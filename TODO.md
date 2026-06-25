# pktFlow — Pending Work

Last updated: 2026-06-25

---

## Completed

- [x] **Sankey flow diagram** — src_ip → dst_port → dst_ip alluvial chart using D3-sankey on Device View page
- [x] **Implement `threshold` alert rule type** — ClickHouse aggregate query over time window vs configured threshold
- [x] **Implement `rate_spike` alert rule type** — current rate vs 7-day rolling baseline with configurable multiplier
- [x] **Implement `port_protocol` alert rule type** — scan recent flows for port/protocol/direction matches
- [x] **Build per-rule-type alert condition builder UI** — rule-type-aware field sets in Alerts.tsx
- [x] **Build aggregate rollup job (hourly/daily)** — materialized views + backfill + Analytics long-range trend chart
- [x] **Build alert event auto-cleanup job** — scheduled purge with configurable retention window in Settings
- [x] **Build manual retention cleanup trigger endpoint** — `/api/system/cleanup` + button in Settings Storage tab
- [x] **Build network topology export (PNG/SVG/JSON)** — Export dropdown with optional sampler filtering
- [x] **Build Settings page auto-refresh** — polling added to Settings page
- [x] **Build unknown samplers UI section** — Settings → Devices panel with dismiss support
- [x] **Build device import from CSV** — import button + backend handler
- [x] **Build WebSocket live updates for Dashboard** — backend broadcast from IngestBuffer, Dashboard hooked in
- [x] **Build direct UDP NetFlow ingest** — `app/ingest/udp_listener.py` written and wired into main.py lifespan

---

---

## Authentication

- [ ] **Build Okta OIDC authentication** — `app/auth/okta.py` does not exist. Need OIDC flow, callback handler in `app/api/auth.py`, and group → role resolution from Okta token. Settings UI and `users.okta_sub` DB column already exist.

---

## Ingest

- [ ] **Build migration mode / O2 flow forwarding** — Settings UI has toggle and forwarding URL field but no backend logic reads it. Build logic to forward received flows to a secondary destination when enabled.

---

## Notifications

- [ ] **Test and verify notification channels (Slack, Email, PagerDuty, Webhook)** — Dispatch methods written in `engine.py` but never tested against real services. Verify `httpx`, `aiosmtplib`, and `jinja2` are in the venv.
- [ ] **Build "Send Test" notification backend endpoints** — Settings UI has "Send Test" buttons for each channel but no backend endpoint (`/api/settings/test-notification` or similar) exists.

---

## Data Retention & Storage

- [ ] **Build Storage "Test Connection" endpoint** — Settings → Storage has "Test Connection" button but no `/api/settings/test-connection` endpoint exists.
- [ ] **Production-test DuckDB backend** — `app/storage/duckdb.py` is fully implemented but has never run against real data on O2.

---

## Frontend / UI

- [ ] **Pie charts above Device View top talkers table** — Add pie chart visualizations above the top talkers table on the Device View page.
- [ ] **Build topology node click → flow drill-down** — Clicking a topology node should navigate to (or open a panel with) flows filtered to that IP as src or dst. Nodes are currently not interactive beyond hover tooltips.

---

## Other

- [ ] **Verify and test AI assistant on O2** — `app/api/ai.py` and `AiAssistant.tsx` written but untested. Verify `anthropic` package in venv, API key set in Settings, and component wired into a page layout.
