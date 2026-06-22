"""
DuckDB storage backend.
Embedded, zero-config alternative to ClickHouse for low-to-mid traffic deployments.

Concurrency design
------------------
DuckDB requires each connection to be used by exactly one thread.  To allow
reads and writes to proceed independently we open TWO connections to the same
file and route them through dedicated single-thread executors:

    _WRITE_EXECUTOR (max_workers=1)  ←→  _wconn   — inserts, schema, retention
    _READ_EXECUTOR  (max_workers=1)  ←→  _rconn   — all SELECT queries

Because the executors are separate, read queries never queue behind in-progress
inserts and there is no mutex contention between them.  DuckDB's internal WAL
handles concurrent access between the two connections safely.

Both connections are opened in the default (write) mode — opening a second
connection with read_only=True while a write connection exists raises a
"different configuration" error in DuckDB, so we simply use write mode for
both and rely on discipline (reads only go through _rconn).
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import duckdb

from app.config import get_settings
from app.models.flow import (
    FlowRecord, TopTalker, TimeSeriesPoint,
    DeviceSummary, FlowSearchResult,
    TopologyNode, TopologyEdge,
)
from app.storage.base import StorageBackend

log = logging.getLogger("pktflow.storage.duckdb")
settings = get_settings()

# ── Dedicated per-role executors ───────────────────────────────────────────────
# max_workers=1 guarantees each executor's connection is only ever touched by
# one thread at a time, satisfying DuckDB's thread-safety requirement.
_WRITE_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="duckdb-write"
)
_READ_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="duckdb-read"
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS flows (
    timestamp        TIMESTAMPTZ NOT NULL,
    sampler_ip       VARCHAR     NOT NULL,
    sampler_name     VARCHAR     DEFAULT '',
    site             VARCHAR     DEFAULT '',
    src_ip           VARCHAR     DEFAULT '0.0.0.0',
    dst_ip           VARCHAR     DEFAULT '0.0.0.0',
    src_port         INTEGER     DEFAULT 0,
    dst_port         INTEGER     DEFAULT 0,
    protocol         INTEGER     DEFAULT 0,
    bytes            BIGINT      DEFAULT 0,
    packets          BIGINT      DEFAULT 0,
    duration_ms      INTEGER     DEFAULT 0,
    tcp_flags        INTEGER     DEFAULT 0,
    tos              INTEGER     DEFAULT 0,
    input_if         INTEGER     DEFAULT 0,
    output_if        INTEGER     DEFAULT 0,
    next_hop         VARCHAR     DEFAULT '0.0.0.0',
    src_as           INTEGER     DEFAULT 0,
    dst_as           INTEGER     DEFAULT 0,
    flow_dir         INTEGER     DEFAULT 2
);

CREATE INDEX IF NOT EXISTS idx_flows_ts      ON flows (timestamp);
CREATE INDEX IF NOT EXISTS idx_flows_sampler ON flows (sampler_ip);
CREATE INDEX IF NOT EXISTS idx_flows_src_ip  ON flows (src_ip);
CREATE INDEX IF NOT EXISTS idx_flows_dst_ip  ON flows (dst_ip);
"""


class DuckDBBackend(StorageBackend):

    def __init__(self):
        self._wconn: Optional[duckdb.DuckDBPyConnection] = None  # write connection
        self._rconn: Optional[duckdb.DuckDBPyConnection] = None  # read connection
        self._db_path: str = getattr(
            settings, "duckdb_path", "/mnt/software/pktflow/flows.duckdb"
        )

    # ── Executor helpers ───────────────────────────────────────────────────────

    async def _run_write(self, fn):
        """Run a blocking function in the write executor thread."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_WRITE_EXECUTOR, fn)

    async def _run_read(self, fn, timeout: float = 20.0):
        """Run a read function in the read executor thread with a timeout.

        asyncio.shield() prevents wait_for from blocking on a non-cancellable
        concurrent.futures thread (a known Python 3.9 issue where
        _cancel_and_wait() stalls when the underlying thread cannot be stopped).
        The shield lets wait_for cancel the *wrapper*, not the thread — the
        thread completes in the background and the caller gets None immediately.
        """
        loop = asyncio.get_event_loop()
        fut = loop.run_in_executor(_READ_EXECUTOR, fn)
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("DuckDB read timed out after %.1fs — query still running in background", timeout)
            return None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        # Open write connection first (also creates/migrates schema)
        def _open_write():
            self._wconn = duckdb.connect(self._db_path)
            for stmt in _SCHEMA.strip().split(";"):
                s = stmt.strip()
                if s:
                    self._wconn.execute(s)

        # Open read connection after schema exists
        def _open_read():
            self._rconn = duckdb.connect(self._db_path)

        await self._run_write(_open_write)
        await self._run_read(_open_read)
        log.info("DuckDB connected (write+read executors): %s", self._db_path)

    async def close(self) -> None:
        def _close_write():
            if self._wconn:
                self._wconn.close()
                self._wconn = None

        def _close_read():
            if self._rconn:
                self._rconn.close()
                self._rconn = None

        await self._run_write(_close_write)
        await self._run_read(_close_read)

    # ── Insert ────────────────────────────────────────────────────────────────

    async def insert_flows(self, flows: list[FlowRecord]) -> None:
        if not flows:
            return

        def _insert():
            rows = [f.to_clickhouse_row() for f in flows]
            self._wconn.executemany(
                "INSERT INTO flows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )

        await self._run_write(_insert)

    # ── Dashboard ─────────────────────────────────────────────────────────────

    async def get_device_summaries(self) -> list[DeviceSummary]:
        def _query():
            cutoff_24h = datetime.now(tz=timezone.utc) - timedelta(hours=24)
            cutoff_1h  = datetime.now(tz=timezone.utc) - timedelta(hours=1)
            return self._rconn.execute("""
                SELECT
                    sampler_ip,
                    ARG_MAX(sampler_name, timestamp)                      AS sampler_name,
                    ARG_MAX(site,         timestamp)                      AS site,
                    SUM(CASE WHEN timestamp >= ? THEN bytes   ELSE 0 END) AS bytes_last_hour,
                    SUM(CASE WHEN timestamp >= ? THEN packets ELSE 0 END) AS packets_last_hour,
                    COUNT(CASE WHEN timestamp >= ? THEN 1     END)        AS flows_last_hour,
                    MAX(timestamp)                                         AS last_seen
                FROM flows
                WHERE timestamp >= ?
                GROUP BY sampler_ip
                ORDER BY sampler_name
            """, [cutoff_1h, cutoff_1h, cutoff_1h, cutoff_24h]).fetchall()

        rows = await self._run_read(_query) or []
        return [
            DeviceSummary(
                sampler_ip=row[0],
                sampler_name=row[1] or "",
                site=row[2] or "",
                bytes_last_hour=row[3] or 0,
                packets_last_hour=row[4] or 0,
                flows_last_hour=row[5] or 0,
                flows_per_sec=round((row[5] or 0) / 3600, 2),
                last_seen=row[6],
            )
            for row in rows
        ]

    # ── Top talkers ───────────────────────────────────────────────────────────

    async def get_top_talkers(
        self,
        sampler_ip: Optional[str],
        start: datetime,
        end: datetime,
        limit: int = 50,
    ) -> list[TopTalker]:
        def _query():
            where_extra = "AND sampler_ip = ?" if sampler_ip else ""
            params: list = [start, end]
            if sampler_ip:
                params.append(sampler_ip)
            params.append(limit)
            return self._rconn.execute(f"""
                SELECT src_ip, dst_ip, dst_port, protocol,
                       SUM(bytes) AS bytes, SUM(packets) AS packets, COUNT(*) AS flow_count
                FROM flows
                WHERE timestamp BETWEEN ? AND ? {where_extra}
                GROUP BY src_ip, dst_ip, dst_port, protocol
                ORDER BY bytes DESC
                LIMIT ?
            """, params).fetchall()

        rows = await self._run_read(_query) or []
        return [
            TopTalker(
                src_ip=r[0], dst_ip=r[1], dst_port=r[2], protocol=r[3],
                bytes=r[4], packets=r[5], flow_count=r[6],
            )
            for r in rows
        ]

    # ── Time series ───────────────────────────────────────────────────────────

    async def get_time_series(
        self,
        sampler_ip: Optional[str],
        start: datetime,
        end: datetime,
        bucket_seconds: int = 60,
    ) -> list[TimeSeriesPoint]:
        def _query():
            where_extra = "AND sampler_ip = ?" if sampler_ip else ""
            params: list = [bucket_seconds, bucket_seconds, start, end]
            if sampler_ip:
                params.append(sampler_ip)
            return self._rconn.execute(f"""
                SELECT
                    epoch_ms(
                        (epoch_ms(timestamp) / (? * 1000)) * (? * 1000)
                    )::TIMESTAMPTZ AS ts,
                    SUM(bytes)     AS bytes,
                    SUM(packets)   AS packets,
                    COUNT(*)       AS flow_count
                FROM flows
                WHERE timestamp BETWEEN ? AND ? {where_extra}
                GROUP BY ts
                ORDER BY ts
            """, params).fetchall()

        rows = await self._run_read(_query) or []
        return [
            TimeSeriesPoint(timestamp=r[0], bytes=r[1], packets=r[2], flow_count=r[3])
            for r in rows
        ]

    # ── Flow search ───────────────────────────────────────────────────────────

    async def search_flows(
        self,
        src_ip: Optional[str] = None,
        dst_ip: Optional[str] = None,
        src_port: Optional[int] = None,
        dst_port: Optional[int] = None,
        protocol: Optional[int] = None,
        sampler_ip: Optional[str] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[FlowSearchResult]:
        def _query():
            conditions: list[str] = []
            params: list = []
            if start:
                conditions.append("timestamp >= ?"); params.append(start)
            if end:
                conditions.append("timestamp <= ?"); params.append(end)
            if src_ip:
                conditions.append("src_ip = ?"); params.append(src_ip)
            if dst_ip:
                conditions.append("dst_ip = ?"); params.append(dst_ip)
            if src_port is not None:
                conditions.append("src_port = ?"); params.append(src_port)
            if dst_port is not None:
                conditions.append("dst_port = ?"); params.append(dst_port)
            if protocol is not None:
                conditions.append("protocol = ?"); params.append(protocol)
            if sampler_ip:
                conditions.append("sampler_ip = ?"); params.append(sampler_ip)
            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params += [limit, offset]
            return self._rconn.execute(f"""
                SELECT timestamp, sampler_ip, sampler_name, src_ip, dst_ip,
                       src_port, dst_port, protocol, bytes, packets, duration_ms,
                       tcp_flags, tos, input_if, output_if, next_hop,
                       src_as, dst_as, flow_dir
                FROM flows
                {where}
                ORDER BY timestamp DESC
                LIMIT ? OFFSET ?
            """, params).fetchall()

        rows = await self._run_read(_query) or []
        return [
            FlowSearchResult(
                timestamp=r[0], sampler_ip=r[1], sampler_name=r[2] or "",
                src_ip=r[3], dst_ip=r[4], src_port=r[5], dst_port=r[6], protocol=r[7],
                bytes=r[8], packets=r[9], duration_ms=r[10],
                tcp_flags=r[11] or 0, tos=r[12] or 0,
                input_if=r[13] or 0, output_if=r[14] or 0,
                next_hop=r[15] or "0.0.0.0",
                src_as=r[16] or 0, dst_as=r[17] or 0, flow_dir=r[18] or 2,
            )
            for r in rows
        ]

    # ── Rates ─────────────────────────────────────────────────────────────────

    async def get_flows_per_sec(self) -> float:
        def _query():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=60)
            return self._rconn.execute(
                "SELECT COUNT(*) / 60.0 FROM flows WHERE timestamp >= ?", [cutoff]
            ).fetchall()

        rows = await self._run_read(_query)
        return float(rows[0][0]) if rows else 0.0

    async def get_sampler_last_seen(self) -> dict[str, datetime]:
        def _query():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(days=1)
            return self._rconn.execute(
                "SELECT sampler_ip, MAX(timestamp) FROM flows "
                "WHERE timestamp >= ? GROUP BY sampler_ip",
                [cutoff],
            ).fetchall()

        rows = await self._run_read(_query) or []
        return {r[0]: r[1] for r in rows}

    # ── Retention ─────────────────────────────────────────────────────────────

    async def update_retention_ttl(self, days: int) -> None:
        """Delete rows older than `days` days (DuckDB has no built-in TTL)."""
        def _delete():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
            result = self._wconn.execute(
                "DELETE FROM flows WHERE timestamp < ? RETURNING count(*)", [cutoff]
            ).fetchone()
            return result[0] if result else 0

        n = await self._run_write(_delete)
        log.info("DuckDB retention purge: removed %d rows older than %d days", n, days)

    # ── Topology ──────────────────────────────────────────────────────────────

    async def get_topology(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
        min_bytes: int = 0,
        limit: int = 200,
    ) -> tuple[list[TopologyNode], list[TopologyEdge]]:
        def _query():
            where_parts = ["timestamp BETWEEN ? AND ?"]
            params: list = [start, end]
            if sampler_ip:
                where_parts.append("sampler_ip = ?")
                params.append(sampler_ip)
            where = " AND ".join(where_parts)

            edge_rows = self._rconn.execute(f"""
                SELECT src_ip, dst_ip,
                       SUM(bytes)    AS bytes,
                       SUM(packets)  AS packets,
                       COUNT(*)      AS flows,
                       MIN(protocol) AS protocol,
                       MIN(dst_port) AS dst_port
                FROM flows
                WHERE {where}
                GROUP BY src_ip, dst_ip
                HAVING SUM(bytes) >= ?
                ORDER BY bytes DESC
                LIMIT ?
            """, params + [min_bytes, limit]).fetchall()

            sampler_rows = self._rconn.execute(f"""
                SELECT sampler_ip,
                       ARG_MAX(sampler_name, timestamp) AS name,
                       ARG_MAX(site,         timestamp) AS site
                FROM flows
                WHERE {where}
                GROUP BY sampler_ip
            """, params).fetchall()

            return edge_rows, sampler_rows

        result = await self._run_read(_query)
        edge_rows, sampler_rows = result if result else ([], [])

        sampler_map = {r[0]: {"name": r[1] or "", "site": r[2] or ""} for r in sampler_rows}

        edges: list[TopologyEdge] = []
        node_bytes: dict[str, int] = {}
        node_flows: dict[str, int] = {}
        for r in edge_rows:
            src, dst = r[0], r[1]
            edges.append(TopologyEdge(
                source=src, target=dst,
                bytes=r[2], packets=r[3], flows=r[4],
                protocol=r[5] or 0, dst_port=r[6] or 0,
            ))
            node_bytes[src] = node_bytes.get(src, 0) + r[2]
            node_bytes[dst] = node_bytes.get(dst, 0) + r[2]
            node_flows[src] = node_flows.get(src, 0) + r[4]
            node_flows[dst] = node_flows.get(dst, 0) + r[4]

        nodes: list[TopologyNode] = []
        for ip in set(node_bytes.keys()):
            info = sampler_map.get(ip, {})
            nodes.append(TopologyNode(
                id=ip,
                sampler_name=info.get("name", ""),
                site=info.get("site", ""),
                bytes=node_bytes.get(ip, 0),
                flows=node_flows.get(ip, 0),
                is_sampler=ip in sampler_map,
            ))

        return nodes, edges
