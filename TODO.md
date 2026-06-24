# pktFlow — Pending Work

Last updated: 2026-06-23

---

## Completed

- [x] **Sankey flow diagram** — src_ip → dst_port → dst_ip alluvial chart using D3-sankey on Device View page

---

## Alert Engine

- [ ] **Implement `threshold` alert rule type** — Query ClickHouse for aggregate metric (bytes/packets/flows) over a time window and compare to configured threshold. Currently hits a `return` stub in `engine.py _evaluate_rule()`.
- [ ] **Implement `rate_spike` alert rule type** — Compare current rate to rolling 7-day baseline from ClickHouse, fire if ratio exceeds configured multiplier. Currently a `return` stub.
- [ ] **Implement `port_protocol` alert rule type** — Scan recent flows for matches on configured port/protocol/direction combinations. Currently a `return` stub.
- [ ] **Build per-rule-type alert condition builder UI** — `Alerts.tsx` sends `conditions: {}` for all rule types. Needs rule-type-aware field sets for `threshold`, `rate_spike`, and `port_protocol`.

---

## Authentication

- [ ] **Build Okta OIDC authentication** — `app/auth/okta.py` does not exist. Need OIDC flow, callback handler in `app/api/auth.py`, and group → role resolution from Okta token. Settings UI and `users.okta_sub` DB column already exist.

---

## Ingest

- [ ] **Build direct UDP NetFlow ingest** — `app/ingest/udp_listener.py` does not exist. Need async UDP listener decoding NetFlow v5/v9/IPFIX directly (no goflow2/vector), normalizing records, and feeding into `IngestBuffer`. Settings UI exists.
- [ ] **Build migration mode / O2 flow forwarding** — Settings UI has toggle and forwarding URL field but no backend logic reads it. Build logic to forward received flows to a secondary destination when enabled.

---

## Notifications

- [ ] **Test and verify notification channels (Slack, Email, PagerDuty, Webhook)** — Dispatch methods written in `engine.py` but never tested against real services. Verify `httpx`, `aiosmtplib`, and `jinja2` are in the venv.
- [ ] **Build "Send Test" notification backend endpoints** — Settings UI has "Send Test" buttons for each channel but no backend endpoint (`/api/settings/test-notification` or similar) exists.

---

## Data Retention & Storage

- [ ] **Build aggregate rollup job (hourly/daily)** — Hourly/daily rollup tables may exist in schema but no scheduled job populates them. Build background job writing to `flows_hourly` and `flows_daily`.
- [ ] **Build manual retention cleanup trigger endpoint** — Settings UI has a trigger button + last-run timestamp but no backend endpoint exists.
- [ ] **Build Storage "Test Connection" endpoint** — Settings → Storage has "Test Connection" button but no `/api/settings/test-connection` endpoint exists.
- [ ] **Build alert event auto-cleanup job** — `alert_events` and `notification_log` accumulate in SQLite indefinitely. Build a scheduled purge job with configurable retention window.
- [ ] **Production-test DuckDB backend** — `app/storage/duckdb.py` is fully implemented but has never run against real data on O2.

---

## Frontend / UI

- [ ] **Pie charts above Device View top talkers table** — Add pie chart visualizations above the top talkers table on the Device View page.
- [ ] **Build topology node click → flow drill-down** — Clicking a topology node should navigate to (or open a panel with) flows filtered to that IP as src or dst. Nodes are currently not interactive beyond hover tooltips.
- [ ] **Build network topology export (PNG/SVG/JSON)** — Add export button for PNG/SVG/JSON output with optional filtering by sampler device (medical, dental, or full combined).
- [ ] **Build Settings page auto-refresh** — Settings page loads once on mount. Add polling of `/api/settings/` or a server-sent event / WebSocket push to stay current across sessions.
- [ ] **Build unknown samplers UI section** — Settings → Devices section showing IPs that sent flow data but aren't in the device registry, with prompt to add or block them.
- [ ] **Build WebSocket live updates for Dashboard** — Dashboard currently polls via REST GET. Replace with WebSocket for live flows/sec and active alerts badge.
- [ ] **Build device import from CSV** — Neither Settings Devices tab nor backend currently supports CSV import. Build the import button and backend handler.

---

## Other

- [ ] **Verify and test AI assistant on O2** — `app/api/ai.py` and `AiAssistant.tsx` written but untested. Verify `anthropic` package in venv, API key set in Settings, and component wired into a page layout.
