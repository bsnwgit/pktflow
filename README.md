<p align="center">
  <img src="assets/logos/lockup-256h.png" alt="pktFlow" height="80"/>
</p>

A production NetFlow visualization and alerting platform. Receives live NetFlow v9 data from network samplers via [goflow2](https://github.com/netsampler/goflow2) + [Vector](https://vector.dev/), stores flows in ClickHouse, and serves a React dashboard for real-time traffic analysis.

---

## Quick Start

Requires a fresh Ubuntu Server 22.04/24.04 LTS host with `sudo` access, and Node.js 20.x LTS installed beforehand for the frontend build (`install.sh` builds the frontend automatically if `npm` is already on `PATH`, but does not install Node.js itself — see [Requirements](#requirements)).

```bash
# 1. Clone the repository
git clone https://github.com/bsnwgit/pktflow.git
cd pktflow

# 2. Run the installer — system packages, ClickHouse, Python deps, schema,
#    config.yaml + secret key, admin user, frontend build (if npm is present),
#    systemd service (installed + started)
bash install.sh
# Prints the admin password and ingest token at the end — save them, they are
# not shown again. If npm wasn't found, the final banner prints the exact
# manual frontend-build commands to run before the web UI will load.

# 3. Open the firewall for the app port (adjust if PKTFLOW_INSTALL_DIR/port differ)
sudo ufw allow 8766/tcp

# 4. Open http://<server-ip>:8766 and log in with the admin credentials from step 2
```

For a fully manual walkthrough of what `install.sh` does (e.g. to customize the install path or run steps individually), see [Installation](#installation).

### Environment variables

All settings in `config.example.yaml` can also be passed as `PKTFLOW_*` environment variables instead of editing `config.yaml` — environment variables take priority. Commonly used ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `PKTFLOW_CONFIG` | (none) | Path to `config.yaml` to load |
| `PKTFLOW_INSTALL_DIR` | (none) | Install directory `install.sh` deployed to; used by `pktflow.service` and the SSL/backup/config-restore paths |
| `PKTFLOW_HOST` | `0.0.0.0` | Bind address |
| `PKTFLOW_PORT` | `8766` | Listen port |
| `PKTFLOW_DB_PATH` | `/data/pktflow.db` | SQLite app database path |
| `PKTFLOW_CLICKHOUSE_HOST` / `_PORT` / `_DATABASE` / `_USER` / `_PASSWORD` | `localhost` / `9000` / `pktflow` / `default` / `` | ClickHouse connection |
| `PKTFLOW_SECRET_KEY` | (required) | JWT signing key — `openssl rand -hex 32` |
| `PKTFLOW_ADMIN_USER` / `PKTFLOW_ADMIN_PASSWORD` | (blank) | First-run admin seed — only used if no users exist yet |
| `PKTFLOW_CORS_ORIGINS` | `["*"]` | Restrict to your dashboard origin in production |
| `PKTFLOW_LOG_LEVEL` / `PKTFLOW_LOG_FILE` | `info` / `/data/logs/pktflow.log` | Logging |

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
- **Geo Map** — Leaflet dark map with D3 SVG arc overlays; ip-api.com geo lookup; arc classification by type (GlobalProtect VPN = green dash-dot, Site-to-Site VPN = blue dashed, WAN = solid red); circle markers colored by configurable site groups; collapsible VPN Sites panel (admin CRUD); map legend overlay; VPN site mapping resolves RFC-1918 private IPs to their firewall public IPs for accurate geo placement

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
- **Device registry** — name, IP, site per sampler; CSV import; live stats per device; **acts as an ingest allowlist, not just labeling** — flows from a sampler IP not present and enabled in the registry are dropped before storage, not just missing metadata
- **Unknown samplers** — IPs sending flows but not in the registry raise an alert (with a one-click link to pre-fill registration) and appear in Settings → Devices with dismiss support; their flows are not persisted until registered
- **Data retention** — configurable TTL for ClickHouse flows (default 90 days); manual cleanup trigger
- **Backup** — one-click or scheduled local backup (SQLite DB + ClickHouse flows export) with configurable rotation count
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
pktFlow (FastAPI, port 8766, HTTP/HTTPS)
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

| Component | Version | Notes |
|-----------|---------|-------|
| OS | Ubuntu Server 22.04 LTS or 24.04 LTS | systemd required |
| Python | 3.10+ (ships with Ubuntu 22.04/24.04) | venv created via `python3-venv` |
| ClickHouse | 24.x+ (installed by `install.sh` from the official apt repo) | |
| Node.js | 20.x LTS | Frontend build only, not installed by `install.sh` |
| npm | 10+ | Frontend build only |
| System packages | `python3-venv`, `python3-pip`, `libxmlsec1-dev`, `libxmlsec1-openssl`, `libxml2-dev`, `pkg-config`, `gcc`, `curl`, `ca-certificates`, `gnupg`, `apt-transport-https` | Installed by `install.sh`; `libxmlsec1*`/`pkg-config`/`gcc` are required to build `python3-saml`'s xmlsec bindings |

Node.js is not installed by `install.sh` — install it yourself before the frontend build step, e.g. via [NodeSource](https://github.com/nodesource/distributions):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

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

`install.sh` (see [Quick Start](#quick-start)) automates everything below except **step 10 (open the firewall)**, which is always manual. **Step 8 (build the frontend) is automated too, but only if `npm` is already on `PATH`** — `install.sh` does not install Node.js itself (see [Requirements](#requirements)); if `npm` isn't found, that step is skipped and the script's final banner prints the exact manual commands to run afterward. Note that `install.sh` creates the admin user and ingest token directly (printing a generated password at the end) rather than via the `admin_user`/`admin_password` config.yaml fields described in step 7; use whichever approach matches how you're installing. This section is the full manual walkthrough — useful to customize the install, run steps individually, or understand what the script does.

### 1. Clone the repository

```bash
git clone https://github.com/bsnwgit/pktflow.git
cd pktflow
```

All commands below assume you're in the repo root unless otherwise noted.

### 2. Create the install directory

```bash
INSTALL_DIR=/opt/pktflow
sudo mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/logs"
sudo chown "$(whoami):$(whoami)" "$INSTALL_DIR" "$INSTALL_DIR/logs"
```

`/opt` is root-owned by default, so this needs `sudo`. Steps 5–8 below run as your regular user against this now-owned directory; step 9 re-owns everything to whichever user/group the systemd service runs as.

### 3. System packages + ClickHouse

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    libxmlsec1-dev libxmlsec1-openssl libxml2-dev pkg-config gcc \
    curl ca-certificates gnupg apt-transport-https

# ClickHouse — official apt repo
curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
    | sudo gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
ARCH="$(dpkg --print-architecture)"
echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=${ARCH}] https://packages.clickhouse.com/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/clickhouse.list
sudo apt-get update
sudo apt-get install -y clickhouse-server clickhouse-client
sudo systemctl enable --now clickhouse-server
```

`libxmlsec1-dev`, `libxmlsec1-openssl`, `libxml2-dev`, `pkg-config`, and `gcc` are required to build `python3-saml`'s xmlsec native bindings.

### 4. Apply ClickHouse schema

```bash
clickhouse-client --multiquery < clickhouse/schema.sql
```

Creates `pktflow` database with `flows`, `flows_hourly`, `flows_daily` tables and two materialized views.

### 5. Install Python dependencies

```bash
python3 -m venv /opt/pktflow/venv
/opt/pktflow/venv/bin/pip install -r requirements.txt
```

### 6. Copy application files

`pktflow.service` runs `uvicorn app.main:app` with `WorkingDirectory=/opt/pktflow`, so the app package must live there — not just the venv:

```bash
cp -r app migrations clickhouse scripts /opt/pktflow/
```

### 7. Configure

```bash
cp config.example.yaml /opt/pktflow/config.yaml
# Edit config.yaml — set secret_key, db_path, cors_origins, admin_user, admin_password
openssl rand -hex 32   # use this as secret_key
```

Set `admin_user`/`admin_password` here — that's what lets you log in at all on a fresh install; the app creates that account on first startup (see [`_seed_admin_user`](app/database.py)) and it is not re-run once any user exists.

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
| `admin_user` | (blank) | Initial admin username — created on first run |
| `admin_password` | (blank) | Initial admin password — created on first run |
| `log_file` | `/opt/pktflow/pktflow.log` | Log path |

### 8. Build the frontend

`install.sh` does this automatically if `npm` is on `PATH` at install time. This is the manual equivalent, for running it yourself or rebuilding after a code change (see [Deployment](#deployment)).

Requires Node.js 20.x LTS. The frontend must be built on Linux — not on Windows (Windows `node_modules` lacks the Linux rollup native binary).

```bash
cp -r frontend /tmp/pktflow-fe
cd /tmp/pktflow-fe
npm install
npm run build > /dev/null 2>&1 && echo "build ok" || echo "BUILD FAILED"
cp -r dist /opt/pktflow/frontend/dist
```

### 9. Start the service

`pktflow.service` is a template — substitute the placeholders before installing it, or just run `install.sh` which does this for you:

```bash
sed \
    -e "s#__INSTALL_DIR__#/opt/pktflow#g" \
    -e "s#__LOG_DIR__#/opt/pktflow/logs#g" \
    -e "s#__SERVICE_USER__#$(whoami)#g" \
    -e "s#__SERVICE_GROUP__#$(whoami)#g" \
    pktflow.service | sudo tee /etc/systemd/system/pktflow.service
sudo systemctl daemon-reload
sudo systemctl enable --now pktflow
sudo systemctl status pktflow
```

### 10. Open the firewall

```bash
sudo ufw allow 8766/tcp
```

If using direct UDP ingest instead of a goflow2/Vector collector, also open the configured UDP port(s) (defaults: `2055` NetFlow, `6343` sFlow) — see Settings → Ingest.

### 11. Verify

```bash
curl -s http://localhost:8766/api/health
curl -s http://localhost:8766/api/ingest/stats
```

Log in at `http://<server-ip>:8766` with the `admin_user`/`admin_password` from step 7, then set the ingest token collectors will authenticate with at **Settings → Ingest**.

---

## SSL / HTTPS

pktFlow auto-detects SSL on startup. If `ssl/server.crt` and `ssl/server.key` exist under the data directory, it starts in HTTPS mode; otherwise HTTP.

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
| Direct UDP ingest enabled | Enable built-in NetFlow UDP listener. **Requires a service restart to take effect** — the listener only starts/stops at process startup, it does not react to this setting changing live. |
| UDP listen port | Port for direct UDP ingest (default 2055). **Requires a service restart to take effect.** |
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

> **Note:** Notification channels have not been end-to-end tested against live services. Verify `httpx`, `aiosmtplib`, and `jinja2` are installed before enabling.

### Storage

| Setting | Description |
|---------|-------------|
| Storage backend | `clickhouse` (production, default) or `duckdb` (**incomplete** — missing a required backend method, selecting it will crash the app on next restart; do not use until `app/storage/duckdb.py` implements `get_top_ports`). **Requires a service restart to take effect.** |
| Flow retention days | ClickHouse TTL for raw flows table (default 90) |
| Manual cleanup | Trigger immediate retention cleanup |

### Backup

| Setting | Description |
|---------|-------------|
| Auto backup | Run a scheduled backup at the configured interval |
| Interval | Hours between automatic backup runs (default 24) |
| Rotation count | Number of snapshots to keep before old ones are deleted (default 5) |
| Backup path | Destination directory for snapshots. Defaults to a `backups/` directory next to `pktflow.db` (i.e. inside the install directory) if left blank |
| Include ClickHouse | Also export the `flows` table to CSV alongside the SQLite snapshot |

Each run creates a timestamped `pktflow-backup-<UTC timestamp>/` directory containing a consistent copy of `pktflow.db` (via SQLite's own backup API, safe to run against a live database) and, if enabled, `flows.csv`. Trigger manually from Settings → Backup → **Run Backup Now**, or via `POST /api/system/backup`.

### Integrations

| Setting | Description |
|---------|-------------|
| SSL / TLS | Upload PFX/P12 or PEM cert+key; restart required to apply |
| Lucidchart API token | Enables "Export to Lucidchart" on the Topology page |

### System

- **Restart Service** — triggers a service restart; wait ~5 seconds for the service to come back. Tries `sudo systemctl restart pktflow` first; if the service user doesn't have passwordless sudo for that command (the common case), it falls back to sending itself `SIGTERM` and relying on systemd to bring it back up. **This fallback only works if `pktflow.service` has `Restart=always`** (the shipped template does) — with `Restart=on-failure`, a clean `SIGTERM` is not considered a failure by systemd and the service will stop and stay stopped instead of restarting. If you've customized the unit file, keep `Restart=always` or set up passwordless sudo for `systemctl restart pktflow` for this button to work reliably.
- **Backup** — see [Backup](#backup) above

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
uri = "http://<PKTFLOW_HOST>/api/ingest/flows"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN>"
request.timeout_secs = 10
healthcheck.enabled = false

# If connecting over HTTPS with a self-signed cert:
# [sinks.pktflow.tls]
# verify_certificate = false
```

The ingest token is in **Settings → Ingest**.

See [DATAFLOW.md](DATAFLOW.md) for the full Vector configuration including the `add_site` transform and field mapping reference.

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
│   │   ├── flows.py        GET /api/flows/* (includes /geo endpoint)
│   │   ├── alerts.py       Alert rules + events
│   │   ├── auth.py         Login, SAML, token refresh
│   │   ├── devices.py      Device registry CRUD + unknown samplers
│   │   ├── settings.py     App settings CRUD
│   │   ├── users.py        User management
│   │   ├── vpn_mappings.py VPN site mapping CRUD (/api/vpn-mappings)
│   │   ├── geo_config.py   Geo map config CRUD (/api/geo-config/*)
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
│   ├── database.py         SQLite init + migrations + first-run admin seed
│   └── main.py             App factory, lifespan, router registration
├── clickhouse/schema.sql   flows + rollup tables + materialized views
├── frontend/src/
│   ├── pages/              Dashboard, Analytics, DeviceView, FlowExplorer,
│   │                         Topology, GeoMap, Ports, Alerts, Settings, Users
│   ├── components/         Layout, AiAssistant
│   ├── api/client.ts       Typed API client + getToken() for WebSocket
│   ├── hooks/useWebSocket.ts  WebSocket hook
│   └── utils/protocols.ts  Shared protocol name map
├── migrations/             SQLite migration scripts (auto-applied on startup)
├── install.sh              Ubuntu install script (ClickHouse, venv, systemd service)
├── config.example.yaml     Config file template
├── pktflow.service         systemd unit template (placeholders filled in by install.sh)
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
| `GET` | `/api/flows/geo` | Geo-located IP pairs + arc type classification for Geo Map |
| `GET` | `/api/flows/rate` | Current flows/sec |
| `GET` | `/api/flows/export` | Download flows as CSV or JSON |
| `GET` | `/api/flows/devices` | Device summaries with live stats |

Common query parameters: `sampler_ip`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol`, `site`, `start`, `end`, `limit`, `offset`.

### VPN Site Mappings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/vpn-mappings` | JWT | List all VPN site mappings |
| `POST` | `/api/vpn-mappings` | Admin JWT | Create a new VPN mapping |
| `PUT` | `/api/vpn-mappings/{id}` | Admin JWT | Update a VPN mapping |
| `DELETE` | `/api/vpn-mappings/{id}` | Admin JWT | Delete a VPN mapping |

VPN mappings resolve private RFC-1918 CIDRs or single IPs to a public firewall IP and a site group. The `/api/flows/geo` endpoint uses these to show VPN traffic at the correct real-world location. `entry_type` is `gp` (GlobalProtect) or `s2s` (Site-to-Site), which determines arc color/style on the map.

### Geo Map Config

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET/POST/PUT/DELETE` | `/api/geo-config/site-groups` | Admin JWT | Site group definitions (color per group) |
| `GET/POST/PUT/DELETE` | `/api/geo-config/line-styles` | Admin JWT | Arc line style catalog |
| `GET/POST/PUT/DELETE` | `/api/geo-config/traffic-types` | Admin JWT | Traffic type → line style mappings |

### WebSocket

| Endpoint | Auth | Description |
|----------|------|-------------|
| `ws://<host>/api/ws/dashboard?token=<jwt>` | JWT query param | Push updates after each ingest flush |

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
3. Verify: `curl -s http://localhost:8766/api/health`

### Frontend changes

The frontend must be built on Linux — build on the server itself or a Linux CI runner, not on a Windows machine (Windows `node_modules` lacks the Linux rollup native binary).

```bash
# On the server (or a Linux build machine)
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
2. **goflow2 template errors after restart** — Normal. goflow2 loses cached NetFlow v9 templates on restart; "template error" log lines resolve within seconds when the router sends the next template packet.
3. **Collector orphan process** — If `goflow2-vector` is restarted while flows are active, the old goflow2 process may survive and hold port 2055. Symptom: service is `active` but no flows arriving. Fix: `sudo kill -9 <old_goflow2_pid>`.
4. **ClickHouse threading** — `clickhouse-driver` is not thread-safe. All calls are serialized with `threading.Lock()` in `clickhouse.py`.
5. **passlib/bcrypt on Python 3.12+** — Pin `passlib==1.7.4` and `bcrypt==4.0.1` to avoid attribute errors.
6. **Direct UDP ingest depends on a `netflow` library workaround** — the third-party `netflow` package (`bitkeks/python-netflow-v9-softflowd`) initializes its own template cache as a list, but its NetFlow v9 parser then indexes into that same object using the exporter's raw Template ID (commonly ≥256 for real hardware) as a dict-style key — this raises `IndexError` for any realistic Template ID, silently dropping every flow record after the first template arrives. `app/ingest/udp_listener.py` works around this by pre-seeding the template cache as `{"netflow": {}, "ipfix": {}}` (dicts) before the library ever gets a chance to install its own broken list default. If you upgrade the `netflow` dependency, re-verify this workaround is still needed (or still effective) against a real capture before relying on direct UDP ingest.

---

## Incomplete / Planned Features

| Feature | Status |
|---------|--------|
| Notification channels (Slack, Email, PagerDuty, Webhook) | Code written; not end-to-end tested against live services |
| Okta OIDC | SAML works; OIDC (`app/auth/okta.py`) not implemented |
| AI assistant | Code written; needs `anthropic` package in venv + API key in Settings |
| Topology node click → flow drill-down | Nodes not interactive beyond hover |
| Traffic by Port page | Not yet built — planned: port inventory, protocol mix, top ports, traffic chart |
| Sankey flow diagram | Not yet built — planned: D3-sankey `src_ip → dst_port → dst_ip` arc chart |
| Pie charts on Device View | Not built |
| Storage "Test Connection" button | UI exists, no backend endpoint |
| DuckDB backend | **Broken, not just unvalidated** — `DuckDBBackend` doesn't implement the abstract `get_top_ports` method required by `StorageBackend`, so selecting it crashes the app on next restart (`TypeError: Can't instantiate abstract class DuckDBBackend`). `storage_backend` now defaults to `clickhouse` everywhere specifically to avoid this; do not switch to `duckdb` until this method is implemented. |
| Migration mode / flow forwarding | UI toggle exists, no backend logic |

---

## Security Notes

- Change `secret_key` in `config.yaml` (or `PKTFLOW_SECRET_KEY` env var) before production use — `openssl rand -hex 32`
- Change the default admin password immediately after first login
- The ingest token is in **Settings → Ingest** and must match `auth.token` in each collector's `vector.toml`
- `cors_origins` should be restricted to your dashboard origin in production
- If using a self-signed cert or connecting by IP, set `verify_certificate = false` in Vector's TLS section
- SAML SP Entity ID must exactly match Okta's "Audience URI" — both derived from Base URL in Settings
