# pktFlow — NetFlow Volume Analysis & Storage Recommendation

**Date:** 2026-06-22  
**Source data:** Live O2 API + GoFlow2 Prometheus metrics from both collectors

---

## Current Infrastructure Summary

| Stream | O2 Doc Count | Disk (O2 compressed) | Samplers |
|--------|-------------|----------------------|----------|
| medical_netflow | 1,099,760,691 (~1.1B) | 40 GB | 172.27.28.88/89, 192.168.44.7/8 |
| dental_netflow | 501,657,963 (~502M) | 16 GB | 10.19.56.186, 10.19.81.236 |
| **Combined** | **~1.6 billion** | **56 GB** | 6 samplers total |

O2 has 180-day data retention. The 56 GB covers that full retention window.

---

## Flow Rate Calculation

GoFlow2 Prometheus metrics give us exact cumulative counters since the services last restarted (**2026-06-05 16:35 UTC** — 17 days ago).

### Medical Collector (172.23.80.11)

| Sampler | DataFlowSet Records |
|---------|-------------------|
| 192.168.44.7 (OneNeck) | 164,318,245 |
| 172.27.28.89 (QTS) | 52,920,287 |
| **Total (17 days)** | **217,238,532** |

- **Daily rate:** 217,238,532 / 17 = **~12.8 million flows/day**
- **Per second:** 12,800,000 / 86,400 = **~148 flows/sec**

### Dental Collector (10.56.57.181)

| Sampler | DataFlowSet Records |
|---------|-------------------|
| 10.19.81.236 | 50,977,499 |
| 10.19.56.186 | 41,996,633 |
| **Total (17 days)** | **92,974,132** |

- **Daily rate:** 92,974,132 / 17 = **~5.5 million flows/day**
- **Per second:** 5,500,000 / 86,400 = **~63 flows/sec**

### Combined

| Metric | Value |
|--------|-------|
| Total flows/day | ~18.3 million |
| Sustained ingest rate | **~211 flows/sec** |
| O2 storage rate (compressed) | ~641 MB/day |
| Estimated raw record size | ~200–350 bytes/record |

---

## Storage Projection for pktFlow

With 90-day retention (recommended default for pktFlow):

| Backend | Estimated Storage |
|---------|------------------|
| 30 days | ~19 GB compressed |
| 90 days | ~58 GB compressed |
| 180 days | ~115 GB compressed |

Note: columnar stores (ClickHouse, DuckDB) will achieve similar or better compression than O2's JSON storage.

---

## Storage Backend Recommendation

### Verdict: **ClickHouse** (recommended default)

**Why ClickHouse wins at this volume:**

At 211 flows/sec (~18M/day), this sits exactly in ClickHouse's design sweet spot:
- **Insert throughput:** ClickHouse handles millions of rows/sec; 211/sec is trivial — it will batch-buffer automatically
- **Query speed:** Sub-second aggregations on billions of rows (top talkers, per-device views, time-range filters) — no other option comes close at this scale
- **Compression:** Columnar storage with LZ4 typically achieves 10–20:1 on structured network data (5x better than O2's JSON-based storage)
- **NetFlow schema fit:** Append-only, time-series, rarely updated — exactly what ClickHouse is optimized for
- **Projected storage with 90-day retention:** ~19–30 GB (after columnar compression)
- **Operational:** Runs as a single process, reasonable memory footprint for a dedicated app on this EC2

**Why not the alternatives:**

| Option | Issue |
|--------|-------|
| DuckDB | Excellent for analytics but not built for concurrent real-time ingest + reads. No server mode — one writer at a time. Good secondary option for lower-traffic deployments. |
| SQLite | Row-based; will bog down past ~50M records; no concurrent writes. Not suitable. |
| PostgreSQL + TimescaleDB | Would work but row-based storage means 5–10x larger footprint. Requires more tuning. Overkill complexity for what TimescaleDB adds. |

---

## Settings Page Design (Ingest + Storage)

Both settings should live in pktFlow's Settings → Data Sources page, with the defaults below pre-selected on fresh install.

### Storage Backend (Settings)

| Option | Best For | Default? |
|--------|----------|---------|
| ClickHouse | Production, high volume, fast queries | ✅ Recommended |
| DuckDB | Dev/test, single-user, low traffic | — |
| SQLite | Minimal footprint, very small deployments | — |

### Ingest Method (Settings)

**Recommendation: HTTP POST (recommended default) — Direct UDP as alternate**

| Method | Pros | Cons |
|--------|------|------|
| **HTTP POST** | Zero changes to existing Vector→O2 pipeline; swap URL only; battle-tested; easier firewall rules; built-in auth/TLS support | Adds Vector as a dependency (already present) |
| **Direct UDP NetFlow** | Eliminates Vector; lower latency; simpler end-to-end | Requires network device reconfiguration to change export targets; more complex connection handling in Python; no built-in retry/buffering |

**For initial pktFlow deployment**, HTTP POST is the correct default:
- Collectors already run Vector; migration is a 1-line URL change in `vector.toml`
- No firewall rule changes needed (same EC2, same direction)
- Can add pktFlow as a second sink in Vector alongside O2 for zero-downtime migration testing
- Direct UDP becomes valuable later if you want to eliminate Vector from the stack entirely

---

## Sampler Inventory (for allowed-hosts settings)

These are the actual NetFlow exporters sending data today:

| IP | Site | Collector |
|----|------|-----------|
| 192.168.44.7 | OneNeck | Medical |
| 192.168.44.8 | OneNeck | Medical |
| 172.27.28.88 | QTS | Medical |
| 172.27.28.89 | QTS | Medical |
| 10.19.56.186 | AWS | Dental |
| 10.19.81.236 | AWS | Dental |

---

## Additional Observations

**O2 Process:** OpenObserve is consuming **3.1 GB RAM** (39.1% of 7.5 GB total) and has been running for 18 days — pktFlow needs to be lightweight enough to coexist. ClickHouse default memory can be capped in config.

**Medical template errors:** Sporadic `template_not_found` warnings on 172.27.28.89 and 192.168.44.7. These are not failures — NetFlow v9 template packets occasionally arrive after data packets on restart; GoFlow2 drops and recovers. pktFlow should handle this the same way.

**Dental Vector connection errors:** Recurring `connection closed before message completed` retries to O2. Vector retries successfully, no data loss. Worth monitoring — may indicate O2 TCP keepalive tuning issue. pktFlow's HTTP ingest endpoint should use persistent connections and proper keepalive headers.

**Netflow org in O2:** There is an empty `netflow` organization in O2 with two zero-doc streams (`datacenter_oneneck`, `datacenter_qts`). These appear to be unused/abandoned test streams. Not relevant to pktFlow.
