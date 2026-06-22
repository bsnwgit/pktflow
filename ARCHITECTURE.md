# pktFlow — Architecture Design

**Version:** 0.1 (pre-build)  
**Date:** 2026-06-22  
**Status:** Design / Discussion

---

## Overview

pktFlow is a purpose-built enterprise NetFlow visualization and alerting platform. It runs as an independent Python web service on the same EC2 as OpenObserve (`172.23.80.5`) but is completely isolated from it — own process, own storage, own port, no shared dependencies. Once live, the GoFlow2 collectors send NetFlow data exclusively to pktFlow; O2 is relieved of netflow duties entirely.

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Backend framework | **FastAPI** (Python) | Async, fast, auto-generates OpenAPI docs, native websocket support for live UI updates |
| ASGI server | **Uvicorn** | Production-grade, pairs with FastAPI |
| Storage (default) | **ClickHouse** | Columnar, purpose-built for high-volume append-only time-series; sub-second aggregations on billions of rows |
| Storage (alternate) | **DuckDB** | Embedded, zero-config; suitable for low-traffic deployments or dev/test |
| Background tasks | **APScheduler** | Lightweight in-process scheduler for alert evaluation, retention cleanup, aggregate rollups |
| Frontend | **React + TypeScript** | Best ecosystem for interactive data visualization |
| Charts / graphs | **Recharts + D3.js** | Recharts for time-series/bar; D3 for connection topology graphs |
| Styling | **Tailwind CSS** | Utility-first, consistent dark-mode-friendly UI |
| Build tooling | **Vite** | Fast dev server and bundler |
| Auth (local) | **JWT + bcrypt** | Stateless sessions, secure password storage |
| Auth (SSO) | **Okta OIDC** | Standard OIDC flow; configurable in settings |

---

## Repository Structure

```
pktFlow/
├── app/                          # Python backend (FastAPI)
│   ├── main.py                   # App factory, mounts routers, starts scheduler
│   ├── config.py                 # Runtime settings loader (DB-backed + env override)
│   ├── dependencies.py           # FastAPI dependency injection (db session, auth, etc.)
│   │
│   ├── api/                      # REST API routes
│   │   ├── ingest.py             # POST /api/ingest/flows  — receives GoFlow2 JSON
│   │   ├── flows.py              # GET /api/flows/*        — query flow data
│   │   ├── devices.py            # CRUD /api/devices       — device registry
│   │   ├── alerts.py             # CRUD /api/alerts/*      — rules + event history
│   │   ├── settings.py           # GET/PUT /api/settings   — all app settings
│   │   ├── auth.py               # POST /api/auth/*        — login, logout, Okta callback
│   │   └── users.py              # CRUD /api/users         — admin user management
│   │
│   ├── storage/                  # Storage abstraction layer
│   │   ├── base.py               # Abstract StorageBackend interface
│   │   ├── clickhouse.py         # ClickHouse implementation
│   │   ├── duckdb.py             # DuckDB implementation
│   │   └── factory.py            # Returns configured backend from settings
│   │
│   ├── ingest/                   # Ingest method implementations
│   │   ├── http_handler.py       # Processes GoFlow2 JSON POSTed by Vector
│   │   ├── udp_listener.py       # Direct UDP NetFlow v5/v9/IPFIX listener
│   │   └── normalizer.py         # Normalizes both sources to internal FlowRecord schema
│   │
│   ├── alerts/                   # Alert engine
│   │   ├── engine.py             # Evaluates alert rules on schedule
│   │   ├── rules.py              # Rule model + condition evaluators
│   │   └── notifiers/
│   │       ├── base.py           # Abstract Notifier interface
│   │       ├── email.py          # SMTP
│   │       ├── slack.py          # Slack Incoming Webhook
│   │       ├── webhook.py        # Generic HTTP webhook
│   │       ├── pagerduty.py      # PagerDuty Events API v2
│   │       └── inapp.py          # In-app notification store
│   │
│   ├── auth/
│   │   ├── local.py              # Local user auth (bcrypt + JWT)
│   │   ├── okta.py               # Okta OIDC handler
│   │   └── middleware.py         # Auth middleware + role enforcement
│   │
│   └── models/
│       ├── flow.py               # FlowRecord (internal normalized schema)
│       ├── device.py             # Device / sampler registry entry
│       ├── alert.py              # AlertRule + AlertEvent
│       ├── user.py               # User + Role
│       └── settings.py           # Settings model (stored in SQLite sidecar)
│
├── frontend/                     # React + TypeScript
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx     # All-devices overview
│   │   │   ├── DeviceView.tsx    # Per-device traffic deep dive
│   │   │   ├── FlowExplorer.tsx  # Search/filter raw flows
│   │   │   ├── Topology.tsx      # Network connection graph
│   │   │   ├── Alerts.tsx        # Alert rules + event history
│   │   │   └── Settings.tsx      # Settings page (tabbed)
│   │   ├── components/
│   │   │   ├── TrafficSparkline.tsx
│   │   │   ├── TopTalkersTable.tsx
│   │   │   ├── ConnectionGraph.tsx   # D3 force-directed / Sankey
│   │   │   ├── FlowTable.tsx
│   │   │   ├── AlertRuleEditor.tsx
│   │   │   └── SettingsPanel.tsx
│   │   ├── api/                  # Typed API client (fetch wrappers)
│   │   └── store/                # React context / lightweight state
│   ├── package.json
│   └── vite.config.ts
│
├── clickhouse/
│   └── schema.sql                # Table definitions + TTL + aggregation materialized views
│
├── migrations/                   # SQLite migrations (for settings/users/alerts DB)
│   └── 001_initial.sql
│
├── scripts/
│   ├── install.sh                # First-run setup (deps, ClickHouse, systemd)
│   └── migrate_from_o2.py       # One-time importer for historical O2 netflow data
│
├── pktflow.service               # systemd unit file
├── config.example.yaml           # Documented example config
├── requirements.txt
└── README.md
```

