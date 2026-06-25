"""
POST /api/auth/* — login, logout, token refresh, Okta OIDC callback, Okta SAML 2.0.
"""
from __future__ import annotations

import secrets

from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.auth.local import verify_password, create_access_token, create_refresh_token, decode_refresh_token
from app.auth import okta as okta_auth
from app.auth import saml as saml_auth
from app.database import get_db

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str


# ── Local auth ────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, response: Response, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, hashed_password, role, is_active FROM users WHERE username = ? OR email = ?",
        (body.username, body.username),
    ) as cur:
        user = await cur.fetchone()

    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not user["hashed_password"] or not verify_password(body.password, user["hashed_password"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    # Update last_login + auth provider
    await db.execute("UPDATE users SET last_login = datetime('now'), auth_provider = 'local' WHERE id = ?", (user["id"],))
    await db.commit()

    access_token = create_access_token(user["id"], user["role"])
    refresh_token = create_refresh_token(user["id"])

    # Refresh token in httpOnly cookie
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,  # 7 days
    )

    return TokenResponse(access_token=access_token, role=user["role"])


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    user_id = decode_refresh_token(token)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    async with db.execute(
        "SELECT id, role, is_active FROM users WHERE id = ?", (user_id,)
    ) as cur:
        user = await cur.fetchone()

    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    access_token = create_access_token(user["id"], user["role"])
    return TokenResponse(access_token=access_token, role=user["role"])


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}


# ── Public config ─────────────────────────────────────────────────────────────

@router.get("/config")
async def auth_config(db: aiosqlite.Connection = Depends(get_db)):
    """Return which auth methods are available (no auth required — used by Login page)."""
    import json as _json
    oidc_settings = await okta_auth.load_okta_settings(db)
    saml_settings = await saml_auth.load_saml_settings(db)

    # Read auth_local_enabled from DB (defaults to True)
    async with db.execute("SELECT value FROM settings WHERE key = 'auth_local_enabled'") as cur:
        row = await cur.fetchone()
    try:
        local_enabled = _json.loads(row[0]) if row else True
    except Exception:
        local_enabled = True
    # Safety: never disable local auth if no SSO is configured
    if not oidc_settings and not saml_settings:
        local_enabled = True

    return {
        "okta_enabled":  oidc_settings is not None,
        "saml_enabled":  saml_settings is not None,
        "local_enabled": bool(local_enabled),
    }


# ── Okta OIDC ─────────────────────────────────────────────────────────────────

@router.get("/okta/login")
async def okta_login(response: Response, db: aiosqlite.Connection = Depends(get_db)):
    """Initiate Okta OIDC flow — generate state, set cookie, redirect to Okta."""
    settings = await okta_auth.load_okta_settings(db)
    if not settings:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Okta SSO is not configured")

    try:
        discovery = await okta_auth.discover(settings["issuer"])
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Okta discovery failed: {e}")

    raw_state, signed_state = okta_auth.generate_state()
    nonce = secrets.token_urlsafe(32)

    redirect_uri = settings["redirect_uri"] or ""

    auth_url = okta_auth.build_auth_url(
        authorization_endpoint=discovery["authorization_endpoint"],
        client_id=settings["client_id"],
        redirect_uri=redirect_uri,
        state=raw_state,
        nonce=nonce,
    )

    # Store signed state + nonce in short-lived cookies (httpOnly, SameSite=lax)
    resp = RedirectResponse(url=auth_url, status_code=302)
    resp.set_cookie("okta_state", signed_state, httponly=True, samesite="lax", max_age=600)
    resp.set_cookie("okta_nonce", nonce, httponly=True, samesite="lax", max_age=600)
    return resp


