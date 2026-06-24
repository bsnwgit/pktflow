"""
WebSocket endpoints — real-time push to connected browser clients.

/api/ws/dashboard  — streams DeviceSummary updates after every ingest flush.
Auth: pass JWT access token as ?token= query parameter (browsers can't send
custom headers on WebSocket upgrade requests).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from app.auth.local import decode_access_token

log = logging.getLogger("pktflow.ws")
router = APIRouter()


# ── Connection manager ────────────────────────────────────────────────────────

class WebSocketManager:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.add(ws)
        log.info("WS client connected (%d total)", len(self._connections))

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.discard(ws)
        log.info("WS client disconnected (%d total)", len(self._connections))

    async def send_one(self, ws: WebSocket, message: dict) -> bool:
        """Send to a single client; returns False if the send failed."""
        try:
            await ws.send_text(json.dumps(message, default=str))
            return True
        except Exception:
            self._connections.discard(ws)
            return False

    async def broadcast(self, message: dict) -> None:
        if not self._connections:
            return
        payload = json.dumps(message, default=str)
        dead: set[WebSocket] = set()
        for ws in list(self._connections):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)
        self._connections -= dead

    @property
    def connection_count(self) -> int:
        return len(self._connections)


ws_manager = WebSocketManager()


# ── Broadcast helpers (called by IngestBuffer after flush) ────────────────────

async def broadcast_device_update() -> None:
    """Fetch current DeviceSummary list and push to all connected clients."""
    if ws_manager.connection_count == 0:
        return
    try:
        from app.storage.factory import get_storage
        devices = await get_storage().get_device_summaries()
        await ws_manager.broadcast({
            "type": "device_update",
            "data": [d.model_dump() for d in devices],
        })
    except Exception as exc:
        log.warning("WS device broadcast failed: %s", exc)


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.websocket("/ws/dashboard")
async def ws_dashboard(
    websocket: WebSocket,
    token: str = Query(..., description="JWT access token"),
) -> None:
    """
    Real-time device summary stream.
    Connect with:  ws://<host>/api/ws/dashboard?token=<access_token>
    Messages:      {"type": "device_update", "data": [...DeviceSummary]}
    """
    payload = decode_access_token(token)
    if not payload:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await ws_manager.connect(websocket)
    try:
        # Push current state immediately on connect
        await broadcast_device_update()

        # Keep alive — wait for client disconnect or ping
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                if msg == "ping":
                    await websocket.send_text("pong")
            except asyncio.TimeoutError:
                # Send a keepalive so load balancers don't kill idle connections
                try:
                    await websocket.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    finally:
        ws_manager.disconnect(websocket)
