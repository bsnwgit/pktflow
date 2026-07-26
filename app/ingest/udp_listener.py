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
from app.ingest.normalizer import _device_cache, _conversation_id, _flow_role  # populated by refresh_device_cache()

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
    # Lazy imports — only needed when UDP is active
    from netflow import parse_packet
    from netflow.ipfix import IPFIXTemplateNotRecognized
    from netflow.v9 import V9TemplateNotRecognized

    try:
        packet = parse_packet(data, templates)
    except (V9TemplateNotRecognized, IPFIXTemplateNotRecognized):
        # Expected while waiting for the first template packet from this
        # exporter. These are raised with no message text, so checking
        # str(exc) (as this used to do) never matched and every one of
        # these got misreported as an opaque "UDP parse error from ...: "
        # with an empty message — checking the exception type directly
        # instead of sniffing its (empty) string form.
        log.info("UDP template not yet seen from %s — dropping packet", src_ip)
        return []
    except Exception as exc:
        log.info("UDP parse error from %s: %s", src_ip, exc)
        return []

    # Settings -> Devices is the gateway for what's allowed to persist — a
    # sampler can be sending flows on the wire, but nothing is stored unless
    # its IP is registered there and marked Allowed.
    device = _device_cache.get(src_ip)
    if device is None:
        from app.alerts.engine import AlertEngine
        AlertEngine.notify_unknown_sampler(src_ip)
        return []

    now = datetime.now(tz=timezone.utc)
    name, site = device

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
            src_port    = _safe_int(d.get("L4_SRC_PORT"))
            dst_port    = _safe_int(d.get("L4_DST_PORT"))
            protocol    = _safe_int(d.get("PROTOCOL"))

            # NAT translation — standard IANA NAT Information Elements
            # (IPFIX IE 225-230), present only when the exporter itself
            # supports NAT event logging (Cisco ASA/ISR NSEL, Juniper SRX,
            # pfSense/OPNsense-class gear — see clickhouse/schema.sql).
            # NetFlow v9 and IPFIX use different field-name strings for the
            # same IEs; the `netflow` library decodes both by name into the
            # same flat dict, so check both like the src/dst IPv4-vs-IPv6
            # fallback above. None (not "0.0.0.0"/0) when absent.
            nat_src_ip_raw = d.get("NF_F_XLATE_SRC_ADDR_IPV4") or d.get("postNATSourceIPv4Address")
            nat_dst_ip_raw = d.get("NF_F_XLATE_DST_ADDR_IPV4") or d.get("postNATDestinationIPv4Address")
            nat_src_port_raw = d.get("NF_F_XLATE_SRC_PORT") or d.get("postNAPTSourceTransportPort")
            nat_dst_port_raw = d.get("NF_F_XLATE_DST_PORT") or d.get("postNAPTDestinationTransportPort")
            nat_event_raw = d.get("natEvent")

            records.append(FlowRecord(
                timestamp    = now,
                sampler_ip   = src_ip,
                sampler_name = name,
                site         = site,
                src_ip       = src_ip_flow,
                dst_ip       = dst_ip_flow,
                src_port     = src_port,
                dst_port     = dst_port,
                protocol     = protocol,
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
                conversation_id = _conversation_id(src_ip_flow, dst_ip_flow, src_port, dst_port, protocol),
                flow_role       = _flow_role(src_port, dst_port),
                nat_src_ip   = str(nat_src_ip_raw) if nat_src_ip_raw else None,
                nat_dst_ip   = str(nat_dst_ip_raw) if nat_dst_ip_raw else None,
                nat_src_port = _safe_int(nat_src_port_raw) if nat_src_port_raw is not None else None,
                nat_dst_port = _safe_int(nat_dst_port_raw) if nat_dst_port_raw is not None else None,
                nat_event    = _safe_int(nat_event_raw) if nat_event_raw is not None else None,
            ))
        except Exception as exc:
            log.info("Flow record normalization error from %s: %s", src_ip, exc)

    log.info("UDP packet from %s: %d raw flow(s), %d normalized", src_ip, len(raw_flows), len(records))

    return records


# ── asyncio UDP protocol ──────────────────────────────────────────────────────

class _NetFlowUDPProtocol(asyncio.DatagramProtocol):
    """asyncio datagram protocol — one instance per listener socket."""

    def __init__(self) -> None:
        # Pre-seed "netflow"/"ipfix" as dicts, not the library's own default.
        # netflow.utils.parse_packet() does `templates["netflow"] = []` (a
        # LIST) if the key is missing, per its own docstring/example — but
        # netflow.v9.V9ExportPacket then does `self._templates[id_] = template`
        # using the raw Template ID (commonly 256+ in real exporters) as an
        # arbitrary key, which only works on a dict. On a list this always
        # raises IndexError for any realistic Template ID, silently dropping
        # every flow record after the first template arrives. Pre-supplying
        # dicts here (the check is `if "netflow" not in templates`, so our
        # values are used as-is) sidesteps the bug entirely.
        self._templates: dict = {"netflow": {}, "ipfix": {}}   # shared, mutated in-place by parse_packet

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