---

## Data Architecture

### Two-Database Model

pktFlow uses two separate databases:

**1. ClickHouse (flow data)** — the heavy store. All NetFlow records, pre-aggregated rollup tables.

**2. SQLite (application data)** — lightweight sidecar for everything else: users, settings, alert rules, alert events, device registry, notification logs. No ClickHouse dependency for application configuration — if flow storage is swapped to DuckDB, this sidecar stays the same.

### ClickHouse Schema

```sql
-- Raw flows (full resolution, 90-day default TTL)
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
    flow_dir     UInt8
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (sampler_ip, timestamp, src_ip, dst_ip)
TTL timestamp + INTERVAL 90 DAY;   -- configurable via settings

-- Hourly aggregates (1-year TTL, auto-populated via Materialized View)
CREATE TABLE flows_hourly (
    hour         DateTime,
    sampler_ip   IPv4,
    src_ip       IPv4,
    dst_ip       IPv4,
    dst_port     UInt16,
    protocol     UInt8,
    bytes        UInt64,
    packets      UInt64,
    flow_count   UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (sampler_ip, hour, src_ip, dst_ip, dst_port, protocol)
TTL hour + INTERVAL 365 DAY;

-- Daily aggregates (no TTL — retained indefinitely for long-term trending)
CREATE TABLE flows_daily (
    day          Date,
    sampler_ip   IPv4,
    bytes        UInt64,
    packets      UInt64,
    flow_count   UInt64,
    unique_src   UInt64,
    unique_dst   UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (sampler_ip, day);
```

**Storage projection at these retention tiers:**
- Raw 90 days: ~58 GB (at current ~641 MB/day compressed)
- Hourly 1 year: ~2–4 GB (heavily aggregated)
- Daily indefinite: negligible (< 1 MB/year)

---

## Ingest Pipeline

```
Network Device
    │  NetFlow v5/v9/IPFIX UDP
    ▼
GoFlow2 (existing)
    │  JSON per flow → stdout
    ▼
Vector (existing)
    │  HTTP POST to pktFlow ingest endpoint
    ▼
POST /api/ingest/flows
    │
    ├── Verify source IP is in allowed hosts list (429 if not)
    ├── Validate JSON schema
    ├── Enrich: look up sampler_ip in device registry → add sampler_name + site
    ├── Normalize to FlowRecord schema
    └── Batch buffer → flush to ClickHouse every 1,000 records or 2 seconds
```

**Ingest endpoint auth:** Bearer token (set in Settings → Ingest). Vector sends it as `Authorization: Bearer <token>` header. Same pattern Vector uses today with O2's basic auth.

**Direct UDP path** (alternate ingest method, off by default):
```
Network Device → UDP:2055 → pktFlow UDP Listener → normalize → ClickHouse
```
When enabled, pktFlow runs its own asyncio UDP server that handles NetFlow v5/v9/IPFIX and sFlow directly, bypassing GoFlow2 and Vector entirely.

