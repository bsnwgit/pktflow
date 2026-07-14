"""
Local backup — snapshots pktflow.db (+ an optional ClickHouse flows export)
into a timestamped directory under the configured backup_path, with rotation.

Settings (backup_path, backup_rotation_count, backup_include_clickhouse,
backup_enabled, backup_interval_hours) are read directly from the SQLite
settings table rather than passed in, matching how app/config.py reads
suite_token — these are runtime settings managed via the Settings UI, not
config.yaml/env vars.
"""
from __future__ import annotations

import asyncio
import csv
import json
import logging
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("pktflow.backup")

_SNAPSHOT_PREFIX = "pktflow-backup-"


def _read_setting(db_path: str, key: str, default: Any) -> Any:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return default
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return default


def _backup_root(db_path: str) -> Path:
    configured = _read_setting(db_path, "backup_path", "")
    return Path(configured) if configured else Path(db_path).parent / "backups"


def run_backup_sync(db_path: str, clickhouse_database: str) -> dict[str, Any]:
    """Run one backup snapshot. Returns {name, path, size_bytes, files}."""
    root = _backup_root(db_path)
    root.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    snapshot_dir = root / f"{_SNAPSHOT_PREFIX}{stamp}"
    snapshot_dir.mkdir()

    files: list[str] = []

    # Use SQLite's own backup API for a consistent copy of a live database,
    # instead of copying bytes out from under a process that may be writing.
    dest_db = snapshot_dir / "pktflow.db"
    src_conn = sqlite3.connect(db_path)
    dest_conn = sqlite3.connect(str(dest_db))
    try:
        src_conn.backup(dest_conn)
    finally:
        dest_conn.close()
        src_conn.close()
    files.append(dest_db.name)

    if _read_setting(db_path, "backup_include_clickhouse", True):
        try:
            _export_clickhouse_flows(snapshot_dir, clickhouse_database)
            files.append("flows.csv")
        except Exception as e:
            log.warning("ClickHouse export skipped: %s", e)

    rotation_count = _read_setting(db_path, "backup_rotation_count", 5)
    _rotate(root, rotation_count)

    size_bytes = sum(f.stat().st_size for f in snapshot_dir.iterdir() if f.is_file())
    log.info("Backup snapshot created: %s (%d bytes, %d files)", snapshot_dir, size_bytes, len(files))
    return {"name": snapshot_dir.name, "path": str(snapshot_dir), "size_bytes": size_bytes, "files": files}


def _export_clickhouse_flows(snapshot_dir: Path, clickhouse_database: str) -> None:
    from clickhouse_driver import Client

    from app.config import get_settings

    cfg = get_settings()
    client = Client(
        host=cfg.clickhouse_host,
        port=cfg.clickhouse_port,
        database=clickhouse_database,
        user=cfg.clickhouse_user,
        password=cfg.clickhouse_password,
    )
    columns = [row[0] for row in client.execute(f"DESCRIBE TABLE {clickhouse_database}.flows")]
    rows = client.execute(f"SELECT * FROM {clickhouse_database}.flows")
    with (snapshot_dir / "flows.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(columns)
        writer.writerows(rows)


def _rotate(root: Path, keep: int) -> None:
    snapshots = sorted(
        (p for p in root.iterdir() if p.is_dir() and p.name.startswith(_SNAPSHOT_PREFIX)),
        key=lambda p: p.name,
        reverse=True,
    )
    for old in snapshots[keep:]:
        shutil.rmtree(old, ignore_errors=True)


def list_backups_sync(db_path: str) -> list[dict[str, Any]]:
    root = _backup_root(db_path)
    if not root.exists():
        return []
    results = []
    for p in sorted(root.iterdir(), reverse=True):
        if not p.is_dir() or not p.name.startswith(_SNAPSHOT_PREFIX):
            continue
        snap_files = [f for f in p.iterdir() if f.is_file()]
        results.append({
            "name": p.name,
            "path": str(p),
            "size_bytes": sum(f.stat().st_size for f in snap_files),
            "files": [f.name for f in snap_files],
        })
    return results


class BackupScheduler:
    """Runs run_backup_sync on an interval while backup_enabled is set."""

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            await self._task

    async def _loop(self) -> None:
        from app.config import get_settings

        cfg = get_settings()
        while not self._stop_event.is_set():
            if _read_setting(cfg.db_path, "backup_enabled", False):
                try:
                    await asyncio.to_thread(run_backup_sync, cfg.db_path, cfg.clickhouse_database)
                except Exception as e:
                    log.warning("Scheduled backup failed: %s", e)
            interval_hours = _read_setting(cfg.db_path, "backup_interval_hours", 24)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=max(interval_hours, 1) * 3600)
            except asyncio.TimeoutError:
                pass
