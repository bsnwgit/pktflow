"""
pktFlow configuration.

Priority order (highest → lowest):
  1. Environment variables  (PKTFLOW_*)
  2. config.yaml in CWD, $PKTFLOW_INSTALL_DIR, /data, /opt/pktflow, or ~/.pktflow
  3. Defaults defined here

Runtime settings (storage backend, retention days, ingest token, etc.) are
stored in SQLite and loaded via SettingsStore; those are NOT in this file.
This file only covers startup/infrastructure settings that must be known
before the database is connected.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _load_yaml() -> dict:
    """Try known config file locations and return parsed YAML, or {}."""
    candidates = [
        Path("config.yaml"),
        Path("/data/config.yaml"),
        Path("/opt/pktflow/config.yaml"),
        Path.home() / ".pktflow" / "config.yaml",
    ]
    install_dir = os.environ.get("PKTFLOW_INSTALL_DIR")
    if install_dir:
        candidates.insert(0, Path(install_dir) / "config.yaml")

    env_path = os.environ.get("PKTFLOW_CONFIG")
    if env_path:
        candidates.insert(0, Path(env_path))

    for path in candidates:
        if path.exists():
            with path.open() as f:
                return yaml.safe_load(f) or {}
    return {}


_yaml_cfg = _load_yaml()


def _default_install_dir() -> Path:
    """The app root — used for locating files like VERSION that live at the
    repo/install root. Not wired through the rest of this file's path
    defaults (those already have their own defaults); this exists so
    app/version.py (shared verbatim across pkt* apps) has somewhere to look."""
    env_dir = os.environ.get("PKTFLOW_INSTALL_DIR")
    if env_dir:
        return Path(env_dir)
    return Path.cwd()


_INSTALL_DIR = _default_install_dir()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PKTFLOW_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Server ────────────────────────────────────────────────────────────────
    host: str = Field(default=_yaml_cfg.get("host", "0.0.0.0"))
    port: int = Field(default=_yaml_cfg.get("port", 8766))
    workers: int = Field(default=_yaml_cfg.get("workers", 2))
    debug: bool = Field(default=_yaml_cfg.get("debug", False))

    # ── App root — used by app/version.py to locate the VERSION file ───────────
    install_dir: str = Field(default=_yaml_cfg.get("install_dir", str(_INSTALL_DIR)))

    # ── App database (SQLite sidecar) ──────────────────────────────────────────
    db_path: str = Field(
        default=_yaml_cfg.get("db_path", "/data/pktflow.db")
    )

    # ── ClickHouse (startup connection — overridable at runtime via settings) ──
    clickhouse_host: str = Field(default=_yaml_cfg.get("clickhouse_host", "localhost"))
    clickhouse_port: int = Field(default=_yaml_cfg.get("clickhouse_port", 9000))
    clickhouse_database: str = Field(default=_yaml_cfg.get("clickhouse_database", "pktflow"))
    clickhouse_user: str = Field(default=_yaml_cfg.get("clickhouse_user", "default"))
    clickhouse_password: str = Field(default=_yaml_cfg.get("clickhouse_password", ""))

    # ── DuckDB (alternate backend) ─────────────────────────────────────────────
    duckdb_path: str = Field(
        default=_yaml_cfg.get("duckdb_path", "/data/flows.duckdb")
    )

    # ── JWT ───────────────────────────────────────────────────────────────────
    secret_key: str = Field(
        default=_yaml_cfg.get("secret_key", "CHANGE_ME_IN_PRODUCTION_secret_key_32chars")
    )
    algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    # ── Credential encryption (Fernet) ──────────────────────────────────────────
    # Separate from secret_key (JWT signing) — used to encrypt stored secrets
    # (user API keys, etc.) at rest.
    credential_key: str = Field(default=_yaml_cfg.get("credential_key", ""))

    # ── First-run admin user seed (fresh install) ────────────────────────────
    # If no users exist in the database, pktFlow creates an admin account using
    # these credentials on startup. Leave blank to skip seeding.
    admin_user: str = Field(default=_yaml_cfg.get("admin_user", ""))
    admin_password: str = Field(default=_yaml_cfg.get("admin_password", ""))

    # ── CORS ──────────────────────────────────────────────────────────────────
    # In production, restrict this to your actual dashboard origin.
    cors_origins: list[str] = Field(
        default=_yaml_cfg.get("cors_origins", ["*"])
    )

    # ── pktSuite integration ─────────────────────────────────────────────────
    suite_token: str = Field(default=_yaml_cfg.get("suite_token", ""))

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = Field(default=_yaml_cfg.get("log_level", "info"))
    log_file: str = Field(
        default=_yaml_cfg.get("log_file", "/data/logs/pktflow.log")
    )

    # ── Ingest buffer ─────────────────────────────────────────────────────────
    # Flush to storage when either threshold is hit (whichever comes first)
    ingest_buffer_size: int = 1000      # records
    ingest_buffer_flush_secs: int = 2   # seconds


@lru_cache
def get_settings() -> Settings:
    return Settings()


# suite_token_from_sqlite_patch — reads token from SQLite so /api/suite/register
# takes effect immediately without service restart.
_patched_get_settings = get_settings  # noqa: save original if it exists

def get_settings() -> Settings:  # type: ignore[misc]
    s = Settings()
    try:
        import sqlite3 as _sq, json as _j
        from pathlib import Path as _P
        _db_path = str(_P(__file__).parent.parent / 'pktflow.db')
        _conn = _sq.connect(_db_path)
        _row = _conn.execute("SELECT value FROM settings WHERE key='suite_token'").fetchone()
        _conn.close()
        if _row and _row[0]:
            _val = _row[0]
            _tok = _j.loads(_val) if _val.startswith('"') else _val
            if _tok:
                s = s.model_copy(update={'suite_token': _tok})
    except Exception:
        pass
    return s
