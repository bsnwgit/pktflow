# NetFlow Data Pipeline — Complete Reference

This document maps the full end-to-end data path from router to dashboard, covering both supported ingest modes. All examples use generic placeholder values — substitute your own IPs, tokens, and site names.

**Placeholder key:**

| Placeholder | Meaning |
|---|---|
| `<ROUTER_IP>` | IP of the network device exporting NetFlow |
| `<COLLECTOR_IP>` | IP of the remote collector host (goflow2 + Vector) |
| `<APP_SERVER_IP>` | IP of the server running pktFlow + ClickHouse |
| `<APP_PORT>` | pktFlow HTTP port (e.g. `8766`) |
| `<INGEST_TOKEN>` | Bearer token from pktFlow Settings → Ingest |
| `<SITE_NAME>` | Logical site label (e.g. `datacenter-a`, `office-b`) |

---

## Ingest Modes Overview

pktFlow supports two ingest paths:

```
Mode 1 — Remote Collector Pipeline (recommended, production-proven)
  Router → UDP NetFlow → Remote Collector Host
                              │  goflow2 decodes → JSON
                              │  Vector transforms → HTTP POST
                              ▼
                         pktFlow /api/ingest/flows
                              │
                         ClickHouse

Mode 2 — Direct UDP (built-in, off by default)
  Router → UDP NetFlow → pktFlow UDP Listener (built-in)
                              │
                         ClickHouse
```

Mode 1 is the recommended path because goflow2 handles the complex NetFlow v9/IPFIX template negotiation and protocol decoding. Mode 2 is simpler to deploy but requires the pktFlow server to be reachable by UDP from routers.

---

## Mode 1 — Remote Collector Pipeline

### Software Stack on the Collector Host

**goflow2** — NetFlow decoder  
- GitHub: https://github.com/netsampler/goflow2  
- Role: Listens on UDP, decodes NetFlow v5/v9/IPFIX/sFlow, emits one JSON object per flow to stdout  
- Stateful: caches NetFlow v9 templates between packets; loses template cache on restart (routers resend templates within seconds)  
- Output format: PascalCase JSON (protobuf-style field names)  
- No config file — configured entirely via command-line flags

**Vector** — data pipeline / agent  
- Website: https://vector.dev  
- Role: Reads goflow2 JSON from stdin (or via exec), applies transforms, batches records, POSTs JSON arrays to pktFlow  
- Config file: `vector.toml` (TOML format)  
- Handles retries with exponential backoff — if pktFlow is unreachable, Vector queues and retries automatically

**Systemd** — process supervision  
- Both goflow2 and Vector run as a single piped command under one systemd unit (`goflow2-vector.service`)

---

### How the Pipe Works

The systemd unit runs this command:

```bash
/bin/bash -c "/path/to/goflow2 -format json -listen netflow://<COLLECTOR_IP>:2055 | \
              /path/to/vector --config /path/to/vector.toml"
```

goflow2 writes one JSON object per line to stdout. That stdout is piped directly into Vector's stdin. Vector reads lines, parses them, transforms the fields, and batches them into HTTP POST requests to pktFlow.

**Stdin vs exec source type:**  
The stdin pipe works when systemd allows stdin to be inherited by the process. On some systemd configurations, `stdin=/dev/null` is set (for security hardening), which silently breaks the pipe — Vector gets nothing. In that case, use Vector's `exec` source type instead, which runs goflow2 as a subprocess:

```toml
[sources.goflow2]
type = "exec"
mode = "streaming"
command = ["/path/to/goflow2", "-format", "json", "-listen", "netflow://<COLLECTOR_IP>:2055"]
```

This is equivalent behavior — use `stdin` when you control the systemd unit and it doesn't set `stdin=/dev/null`; use `exec` otherwise.

---

### goflow2 Command Flags

```bash
goflow2 \
  -format json \                    # Output format: "json" (one object per line)
  -listen netflow://<COLLECTOR_IP>:2055 \  # Protocol + bind address + port
  -addr :8080                       # Optional: HTTP health/metrics endpoint
```

**Supported listen schemes:** `netflow://` (v5/v9/IPFIX), `sflow://`, `nflegacy://` (v5 only)  
**Default NetFlow port:** UDP 2055  
**Default sFlow port:** UDP 6343

goflow2 logs template errors on restart — this is normal. NetFlow v9 routers send template packets periodically (and immediately on request). goflow2 will silently discard data flows until it receives the matching template. Recovery is automatic within seconds.

---

### goflow2 Raw Output Format (PascalCase)

