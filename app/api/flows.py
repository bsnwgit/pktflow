"""
GET /api/flows/* — flow data query endpoints.
All endpoints require authentication (any role).
"""
from __future__ import annotations

import csv
import io
import json
import socket
import struct
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.dependencies import CurrentUser
from app.models.flow import TopTalker, TimeSeriesPoint, DeviceSummary, FlowSearchResult, TopologyNode, TopologyEdge, ProtocolStat
from app.storage.factory import get_storage

router = APIRouter()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _parse_window(window: str) -> tuple[datetime, datetime]:
    """Convert shorthand window string to (start, end) datetimes."""
    end = _now()
    windows = {
        "1h": timedelta(hours=1),
        "6h": timedelta(hours=6),
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }
    delta = windows.get(window, timedelta(hours=1))
    return end - delta, end


def _bucket_for_window(window: str) -> int:
    """Appropriate time-series bucket size (seconds) for the given window."""
    return {
        "1h": 60,
        "6h": 300,
        "24h": 900,
        "7d": 3600,
        "30d": 86400,
    }.get(window, 60)


# ── Dashboard ─────────────────────────────────────────────────────────────────

@router.get("/devices", response_model=list[DeviceSummary])
async def list_device_summaries(_: CurrentUser):
    """All-devices summary for Dashboard cards."""
    return await get_storage().get_device_summaries()


@router.get("/rate")
async def current_flow_rate(_: CurrentUser):
    """Current flows/sec (last 60 seconds) — for the live header counter."""
    fps = await get_storage().get_flows_per_sec()
    return {"flows_per_sec": fps}


# ── Device view ───────────────────────────────────────────────────────────────

@router.get("/timeseries", response_model=list[TimeSeriesPoint])
async def flow_time_series(
    _: CurrentUser,
    sampler_ip: Optional[str] = Query(None, description="Filter to a single sampler"),
    window: str = Query("1h", description="Time window: 1h, 6h, 24h, 7d, 30d"),
    start: Optional[datetime] = Query(None, description="Custom start (ISO 8601, overrides window)"),
    end: Optional[datetime] = Query(None, description="Custom end (ISO 8601, overrides window)"),
):
    """Traffic volume time-series for charting."""
    if start and end:
        s, e = start, end
        bucket = 60
    else:
        s, e = _parse_window(window)
        bucket = _bucket_for_window(window)

    return await get_storage().get_time_series(sampler_ip, s, e, bucket)


