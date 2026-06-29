"""
Flow record normalizer.

Converts raw GoFlow2 JSON (as POSTed by Vector) into a list of FlowRecord objects.
Also enriches each record with sampler_name and site from the device registry.

Vector outputs snake_case field names after transforming goflow2 data:
  sampler_address, src_addr, dst_addr, bytes, packets, proto (string!), in_if, out_if ...

Also handles PascalCase (protobuf-JSON) for direct goflow2 ingest:
  SamplerAddress, SrcAddr, DstAddr, Bytes, Packets, Proto ...

Key difference: vector outputs proto as a string ("UDP", "TCP") not an integer.
"""
from __future__ import annotations

import hashlib
import logging
import struct
from datetime import datetime, timezone
from typing import Any, Optional, Union

from app.models.flow import FlowRecord

log = logging.getLogger("pktflow.ingest.normalizer")

# Cache of sampler_ip → (name, site) — populated from device registry
_device_cache: dict[str, tuple[str, str]] = {}

# Protocol name → IANA protocol number
_PROTO_NAMES: dict[str, int] = {
    "HOPOPT": 0, "ICMP": 1, "IGMP": 2, "GGP": 3, "IPV4": 4, "ST": 5,
    "TCP": 6, "CBT": 7, "EGP": 8, "IGP": 9, "PUP": 12, "UDP": 17,
    "HMP": 20, "RDP": 27, "IPV6": 41, "IPV6_ROUTE": 43, "IPV6_FRAG": 44,
    "IDRP": 45, "RSVP": 46, "GRE": 47, "ESP": 50, "AH": 51,
    "ICMPV6": 58, "IPV6_NONXT": 59, "IPV6_OPTS": 60, "OSPF": 89,
    "PIM": 103, "SCTP": 132, "MPLS_IN_IP": 137,
}


def refresh_device_cache(devices: list[dict]) -> None:
    """Called by ingest handler after settings change or on startup."""
    global _device_cache
    _device_cache = {d["ip"]: (d["name"], d["site"]) for d in devices}


def _get(raw: dict, *keys: str, default: Any = None) -> Any:
    """Try multiple key names in order, return first found value."""
    for key in keys:
        if key in raw and raw[key] is not None:
            return raw[key]
    return default


def _proto_to_int(val: Any) -> int:
    """Convert protocol value to int. Handles integers, numeric strings, and name strings."""
    if val is None:
        return 0
    if isinstance(val, int):
        return val
    s = str(val).upper().strip()
    if s.isdigit():
        return int(s)
    return _PROTO_NAMES.get(s, 0)


def _conversation_id(src_ip: str, dst_ip: str, src_port: int, dst_port: int, proto: int) -> int:
    """
    Stable UInt64 hash of the normalized 5-tuple.
    Sorting ensures both legs of a conversation produce the same ID.
    Uses MD5 (non-security) for a deterministic 64-bit integer.
    """
    if (src_ip, src_port) <= (dst_ip, dst_port):
        key = f"{src_ip}:{src_port}-{dst_ip}:{dst_port}/{proto}"
    else:
        key = f"{dst_ip}:{dst_port}-{src_ip}:{src_port}/{proto}"
    digest = hashlib.md5(key.encode(), usedforsecurity=False).digest()
    return struct.unpack_from("<Q", digest)[0]  # first 8 bytes → UInt64


def _flow_role(src_port: int, dst_port: int) -> int:
    """
    Classify whether this flow leg is the initiator or responder.
    0=unknown, 1=initiator (ephemeral src → service dst), 2=responder (service src → ephemeral dst)
    Well-known ports: < 1024.  Ephemeral ports: >= 1024.
    """
    src_service = src_port < 1024
    dst_service = dst_port < 1024
    if not src_service and dst_service:
        return 1  # ephemeral → service port: this is the request
    if src_service and not dst_service:
        return 2  # service port → ephemeral: this is the response
    return 0  # both ephemeral or both well-known — ambiguous


def _ip_or_default(val: Any, default: str = "0.0.0.0") -> str:
    """Return IP string, falling back to default for None/empty."""
    if val is None:
        return default
    s = str(val).strip()
    return s if s and s not in ("null", "None") else default


