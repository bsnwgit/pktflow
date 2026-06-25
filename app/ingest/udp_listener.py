"""
app/ingest/udp_listener.py — Direct UDP NetFlow v9 listener.

Receives raw NetFlow v9 UDP datagrams, decodes them using the `netflow`
pip package (bitkeks/python-netflow-v9-softflowd), normalizes records
into FlowRecord objects, and feeds them to IngestBuffer.

Template caching: the `templates` dict is shared across all packets for
the lifetime of the listener and is mutated in-place by parse_packet() as
template records arrive.  Until a router sends its first template packet
(usually on startup or within ~30 s), data records from that exporter are
silently dropped — this is normal NetFlow v9 behavior.

sysUptime-based timestamps: FIRST_SWITCHED / LAST_SWITCHED are
milliseconds since the router's last reboot, not epoch time.  We cannot
reconstruct absolute time without the router's current sysUptime, so the
packet arrival time is used as FlowRecord.timestamp and the raw delta is
stored as duration_ms.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from app.models.flow import FlowRecord
from app.ingest.buffer import IngestBuffer
from app.ingest.normalizer import _device_cache  # populated by refresh_device_cache()

log = logging.getLogger("pktflow.ingest.udp")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_ip(value) -> str:
    """Return a dotted-notation IP string, or '0.0.0.0' for None/empty."""
    if not value:
        return "0.0.0.0"
    s = str(value).strip()
    return s if s else "0.0.0.0"


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ── NetFlow v9 decoder ────────────────────────────────────────────────────────

def _decode_v9_flows(
    data: bytes,
    src_ip: str,
    templates: dict,
) -> list[FlowRecord]:
    """Parse one raw UDP datagram; return normalized FlowRecords (may be empty)."""
    from netflow import parse_packet  # lazy import — only needed when UDP is active

    try:
        packet = parse_packet(data, templates)
    except Exception as exc:
        msg = str(exc).lower()
        if "template" in msg:
            # Expected while waiting for the first template packet from this exporter
            log.debug("UDP template not yet seen from %s — dropping packet", src_ip)
        else:
            log.debug("UDP parse error from %s: %s", src_ip, exc)
        return []

    now = datetime.now(tz=timezone.utc)
    name, site = _device_cache.get(src_ip, ("", "unknown"))

    # The netflow library supports two slightly different API shapes across
    # versions.  Handle both defensively.
    raw_flows: list = []
    if hasattr(packet, "export") and hasattr(getattr(packet, "export", None), "flows"):
        raw_flows = packet.export.flows or []
    elif hasattr(packet, "flows"):
        raw_flows = packet.flows or []

    records: list[FlowRecord] = []
    for flow in raw_flows:
        d = getattr(flow, "data", None)
        if not d:
            continue
        try:
            # Duration from sysUptime-relative timestamps
            first = _safe_int(d.get("FIRST_SWITCHED"))
            last  = _safe_int(d.get("LAST_SWITCHED"))
            duration_ms = max(last - first, 0) if (first or last) else 0

            # DIRECTION field (NetFlow v9 type 61): 0=ingress, 1=egress
            raw_dir = d.get("DIRECTION")
            if raw_dir is not None:
                flow_dir = min(_safe_int(raw_dir), 1)
            else:
                flow_dir = 2  # unknown

            # Prefer IPv4 addresses; fall back to IPv6 if present
            src_ip_flow = _safe_ip(d.get("IPV4_SRC_ADDR") or d.get("IPV6_SRC_ADDR"))
            dst_ip_flow = _safe_ip(d.get("IPV4_DST_ADDR") or d.get("IPV6_DST_ADDR"))
            next_hop    = _safe_ip(d.get("IPV4_NEXT_HOP") or d.get("IPV6_NEXT_HOP"))

            records.append(FlowRecord(
                timestamp    = now,
                sampler_ip   = src_ip,
                sampler_name = name,
                site         = site,
                src_ip       = src_ip_flow,
                dst_ip       = dst_ip_flow,
                src_port     = _safe_int(d.get("L4_SRC_PORT")),
                dst_port     = _safe_int(d.get("L4_DST_PORT")),
                protocol     = _safe_int(d.get("PROTOCOL")),
                bytes        = _safe_int(d.get("IN_BYTES")),
                packets      = _safe_int(d.get("IN_PKTS")),
                duration_ms  = duration_ms,
                tcp_flags    = _safe_int(d.get("TCP_FLAGS")),
                tos          = _safe_int(d.get("SRC_TOS")),
                input_if     = _safe_int(d.get("INPUT_SNMP")),
                output_if    = _safe_int(d.get("OUTPUT_SNMP")),
                next_hop     = next_hop,
                src_as       = _safe_int(d.get("SRC_AS")),
                dst_as       = _safe_int(d.get("DST_AS")),
                flow_dir     = flow_dir,
            ))
        except Exception as exc:
            log.debug("Flow record normalization error from %s: %s", src_ip, exc)

    if records:
        log.debug("UDP decoded %d flow(s) from %s", len(records), src_ip)

    return records


# ── asyncio UDP protocol ──────────────────────────────────────────────────────

class _NetFlowUDPProtocol(asyncio.DatagramProtocol):
    """asyncio datagram protocol — one instance per listener socket."""

    def __init__(self) -> None:
        self._templates: dict = {}   # shared, mutated in-place by parse_packet

    def connection_made(self, transport: asyncio.DatagramTransport) -> None:
        self._transport = transport
        addr = transport.get_extra_info("sockname")
        log.info("UDP socket open on %s:%d", *addr)

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        src_ip = addr[0]
        # Offload decode to a task so we don't block the event loop's I/O
        asyncio.create_task(self._handle(data, src_ip))

    async def _handle(self, data: bytes, src_ip: str) -> None:
        records = _decode_v9_flows(data, src_ip, self._templates)
        if records:
            await IngestBuffer.get_instance().add(records)

    def error_received(self, exc: Exception) -> None:
        log.warning("UDP socket error: %s", exc)

    def connection_lost(self, exc: Optional[Exception]) -> None:
        log.info("UDP listener socket closed%s", f": {exc}" if exc else "")


# ── Public lifecycle class ────────────────────────────────────────────────────

class UDPNetFlowListener:
    """
    Lifecycle wrapper — call start() once at app startup, stop() at shutdown.

    Example (in lifespan):
        listener = UDPNetFlowListener()
        await listener.start(port=2055)
        ...
        await listener.stop()
    """

    def __init__(self) -> None:
        self._transport: Optional[asyncio.DatagramTransport] = None

    async def start(self, host: str = "0.0.0.0", port: int = 2055) -> None:
        if self._transport is not None:
            log.warning("UDP listener already running — ignoring duplicate start()")
            return
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            _NetFlowUDPProtocol,
            local_addr=(host, port),
        )
        self._transport = transport
        log.info("UDP NetFlow v9 listener started on %s:%d", host, port)

    async def stop(self) -> None:
        if self._transport:
            self._transport.close()
            self._transport = None
            log.info("UDP NetFlow v9 listener stopped")
