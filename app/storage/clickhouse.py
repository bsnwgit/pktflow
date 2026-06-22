"""
ClickHouse storage backend.
Uses clickhouse-driver (sync) wrapped in asyncio.to_thread for non-blocking operation.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from clickhouse_driver import Client

from app.config import get_settings
from app.models.flow import FlowRecord, TopTalker, TimeSeriesPoint, DeviceSummary, FlowSearchResult, TopologyNode, TopologyEdge
from app.storage.base import StorageBackend

log = logging.getLogger("pktflow.storage.clickhouse")
settings = get_settings()

# Column order must match FlowRecord.to_clickhouse_row() and schema.sql
_INSERT_COLS = """
    timestamp, sampler_ip, sampler_name, site,
    src_ip, dst_ip, src_port, dst_port, protocol,
    bytes, packets, duration_ms, tcp_flags, tos,
    input_if, output_if, next_hop, src_as, dst_as, flow_dir
"""


class ClickHouseBackend(StorageBackend):

    def __init__(self):
        self._client: Optional[Client] = None

    def _get_client(self) -> Client:
        if self._client is None:
            self._client = Client(
                host=settings.clickhouse_host,
                port=settings.clickhouse_port,
                database=settings.clickhouse_database,
                user=settings.clickhouse_user,
                password=settings.clickhouse_password,
                connect_timeout=10,
                settings={"use_numpy": False},
            )
        return self._client

    def _execute(self, query: str, params=None, data=None):
        """Sync ClickHouse execute — call via asyncio.to_thread."""
        client = self._get_client()
        if data is not None:
            return client.execute(query, data)
        return client.execute(query, params or {})

    async def connect(self) -> None:
        await asyncio.to_thread(self._ensure_schema)
        log.info(f"ClickHouse connected: {settings.clickhouse_host}:{settings.clickhouse_port}/{settings.clickhouse_database}")

    def _ensure_schema(self):
        from pathlib import Path
        schema_path = Path(__file__).parent.parent.parent / "clickhouse" / "schema.sql"
        if not schema_path.exists():
            log.warning("schema.sql not found — skipping schema init")
            return
        client = self._get_client()
        # Create database if needed
        client.execute(f"CREATE DATABASE IF NOT EXISTS {settings.clickhouse_database}")
        # Execute schema statements one at a time (skip comments and empty lines)
        sql = schema_path.read_text()
        statements = [s.strip() for s in sql.split(";") if s.strip() and not s.strip().startswith("--")]
        for stmt in statements:
            try:
                client.execute(stmt)
            except Exception as e:
                # Ignore "already exists" errors
                if "already exists" not in str(e).lower():
                    log.warning(f"Schema statement warning: {e}")

    async def close(self) -> None:
        if self._client:
            self._client.disconnect()
            self._client = None

    async def insert_flows(self, flows: list[FlowRecord]) -> None:
        if not flows:
            return
        rows = [f.to_clickhouse_row() for f in flows]
        query = f"INSERT INTO {settings.clickhouse_database}.flows ({_INSERT_COLS}) VALUES"
        await asyncio.to_thread(self._execute, query, data=rows)

    async def get_device_summaries(self) -> list[DeviceSummary]:
        query = f"""
            SELECT
                sampler_ip,
                any(sampler_name)                          AS sampler_name,
                any(site)                                  AS site,
                sumIf(bytes,   timestamp >= now() - INTERVAL 1 HOUR) AS bytes_last_hour,
                sumIf(packets, timestamp >= now() - INTERVAL 1 HOUR) AS packets_last_hour,
                countIf(       timestamp >= now() - INTERVAL 1 HOUR) AS flows_last_hour,
                max(timestamp)                             AS last_seen
            FROM {settings.clickhouse_database}.flows
            WHERE timestamp >= now() - INTERVAL 24 HOUR
            GROUP BY sampler_ip
            ORDER BY sampler_name
        """
        rows = await asyncio.to_thread(self._execute, query)
        result = []
        for row in rows:
            result.append(DeviceSummary(
                sampler_ip=str(row[0]),
                sampler_name=row[1],
                site=row[2],
                bytes_last_hour=row[3],
                packets_last_hour=row[4],
                flows_last_hour=row[5],
                flows_per_sec=round(row[5] / 3600, 2),
                last_seen=row[6],
            ))
        return result

    async def get_top_talkers(
        self,
        sampler_ip: Optional[str],
        start: datetime,
        end: datetime,
        limit: int = 50,
    ) -> list[TopTalker]:
        where = "timestamp BETWEEN %(start)s AND %(end)s"
        params: dict = {"start": start, "end": end, "limit": limit}
        if sampler_ip:
            where += " AND sampler_ip = %(sampler_ip)s"
            params["sampler_ip"] = sampler_ip

        query = f"""
            SELECT src_ip, dst_ip, dst_port, protocol,
                   sum(bytes) AS bytes, sum(packets) AS packets, count() AS flow_count
            FROM {settings.clickhouse_database}.flows
            WHERE {where}
            GROUP BY src_ip, dst_ip, dst_port, protocol
            ORDER BY bytes DESC
            LIMIT %(limit)s
        """
        rows = await asyncio.to_thread(self._execute, query, params)
        return [
            TopTalker(
                src_ip=str(r[0]), dst_ip=str(r[1]),
                dst_port=r[2], protocol=r[3],
                bytes=r[4], packets=r[5], flow_count=r[6],
            )
            for r in rows
        ]

    async def get_time_series(
        self,
        sampler_ip: Optional[str],
        start: datetime,
        end: datetime,
        bucket_seconds: int = 60,
    ) -> list[TimeSeriesPoint]:
        where = "timestamp BETWEEN %(start)s AND %(end)s"
        params: dict = {"start": start, "end": end, "bucket": bucket_seconds}
        if sampler_ip:
            where += " AND sampler_ip = %(sampler_ip)s"
            params["sampler_ip"] = sampler_ip

        query = f"""
            SELECT
                toStartOfInterval(timestamp, INTERVAL %(bucket)s SECOND) AS ts,
                sum(bytes)   AS bytes,
                sum(packets) AS packets,
                count()      AS flow_count
            FROM {settings.clickhouse_database}.flows
            WHERE {where}
            GROUP BY ts
            ORDER BY ts
        """
        rows = await asyncio.to_thread(self._execute, query, params)
        return [TimeSeriesPoint(timestamp=r[0], bytes=r[1], packets=r[2], flow_count=r[3]) for r in rows]

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
        conditions = []
        params: dict = {"limit": limit, "offset": offset}

        if start:
            conditions.append("timestamp >= %(start)s"); params["start"] = start
        if end:
            conditions.append("timestamp <= %(end)s"); params["end"] = end
        if src_ip:
            conditions.append("src_ip = %(src_ip)s"); params["src_ip"] = src_ip
        if dst_ip:
            conditions.append("dst_ip = %(dst_ip)s"); params["dst_ip"] = dst_ip
        if src_port is not None:
            conditions.append("src_port = %(src_port)s"); params["src_port"] = src_port
        if dst_port is not None:
            conditions.append("dst_port = %(dst_port)s"); params["dst_port"] = dst_port
        if protocol is not None:
            conditions.append("protocol = %(protocol)s"); params["protocol"] = protocol
        if sampler_ip:
            conditions.append("sampler_ip = %(sampler_ip)s"); params["sampler_ip"] = sampler_ip

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        query = f"""
            SELECT timestamp, sampler_ip, sampler_name, src_ip, dst_ip,
                   src_port, dst_port, protocol, bytes, packets, duration_ms,
                   tcp_flags, tos, input_if, output_if, next_hop, src_as, dst_as, flow_dir
            FROM {settings.clickhouse_database}.flows
            {where}
            ORDER BY timestamp DESC
            LIMIT %(limit)s OFFSET %(offset)s
        """
        rows = await asyncio.to_thread(self._execute, query, params)
        return [
            FlowSearchResult(
                timestamp=r[0], sampler_ip=str(r[1]), sampler_name=r[2],
                src_ip=str(r[3]), dst_ip=str(r[4]),
                src_port=r[5], dst_port=r[6], protocol=r[7],
                bytes=r[8], packets=r[9], duration_ms=r[10],
                tcp_flags=r[11], tos=r[12],
                input_if=r[13], output_if=r[14],
                next_hop=str(r[15]), src_as=r[16], dst_as=r[17], flow_dir=r[18],
            )
            for r in rows
        ]

    async def get_flows_per_sec(self) -> float:
        query = f"""
            SELECT count() / 60.0
            FROM {settings.clickhouse_database}.flows
            WHERE timestamp >= now() - INTERVAL 60 SECOND
        """
        rows = await asyncio.to_thread(self._execute, query)
        return float(rows[0][0]) if rows else 0.0

    async def get_sampler_last_seen(self) -> dict[str, datetime]:
        query = f"""
            SELECT sampler_ip, max(timestamp)
            FROM {settings.clickhouse_database}.flows
            WHERE timestamp >= now() - INTERVAL 1 DAY
            GROUP BY sampler_ip
        """
        rows = await asyncio.to_thread(self._execute, query)
        return {str(r[0]): r[1] for r in rows}

    async def get_topology(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
        min_bytes: int = 0,
        limit: int = 200,
    ) -> tuple[list[TopologyNode], list[TopologyEdge]]:
        where_parts = ["timestamp BETWEEN %(start)s AND %(end)s"]
        params: dict = {"start": start, "end": end, "limit": limit, "min_bytes": min_bytes}
        if sampler_ip:
            where_parts.append("sampler_ip = %(sampler_ip)s")
            params["sampler_ip"] = sampler_ip
        where = " AND ".join(where_parts)

        # Edges: top IP pairs by bytes
        edge_query = f"""
            SELECT src_ip, dst_ip, sum(bytes) AS bytes, sum(packets) AS packets,
                   count() AS flows, any(protocol) AS protocol, any(dst_port) AS dst_port
            FROM {settings.clickhouse_database}.flows
            WHERE {where}
            GROUP BY src_ip, dst_ip
            HAVING bytes >= %(min_bytes)s
            ORDER BY bytes DESC
            LIMIT %(limit)s
        """
        edge_rows = await asyncio.to_thread(self._execute, edge_query, params)

        # Sampler info for node enrichment
        sampler_query = f"""
            SELECT sampler_ip, any(sampler_name) AS name, any(site) AS site
            FROM {settings.clickhouse_database}.flows
            WHERE {where}
            GROUP BY sampler_ip
        """
        sampler_rows = await asyncio.to_thread(self._execute, sampler_query, params)
        sampler_map = {str(r[0]): {"name": r[1], "site": r[2]} for r in sampler_rows}

        # Build edges
        edges: list[TopologyEdge] = []
        node_bytes: dict[str, int] = {}
        node_flows: dict[str, int] = {}
        for r in edge_rows:
            src, dst = str(r[0]), str(r[1])
            edges.append(TopologyEdge(
                source=src, target=dst,
                bytes=r[2], packets=r[3], flows=r[4],
                protocol=r[5], dst_port=r[6],
            ))
            node_bytes[src] = node_bytes.get(src, 0) + r[2]
            node_bytes[dst] = node_bytes.get(dst, 0) + r[2]
            node_flows[src] = node_flows.get(src, 0) + r[4]
            node_flows[dst] = node_flows.get(dst, 0) + r[4]

        # Build nodes from IPs seen in edges
        all_ips = set(node_bytes.keys())
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

    async def update_retention_ttl(self, days: int) -> None:
        query = f"""
            ALTER TABLE {settings.clickhouse_database}.flows
            MODIFY TTL toDateTime(timestamp) + INTERVAL {days} DAY
        """
        await asyncio.to_thread(self._execute, query)
        log.info(f"Updated flow retention TTL to {days} days")