goflow2 emits JSON with PascalCase field names (protobuf-JSON convention):

```json
{
  "Type": "NETFLOW_V9",
  "TimeReceived": 1750686005,
  "SamplerAddress": "192.0.2.1",
  "SrcAddr": "10.1.2.3",
  "DstAddr": "203.0.113.5",
  "SrcPort": 54321,
  "DstPort": 443,
  "Proto": 17,
  "Bytes": 1500,
  "Packets": 10,
  "InIf": 6,
  "OutIf": 7,
  "IPTos": 0,
  "TCPFlags": 0,
  "SrcAS": 0,
  "DstAS": 0,
  "NextHop": "0.0.0.0",
  "TimeFlowStartNs": 1750686000000000000,
  "TimeFlowEndNs": 1750686005000000000,
  "TimeReceivedNs": 1750686005599594040
}
```

Key points:
- `Proto` is an **integer** (IANA protocol number: 6=TCP, 17=UDP, 1=ICMP, etc.)
- `SamplerAddress` is the IP of the router that exported the flow
- `NextHop` is `"0.0.0.0"` when no next hop is set
- Timestamps are in nanoseconds since epoch for `*Ns` fields, seconds for `TimeReceived`

---

### Vector Configuration — vector.toml

Vector reads from goflow2's output, transforms the data, and forwards to pktFlow. The full annotated config:

```toml
# ── Source ────────────────────────────────────────────────────────────────────
# Read goflow2 JSON lines from stdin (when piped from goflow2)
[sources.goflow2_stdin]
type = "stdin"

# If using exec source instead of stdin pipe, replace with:
# [sources.goflow2_stdin]
# type = "exec"
# mode = "streaming"
# command = ["/path/to/goflow2", "-format", "json", "-listen", "netflow://<COLLECTOR_IP>:2055"]

# ── Transform 1: parse the JSON string ────────────────────────────────────────
# goflow2 writes one JSON object per line. Vector's stdin source wraps each line
# in an envelope with a .message field. This transform parses .message as JSON,
# promoting all goflow2 fields to the top level of the event.
[transforms.parse_json]
type = "remap"
inputs = ["goflow2_stdin"]
source = '''
  . = parse_json!(.message)
'''

# ── Transform 2: add site metadata ───────────────────────────────────────────
# Enrich each flow with a site label and normalize the sampler address field.
# The sampler_address field is already populated by goflow2 as SamplerAddress —
# this just adds a human-readable site tag based on the sampler IP.
[transforms.add_site]
type = "remap"
inputs = ["parse_json"]
source = '''
  # Normalize field name (goflow2 uses SamplerAddress, we want sampler_address)
  .sampler_address = .SamplerAddress
  
  # Tag with site name based on sampler IP
  .site = if .SamplerAddress == "<ROUTER_IP_1>" || .SamplerAddress == "<ROUTER_IP_2>" {
    "<SITE_NAME_A>"
  } else if .SamplerAddress == "<ROUTER_IP_3>" {
    "<SITE_NAME_B>"
  } else {
    "unknown"
  }
'''

# ── Sink: POST to pktFlow ─────────────────────────────────────────────────────
[sinks.pktflow]
type = "http"
inputs = ["add_site"]
uri = "http://<APP_SERVER_IP>:<APP_PORT>/api/ingest/flows"
encoding.codec = "json"               # Send as JSON array
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN>"
request.timeout_secs = 10
healthcheck.enabled = false           # Disable — pktFlow has no /health healthcheck path by default
```

**Vector retry behavior:** On connection failure, Vector uses exponential backoff (doubles each retry, caps around 512s). A pktFlow restart (connection reset) counts as a connection event and triggers an immediate reconnect — so flows typically resume within seconds of pktFlow restarting.

**Running multiple sinks:** During migration or validation, you can add a second sink pointing at a previous system (e.g., OpenObserve, Elasticsearch) alongside the pktFlow sink. Both receive the same transformed data. Remove the old sink once pktFlow is validated.

---

### Vector Output Format — What pktFlow Receives

After Vector transforms the data, the JSON sent to pktFlow differs from goflow2's raw output in important ways:

