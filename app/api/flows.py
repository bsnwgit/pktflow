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
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import StreamingResponse

from app.dependencies import CurrentUser, AdminUser
from app.models.flow import TopTalker, TimeSeriesPoint, DeviceSummary, FlowSearchResult, TopologyNode, TopologyEdge, ProtocolStat, PortStat
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


@router.delete("/samplers/{sampler_ip}", status_code=204)
async def purge_sampler(_: AdminUser, sampler_ip: str):
    """Delete all flow records for a sampler IP (admin only). Used to remove stale dashboard cards."""
    await get_storage().purge_sampler(sampler_ip)
    return None


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
    site: Optional[str] = Query(None, description="Filter to a site (site-a, site-b, etc.)"),
    dst_port: Optional[int] = Query(None, ge=0, le=65535, description="Filter to a destination port"),
    protocol: Optional[int] = Query(None, ge=0, le=255, description="Filter to IP protocol number"),
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

    return await get_storage().get_time_series(
        sampler_ip, s, e, bucket,
        dst_port=dst_port, protocol=protocol, site=site,
    )


@router.get("/timeseries/daily", response_model=list[TimeSeriesPoint])
async def daily_time_series(
    _: CurrentUser,
    days: int = Query(30, ge=1, le=365, description="Number of days to include (default 30)"),
    sampler_ip: Optional[str] = Query(None, description="Filter to a single sampler"),
):
    """Daily traffic totals from the flows_daily rollup table. Efficient for 30-365 day views."""
    return await get_storage().get_daily_timeseries(days=days, sampler_ip=sampler_ip)


@router.get("/timeseries/hourly", response_model=list[TimeSeriesPoint])
async def hourly_time_series(
    _: CurrentUser,
    window: str = Query("7d", description="Time window: 1h, 6h, 24h, 7d, 30d"),
    sampler_ip: Optional[str] = Query(None, description="Filter to a single sampler"),
):
    """Hourly traffic totals from the flows_hourly rollup table. Efficient for 7-30 day views."""
    s, e = _parse_window(window)
    return await get_storage().get_hourly_timeseries(start=s, end=e, sampler_ip=sampler_ip)


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


# ── Port analytics ───────────────────────────────────────────────────────────

