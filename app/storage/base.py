"""
Abstract storage backend interface.
Both ClickHouse and DuckDB backends implement this.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from app.models.flow import FlowRecord, TopTalker, TimeSeriesPoint, DeviceSummary, FlowSearchResult, TopologyNode, TopologyEdge


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
