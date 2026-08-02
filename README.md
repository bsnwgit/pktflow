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

# 2. Run the installer — prompts for install directory (default /opt/pktflow)
#    and port (default 8766) when run interactively, then handles system
#    packages, ClickHouse, Python deps, schema, config.yaml + secret key,
#    admin user, frontend build (if npm is present), systemd service
#    (installed + started)
bash install.sh
# Prints the admin password and ingest token at the end — save them, they are
# not shown again. If npm wasn't found, the final banner prints the exact
# manual frontend-build commands to run before the web UI will load.

# 3. Open the firewall for the app port (whatever you entered at the prompt, default 8766)
sudo ufw allow 8766/tcp

# 4. Open http://<server-ip>:8766 (or your chosen port) and log in with the admin credentials from step 2
```

Both prompts are skippable for scripted/unattended installs via env vars: `PKTFLOW_INSTALL_DIR` and `PKTFLOW_PORT` (see [Environment variables](#environment-variables) below — these are read by `install.sh` itself, not just the running app).

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
- **Direct UDP ingest** — optional built-in NetFlow v5/v9/IPFIX/sFlow listener (no external collector required); Settings → Ingest's "Ingest method" selects `http` / `udp` / `both`
- **Source IP allowlist** — Settings → Ingest → "Allowed source IPs" (exact IPs and/or CIDRs, comma-separated) restricts which hosts may POST to `/api/ingest/flows` at all, on top of the bearer token check; empty = allow any source. A rejected source triggers the same unknown-sampler alert path as an unregistered device.
- **Ingest buffer** — in-memory batch buffer; flush interval (`ingest_buffer_flush_secs`, default 2s) is a `config.yaml`/env-var setting (`PKTFLOW_INGEST_BUFFER_FLUSH_SECS`), not currently exposed in the Settings UI. WebSocket broadcasts to connected browsers on every flush.
- **Invalid sampler filtering** — flows with `0.0.0.0` sampler address are rejected at ingest
- **NAT Information Elements** — the direct UDP listener (not the goflow2/Vector HTTP path — see NAT Translations below) decodes the standard IANA NAT fields when an exporter sends them (IPFIX `postNATSourceIPv4Address`/`postNATDestinationIPv4Address`/`natEvent`, or NetFlow v9's equivalent `NF_F_XLATE_*` fields) and stores them alongside the flow, feeding the NAT Translations page

### Dashboards & Visualization
- **Real-time dashboard** — flows/sec counter with live WebSocket updates (green dot = live, falls back to polling)
- **Analytics** — traffic timeseries charts; short-range (REST) and long-range (hourly/daily rollup) views
- **Device View** — per-sampler traffic history, top talkers table, protocol distribution
- **Flow Explorer** — search and filter flows by IP, port, protocol, time range; **Any direction** toggle turns Source/Destination IP into an either-side match (one IP set matches it on either side; both set matches the full two-way conversation between them, regardless of which leg recorded which direction); server-side pagination with a sliding page-number bar (Prev/Next, `1 ..` / `.. N` jump shortcuts) and a page-size selector (25/50/75/100, default 25); CSV/JSON/PCAP export (all respect the any-direction filter); any public source/destination IP is a clickable link to the IP Lookup modal (see below)
- **Network Topology** — two layouts, toggled per view. **Hierarchical** (default) is a fixed 3-band diagram per NetFlow sampler: private devices grouped into labeled `/24` subnet boxes at top, a single generic **L3** pivot node in the middle (deliberately no IP/stats — it represents the network boundary itself, not a guessed router), external destinations at bottom. A destination reached by several internal hosts renders once with several lines converging on it, never duplicated or chained through unrelated conversations; private↔private traffic (which never crosses the L3 boundary) draws as a direct dashed line instead. Hovering a device highlights its own line plus only the specific peers it actually reaches, in a brighter accent color; hovering L3 lights up everything that sampler observed. Clicking a device (or a private↔private link) deep-links into Flow Explorer, any-direction-filtered to that traffic for the current window. **Force** keeps the original free-floating D3 graph with site clustering. Export to PNG, SVG, JSON, DOT, Draw.io, or Lucidchart (Lucidchart mirrors the same 3-band structure)
- **Geo Map** — Leaflet dark map with D3 SVG arc overlays; ip-api.com geo lookup; circle markers colored by configurable **Sites** — a Site's IP/CIDR field colors the remote end of a flow by direct IP/CIDR match, while **NAT Mappings** (private→public CIDR/IP topology, renamed from Address Mappings; multiple rows may share the same private/public CIDR, priority order resolves conflicts) color the local end by resolving RFC-1918 traffic to the correct physical site; a NAT Mapping's own optional Destination CIDR/Port lets the SAME private range resolve to a DIFFERENT public CIDR depending on the flow's destination (e.g. a firewall NATing DNS out one IP and everything else out another) — resolved per flow pair, so the same private IP can legitimately produce two map markers if its real NAT genuinely varies; an **ISP DHCP** toggle handles networks with no static public IP by locking all mappings and substituting one synthetic catch-all; every install has one locked-key **Default** site that new NAT Mappings fall back to; arc styling comes entirely from NAT Mappings + **Traffic Rules** (priority-ordered, drag-and-drop, matches on NAT mapping / destination (typed CIDR or a Site — mutually exclusive, locked once set) / destination port to pick a Line Style) — see Settings → Geo Map; dynamic, clickable legend shows only the Traffic Rules/Sites/NAT Mappings actually present on screen (Sites/NAT Mappings additionally gated on "show in legend"), labeled by rule/site/mapping name — click any entry to filter the map to it plus everything it connects to, multiple selections union across categories, a Reset row appears once something's selected, and the filter clears automatically on the next refresh; both legs of a bidirectional conversation resolve against the same normalized service port and always merge into one arc
- **Traffic by Port** (`/ports`) — protocol mix, top ports by bytes/flows, traffic-over-time chart, full port inventory table
- **NAT Translations** (`/nat-translations`) — table of observed original-address → NAT'd-address mappings (e.g. a VLAN or subnet egressing through a different public IP than the rest of the network, even via the same physical WAN interface), aggregated from flows carrying NAT Information Elements. This is real flow-telemetry data, not device configuration or a vendor-specific integration — it works for any exporter that sends standard NAT event fields, with no vendor-specific code. Two hard requirements: (1) the sending device must be configured to export NAT event data — this is a Cisco ASA/ISR (NSEL), Juniper SRX, or pfSense/OPNsense-with-NAT-logging-class capability; most consumer/prosumer routers (including most UniFi/EdgeOS gear) don't support it at all, so an empty table is expected on many networks, not a bug; (2) the sampler must be pointed at pktFlow's **direct UDP listener** (Settings → Ingest → "Ingest method" = `udp` or `both`) — the goflow2/Vector HTTP ingestion path normalizes everything into goflow2's own fixed protobuf schema, which has no NAT fields, so NAT data sent through that path is silently unavailable regardless of what the exporter sends. Filterable by sampler and time window; each row shows direction (source/egress vs. destination/inbound NAT), byte/flow counts, and last-seen time.
- **Sankey flow diagrams** — a network-wide src→dst view on Analytics, and a per-device top-talkers flow map on Device View
- **IP Lookup** — any public (non-RFC1918) IP address shown in Flow Explorer, Device View, Topology, or Alerts is a clickable link that opens a modal combining ipinfo.io (geolocation/ASN/org, plus company/privacy/abuse-contact on paid plans), ipapi.is (geolocation, ASN/org, company, abuse contact, VPN/proxy/Tor/datacenter/abuser detection — usable with no API key at all via a "use free tier" toggle, ~1,000 lookups/day), AbuseIPDB reputation score, and MXToolbox reverse-DNS/ASN/blacklist data, using each user's own API keys (see Settings → User Keys below). Each provider can be shown/hidden in the modal independently (per-provider on/off toggle), and ipinfo.io/ipapi.is further break down into per-field checkboxes (geolocation, ASN/org, company, privacy/threat detection, abuse contact, hosted domains) so a user can hide sections they don't want to see. Any `ASxxxx` shown in the modal is itself a clickable link (`AsnLink` component) that opens a second modal with ipinfo.io's ASN-level details. MXToolbox's other commands — email/DNS record checks (SPF/DMARC/DKIM/MX/etc.) and active probes (ping/traceroute/TCP/HTTP/HTTPS/SMTP) — are reachable via the API but not surfaced in this modal yet.
- **Internal IP Lookup (pktIPAM)** — private/RFC1918 IPs are also clickable (styled with a purple dashed underline + network icon instead of the public lookup's search icon): the modal calls out to a connected pktIPAM instance (see Settings → Security → Suite Integration → Sibling pkt Apps) and shows subnet/site, IP inventory status/hostname/MAC/owner, the active DHCP lease, DNS records, and last-seen ARP entry. If no pktIPAM connection is configured, the modal shows a link straight to that settings page instead of erroring. Addresses that aren't well-formed IPv4 (or are otherwise unparseable) still render as plain text.

### Alerting
- **data_gap** — fires when a known sampler goes silent for a configurable period; dismissed samplers are excluded
- **new_host** — fires when a previously unseen sampler IP sends flows
- **threshold** — fires when bytes/packets/flows in a time window exceed a configured value
- **rate_spike** — fires when current rate exceeds the 7-day rolling baseline by a configurable multiplier
- **port_protocol** — fires when specific port/protocol/direction combinations appear in recent flows
- **Auto-resolve** — open alert events self-close when the condition clears on the next evaluation cycle
- **ACK support** — analysts can acknowledge alerts without closing them
- **Alert cleanup** — configurable retention period; old events are purged on a schedule
- **Bulk rule provisioning** — Export CSV / Import CSV / template-download on the Rules tab; `conditions` round-trips as a JSON object string (shape depends on `rule_type`), `channels` as a comma-separated column
- **Investigate button** — every active/history alert card deep-links straight to Flow Explorer, pre-filtered to the alert's time window plus whatever sampler/src IP/dst port/protocol its details carry
- **Active/History time-range filter** — both alert tabs share the same search + severity + time-range filter bar as Application Logs (below)
- **Active/History pagination** — both tabs paginate client-side (default 25 events/page, selectable 25/50/75/100 independently per tab) with the same sliding page-number bar (Prev/Next, `1 ..` / `.. N` jump shortcuts) used elsewhere in the app; filtering by text/severity/time-range resets back to page 1

### Authentication & Users
- **Local auth** — JWT + bcrypt, configurable token lifetime
- **SAML 2.0 (Okta)** — SP-initiated SSO; users auto-provisioned on first login
- **Roles** — `admin` (full access), `analyst` (read + export), `viewer` (read-only)
- **User management page** — admin can create users, reset passwords, toggle active status
- **Default admin / auto-login** — exactly one active admin account can be flagged (★, in Settings → Security → Users) as the "default admin." If an admin ever disables **both** Local auth and SAML SSO in Settings → Security → Auth, the app skips the login page entirely and auto-signs everyone in as that account (`POST /api/auth/auto-login`) instead of dead-ending into a login form nobody can pass. This only activates when every auth method is off — with either enabled, auto-login is refused (403).

### Settings & Configuration
All configuration is managed via the Settings UI (no file edits required after install, except the listen port — see General below). Settings are stored in SQLite and survive restarts. See [Application Settings](#application-settings) for the full tab-by-tab reference.

- **User Keys** — every logged-in user (not just admins) has their own "User Keys" tab to store personal keys for AbuseIPDB, ipinfo.io, and IPQualityScore, used by the IP Lookup feature above (this tab also holds the app-wide Lucidchart token). Keys are scoped strictly to the owning user — nobody else, including admins, can see the value. Each field has a "Test" button that calls the real provider API with a harmless test IP to validate the key before saving.
- **Contextual help** — a small blue "?" (`HelpButton`) next to every page heading and every Settings section opens a modal explaining how that feature actually works, instead of permanent inline text blocks. Rolled out across every main nav page (Analytics, Flow Explorer, Device View, Topology, Geo Map, Traffic by Port, Alerts, Logs) and every Settings section.

### Integrations
- **SSL/TLS** — upload a PFX/P12 bundle or separate PEM cert+key via drag-and-drop; service is intended to auto-detect SSL files on startup (Settings → Security → SSL/TLS) — see [Known Issues & Quirks](#known-issues--quirks) for a verification gap between this and the current process entrypoint
- **Lucidchart** — topology export directly to a Lucidchart document via API token (Settings → User Keys)
- **Suite Integration (inbound)** — one-directional discovery token that lets pktHub's App Manager proxy into pktFlow with users already signed in (Settings → Security → Suite Integration)
- **Sibling pkt Apps (outbound)** — named connections *from* pktFlow *to* one or more pktIPAM instances, used for the Internal IP Lookup feature above. Configured in Settings → Security → Suite Integration → Sibling pkt Apps: add a connection with pktIPAM's base URL and the Suite Token copied from that pktIPAM's own Settings → Integrations → Suite Integration page. Multiple named pktIPAM connections are supported; the first *enabled* one is used for lookups. Each has a "Test Connection" button that authenticates against the real `/api/suite/whoami` endpoint (not just a port-reachability check), so a wrong/revoked token fails the test instead of reporting a false-healthy connection.

### Infrastructure
- **Device registry** — name, IP, site per sampler; CSV import/export + downloadable template; live stats per device; **acts as an ingest allowlist, not just labeling** — flows from a sampler IP not present and enabled in the registry are dropped before storage, not just missing metadata. The allowlist is an in-memory cache (`app/ingest/normalizer.py`'s `_device_cache`) that's now warmed from the registry at process startup (`app/main.py` lifespan) — previously it was only ever populated reactively by device create/edit/delete through the UI, so **every service restart silently dropped all incoming flow data** as "unregistered" until someone happened to edit a device afterward, even though the registry itself was correct the whole time
- **Application Logs** — search + level filter, plus a time-range dropdown (1h/6h/24h/7d/30d/All time/Custom range) for narrowing down a large log history; custom range validates the end is after the start and disallows future times. The table paginates server-side (default 25 rows/page, selectable 25/50/75/100) with a sliding page-number bar above it — Next/Prev move the visible window of 5 page numbers along with you, plus `1 ..` / `.. N` shortcuts to jump straight to the first/last page
- Alert-event and last-login timestamps are normalized to UTC before parsing so they display correctly regardless of the browser's local timezone
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

`pktflow.service` runs `python -m app.server` (see [`app/server.py`](app/server.py)), not a `uvicorn ... --port` command line — the entrypoint reads `host`/`port` from `config.yaml` itself at process start. This is what lets Settings → General → Port (below) actually take effect on the next restart: saving that field just rewrites `port:` in `config.yaml`, and the next process start picks it up here, with no unit-file edit needed.

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

pktFlow auto-detects SSL at process startup: `app/server.py`'s `main()` (the actual systemd entrypoint — `ExecStart=... python -m app.server`) reads `ssl_enabled`/`ssl_certfile`/`ssl_keyfile` directly from the SQLite settings table before calling `uvicorn.run()`, and passes `ssl_certfile`/`ssl_keyfile` through to uvicorn when a cert is enabled and both paths are present.

> This was previously broken — the SSL-reading logic lived in a dead `if __name__ == "__main__":` block in `app/main.py` that neither the systemd unit nor a direct `uvicorn app.main:app ...` invocation ever executed, since both import `app.main` as a module. Fixed by moving the logic into `app/server.py::main()`; the orphaned `start.sh` wrapper (which built the SSL args correctly but was never referenced by `install.sh` or the systemd unit) was removed as part of the same fix. Still worth a real cert upload + restart + `curl -k https://localhost:<port>/api/health` to confirm end-to-end in your own environment, but the code path is no longer dead.

