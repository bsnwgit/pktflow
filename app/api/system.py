"""
System management endpoints — restart, health, etc.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess

from fastapi import APIRouter, Depends

from app.dependencies import require_admin

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
