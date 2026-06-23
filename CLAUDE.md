# pktFlow — Project Context for Claude

This file is the ground truth for working in this project. Read it before doing anything.

---

## What This Is

pktFlow is a production NetFlow visualization and alerting platform deployed on the Corp Infrastructure O2 server. It receives live NetFlow data from two collectors, stores it in ClickHouse, and serves a React dashboard.

**Live URL:** http://10.20.30.5:8080  
**Git remote:** GitHub + GitLab (both configured)  
**Active branch:** `feature/initial-build`

---

## Infrastructure

| Role | IP | User | SSH Key |
|------|----|------|---------|
| O2 Server (pktFlow + ClickHouse) | 10.20.30.5 | ec2-user | `C:\Users\user\.ssh\corporate_infrastructure.pem` |
| Medical Collector | 10.20.30.11 | ec2-user | `C:\Users\user\.ssh\corporate_infrastructure.pem` |
| Dental Collector | 10.20.30.181 | ec2-user | `C:\Users\user\.ssh\corporate_infrastructure.pem` |

**pktFlow on O2:**
- Service: `systemctl status pktflow`
- App dir: `/mnt/software/pktflow`
- Venv: `/mnt/software/pktflow/venv`
- Config: `/mnt/software/pktflow/config.yaml`
- Port: **8080** (not 8000 — do not confuse)
- Systemd: `/etc/systemd/system/pktflow.service`
- ClickHouse: localhost:9000, database `pktflow`, user `default`, no password
- ClickHouse version: 26.5.3.52 on Amazon Linux 2023

---

## SSH Rules — CRITICAL

**SentinelOne EDR blocks system ssh.exe.** Always use Python + Paramiko.

- Python path: `C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe`
- **ONE script, ONE run, NO retry loops** — hammering the connection locks the server and requires a reboot
- `timeout=15, banner_timeout=15` on every connect call
- Run scripts via Desktop Commander `start_process`, not the bash sandbox

```python
import paramiko
key = paramiko.RSAKey.from_private_key_file(r"C:\Users\user\.ssh\corporate_infrastructure.pem")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("10.20.30.5", username="ec2-user", pkey=key, timeout=15, banner_timeout=15)
_, stdout, _ = client.exec_command("your command", timeout=20)
print(stdout.read().decode())
client.close()
```

---

## Data Flow — Exactly How Traffic Moves

```
Routers (172.27.28.89/Site-A, 192.168.44.7/Site-B)
    │  NetFlow v9 UDP
    ▼
Medical Collector (10.20.30.11:2055)
    │  goflow2 decodes NetFlow v9 → JSON to stdout
    │  piped directly to vector stdin
    ▼
Vector (same host, stdin source)
    │  Transforms data:
    │    1. parse_json — parses goflow2 JSON string from .message field
    │    2. add_site — adds .site and .sampler_address fields
    │  Batches events → HTTP POST JSON array
    ▼
pktFlow ingest (10.20.30.5:8080/api/ingest/flows)
    │  normalize_batch() → FlowRecord objects
    │  IngestBuffer → flushes to ClickHouse
    ▼
ClickHouse (localhost:9000, pktflow.flows table)
    ▼
Dashboard browser queries /api/flows/* → returns data
```

---

## Vector Output Format — CRITICAL

Vector transforms the goflow2 data before sending to pktFlow. **The format reaching pktFlow is NOT goflow2's raw output.**

Vector sends a JSON array of events. Each event has:

```json
{
  "src_addr": "10.1.2.3",
  "dst_addr": "8.8.8.8",
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
  "sampler_address": "192.168.44.7",
  "time_flow_start_ns": 1750686000000000000,
  "time_flow_end_ns": 1750686005000000000,
  "time_received_ns": 1750686005599594040,
  "site": "Site-B",
  "type": "NETFLOW_V9",
  "message": "{...original goflow2 json string...}",
  "timestamp": "2026-06-23T13:26:37.603992262Z",
  "host": "internal-ip.example.com",
  "source_type": "stdin"
}
```

**Key differences from goflow2 raw format:**
- All field names are **snake_case** (`src_addr` not `SrcAddr`)
- `proto` is a **string** (`"UDP"`, `"TCP"`) not an integer
- `next_hop` is an **empty string** `""` not `"0.0.0.0"` when no next hop
- `sampler_address` is already a lowercase string (correctly populated)
- `site` is set to `"Site-B"`, `"Site-A"`, or `"unknown"` by the vector add_site transform
- Extra vector metadata fields: `message`, `timestamp`, `host`, `source_type`

The normalizer (`app/ingest/normalizer.py`) handles all of this via `_proto_to_int()` and `_ip_or_default()`.

---

## Collector Services

### Medical Collector (10.20.30.11)
- Service: `goflow2-vector`
- Command: `/bin/bash -c "/mnt/software/goflow2/goflow2 -format json -listen netflow://10.20.30.11:2055 -addr :8080 | /mnt/software/vector/vector --config /mnt/software/vector/vector.toml"`
- Log: `/mnt/software/logs/goflow2_netflow_all.log`
- Config: `/mnt/software/vector/vector.toml`
- Samplers: `192.168.44.7/8` (Site-B), `172.27.28.89/88` (Site-A)
- Ingest rate: ~148 flows/sec