```json
{
  "src_addr": "10.1.2.3",
  "dst_addr": "203.0.113.5",
  "src_port": 54321,
  "dst_port": 443,
  "proto": "UDP",
  "bytes": 1500,
  "packets": 10,
  "in_if": 6,
  "out_if": 7,
  "ip_tos": 0,
  "tcp_flags": 0,
  "src_as": 0,
  "dst_as": 0,
  "next_hop": "",
  "sampler_address": "192.0.2.1",
  "time_flow_start_ns": 1750686000000000000,
  "time_flow_end_ns": 1750686005000000000,
  "time_received_ns": 1750686005599594040,
  "site": "<SITE_NAME_A>",
  "type": "NETFLOW_V9",
  "message": "{...original goflow2 json string...}",
  "timestamp": "2026-06-23T13:26:37.603992262Z",
  "host": "<COLLECTOR_HOSTNAME>",
  "source_type": "stdin"
}
```

**Critical differences from goflow2 raw format:**

| Field | goflow2 raw | After Vector |
|---|---|---|
| Field naming | `PascalCase` (`SrcAddr`) | `snake_case` (`src_addr`) |
| `proto` | Integer (`17`) | String (`"UDP"`) |
| `next_hop` | `"0.0.0.0"` | Empty string `""` |
| `sampler_address` | `SamplerAddress` (PascalCase) | `sampler_address` (snake_case) |
| `site` | Not present | Added by Vector transform |
| Extra fields | None | `message`, `timestamp`, `host`, `source_type` |

Vector's `remap` VRL transform lowercases and snake_cases field names automatically when it parses the JSON via `parse_json!()`. The `proto` field becomes a string representation of the protocol name. The `next_hop` field collapses `"0.0.0.0"` to `""`.

---

### Systemd Unit — goflow2-vector.service

```ini
[Unit]
Description=GoFlow2 + Vector NetFlow Collector
After=network.target

[Service]
Type=simple
User=<SERVICE_USER>
ExecStart=/bin/bash -c "/path/to/goflow2 \
    -format json \
    -listen netflow://<COLLECTOR_IP>:2055 \
    -addr :8080 \
  | /path/to/vector --config /path/to/vector.toml"
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/goflow2-vector.log
StandardError=append:/var/log/goflow2-vector.log

[Install]
WantedBy=multi-user.target
```

**Note on stdin:** The pipe `|` only works for Vector's `stdin` source if systemd does not redirect stdin to `/dev/null`. Some hardened unit templates include `StandardInput=null` — if yours does, switch to the `exec` source type (shown above).

---

### pktFlow Ingest Endpoint

```
POST /api/ingest/flows
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

[ { ...flow record... }, { ...flow record... } ]
```

Vector sends a JSON array per batch. pktFlow:
1. Validates the bearer token
2. Calls `normalize_batch()` on the array
3. Passes normalized `FlowRecord` objects to `IngestBuffer`
4. `IngestBuffer` flushes to ClickHouse every 1,000 records or 2 seconds, whichever comes first

**Stats endpoint** (no auth required):
```
GET /api/ingest/stats
```
```json
{
  "buffered": 0,
  "total_received": 12048,
  "total_flushed": 12048,
  "last_flush": "2026-06-23T13:28:44Z"
}
```

`total_received` increments only when `normalize_batch()` returns at least one valid record. If Vector is POSTing (visible in access logs) but `total_received` stays at 0, the normalizer is silently dropping records — check for missing/malformed `sampler_address` fields.

---

### Normalizer — Field Handling

The normalizer (`app/ingest/normalizer.py`) handles both field name conventions (PascalCase from goflow2 direct, snake_case from Vector) using a multi-key lookup:

```python
_get(raw, "SrcAddr", "src_addr")  # tries PascalCase first, then snake_case
```

**Protocol handling:**  
`_proto_to_int()` converts any of these to an IANA integer:
- Integer already: pass through (`17` → `17`)
- Numeric string: parse (`"17"` → `17`)
- Protocol name string: lookup (`"UDP"` → `17`, `"TCP"` → `6`)

**IP handling:**  
`_ip_or_default()` normalizes edge cases:
- Empty string → `"0.0.0.0"`
- `"null"` / `None` → `"0.0.0.0"`
- Empty `next_hop` from Vector → `"0.0.0.0"` (stored as IPv4 null)

**Sampler validation:**  
Records with `sampler_address == "0.0.0.0"` (unresolvable) are dropped entirely — they have no useful attribution.

**Site enrichment:**  
The `site` field is resolved in priority order:
1. Vector transform's `.site` field (most specific — already resolved per-sampler-IP)
2. Device registry cache (keyed by sampler IP)
3. Empty string fallback

---

### ClickHouse Storage

