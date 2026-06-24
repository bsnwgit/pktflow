"""
Abstract storage backend interface.
Both ClickHouse and DuckDB backends implement this.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from app.models.flow import FlowRecord, TopTalker, TimeSeriesPoint, DeviceSummary, FlowSearchResult, TopologyNode, TopologyEdge, PortStat


class StorageBackend(ABC):

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection and ensure schema exists."""

    @abstractmethod
    async def close(self) -> None:
        """Clean shutdown."""

    @abstractmethod
    async def insert_flows(self, flows: list[FlowRecord]) -> None:
        """Bulk insert a batch of flow records."""

    @abstractmethod
    async def get_device_summaries(self) -> list[DeviceSummary]:
        """Current status for all known samplers (Dashboard cards)."""

    @abstractmethod
    async def get_top_talkers(
        self,
        sampler_ip: Optional[str],
        start: datetime,
        end: datetime,
        limit: int = 50,
    ) -> list[TopTalker]:
        """Top src/dst pairs by byte volume in the given window."""

    @abstractmethod
    async def get_time_series(
        self,
        sampler_ip: Optional[str],
        start: datetime,
        end: datetime,
        bucket_seconds: int = 60,
        dst_port: Optional[int] = None,
        protocol: Optional[int] = None,
        site: Optional[str] = None,
    ) -> list[TimeSeriesPoint]:
        """Traffic volume bucketed by time for charting."""

    @abstractmethod
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
        """Filtered flow search for the Flow Explorer."""

    @abstractmethod
    async def get_flows_per_sec(self) -> float:
        """Current sustained ingest rate (last 60 seconds)."""

    @abstractmethod
    async def get_sampler_last_seen(self) -> dict[str, datetime]:
        """Dict of sampler_ip → latest timestamp (for data-gap alerting)."""

    @abstractmethod
    async def update_retention_ttl(self, days: int) -> None:
        """Adjust the TTL on the raw flows table."""

    @abstractmethod
    async def get_topology(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
        min_bytes: int = 0,
        limit: int = 200,
    ) -> tuple[list[TopologyNode], list[TopologyEdge]]:
        """Return (nodes, edges) for the network topology graph."""

    @abstractmethod
    async def purge_sampler(self, sampler_ip: str) -> None:
        """Delete all flow records for a given sampler IP (used to clean stale dashboard cards)."""

    @abstractmethod
    async def get_top_ports(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
        site: Optional[str] = None,
        limit: int = 50,
    ) -> list[PortStat]:
        """Top destination ports ranked by byte volume."""

    @abstractmethod
    async def get_metric_in_window(
        self,
        metric: str,
        window_min: int,
        sampler_ip: Optional[str] = None,
    ) -> float:
        """Sum of metric ('bytes', 'packets', or 'flows') over the last window_min minutes."""

    @abstractmethod
    async def get_metric_baseline(
        self,
        metric: str,
        baseline_days: int,
        window_min: int,
        sampler_ip: Optional[str] = None,
    ) -> float:
        """Average per-window-min value of metric over the last baseline_days days."""

    @abstractmethod
    async def get_port_flow_count(
        self,
        port: int,
        protocol: Optional[int],
        direction: str,
        window_min: int,
        sampler_ip: Optional[str] = None,
    ) -> int:
        """Count of flows matching port/protocol/direction in the last window_min minutes.
        direction: 'src', 'dst', or 'any'."""

    async def get_daily_timeseries(
        self,
        days: int = 30,
        sampler_ip: Optional[str] = None,
    ) -> list[TimeSeriesPoint]:
        """Daily rollup: bytes/packets/flows per day from flows_daily.
        Default implementation returns empty list (ClickHouse-only feature)."""
        return []

    async def get_hourly_timeseries(
        self,
        start: datetime,
        end: datetime,
        sampler_ip: Optional[str] = None,
    ) -> list[TimeSeriesPoint]:
        """Hourly rollup: bytes/packets/flows per hour from flows_hourly.
        Default implementation returns empty list (ClickHouse-only feature)."""
        return []
