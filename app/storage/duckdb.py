"""
DuckDB storage backend.
Embedded, zero-config alternative to ClickHouse.
Suitable for low-traffic deployments (<50 flows/sec) or dev/test environments.

DuckDB is synchronous, so every call is wrapped in asyncio.to_thread.
The database file lives at settings.duckdb_path (default: /mnt/software/pktflow/flows.duckdb).
"""
from __future__ import annotations

import asyncio
import logging
import threading
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

# DuckDB is not thread-safe for concurrent writes — use a lock
_write_lock = threading.Lock()

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

CREATE INDEX IF NOT EXISTS idx_flows_ts          ON flows (timestamp);
CREATE INDEX IF NOT EXISTS idx_flows_sampler     ON flows (sampler_ip);
CREATE INDEX IF NOT EXISTS idx_flows_src_ip      ON flows (src_ip);
CREATE INDEX IF NOT EXISTS idx_flows_dst_ip      ON flows (dst_ip);
"""


class DuckDBBackend(StorageBackend):

    def __init__(self):
        self._conn: Optional[duckdb.DuckDBPyConnection] = None
        self._db_path: str = getattr(settings, "duckdb_path", "/mnt/software/pktflow/flows.duckdb")

    def _get_conn(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            raise RuntimeError("DuckDB not connected — call connect() first")
        return self._conn

    def _exec(self, sql: str, params=None):
        conn = self._get_conn()
        if params:
            return conn.execute(sql, params).fetchall()
        return conn.execute(sql).fetchall()

    def _exec_write(self, sql: str, params=None):
        """Execute a write with the lock held."""
        with _write_lock:
            conn = self._get_conn()
            if params:
                conn.execute(sql, params)
            else:
                conn.execute(sql)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        def _open():
            self._conn = duckdb.connect(self._db_path)
            # Apply schema (idempotent)
            for stmt in _SCHEMA.strip().split(";"):
                stmt = stmt.strip()
                if stmt:
                    self._conn.execute(stmt)
        await asyncio.to_thread(_open)
        log.info(f"DuckDB connected: {self._db_path}")

    async def close(self) -> None:
        def _close():
            if self._conn:
                self._conn.close()
                self._conn = None
        await asyncio.to_thread(_close)

    # ── Insert ────────────────────────────────────────────────────────────────

    async def insert_flows(self, flows: list[FlowRecord]) -> None:
        if not flows:
            return

        def _insert():
            with _write_lock:
                conn = self._get_conn()
                rows = [f.to_clickhouse_row() for f in flows]
                conn.executemany(
                    """INSERT INTO flows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    rows,
                )
        await asyncio.to_thread(_insert)

    # ── Dashboard ─────────────────────────────────────────────────────────────

    async def get_device_summaries(self) -> list[DeviceSummary]:
        def _query():
            cutoff_24h = datetime.now(tz=timezone.utc) - timedelta(hours=24)
            cutoff_1h  = datetime.now(tz=timezone.utc) - timedelta(hours=1)
            return self._exec("""
                SELECT
                    sampler_ip,
                    FIRST(sampler_name ORDER BY timestamp DESC)           AS sampler_name,
                    FIRST(site        ORDER BY timestamp DESC)            AS site,
                    SUM(CASE WHEN timestamp >= ? THEN bytes   ELSE 0 END) AS bytes_last_hour,
                    SUM(CASE WHEN timestamp >= ? THEN packets ELSE 0 END) AS packets_last_hour,
                    COUNT(CASE WHEN timestamp >= ? THEN 1     END)        AS flows_last_hour,
                    MAX(timestamp)                                         AS last_seen
                FROM flows
                WHERE timestamp >= ?
                GROUP BY sampler_ip
                ORDER BY sampler_name
            """, [cutoff_1h, cutoff_1h, cutoff_1h, cutoff_24h])

        rows = await asyncio.to_thread(_query)
        result = []
        for row in rows:
            result.append(DeviceSummary(
                sampler_ip=row[0],
                sampler_name=row[1] or "",
                site=row[2] or "",
                bytes_last_hour=row[3] or 0,
                packets_last_hour=row[4] or 0,
                flows_last_hour=row[5] or 0,
                flows_per_sec=round((row[5] or 0) / 3600, 2),
                last_seen=row[6],
            ))
        return result

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
            params = [start, end]
            if sampler_ip:
                params.append(sampler_ip)
            params.append(limit)
            return self._exec(f"""
                SELECT src_ip, dst_ip, dst_port, protocol,
                       SUM(bytes) AS bytes, SUM(packets) AS packets, COUNT(*) AS flow_count
                FROM flows
                WHERE timestamp BETWEEN ? AND ? {where_extra}
                GROUP BY src_ip, dst_ip, dst_port, protocol
                ORDER BY bytes DESC
                LIMIT ?
            """, params)

        rows = await asyncio.to_thread(_query)
        return [
            TopTalker(
                src_ip=r[0], dst_ip=r[1],
                dst_port=r[2], protocol=r[3],
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
            params = [bucket_seconds, start, end]
            if sampler_ip:
                params.append(sampler_ip)
            # DuckDB: epoch_ms / (bucket_ms) * bucket_ms gives bucket start
            return self._exec(f"""
                SELECT
                    epoch_ms(
                        (epoch_ms(timestamp) / (? * 1000)) * (? * 1000)
                    )::TIMESTAMPTZ                        AS ts,
                    SUM(bytes)                            AS bytes,
                    SUM(packets)                          AS packets,
                    COUNT(*)                              AS flow_count
                FROM flows
                WHERE timestamp BETWEEN ? AND ? {where_extra}
                GROUP BY ts
                ORDER BY ts
            """, [bucket_seconds, bucket_seconds] + params[1:])

        rows = await asyncio.to_thread(_query)
        return [TimeSeriesPoint(timestamp=r[0], bytes=r[1], packets=r[2], flow_count=r[3]) for r in rows]

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
            conditions = []
            params = []
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
            return self._exec(f"""
                SELECT timestamp, sampler_ip, sampler_name, src_ip, dst_ip,
                       src_port, dst_port, protocol, bytes, packets, duration_ms,
                       tcp_flags, tos, input_if, output_if, next_hop, src_as, dst_as, flow_dir
                FROM flows
                {where}
                ORDER BY timestamp DESC
                LIMIT ? OFFSET ?
            """, params)

        rows = await asyncio.to_thread(_query)
        return [
            FlowSearchResult(
                timestamp=r[0], sampler_ip=r[1], sampler_name=r[2] or "",
                src_ip=r[3], dst_ip=r[4],
                src_port=r[5], dst_port=r[6], protocol=r[7],
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
            return self._exec("SELECT COUNT(*) / 60.0 FROM flows WHERE timestamp >= ?", [cutoff])

        rows = await asyncio.to_thread(_query)
        return float(rows[0][0]) if rows else 0.0

    async def get_sampler_last_seen(self) -> dict[str, datetime]:
        def _query():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(days=1)
            return self._exec(
                "SELECT sampler_ip, MAX(timestamp) FROM flows WHERE timestamp >= ? GROUP BY sampler_ip",
                [cutoff],
            )

        rows = await asyncio.to_thread(_query)
        return {r[0]: r[1] for r in rows}

    # ── Retention ─────────────────────────────────────────────────────────────

    async def update_retention_ttl(self, days: int) -> None:
        """DuckDB has no built-in TTL — delete rows older than `days` days."""
        def _delete():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
            with _write_lock:
                deleted = self._get_conn().execute(
                    "DELETE FROM flows WHERE timestamp < ? RETURNING COUNT(*)", [cutoff]
                ).fetchone()
            return deleted[0] if deleted else 0

        n = await asyncio.to_thread(_delete)
        log.info(f"DuckDB retention purge: removed {n} rows older than {days} days")

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
            params = [start, end]
            if sampler_ip:
                where_parts.append("sampler_ip = ?")
                params.append(sampler_ip)
            where = " AND ".join(where_parts)

            edge_rows = self._exec(f"""
                SELECT src_ip, dst_ip, SUM(bytes) AS bytes, SUM(packets) AS packets,
                       COUNT(*) AS flows, FIRST(protocol) AS protocol, FIRST(dst_port) AS dst_port
                FROM flows
                WHERE {where}
                GROUP BY src_ip, dst_ip
                HAVING bytes >= ?
                ORDER BY bytes DESC
                LIMIT ?
            """, params + [min_bytes, limit])

            sampler_rows = self._exec(f"""
                SELECT sampler_ip,
                       FIRST(sampler_name ORDER BY timestamp DESC) AS name,
                       FIRST(site        ORDER BY timestamp DESC) AS site
                FROM flows
                WHERE {where}
                GROUP BY sampler_ip
            """, params)

            return edge_rows, sampler_rows

        edge_rows, sampler_rows = await asyncio.to_thread(_query)

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
