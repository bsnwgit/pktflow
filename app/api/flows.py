"""
GET /api/flows/* — flow data query endpoints.
All endpoints require authentication (any role).
"""
from __future__ import annotations

import csv
import io
import ipaddress
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
from app.models.flow import TopTalker, TimeSeriesPoint, DeviceSummary, FlowSearchResult, TopologyNode, TopologyEdge, ProtocolStat, PortStat, NatTranslation
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


@router.get("/nat-translations", response_model=list[NatTranslation])
async def nat_translations(
    _: CurrentUser,
    sampler_ip: Optional[str] = Query(None),
    window: str = Query("24h"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(500, ge=1, le=2000),
):
    """Observed (original address -> NAT'd address) mappings, aggregated
    from flows carrying NAT Information Elements. Only populated for
    exporters that send NAT event fields via the direct UDP NetFlow v9/
    IPFIX listener (see clickhouse/schema.sql and
    app/ingest/udp_listener.py) — most consumer/prosumer NAT gear does not
    export these, so an empty result here is expected and not an error."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)

    return await get_storage().get_nat_translations(s, e, sampler_ip, limit)


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
    any_direction: bool = Query(False, description="Match src/dst IP filters in either direction"),
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
        any_direction=any_direction,
    )


@router.get("/search/count")
async def count_flows(
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
    any_direction: bool = Query(False),
) -> dict:
    """Total matching rows for the current /search filters, for page-number pagination."""
    if start and end:
        s, e = start, end
    else:
        s, e = _parse_window(window)

    total = await get_storage().count_flows(
        src_ip=src_ip,
        dst_ip=dst_ip,
        src_port=src_port,
        dst_port=dst_port,
        protocol=protocol,
        sampler_ip=sampler_ip,
        start=s,
        end=e,
        any_direction=any_direction,
    )
    return {"total": total}


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


# ── Geo map ───────────────────────────────────────────────────────────────────

def _is_private_ip(ip: str) -> bool:
    """Return True for RFC-1918, loopback, link-local, multicast, and unroutable addresses."""
    try:
        addr = ipaddress.ip_address(ip)
        return (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        )
    except ValueError:
        return True


@router.get("/geo")
async def get_geo_data(
    _: CurrentUser,
    window: str = Query("1h"),
    sampler_ip: Optional[str] = Query(None),
):
    """
    Geolocate the top IP flows from flow data and return locations + colored arcs
    for the geo traffic map.

    Private IPs are resolved against nat_mappings (private CIDR -> a
    representative public CIDR/IP) so RFC-1918 traffic appears at the correct
    physical site instead of being dropped from the map — a NAT mapping
    carries no line style of its own. traffic_rules is the only source of
    visual styling: a rule scoped to that NAT mapping (with or without a
    destination CIDR/IP, Site, and/or port filter) supplies the line style,
    first match wins in priority order. When both ends of a flow match a
    different NAT mapping, the one with the better (lower) priority is used
    to look up rules. Flows matching no rule at all fall back to a neutral
    gray line.

    A NAT mapping's own dst_cidrs/dst_ports let the SAME private_cidr resolve
    to a DIFFERENT public_cidr depending on the flow's destination — modeling
    a firewall that NATs the same internal range out different public IPs
    depending on where the traffic is headed (e.g. DNS out one IP, everything
    else out another). Resolution therefore happens per flow pair, not once
    per unique IP: the same private IP can legitimately produce two separate
    map markers if its effective public identity genuinely varies by
    destination. Both legs of a bidirectional conversation resolve against
    the same normalized service port (see pair_service_port below) so they
    still merge into one arc instead of splitting on direction alone.

    Any IP not resolved via nat_mappings (this is normally the remote/public
    end of a flow) is additionally checked against every site's ip_cidr
    field — a site can list the real-world IP/CIDR(s) it's reached at so its
    marker color shows up on the remote end too, not just the local end via
    a NAT mapping.

    Uses ip-api.com batch (free, no key required).
    """
    import aiosqlite
    from app.database import DB_PATH

    s, e = _parse_window(window)
    pairs = await get_storage().get_top_ip_pairs(start=s, end=e, limit=300, sampler_ip=sampler_ip)

    DEFAULT_LINE = {"color_hex": "#6b7280", "dash_pattern": ""}  # unmapped public<->public traffic

    # ── Load NAT mappings, traffic rules, sites, and the line style catalog ────
    nat_mappings_list: list[dict] = []
    traffic_rules_list: list[dict] = []
    sites_list: list[dict] = []
    all_sites_list: list[dict] = []
    line_styles_map: dict[int, dict] = {}
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM nat_mappings ORDER BY priority, id") as cur:
                nat_mappings_list = [dict(r) for r in await cur.fetchall()]
            # ISP DHCP mode: every other mapping is grayed out/unused in the
            # UI, and the same restriction applies here — only the single
            # synthetic "Default" mapping (tracked by id) is actually matched.
            async with db.execute("SELECT value FROM settings WHERE key = 'isp_dhcp_enabled'") as cur:
                row = await cur.fetchone()
            if row and json.loads(row[0]):
                async with db.execute("SELECT value FROM settings WHERE key = 'isp_dhcp_mapping_id'") as cur:
                    id_row = await cur.fetchone()
                dhcp_mapping_id = json.loads(id_row[0]) if id_row else None
                nat_mappings_list = [m for m in nat_mappings_list if m["id"] == dhcp_mapping_id]
            async with db.execute("SELECT * FROM traffic_rules ORDER BY priority, id") as cur:
                traffic_rules_list = [dict(r) for r in await cur.fetchall()]
            # Unfiltered — sites_by_name below needs every site (including
            # ones with no ip_cidr yet, so a Traffic Rule's dst_site_key can
            # still resolve to "nothing to match" rather than a KeyError).
            # sites_list (ip_cidr-only) is the remote-IP fallback match in
            # _match_site, which only ever cares about sites that have one.
            async with db.execute("SELECT * FROM sites ORDER BY id") as cur:
                all_sites_list = [dict(r) for r in await cur.fetchall()]
            sites_list = [s for s in all_sites_list if s["ip_cidr"]]
            async with db.execute("SELECT * FROM line_styles") as cur:
                line_styles_map = {r["id"]: dict(r) for r in await cur.fetchall()}
    except Exception:
        pass  # tables may not exist on older deploys — degrade gracefully

    sites_by_name: dict[str, dict] = {s["name"]: s for s in all_sites_list}

    def _cidr_to_query_ip(cidr_or_ip: str) -> str:
        """Resolve a /32 or a broader CIDR block to a single representative IP for geolocation."""
        try:
            return str(ipaddress.ip_network(cidr_or_ip, strict=False).network_address)
        except ValueError:
            return cidr_or_ip

    def _cidr_list_matches(ip: str, spec: str) -> bool:
        """True if ip falls within any comma-separated CIDR/IP in spec."""
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                if ipaddress.ip_address(ip) in ipaddress.ip_network(part, strict=False):
                    return True
            except ValueError:
                if ip == part:
                    return True
        return False

    def _port_list_matches(port: Optional[int], spec: str) -> bool:
        """True if port falls within any comma-separated port/range in spec (e.g. '53,8000-9000')."""
        if port is None:
            return False
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                lo, _, hi = part.partition("-")
                try:
                    if int(lo) <= port <= int(hi):
                        return True
                except ValueError:
                    continue
            else:
                try:
                    if port == int(part):
                        return True
                except ValueError:
                    continue
        return False

    def _match_nat_mapping(ip: str, remote_ip: str, dst_port: Optional[int]) -> Optional[dict]:
        """First priority-ordered nat_mappings row whose private_cidr covers ip,
        and whose own dst_cidrs/dst_ports (if set) match the flow's remote_ip
        and dst_port — lets the same private range resolve to a different
        public_cidr depending on destination (e.g. DNS out one NAT, everything
        else out another)."""
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        for m in nat_mappings_list:
            try:
                covers = addr in ipaddress.ip_network(m["private_cidr"], strict=False)
            except ValueError:
                covers = (ip == m["private_cidr"])  # single host IP, not a CIDR
            if not covers:
                continue
            if m["dst_cidrs"] and not _cidr_list_matches(remote_ip, m["dst_cidrs"]):
                continue
            if m["dst_ports"] and not _port_list_matches(dst_port, m["dst_ports"]):
                continue
            return m
        return None

    def _match_rule(mapping_id: Optional[int], remote_ip: str, dst_port: Optional[int]) -> Optional[dict]:
        """First traffic_rules row (already priority-ordered) matching this
        NAT mapping (or scoped to 'any'), destination (CIDR or Site), and
        destination port."""
        for r in traffic_rules_list:
            if r["nat_mapping_id"] is not None and r["nat_mapping_id"] != mapping_id:
                continue
            if r["dst_cidrs"]:
                if not _cidr_list_matches(remote_ip, r["dst_cidrs"]):
                    continue
            elif r["dst_site_key"]:
                site = sites_by_name.get(r["dst_site_key"])
                if not site or not site["ip_cidr"] or not _cidr_list_matches(remote_ip, site["ip_cidr"]):
                    continue
            if r["dst_ports"] and not _port_list_matches(dst_port, r["dst_ports"]):
                continue
            return r
        return None

    def _resolve_line(meta: Optional[dict], remote_ip: str, dst_port: Optional[int]) -> Optional[tuple]:
        """Return (priority, line_style_id, rule_name) for one side of a flow, or None if
        unmapped. line_style_id/rule_name are None (falls back to the neutral default) if
        no rule matches — a NAT mapping itself carries no style, only traffic_rules does."""
        if not meta:
            return None
        rule = _match_rule(meta["id"], remote_ip, dst_port)
        if rule:
            return (meta["priority"], rule["line_style_id"], rule["name"])
        return (meta["priority"], None, None)

    def _match_site(ip: str) -> Optional[dict]:
        """First sites row (in id order) whose ip_cidr list covers ip. Used only to
        color the marker for an end of a flow that nat_mappings didn't match —
        sites carry no line style, so this never feeds into _resolve_line."""
        for site in sites_list:
            if _cidr_list_matches(ip, site["ip_cidr"]):
                return site
        return None

    # ── Normalize a shared destination port per undirected endpoint pair ───────
    # Aggregation and matching below both treat a request leg (A→B) and its
    # response leg (B→A) as one relationship, not two directional ones —
    # without normalizing dst_port here they'd resolve NAT mappings and
    # Traffic Rules inconsistently (and, before this, draw as two separate
    # arcs bowing opposite ways). get_top_ip_pairs groups by (src, dst,
    # dst_port), so a request leg (A->B, dst_port=443) and its response leg
    # (B->A, dst_port=<A's ephemeral port>) arrive as separate rows carrying
    # different dst_port values. Use the lower port seen across both
    # directions of a pair as the shared "service port" so both legs resolve
    # identically — same NAT mapping, same rule, same arc.
    pair_service_port: dict[tuple, int] = {}
    for p in pairs:
        dp = p.get("dst_port")
        if dp is None:
            continue
        ep = tuple(sorted((p["src_ip"], p["dst_ip"])))
        if ep not in pair_service_port or dp < pair_service_port[ep]:
            pair_service_port[ep] = dp

    def _resolve_side(ip: str, remote_ip: str, dst_port: Optional[int]) -> Optional[tuple]:
        """Resolve one IP in the context of a specific flow (its remote IP and
        the pair's normalized service port). Returns (key, effective_ip, meta)
        or None if this IP can't be placed at all (private with no matching
        NAT mapping). `key` — (ip, matched nat_mapping id) for private IPs,
        (ip, None) for public ones — is what the same private IP resolves to
        differently across pairs when a NAT mapping's own dst_cidrs/dst_ports
        make it apply to some destinations and not others."""
        if _is_private_ip(ip):
            m = _match_nat_mapping(ip, remote_ip, dst_port)
            if not m:
                return None
            return ((ip, m["id"]), _cidr_to_query_ip(m["public_cidr"]), m)
        return ((ip, None), ip, None)

    # resolved_pairs mirrors `pairs`, each entry annotated with its src/dst
    # resolution — computed once and reused for geolocation, aggregation, and
    # arc building so all three agree on the same per-pair NAT identity.
    resolved_pairs: list[tuple] = []
    for p in pairs:
        ep = tuple(sorted((p["src_ip"], p["dst_ip"])))
        dst_port = pair_service_port.get(ep, p.get("dst_port"))
        src_side = _resolve_side(p["src_ip"], p["dst_ip"], dst_port)
        dst_side = _resolve_side(p["dst_ip"], p["src_ip"], dst_port)
        resolved_pairs.append((p, src_side, dst_side))

    # ── Build effective-key mapping ─────────────────────────────────────────────
    # key_to_effective : resolution key -> ip to actually send to ip-api.com
    # key_to_meta      : resolution key -> matched nat_mappings row (private only)
    key_to_effective: dict[tuple, str] = {}
    key_to_meta: dict[tuple, dict] = {}
    for _p, src_side, dst_side in resolved_pairs:
        for side in (src_side, dst_side):
            if not side:
                continue
            key, eff, meta = side
            if key not in key_to_effective:
                key_to_effective[key] = eff
                if meta:
                    key_to_meta[key] = meta

    # key_to_site_match : resolution key -> matched sites row, for any key
    # nat_mappings didn't already claim (normally the remote/public end).
    key_to_site_match: dict[tuple, dict] = {}
    if sites_list:
        for key in key_to_effective:
            if key in key_to_meta:
                continue
            site = _match_site(key[0])
            if site:
                key_to_site_match[key] = site

    if not key_to_effective:
        return {"locations": [], "arcs": []}

    # ── Geolocate unique effective IPs via ip-api.com ──────────────────────────
    unique_effective = list(set(key_to_effective.values()))[:100]
    geo_map: dict[str, dict] = {}  # effective_ip -> {lat, lng, city, country, ...}
    try:
        body = json.dumps([
            {"query": ip, "fields": "status,query,lat,lon,city,country,countryCode"}
            for ip in unique_effective
        ]).encode()
        req = urllib.request.Request(
            "http://ip-api.com/batch",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            results = json.loads(resp.read())
        for r in results:
            if r.get("status") == "success":
                geo_map[r["query"]] = {
                    "lat":          r["lat"],
                    "lng":          r["lon"],
                    "city":         r.get("city", ""),
                    "country":      r.get("country", ""),
                    "country_code": r.get("countryCode", ""),
                }
    except Exception:
        pass

    if not geo_map:
        return {"locations": [], "arcs": []}

    # ── Aggregate bytes/flows per resolution key ────────────────────────────────
    key_bytes: dict[tuple, int] = {}
    key_flows: dict[tuple, int] = {}
    for p, src_side, dst_side in resolved_pairs:
        for side in (src_side, dst_side):
            if not side:
                continue
            key, eff, _meta = side
            if eff in geo_map:
                key_bytes[key] = key_bytes.get(key, 0) + p["bytes"]
                key_flows[key] = key_flows.get(key, 0) + p["flows"]

    # ── Build locations ────────────────────────────────────────────────────────
    # A private IP whose NAT mapping genuinely varies by destination produces
    # one location entry per distinct resolution key — i.e. more than one
    # marker for the same IP if it really does egress differently depending
    # on where the traffic is headed.
    locations: list[dict] = []
    for key, eff in key_to_effective.items():
        g = geo_map.get(eff)
        if not g:
            continue
        meta = key_to_meta.get(key)
        site = key_to_site_match.get(key)
        locations.append({
            "ip":           key[0],
            "lat":          g["lat"],
            "lng":          g["lng"],
            "city":         g["city"],
            "country":      g["country"],
            "country_code": g["country_code"],
            "bytes":        key_bytes.get(key, 0),
            "flows":        key_flows.get(key, 0),
            "site_name":    meta["name"]         if meta else (site["display_name"] if site else ""),
            "site_key":     meta["site_key"]     if meta else (site["name"]          if site else ""),
        })

    # ── Build arcs ─────────────────────────────────────────────────────────────
    # Aggregated by (unordered resolved-key pair, resolved line style) rather
    # than directional (src, dst) — a request leg and its response leg are
    # the same visual line between the same two points, just opposite NetFlow
    # directions. Sorting by str() rather than the tuples directly sidesteps
    # comparing a None second element against an int across mismatched keys.
    arc_agg: dict[tuple, dict] = {}
    for p, src_side, dst_side in resolved_pairs:
        if not src_side or not dst_side:
            continue
        src_key, src_eff, src_meta = src_side
        dst_key, dst_eff, dst_meta = dst_side
        sg = geo_map.get(src_eff)
        dg = geo_map.get(dst_eff)
        if not sg or not dg:
            continue

        ep = tuple(sorted((p["src_ip"], p["dst_ip"])))
        dst_port = pair_service_port.get(ep, p.get("dst_port"))
        src_res = _resolve_line(src_meta, p["dst_ip"], dst_port)
        dst_res = _resolve_line(dst_meta, p["src_ip"], dst_port)
        if src_res and dst_res:
            winning = src_res if src_res[0] <= dst_res[0] else dst_res
        else:
            winning = src_res or dst_res
        line_style_id = winning[1] if winning else None
        rule_name = winning[2] if winning else None
        style = line_styles_map.get(line_style_id, DEFAULT_LINE)

        arc_ep = tuple(sorted((src_key, dst_key), key=str))
        key = (arc_ep, line_style_id)
        if key not in arc_agg:
            arc_agg[key] = {
                "src_ip":  p["src_ip"],
                "src_lat": sg["lat"],
                "src_lng": sg["lng"],
                "dst_ip":  p["dst_ip"],
                "dst_lat": dg["lat"],
                "dst_lng": dg["lng"],
                "bytes":   0,
                "flows":   0,
                "color":   style["color_hex"],
                "dash":    style["dash_pattern"],
                "label":   rule_name,  # the Traffic Rule that assigned this style, for the legend/tooltip
            }
        arc_agg[key]["bytes"] += p["bytes"]
        arc_agg[key]["flows"] += p["flows"]

    arcs = sorted(arc_agg.values(), key=lambda a: a["bytes"], reverse=True)[:50]
    return {"locations": locations, "arcs": arcs}


# ── Lucidchart diagram export ─────────────────────────────────────────────────

def _fmt_bytes_lucid(b: int) -> str:
    if b >= 1_000_000_000: return f"{b/1e9:.1f}GB"
    if b >= 1_000_000:     return f"{b/1e6:.1f}MB"
    if b >= 1_000:         return f"{b/1e3:.1f}KB"
    return f"{b}B"

SITE_COLORS_LUCID = ["#3b82f6","#8b5cf6","#10b981","#f59e0b","#ef4444","#06b6d4"]
PROTO_NAMES_LUCID = {1:"ICMP",6:"TCP",17:"UDP",47:"GRE",50:"ESP"}

# Fixed 3-band layout constants — mirror Topology.tsx's buildLayeredDiagram /
# layoutSamplerBands exactly, so the exported diagram matches the in-app view.
CARD_W, CARD_H = 172, 58
DEVICE_GAP_Y = 14
SUBNET_PAD = 16
SUBNET_LABEL_H = 26
SUBNET_GAP_X = 36
BAND_GAP_Y = 110
L3_W, L3_H = 150, 56
EXTERNAL_MAX_COLS = 6
EXTERNAL_GAP_X = 20
EXTERNAL_GAP_Y = 16
SAMPLER_GAP_X = 100
BAND_TOP = 44


def _is_private_ip_rfc1918(ip: str) -> bool:
    """Pure octet check — RFC 1918 + loopback + link-local — matching the
    frontend's isPrivateIP exactly, so classification agrees between the
    in-app view and this export. Deliberately narrower than the geo-map's
    _is_private_ip (which also excludes multicast/reserved for a different
    purpose)."""
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return False
    a, b = nums[0], nums[1]
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 127:
        return True
    if a == 169 and b == 254:
        return True
    return False


def _subnet24_lucid(ip: str) -> str:
    parts = ip.split(".")
    return ".".join(parts[:3]) if len(parts) == 4 else ip


def _build_layered_diagram(nodes, edges) -> list[dict]:
    """Same algorithm as the frontend's buildLayeredDiagram: for each
    sampler, split its observed private<->public conversations into private
    devices (grouped by /24 subnet) and external devices, with each side
    getting exactly one aggregated line toward/from a single generic L3
    pivot — so a destination reached by several internal hosts renders once,
    not duplicated or chained. Private<->private edges never cross L3."""
    node_by_id = {n.id: n for n in nodes}
    samplers = [n for n in nodes if n.is_sampler]

    bands = []
    for sampler in samplers:
        relevant = [e for e in edges if e.sampler_ip == sampler.id]

        private_line: dict[str, dict] = {}
        external_line: dict[str, dict] = {}
        private_private_edges = []
        private_ids: set[str] = set()
        external_ids: set[str] = set()

        for e in relevant:
            src_priv = _is_private_ip_rfc1918(e.source)
            dst_priv = _is_private_ip_rfc1918(e.target)
            if src_priv and dst_priv:
                private_private_edges.append(e)
                private_ids.add(e.source); private_ids.add(e.target)
                continue
            if not src_priv and not dst_priv:
                continue

            priv_id = e.source if src_priv else e.target
            ext_id = e.target if src_priv else e.source
            private_ids.add(priv_id); external_ids.add(ext_id)

            pl = private_line.setdefault(priv_id, {"peer_ids": set(), "bytes": 0, "flows": 0})
            pl["peer_ids"].add(ext_id); pl["bytes"] += e.bytes; pl["flows"] += e.flows

            el = external_line.setdefault(ext_id, {"peer_ids": set(), "bytes": 0, "flows": 0})
            el["peer_ids"].add(priv_id); el["bytes"] += e.bytes; el["flows"] += e.flows

        private_devices = [node_by_id[i] for i in private_ids if i in node_by_id]
        external_devices = sorted(
            (node_by_id[i] for i in external_ids if i in node_by_id),
            key=lambda n: -n.bytes,
        )

        by_subnet: dict[str, list] = {}
        for d in private_devices:
            by_subnet.setdefault(_subnet24_lucid(d.id), []).append(d)
        subnet_groups = [
            {"subnet": subnet, "devices": sorted(devices, key=lambda n: -n.bytes)}
            for subnet, devices in sorted(by_subnet.items())
        ]

        bands.append({
            "sampler": sampler,
            "subnet_groups": subnet_groups,
            "externals": external_devices,
            "private_line": private_line,
            "external_line": external_line,
            "private_private_edges": private_private_edges,
        })

    return bands


def _build_lucid_standard_import(nodes, edges, title: str) -> dict:
    """Convert topology nodes/edges to a hierarchical Lucidchart Standard
    Import diagram matching Topology.tsx's fixed 3-band view: private
    devices (grouped into subnet boxes) at top, a single generic L3 pivot
    per sampler in the middle, external destinations at bottom."""
    sites = list(dict.fromkeys(n.site or "unknown" for n in nodes))
    site_color = lambda s: SITE_COLORS_LUCID[sites.index(s) % len(SITE_COLORS_LUCID)]

    bands = _build_layered_diagram(nodes, edges)

    max_line_bytes = 1
    for band in bands:
        for info in list(band["private_line"].values()) + list(band["external_line"].values()):
            max_line_bytes = max(max_line_bytes, info["bytes"])

    def stroke_width(b: int) -> int:
        return max(1, int(1 + (b / max_line_bytes) ** 0.5 * 5))

    shapes = []
    lines = []
    shape_id_by_key: dict[str, str] = {}
    counter = [0]

    def next_sid() -> str:
        sid = f"n{counter[0]}"; counter[0] += 1
        return sid

    def device_shape(node, x: float, y: float, key: str) -> None:
        sid = next_sid()
        shape_id_by_key[key] = sid
        color = site_color(node.site or "unknown")
        name = (node.sampler_name or node.id)[:26]
        label = f"{name}\n{node.id}" if node.sampler_name else name
        label += f"\n{_fmt_bytes_lucid(node.bytes)} · {node.flows:,} fl"
        shapes.append({
            "id": sid, "type": "rectangle",
            "boundingBox": {"x": x - CARD_W / 2, "y": y - CARD_H / 2, "w": CARD_W, "h": CARD_H},
            "text": label,
            "style": {
                "fill": {"type": "color", "color": "#1f2937"},
                "stroke": {"color": color, "width": 1.5, "style": "solid"},
                "textColor": "#f3f4f6", "fontSize": 10,
            },
        })

    def group_box(x: float, y: float, w: float, h: float, label: str) -> None:
        shapes.append({
            "id": next_sid(), "type": "rectangle",
            "boundingBox": {"x": x, "y": y, "w": w, "h": h},
            "text": label,
            "style": {
                "fill": {"type": "none"},
                "stroke": {"color": "#374151", "width": 1, "style": "solid"},
                "textColor": "#9ca3af", "fontSize": 11,
            },
        })

    cursor_x = 40.0
    for band in bands:
        sampler = band["sampler"]
        sampler_key = sampler.id

        subnet_x = cursor_x
        tallest_subnet = 0.0
        subnet_centers: list[float] = []
        for group in band["subnet_groups"]:
            n = len(group["devices"])
            box_h = SUBNET_LABEL_H + SUBNET_PAD + n * CARD_H + max(0, n - 1) * DEVICE_GAP_Y + SUBNET_PAD
            box_w = CARD_W + SUBNET_PAD * 2
            group_box(subnet_x, BAND_TOP, box_w, box_h, group["subnet"] + ".0/24")
            tallest_subnet = max(tallest_subnet, box_h)
            subnet_centers.append(subnet_x + box_w / 2)

            device_y = BAND_TOP + SUBNET_LABEL_H + SUBNET_PAD + CARD_H / 2
            for dev in group["devices"]:
                device_shape(dev, subnet_x + box_w / 2, device_y, f"{sampler_key}|{dev.id}")
                device_y += CARD_H + DEVICE_GAP_Y
            subnet_x += box_w + SUBNET_GAP_X

        band_end_x = subnet_x - SUBNET_GAP_X if band["subnet_groups"] else cursor_x + CARD_W
        private_span_center = (
            (subnet_centers[0] + subnet_centers[-1]) / 2 if subnet_centers else cursor_x + CARD_W / 2
        )

        l3_y = BAND_TOP + tallest_subnet + BAND_GAP_Y / 2
        l3_x = private_span_center
        l3_sid = next_sid()
        shape_id_by_key[f"L3|{sampler_key}"] = l3_sid
        shapes.append({
            "id": l3_sid, "type": "rectangle",
            "boundingBox": {"x": l3_x - L3_W / 2, "y": l3_y - L3_H / 2, "w": L3_W, "h": L3_H},
            "text": "L3\nnetwork boundary",
            "style": {
                "fill": {"type": "color", "color": "#111827"},
                "stroke": {"color": "#6b7280", "width": 1.5, "style": "dashed"},
                "textColor": "#d1d5db", "fontSize": 11,
            },
        })

        for priv_id, info in band["private_line"].items():
            src_sid = shape_id_by_key.get(f"{sampler_key}|{priv_id}")
            if not src_sid:
                continue
            lines.append({
                "id": f"e{len(lines)}", "lineType": "elbow",
                "endpoint1": {"type": "shapeEndpoint", "style": "none", "shapeId": src_sid},
                "endpoint2": {"type": "shapeEndpoint", "style": "arrow", "shapeId": l3_sid},
                "stroke": {"color": "#6b7280", "width": stroke_width(info["bytes"]), "style": "solid"},
                "text": [{"text": f"{_fmt_bytes_lucid(info['bytes'])} · {info['flows']} fl", "position": 0.5, "side": "middle"}],
            })

        n_ext = len(band["externals"])
        cols = max(1, min(EXTERNAL_MAX_COLS, n_ext))
        rows = -(-n_ext // cols) if n_ext else 0
        ext_grid_w = cols * CARD_W + max(0, cols - 1) * EXTERNAL_GAP_X
        ext_box_w = ext_grid_w + SUBNET_PAD * 2
        ext_box_h = SUBNET_LABEL_H + SUBNET_PAD + rows * CARD_H + max(0, rows - 1) * EXTERNAL_GAP_Y + SUBNET_PAD
        ext_box_x = l3_x - ext_box_w / 2
        ext_box_y = l3_y + L3_H / 2 + BAND_GAP_Y / 2
        if n_ext:
            group_box(ext_box_x, ext_box_y, ext_box_w, ext_box_h, "External")

        for i, dev in enumerate(band["externals"]):
            col, row = i % cols, i // cols
            x = ext_box_x + SUBNET_PAD + col * (CARD_W + EXTERNAL_GAP_X) + CARD_W / 2
            y = ext_box_y + SUBNET_LABEL_H + SUBNET_PAD + row * (CARD_H + EXTERNAL_GAP_Y) + CARD_H / 2
            device_shape(dev, x, y, f"{sampler_key}|{dev.id}")

        for ext_id, info in band["external_line"].items():
            dst_sid = shape_id_by_key.get(f"{sampler_key}|{ext_id}")
            if not dst_sid:
                continue
            lines.append({
                "id": f"e{len(lines)}", "lineType": "elbow",
                "endpoint1": {"type": "shapeEndpoint", "style": "none", "shapeId": l3_sid},
                "endpoint2": {"type": "shapeEndpoint", "style": "arrow", "shapeId": dst_sid},
                "stroke": {"color": "#6b7280", "width": stroke_width(info["bytes"]), "style": "solid"},
                "text": [{"text": f"{_fmt_bytes_lucid(info['bytes'])} · {info['flows']} fl", "position": 0.5, "side": "middle"}],
            })

        for edge in band["private_private_edges"]:
            a_sid = shape_id_by_key.get(f"{sampler_key}|{edge.source}")
            b_sid = shape_id_by_key.get(f"{sampler_key}|{edge.target}")
            if not a_sid or not b_sid:
                continue
            proto = PROTO_NAMES_LUCID.get(edge.protocol, f"P{edge.protocol}")
            port_str = f":{edge.dst_port}" if edge.dst_port else ""
            lines.append({
                "id": f"e{len(lines)}", "lineType": "elbow",
                "endpoint1": {"type": "shapeEndpoint", "style": "none", "shapeId": a_sid},
                "endpoint2": {"type": "shapeEndpoint", "style": "none", "shapeId": b_sid},
                "stroke": {
                    "color": "#f59e0b" if edge.is_asymmetric else "#6b7280",
                    "width": 1, "style": "dashed",
                },
                "text": [{"text": f"{proto}{port_str} {_fmt_bytes_lucid(edge.bytes)}", "position": 0.5, "side": "middle"}],
            })

        cursor_x = max(band_end_x, ext_box_x + ext_box_w) + SAMPLER_GAP_X

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
    src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end,
    any_direction: bool = False,
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
        any_direction=any_direction,
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

    any_direction: bool = Query(False),
):
    """Export filtered flows as CSV."""
    flows = await _fetch_for_export(src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end, any_direction)

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

    any_direction: bool = Query(False),
):
    """Export filtered flows as JSON array."""
    flows = await _fetch_for_export(src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end, any_direction)

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

    any_direction: bool = Query(False),
):
    """
    Export filtered flows as a synthetic PCAP file.
    Each flow becomes one reconstructed packet (Ethernet + IP + L4 headers only).
    No application payload — NetFlow does not carry payload data.
    Compatible with Wireshark, tcpdump, and other PCAP tools.
    """
    flows = await _fetch_for_export(src_ip, dst_ip, src_port, dst_port, protocol, sampler_ip, window, start, end, any_direction)

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