pktFlow writes normalized flows to ClickHouse. The `clickhouse-driver` Python client is not thread-safe — all calls are serialized through a `threading.Lock()` in `app/storage/clickhouse.py` to prevent `PartiallyConsumedQueryError` under concurrent asyncio load.

**Schema (abbreviated):**
```sql
CREATE TABLE flows (
    timestamp    DateTime64(3),
    sampler_ip   IPv4,
    sampler_name LowCardinality(String),
    site         LowCardinality(String),
    src_ip       IPv4,
    dst_ip       IPv4,
    src_port     UInt16,
    dst_port     UInt16,
    protocol     UInt8,
    bytes        UInt64,
    packets      UInt64,
    duration_ms  UInt32,
    tcp_flags    UInt8,
    input_if     UInt32,
    output_if    UInt32,
    next_hop     IPv4,
    src_as       UInt32,
    dst_as       UInt32,
    flow_dir     UInt8        -- 0=ingress, 1=egress, 2=unknown
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (sampler_ip, timestamp, src_ip, dst_ip)
TTL timestamp + INTERVAL 90 DAY;
```

ClickHouse connects on `localhost:9000` (native binary protocol). It should be bound to localhost only — not exposed externally.

---

## Mode 2 — Direct UDP Ingest

pktFlow has a built-in UDP listener (`app/ingest/udp_listener.py`) that handles NetFlow v5/v9/IPFIX and sFlow directly, bypassing goflow2 and Vector entirely. This path is off by default and enabled via Settings → Ingest.

```
Router → UDP:2055 → pktFlow UDP Listener (asyncio)
                         │
                    normalize → FlowRecord
                         │
                    IngestBuffer → ClickHouse
```

**When to use direct UDP:**
- Simpler infrastructure (no separate collector host needed)
- Low-to-moderate flow volume (no external buffering/retry like Vector)
- Dev/test environments

**When to use remote collector (Mode 1):**
- High flow volume requiring buffering and retry on the collector
- Multiple source sites funneled through a dedicated collector
- Existing goflow2 + Vector infrastructure already in place

Direct UDP bypasses Vector's transformation, so the normalizer receives goflow2's PascalCase format when this path is used. The normalizer handles both conventions identically via the multi-key `_get()` pattern.

---

## Complete Data Flow — Field Transformation Summary

```
Router
  └─ UDP NetFlow v9 packet
       SamplerAddress: 192.0.2.1
       SrcAddr: 10.1.2.3
       DstAddr: 203.0.113.5
       Proto: 17 (integer)
       NextHop: 0.0.0.0

goflow2 (decoder)
  └─ PascalCase JSON per flow
       SamplerAddress: "192.0.2.1"
       SrcAddr: "10.1.2.3"
       DstAddr: "203.0.113.5"
       Proto: 17
       NextHop: "0.0.0.0"

Vector (transformer)
  └─ snake_case JSON array
       sampler_address: "192.0.2.1"
       src_addr: "10.1.2.3"
       dst_addr: "203.0.113.5"
       proto: "UDP"          ← string, not integer
       next_hop: ""          ← empty, not "0.0.0.0"
       site: "site-a"        ← added by transform

pktFlow normalizer
  └─ FlowRecord (internal schema)
       sampler_ip: "192.0.2.1"
       src_ip: "10.1.2.3"
       dst_ip: "203.0.113.5"
       protocol: 17          ← back to integer
       next_hop: "0.0.0.0"   ← empty string → default IP
       site: "site-a"

ClickHouse flows table
  └─ Columnar storage, 90-day TTL default
```

---

## Troubleshooting

**Flows arriving at Vector but not stored in ClickHouse:**  
Check `GET /api/ingest/stats` — if `total_received` is 0 while the access log shows POSTs, the normalizer is dropping everything. Most common cause: `sampler_address` is `0.0.0.0` or missing. Verify the Vector `add_site` transform correctly sets `.sampler_address`.

**goflow2 logging "template error":**  
Normal after restart. NetFlow v9/IPFIX require the router to send template packets before data packets. These arrive automatically within seconds. No action needed.

**Vector not sending after pktFlow restarts:**  
Vector uses exponential backoff. Multiple pktFlow restarts in quick succession can push the retry interval up to ~512 seconds. A pktFlow restart (TCP connection reset) triggers an immediate retry, so flows typically resume within seconds. If they don't, restart Vector.

**npm build output contains Unicode characters:**  
Vite's build output contains Unicode box-drawing characters. When scripting a build, redirect stdout to avoid encoding errors: `npm run build > /dev/null 2>&1 && echo 'build ok' || echo 'BUILD FAILED'`.
