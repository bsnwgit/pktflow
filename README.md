# pktFlow

A production NetFlow visualization and alerting platform. Receives live NetFlow v9 data from network samplers via [goflow2](https://github.com/netsampler/goflow2) + [Vector](https://vector.dev/), stores flows in ClickHouse, and serves a React dashboard for real-time traffic analysis.

**Live deployment:** Corp Infrastructure O2 server — `http://10.20.30.5:8080`

---

## Features

- **Real-time dashboard** — per-device traffic charts, flows/sec, top talkers, site breakdown
- **Flow Explorer** — search and filter flows by IP, port, protocol, time range; paginated results; CSV/JSON export
- **Device View** — per-sampler traffic history, top talkers table, protocol distribution
- **Network Topology** — D3 force-directed graph of traffic relationships between hosts
- **Alerts** — `data_gap` and `new_host` rules fully functional; rule builder UI for threshold/rate/protocol rules (engine stubs pending)
- **Notification channels** — Slack, email, PagerDuty, webhook (code written, untested — see [INCOMPLETE_FEATURES.md](INCOMPLETE_FEATURES.md))
- **Multi-site support** — separate collector pipelines per datacenter/site, labeled in all views
- **User management** — admin/analyst/viewer roles, local auth, password management
- **Settings UI** — all configuration via browser (ingest token, storage backend, retention, notification channels, device registry)

---

## Architecture

```
Routers (NetFlow v9 UDP)
    │
    ▼
Collector host (goflow2 → Vector)
    │  goflow2 decodes NetFlow v9 → JSON
    │  Vector transforms to snake_case, adds site label
    │  HTTP POST JSON array → pktFlow ingest endpoint
    ▼
pktFlow (FastAPI, port 8080)
    │  Normalizer converts fields → FlowRecord
    │  IngestBuffer → batched write
    ▼
ClickHouse (port 9000)
    │  pktflow.flows (raw, 90-day TTL)
    │  pktflow.flows_hourly (materialized, 1-year TTL)
    │  pktflow.flows_daily (materialized, indefinite)
    ▼
React Dashboard (served by FastAPI on same port)
```

**App database:** SQLite — users, settings, device registry, alert rules/events, notification log.

---

## Requirements

### Server

| Component | Version | Notes |
|-----------|---------|-------|
| Python | 3.9+ | 3.11+ recommended |
| ClickHouse | 24.x+ | Tested on 26.5.3.52 |
| Node.js | 18+ | Frontend build only |
| npm | 9+ | Frontend build only |
| OS | Amazon Linux 2023 / RHEL 8+ / Ubuntu 22+ | systemd required |

### Collector hosts (one per site)

| Component | Version |
|-----------|---------|
| [goflow2](https://github.com/netsampler/goflow2) | latest |
| [Vector](https://vector.dev/) | 0.38+ |

### Python packages

See [requirements.txt](requirements.txt). Key dependencies:

- `fastapi`, `uvicorn[standard]` — web framework
- `clickhouse-driver` — ClickHouse backend
- `aiosqlite`, `sqlalchemy[asyncio]` — app database
- `python-jose[cryptography]`, `passlib[bcrypt]` — JWT auth
- `apscheduler` — background jobs (alert engine)
- `anthropic` — AI assistant (optional, requires API key)

### Frontend

- React 18, TypeScript, Vite, Tailwind CSS, Recharts, D3.js

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/bsnwgit/pktflow.git
cd pktflow
git checkout feature/initial-build
```

### 2. Run the install script (Amazon Linux / RHEL)

The install script handles ClickHouse installation, Python virtualenv, schema initialization, and systemd service registration in one step.

```bash
bash scripts/install.sh
```

The script will print the admin password and ingest token when complete — **save these immediately.**

### 3. Manual installation (other Linux distros)

#### Install ClickHouse

Follow the official instructions at https://clickhouse.com/docs/en/install, then:

```bash
sudo systemctl enable --now clickhouse-server
```

#### Apply ClickHouse schema

```bash
clickhouse-client --multiquery < clickhouse/schema.sql
```

This creates the `pktflow` database with three tables (`flows`, `flows_hourly`, `flows_daily`) and two materialized views.

#### Create Python virtualenv

```bash
python3 -m venv /mnt/software/pktflow/venv
/mnt/software/pktflow/venv/bin/pip install -r requirements.txt
```

#### Configure

```bash
cp config.example.yaml /mnt/software/pktflow/config.yaml
# Edit config.yaml — update secret_key, cors_origins, paths as needed
openssl rand -hex 32   # use this as secret_key
```

Key config values:

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `0.0.0.0` | Bind address |
| `port` | `8080` | Listen port |
| `db_path` | `/mnt/software/pktflow/pktflow.db` | SQLite database |
| `clickhouse_host` | `localhost` | ClickHouse host |
| `clickhouse_port` | `9000` | ClickHouse native port |
| `clickhouse_database` | `pktflow` | ClickHouse database name |
| `secret_key` | **CHANGE THIS** | JWT signing key |
| `log_file` | `/mnt/software/logs/pktflow.log` | Log path |

#### Initialize the app database

```bash
PKTFLOW_CONFIG=/mnt/software/pktflow/config.yaml \
  /mnt/software/pktflow/venv/bin/python3 -c "
import asyncio
from app.database import init_db
asyncio.run(init_db())
"
```

#### Install and start the systemd service

```bash
sudo cp pktflow.service /etc/systemd/system/pktflow.service
sudo systemctl daemon-reload
sudo systemctl enable --now pktflow
sudo systemctl status pktflow
```

#### Verify the service is healthy

```bash
curl -s http://localhost:8080/api/health
curl -s http://localhost:8080/api/ingest/stats
```

---

## Frontend Build

> **Important:** Never build the frontend from the Windows project folder — `node_modules` there is Windows-only and lacks the Linux Rollup native binary. Always build in `/tmp` on the Linux server.

```bash
# Copy source to tmp
cp -r frontend /tmp/pktflow-frontend
cd /tmp/pktflow-frontend

# Install Linux-compatible packages
npm install

# Build
npm run build

# Copy dist to app directory
cp -r dist /mnt/software/pktflow/frontend/dist
```

The built `frontend/dist/` is served statically by FastAPI on the root path.

---

## Collector Configuration

pktFlow receives data from **goflow2 + Vector** pipelines on each collector host. Vector transforms goflow2's output (PascalCase protobuf-JSON) into a flat snake_case format before sending to pktFlow.

### Vector output format (what pktFlow receives)

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
  "sampler_address": "192.168.44.7",
  "site": "Site-B",
  "time_flow_start_ns": 1750686000000000000,
  "time_flow_end_ns": 1750686005000000000
}
```

Key differences from goflow2 raw output: all fields are **snake_case**, `proto` is a **string** (`"UDP"`, `"TCP"`, not an integer), and `next_hop` is an empty string when absent.

### Vector sink configuration (`vector.toml`)

Add this sink block on each collector host:

```toml
[sinks.pktflow]
type = "http"
inputs = ["add_site"]          # or whichever transform feeds the sink
uri = "http://10.20.30.5:8080/api/ingest/flows"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN>"   # from Settings → Ingest or install output
request.timeout_secs = 10
healthcheck.enabled = false
```

See [VECTOR_MIGRATION.md](VECTOR_MIGRATION.md) for the full parallel-then-cutover migration guide.

### Medical collector (10.20.30.11)

- Service: `goflow2-vector.service`
- Source type: `stdin` (goflow2 stdout piped to vector stdin)
- Samplers: `192.168.44.7/8` (Site-B), `172.27.28.89/88` (Site-A)
- ~148 flows/sec

### Dental collector (10.20.30.181)

- Service: `goflow2-vector.service`
- Source type: `exec` (vector launches goflow2 as subprocess — required because systemd sets `stdin=/dev/null`)
- Samplers: `10.19.56.186`, `10.19.81.236` (AWS)

---

## Directory Structure

```
pktflow/
├── app/                        # FastAPI application
│   ├── api/                    # Route handlers
│   │   ├── ingest.py           # POST /api/ingest/flows
│   │   ├── flows.py            # GET /api/flows/*
│   │   ├── alerts.py           # Alert rules + events
│   │   ├── auth.py             # Login / token
│   │   ├── devices.py          # Device registry CRUD
│   │   ├── settings.py         # App settings CRUD
│   │   ├── users.py            # User management
│   │   ├── system.py           # Health, restart
│   │   └── ai.py               # AI assistant (Claude)
│   ├── alerts/
│   │   ├── engine.py           # Alert evaluation loop
│   │   └── notifiers/          # Slack, email, PagerDuty, webhook
│   ├── auth/
│   │   └── local.py            # JWT + bcrypt
│   ├── ingest/
│   │   ├── normalizer.py       # Vector JSON → FlowRecord
│   │   └── buffer.py           # In-memory batch buffer
│   ├── models/
│   │   └── flow.py             # FlowRecord Pydantic model
│   ├── storage/
│   │   ├── base.py             # Storage backend interface
│   │   ├── clickhouse.py       # ClickHouse backend (production)
│   │   ├── duckdb.py           # DuckDB backend (untested)
│   │   └── factory.py          # Backend selector
│   ├── config.py               # Settings loader (YAML + env)
│   ├── database.py             # SQLite init + migrations
│   ├── dependencies.py         # FastAPI dependency injection
│   └── main.py                 # App factory, router registration
├── clickhouse/
│   └── schema.sql              # flows, flows_hourly, flows_daily tables + MVs
├── frontend/                   # React/Vite app
│   └── src/
│       ├── pages/              # Dashboard, DeviceView, FlowExplorer,
│       │                       #   Topology, Alerts, Settings, Users
│       ├── components/         # Layout, AiAssistant
│       └── api/client.ts       # Typed API client
├── migrations/
│   └── 001_initial.sql         # SQLite schema (users, settings, devices, alerts)
├── scripts/
│   └── install.sh              # One-shot installer
├── config.example.yaml         # Config template
├── pktflow.service             # systemd unit file
├── requirements.txt
├── ARCHITECTURE.md             # Detailed component design
├── INCOMPLETE_FEATURES.md      # Planned but unbuilt features
├── VECTOR_MIGRATION.md         # Collector cutover guide
└── CLAUDE.md                   # AI session context (do not delete)
```

---

## API Reference

### Ingest

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest/flows` | Accept JSON array of flow records from Vector |
| `GET` | `/api/ingest/stats` | Buffer statistics (`buffered`, `total_received`, `total_flushed`) |

The ingest endpoint requires a Bearer token matching the `ingest_token` setting. Returns `204 No Content` on success.

### Flows

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/flows/summary` | Aggregate stats (bytes, packets, flows) for a time range |
| `GET` | `/api/flows/timeseries` | Bytes/flows per interval for charting |
| `GET` | `/api/flows/top-talkers` | Top src/dst IPs by bytes or flows |
| `GET` | `/api/flows/search` | Paginated flow search with filters |
| `GET` | `/api/flows/topology` | Node/edge list for topology graph |
| `GET` | `/api/flows/export` | Download flows as CSV or JSON |

Common query parameters: `sampler_ip`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol`, `site`, `start`, `end`, `limit`, `offset`.

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health check |
| `POST` | `/api/system/restart` | Restart the pktflow systemd service (admin only) |

### Auth / Users / Settings / Devices / Alerts

Standard CRUD — see route handlers in `app/api/` for full parameter documentation.

---

## Deployment

### Updating backend code

```bash
# 1. Edit files locally in the project folder
# 2. SFTP changed files to O2 (same relative path under /mnt/software/pktflow/)
# 3. Restart the service
ssh ec2-user@10.20.30.5   # requires Python+Paramiko (see O2_SSH_CONNECTION.md)
sudo systemctl restart pktflow
# 4. Verify
curl -s http://localhost:8080/api/ingest/stats
```

### Updating the frontend

Build in Linux `/tmp` (not the Windows project folder), then copy `dist/` to O2:

```bash
cp -r frontend /tmp/pktflow-frontend && cd /tmp/pktflow-frontend
npm install && npm run build
# sftp dist/ → /mnt/software/pktflow/frontend/dist/
sudo systemctl restart pktflow
```

### After restart — Vector reconnection

After pktFlow restarts, Vector detects the connection reset and immediately retries. If pktFlow was restarted repeatedly before this, Vector may be in exponential backoff (up to ~512s delay). The connection reset from a clean restart triggers an immediate retry, so flows normally resume within seconds.

---

## Known Issues

1. **Schema startup warnings** — `_ensure_schema` logs "Schema statement warning" on startup for SQL comments inside multi-statement blocks. Cosmetic, service starts fine.
2. **goflow2 template errors after restart** — Normal. goflow2 loses cached NetFlow v9 templates on restart and logs "template error" until the router sends the next template packet (resolves in seconds).
3. **ClickHouse threading** — `clickhouse-driver` is not thread-safe. The storage backend uses `threading.Lock()` to serialize all calls from `asyncio.to_thread()`.
4. **passlib/bcrypt on Python 3.12+** — If upgrading Python, pin `passlib==1.7.4` and `bcrypt==4.0.1` to avoid attribute errors.

---

## Incomplete / Planned Features

See [INCOMPLETE_FEATURES.md](INCOMPLETE_FEATURES.md) for the full inventory. Key gaps:

- Alert rule types `threshold`, `rate_spike`, `port_protocol` — UI exists, engine returns early (no evaluation)
- Okta OIDC — settings UI exists, `app/auth/okta.py` does not exist
- Direct UDP ingest — settings UI exists, `app/ingest/udp_listener.py` does not exist
- Notification channels (Slack, Email, PagerDuty, Webhook) — code written, never tested on O2
- AI assistant — code written, requires `anthropic` package in venv + API key in Settings
- Network topology export (PNG/SVG/JSON) — not built
- Topology node click → flow drill-down — not built
- Alert event auto-cleanup — events accumulate indefinitely in SQLite
- Aggregate rollup job — hourly/daily tables populated by materialized view only, no backfill

---

## Security Notes

- Change `secret_key` in `config.yaml` before production use (`openssl rand -hex 32`)
- The ingest token is stored in Settings → Ingest and must match `vector.toml` `auth.token`
- `cors_origins` in config should be restricted to your actual dashboard origin
- SSH access to O2 requires the `corporate_infrastructure.pem` key and SentinelOne EDR blocks the system `ssh.exe` — use Python + Paramiko (see [O2_SSH_CONNECTION.md](O2_SSH_CONNECTION.md))

---

## License

Internal — Corp Dental. Not for public distribution.
