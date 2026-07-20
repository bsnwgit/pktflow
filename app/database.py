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

    # Seed default admin user if no users exist (first-run setup)
    await _seed_admin_user()
