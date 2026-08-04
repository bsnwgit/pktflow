"""
SQLite async database engine for the pktFlow app sidecar DB
(users, settings, devices, alert rules, alert events, notification log).
"""
from __future__ import annotations

import aiosqlite
import logging
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator

from app.config import get_settings

log = logging.getLogger("pktflow")

_settings = get_settings()
DB_PATH = _settings.db_path


async def _seed_admin_user() -> None:
    """Create a default admin account on first run if no users exist.

    Reads PKTFLOW_ADMIN_USER and PKTFLOW_ADMIN_PASSWORD from settings (which
    are populated from env vars, config.yaml, or .env). Skips silently when:
    - admin_password is not set (blank), or
    - the users table already has at least one row.
    """
    s = get_settings()
    if not s.admin_password:
        return

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("SELECT COUNT(*) FROM users") as cur:
            row = await cur.fetchone()
        if row and row[0] > 0:
            return  # Users already exist — nothing to seed

        try:
            from passlib.context import CryptContext
            pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
            hashed = pwd_ctx.hash(s.admin_password)
            username = s.admin_user or "admin"
            await conn.execute(
                """INSERT INTO users (username, email, hashed_password, role, is_active, is_default_admin, created_at)
                   VALUES (?, ?, ?, 'admin', 1, 1, ?)""",
                (username, f"{username}@localhost", hashed, datetime.utcnow().isoformat()),
            )
            await conn.commit()
            log.info("Created default admin user: %s", username)
        except Exception as exc:
            log.warning("Could not seed admin user: %s", exc)


async def get_db() -> AsyncGenerator[aiosqlite.Connection, None]:
    """FastAPI dependency — yields an open aiosqlite connection per request."""
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")
        yield conn


async def init_db() -> None:
    """Run migrations on startup. Safe to call multiple times (idempotent SQL)."""
    migration_dir = Path(__file__).parent.parent / "migrations"
    migration_files = sorted(migration_dir.glob("*.sql"))

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")

        # Track which migrations have been applied
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS _migrations (
                filename TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        await conn.commit()

        for mfile in migration_files:
            async with conn.execute(
                "SELECT 1 FROM _migrations WHERE filename = ?", (mfile.name,)
            ) as cur:
                already_applied = await cur.fetchone()

            if not already_applied:
                sql = mfile.read_text()
                await conn.executescript(sql)
                await conn.execute(
                    "INSERT INTO _migrations (filename) VALUES (?)", (mfile.name,)
                )
                await conn.commit()

        await _encrypt_legacy_api_keys(conn)
        await _encrypt_legacy_suite_tokens(conn)

    # Seed default admin user if no users exist (first-run setup)
    await _seed_admin_user()


async def _encrypt_legacy_suite_tokens(conn: aiosqlite.Connection) -> None:
    """One-time data migration: integrations.suite_token used to be stored
    in plaintext. Encrypt any row that isn't already a valid Fernet token.
    Tracked via _migrations (same table the .sql migrations use) so this
    only does real work once."""
    marker = "999_encrypt_legacy_suite_tokens.py"
    async with conn.execute(
        "SELECT 1 FROM _migrations WHERE filename = ?", (marker,)
    ) as cur:
        if await cur.fetchone():
            return

    from app.crypto import decrypt_str, encrypt_str

    async with conn.execute(
        "SELECT id, suite_token FROM integrations WHERE suite_token != ''"
    ) as cur:
        rows = await cur.fetchall()

    for row_id, suite_token in rows:
        try:
            already_encrypted = bool(decrypt_str(suite_token))
        except Exception:
            already_encrypted = False
        if already_encrypted:
            continue
        await conn.execute(
            "UPDATE integrations SET suite_token = ? WHERE id = ?",
            (encrypt_str(suite_token), row_id),
        )

    await conn.execute("INSERT INTO _migrations (filename) VALUES (?)", (marker,))
    await conn.commit()


async def _encrypt_legacy_api_keys(conn: aiosqlite.Connection) -> None:
    """One-time data migration: user_api_keys.api_key used to be stored in
    plaintext. Encrypt any row that isn't already a valid Fernet token.
    Tracked via _migrations (same table the .sql migrations use) so this
    only does real work once."""
    marker = "999_encrypt_legacy_user_api_keys.py"
    async with conn.execute(
        "SELECT 1 FROM _migrations WHERE filename = ?", (marker,)
    ) as cur:
        if await cur.fetchone():
            return

    from app.crypto import decrypt_str, encrypt_str

    async with conn.execute(
        "SELECT id, api_key FROM user_api_keys WHERE api_key != ''"
    ) as cur:
        rows = await cur.fetchall()

    for row_id, api_key in rows:
        try:
            already_encrypted = bool(decrypt_str(api_key))
        except Exception:
            already_encrypted = False
        if already_encrypted:
            continue
        await conn.execute(
            "UPDATE user_api_keys SET api_key = ? WHERE id = ?",
            (encrypt_str(api_key), row_id),
        )

    await conn.execute("INSERT INTO _migrations (filename) VALUES (?)", (marker,))
    await conn.commit()
