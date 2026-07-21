"""
Shared post-processing for get_topology, used by both storage backends.
"""
from __future__ import annotations

from app.models.flow import TopologyEdge


def _dominant_per_pair(rows: list[tuple[str, str, str, int]]) -> dict[tuple[str, str], list[tuple[str, int]]]:
    """Group (ip_a, ip_b, value, weight_bytes) rows by normalized pair, keeping
    every (value, weight) candidate so callers can pick a max or apply a
    coverage threshold."""
    by_pair: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for ip_a, ip_b, value, weight in rows:
        key = (ip_a, ip_b) if ip_a < ip_b else (ip_b, ip_a)
        by_pair.setdefault(key, []).append((value, weight))
    return by_pair


def attach_dominant_sampler(
    edges: list[TopologyEdge],
    sampler_attrib_rows: list[tuple[str, str, str, int]],
) -> list[TopologyEdge]:
    """
    sampler_attrib_rows: (ip_a, ip_b, sampler_ip, bytes) from a secondary
    GROUP BY ip_a, ip_b, sampler_ip query — which exporter(s) reported each
    pair's traffic, and how much. Tags each edge with the sampler that
    contributed the most bytes, so the hierarchy can anchor conversation
    clusters under the vantage point that actually observed them instead of
    relying on incidental graph connectivity (most conversations never touch
    the sampler's own IP as a src/dst endpoint).
    """
    by_pair = _dominant_per_pair(sampler_attrib_rows)
    result: list[TopologyEdge] = []
    for e in edges:
        key = (e.source, e.target) if e.source < e.target else (e.target, e.source)
        candidates = by_pair.get(key)
        if candidates:
            dominant_sampler, _ = max(candidates, key=lambda c: c[1])
            result.append(e.model_copy(update={"sampler_ip": dominant_sampler}))
        else:
            result.append(e)
    return result