@router.get("/top-talkers", response_model=list[TopTalker])
async def top_talkers(
    _: CurrentUser,
    sampler_ip: Optional[str] = Query(None),
    window: str = Query("1h"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    """Top src/dst IP pairs ranked by byte volume."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)

    return await get_storage().get_top_talkers(sampler_ip, s, e, limit)


# ── Flow Explorer ─────────────────────────────────────────────────────────────

@router.get("/search", response_model=list[FlowSearchResult])
async def search_flows(
    _: CurrentUser,
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    src_port: Optional[int] = Query(None, ge=0, le=65535),
    dst_port: Optional[int] = Query(None, ge=0, le=65535),
    protocol: Optional[int] = Query(None, ge=0, le=255),
    sampler_ip: Optional[str] = Query(None),
    window: str = Query("1h"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    """Filtered flow search for the Flow Explorer page."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)

    return await get_storage().search_flows(
        src_ip=src_ip,
        dst_ip=dst_ip,
        src_port=src_port,
        dst_port=dst_port,
        protocol=protocol,
        sampler_ip=sampler_ip,
        start=s,
        end=e,
        limit=limit,
        offset=offset,
    )


# ── Sampler last-seen (for data-gap alerting and UI status dots) ───────────────

@router.get("/last-seen")
async def sampler_last_seen(_: CurrentUser):
    """Dict of sampler_ip → last flow timestamp."""
    data = await get_storage().get_sampler_last_seen()
    return {ip: ts.isoformat() for ip, ts in data.items()}


# ── Protocol distribution ─────────────────────────────────────────────────────

@router.get("/protocols", response_model=list[ProtocolStat])
async def protocol_distribution(
    _: CurrentUser,
    window: str = Query("1h"),
    sampler_ip: Optional[str] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
):
    """Protocol breakdown by byte volume — for pie/bar charts."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)
    return await get_storage().get_protocol_distribution(s, e, sampler_ip)


# ── Topology ──────────────────────────────────────────────────────────────────

from pydantic import BaseModel as _BaseModel

class TopologyResponse(_BaseModel):
    nodes: list[TopologyNode]
    edges: list[TopologyEdge]


@router.get("/topology", response_model=TopologyResponse)
async def get_topology(
    _: CurrentUser,
    window: str = Query("1h"),
    sampler_ip: Optional[str] = Query(None),
    min_bytes: int = Query(0, ge=0, description="Only include edges with at least this many bytes"),
    limit: int = Query(200, ge=1, le=1000, description="Max number of edges"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
):
    """
    Return network topology as nodes + edges for D3 force graph.
    Edges are aggregated IP pairs (src → dst) sorted by byte volume.
    """
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)

    nodes, edges = await get_storage().get_topology(
        start=s, end=e,
        sampler_ip=sampler_ip,
        min_bytes=min_bytes,
        limit=limit,
    )
    return TopologyResponse(nodes=nodes, edges=edges)


# ── Export endpoints ──────────────────────────────────────────────────────────

async def _fetch_for_export(
    src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end
) -> list[FlowSearchResult]:
    """Shared query for all export formats. Cap at 10k rows."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)
    return await get_storage().search_flows(
        src_ip=src_ip, dst_ip=dst_ip,
        src_port=src_port, dst_port=dst_port,
        protocol=protocol, sampler_ip=sampler_ip,
        start=s, end=e,
        limit=10000, offset=0,
    )


@router.get("/export/csv")
async def export_csv(
    _: CurrentUser,
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    src_port: Optional[int] = Query(None, ge=0, le=65535),
    dst_port: Optional[int] = Query(None, ge=0, le=65535),
    protocol: Optional[int] = Query(None, ge=0, le=255),
    sampler_ip: Optional[str] = Query(None),
    window: str = Query("1h"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
):
    """Export filtered flows as CSV."""
    flows = await _fetch_for_export(src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "timestamp", "sampler_ip", "sampler_name",
        "src_ip", "src_port", "dst_ip", "dst_port",
        "protocol", "bytes", "packets", "duration_ms",
    ])
    for f in flows:
        writer.writerow([
            f.timestamp.isoformat(), f.sampler_ip, f.sampler_name,
            f.src_ip, f.src_port, f.dst_ip, f.dst_port,
            f.protocol, f.bytes, f.packets, f.duration_ms,
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=pktflow-flows.csv"},
    )


@router.get("/export/json")
async def export_json(
    _: CurrentUser,
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    src_port: Optional[int] = Query(None, ge=0, le=65535),
    dst_port: Optional[int] = Query(None, ge=0, le=65535),
    protocol: Optional[int] = Query(None, ge=0, le=255),
    sampler_ip: Optional[str] = Query(None),
    window: str = Query("1h"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
):
    """Export filtered flows as JSON array."""
    flows = await _fetch_for_export(src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end)

    data = [
        {
            "timestamp": f.timestamp.isoformat(),
            "sampler_ip": f.sampler_ip,
            "sampler_name": f.sampler_name,
            "src_ip": f.src_ip,
            "src_port": f.src_port,
            "dst_ip": f.dst_ip,
            "dst_port": f.dst_port,
            "protocol": f.protocol,
            "bytes": f.bytes,
            "packets": f.packets,
            "duration_ms": f.duration_ms,
        }
        for f in flows
    ]
    content = json.dumps(data, indent=2)
    return StreamingResponse(
        iter([content]),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=pktflow-flows.json"},
    )


# ── Synthetic PCAP helpers ────────────────────────────────────────────────────

def _ip_to_bytes(ip: str) -> bytes:
    try:
        return socket.inet_aton(ip)
    except Exception:
        return b"\x00\x00\x00\x00"


def _ip_checksum(header: bytes) -> int:
    """Standard one's-complement IP header checksum."""
    if len(header) % 2:
        header += b"\x00"
    s = 0
    for i in range(0, len(header), 2):
        s += (header[i] << 8) + header[i + 1]
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return ~s & 0xFFFF


def _build_pcap_record(flow: FlowSearchResult) -> bytes:
    """
    Build a single libpcap record for a flow.
    Packet = Ethernet (14B) + IP (20B) + TCP/UDP header (20B/8B).
    No payload — this is a synthetic record representing NetFlow metadata.
    Protocol 6 = TCP, 17 = UDP, everything else = raw IP with 0 payload.
    """
    src = _ip_to_bytes(flow.src_ip)
    dst = _ip_to_bytes(flow.dst_ip)

    # Layer 4
    if flow.protocol == 6:          # TCP — 20 byte header
        l4 = struct.pack(
            "!HHIIHHHH",
            flow.src_port & 0xFFFF,  # sport
            flow.dst_port & 0xFFFF,  # dport
            0,                       # seq
            0,                       # ack
            0x5002,                  # data offset 5, SYN flag
            65535,                   # window
            0,                       # checksum (0 = not computed)
            0,                       # urgent
        )
    elif flow.protocol == 17:       # UDP — 8 byte header
        udp_len = 8
        l4 = struct.pack(
            "!HHHH",
            flow.src_port & 0xFFFF,
            flow.dst_port & 0xFFFF,
            udp_len,
            0,                       # checksum
        )
    else:
        l4 = b""

    total_len = 20 + len(l4)

    # IP header (no options, TTL=64)
    ip_header_no_checksum = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,                        # version=4, IHL=5
        0,                           # TOS
        total_len,
        0,                           # identification
        0,                           # flags + fragment offset
        64,                          # TTL
        flow.protocol,
        0,                           # checksum placeholder
        src,
        dst,
    )
    # Re-pack with real checksum
    chk = _ip_checksum(ip_header_no_checksum)
    ip_header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,                           # TOS
        total_len,
        0,
        0,
        64,
        flow.protocol,
        chk,
        src,
        dst,
    )

    # Ethernet frame (fake MACs, EtherType 0x0800 = IPv4)
    eth = b"\x00" * 6 + b"\x00" * 6 + b"\x08\x00"

    packet = eth + ip_header + l4

    # libpcap record header
    ts_sec  = int(flow.timestamp.timestamp())
    ts_usec = flow.timestamp.microsecond
    pkt_len = len(packet)
    rec_hdr = struct.pack("!IIII", ts_sec, ts_usec, pkt_len, pkt_len)

    return rec_hdr + packet


@router.get("/export/pcap")
async def export_pcap(
    _: CurrentUser,
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    src_port: Optional[int] = Query(None, ge=0, le=65535),
    dst_port: Optional[int] = Query(None, ge=0, le=65535),
    protocol: Optional[int] = Query(None, ge=0, le=255),
    sampler_ip: Optional[str] = Query(None),
    window: str = Query("1h"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
):
    """
    Export filtered flows as a synthetic PCAP file.
    Each flow becomes one reconstructed packet (Ethernet + IP + L4 headers only).
    No application payload — NetFlow does not carry payload data.
    Compatible with Wireshark, tcpdump, and other PCAP tools.
    """
    flows = await _fetch_for_export(src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end)

    # Global pcap header: magic, version 2.4, GMT offset 0, accuracy 0, snaplen 65535, Ethernet link type
    global_hdr = struct.pack("!IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)

    def _generate():
        yield global_hdr
        for flow in flows:
            yield _build_pcap_record(flow)

    return StreamingResponse(
        _generate(),
        media_type="application/vnd.tcpdump.pcap",
        headers={"Content-Disposition": "attachment; filename=pktflow-flows.pcap"},
    )