def _ns_to_datetime(ns: int) -> datetime:
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc)


def _sec_to_datetime(sec: Union[int, float]) -> datetime:
    return datetime.fromtimestamp(sec, tz=timezone.utc)


def normalize_goflow2_record(raw: dict[str, Any]) -> Optional[FlowRecord]:
    """
    Normalize a single GoFlow2 JSON object to a FlowRecord.
    Handles both PascalCase and snake_case field names.
    Returns None if the record is malformed or should be skipped.
    """
    try:
        # ── Timestamp ────────────────────────────────────────────────────────
        end_ns = _get(raw, "TimeFlowEndNs", "time_flow_end_ns")
        if end_ns:
            ts = _ns_to_datetime(int(end_ns))
        else:
            received = _get(raw, "TimeReceived", "time_received")
            if received:
                ts = _sec_to_datetime(int(received))
            else:
                ts = datetime.now(tz=timezone.utc)

        # ── Sampler ──────────────────────────────────────────────────────────
        sampler_ip = str(_get(raw, "SamplerAddress", "sampler_address", default="0.0.0.0"))
        if not sampler_ip or sampler_ip in ("", "null", "None"):
            sampler_ip = "0.0.0.0"
        # Reject flows with no valid sampler address — 0.0.0.0 is not a real device
        if sampler_ip == "0.0.0.0":
            return None

        # Site from Vector transform takes priority, then device cache
        site_from_vector = str(_get(raw, "site", default="") or "")
        name, site = _device_cache.get(sampler_ip, ("", site_from_vector))
        if not site:
            site = site_from_vector

        # ── Duration ─────────────────────────────────────────────────────────
        start_ns = _get(raw, "TimeFlowStartNs", "time_flow_start_ns", default=0)
        if not end_ns:
            end_ns = 0
        if start_ns and end_ns and int(end_ns) >= int(start_ns):
            duration_ms = (int(end_ns) - int(start_ns)) // 1_000_000
        else:
            duration_ms = 0

        src_ip  = _ip_or_default(_get(raw, "SrcAddr", "src_addr"))
        dst_ip  = _ip_or_default(_get(raw, "DstAddr", "dst_addr"))
        src_port = int(_get(raw, "SrcPort", "src_port", default=0))
        dst_port = int(_get(raw, "DstPort", "dst_port", default=0))
        protocol = _proto_to_int(_get(raw, "Proto", "proto", default=0))

        return FlowRecord(
            timestamp=ts,
            sampler_ip=sampler_ip,
            sampler_name=name,
            site=site,
            src_ip=src_ip,
            dst_ip=dst_ip,
            src_port=src_port,
            dst_port=dst_port,
            protocol=protocol,
            bytes=int(_get(raw, "Bytes", "bytes", default=0)),
            packets=int(_get(raw, "Packets", "packets", default=0)),
            duration_ms=duration_ms,
            tcp_flags=int(_get(raw, "TCPFlags", "tcp_flags", default=0)),
            tos=int(_get(raw, "IPTos", "ip_tos", default=0)),
            input_if=int(_get(raw, "InIf", "in_if", default=0)),
            output_if=int(_get(raw, "OutIf", "out_if", default=0)),
            next_hop=_ip_or_default(_get(raw, "NextHop", "next_hop")),
            src_as=int(_get(raw, "SrcAS", "src_as", default=0)),
            dst_as=int(_get(raw, "DstAS", "dst_as", default=0)),
            flow_dir=int(_get(raw, "FlowDirection", "flow_direction", default=2)),
            conversation_id=_conversation_id(src_ip, dst_ip, src_port, dst_port, protocol),
            flow_role=_flow_role(src_port, dst_port),
        )
    except Exception as e:
        log.debug(f"Skipping malformed flow record: {e} — {raw}")
        return None


def normalize_batch(raw_records: list[dict[str, Any]]) -> list[FlowRecord]:
    """Normalize a list of raw GoFlow2 records, dropping malformed ones."""
    results = []
    for raw in raw_records:
        record = normalize_goflow2_record(raw)
        if record is not None:
            results.append(record)
    return results
