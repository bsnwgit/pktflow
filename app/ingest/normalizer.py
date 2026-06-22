"""
Flow record normalizer.

Converts raw GoFlow2 JSON (as POSTed by Vector) into a list of FlowRecord objects.
Also enriches each record with sampler_name and site from the device registry.

GoFlow2 JSON field reference (subset we care about):
  Type           – "NETFLOW_V9", "NETFLOW_V5", "IPFIX", "SFLOW_5"
  TimeFlowEndNs  – flow end time (nanoseconds epoch)  ← primary
  TimeReceived   – packet receive time (seconds epoch) ← fallback
  SamplerAddress – IP of the exporter
  SrcAddr        – source IP
  DstAddr        – destination IP
  SrcPort        – source port
  DstPort        – destination port
  Proto          – IP protocol
  Bytes          – byte count
  Packets        – packet count
  TimeFlowStartNs – flow start time (ns)
  TCPFlags       – TCP flags byte
  IPTos          – DSCP/TOS
  InIf, OutIf    – interface indices
  NextHop        – next-hop IP
  SrcAS, DstAS   – BGP ASNs
  FlowDirection  – 0=ingress, 1=egress
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


def _ns_to_datetime(ns: int) -> datetime:
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc)


def _sec_to_datetime(sec: Union[int, float]) -> datetime:
    return datetime.fromtimestamp(sec, tz=timezone.utc)


def normalize_goflow2_record(raw: dict[str, Any]) -> Optional[FlowRecord]:
    """
    Normalize a single GoFlow2 JSON object to a FlowRecord.
    Returns None if the record is malformed or should be skipped.
    """
    try:
        # ── Timestamp ────────────────────────────────────────────────────────
        if raw.get("TimeFlowEndNs"):
            ts = _ns_to_datetime(int(raw["TimeFlowEndNs"]))
        elif raw.get("TimeReceived"):
            ts = _sec_to_datetime(int(raw["TimeReceived"]))
        else:
            ts = datetime.now(tz=timezone.utc)

        # ── Sampler ──────────────────────────────────────────────────────────
        sampler_ip = raw.get("SamplerAddress", "0.0.0.0")
        name, site = _device_cache.get(sampler_ip, ("", ""))

        # ── Duration ─────────────────────────────────────────────────────────
        start_ns = raw.get("TimeFlowStartNs", 0)
        end_ns   = raw.get("TimeFlowEndNs", 0)
        if start_ns and end_ns and end_ns >= start_ns:
            duration_ms = (end_ns - start_ns) // 1_000_000
        else:
            duration_ms = 0

        return FlowRecord(
            timestamp=ts,
            sampler_ip=sampler_ip,
            sampler_name=name,
            site=site,
            src_ip=raw.get("SrcAddr", "0.0.0.0"),
            dst_ip=raw.get("DstAddr", "0.0.0.0"),
            src_port=int(raw.get("SrcPort", 0)),
            dst_port=int(raw.get("DstPort", 0)),
            protocol=int(raw.get("Proto", 0)),
            bytes=int(raw.get("Bytes", 0)),
            packets=int(raw.get("Packets", 0)),
            duration_ms=duration_ms,
            tcp_flags=int(raw.get("TCPFlags", 0)),
            tos=int(raw.get("IPTos", 0)),
            input_if=int(raw.get("InIf", 0)),
            output_if=int(raw.get("OutIf", 0)),
            next_hop=raw.get("NextHop", "0.0.0.0"),
            src_as=int(raw.get("SrcAS", 0)),
            dst_as=int(raw.get("DstAS", 0)),
            flow_dir=int(raw.get("FlowDirection", 2)),
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