### Dental Collector (10.20.30.181)
- Same structure as medical
- Samplers: `10.19.56.186`, `10.19.81.236` (aws)
- Uses `exec` source type (NOT stdin) due to systemd stdin=/dev/null issue

---

## ClickHouse Backend — Threading Fix

The `clickhouse-driver` Client is **not thread-safe**. Multiple concurrent `asyncio.to_thread()` calls sharing one client cause `PartiallyConsumedQueryError`.

Fix is in `app/storage/clickhouse.py`: a `threading.Lock()` serializes all ClickHouse calls.

```python
self._lock = threading.Lock()

def _execute(self, query, params=None, data=None):
    with self._lock:
        for attempt in range(2):
            try:
                ...
            except Exception as e:
                # reconnect and retry once
```

---

## Frontend Build

**Never build the frontend in the project folder on Windows** — `node_modules` there is Windows-only and lacks the Linux `rollup` native binary.

Always build in Linux `/tmp`:
```bash
cp -r /path/to/frontend /tmp/frontend-build
cd /tmp/frontend-build
npm install
npm run build
cp -r dist /mnt/software/pktflow/frontend/
```

---

## Deployment Process

To deploy backend changes to O2:
1. Write/edit local file in `C:\Users\user\My Drive\Documents\Claude\Projects\pktFlow\`
2. SFTP the changed file(s) to `/mnt/software/pktflow/` on O2 (same relative path)
3. `sudo systemctl restart pktflow`
4. Wait 4 seconds, check `systemctl is-active pktflow`
5. Check `curl -s http://localhost:8080/api/ingest/stats`

**After pktFlow restarts**, vector may have exponential backoff from prior connection resets — it can take up to ~512s before vector sends again. The restart itself triggers an immediate retry in vector (connection reset = immediate reconnect), so usually flows resume within seconds.

---

## Ingest Stats Endpoint

```
GET http://10.20.30.5:8080/api/ingest/stats
```

Returns:
```json
{
  "buffered": 0,
  "total_received": 2046,
  "total_flushed": 2046,
  "last_flush": "2026-06-23T13:28:44Z"
}
```

`total_received` only increments when `normalize_batch()` returns a non-empty list. If it stays 0 while vector is sending (check access log), normalization is silently dropping records.

---

## Ingest Token

`K6l1j0Y3eyKmS8Uzn5d_Ak4ofbnzSawF7XprlajgoPU`

Used in vector.toml `auth.token` and in curl test commands.

---

## Incomplete Features

See `INCOMPLETE_FEATURES.md` for the full breakdown. Key gaps a new session must know:

- **Alert rule types `threshold`, `rate_spike`, `port_protocol`** — engine has placeholder `return`, nothing executes. Only `data_gap` and `new_host` work.
- **Okta OIDC** — Settings UI exists, DB column exists, `app/auth/okta.py` does not exist. Zero backend implementation.
- **Direct UDP ingest** — Settings UI exists, `app/ingest/udp_listener.py` does not exist.
- **Notification channels (Slack, Email, PagerDuty, Webhook)** — code written in `engine.py` but never tested. `aiosmtplib` and `jinja2` are not verified in the venv. No "Send Test" backend endpoints exist.
- **AI assistant** — backend and frontend written, requires `anthropic` package in venv + API key in settings. Never tested on O2.
- **Aggregate rollup job** — hourly/daily rollup tables may exist in schema but no scheduled job populates them.
- **Migration mode, storage test connection, device CSV import, unknown samplers UI, WebSocket live updates** — UI elements exist with no backend wiring.
- **Alert event auto-cleanup** — alert_events and notification_log accumulate in SQLite indefinitely. No purge job built.
- **Settings auto-refresh** — Settings page loads once on mount, no polling or push to detect changes made elsewhere.
- **DuckDB backend** — fully written, never run against real data in production.
- **Network layout export** — topology view has no export (PNG/SVG/JSON). Needs export button + optional per-device filtering.
- **Topology node click → flow drill-down** — topology nodes are not interactive. Clicking a node should show flows filtered to that IP as src or dst.

---

## Known Issues / Watch Out For

1. **Schema startup warnings** — `_ensure_schema` logs "Schema statement warning" on startup for SQL comments inside multi-statement blocks. Cosmetic only, service starts fine.
2. **goflow2 template errors on restart** — Normal. After service restart, goflow2 loses cached NetFlow v9 templates and logs "template error" until the router sends the next template packet. Resolves within seconds.
3. **Vector exponential backoff** — After multiple pktFlow restarts, vector backs off to ~512s retry intervals. A pktFlow restart (connection reset) triggers immediate retry from vector.
4. **`--no-access-log` is removed from pktflow.service** — Access logging is currently enabled. Restore `--no-access-log` flag if performance becomes a concern.
5. **ClickHouse `flow_dir` constraint** — `FlowRecord.flow_dir` is `Field(ge=0, le=2)`. Valid: 0=ingress, 1=egress, 2=unknown. If a router sends a non-standard direction value, it would be clamped to 2 by `default=2` in `_get()`.
