"""
Okta OIDC helpers — discovery, authorization URL, code exchange, userinfo.

Flow:
  1. GET /api/auth/okta/login  → redirect to Okta authorization URL (state in signed cookie)
  2. Okta redirects to GET /api/auth/okta/callback?code=...&state=...
  3. exchange_code() → id_token + access_token
  4. get_userinfo() → sub, email, name, groups
  5. Caller finds/creates pktFlow user, issues JWT, redirects to /
"""
from __future__ import annotations

import secrets
from typing import List, Optional

import httpx
from itsdangerous import BadData, URLSafeTimedSerializer

from app.config import get_settings

_cfg = get_settings()

# Signed state tokens expire after 10 minutes
_STATE_MAX_AGE = 600
_STATE_SALT = "okta-oauth-state"


def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_cfg.secret_key, salt=_STATE_SALT)


def generate_state() -> tuple[str, str]:
    """Return (raw_state, signed_state).  Store signed_state in a cookie; pass raw_state to Okta."""
    raw = secrets.token_urlsafe(32)
    signed = _signer().dumps(raw)
    return raw, signed


def verify_state(signed: str, raw: str) -> bool:
    """Validate cookie-stored signed state against the state param returned by Okta."""
    try:
        expected = _signer().loads(signed, max_age=_STATE_MAX_AGE)
        return secrets.compare_digest(expected, raw)
    except BadData:
        return False


# ── OIDC discovery ────────────────────────────────────────────────────────────

async def discover(issuer: str) -> dict:
    """Fetch the OIDC discovery document and return it."""
    url = issuer.rstrip("/") + "/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()


def build_auth_url(
    authorization_endpoint: str,
    client_id: str,
    redirect_uri: str,
    state: str,
    nonce: str,
    extra_scopes: Optional[List[str]] = None,
) -> str:
    """Build the Okta authorization redirect URL."""
    from urllib.parse import urlencode

    scopes = ["openid", "email", "profile"] + (extra_scopes or [])
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(scopes),
        "state": state,
        "nonce": nonce,
    }
    return f"{authorization_endpoint}?{urlencode(params)}"


# ── Token exchange ─────────────────────────────────────────────────────────────

async def exchange_code(
    token_endpoint: str,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
) -> dict:
    """Exchange an authorization code for tokens.  Returns the full token response dict."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "client_secret": client_secret,
            },
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        return resp.json()


# ── Userinfo ──────────────────────────────────────────────────────────────────

async def get_userinfo(userinfo_endpoint: str, access_token: str) -> dict:
    """Fetch the OIDC userinfo and return it.
    Guaranteed keys after normalisation: sub, email, name (may be empty string).
    Optional keys: given_name, family_name, groups (list[str]).
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            userinfo_endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        raw = resp.json()

    return {
        "sub": raw.get("sub", ""),
        "email": raw.get("email", ""),
        "name": raw.get("name", "") or f"{raw.get('given_name','')} {raw.get('family_name','')}".strip(),
        "given_name": raw.get("given_name", ""),
        "family_name": raw.get("family_name", ""),
        "groups": raw.get("groups", []),  # requires 'groups' scope + Okta group claim
    }


# ── Settings helper ───────────────────────────────────────────────────────────

async def load_okta_settings(db) -> Optional[dict]:
    """Return Okta settings from SQLite, or None if Okta is disabled / not configured."""
    import json as _json

    async with db.execute(
        "SELECT key, value FROM settings WHERE key IN "
        "('auth_okta_enabled','okta_issuer','okta_client_id','okta_client_secret','okta_redirect_uri')"
    ) as cur:
        rows = await cur.fetchall()

    kv = {r["key"]: r["value"] for r in rows}

    def _s(key: str, default: str = "") -> str:
        """JSON-decode a settings value — DB stores all values as JSON-encoded strings."""
        raw = kv.get(key, _json.dumps(default))
        try:
            val = _json.loads(raw)
        except Exception:
            val = raw
        return str(val).strip() if val is not None else default

    try:
        enabled = _json.loads(kv.get("auth_okta_enabled", "false"))
    except Exception:
        enabled = False
    if isinstance(enabled, str):
        enabled = enabled.lower() in ("true", "1", "yes")
    if not enabled:
        return None

    issuer        = _s("okta_issuer")
    client_id     = _s("okta_client_id")
    client_secret = _s("okta_client_secret")
    redirect_uri  = _s("okta_redirect_uri")

    if not all([issuer, client_id, client_secret]):
        return None

    return {
        "issuer": issuer,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
    }
