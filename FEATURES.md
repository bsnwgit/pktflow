# pktFlow — Feature Set

A complete inventory of what pktFlow does today. Status tags: **✅ built & production-verified**, **⚠️ built, not end-to-end tested**, **🚧 partially built / planned**.

---

## Data Ingestion

- ✅ **NetFlow v9 via goflow2 + Vector** — one or more collector pipelines transform raw NetFlow to snake_case JSON and POST to pktFlow over HTTPS with a bearer token (`/api/ingest/flows`).
- ✅ **Direct UDP ingest** — built-in NetFlow v5/v9/IPFIX/sFlow listener (`app/ingest/udp_listener.py`), no external collector required. Off by default; toggled and configured in Settings → Ingest. Requires a service restart to take effect.
- ✅ **Ingest buffer** — in-memory batch buffer, configurable flush interval, WebSocket broadcast to connected browsers on every flush.
- ✅ **Invalid sampler filtering** — flows with a `0.0.0.0` sampler address are rejected at ingest.
- ✅ **Device registry as ingest allowlist** — flows from a sampler IP not present and enabled in the device registry are dropped before storage, not just left unlabeled. Registry is warmed into memory at process startup so a restart doesn't silently drop everything until the first UI edit.

## Dashboards & Visualization

- ✅ **Real-time dashboard** — live flows/sec counter, WebSocket push with polling fallback.
- ✅ **Analytics** — traffic timeseries (short-range REST + long-range hourly/daily rollups).
- ✅ **Device View** — per-sampler traffic history, top talkers, protocol distribution.
- ✅ **Flow Explorer** — search/filter by IP, port, protocol, time range; server-side pagination with a sliding page-number bar (matching the Logs page); CSV/JSON export.
- ✅ **Network Topology** — D3 force-directed graph, site clustering, export to PNG/SVG/JSON/DOT/Draw.io/Lucidchart. Node click opens a detail panel with "Flows from →" / "Flows to →" buttons that deep-link into Flow Explorer pre-filtered.
- ✅ **Geo Map** — see dedicated section below; substantially rebuilt this cycle.
- ✅ **Traffic by Port page** (`/ports`) — protocol mix (pie), top ports (bar), traffic-over-time (area, optionally pinned to a port), full port inventory table. Not currently linked from the sidebar nav — reachable by URL only.
- ✅ **Sankey flow diagrams** — two implementations: a network-wide src→dst view in Analytics, and a per-device top-talkers flow map in Device View with click-to-drill-down into Flow Explorer.

## Geo Map

The traffic geo-visualization system, rebuilt end-to-end this cycle around a simpler two-layer model.

- ✅ **Leaflet dark map + D3 arc overlay** — circle markers sized by bytes, arcs between src/dst locations sized by bytes, both interactive (click → Flow Explorer pre-filtered).
- ✅ **Zoom/pan clamped to a single world view** — `minZoom`, `noWrap` tiles, and `maxBounds` prevent the globe from tiling into duplicate copies on zoom-out.
- ✅ **Pop-out window** (`/geomap`) — opens as a real separate browser window (`window.open`), so its Close button actually works and the original tab is untouched.
- ✅ **Address Mappings** — maps a private CIDR/IP to a representative public CIDR/IP so RFC-1918 traffic (both VPN and plain WAN egress) is geolocated at the correct physical site instead of being dropped from the map. Pure network-topology data — carries no visual styling. Fields: Name, Site, Category (WAN/VPN — display badge only), Private CIDR/IP, Public/External CIDR/IP. Drag-and-drop ordering (no manual priority numbers) resolves which side's rules get consulted when both ends of a flow match a different mapping.
- ✅ **Traffic Rules** — the single source of arc line styling. Each rule optionally matches an Address Mapping (or "Any"), a Destination CIDR/IP, and/or a Destination Port — at least one filter required. Matching is strictly top-to-bottom, first hit wins, via drag-and-drop ordering. A rule with only an Address Mapping set (no destination filter) acts as that mapping's default/catch-all style. Unmatched traffic falls back to a neutral gray line. This is what makes "traffic to 1.1.1.1/9.9.9.9" or "any traffic to port 53" stand out as its own line instead of blending into the general WAN color.
- ✅ **Site Groups** — configurable circle-marker colors (fill/stroke) and Settings-page badge colors (background/text, both pickable via native color inputs), replacing the old hardcoded Tailwind-class badges.
- ✅ **Line Styles** — the shared color + dash-pattern catalog that Traffic Rules picks from.
- ✅ **Dynamic legend** — lists only the Traffic Rules actually in use by arcs currently on screen, labeled by the rule's own name (not a generic Line Style label); Sites section only shows groups with "show in legend" enabled.
- ✅ **VPN site mapping (superseded)** — the original single-purpose "VPN Site Mappings" + "WAN Addresses" boxes and the "Traffic Type" indirection layer were merged/removed in favor of Address Mappings + Traffic Rules above; same underlying capability, one fewer layer of indirection.
- ✅ **Multi-value Traffic Rules** — a single rule can match a comma-separated list of destination CIDRs/IPs and/or ports/ranges, instead of needing one rule per value.
- ✅ Port-aware backend matching — the underlying flow-pairs query includes destination port, so Traffic Rules can classify by port; same-destination traffic that resolves to the same style still collapses into one arc (no per-port clutter) unless a rule actually splits it out. Both legs of a bidirectional conversation resolve against the same canonical service port (the lower port seen across the pair) so a request leg and its response leg always merge into a single arc instead of drawing twice.
- ✅ **Auto-refresh wired up** — main Geo Map page and card both re-poll on the app's auto-refresh tick; the `/geomap` pop-out (outside the main layout) has its own manual refresh button plus a 30s interval.
- ✅ **QA'd against real traffic** — arcs, legend, and styling verified against live data (not just synthetic test cases) since the Address Mappings + Traffic Rules rebuild; user-confirmed.