**Migration mode** (settings toggle):
When enabled, pktFlow exposes a `/api/ingest/flows/passthrough` endpoint that accepts data, stores it locally, and also forwards a copy to the configured O2 URL. This allows running Vector with two sinks (pktFlow + O2) during validation with zero production risk.

---

## Authentication & Authorization

### Roles

| Role | Capabilities |
|------|-------------|
| **Admin** | Full access: settings, user management, alert rules, all views |
| **Analyst** | All views + alert rule management; no settings or user management |
| **Viewer** | Read-only: all dashboards and flow data; no alert management |

### Local Auth Flow
1. POST `/api/auth/login` → returns JWT (15-min access token + 7-day refresh token)
2. Frontend stores tokens in memory (not localStorage)
3. Auto-refresh via silent background call before expiry

### Okta OIDC Flow
1. Redirect to Okta authorization URL
2. Okta calls back to `/api/auth/okta/callback` with code
3. pktFlow exchanges code for ID token, extracts user info
4. Maps Okta groups to pktFlow roles (configurable in settings: "Okta group X → Admin")
5. Issues pktFlow JWT as above

Both auth methods can be active simultaneously. Settings control which are enabled.

---

## Settings Page Structure

**Tab 1 — General**
- Application name / display title
- Base URL (used for Okta redirect URIs and alert notification links)
- Timezone
- Date/time display format

**Tab 2 — Storage**
- Backend: `ClickHouse` (recommended) / `DuckDB` / `SQLite`
- ClickHouse: host, port, database, user, password — Test Connection button
- Data retention tiers:
  - Raw flow retention: `90 days` (default)
  - Hourly aggregate retention: `365 days` (default)
  - Daily aggregate retention: `indefinite` (default)
- Run retention cleanup: Manual trigger button + last-run timestamp

**Tab 3 — Ingest**
- Ingest method: `HTTP POST` (recommended) / `Direct UDP` / `Both`
- HTTP POST: bind address, port (`8081` default), ingest bearer token (auto-generated, regeneratable)
- Direct UDP: bind address, ports (NetFlow `2055`, sFlow `6343`)
- Allowed hosts: IP/CIDR whitelist for ingest sources (unauthorized sources rejected)
- Migration mode: toggle + O2 forwarding URL

**Tab 4 — Authentication**
- Auth methods enabled: Local / Okta / Both
- Local: password policy (min length, complexity)
- Okta OIDC: Issuer URL, Client ID, Client Secret, Redirect URI
- Okta group → role mapping (table: Okta Group Name → pktFlow Role)
- Session timeout

**Tab 5 — Notifications**

Each channel has an Enable toggle + its own config block. None are required.

| Channel | Config Fields |
|---------|--------------|
| **Email** | SMTP host, port, TLS, username, password, from address, default recipient(s) |
| **Slack** | Incoming webhook URL, default channel |
| **PagerDuty** | Events API v2 integration key, default severity mapping |
| **Webhook** | URL, HTTP method, custom headers, payload template (Jinja2) |
| **In-app** | Always on. Max notification retention (default 30 days) |

Each channel has a "Send Test" button to verify config before saving.

**Tab 6 — Devices**
- Device registry table: Sampler IP | Name | Site | Notes | Actions
- Add / edit / delete entries
- Import from CSV
- "Unknown samplers" section: IPs that have sent data but aren't in the registry (prompts to add or block)

---

## Alert Engine

The alert engine runs on a configurable schedule (default: every 60 seconds) via APScheduler. Each enabled alert rule is evaluated against the ClickHouse flows table.

### Alert Rule Types

| Type | Description | Example |
|------|-------------|---------|
| **Threshold** | Aggregate metric exceeds a value in a time window | Total bytes from src_ip X > 5 GB in 15 min |
| **Rate spike** | Metric exceeds N% of rolling baseline | Flow count for device Y > 300% of 7-day avg |
| **Port/protocol** | Flow matches a condition | Any flow to port 22/3389 from non-RFC1918 |
| **New host** | IP not in device registry sends flows | Unknown sampler appears |
| **Data gap** | No flows received from a known sampler for N minutes | Medical collector silent for >10 min |

### Alert Rule Schema

```
AlertRule:
  name: string
  description: string
  enabled: bool
  type: threshold | rate_spike | port_protocol | new_host | data_gap
  conditions: JSON (type-specific)
  time_window_minutes: int
  severity: info | warning | critical
  channels: list[email | slack | pagerduty | webhook | inapp]
  cooldown_minutes: int   # min time before re-firing same rule
  created_by: user_id
  last_fired: datetime
```

### Notification Flow

