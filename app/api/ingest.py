"""
POST /api/ingest/flows

Receives GoFlow2 JSON records POSTed by Vector.
Validates the ingest bearer token and checks source IP against the allowed-hosts list.

Vector sink config (vector.toml):
  [sinks.pktflow]
  type = "http"
  inputs = ["add_site"]
  uri = "http://172.23.80.5:8080/api/ingest/flows"
  encoding.codec = "json"
  auth.strategy = "bearer"
  auth.token = "<token_from_settings>"
"""
from __future__ import annotations

import ipaddress
import json
import logging
from typing import Any, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.database import get_db
from app.ingest.buffer import IngestBuffer
from app.ingest.normalizer import normalize_batch

log = logging.getLogger("pktflow.api.ingest")
router = APIRouter()
_bearer = HTTPBearer(auto_error=False)


async def _get_ingest_settings(db: aiosqlite.Connection) -> tuple[str, list[str]]:
    """Returns (ingest_token, allowed_cidrs_list)."""
    async with db.execute(
        "SELECT key, value FROM settings WHERE key IN ('ingest_token', 'allowed_hosts')"
    ) as cur:
        rows = {r[0]: json.loads(r[1]) async for r in cur}
    token = rows.get("ingest_token", "")
    allowed = rows.get("allowed_hosts", [])  # list of IP strings or CIDR blocks
    return token, allowed


def _ip_allowed(client_ip: str, allowed: list[str]) -> bool:
    """True if client_ip matches any entry in allowed (exact IP or CIDR)."""
    if not allowed:
        return True  # Empty list = allow all (open ingest)
    try:
        addr = ipaddress.ip_address(client_ip)
        for entry in allowed:
            try:
                if "/" in entry:
                    if addr in ipaddress.ip_network(entry, strict=False):
                        return True
                else:
                    if addr == ipaddress.ip_address(entry):
                        return True
            except ValueError:
                continue
    except ValueError:
        pass
    return False


@router.post("/flows", status_code=status.HTTP_204_NO_CONTENT)
async def ingest_flows(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Accept a JSON array of GoFlow2 flow records from Vector.
    Returns 204 No Content on success (matches Vector's expectation).
    """
    # ── Token auth ────────────────────────────────────────────────────────────
    expected_token, allowed_hosts = await _get_ingest_settings(db)

    if expected_token:
        if not credentials or credentials.credentials != expected_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid ingest token")

    # ── Source IP check ───────────────────────────────────────────────────────
    client_ip = request.client.host if request.client else "unknown"
    if not _ip_allowed(client_ip, allowed_hosts):
        log.warning(f"Rejected ingest from unauthorized source: {client_ip}")
        # Fire "new host" alert check asynchronously
        from app.alerts.engine import AlertEngine
        AlertEngine.notify_unknown_sampler(client_ip)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Source not in allowed hosts")

    # ── Parse body ────────────────────────────────────────────────────────────
    try:
        body = await request.body()
        raw_text = body.decode("utf-8")

        # Vector sends one JSON object per line (NDJSON) OR a JSON array
        raw_records: list[dict[str, Any]] = []
        if raw_text.strip().startswith("["):
            raw_records = json.loads(raw_text)
        else:
            for line in raw_text.splitlines():
                line = line.strip()
                if line:
                    raw_records.append(json.loads(line))
    except Exception as e:
        log.warning(f"Failed to parse ingest body: {e}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid JSON: {e}")

    if not raw_records:
        return  # 204

    # ── Normalize + buffer ────────────────────────────────────────────────────
    records = normalize_batch(raw_records)
    if records:
        buffer = IngestBuffer.get_instance()
        await buffer.add(records)
        log.debug(f"Buffered {len(records)}/{len(raw_records)} records from {client_ip}")

    return  # 204 No Content


@router.get("/stats")
async def ingest_stats():
    """Current ingest buffer statistics."""
    buffer = IngestBuffer.get_instance()
    return buffer.stats
