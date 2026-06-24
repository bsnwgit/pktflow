# pktFlow — Project Context for Claude

This file is the ground truth for working in this project. Read it before doing anything.

**Todo list:** All pending work is tracked in `TODO.md`. When asked for the todo list, read `todo_widget.html` and render it using the `show_widget` tool — do NOT show it as plain text or as a separate artifact panel.

**CRITICAL — Backup before marking complete:** Every time the user says to mark a todo item as done, run the O2 backup rotation script FIRST, then mark the item. Never mark complete without backing up.

```
# Run via Paramiko on O2:
/mnt/software/pktflow_backup.sh
```

Backup rotation keeps 2 revisions at `/mnt/software/pktflow_backups/`:
- `backup_1/` = most recent snapshot
- `backup_2/` = previous snapshot
- When a new backup runs: backup_2 is dropped, backup_1 → backup_2, current → backup_1

---

## What This Is

pktFlow is a production NetFlow visualization and alerting platform deployed on the Corp Infrastructure O2 server. It receives live NetFlow data from two collectors, stores it in ClickHouse, and serves a React dashboard.

**Live URL:** http://10.20.30.5:8766  
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
- Port: **8766**
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
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')  # REQUIRED — Windows defaults to cp1252 which crashes on Unicode output from O2
key = paramiko.RSAKey.from_private_key_file(r"C:\Users\user\.ssh\corporate_infrastructure.pem")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("10.20.30.5", username="ec2-user", pkey=key, timeout=15, banner_timeout=15)
_, stdout, _ = client.exec_command("your command", timeout=20)
print(stdout.read().decode('utf-8', errors='replace'))
client.close()
```

**Windows encoding — CRITICAL:** Always include `sys.stdout.reconfigure(encoding='utf-8')` at the top of every Paramiko script. Without it, any Unicode output from O2 (box-drawing chars, checkmarks, etc.) causes `UnicodeEncodeError: 'charmap' codec can't encode character` and the script dies mid-run.

**npm build output:** Vite's build table uses Unicode box-drawing characters. Never try to capture and print `npm run build` output directly. Always redirect to `/dev/null` and echo pass/fail:
```bash
npm run build > /dev/null 2>&1 && echo 'build ok' || echo 'BUILD FAILED'
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
pktFlow ingest (10.20.30.5:8766/api/ingest/flows)
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

Always build in Linux `/tmp`. **CRITICAL: always sync the full `frontend/src` from local to O2 first** — the O2 copy can drift from the local project. Skipping this means new pages/components get silently excluded from the bundle.

Full frontend deploy process (use Paramiko SFTP + SSH):
```
1. SFTP entire frontend/src/ tree → /mnt/software/pktflow/frontend/src/ on O2
2. SSH: rm -rf /tmp/pktflow-fe && cp -r /mnt/software/pktflow/frontend /tmp/pktflow-fe
3. SSH: cd /tmp/pktflow-fe && npm install && npm run build
4. SSH: rm -rf /mnt/software/pktflow/frontend/dist && cp -r /tmp/pktflow-fe/dist /mnt/software/pktflow/frontend/dist
5. SSH: sudo systemctl restart pktflow
```

To verify the build includes all pages, check for lazy chunk filenames:
```bash
ls /mnt/software/pktflow/frontend/dist/assets/
# Expected chunks: Users-*.js, Alerts-*.js, Settings-*.js, DeviceView-*.js, etc.
```

Node is installed via nvm on O2: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"` before any npm command.

---

## Deployment Process

### Backend changes
1. Write/edit local file in `C:\Users\user\My Drive\Documents\Claude\Projects\pktFlow\`
2. SFTP the changed file(s) to `/mnt/software/pktflow/` on O2 (same relative path)
3. `sudo systemctl restart pktflow`
4. Wait 4 seconds, check `systemctl is-active pktflow`
5. Check `curl -s http://localhost:8766/api/ingest/stats`

### Frontend changes
Follow the full frontend deploy process in the Frontend Build section above. Do NOT just rebuild from O2's existing source without first syncing local `frontend/src/` — the O2 source is not automatically updated.

**After pktFlow restarts**, vector may have exponential backoff from prior connection resets — it can take up to ~512s before vector sends again. The restart itself triggers an immediate retry in vector (connection reset = immediate reconnect), so usually flows resume within seconds.

---

## Ingest Stats Endpoint

