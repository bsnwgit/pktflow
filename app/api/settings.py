"""
GET/PUT /api/settings — runtime application settings.
All settings are stored as JSON values in the SQLite settings table.
"""
from __future__ import annotations

import logging
import json
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

log = logging.getLogger("pktflow.settings")

router = APIRouter()

# ── Default settings (applied on first run) ───────────────────────────────────
DEFAULTS: dict[str, Any] = {
    # Storage
    "storage_backend": "clickhouse",      # clickhouse | duckdb
    "retention_days_raw": 90,
    "retention_days_hourly": 365,

    # Ingest
    "ingest_method": "http",             # http | udp | both
    "ingest_token": "",                  # Set by install.sh
    "ingest_http_port": 8766,
    "ingest_udp_port_netflow": 2055,
    "ingest_udp_port_sflow": 6343,
    "allowed_hosts": [],                 # Empty = allow all

    # Auth
    "auth_local_enabled": True,
    "session_timeout_minutes": 480,

    # SAML 2.0
    "okta_saml_enabled": False,
    "okta_saml_idp_entity_id": "",       # From Okta metadata: IdP Entity ID
    "okta_saml_idp_sso_url": "",         # From Okta metadata: IdP SSO URL
    "okta_saml_idp_cert": "",            # From Okta metadata: X.509 cert (no header/footer)
    "okta_saml_sp_entity_id": "",        # Defaults to base_url/api/auth/saml/metadata
    "okta_saml_sp_cert": "",             # Optional: SP cert for signed requests
    "okta_saml_sp_key": "",              # Optional: SP private key for signed requests

    # Notifications
    "notify_email_enabled": False,
    "notify_email_smtp_host": "",
    "notify_email_smtp_port": 587,
    "notify_email_smtp_tls": True,
    "notify_email_username": "",
    "notify_email_password": "",
    "notify_email_from": "",
    "notify_email_default_to": [],

    "notify_slack_enabled": False,
    "notify_slack_webhook_url": "",
    "notify_slack_channel": "#alerts",

    "notify_pagerduty_enabled": False,
    "notify_pagerduty_integration_key": "",

    "notify_webhook_enabled": False,
    "notify_webhook_url": "",
    "notify_webhook_method": "POST",
    "notify_webhook_headers": {},
    "notify_webhook_payload_template": '{"alert": "{{ alert_name }}", "message": "{{ message }}"}',

    "notify_tracecat_enabled": False,
    "notify_tracecat_webhook_url": "",   # TraceCat workflow webhook URL (from TraceCat workflow settings)
    "notify_tracecat_api_token": "",     # Bearer token for TraceCat API auth (optional)

    # ── App log forwarding (ship this app's own logs to pktLog) ──────────────
    # pktLog listens on 5514 by default and parses RFC 5424.
    "log_forward_enabled": False,
    "log_forward_host": "",
    "log_forward_port": 5514,
    "log_forward_protocol": "udp",       # udp | tcp
    "log_forward_level": "INFO",         # DEBUG | INFO | WARNING | ERROR
    "log_forward_app_name": "pktflow",

    # General
    "app_name": "pktFlow",
    "base_url": "http://localhost:8766",
    "timezone": "UTC",


    # Integrations
    "lucid_api_token": "",            # Lucidchart Personal Access Token for diagram export

    # SSL / TLS
    "ssl_enabled": False,             # Enable HTTPS/WSS
    "ssl_certfile": "",               # Absolute path to PEM cert file on server
    "ssl_keyfile": "",                # Absolute path to PEM private key on server

    # Geo Map — NAT Mappings
    "isp_dhcp_enabled": False,   # True = ISP DHCP mode; see nat_mappings.py / flows.py for behavior
    "isp_dhcp_mapping_id": None, # id of the synthetic "Default" nat_mappings row created while isp_dhcp_enabled — internal, not user-editable

    # Alerts
    "alert_event_retention_days": 90, # Days to keep alert_events + notification_log rows

    # Backup
    "backup_enabled": False,
    "backup_interval_hours": 24,
    "backup_rotation_count": 5,
    "backup_path": "",  # computed at seed time — see _ensure_defaults()
    "backup_include_clickhouse": True,

    # Live updates (WebSocket)
    "ws_stream_raw_flows": False,  # Push raw FlowRecord batch to WS clients after each flush
    "ws_max_raw_flows": 100,       # Max flows per push (capped to prevent flooding)

    # Suite integration
    "hub_settings_managed": False,  # Set by pktHub on register/deregister via /api/suite/settings-lock — not user-editable.
}


# Sentinel mask written over secret values in GET responses.
# If the UI sends this value back on Save, we treat it as "unchanged" and skip the write.
_MASK = "••••••••"
_SECRET_KEYS = frozenset({
    "ingest_token", "notify_email_password",
    "notify_pagerduty_integration_key", "lucid_api_token",
    "okta_saml_sp_key", "notify_tracecat_api_token",
})