@router.get("/okta/callback")
async def okta_callback(
    request: Request,
    response: Response,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Handle the Okta authorization code callback, issue pktFlow JWT, redirect to /."""
    # Okta error response
    if error:
        return RedirectResponse(url=f"/login?sso_error={error}", status_code=302)

    if not code or not state:
        return RedirectResponse(url="/login?sso_error=missing_params", status_code=302)

    # Validate state against signed cookie
    signed_state = request.cookies.get("okta_state", "")
    if not okta_auth.verify_state(signed_state, state):
        return RedirectResponse(url="/login?sso_error=invalid_state", status_code=302)

    settings = await okta_auth.load_okta_settings(db)
    if not settings:
        return RedirectResponse(url="/login?sso_error=okta_disabled", status_code=302)

    try:
        discovery = await okta_auth.discover(settings["issuer"])
    except Exception:
        return RedirectResponse(url="/login?sso_error=discovery_failed", status_code=302)

    # Exchange code for tokens
    try:
        tokens = await okta_auth.exchange_code(
            token_endpoint=discovery["token_endpoint"],
            client_id=settings["client_id"],
            client_secret=settings["client_secret"],
            code=code,
            redirect_uri=settings["redirect_uri"],
        )
    except Exception:
        return RedirectResponse(url="/login?sso_error=token_exchange_failed", status_code=302)

    access_token_okta = tokens.get("access_token", "")
    if not access_token_okta:
        return RedirectResponse(url="/login?sso_error=no_access_token", status_code=302)

    # Get user info from Okta
    try:
        userinfo = await okta_auth.get_userinfo(discovery["userinfo_endpoint"], access_token_okta)
    except Exception:
        return RedirectResponse(url="/login?sso_error=userinfo_failed", status_code=302)

    okta_sub = userinfo["sub"]
    email = userinfo["email"]
    name = userinfo.get("name", "")

    if not okta_sub or not email:
        return RedirectResponse(url="/login?sso_error=missing_claims", status_code=302)

    # Find user by okta_sub, fall back to email, or create a new viewer account
    async with db.execute("SELECT id, role, is_active FROM users WHERE okta_sub = ?", (okta_sub,)) as cur:
        user = await cur.fetchone()

    if not user:
        async with db.execute("SELECT id, role, is_active FROM users WHERE email = ?", (email,)) as cur:
            user = await cur.fetchone()
        if user:
            # Link the Okta sub to the existing account
            await db.execute("UPDATE users SET okta_sub = ? WHERE id = ?", (okta_sub, user["id"]))

    if not user:
        # Auto-provision: create a new viewer account
        username = email.split("@")[0]
        # Ensure unique username
        async with db.execute("SELECT id FROM users WHERE username = ?", (username,)) as cur:
            if await cur.fetchone():
                username = f"{username}_{secrets.token_hex(4)}"

        await db.execute(
            "INSERT INTO users (username, email, hashed_password, role, is_active, okta_sub) "
            "VALUES (?, ?, NULL, 'viewer', 1, ?)",
            (username, email, okta_sub),
        )
        await db.commit()
        async with db.execute("SELECT id, role, is_active FROM users WHERE okta_sub = ?", (okta_sub,)) as cur:
            user = await cur.fetchone()

    if not user or not user["is_active"]:
        return RedirectResponse(url="/login?sso_error=user_inactive", status_code=302)

    # Update last_login + auth provider
    await db.execute("UPDATE users SET last_login = datetime('now'), auth_provider = 'oidc' WHERE id = ?", (user["id"],))
    await db.commit()

    # Issue pktFlow tokens
    pktflow_access = create_access_token(user["id"], user["role"])
    pktflow_refresh = create_refresh_token(user["id"])

    resp = RedirectResponse(url="/", status_code=302)

    # Clear the OIDC state cookies
    resp.delete_cookie("okta_state")
    resp.delete_cookie("okta_nonce")

    # Set pktFlow auth cookies — refresh token httpOnly, access token readable by JS
    resp.set_cookie(
        key="refresh_token",
        value=pktflow_refresh,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    # Expose the access token via a non-httpOnly cookie so the React app can read it on redirect
    resp.set_cookie(
        key="sso_access_token",
        value=pktflow_access,
        httponly=False,
        samesite="lax",
        max_age=60,  # 1-minute cookie — React reads it immediately and stores in memory
    )
    resp.set_cookie(
        key="sso_role",
        value=user["role"],
        httponly=False,
        samesite="lax",
        max_age=60,
    )

    return resp


# ── Okta SAML 2.0 ─────────────────────────────────────────────────────────────

@router.get("/saml/metadata")
async def saml_metadata(db: aiosqlite.Connection = Depends(get_db)):
    """Return SP metadata XML for registration in the Okta admin console."""
    cfg = await saml_auth.load_saml_settings(db)
    if not cfg:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="SAML SSO is not configured")
    try:
        xml = saml_auth.get_metadata_xml(cfg)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
    return Response(content=xml, media_type="application/xml")


@router.get("/saml/login")
async def saml_login(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    """Initiate SP-initiated SAML flow — redirect user to Okta SSO URL."""
    cfg = await saml_auth.load_saml_settings(db)
    if not cfg:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="SAML SSO is not configured")
    auth = await saml_auth.get_auth(request, cfg)
    redirect_url = auth.login()
    return RedirectResponse(url=redirect_url, status_code=302)


@router.post("/saml/callback")
async def saml_callback(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    """ACS endpoint — Okta POSTs the SAMLResponse here after authentication."""
    cfg = await saml_auth.load_saml_settings(db)
    if not cfg:
        return RedirectResponse(url="/login?sso_error=saml_disabled", status_code=303)

    import logging as _logging
    _log = _logging.getLogger(__name__)

    try:
        auth = await saml_auth.get_auth(request, cfg)
        auth.process_response()
    except Exception as exc:
        _log.error("SAML process_response error: %s", exc, exc_info=True)
        return RedirectResponse(url="/login?sso_error=saml_processing_failed", status_code=303)

    errors = auth.get_errors()
    if errors:
        reason = auth.get_last_error_reason() or ""
        _log.error("SAML validation errors: %s | reason: %s", errors, reason)
        return RedirectResponse(url="/login?sso_error=saml_invalid_response", status_code=303)

    if not auth.is_authenticated():
        return RedirectResponse(url="/login?sso_error=not_authenticated", status_code=303)

    email = auth.get_nameid()
    if not email:
        return RedirectResponse(url="/login?sso_error=missing_claims", status_code=303)

    # Read role from SAML attributes — Okta sends appuser.role as the 'role' attribute
    _VALID_ROLES = {"admin", "analyst", "viewer"}
    attrs = auth.get_attributes()
    raw_role = (attrs.get("role") or attrs.get("Role") or [None])[0]
    okta_role = raw_role.strip().lower() if raw_role else "viewer"
    if okta_role not in _VALID_ROLES:
        okta_role = "viewer"

    # Find user by email, or auto-provision with the Okta-assigned role
    async with db.execute("SELECT id, role, is_active FROM users WHERE email = ?", (email,)) as cur:
        user = await cur.fetchone()

    if not user:
        username = email.split("@")[0]
        async with db.execute("SELECT id FROM users WHERE username = ?", (username,)) as cur:
            if await cur.fetchone():
                username = f"{username}_{secrets.token_hex(4)}"
        await db.execute(
            "INSERT INTO users (username, email, hashed_password, role, is_active) VALUES (?, ?, NULL, ?, 1)",
            (username, email, okta_role),
        )
        await db.commit()
        async with db.execute("SELECT id, role, is_active FROM users WHERE email = ?", (email,)) as cur:
            user = await cur.fetchone()

    if not user or not user["is_active"]:
        return RedirectResponse(url="/login?sso_error=user_inactive", status_code=303)

    # Always sync role from Okta on every login; mark auth provider as saml
    await db.execute(
        "UPDATE users SET role = ?, last_login = datetime('now'), auth_provider = 'saml' WHERE id = ?",
        (okta_role, user["id"]),
    )
    await db.commit()

    pktflow_access = create_access_token(user["id"], user["role"])
    pktflow_refresh = create_refresh_token(user["id"])

    resp = RedirectResponse(url="/", status_code=302)
    resp.set_cookie(
        key="refresh_token",
        value=pktflow_refresh,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    resp.set_cookie(
        key="sso_access_token",
        value=pktflow_access,
        httponly=False,
        samesite="lax",
        max_age=60,
    )
    resp.set_cookie(
        key="sso_role",
        value=user["role"],
        httponly=False,
        samesite="lax",
        max_age=60,
    )
    return resp