@router.get("/ports/top", response_model=list[PortStat])
async def top_ports(
    _: CurrentUser,
    window: str = Query("1h"),
    sampler_ip: Optional[str] = Query(None),
    site: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
):
    """Top destination ports by byte volume — for port analytics page."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)
    return await get_storage().get_top_ports(s, e, sampler_ip=sampler_ip, site=site, limit=limit)


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


# ── Lucidchart diagram export ─────────────────────────────────────────────────

def _fmt_bytes_lucid(b: int) -> str:
    if b >= 1_000_000_000: return f"{b/1e9:.1f}GB"
    if b >= 1_000_000:     return f"{b/1e6:.1f}MB"
    if b >= 1_000:         return f"{b/1e3:.1f}KB"
    return f"{b}B"

SITE_COLORS_LUCID = ["#3b82f6","#8b5cf6","#10b981","#f59e0b","#ef4444","#06b6d4"]
PROTO_NAMES_LUCID = {1:"ICMP",6:"TCP",17:"UDP",47:"GRE",50:"ESP"}

def _build_lucid_standard_import(nodes, edges, title: str) -> dict:
    """Convert topology nodes/edges to Lucidchart Standard Import JSON."""
    sites = list(dict.fromkeys(n.site or "unknown" for n in nodes))
    site_color = lambda s: SITE_COLORS_LUCID[sites.index(s) % len(SITE_COLORS_LUCID)]

    max_bytes = max((n.bytes for n in nodes), default=1)
    max_edge_bytes = max((e.bytes for e in edges), default=1)

    cols = max(1, int(len(nodes) ** 0.5) + 1)
    SPACING = 160
    MIN_SZ, MAX_SZ = 50, 100

    shapes = []
    node_shape_id: dict[str, str] = {}

    for i, node in enumerate(nodes):
        sid = f"n{i}"
        node_shape_id[node.id] = sid
        col, row = i % cols, i // cols
        ratio = (node.bytes / max_bytes) ** 0.5
        sz = int(MIN_SZ + ratio * (MAX_SZ - MIN_SZ))
        color = site_color(node.site or "unknown")
        label = (node.sampler_name or node.id)[:30]
        shapes.append({
            "id": sid,
            "type": "circle",
            "boundingBox": {"x": col * SPACING, "y": row * SPACING, "w": sz, "h": sz},
            "text": label,
            "style": {
                "fill": {"type": "color", "color": color},
                "stroke": {"color": "#ffffff" if node.is_sampler else "#00000033", "width": 2 if node.is_sampler else 1, "style": "solid"},
                "textColor": "#ffffff",
            },
        })

    lines = []
    for i, edge in enumerate(edges):
        src = node_shape_id.get(edge.source)
        dst = node_shape_id.get(edge.target)
        if not src or not dst:
            continue
        proto = PROTO_NAMES_LUCID.get(edge.protocol, f"P{edge.protocol}")
        port_str = f":{edge.dst_port}" if edge.dst_port else ""
        ratio = (edge.bytes / max_edge_bytes) ** 0.5
        stroke_w = max(1, int(1 + ratio * 5))
        lines.append({
            "id": f"e{i}",
            "lineType": "elbow",
            "endpoint1": {"type": "shapeEndpoint", "style": "none", "shapeId": src},
            "endpoint2": {"type": "shapeEndpoint", "style": "arrow", "shapeId": dst},
            "stroke": {"color": "#6b7280", "width": stroke_w, "style": "solid"},
            "text": [{"text": f"{proto}{port_str} {_fmt_bytes_lucid(edge.bytes)}", "position": 0.5, "side": "middle"}],
        })

    return {
        "version": 1,
        "title": title,
        "product": "lucidchart",
        "pages": [{"id": "page1", "title": "Network Topology", "shapes": shapes, "lines": lines}],
    }


@router.post("/topology/lucidchart")
async def export_topology_lucidchart(
    _: CurrentUser,
    window: str = Query("1h"),
    sampler_ip: Optional[str] = Query(None),
    min_bytes: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
):
    """Create a Lucidchart diagram from the current topology and return the edit URL."""
    import aiosqlite, json as _json
    from app.database import DB_PATH

    # Load API token from settings
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM settings WHERE key = 'lucid_api_token'") as cur:
            row = await cur.fetchone()
    token = _json.loads(row[0]) if row else ""
    if not token:
        raise HTTPException(status_code=400, detail="Lucidchart API token not configured. Add it in Settings → Integrations.")

    s, e = _parse_window(window)
    nodes, edges = await get_storage().get_topology(
        start=s, end=e, sampler_ip=sampler_ip, min_bytes=min_bytes, limit=limit,
    )
    if not nodes:
        raise HTTPException(status_code=404, detail="No topology data in this window.")

    title = f"pktFlow Topology ({window})"
    payload = _build_lucid_standard_import(nodes, edges, title)
    body = _json.dumps(payload).encode()

    req = urllib.request.Request(
        "https://api.lucid.co/documents",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/vnd.lucid.standardImport",
            "Lucid-Api-Version": "1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = _json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise HTTPException(status_code=502, detail=f"Lucidchart API error {exc.code}: {detail[:300]}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lucidchart API unreachable: {exc}")

    edit_url = result.get("editUrl") or result.get("documentUrl") or result.get("url") or f"https://lucid.app/lucidchart/{result.get('documentId','')}/edit"
    return {"edit_url": edit_url, "document_id": result.get("documentId")}


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
            "<HHIIHHHH",
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
            "<HHHH",
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
        "<BBHHHBBH4s4s",
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
        "<BBHHHBBH4s4s",
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
    rec_hdr = struct.pack("<IIII", ts_sec, ts_usec, pkt_len, pkt_len)

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
    global_hdr = struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)

    def _generate():
        yield global_hdr
        for flow in flows:
            yield _build_pcap_record(flow)

    return StreamingResponse(
        _generate(),
        media_type="application/vnd.tcpdump.pcap",
        headers={"Content-Disposition": "attachment; filename=pktflow-flows.pcap"},
    )