async def _ensure_defaults(db: aiosqlite.Connection) -> None:
    from pathlib import Path

    from app.config import get_settings

    for key, value in DEFAULTS.items():
        if key == "backup_path" and not value:
            # Default backups into a "backups" dir alongside the app database,
            # i.e. inside whatever directory the app was actually installed to
            # — not a hardcoded path that only matches the default install dir.
            value = str(Path(get_settings().db_path).parent / "backups")
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (key, json.dumps(value)),
        )
    await db.commit()


@router.get("/")
async def get_all_settings(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Return all settings as a flat dict. Sensitive values are masked."""
    await _ensure_defaults(db)
    async with db.execute("SELECT key, value FROM settings") as cur:
        rows = await cur.fetchall()

    result = {r[0]: json.loads(r[1]) for r in rows}

    # Mask secrets in API response
    for secret_key in _SECRET_KEYS:
        if result.get(secret_key):
            result[secret_key] = _MASK


    return result


@router.get("/{key}")
async def get_setting(key: str, _: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")
    value = json.loads(row[0])

    # Mask secrets, same convention as GET / (bulk listing) — a single-key
    # lookup must not be usable to bypass the masking any authenticated
    # non-admin user (e.g. viewer) would otherwise see.
    if key in _SECRET_KEYS and value:
        value = _MASK

    return {key: value}


class SettingUpdate(BaseModel):
    value: Any


class TestNotificationRequest(BaseModel):
    channel: str


@router.put("/{key}")
async def update_setting(
    key: str,
    body: SettingUpdate,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    if key not in DEFAULTS:
        raise HTTPException(status_code=400, detail=f"Unknown setting key: {key}")

    # Never overwrite a secret with the display mask
    if key in _SECRET_KEYS and body.value == _MASK:
        return {"key": key, "updated": False, "skipped": "mask value"}

    # Capture the pre-write value for settings whose side effects only fire
    # on an actual state transition (re-PUTting the same value is a no-op).
    old_value = None
    if key == "isp_dhcp_enabled":
        async with db.execute("SELECT value FROM settings WHERE key = 'isp_dhcp_enabled'") as cur:
            row = await cur.fetchone()
        old_value = bool(json.loads(row[0])) if row else False

    value = body.value

    await db.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, json.dumps(value)),
    )
    await db.commit()

    # Side effects for certain settings
    if key == "retention_days_raw":
        from app.storage.factory import get_storage
        await get_storage().update_retention_ttl(int(body.value))

    if key == "isp_dhcp_enabled" and bool(body.value) != old_value:
        if body.value:
            # Enabling: create the single synthetic "Default" mapping every
            # other nat_mappings row is ignored in favor of (see flows.py).
            # 0.0.0.0/0 catches all private traffic regardless of subnet;
            # public_cidr stays blank since a DHCP-assigned IP can't be
            # geolocated — this row exists so Traffic Rules has something to
            # scope to, not to place anything on the map by itself.
            async with db.execute("SELECT COALESCE(MAX(priority) + 1, 0) FROM nat_mappings") as cur:
                next_priority = (await cur.fetchone())[0]
            cur = await db.execute(
                """INSERT INTO nat_mappings
                   (name, site_key, category, private_cidr, public_cidr, priority, show_in_legend)
                   VALUES ('Default', 'default', 'wan', '0.0.0.0/0', '', ?, 1)""",
                (next_priority,),
            )
            await db.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('isp_dhcp_mapping_id', ?, datetime('now')) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (json.dumps(cur.lastrowid),),
            )
        else:
            # Disabling: remove the synthetic mapping. Any Traffic Rule
            # scoped to it goes with it (ON DELETE CASCADE, same as manually
            # deleting any other NAT mapping).
            async with db.execute("SELECT value FROM settings WHERE key = 'isp_dhcp_mapping_id'") as cur:
                row = await cur.fetchone()
            dhcp_mapping_id = json.loads(row[0]) if row else None
            if dhcp_mapping_id is not None:
                await db.execute("DELETE FROM nat_mappings WHERE id = ?", (dhcp_mapping_id,))
            await db.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('isp_dhcp_mapping_id', 'null', datetime('now')) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
            )
        await db.commit()

    return {"key": key, "updated": True}


@router.post("/bulk")
async def bulk_update(
    updates: dict[str, Any],
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Update multiple settings at once (Settings page Save button)."""
    unknown = [k for k in updates if k not in DEFAULTS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown keys: {unknown}")

    skipped = []
    for key, value in updates.items():
        # Never overwrite a secret with the display mask (user saved without changing it)
        if key in _SECRET_KEYS and value == _MASK:
            skipped.append(key)
            continue
        await db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(value)),
        )
    await db.commit()
    written = [k for k in updates if k not in skipped]
    return {"updated": written, "skipped": skipped}


@router.post("/test-notification")
async def test_notification(
    body: TestNotificationRequest,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Send a test notification on the specified channel using saved settings."""
    channel = body.channel
    valid = {"slack", "email", "pagerduty", "webhook", "tracecat"}
    if channel not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown channel: {channel}. Valid: {sorted(valid)}")

    async def _get(key: str):
        async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        return json.loads(row[0]) if row else None

    TEST_RULE   = "pktFlow Test"
    TEST_MSG    = "pktFlow test notification — your configuration is working correctly."
    TEST_SEV    = "info"

    try:
        if channel == "slack":
            enabled = await _get("notify_slack_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "Slack is not enabled"}
            url = await _get("notify_slack_webhook_url") or ""
            if not url:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            import httpx
            payload = {"text": f":white_circle: *pktFlow Test — {TEST_RULE}*\n{TEST_MSG}"}
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                return {"status": "sent", "detail": "Slack message delivered"}
            return {"status": "failed", "detail": f"Slack returned HTTP {resp.status_code}: {resp.text[:200]}"}

        elif channel == "email":
            enabled = await _get("notify_email_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "Email is not enabled"}
            host      = await _get("notify_email_smtp_host")   or ""
            port      = await _get("notify_email_smtp_port")   or 587
            tls       = await _get("notify_email_smtp_tls")
            use_tls   = tls if tls is not None else True
            username  = await _get("notify_email_username")    or ""
            password  = await _get("notify_email_password")    or ""
            from_addr = await _get("notify_email_from")        or "pktflow@localhost"
            to_addrs  = await _get("notify_email_default_to")  or []
            if not host or not to_addrs:
                return {"status": "skipped", "detail": "SMTP host or recipient list not configured"}
            import aiosmtplib
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart
            msg = MIMEMultipart("alternative")
            msg["Subject"] = f"[pktFlow Test] {TEST_RULE}"
            msg["From"]    = from_addr
            msg["To"]      = ", ".join(to_addrs)
            msg.attach(MIMEText(f"pktFlow Test Notification\n\n{TEST_MSG}", "plain"))
            await aiosmtplib.send(
                msg,
                hostname=host, port=int(port), use_tls=bool(use_tls),
                username=username or None, password=password or None,
            )
            return {"status": "sent", "detail": f"Email sent to {', '.join(to_addrs)}"}

        elif channel == "pagerduty":
            enabled = await _get("notify_pagerduty_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "PagerDuty is not enabled"}
            key = await _get("notify_pagerduty_integration_key") or ""
            if not key:
                return {"status": "skipped", "detail": "No integration key configured"}
            import httpx
            payload = {
                "routing_key": key,
                "event_action": "trigger",
                "payload": {
                    "summary": f"[pktFlow Test] {TEST_RULE}: {TEST_MSG}",
                    "severity": "info",
                    "source": "pktflow",
                },
            }
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://events.pagerduty.com/v2/enqueue", json=payload, timeout=10
                )
            if resp.status_code in (200, 202):
                return {"status": "sent", "detail": "PagerDuty event triggered"}
            return {"status": "failed", "detail": f"PagerDuty returned HTTP {resp.status_code}: {resp.text[:200]}"}

        elif channel == "webhook":
            enabled = await _get("notify_webhook_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "Webhook is not enabled"}
            url      = await _get("notify_webhook_url")              or ""
            method   = await _get("notify_webhook_method")           or "POST"
            template = await _get("notify_webhook_payload_template") or ""
            headers  = await _get("notify_webhook_headers")          or {}
            if not url:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            try:
                from jinja2 import Template
                from datetime import datetime, timezone
                rendered = Template(template).render(
                    alert_name=TEST_RULE, message=TEST_MSG,
                    severity=TEST_SEV, fired_at=datetime.now(tz=timezone.utc).isoformat(),
                )
                body_json = json.loads(rendered)
            except Exception as e:
                return {"status": "failed", "detail": f"Template render error: {e}"}
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    method.upper(), url, json=body_json, headers=headers, timeout=10
                )
            if resp.status_code < 300:
                return {"status": "sent", "detail": f"Webhook returned HTTP {resp.status_code}"}
            return {"status": "failed", "detail": f"Webhook returned HTTP {resp.status_code}: {resp.text[:200]}"}

        elif channel == "tracecat":
            enabled = await _get("notify_tracecat_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "TraceCat is not enabled"}
            webhook_url = await _get("notify_tracecat_webhook_url") or ""
            api_token   = await _get("notify_tracecat_api_token")   or ""
            if not webhook_url:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            from datetime import datetime, timezone
            payload = {
                "source": "pktflow",
                "event_id": 0,
                "alert_name": TEST_RULE,
                "severity": TEST_SEV,
                "message": TEST_MSG,
                "fired_at": datetime.now(tz=timezone.utc).isoformat(),
                "details": {"test": True},
            }
            headers: dict = {"Content-Type": "application/json"}
            if api_token:
                headers["Authorization"] = f"Bearer {api_token}"
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.post(webhook_url, json=payload, headers=headers, timeout=10)
            if resp.status_code < 300:
                return {"status": "sent", "detail": f"TraceCat webhook returned HTTP {resp.status_code}"}
            return {"status": "failed", "detail": f"TraceCat returned HTTP {resp.status_code}: {resp.text[:200]}"}

    except Exception:

        log.exception("provider test call failed")

        return {"status": "failed", "detail": "Request failed — see the app log for detail"}
