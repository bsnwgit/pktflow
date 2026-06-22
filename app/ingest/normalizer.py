"""
Flow record normalizer.

Converts raw GoFlow2 JSON (as POSTed by Vector) into a list of FlowRecord objects.
Also enriches each record with sampler_name and site from the device registry.

GoFlow2 field reference — handles BOTH output formats:
  PascalCase (protobuf-JSON):  SamplerAddress, SrcAddr, DstAddr, Bytes, Packets ...
  snake_case (newer/VRL):      sampler_address, src_addr, dst_addr, bytes, packets ...
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional, Union

from app.models.flow import FlowRecord

log = logging.getLogger("pktflow.ingest.normalizer")

# Cache of sampler_ip → (name, site) — populated from device registry
_device_cache: dict[str, tuple[str, str]] = {}


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

        return FlowRecord(
            timestamp=ts,
            sampler_ip=sampler_ip,
            sampler_name=name,
            site=site,
            src_ip=str(_get(raw, "SrcAddr", "src_addr", default="0.0.0.0")),
            dst_ip=str(_get(raw, "DstAddr", "dst_addr", default="0.0.0.0")),
            src_port=int(_get(raw, "SrcPort", "src_port", default=0)),
            dst_port=int(_get(raw, "DstPort", "dst_port", default=0)),
            protocol=int(_get(raw, "Proto", "proto", default=0)),
            bytes=int(_get(raw, "Bytes", "bytes", default=0)),
            packets=int(_get(raw, "Packets", "packets", default=0)),
            duration_ms=duration_ms,
            tcp_flags=int(_get(raw, "TCPFlags", "tcp_flags", default=0)),
            tos=int(_get(raw, "IPTos", "ip_tos", default=0)),
            input_if=int(_get(raw, "InIf", "in_if", default=0)),
            output_if=int(_get(raw, "OutIf", "out_if", default=0)),
            next_hop=str(_get(raw, "NextHop", "next_hop", default="0.0.0.0")),
            src_as=int(_get(raw, "SrcAS", "src_as", default=0)),
            dst_as=int(_get(raw, "DstAS", "dst_as", default=0)),
            flow_dir=int(_get(raw, "FlowDirection", "flow_direction", default=2)),
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