```
GET http://10.20.30.5:8766/api/ingest/stats

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
- **Traffic by Port page** — new page planned: protocol mix chart, top ports by bytes/flows, traffic chart over time, full port inventory table (every dst_port seen), filterable by sampler/site.
- **Sankey flow diagram** — new visualization planned: `src_ip → dst_port → dst_ip` alluvial/Sankey chart with band width by bytes. Similar to Kibana/Grafana flow diagrams. Use D3-sankey. Goes on the Traffic by Port page or its own tab.

---

## Current Build State (as of 2026-06-23)

The application is **fully deployed and receiving live traffic** on O2.

### What is built and working
- FastAPI backend with ClickHouse storage (threading-safe, lock-serialized)
- NetFlow ingest from two collectors (medical 10.20.30.11, dental 10.20.30.181) via goflow2 + Vector
- Normalizer correctly handles Vector's snake_case output and string proto names (`"UDP"` → 17)
- React dashboard: Dashboard, Device View, Flow Explorer, Topology (D3), Alerts, Settings, Users pages
- Local auth (JWT + bcrypt), admin/analyst/viewer roles
- Alert engine: `data_gap` and `new_host` rules functional
- CSV/JSON flow export
- Change password + reset password (admin) in Users page
- Restart service button in Settings
- README.md complete with setup, architecture, API reference

### What is NOT yet built (next up)
1. **Traffic by Port page** — port inventory, protocol mix, top ports, traffic chart by port
2. **Sankey flow diagram** — `src_ip → dst_port → dst_ip` visualization
3. See full list in `INCOMPLETE_FEATURES.md`

### Git state
- Branch: `feature/initial-build`
- Remotes: GitHub (`github`) + GitLab (`gitlab`)
- Last commit: `docs: complete README with setup, architecture, API reference, and deployment guide`
- GitHub PR and GitLab MR open on `feature/initial-build`

### Port discrepancy note
The `pktflow.service` file in the repo specifies port `8080`. The **running service on O2 uses port `8766`** (the service file on the server was updated). If deploying fresh from the repo, update the port in `pktflow.service` and `config.example.yaml` to `8766` before installing.

---

## User Management

SQLite DB: `/mnt/software/pktflow/pktflow.db`, table `users`.

Columns: `id, username, email, hashed_password, role, is_active, okta_sub, created_at, last_login`

Roles: `admin` (full access), `analyst` (read + export), `viewer` (read-only).

**Users page** is at `/users` in the app — admin-only nav item. If it's missing from the sidebar, the user is not logged in as admin or the frontend is stale (re-deploy).

**If login is broken** (can't get in after logout):
1. SSH to O2, use Python + pktflow venv to inspect/repair SQLite:
```python
import sqlite3, bcrypt
conn = sqlite3.connect('/mnt/software/pktflow/pktflow.db')
conn.row_factory = sqlite3.Row
# Check state
for r in conn.execute("SELECT id, username, role, is_active FROM users"): print(dict(r))
# Reset a user's password and re-activate
new_hash = bcrypt.hashpw(b'NewPassword1!', bcrypt.gensalt()).decode()
conn.execute("UPDATE users SET hashed_password=?, is_active=1 WHERE username='admin'", (new_hash,))
conn.commit()
```
2. The `is_active=0` flag silently rejects login with "Invalid credentials" — always check it first.
3. JWT secret is static (`CHANGE_ME_IN_PRODUCTION_secret_key_32chars`), so service restarts do NOT invalidate existing tokens.

**Current accounts** (as of 2026-06-23):
- `admin` / role=admin — primary break-glass account
- `robert` / role=admin — day-to-day account

---

## Known Issues / Watch Out For

1. **Schema startup warnings** — `_ensure_schema` logs "Schema statement warning" on startup for SQL comments inside multi-statement blocks. Cosmetic only, service starts fine.
2. **goflow2 template errors on restart** — Normal. After service restart, goflow2 loses cached NetFlow v9 templates and logs "template error" until the router sends the next template packet. Resolves within seconds.
3. **Vector exponential backoff** — After multiple pktFlow restarts, vector backs off to ~512s retry intervals. A pktFlow restart (connection reset) triggers immediate retry from vector.
4. **`--no-access-log` is removed from pktflow.service** — Access logging is currently enabled. Restore `--no-access-log` flag if performance becomes a concern.
5. **ClickHouse `flow_dir` constraint** — `FlowRecord.flow_dir` is `Field(ge=0, le=2)`. Valid: 0=ingress, 1=egress, 2=unknown. If a router sends a non-standard direction value, it would be clamped to 2 by `default=2` in `_get()`.