**To enable HTTPS:** go to **Settings → Security → SSL / TLS**, drag-and-drop a PFX/P12 bundle (with passphrase) or separate PEM cert + key files, then restart the service. The restart button is in **Settings → General**.

**To disable HTTPS:** delete the cert via the same Settings panel, then restart.

---

## Application Settings

All settings are in the browser UI at `/settings`. Changes take effect immediately (no restart needed unless otherwise noted). The top-level tab bar is: **General · Security · Data · Notifications · User Keys · Sources · Geo Map · Ingest**. Security and Data each have their own left-hand sub-tab strip.

### General

| Setting | Description |
|---------|-------------|
| App name | Displayed in browser tab and header |
| Port | Port the app listens on — written to `config.yaml`, not the SQLite settings table. **Requires a service restart to take effect**, and the browser will need to follow the app to the new port/URL afterward. Backed by `GET`/`POST /api/system/port`. |
| Base URL | Public-facing URL of the app — used to build the SAML ACS URL/entity ID and any links posted in Slack/Email/webhook notifications. Set this to the actual externally-reachable address *before* configuring SSO or notifications. |
| Timezone | Affects display of timestamps in the UI |
| Restart Service | Triggers a service restart; wait ~5 seconds for the service to come back. Tries `sudo systemctl restart pktflow` first; if the service user doesn't have passwordless sudo for that command (the common case), it falls back to sending itself `SIGTERM` and relying on systemd to bring it back up. **This fallback only works if `pktflow.service` has `Restart=always`** (the shipped template does) — with `Restart=on-failure`, a clean `SIGTERM` is not considered a failure by systemd and the service will stop and stay stopped instead of restarting. If you've customized the unit file, keep `Restart=always` or set up passwordless sudo for `systemctl restart pktflow` for this button to work reliably. |

### Security

Left-hand sub-tabs: **Users** (admin only) · **Auth** · **Suite Integration** · **AI Assistant** · **SSL / TLS**.

#### Security → Users (admin only)

Admin can create users, reset passwords, toggle active status, and assign roles (`admin` / `analyst` / `viewer`). This tab only manages local accounts — SAML/Okta SSO users are auto-provisioned on first login and managed in Okta itself.

The ★ / ☆ button next to a username marks the **default admin** — the account auto-logged-in when both Local auth and SAML SSO are disabled on the Auth sub-tab below (see [Authentication & Users](#authentication--users) above). Only one user can hold it at a time (setting it clears it from every other user); only an active admin account is eligible.

#### Security → Auth

| Setting | Description |
|---------|-------------|
| Local auth | Allow username/password login |
| Session timeout | JWT expiry, in minutes |
| Enable SAML SSO | Turns on Okta SP-initiated SSO |
| IdP SSO URL / IdP Entity ID / IdP certificate | From Okta's IdP metadata — a "Paste IdP Metadata XML" box auto-fills these three from Okta's raw metadata document |
| SP Entity ID | Defaults to the auto-generated metadata URL; must match "Audience URI" in the Okta app settings if overridden |
| ACS URL (read-only) | Register this as the Single Sign-On URL in the Okta app. Both this and the SP metadata link are derived from **Base URL** on the General tab — set that first |
| SP Certificate / SP Private Key | Optional — only needed if signing outbound SAML requests |

Local auth and SAML aren't mutually exclusive — both can be enabled at once. Okta OIDC is not offered here; it was deliberately dropped (`app/auth/okta.py` is an intentional no-op) in favor of SAML 2.0, which already covers Okta SSO.

#### Security → Suite Integration

Two sections on this sub-tab:

- **Suite Integration (inbound)** — the Suite Token pktHub's App Manager uses to proxy into pktFlow with users already signed in. Regenerating it immediately revokes the old one.
- **Sibling pkt Apps (outbound)** — named connections *from* pktFlow to one or more pktIPAM instances, powering the Internal IP Lookup feature (see [Features](#features) above). Add a connection with a name, pktIPAM's base URL, and the Suite Token copied from that pktIPAM's own Settings → Integrations → Suite Integration page. Each has Test/Edit/Delete actions; "Test Connection" round-trips a real authenticated call to `/api/suite/whoami` on the target, so a wrong or revoked token fails the test instead of just checking the port is open.

#### Security → AI Assistant

| Setting | Description |
|---------|-------------|
| Anthropic API key | Required to enable the AI assistant panel. From console.anthropic.com — separate from a Claude Enterprise seat |
| AI model | Model used for the assistant. Default `claude-haiku-4-5-20251001` (fast/cheap); selectable alternatives are Sonnet (`claude-sonnet-5`, balanced) and Opus (`claude-opus-4-8`, most capable) |

#### Security → SSL / TLS

Upload a PFX/P12 bundle or separate PEM cert+key via drag-and-drop; the running service auto-detects and loads whichever was uploaded, at startup. See [SSL / HTTPS](#ssl--https) above.

### Data

Left-hand sub-tabs: **Storage** · **Backups**.

#### Data → Storage

| Setting | Description |
|---------|-------------|
| Storage backend | `clickhouse` (production, default) or `duckdb` (embedded, no external service required). **Requires a service restart to take effect.** |
| Flow retention days | ClickHouse TTL for raw flows table (default 90) |
| Manual cleanup | Trigger immediate retention cleanup |
| Test Connection | `POST /api/system/test-connection` — verifies the currently configured backend is reachable |

> DuckDB implements the core query paths (search, top talkers/ports, protocol distribution, topology). A handful of alert-engine detail queries (baselines, elephant-flow/threshold/port-scan/inter-site/asymmetric-flow lookups — 19 methods in `app/storage/duckdb.py`) deliberately raise `NotImplementedError` under DuckDB rather than being built out — those specific alert rule types are ClickHouse-only for now.

#### Data → Backups

| Setting | Description |
|---------|-------------|
| Auto backup | Run a scheduled backup at the configured interval |
| Interval | Hours between automatic backup runs (default 24) |
| Rotation count | Number of snapshots to keep before old ones are deleted (default 5) |
| Backup path | Destination directory for snapshots. Defaults to a `backups/` directory next to `pktflow.db` (i.e. inside the install directory) if left blank |
| Include ClickHouse | Also export the `flows` table to CSV alongside the SQLite snapshot |

Each run creates a timestamped `pktflow-backup-<UTC timestamp>/` directory containing a consistent copy of `pktflow.db` (via SQLite's own backup API, safe to run against a live database) and, if enabled, `flows.csv`. Trigger manually from Settings → Data → Backups → **Run Backup Now**, or via `POST /api/system/backup`.

Each listed snapshot has a **Restore…** link that restores directly from that on-server snapshot — no need to download and re-upload it. Expanding it shows a checkbox per file present in the snapshot (`pktflow.db`, `config.yaml`, `flows.csv`/`flows.csv.gz`), so you can restore just one piece instead of always restoring everything together; the same per-file selection is available on the bundle-upload restore. Every restore requires confirmation and, for `config.yaml` changes, a service restart to take effect.

### Notifications

Notification channels are configured per-alert-rule. Available channels:

| Channel | Status |
|---------|--------|
| Slack webhook | Code written; requires webhook URL |
| Email (SMTP) | Code written; requires SMTP host, port, credentials |
| PagerDuty | Code written; requires integration key |
| Webhook | Code written; requires endpoint URL |
| Tracecat | Code written; requires webhook URL + API token |

Each channel has a "Send Test" button (`POST /api/settings/test-notification`) that dispatches a real test message using the saved settings — not yet confirmed fired against a live Slack/SMTP/PagerDuty/Tracecat endpoint in production, but the endpoint itself is implemented, not a stub.

### User Keys

Every logged-in user (not just admins) manages their **own** keys here for AbuseIPDB, ipinfo.io, ipapi.is, MXToolbox, and IPQualityScore — used by the public IP Lookup feature (IPQualityScore can be saved/tested but isn't consumed by the lookup yet). Keys are scoped strictly to the owning user; nobody else, including admins, can see the value. Each field has a "Test" button that calls the real provider API with a harmless test IP before saving. Leaving a field blank and saving clears that key.

For ipinfo.io, ipapi.is, AbuseIPDB, and MXToolbox — the four providers actually wired into the IP Lookup modal — a checkbox toggles the whole provider's section on/off in the modal, and ipinfo.io/ipapi.is additionally expose per-field checkboxes (geolocation, ASN/org, company, privacy/threat detection, abuse contact, hosted domains) to hide individual pieces of data. ipapi.is also has a "Use free tier" toggle that skips the API key requirement entirely (~1,000 lookups/day, no key needed).

This tab also holds the app-wide **Lucidchart API token** (a Personal Access Token from lucid.co → Account → API Tokens), which enables "Export to Lucidchart" on the Topology page — this one setting is shared across all users, unlike the personal keys above it.

### Sources (Devices)

The device registry maps sampler IPs to human-readable names and sites. Devices appear on Device View and the sampler dropdown throughout the UI. (Sidebar/Settings tab label is "Sources" — not to be confused with the goflow2/Vector "collector" hosts described under [Collector Configuration](#collector-configuration) below, which is a different meaning of "collector".)

- Add devices manually or **import from CSV** (columns: `name`, `ip`, `site`, `description`)
- **Unknown Samplers** panel shows IPs sending flows that are not in the registry; dismiss to suppress the `new_host` alert without adding to the registry

### Geo Map

Admin-only tab covering Sites, NAT Mappings, Traffic Rules, and Line Styles — see [Geo Map](#dashboards--visualization) under Features above for what each does.

### Ingest

| Setting | Description |
|---------|-------------|
| Ingest method | `http` (goflow2 + Vector POSTing to `/api/ingest/flows` — recommended), `udp` (built-in direct listener only), or `both`. **Changing this or either UDP port requires an actual service restart** — the UDP listener only starts/stops at process startup, saving the form alone doesn't switch anything live. |
| Ingest token | Bearer token required on the HTTP POST ingest endpoint. Leave blank in the form to keep the current (masked) value. |
| HTTP port | Informational display field (`ingest_http_port`, default 8766) describing the port pktFlow listens on for ingest — this is a separate SQLite-stored value from the actual bind port and is not itself wired to change anything; the port the process actually listens on is set via **Settings → General → Port** (config.yaml). Don't expect editing this field to move the app to a new port. |
| UDP NetFlow port | Port for direct UDP NetFlow ingest (default 2055). **Requires a service restart to take effect.** |
| UDP sFlow port | Port for direct UDP sFlow ingest (default 6343) |
| Allowed source IPs | Comma-separated exact IPs and/or CIDR blocks. Empty = allow ingest from any source. Enforced in `app/api/ingest.py` on every POST to `/api/ingest/flows`, in addition to (not instead of) the bearer token check and the device-registry allowlist described under Infrastructure below — a rejected source IP fires the same `new_host`-style alert path as an unregistered sampler. |
| Stream raw flows | Push raw flow batches to connected browsers after each flush (bandwidth-heavy; off by default) |
| Max flows per push | Cap on flows sent per broadcast when raw streaming is enabled (1–1000) |

### Alerts

Alert retention (days before auto-purge of alert events) is configured on the Data → Storage sub-tab alongside the other retention settings.

**Alert rule types:**

| Type | What it detects |
|------|----------------|
| `data_gap` | A known sampler has sent no flows for N minutes |
| `new_host` | A previously unseen sampler IP sent flows |
| `threshold` | Bytes/packets/flows in a time window exceed a configured value |
| `rate_spike` | Current rate exceeds 7-day baseline by a configurable multiplier |
| `port_protocol` | Specific port/protocol/direction combinations appear in recent flows |

Dismissed sampler IPs (via the Unknown Samplers panel) are excluded from `data_gap` evaluation. `0.0.0.0` is always excluded.

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
│   │   ├── settings.py     App settings CRUD + notification test
│   │   ├── users.py        User management
│   │   ├── nat_mappings.py Private↔public CIDR topology (/api/nat-mappings)
│   │   ├── traffic_rules.py    Geo Map line-style rules (/api/traffic-rules)
│   │   ├── geo_config.py   Sites + line styles CRUD (/api/geo-config/*)
│   │   ├── user_api_keys.py Per-user external API keys (/api/user-api-keys)
│   │   ├── ip_info.py      Combined ipinfo.io + ipapi.is + AbuseIPDB + MXToolbox
│   │   │                     (ptr/asn/blacklist) lookup (/api/ip-info); also
│   │   │                     /api/ip-info/internal/{ip} — pktIPAM-backed internal IP lookup
│   │   ├── mxtoolbox.py     Generic MXToolbox command passthrough (/api/mxtoolbox/lookup) —
│   │   │                     DNS/email records + active probes, every command not already
│   │   │                     auto-wired into ip_info.py above
│   │   ├── integrations.py Outbound sibling-app connections, currently pktIPAM only (/api/integrations)
│   │   ├── suite.py        Inbound pktHub Suite Integration token + /api/suite/whoami
│   │   ├── system.py       Health, restart, port, SSL upload, cleanup, backup, test-connection
│   │   ├── ws.py           WebSocket endpoint + broadcast helpers
│   │   └── ai.py           AI assistant (Claude)
│   ├── alerts/
│   │   ├── engine.py       Alert evaluation loop (all rule types) + notification dispatch
│   │   │                     (Slack, Email/SMTP, PagerDuty, generic Webhook, Tracecat — all
│   │   │                     implemented inline here, not in notifiers/ below)
│   │   ├── cleanup.py      Alert event retention purge job
│   │   └── notifiers/      Present but currently unused (just __init__.py)
│   ├── auth/
│   │   └── local.py        JWT + bcrypt
│   ├── integrations/
│   │   └── suite_client.py Outbound HTTP client for calling a sibling pkt* app via its Suite Token
│   ├── ingest/
│   │   ├── normalizer.py   Vector JSON → FlowRecord (rejects 0.0.0.0)
│   │   ├── buffer.py       In-memory batch buffer + WS broadcast
│   │   └── udp_listener.py Direct UDP NetFlow listener
│   ├── models/flow.py      FlowRecord Pydantic model
│   ├── storage/
│   │   ├── base.py         Storage interface
│   │   ├── clickhouse.py   ClickHouse backend (production)
│   │   ├── duckdb.py       DuckDB backend (embedded, core paths implemented)
│   │   └── factory.py      Backend selector
│   ├── config.py           Settings loader (YAML + env)
│   ├── database.py         SQLite init + migrations + first-run admin seed
│   ├── main.py             App factory, lifespan, router registration
│   └── server.py           Process entrypoint (`python -m app.server`) — reads host/port from
│                             config.yaml at startup so Settings → General → Port takes effect
│                             on the next restart without a systemd unit edit; also reads
│                             ssl_enabled/ssl_certfile/ssl_keyfile from the settings DB and
│                             forwards them to uvicorn.run() (see SSL / HTTPS below)
├── clickhouse/schema.sql   flows + rollup tables + materialized views
├── frontend/src/
│   ├── pages/              Analytics (dashboard + timeseries), DeviceView, FlowExplorer,
│   │                         Topology, GeoMap, Ports, NatTranslations, Alerts, Logs, Settings
│   ├── components/         Layout, AiAssistant, Pagination, IpLink (public + internal/pktIPAM
│   │                         lookup modals; also exports linkifyIps, used to auto-link IPs
│   │                         embedded in alert message text), AsnLink (ASxxxx click-through
│   │                         to an ipinfo.io ASN-details modal), HelpButton (app-wide
│   │                         contextual help)
│   ├── api/client.ts       Typed API client + getToken() for WebSocket
│   ├── hooks/useWebSocket.ts  WebSocket hook
│   └── utils/               protocols.ts (protocol name map), ip.ts (RFC1918 private-range
│                               check + IPv4-validity check backing IpLink)
├── migrations/             SQLite migration scripts (auto-applied on startup)
├── install.sh              Ubuntu install script (ClickHouse, venv, systemd service; prompts
│                             for install dir and port)
├── config.example.yaml     Config file template
├── pktflow.service         systemd unit template (placeholders filled in by install.sh);
│                             ExecStart runs `python -m app.server`, not a raw uvicorn command
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
| `GET` | `/api/flows/search` | Paginated flow search (`any_direction` param: either-side IP match) |
| `GET` | `/api/flows/search/count` | Total matching row count for the current `/search` filters (page-number pagination) |
| `GET` | `/api/flows/topology` | Node/edge list for topology graph (edges carry `sampler_ip`, the dominant observing exporter) |
| `POST` | `/api/flows/topology/lucidchart` | Export topology to Lucidchart (same fixed 3-band layout as the in-app Hierarchical view) |
| `GET` | `/api/flows/geo` | Geo-located IP pairs + Traffic Rule-resolved arc styling for Geo Map |
| `GET` | `/api/flows/rate` | Current flows/sec |
| `GET` | `/api/flows/export` | Download flows as CSV or JSON |
| `GET` | `/api/flows/devices` | Device summaries with live stats |

Common query parameters: `sampler_ip`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol`, `site`, `start`, `end`, `limit`, `offset`.

### NAT Mappings & Traffic Rules

Replaced the old VPN Site Mappings / WAN Addresses / Traffic Types design. NAT Mappings (renamed from Address Mappings) are network topology (private CIDR/IP → representative public CIDR/IP, for correct geo placement) plus a `show_in_legend` flag for the Geo Map legend; Traffic Rules are the sole source of Geo Map line styling (priority-ordered, first-match-wins). Multiple NAT Mappings may share the same private and/or public CIDR — priority order resolves which one wins.

A NAT Mapping also carries its own optional `dst_cidrs`/`dst_ports` (same comma-separated format as Traffic Rules', blank = any destination) — this is what lets the SAME `private_cidr` resolve to a DIFFERENT `public_cidr` depending on the flow's destination, modeling a firewall that NATs the same internal range out different public IPs by destination. `get_geo_data()` in `app/api/flows.py` resolves this **per flow pair**, not once per unique IP — see its docstring and the `_match_nat_mapping`/`_resolve_side` helpers for the exact mechanics, including why the same private IP can now legitimately produce two separate map markers.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET/POST` | `/api/nat-mappings` | JWT / Admin JWT | List / create NAT mappings |
| `PUT/DELETE` | `/api/nat-mappings/{id}` | Admin JWT | Update / delete a mapping — rejected with 400 while `isp_dhcp_enabled` is on |
| `POST` | `/api/nat-mappings/reorder` | Admin JWT | Rewrite priority order from a client-supplied ordered id list — rejected while `isp_dhcp_enabled` is on |
| `GET/POST` | `/api/traffic-rules` | JWT / Admin JWT | List / create traffic rules |
| `PUT/DELETE` | `/api/traffic-rules/{id}` | Admin JWT | Update / delete a rule — PUT rejects switching `dst_cidrs`↔`dst_site_key` on an existing rule with a 400 |
| `POST` | `/api/traffic-rules/reorder` | Admin JWT | Rewrite priority order from a client-supplied ordered id list |

A Traffic Rule optionally matches a NAT Mapping (or "Any"), a destination — either `dst_cidrs` (typed, comma-separated) or `dst_site_key` (a live reference to a Site's `ip_cidr`, resolved at request time; mutually exclusive with `dst_cidrs`, enforced by a CHECK constraint) — and/or a comma-separated list of destination ports/ranges. At least one filter is required. `/api/flows/geo` resolves each arc's NAT Mapping first (for geolocation), then its Traffic Rule (for color/dash style + legend label).

**Canonical example** (also documented in ADMIN_GUIDE.md): a firewall NATs `10.1.157.141` to `104.62.87.92` for destination port 53 and to `104.62.87.89` for everything else. To make the Geo Map reflect that: two NAT Mappings, same `private_cidr=10.1.157.141/32` — one with `dst_ports=53` → `public_cidr=104.62.87.92` (higher priority), one with no destination filter → `public_cidr=104.62.87.89` (lower priority, catch-all). A Traffic Rule scoped to the port-53 mapping only ever matches port-53 traffic; traffic on any other port resolves through the catch-all mapping and gets a different marker location, correctly falling through to the neutral gray default line if no rule is scoped to that mapping.

**ISP DHCP mode** — `PUT /api/settings/isp_dhcp_enabled` with `true`/`false` toggles it, same generic settings endpoint as everything else in Settings; the side effect lives in `app/api/settings.py`, not `nat_mappings.py`. Enabling creates one `nat_mappings` row (`name='Default'`, `site_key='default'`, `private_cidr='0.0.0.0/0'`, `public_cidr=''`) and records its id in the internal `isp_dhcp_mapping_id` setting; `app/api/flows.py`'s `get_geo_data()` then ignores every other NAT mapping while the flag is on. Disabling deletes that row — `traffic_rules.nat_mapping_id` is `ON DELETE CASCADE`, so any rule scoped to it is deleted too.

### Geo Map Config

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET/POST/PUT/DELETE` | `/api/geo-config/sites` | Admin JWT | Site definitions (marker color, badge color, IP/CIDR for remote-end matching, "show in legend" toggle); the Default site's key is immutable and it can't be deleted |
| `GET/POST/PUT/DELETE` | `/api/geo-config/line-styles` | Admin JWT | Arc line style catalog (color + dash pattern), picked by Traffic Rules |

### User API Keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/user-api-keys` | JWT | This user's own keys for `abuseipdb`, `ipinfo`, `ipapi_is`, `mxtoolbox`, `ipqualityscore` |
| `PUT` | `/api/user-api-keys/{provider}` | JWT | Set (or clear, with an empty value) this user's key for a provider |
| `POST` | `/api/user-api-keys/{provider}/test` | JWT | Validate a key against the real provider API using a harmless test IP |

Scoped strictly to the authenticated user (by username, not user id — pktHub suite-proxy logins share a single pseudo id). No admin override or cross-user visibility.

### IP Info

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/ip-info/{ip}` | JWT | Combined ipinfo.io + ipapi.is + AbuseIPDB + MXToolbox (ptr/asn/blacklist, run concurrently) lookup for a single public IP, using the caller's own stored keys (or ipapi.is's keyless free tier, if enabled). Returns 400 for private/loopback/link-local/reserved addresses. |
| `GET` | `/api/ip-info/internal/{ip}` | JWT | pktIPAM-backed lookup for a single private/loopback/link-local IP — subnet, IP inventory record, DHCP leases, DNS records, ARP entries. Returns 400 for public addresses. Returns `configured: false` (not an error) if no enabled pktIPAM connection exists yet. |
| `GET` | `/api/ip-info/asn/{asn}` | JWT | ipinfo.io's ASN API for a given `ASxxxx` number — backs the `AsnLink` click-through from `ASxxxx` text in the IP Lookup modal. |

### MXToolbox

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/mxtoolbox/lookup` | JWT | Generic passthrough to any MXToolbox `Lookup` command — `{command, argument, port?}`. Covers everything not already auto-wired into `/api/ip-info/{ip}`: email/DNS records (`mx`, `spf`, `dmarc`, `dkim`, `dns`, `txt`, `soa`, `bimi`, `mta-sts`, `tlsrpt`, `a`, `aaaa`) and active probes (`ping`, `trace`, `tcp`, `http`, `https`, `smtp`) that run from MXToolbox's own infrastructure against the target. `dkim` needs `domain:selector`; `tcp` needs `port`. Returns MXToolbox's raw JSON — no response modeling, since nothing in the UI consumes it yet. |

### Sibling pkt Apps (Integrations)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/integrations` | JWT | List configured outbound connections to sibling pkt* apps (currently pktIPAM only) |
| `POST` | `/api/integrations` | Admin JWT | Create a named connection (`name`, `app_name`, `base_url`, `suite_token`) |
| `PUT` | `/api/integrations/{id}` | Admin JWT | Update name/base_url/suite_token/enabled (partial update) |
| `DELETE` | `/api/integrations/{id}` | Admin JWT | Remove a connection |
| `POST` | `/api/integrations/{id}/test` | Admin JWT | Authenticate against the target's `/api/suite/whoami` and report health |

### Suite Integration (inbound, from pktHub)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/suite/token` | — | Returns the current Suite Token, generating one on first call |
| `POST` | `/api/suite/register` | — | Manual token override |
| `GET` | `/api/suite/whoami` | Suite Token or JWT | Identity/health check — used by sibling apps' "Test Connection" so a bad token fails instead of reporting a false-healthy port check |

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
| `GET` | `/api/system/port` | Admin JWT | Current listen port (read from `config.yaml`) |
| `POST` | `/api/system/port` | Admin JWT | Rewrite the `port:` line in `config.yaml`; takes effect on the next restart, does not restart itself |
| `POST` | `/api/system/ssl/upload-pfx` | Admin JWT | Upload PFX/P12 bundle |
| `POST` | `/api/system/ssl/upload` | Admin JWT | Upload PEM cert + key separately |
| `DELETE` | `/api/system/ssl` | Admin JWT | Remove SSL files |
| `GET` | `/api/system/ssl/status` | Admin JWT | SSL file status |
| `POST` | `/api/system/cleanup` | Admin JWT | Trigger retention cleanup |
| `POST` | `/api/system/backup` | Admin JWT | Trigger local backup |
| `POST` | `/api/system/test-connection` | Admin JWT | Verify the configured storage backend is reachable |

### Auth (additional)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/auto-login` | None | Issues a session for the flagged default-admin account. Only succeeds when both Local auth and SAML are disabled (403 otherwise) — see [Default admin / auto-login](#authentication--users). |

### Users (additional)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PATCH` | `/api/users/{id}/set-default-admin` | Admin JWT | Flags this user as the default admin for auto-login, clearing the flag from every other user. Target must be an active admin. |

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

1. **Workers = 1 required for WebSocket** — the systemd unit's `ExecStart` always runs a single worker. With multiple workers, each has its own in-memory `ws_manager`; broadcasts from the ingest worker don't reach WS connections on other workers.
2. **goflow2 template errors after restart** — Normal. goflow2 loses cached NetFlow v9 templates on restart; "template error" log lines resolve within seconds when the router sends the next template packet.
3. **Collector orphan process** — If `goflow2-vector` is restarted while flows are active, the old goflow2 process may survive and hold port 2055. Symptom: service is `active` but no flows arriving. Fix: `sudo kill -9 <old_goflow2_pid>`.
4. **ClickHouse threading** — `clickhouse-driver` is not thread-safe. All calls are serialized with `threading.Lock()` in `clickhouse.py`.
5. **passlib/bcrypt on Python 3.12+** — Pin `passlib==1.7.4` and `bcrypt==4.0.1` to avoid attribute errors.
6. **Direct UDP ingest depends on a `netflow` library workaround** — the third-party `netflow` package (`bitkeks/python-netflow-v9-softflowd`) initializes its own template cache as a list, but its NetFlow v9 parser then indexes into that same object using the exporter's raw Template ID (commonly ≥256 for real hardware) as a dict-style key — this raises `IndexError` for any realistic Template ID, silently dropping every flow record after the first template arrives. `app/ingest/udp_listener.py` works around this by pre-seeding the template cache as `{"netflow": {}, "ipfix": {}}` (dicts) before the library ever gets a chance to install its own broken list default. If you upgrade the `netflow` dependency, re-verify this workaround is still needed (or still effective) against a real capture before relying on direct UDP ingest.
7. **SSL/TLS auto-detection — fixed, no longer a dead code path.** Previously the code that read `ssl_enabled`/`ssl_certfile`/`ssl_keyfile` from the settings DB and passed them to uvicorn lived in an `if __name__ == "__main__":` block in `app/main.py` that neither the systemd entrypoint (`python -m app.server`) nor a direct `uvicorn app.main:app ...` invocation ever executed. This is now fixed: `app/server.py::main()` (the real entrypoint) reads those three settings itself and forwards `ssl_certfile`/`ssl_keyfile` to `uvicorn.run()`. The orphaned `start.sh` wrapper was removed since its logic is now in the actual entrypoint. Still worth confirming end-to-end (upload cert → restart → `curl -k https://localhost:<port>/api/health`) in your own environment before depending on it in production.

---

## Incomplete / Planned Features

This list is kept in sync with [FEATURES.md](FEATURES.md), which is the canonical, actively-maintained inventory — check there first if this drifts.

| Feature | Status |
|---------|--------|
| Notification channels (Slack, Email, PagerDuty, Webhook, Tracecat) | Code written, including a real `POST /api/settings/test-notification` behind the "Send Test" buttons — not yet confirmed fired against a live service in production |
| AI assistant | Code written (`app/api/ai.py`, `AiAssistant.tsx`); `anthropic` is now a declared dependency in `requirements.txt` — not yet confirmed used with a live API key in production |
| Okta OIDC | **Deliberately dropped, not pending** — `app/auth/okta.py` is an intentional no-op; SAML 2.0 covers Okta SSO |
| SSL/TLS auto-detection | **Done, not pending** — the code that wires an uploaded cert into uvicorn now lives in `app/server.py`'s actual entrypoint (previously dead code in `app/main.py`); see Known Issues & Quirks above |
| `ingest_http_port` Settings field | Vestigial — displayed in Settings → Ingest but not read anywhere in the backend; the real listen port is Settings → General → Port |
| App-wide contextual help | **Done, not pending** — the "?" → modal `HelpButton` pattern originally built for Address Mappings/Traffic Rules is now on every main nav page and every Settings section |

---

## Security Notes

- Change `secret_key` in `config.yaml` (or `PKTFLOW_SECRET_KEY` env var) before production use — `openssl rand -hex 32`
- Change the default admin password immediately after first login
- The ingest token is in **Settings → Ingest** and must match `auth.token` in each collector's `vector.toml`
- Consider setting **Settings → Ingest → Allowed source IPs** to your collector hosts' IPs/CIDRs — the ingest token alone is bearer-only; the allowlist adds a source-IP check on top
- `cors_origins` should be restricted to your dashboard origin in production
- If using a self-signed cert or connecting by IP, set `verify_certificate = false` in Vector's TLS section
- SAML SP Entity ID must exactly match Okta's "Audience URI" — both derived from Base URL in Settings
- Only assign **Default Admin** (Settings → Security → Users) to an account whose credentials are tightly controlled — if every auth method is ever disabled, that account is the one anyone reaching the app is auto-logged in as
- Suite Tokens (both the inbound one under Settings → Security → Suite Integration, and each outbound Sibling pkt App connection's token) are bearer credentials equivalent to a login — treat them like any other secret
