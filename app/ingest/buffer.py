"""
Ingest buffer — collects incoming flow records and flushes to storage
in batches for efficiency (avoids one ClickHouse insert per flow).

Flush triggers (whichever comes first):
  - Buffer reaches BUFFER_SIZE records
  - FLUSH_INTERVAL_SECS seconds have elapsed since last flush
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from app.config import get_settings
from app.models.flow import FlowRecord

log = logging.getLogger("pktflow.ingest.buffer")
settings = get_settings()


class IngestBuffer:
    _instance: "Optional[IngestBuffer]" = None

    def __init__(self):
        self._buffer: list[FlowRecord] = []
        self._lock = asyncio.Lock()
        self._flush_task: Optional[asyncio.Task] = None
        self._total_received: int = 0
        self._total_flushed: int = 0
        self._last_flush: datetime = datetime.now(tz=timezone.utc)

    @classmethod
    def get_instance(cls) -> "IngestBuffer":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def start(self) -> None:
        self._flush_task = asyncio.create_task(self._flush_loop())
        log.info(
            f"Ingest buffer started "
            f"(size={settings.ingest_buffer_size}, "
            f"flush_interval={settings.ingest_buffer_flush_secs}s)"
        )

    async def stop(self) -> None:
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        await self._flush()  # Drain remaining records

    async def add(self, records: list[FlowRecord]) -> None:
        """Add records to the buffer; auto-flushes if size threshold hit."""
        async with self._lock:
            self._buffer.extend(records)
            self._total_received += len(records)

        if len(self._buffer) >= settings.ingest_buffer_size:
            await self._flush()

    async def _flush(self) -> None:
        async with self._lock:
            if not self._buffer:
                return
            batch = self._buffer[:]
            self._buffer.clear()

        try:
            from app.storage.factory import get_storage
            storage = get_storage()
            await storage.insert_flows(batch)
            self._total_flushed += len(batch)
            self._last_flush = datetime.now(tz=timezone.utc)
            log.debug(f"Flushed {len(batch)} records (total flushed: {self._total_flushed})")
            # Notify WebSocket clients of new data (fire-and-forget)
            try:
                from app.api.ws import (
                    broadcast_device_update,
                    broadcast_ingest_stats,
                    broadcast_flow_update,
                )
                asyncio.create_task(broadcast_device_update())
                asyncio.create_task(broadcast_ingest_stats(self.stats))
                asyncio.create_task(broadcast_flow_update([f.model_dump() for f in batch]))
            except Exception:
                pass
        except Exception as e:
            log.error(f"Flush failed — {len(batch)} records lost: {e}")

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(settings.ingest_buffer_flush_secs)
            await self._flush()

    @property
    def stats(self) -> dict:
        return {
            "buffered": len(self._buffer),
            "total_received": self._total_received,
            "total_flushed": self._total_flushed,
            "last_flush": self._last_flush.isoformat(),
        }