## IP Intelligence & Reputation

- ✅ **Per-user API keys** — every logged-in user has a Settings → API Keys tab for their own AbuseIPDB, ipinfo.io, and IPQualityScore keys (`user_api_keys` table, keyed by username). No cross-user visibility, no admin override — nobody but the owning user can see a key's value. Each field has a "Test" button (`POST /api/user-api-keys/{provider}/test`) that validates the key against the real provider API using a harmless test IP (8.8.8.8), before saving.
- ✅ **IP Lookup** — any public (non-RFC1918/loopback/link-local) IP address is a clickable link, styled with a search icon and a bold underline so it doesn't blend into surrounding text. Clicking opens a modal (`IpLink`/`IpInfoModal` in `frontend/src/components/IpLink.tsx`) backed by `GET /api/ip-info/{ip}`, which combines ipinfo.io (city/region/country/org+ASN/hostname/timezone) and AbuseIPDB (abuse confidence score color-coded green/yellow/red, total reports, ISP, usage type, domain, last reported) using the current user's own stored keys. A provider with no key configured shows an inline "Add your key in Settings → API Keys" link instead of erroring the whole modal.
- ✅ **Wired into Flow Explorer, Device View, Topology, and Alerts** — Flow Explorer's src/dst columns and flow-detail panel; Device View's top-talkers table, drill-down header, Sankey panel, and device header; Topology's node detail panel; Alerts' `src_ip`/`sampler_ip` chips, every IP column across the mini-tables (top contributors/sources/largest-flows/destinations), and a regex-based `linkifyIps` helper that auto-links IPs embedded inside free-text alert messages and live toast notifications.
- 🚧 **Not wired into Geo Map** — deliberate. Geo Map's IPs render through raw Leaflet HTML tooltip strings and native SVG `<title>` elements, neither of which can host a React component/clickable link without a different architecture (a DOM-event-delegation bridge, or moving tooltips off SVG `<title>` entirely). Geo Map's own click-to-explore already routes into Flow Explorer, where the same IPs get the lookup treatment.
- 🚧 **Not wired into `<select>`/`<option>` dropdowns** (device pickers in Device View/Topology) — HTML doesn't allow interactive content inside `<option>`, so those stay plain text by necessity.
- 🚧 **Reverse DNS (PTR) lookup** — not built. Was in the original plan as a third, no-API-key-needed data point alongside ipinfo/AbuseIPDB; not yet added to the modal.

## Alerting

