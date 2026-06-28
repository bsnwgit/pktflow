<p align="center">
  <img src="assets/logos/lockup-256h.png" alt="pktFlow" height="80"/>
</p>

A production NetFlow visualization and alerting platform. Receives live NetFlow v9 data from network samplers via [goflow2](https://github.com/netsampler/goflow2) + [Vector](https://vector.dev/), stores flows in ClickHouse, and serves a React dashboard for real-time traffic analysis.

---

## Features

### Data Ingestion
- **NetFlow v9 via goflow2 + Vector** — one or more collector pipelines, each transforming raw NetFlow to snake_case JSON and posting to pktFlow via HTTPS bearer token
- **Direct UDP ingest** — optional built-in NetFlow v5/v9/IPFIX listener (no external collector required)
- **Ingest buffer** — in-memory batch buffer with configurable flush interval; WebSocket broadcasts to connected browsers on every flush
- **Invalid sampler filtering** — flows with `0.0.0.0` sampler address are rejected at ingest

### Dashboards & Visualization
- **Real-time dashboard** — flows/sec counter with live WebSocket updates (green dot = live, falls back to polling)
- **Analytics** — traffic timeseries charts; short-range (REST) and long-range (hourly/daily rollup) views
- **Device View** — per-sampler traffic history, top talkers table, protocol distribution
- **Flow Explorer** — search and filter flows by IP, port, protocol, time range; paginated results; CSV/JSON export
- **Network Topology** — D3 force-directed graph with site cluster labeling; export to PNG, SVG, JSON, DOT, Draw.io, or Lucidchart

### Alerting
- **data_gap** — fires when a known sampler goes silent for a configurable period; dismissed samplers are excluded
- **new_host** — fires when a previously unseen sampler IP sends flows
- **threshold** — fires when bytes/packets/flows in a time window exceed a configured value
- **rate_spike** — fires when current rate exceeds the 7-day rolling baseline by a configurable multiplier
- **port_protocol** — fires when specific port/protocol/direction combinations appear in recent flows
- **Auto-resolve** — open alert events self-close when the condition clears on the next evaluation cycle
- **ACK support** — analysts can acknowledge alerts without closing them
- **Alert cleanup** — configurable retention period; old events are purged on a schedule

### Authentication & Users
- **Local auth** — JWT + bcrypt, configurable token lifetime
- **SAML 2.0 (Okta)** — SP-initiated SSO; users auto-provisioned on first login
- **Roles** — `admin` (full access), `analyst` (read + export), `viewer` (read-only)
- **User management page** — admin can create users, reset passwords, toggle active status

### Settings & Configuration
All configuration is managed via the Settings UI (no file edits required after install). Settings are stored in SQLite and survive restarts.

### Integrations
- **SSL/TLS** — upload a PFX/P12 bundle or separate PEM cert+key via drag-and-drop; service auto-detects SSL files on startup
- **Lucidchart** — topology export directly to a Lucidchart document via API token

### Infrastructure
- **Device registry** — name, IP, site per sampler; CSV import; live stats per device
- **Unknown samplers** — IPs sending flows but not in the registry appear in Settings → Devices with dismiss support
- **Data retention** — configurable TTL for ClickHouse flows (default 90 days); manual cleanup trigger
- **Auto-backup** — one-click local backup with 2-revision rotation
- **WebSocket** — real-time browser push after every ingest flush; single-worker process ensures all clients receive all broadcasts

---

## Architecture

```
Routers (NetFlow v9 UDP)
    │
    ▼
Collector host (goflow2 → Vector)
    │  goflow2 decodes NetFlow v9 → JSON to stdout
    │  Vector transforms: snake_case, adds .site label
    │  HTTPS POST JSON array → pktFlow ingest endpoint
    ▼
pktFlow (FastAPI, port 8766, HTTPS)
    │  Normalizer: Vector JSON → FlowRecord (rejects 0.0.0.0)
    │  IngestBuffer: batched write + WebSocket broadcast
    ▼
ClickHouse (localhost:9000)
    │  pktflow.flows          (raw, 90-day TTL)
    │  pktflow.flows_hourly   (materialized view, 1-year TTL)
    │  pktflow.flows_daily    (materialized view, indefinite)
    ▼
React Dashboard (served by FastAPI, same port)
    │  WebSocket /api/ws/dashboard — live updates after every flush
```

**App database:** SQLite — users, settings, device registry, alert rules/events, notification log, sampler dismissals.

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
- `aiosqlite` — app database
- `python-jose[cryptography]`, `passlib[bcrypt]` — JWT auth
- `python3-saml` — SAML 2.0 SSO
- `anthropic` — AI assistant (optional, requires API key in Settings)

### Frontend

React 18, TypeScript, Vite, Tailwind CSS, Recharts, D3.js

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-org/pktflow.git
cd pktflow
git checkout feature/initial-build
```

### 2. Run the install script (Amazon Linux / RHEL)

```bash
bash scripts/install.sh
```

The script installs ClickHouse, creates the Python venv, applies the schema, and registers the systemd service. It prints the admin password and ingest token on completion — **save these immediately.**

### 3. Manual installation (other Linux distros)

#### Apply ClickHouse schema

```bash
clickhouse-client --multiquery < clickhouse/schema.sql
```

Creates `pktflow` database with `flows`, `flows_hourly`, `flows_daily` tables and two materialized views.

#### Create Python virtualenv

```bash
python3 -m venv /opt/pktflow/venv
/opt/pktflow/venv/bin/pip install -r requirements.txt
```

#### Configure

```bash
cp config.example.yaml config.yaml
# Edit config.yaml — set secret_key, cors_origins, paths
openssl rand -hex 32   # use this as secret_key
```

**config.yaml reference:**

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `0.0.0.0` | Bind address |
| `port` | `8766` | Listen port |
| `db_path` | `/opt/pktflow/pktflow.db` | SQLite database path |
| `clickhouse_host` | `localhost` | ClickHouse host |
| `clickhouse_port` | `9000` | ClickHouse native protocol port |
| `clickhouse_database` | `pktflow` | ClickHouse database name |
| `secret_key` | **CHANGE THIS** | JWT signing key (32+ random bytes) |
| `access_token_expire_minutes` | `480` | JWT lifetime |
| `log_file` | `/opt/pktflow/pktflow.log` | Log path |

#### Initialize the app database and start the service

```bash
sudo cp pktflow.service /etc/systemd/system/pktflow.service
sudo systemctl daemon-reload
sudo systemctl enable --now pktflow
sudo systemctl status pktflow
```

#### Verify

```bash
curl -sk https://localhost:8766/api/health
curl -sk https://localhost:8766/api/ingest/stats
```

---

## SSL / HTTPS

pktFlow auto-detects SSL on startup. If `ssl/server.crt` and `ssl/server.key` exist under the app directory, it starts in HTTPS mode; otherwise HTTP.

**To enable HTTPS:** go to **Settings → Integrations → SSL / TLS**, drag-and-drop a PFX/P12 bundle (with passphrase) or separate PEM cert + key files, then restart the service. The restart button is in **Settings → System**.

**To disable HTTPS:** delete the cert via the same Settings panel, then restart.

---

## Application Settings

All settings are in the browser UI at `/settings`. Changes take effect immediately (no restart needed unless otherwise noted).

### General

| Setting | Description |
|---------|-------------|
| Base URL | Public-facing URL of the app (used to build SAML ACS URL and entity ID) |
| Local auth enabled | Allow username/password login |
| Token lifetime | JWT expiry in minutes |

### Ingest

| Setting | Description |
|---------|-------------|
| Ingest token | Bearer token required by collector Vector sinks |
| Buffer flush interval | Seconds between ClickHouse writes (default 5) |
| Buffer max size | Max records held before forced flush |
| Direct UDP ingest enabled | Enable built-in NetFlow UDP listener |
| UDP listen port | Port for direct UDP ingest (default 2055) |
| WebSocket stream raw flows | Push raw flow batches to connected browsers after each flush (bandwidth-heavy; off by default) |
| WebSocket max raw flows | Cap on flows sent per broadcast when raw streaming is enabled |

### Devices

The device registry maps sampler IPs to human-readable names and sites. Devices appear on Device View and the sampler dropdown throughout the UI.

- Add devices manually or **import from CSV** (columns: `name`, `ip`, `site`, `description`)
- **Unknown Samplers** panel shows IPs sending flows that are not in the registry; dismiss to suppress the `new_host` alert without adding to the registry

### Alerts

| Setting | Description |
|---------|-------------|
| Alert retention days | How long to keep alert events in SQLite before auto-purge |

**Alert rule types:**

| Type | What it detects |
|------|----------------|
| `data_gap` | A known sampler has sent no flows for N minutes |
| `new_host` | A previously unseen sampler IP sent flows |
| `threshold` | Bytes/packets/flows in a time window exceed a configured value |
| `rate_spike` | Current rate exceeds 7-day baseline by a configurable multiplier |
| `port_protocol` | Specific port/protocol/direction combinations appear in recent flows |

Dismissed sampler IPs (via the Unknown Samplers panel) are excluded from `data_gap` evaluation. `0.0.0.0` is always excluded.

### Notifications

Notification channels are configured per-alert-rule. Available channels:

| Channel | Status |
|---------|--------|
| Slack webhook | Code written; requires webhook URL |
| Email (SMTP) | Code written; requires SMTP host, port, credentials |
| PagerDuty | Code written; requires integration key |
| Webhook | Code written; requires endpoint URL |

> **Note:** Notification channels have not been end-to-end tested against live services. Verify `httpx`, `aiosmtplib`, and `jinja2` are installed in the venv before enabling.

### Storage

| Setting | Description |
|---------|-------------|
| Storage backend | `clickhouse` (production) or `duckdb` (experimental) |
| Flow retention days | ClickHouse TTL for raw flows table (default 90) |
| Manual cleanup | Trigger immediate retention cleanup |

### Integrations

| Setting | Description |
|---------|-------------|
| SSL / TLS | Upload PFX/P12 or PEM cert+key; restart required to apply |
| Lucidchart API token | Enables "Export to Lucidchart" on the Topology page |

### System

- **Restart Service** — triggers `systemctl restart pktflow`; wait ~5 seconds for the service to come back
- **Backup** — runs the local backup script; keeps 2 rotating snapshots

### Okta SAML

| Setting | Description |
|---------|-------------|
| SAML enabled | Enable Okta SSO login |
| IdP SSO URL | Okta app's Single Sign On URL |
| IdP Entity ID | Okta Issuer |
| IdP certificate | Okta X.509 signing certificate |
| SP Entity ID | Must match "Audience URI" in Okta app settings |

> The SP Entity ID is derived from Base URL: `<base_url>/api/auth/saml/metadata`. If you change Base URL, update the Okta app's Audience URI to match.

### AI Assistant

| Setting | Description |
|---------|-------------|
| Anthropic API key | Required to enable the AI assistant panel |
| AI model | Claude model to use (default: claude-3-5-haiku) |

---

## Collector Configuration

pktFlow receives data from **goflow2 + Vector** pipelines. Vector transforms goflow2's PascalCase protobuf-JSON into flat snake_case before posting to pktFlow.

### Vector sink (`vector.toml`)

```toml
[sinks.pktflow]
type = "http"
inputs = ["add_site"]
uri = "https://<PKTFLOW_HOST>:8766/api/ingest/flows"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN>"
request.timeout_secs = 10
healthcheck.enabled = false

[sinks.pktflow.tls]
verify_certificate = false    # required when connecting by IP or internal hostname
```

The ingest token is in **Settings → Ingest**.

### Vector output format (what pktFlow receives)

```json
{
  "src_addr": "10.1.2.3",     "dst_addr": "8.8.8.8",
  "src_port": 54321,           "dst_port": 443,
  "proto": "UDP",              "bytes": 1500,
  "packets": 10,               "in_if": 6,   "out_if": 7,
  "sampler_address": "192.0.2.1",
  "site": "your-site-name",
  "time_flow_start_ns": 1750686000000000000,
  "time_flow_end_ns":   1750686005000000000
}
```

All fields are **snake_case**; `proto` is a **string** (`"UDP"`, `"TCP"`); `next_hop` is `""` when absent.

### Per-site collector

Each collector host runs the same `goflow2-vector.service` unit. The source type is `stdin` when the systemd unit allows stdin inheritance, or `exec` when `stdin=/dev/null` is set (Vector spawns goflow2 as a subprocess instead of reading from the pipe). See [DATAFLOW.md](DATAFLOW.md) for full configuration details.

> **Orphan process note:** If the service is restarted multiple times rapidly, the old goflow2 process may survive and hold port 2055, preventing the new instance from receiving packets. If flows stop after a restart, check `pgrep -a goflow2` — there should be exactly one process per collector. Kill orphans with `sudo kill -9 <PID>`.

---

## Directory Structure

```
pktflow/
├── app/
│   ├── api/
│   │   ├── ingest.py       POST /api/ingest/flows
│   │   ├── flows.py        GET /api/flows/*
│   │   ├── alerts.py       Alert rules + events
│   │   ├── auth.py         Login, SAML, token refresh
│   │   ├── devices.py      Device registry CRUD + unknown samplers
│   │   ├── settings.py     App settings CRUD
│   │   ├── users.py        User management
│   │   ├── system.py       Health, restart, SSL upload, cleanup, backup
│   │   ├── ws.py           WebSocket endpoint + broadcast helpers
│   │   └── ai.py           AI assistant (Claude)
│   ├── alerts/
│   │   ├── engine.py       Alert evaluation loop (all rule types)
│   │   ├── cleanup.py      Alert event retention purge job
│   │   └── notifiers/      Slack, email, PagerDuty, webhook
│   ├── auth/
│   │   └── local.py        JWT + bcrypt
│   ├── ingest/
│   │   ├── normalizer.py   Vector JSON → FlowRecord (rejects 0.0.0.0)
│   │   ├── buffer.py       In-memory batch buffer + WS broadcast
│   │   └── udp_listener.py Direct UDP NetFlow listener
│   ├── models/flow.py      FlowRecord Pydantic model
│   ├── storage/
│   │   ├── base.py         Storage interface
│   │   ├── clickhouse.py   ClickHouse backend (production)
│   │   ├── duckdb.py       DuckDB backend (experimental)
│   │   └── factory.py      Backend selector
│   ├── config.py           Settings loader (YAML + env)
│   ├── database.py         SQLite init + migrations
│   └── main.py             App factory, lifespan, router registration
├── clickhouse/schema.sql   flows + rollup tables + materialized views
├── frontend/src/
│   ├── pages/              Dashboard, Analytics, DeviceView, FlowExplorer,
│   │                         Topology, Ports, Alerts, Settings, Users
│   ├── components/         Layout, AiAssistant
│   ├── api/client.ts       Typed API client + getToken() for WebSocket
│   ├── hooks/useWebSocket.ts  WebSocket hook
│   └── utils/protocols.ts  Shared protocol name map
├── scripts/
│   └── install.sh          One-shot installer (Amazon Linux / RHEL)
├── config.example.yaml
├── pktflow.service
├── start.sh                SSL-aware startup wrapper
└── requirements.txt
```

---

## API Reference

### Ingest

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/ingest/flows` | Bearer ingest token | Accept JSON array of flow records from Vector |
| `GET` | `/api/ingest/stats` | JWT | Buffer stats: `buffered`, `total_received`, `total_flushed`, `last_flush` |

### Flows

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/flows/summary` | Aggregate stats for a time range |
| `GET` | `/api/flows/timeseries` | Bytes/flows per interval |
| `GET` | `/api/flows/timeseries/daily` | Daily totals from rollup table |
| `GET` | `/api/flows/timeseries/hourly` | Hourly totals from rollup table |
| `GET` | `/api/flows/top-talkers` | Top src/dst IPs by bytes or flows |
| `GET` | `/api/flows/search` | Paginated flow search |
| `GET` | `/api/flows/topology` | Node/edge list for topology graph |
| `GET` | `/api/flows/topology/lucidchart` | Export topology to Lucidchart |
| `GET` | `/api/flows/rate` | Current flows/sec |
| `GET` | `/api/flows/export` | Download flows as CSV or JSON |
| `GET` | `/api/flows/devices` | Device summaries with live stats |

Common query parameters: `sampler_ip`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol`, `site`, `start`, `end`, `limit`, `offset`.

### WebSocket

| Endpoint | Auth | Description |
|----------|------|-------------|
| `wss://<host>/api/ws/dashboard?token=<jwt>` | JWT query param | Push updates after each ingest flush |

Message types: `device_update` (device summaries), `ingest_stats` (buffer counters), `flow_update` (raw batch, if enabled), `alert_fired`, `ping` (keepalive).

### System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | None | Service health check |
| `POST` | `/api/system/restart` | Admin JWT | Restart pktflow service |
| `POST` | `/api/system/ssl/upload-pfx` | Admin JWT | Upload PFX/P12 bundle |
| `POST` | `/api/system/ssl/upload` | Admin JWT | Upload PEM cert + key separately |
| `DELETE` | `/api/system/ssl` | Admin JWT | Remove SSL files |
| `GET` | `/api/system/ssl/status` | Admin JWT | SSL file status |
| `POST` | `/api/system/cleanup` | Admin JWT | Trigger retention cleanup |
| `POST` | `/api/system/backup` | Admin JWT | Trigger local backup |

---

## Deployment

### Backend changes

1. Copy changed files to `/opt/pktflow/` on the server (same relative path as the repo)
2. `sudo systemctl restart pktflow`
3. Verify: `curl -sk https://localhost:8766/api/health`

### Frontend changes

The frontend must be built on Linux — build on the server itself or a Linux CI runner, not on a Windows machine (Windows `node_modules` lacks the Linux rollup native binary).

```bash
# On the server
cp -r frontend /tmp/pktflow-fe
cd /tmp/pktflow-fe
npm install
npm run build
cp -r dist /opt/pktflow/frontend/dist
sudo systemctl restart pktflow
```

### After restart — Vector reconnection

After pktFlow restarts, Vector detects the connection reset and immediately retries. Flows normally resume within seconds. If pktFlow was restarted repeatedly, Vector may be in exponential backoff (up to ~512s); a clean restart resets this.

---

## Known Issues & Quirks

1. **Workers = 1 required for WebSocket** — `start.sh` uses `--workers 1`. With multiple workers, each has its own in-memory `ws_manager`; broadcasts from the ingest worker don't reach WS connections on other workers.
2. **Schema startup warnings** — `_ensure_schema` logs "Schema statement warning" on startup for SQL comments in multi-statement blocks. Cosmetic only.
3. **goflow2 template errors after restart** — Normal. goflow2 loses cached NetFlow v9 templates on restart; "template error" log lines resolve within seconds when the router sends the next template packet.
4. **Site B collector orphan process** — If `goflow2-vector` is restarted while flows are active, the old goflow2 process may survive and hold port 2055. Symptom: service is `active` but no flows arriving. Fix: `sudo kill -9 <old_goflow2_pid>`.
5. **ClickHouse threading** — `clickhouse-driver` is not thread-safe. All calls are serialized with `threading.Lock()` in `clickhouse.py`.
6. **passlib/bcrypt on Python 3.12+** — Pin `passlib==1.7.4` and `bcrypt==4.0.1` to avoid attribute errors.

---

## Incomplete / Planned Features

| Feature | Status |
|---------|--------|
| Notification channels (Slack, Email, PagerDuty, Webhook) | Code written; not end-to-end tested against live services |
| Okta OIDC | SAML works; OIDC (`app/auth/okta.py`) not implemented |
| AI assistant | Code written; needs `anthropic` package in venv + API key in Settings |
| Topology node click → flow drill-down | Nodes not interactive beyond hover |
| Pie charts on Device View | Not built |
| Storage "Test Connection" button | UI exists, no backend endpoint |
| Production-test DuckDB backend | Implemented but never run against real data |
| Migration mode / flow forwarding | UI toggle exists, no backend logic |

---

## Security Notes

- Change `secret_key` in `config.yaml` before production use (`openssl rand -hex 32`)
- The ingest token is in **Settings → Ingest** and must match `auth.token` in each collector's `vector.toml`
- `cors_origins` in config should be restricted to your dashboard origin
- If using a self-signed cert or connecting by IP, set `verify_certificate = false` in Vector's TLS section
- SAML SP Entity ID must exactly match Okta's "Audience URI" — both derived from Base URL in Settings