```
Alert engine fires
    │
    ├── Write AlertEvent to SQLite
    ├── In-app: mark as unread in notification store
    └── For each configured channel on this rule:
        ├── Email → SMTP send
        ├── Slack → POST to webhook URL
        ├── PagerDuty → Events API v2 trigger
        └── Webhook → HTTP POST with Jinja2-rendered payload
```

---

## UI Screens

### 1. Dashboard (default landing page)
- Header: total flows/sec (live, websocket-updated), active alerts badge, time range selector
- Device grid: one card per sampler showing:
  - Sampler name + site
  - Current bps / pps (live sparkline, last 60 min)
  - Top 3 src IPs (last 1 hour)
  - Protocol donut (TCP / UDP / ICMP / Other)
  - Click → Device View

### 2. Device View
- Sampler name + IP in header, time range selector (1h / 6h / 24h / 7d / 30d / custom)
- Traffic volume chart (time-series, bytes + packets dual-axis)
- Top Talkers table: src_ip, dst_ip, dst_port, protocol, bytes, packets, % of total
- Connection graph: D3 Sankey or force-directed showing src → dst flows (weight = bytes)
- Export: CSV download of current view

### 3. Flow Explorer
- Filter bar: src IP, dst IP, src port, dst port, protocol, sampler, time range
- Results table with pagination (50 rows/page): timestamp, sampler, src, dst, port, proto, bytes, packets, duration
- Click a row: expand to show all flows between that src/dst pair in the same window
- Export: CSV

### 4. Topology View
- Network-wide connection graph (all samplers, all flows, aggregated by IP pair)
- Time range selector
- Filter by: sampler, protocol, minimum bytes threshold (to reduce noise)
- Node click: highlights all flows to/from that IP, links to Device View

### 5. Alerts
- Two tabs: **Active/Recent** (event list with severity, rule name, time, message, ACK button) and **Rules** (rule list with enable/disable toggles, edit, delete, + New Rule button)
- New/Edit Rule: guided form with condition builder, channel selection, test-fire button

### 6. Settings
- Tabbed as described in Settings Page Structure above
- All changes require explicit Save per tab
- Destructive changes (change storage backend, wipe data) require confirmation modal

---

## Deployment

### Process Layout on EC2 (172.23.80.5)

```
systemd
├── openobserve.service    (existing, port 5080)
├── clickhouse-server.service   (new, port 9000/8123, localhost only)
└── pktflow.service        (new, port 8080 — web UI + API)
```

pktFlow's web UI and API both serve on port `8080`. ClickHouse binds to localhost only (not externally exposed).

### pktflow.service (systemd)

```ini
[Unit]
Description=pktFlow NetFlow Platform
After=network.target clickhouse-server.service
Requires=clickhouse-server.service

[Service]
User=ec2-user
WorkingDirectory=/mnt/software/pktflow
ExecStart=/mnt/software/pktflow/venv/bin/uvicorn app.main:app \
    --host 0.0.0.0 \
    --port 8080 \
    --workers 2 \
    --log-level info
Restart=on-failure
RestartSec=5
StandardOutput=append:/mnt/software/logs/pktflow.log
StandardError=append:/mnt/software/logs/pktflow.log

[Install]
WantedBy=multi-user.target
```

### Vector Migration (collector side)

**Phase 1 — Parallel (validation period):**
Add pktFlow as a second sink in `vector.toml` alongside the existing O2 sink:
```toml
[sinks.pktflow]
type = "http"
uri = "http://172.23.80.5:8080/api/ingest/flows"
inputs = ["add_site"]
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<ingest_token_from_settings>"
```

**Phase 2 — Cutover:**
Remove the O2 sink from both `vector.toml` files. Restart `goflow2-vector.service` on each collector.

---

## Build Phases

| Phase | Scope |
|-------|-------|
| **Phase 1 — Foundation** | FastAPI skeleton, ClickHouse schema, HTTP ingest endpoint, basic flow storage + query API, React shell with Dashboard stub |
| **Phase 2 — Core UI** | Dashboard live view, Device View with charts, Flow Explorer table |
| **Phase 3 — Auth** | Local user auth (JWT), Settings page (storage, ingest, allowed hosts) |
| **Phase 4 — Alerts** | Alert engine (threshold + data gap rules), in-app notifications, Settings → Notifications tab |
| **Phase 5 — Enterprise** | Okta OIDC, all notification channels (email/Slack/PagerDuty/webhook), Topology view, alert rule builder UI |
| **Phase 6 — Polish** | DuckDB alternate backend, UDP ingest option, migration mode, historical O2 import script, install.sh |
