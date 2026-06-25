"""
GET/PUT /api/settings — runtime application settings.
All settings are stored as JSON values in the SQLite settings table.
"""
from __future__ import annotations

import json
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

router = APIRouter()

# ── Default settings (applied on first run) ───────────────────────────────────
DEFAULTS: dict[str, Any] = {
    # Storage
    "storage_backend": "duckdb",          # clickhouse | duckdb
    "retention_days_raw": 90,
    "retention_days_hourly": 365,

    # Ingest
    "ingest_method": "http",             # http | udp | both
    "ingest_token": "",                  # Set by install.sh
    "ingest_http_port": 8080,
    "ingest_udp_port_netflow": 2055,
    "ingest_udp_port_sflow": 6343,
    "allowed_hosts": [],                 # Empty = allow all

    # Auth
    "auth_local_enabled": True,
    "auth_okta_enabled": False,
    "okta_issuer": "",
    "okta_client_id": "",
    "okta_client_secret": "",
    "okta_redirect_uri": "",
    "okta_role_mapping": {},             # {"okta_group": "admin|analyst|viewer"}
    "session_timeout_minutes": 480,

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

    # General
    "app_name": "pktFlow",
    "base_url": "http://localhost:8080",
    "timezone": "UTC",

    # AI assistant (Phase 5)
    "anthropic_api_key": "",          # Anthropic API key for in-app Claude assistant
    "ai_model": "claude-haiku-4-5-20251001",

    # Integrations
    "lucid_api_token": "",            # Lucidchart Personal Access Token for diagram export

    # SSL / TLS
    "ssl_enabled": False,             # Enable HTTPS/WSS
    "ssl_certfile": "",               # Absolute path to PEM cert file on server
    "ssl_keyfile": "",                # Absolute path to PEM private key on server

    # Alerts
    "alert_event_retention_days": 90, # Days to keep alert_events + notification_log rows

    # Backup
    "backup_enabled": False,
    "backup_interval_hours": 24,
    "backup_rotation_count": 5,
    "backup_path": "/mnt/software/pktflow_backups",
    "backup_include_clickhouse": True,

    # Live updates (WebSocket)
    "ws_stream_raw_flows": False,  # Push raw FlowRecord batch to WS clients after each flush
    "ws_max_raw_flows": 100,       # Max flows per push (capped to prevent flooding)
}


# Sentinel mask written over secret values in GET responses.
# If the UI sends this value back on Save, we treat it as "unchanged" and skip the write.
_MASK = "••••••••"
_SECRET_KEYS = frozenset({
    "ingest_token", "okta_client_secret", "notify_email_password",
    "notify_pagerduty_integration_key", "anthropic_api_key", "lucid_api_token",
})


async def _ensure_defaults(db: aiosqlite.Connection) -> None:
    for key, value in DEFAULTS.items():
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
    return {key: json.loads(row[0])}


class SettingUpdate(BaseModel):
    value: Any


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

    await db.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, json.dumps(body.value)),
    )
    await db.commit()

    # Side effects for certain settings
    if key == "retention_days_raw":
        from app.storage.factory import get_storage
        await get_storage().update_retention_ttl(int(body.value))

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
