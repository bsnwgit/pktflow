"""
System management endpoints — restart, health, cleanup, etc.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import subprocess

import aiosqlite
from fastapi import APIRouter, Depends

from app.config import get_settings
from app.dependencies import require_admin
from app.storage.factory import get_storage

log = logging.getLogger("pktflow.system")
router = APIRouter()


async def _delayed_restart(delay: float = 1.5) -> None:
    """Wait briefly, then signal systemd to restart this service."""
    await asyncio.sleep(delay)
    try:
        # Preferred: ask systemd to restart (requires ec2-user passwordless sudo for this command)
        subprocess.Popen(
            ["sudo", "systemctl", "restart", "pktflow"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        # Fallback: kill the current process; systemd Restart=on-failure|always will revive it
        os.kill(os.getpid(), signal.SIGTERM)


@router.post("/cleanup", dependencies=[Depends(require_admin)])
async def run_cleanup() -> dict:
    """
    Manually trigger data retention cleanup:
      - ClickHouse flows: MATERIALIZE TTL (async mutation, uses retention_days_raw)
      - ClickHouse hourly rollup: MATERIALIZE TTL (uses retention_days_hourly)
      - SQLite alert_events + notification_log: synchronous delete (uses alert_event_retention_days)

    Returns eligible row counts for ClickHouse (pre-deletion estimate) and
    exact deleted count for alert events.
    """
    cfg = get_settings()
    storage = get_storage()

    # ── Read retention settings from SQLite ───────────────────────────────────
    retention_raw     = 90
    retention_hourly  = 365
    retention_alerts  = 90
    async with aiosqlite.connect(cfg.db_path) as db:
        async with db.execute(
            "SELECT key, value FROM settings WHERE key IN "
            "('retention_days_raw','retention_days_hourly','alert_event_retention_days')"
        ) as cur:
            async for row in cur:
                try:
                    val = int(json.loads(row[1]))
                    if row[0] == 'retention_days_raw':     retention_raw    = val
                    if row[0] == 'retention_days_hourly':  retention_hourly = val
                    if row[0] == 'alert_event_retention_days': retention_alerts = val
                except (ValueError, TypeError):
                    pass

    result: dict = {
        "flows_eligible": 0,
        "hourly_eligible": 0,
        "alert_events_deleted": 0,
        "notification_log_deleted": 0,
        "status": "ok",
    }

    # ── ClickHouse: count eligible rows, then queue TTL materialization ───────
    db_name = cfg.clickhouse_database

    def _ch_cleanup():
        from app.storage.clickhouse import ClickHouseStorage
        if not isinstance(storage, ClickHouseStorage):
            return

        # Count rows beyond retention threshold (estimate for user feedback)
        rows_q = (
            f"SELECT count() FROM {db_name}.flows "
            f"WHERE timestamp < now() - INTERVAL {retention_raw} DAY"
        )
        r = storage._execute(rows_q)
        result["flows_eligible"] = int(r[0][0]) if r else 0

        hourly_q = (
            f"SELECT count() FROM {db_name}.flows_hourly "
            f"WHERE hour < now() - INTERVAL {retention_hourly} DAY"
        )
        r2 = storage._execute(hourly_q)
        result["hourly_eligible"] = int(r2[0][0]) if r2 else 0

        # Queue TTL materialization (async ClickHouse mutations)
        storage._execute(f"ALTER TABLE {db_name}.flows MATERIALIZE TTL")
        storage._execute(f"ALTER TABLE {db_name}.flows_hourly MATERIALIZE TTL")

    try:
        await asyncio.to_thread(_ch_cleanup)
        result["clickhouse_status"] = "queued"
    except Exception as e:
        log.warning(f"ClickHouse cleanup error: {e}")
        result["clickhouse_status"] = f"error: {e}"

    # ── SQLite: delete old alert events synchronously ────────────────────────
    try:
        async with aiosqlite.connect(cfg.db_path) as db:
            cur = await db.execute(
                "DELETE FROM notification_log WHERE event_id IN "
                "(SELECT id FROM alert_events WHERE fired_at < datetime('now', ?))",
                (f"-{retention_alerts} days",),
            )
            result["notification_log_deleted"] = cur.rowcount
            cur2 = await db.execute(
                "DELETE FROM alert_events WHERE fired_at < datetime('now', ?)",
                (f"-{retention_alerts} days",),
            )
            result["alert_events_deleted"] = cur2.rowcount
            await db.commit()
    except Exception as e:
        log.warning(f"Alert event cleanup error: {e}")
        result["alert_events_status"] = f"error: {e}"

    log.info(
        f"Manual cleanup: flows_eligible={result['flows_eligible']}, "
        f"hourly_eligible={result['hourly_eligible']}, "
        f"alert_events_deleted={result['alert_events_deleted']}"
    )
    return result


@router.post("/restart", dependencies=[Depends(require_admin)])
async def restart_service() -> dict:
    """
    Restart the pktFlow service.  Response is sent immediately; the
    service process exits ~1.5 s later and systemd brings it back up.
    Requires admin role.
    """
    log.warning("Service restart requested via API")
    asyncio.create_task(_delayed_restart())
    return {"status": "restarting", "message": "Service will restart in ~2 seconds"}