- ✅ **data_gap** — fires when a known sampler goes silent for a configurable period; dismissed samplers excluded.
- ✅ **new_host** — fires when a previously unseen sampler IP sends flows.
- ✅ **threshold** — fires when bytes/packets/flows in a time window exceed a configured value.
- ✅ **rate_spike** — fires when current rate exceeds the 7-day rolling baseline by a configurable multiplier.
- ✅ **port_protocol** — fires when specific port/protocol/direction combinations appear in recent flows.
- ✅ **Auto-resolve** — open alert events self-close when the condition clears on the next evaluation cycle.
- ✅ **ACK support**, **alert cleanup** (retention-based purge), **bulk rule provisioning** (CSV export/import/template), **Investigate button** (deep-links to Flow Explorer pre-filtered to the alert's context), shared search/severity/time-range filter bar with Application Logs.
- ⚠️ **Notification channels** — Slack, Email (SMTP), PagerDuty, and generic Webhook dispatch methods are fully implemented in `app/alerts/engine.py`, plus a real `POST /api/settings/test-notification` backing the Settings UI's "Send Test" buttons (posts to Slack, sends SMTP, etc. — not a stub). Not yet confirmed fired against a real live service.

## Authentication & Users

- ✅ **Local auth** — JWT + bcrypt, configurable token lifetime.
- ✅ **SAML 2.0 (Okta)** — SP-initiated SSO, auto-provisions users on first login.
- ✅ **Roles** — admin (full), analyst (read + export), viewer (read-only).
- ✅ **User management** — admin create/reset-password/activate-deactivate.
- **Okta OIDC — deliberately dropped**, not pending. `app/auth/okta.py` is an intentional no-op ("OIDC removed — pktFlow uses SAML 2.0 only"); SAML covers Okta SSO.

## Settings & Configuration

All settings live in the Settings UI, stored in SQLite, no file edits required post-install.

- ✅ **Ingest** — token, buffer tuning, UDP toggle/port, raw-flow WebSocket streaming toggle.
- ✅ **Devices** — registry CRUD, CSV import/export + template, Unknown Samplers panel with dismiss support.
- ✅ **Alerts** — retention window.
- ✅ **Geo Map** — Site Groups, Address Mappings, Traffic Rules, Line Styles (see above).
- ✅ **API Keys** — every user's own tab, not admin-gated (see IP Intelligence & Reputation above).
- ✅ **Storage** — backend selector (ClickHouse default; DuckDB was 🚧 broken — missing the `get_top_ports` abstract method, crashed on selection — now implemented and fixed), retention days, manual cleanup.
- ✅ **Storage "Test Connection" button** — real backend at `POST /api/settings/test-connection`.
- ✅ **Backup** — one-click or scheduled (SQLite backup API + optional ClickHouse CSV export), configurable rotation.
- ✅ **SSL/TLS** — drag-and-drop PFX/P12 or separate PEM cert+key, auto-detected on startup.
- ✅ **System** — Restart Service button (tries `sudo systemctl restart`, falls back to self-SIGTERM relying on `Restart=always`).
- ⚠️ **AI Assistant** — `app/api/ai.py` fully implemented (calls Claude with flow context), frontend chat panel exists, `anthropic` package is now a declared dependency in `requirements.txt`. Not yet confirmed used with a live API key in production.

## Integrations

- ✅ **Lucidchart** — topology export directly to a Lucidchart document via API token.
- ✅ **SSL/TLS** upload (see above).

## Infrastructure

- ✅ **Device registry** doubles as ingest allowlist (see Ingestion).
- ✅ **Application Logs** — search + level filter + time-range dropdown (including custom range), server-side pagination with a sliding page-number bar.
- ✅ **UTC-normalized timestamps** — alert-event and last-login timestamps normalized before parsing, correct regardless of browser timezone.
- ✅ **Data retention** — configurable ClickHouse TTL, manual cleanup trigger.
- ✅ **Backup** (see Settings).
- ✅ **WebSocket** — real-time push after every ingest flush; single-worker process (`--workers 1`) required since `ws_manager` state is in-memory and per-worker.

## Planned Features

### App-wide contextual help — 🚧 not started

Extend the `HelpButton` pattern built for Address Mappings / Traffic Rules (small blue "?" icon next to a section heading → modal with detailed explanation, source of truth instead of permanent inline text blocks) to the rest of the program. Every settings section / non-obvious feature gets the same treatment rather than sprinkling explanatory paragraphs directly in the UI. Needs a pass to identify which sections actually warrant one (anywhere users have asked "how does this work" is a good signal) and to write the explanatory content for each.

## Known Constraints

- **Single worker required** for WebSocket correctness — do not scale `uvicorn --workers` above 1.
- **`clickhouse-driver` is not thread-safe** — all calls serialized via `threading.Lock()`.
- **Direct UDP ingest** depends on a workaround for a bug in the third-party `netflow` package's template cache (list vs dict) — re-verify if that dependency is ever upgraded.
- **DuckDB storage backend** is selectable in the UI; several alert-engine methods (baselines, elephant-flow/threshold/port-scan detail queries, etc.) deliberately raise `NotImplementedError` rather than being implemented, so those specific alert rule types won't work under DuckDB. Core query paths (search, top talkers/ports, protocol distribution, topology) are implemented.
- **goflow2 orphan process** — rapid collector restarts can leave an old `goflow2` process holding the UDP port; check `pgrep -a goflow2` if flows stop after a restart.

---

*This file is a living inventory — update it when a feature's status changes rather than letting it drift from what's actually deployed. See [README.md](README.md) for install/config instructions and full API reference.*
