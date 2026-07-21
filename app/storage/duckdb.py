"""
DuckDB storage backend — enterprise concurrency design.

Architecture
------------
DuckDB requires each connection to be accessed by a single thread at a time.
To support concurrent reads without blocking on in-progress writes we use a
pooled multi-connection design:

    Write path
    ──────────
    _WRITE_EXECUTOR (max_workers=1)
        └── _wconn  ← one connection, one thread, zero contention on writes

    Read path
    ─────────
    _READ_EXECUTOR (max_workers=READ_POOL_SIZE)
        └── _ReadPool (READ_POOL_SIZE connections)
                ├── conn-0  ← thread 0 acquires, queries, releases
                ├── conn-1  ← thread 1 acquires, queries, releases
                └── …

    Each read thread borrows a connection from the pool (blocking queue with
    timeout), executes its query, and returns the connection.  READ_POOL_SIZE
    concurrent read queries can execute simultaneously without blocking each
    other or the write thread.

Timeout strategy
────────────────
asyncio.wait({fut}, timeout=N) is used for read timeouts instead of
asyncio.wait_for().  The key difference: asyncio.wait() does NOT attempt to
cancel the underlying future when the timeout expires — it simply returns
(done, pending) and the caller handles the pending case.  This avoids the
Python 3.9 bug where wait_for's _cancel_and_wait() stalls indefinitely
trying to cancel a non-cancellable concurrent.futures thread.  The thread
always runs to completion in the background; the HTTP handler returns an
empty/default result immediately after the timeout.

Scaling
───────
READ_POOL_SIZE can be increased for heavier read workloads.  Writes are
inherently single-writer in DuckDB (OLAP workloads do not need concurrent
writers); the single write thread is not a bottleneck at typical NetFlow
ingest rates.
"""
from __future__ import annotations

import asyncio
import contextlib
import concurrent.futures
import logging
import queue as _queue
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
from app.topology_enrich import attach_dominant_sampler

log = logging.getLogger("pktflow.storage.duckdb")
settings = get_settings()

# ── Pool / executor sizing ─────────────────────────────────────────────────────
# READ_POOL_SIZE concurrent read queries.  Each needs its own DuckDB connection
# and its own executor thread.  4 is a sensible default; tune up for heavier
# dashboard / API workloads.
READ_POOL_SIZE: int = 4
READ_QUERY_TIMEOUT: float = 30.0   # seconds before a read returns None

_WRITE_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="duckdb-write"
)
_READ_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=READ_POOL_SIZE, thread_name_prefix="duckdb-read"
)

# ── Schema ────────────────────────────────────────────────────────────────────
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


# ── Connection pool ───────────────────────────────────────────────────────────

class _ReadPool:
    """
    Bounded pool of DuckDB connections for concurrent read queries.

    Each connection is owned by at most one thread at a time (enforced by the
    blocking queue).  Threads acquire a connection, run their query, then
    return it to the pool.  If all connections are checked out the acquiring
    thread blocks up to `acquire_timeout` seconds before raising.
    """

    def __init__(self, db_path: str, size: int = READ_POOL_SIZE,
                 acquire_timeout: float = READ_QUERY_TIMEOUT):
        self._db_path = db_path
        self._size = size
        self._acquire_timeout = acquire_timeout
        self._pool: _queue.Queue[duckdb.DuckDBPyConnection] = _queue.Queue(maxsize=size)

    def open(self) -> None:
        """Open all pool connections.  Safe to call from any single thread."""
        for i in range(self._size):
            conn = duckdb.connect(self._db_path)
            self._pool.put(conn)
        log.info("DuckDB read pool open: %d connections at %s", self._size, self._db_path)

    @contextlib.contextmanager
    def acquire(self):
        """
        Context manager: check out a connection, yield it, then return it.
        Raises RuntimeError if no connection becomes available within the
        configured timeout.
        """
        try:
            conn = self._pool.get(timeout=self._acquire_timeout)
        except _queue.Empty:
            raise RuntimeError(
                f"DuckDB read pool exhausted — all {self._size} connections busy "
                f"after {self._acquire_timeout:.0f}s"
            )
        try:
            yield conn
        except Exception:
            # If the connection threw an error it may be invalid; replace it.
            try:
                conn.close()
            except Exception:
                pass
            try:
                conn = duckdb.connect(self._db_path)
            except Exception as e:
                log.error("DuckDB: failed to replace broken connection: %s", e)
                conn = None
            finally:
                if conn is not None:
                    self._pool.put(conn)
            raise
        else:
            self._pool.put(conn)

    @property
    def size(self) -> int:
        return self._size

    @property
    def available(self) -> int:
        return self._pool.qsize()

    def close_all(self) -> None:
        """Close every connection.  Call on shutdown."""
        closed = 0
        while True:
            try:
                conn = self._pool.get_nowait()
                try:
                    conn.close()
                except Exception:
                    pass
                closed += 1
            except _queue.Empty:
                break
        log.info("DuckDB read pool: %d connections closed", closed)


# ── Backend ───────────────────────────────────────────────────────────────────

class DuckDBBackend(StorageBackend):

    def __init__(self):
        self._wconn: Optional[duckdb.DuckDBPyConnection] = None
        self._read_pool: Optional[_ReadPool] = None
        self._db_path: str = getattr(
            settings, "duckdb_path", "/opt/pktflow/flows.duckdb"
        )

    # ── Async dispatch helpers ─────────────────────────────────────────────────

    async def _write(self, fn):
        """Dispatch a write operation to the single write executor thread."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_WRITE_EXECUTOR, fn)

    async def _read(self, fn, timeout: float = READ_QUERY_TIMEOUT):
        """
        Dispatch a read operation to the read executor thread pool.

        asyncio.wait() is intentionally used instead of wait_for() so that
        expiry of the timeout does NOT attempt to cancel the running thread
        (which is not reliably possible for concurrent.futures tasks in
        Python 3.9).  The thread completes in the background; callers receive
        None and can return an empty result set gracefully.
        """
        loop = asyncio.get_event_loop()
        fut = loop.run_in_executor(_READ_EXECUTOR, fn)
        done, _ = await asyncio.wait({fut}, timeout=timeout)
        if fut in done:
            exc = fut.exception()
            if exc is not None:
                log.error("DuckDB read error: %s", exc, exc_info=exc)
                return None
            return fut.result()
        log.warning(
            "DuckDB read timed out after %.1fs — thread running to completion in background",
            timeout,
        )
        return None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """
        Open the write connection (+ apply schema) then warm up the read pool.
        Both happen on the write executor so DuckDB sees a consistent first-
        opener before the read pool connections are created.
        """
        def _open():
            # Write connection
            self._wconn = duckdb.connect(self._db_path)
            for stmt in _SCHEMA.strip().split(";"):
                s = stmt.strip()
                if s:
                    self._wconn.execute(s)

            # Read pool — open here so schema DDL is visible to pool conns
            self._read_pool = _ReadPool(
                self._db_path,
                size=READ_POOL_SIZE,
                acquire_timeout=READ_QUERY_TIMEOUT,
            )
            self._read_pool.open()

        await self._write(_open)
        log.info(
            "DuckDB ready — 1 write thread + %d-connection read pool at %s",
            READ_POOL_SIZE, self._db_path,
        )

    async def close(self) -> None:
        def _close():
            if self._read_pool:
                self._read_pool.close_all()
                self._read_pool = None
            if self._wconn:
                self._wconn.close()
                self._wconn = None

        await self._write(_close)
        # Shut down executors immediately — do NOT wait for threads.
        # Without this, Python's atexit waits forever for blocked DuckDB threads.
        _READ_EXECUTOR.shutdown(wait=False, cancel_futures=True)
        _WRITE_EXECUTOR.shutdown(wait=False, cancel_futures=True)
        log.info("DuckDB connections and executors closed")

    # ── Diagnostics ───────────────────────────────────────────────────────────

    def pool_stats(self) -> dict:
        if self._read_pool is None:
            return {"status": "not_connected"}
        return {
            "pool_size": self._read_pool.size,
            "available": self._read_pool.available,
            "in_use": self._read_pool.size - self._read_pool.available,
        }

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

        await self._write(_insert)

    # ── Dashboard — device summaries ──────────────────────────────────────────

    async def get_device_summaries(self) -> list[DeviceSummary]:
        def _query():
            cutoff_24h = datetime.now(tz=timezone.utc) - timedelta(hours=24)
            cutoff_1h  = datetime.now(tz=timezone.utc) - timedelta(hours=1)
            with self._read_pool.acquire() as conn:
                return conn.execute("""
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

        rows = await self._read(_query) or []
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
            with self._read_pool.acquire() as conn:
                return conn.execute(f"""
                    SELECT src_ip, dst_ip, dst_port, protocol,
                           SUM(bytes)   AS bytes,
                           SUM(packets) AS packets,
                           COUNT(*)     AS flow_count
                    FROM flows
                    WHERE timestamp BETWEEN ? AND ? {where_extra}
                    GROUP BY src_ip, dst_ip, dst_port, protocol
                    ORDER BY bytes DESC
                    LIMIT ?
                """, params).fetchall()

        rows = await self._read(_query) or []
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
            with self._read_pool.acquire() as conn:
                return conn.execute(f"""
                    SELECT
                        epoch_ms(
                            (epoch_ms(timestamp) / (? * 1000)) * (? * 1000)
                        )::TIMESTAMPTZ  AS ts,
                        SUM(bytes)      AS bytes,
                        SUM(packets)    AS packets,
                        COUNT(*)        AS flow_count
                    FROM flows
                    WHERE timestamp BETWEEN ? AND ? {where_extra}
                    GROUP BY ts
                    ORDER BY ts
                """, params).fetchall()

        rows = await self._read(_query) or []
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
        any_direction: bool = False,
    ) -> list[FlowSearchResult]:
        def _query():
            conditions: list[str] = []
            params: list = []
            if start:
                conditions.append("timestamp >= ?"); params.append(start)
            if end:
                conditions.append("timestamp <= ?"); params.append(end)
            if any_direction and src_ip and dst_ip:
                conditions.append("((src_ip = ? AND dst_ip = ?) OR (src_ip = ? AND dst_ip = ?))")
                params += [src_ip, dst_ip, dst_ip, src_ip]
            elif any_direction and (src_ip or dst_ip):
                ip = src_ip or dst_ip
                conditions.append("(src_ip = ? OR dst_ip = ?)"); params += [ip, ip]
            else:
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
            with self._read_pool.acquire() as conn:
                return conn.execute(f"""
                    SELECT timestamp, sampler_ip, sampler_name,
                           src_ip, dst_ip, src_port, dst_port, protocol,
                           bytes, packets, duration_ms, tcp_flags, tos,
                           input_if, output_if, next_hop, src_as, dst_as, flow_dir
                    FROM flows
                    {where}
                    ORDER BY timestamp DESC
                    LIMIT ? OFFSET ?
                """, params).fetchall()

        rows = await self._read(_query) or []
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

    async def count_flows(
        self,
        src_ip: Optional[str] = None,
        dst_ip: Optional[str] = None,
        src_port: Optional[int] = None,
        dst_port: Optional[int] = None,
        protocol: Optional[int] = None,
        sampler_ip: Optional[str] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        any_direction: bool = False,
    ) -> int:
        def _query():
            conditions: list[str] = []
            params: list = []
            if start:
                conditions.append("timestamp >= ?"); params.append(start)
            if end:
                conditions.append("timestamp <= ?"); params.append(end)
            if any_direction and src_ip and dst_ip:
                conditions.append("((src_ip = ? AND dst_ip = ?) OR (src_ip = ? AND dst_ip = ?))")
                params += [src_ip, dst_ip, dst_ip, src_ip]
            elif any_direction and (src_ip or dst_ip):
                ip = src_ip or dst_ip
                conditions.append("(src_ip = ? OR dst_ip = ?)"); params += [ip, ip]
            else:
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
            with self._read_pool.acquire() as conn:
                return conn.execute(f"SELECT COUNT(*) FROM flows {where}", params).fetchall()

        rows = await self._read(_query) or []
        return int(rows[0][0]) if rows else 0

    # ── Rates ─────────────────────────────────────────────────────────────────

    async def get_flows_per_sec(self) -> float:
        def _query():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=60)
            with self._read_pool.acquire() as conn:
                return conn.execute(
                    "SELECT COUNT(*) / 60.0 FROM flows WHERE timestamp >= ?", [cutoff]
                ).fetchall()

        rows = await self._read(_query)
        return float(rows[0][0]) if rows else 0.0

    async def get_sampler_last_seen(self) -> dict[str, datetime]:
        def _query():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(days=1)
            with self._read_pool.acquire() as conn:
                return conn.execute(
                    "SELECT sampler_ip, MAX(timestamp) FROM flows "
                    "WHERE timestamp >= ? GROUP BY sampler_ip",
                    [cutoff],
                ).fetchall()

        rows = await self._read(_query) or []
        return {r[0]: r[1] for r in rows}

    # ── Retention ─────────────────────────────────────────────────────────────

    async def update_retention_ttl(self, days: int) -> None:
        """Delete rows older than `days` days (DuckDB has no built-in TTL)."""
        def _delete():
            cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
            # COUNT(*) of deleted rows via a subquery — DuckDB does not support
            # RETURNING in DELETE; fetch the count before deleting instead.
            count = self._wconn.execute(
                "SELECT COUNT(*) FROM flows WHERE timestamp < ?", [cutoff]
            ).fetchone()[0]
            self._wconn.execute("DELETE FROM flows WHERE timestamp < ?", [cutoff])
            return count

        n = await self._write(_delete)
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

            with self._read_pool.acquire() as conn:
                edge_rows = conn.execute(f"""
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

                sampler_rows = conn.execute(f"""
                    SELECT sampler_ip,
                           ARG_MAX(sampler_name, timestamp) AS name,
                           ARG_MAX(site,         timestamp) AS site
                    FROM flows
                    WHERE {where}
                    GROUP BY sampler_ip
                """, params).fetchall()

                # Dominant exporter per pair — lets the hierarchy anchor a
                # conversation cluster under the vantage point that actually
                # observed it (see clickhouse.py's get_topology for the full
                # rationale — most conversations never touch the sampler's
                # own IP as a src/dst endpoint).
                sampler_attrib_rows = conn.execute(f"""
                    SELECT
                        CASE WHEN src_ip < dst_ip THEN src_ip ELSE dst_ip END AS ip_a,
                        CASE WHEN src_ip < dst_ip THEN dst_ip ELSE src_ip END AS ip_b,
                        sampler_ip,
                        SUM(bytes) AS attrib_bytes
                    FROM flows
                    WHERE {where}
                    GROUP BY ip_a, ip_b, sampler_ip
                """, params).fetchall()

            return edge_rows, sampler_rows, sampler_attrib_rows

        result = await self._read(_query)
        edge_rows, sampler_rows, sampler_attrib_raw = result if result else ([], [], [])

        sampler_map = {r[0]: {"name": r[1] or "", "site": r[2] or ""} for r in sampler_rows}
        sampler_attrib_rows = [(r[0], r[1], r[2], int(r[3])) for r in sampler_attrib_raw]

        edges: list[TopologyEdge] = []
        for r in edge_rows:
            src, dst = r[0], r[1]
            edges.append(TopologyEdge(
                source=src, target=dst,
                bytes=r[2], packets=r[3], flows=r[4],
                protocol=r[5] or 0, dst_port=r[6] or 0,
            ))

        edges = attach_dominant_sampler(edges, sampler_attrib_rows)

        node_bytes: dict[str, int] = {}
        node_flows: dict[str, int] = {}
        for e in edges:
            node_bytes[e.source] = node_bytes.get(e.source, 0) + e.bytes
            node_bytes[e.target] = node_bytes.get(e.target, 0) + e.bytes
            node_flows[e.source] = node_flows.get(e.source, 0) + e.flows
            node_flows[e.target] = node_flows.get(e.target, 0) + e.flows

        # Every known sampler gets a node even with zero direct edge-endpoint
        # bytes (see clickhouse.py's get_topology for why).
        all_ips = set(node_bytes.keys()) | set(sampler_map.keys())
        nodes: list[TopologyNode] = []
        for ip in all_ips:
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

    # ── Protocol distribution ──────────────────────────────────────────────────

    # Well-known port → service name (dst_port context), mirrors ClickHouseStorage._WELL_KNOWN
    _WELL_KNOWN: dict[tuple[int, int], str] = {
        (80, 6): "HTTP", (443, 6): "HTTPS", (22, 6): "SSH", (23, 6): "Telnet",
        (25, 6): "SMTP", (53, 17): "DNS", (53, 6): "DNS/TCP", (67, 17): "DHCP",
        (68, 17): "DHCP", (110, 6): "POP3", (143, 6): "IMAP", (161, 17): "SNMP",
        (162, 17): "SNMP Trap", (179, 6): "BGP", (389, 6): "LDAP",
        (443, 17): "QUIC", (445, 6): "SMB", (514, 17): "Syslog",
        (587, 6): "SMTP TLS", (636, 6): "LDAPS", (993, 6): "IMAPS",
        (995, 6): "POP3S", (1433, 6): "MSSQL", (1521, 6): "Oracle",
        (3306, 6): "MySQL", (3389, 6): "RDP", (5432, 6): "PostgreSQL",
        (5601, 6): "Kibana", (5672, 6): "AMQP", (6379, 6): "Redis",
        (8080, 6): "HTTP-Alt", (8443, 6): "HTTPS-Alt", (9000, 6): "ClickHouse",
        (9200, 6): "Elasticsearch", (9300, 6): "Elasticsearch", (27017, 6): "MongoDB",
        (2055, 17): "NetFlow", (4739, 17): "IPFIX",
    }

    _PROTO_NAMES: dict[int, str] = {
        1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 41: "IPv6",
        46: "RSVP", 47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6",
        88: "EIGRP", 89: "OSPF", 103: "PIM", 112: "VRRP", 115: "L2TP", 132: "SCTP",
    }

    async def get_top_ports(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
        site: Optional[str] = None,
        limit: int = 50,
    ) -> list:
        def _query():
            where_parts = ["timestamp BETWEEN ? AND ?"]
            params: list = [start, end]
            if sampler_ip:
                where_parts.append("sampler_ip = ?")
                params.append(sampler_ip)
            if site:
                where_parts.append("site = ?")
                params.append(site)
            where = " AND ".join(where_parts)
            with self._read_pool.acquire() as conn:
                return conn.execute(f"""
                    SELECT dst_port, protocol,
                           SUM(bytes)   AS total_bytes,
                           SUM(packets) AS total_packets,
                           COUNT(*)     AS flow_count
                    FROM flows
                    WHERE {where}
                    GROUP BY dst_port, protocol
                    ORDER BY total_bytes DESC
                    LIMIT ?
                """, params + [limit]).fetchall()

        rows = await self._read(_query) or []
        total_bytes = sum(r[2] for r in rows) or 1
        from app.models.flow import PortStat
        return [
            PortStat(
                port=r[0],
                protocol=r[1],
                proto_name=self._PROTO_NAMES.get(r[1], str(r[1])),
                service_name=self._WELL_KNOWN.get((r[0], r[1]), ""),
                bytes=r[2],
                packets=r[3],
                flow_count=r[4],
                pct_bytes=round(r[2] / total_bytes * 100, 2),
            )
            for r in rows
        ]

    async def get_protocol_distribution(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
    ) -> list:
        def _query():
            where_parts = ["timestamp BETWEEN ? AND ?"]
            params: list = [start, end]
            if sampler_ip:
                where_parts.append("sampler_ip = ?")
                params.append(sampler_ip)
            where = " AND ".join(where_parts)
            with self._read_pool.acquire() as conn:
                return conn.execute(f"""
                    SELECT protocol,
                           SUM(bytes)   AS total_bytes,
                           SUM(packets) AS total_packets,
                           COUNT(*)     AS flow_count
                    FROM flows
                    WHERE {where}
                    GROUP BY protocol
                    ORDER BY total_bytes DESC
                    LIMIT 20
                """, params).fetchall()

        rows = await self._read(_query) or []
        proto_names = {
            1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP",
            47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6",
            89: "OSPF", 132: "SCTP",
        }
        total_bytes = sum(r[1] for r in rows) or 1
        from app.models.flow import ProtocolStat
        return [
            ProtocolStat(
                protocol=r[0],
                name=proto_names.get(r[0], f"Proto {r[0]}"),
                bytes=r[1],
                packets=r[2],
                flow_count=r[3],
                pct_bytes=round(r[1] / total_bytes * 100, 1),
            )
            for r in rows
        ]

    async def purge_sampler(self, sampler_ip: str) -> None:
        def _delete():
            self._wconn.execute("DELETE FROM flows WHERE sampler_ip = ?", [sampler_ip])
        await self._write(_delete)
        log.info("DuckDB: purged all flows for sampler_ip=%s", sampler_ip)

    async def get_metric_in_window(self, metric: str, window_min: int, sampler_ip=None) -> float:
        raise NotImplementedError("get_metric_in_window not implemented for DuckDB")

    async def get_metric_baseline(self, metric: str, baseline_days: int, window_min: int, sampler_ip=None) -> float:
        raise NotImplementedError("get_metric_baseline not implemented for DuckDB")

    async def get_port_flow_count(self, port: int, protocol, direction: str, window_min: int, sampler_ip=None) -> int:
        raise NotImplementedError("get_port_flow_count not implemented for DuckDB")

    async def get_top_talker_in_window(self, metric, window_min, sampler_ip=None) -> tuple[str, float]:
        raise NotImplementedError("get_top_talker_in_window not implemented for DuckDB")

    async def get_elephant_flow_stats(self, threshold_bytes, window_min, sampler_ip=None) -> tuple[int, float]:
        raise NotImplementedError("get_elephant_flow_stats not implemented for DuckDB")

    async def get_inter_site_metric(self, metric, window_min, site_a=None, site_b=None) -> float:
        raise NotImplementedError("get_inter_site_metric not implemented for DuckDB")

    async def get_top_connection_count(self, window_min, sampler_ip=None) -> tuple[str, int]:
        raise NotImplementedError("get_top_connection_count not implemented for DuckDB")

    async def get_top_unique_dst_ports(self, window_min, sampler_ip=None) -> tuple[str, int]:
        raise NotImplementedError("get_top_unique_dst_ports not implemented for DuckDB")

    async def get_top_unique_dst_ips(self, window_min, sampler_ip=None, src_subnet=None) -> tuple[str, int]:
        raise NotImplementedError("get_top_unique_dst_ips not implemented for DuckDB")

    async def get_unexpected_proto_count(self, port, expected_proto, direction, window_min, sampler_ip=None) -> int:
        raise NotImplementedError("get_unexpected_proto_count not implemented for DuckDB")

    async def get_inter_site_top_contributors(self, metric, window_min, site_a=None, site_b=None, limit=5) -> list:
        raise NotImplementedError("get_inter_site_top_contributors not implemented for DuckDB")

    async def get_elephant_flow_top(self, threshold_bytes, window_min, sampler_ip=None, limit=5) -> list:
        raise NotImplementedError("get_elephant_flow_top not implemented for DuckDB")

    async def get_threshold_top_ips(self, metric, window_min, sampler_ip=None, limit=5) -> list:
        raise NotImplementedError("get_threshold_top_ips not implemented for DuckDB")

    async def get_port_flow_top_ips(self, port, protocol, direction, window_min, sampler_ip=None, limit=5) -> list:
        raise NotImplementedError("get_port_flow_top_ips not implemented for DuckDB")

    async def get_unexpected_proto_top_ips(self, port, expected_proto, direction, window_min, sampler_ip=None, limit=5) -> list:
        raise NotImplementedError("get_unexpected_proto_top_ips not implemented for DuckDB")

    async def get_top_dsts_for_ip(self, src_ip, window_min, sampler_ip=None, limit=5) -> list:
        raise NotImplementedError("get_top_dsts_for_ip not implemented for DuckDB")

    async def get_top_ports_for_ip(self, src_ip, window_min, sampler_ip=None, limit=10) -> list:
        raise NotImplementedError("get_top_ports_for_ip not implemented for DuckDB")

    async def get_response_rate_for_ip(self, src_ip: str, window_min: int) -> tuple:
        raise NotImplementedError("get_response_rate_for_ip not implemented for DuckDB")

    async def get_asymmetric_flows(self, window_min, min_bytes=1_000_000, ratio_threshold=10.0, sampler_ip=None, limit=20) -> list:
        raise NotImplementedError("get_asymmetric_flows not implemented for DuckDB")
