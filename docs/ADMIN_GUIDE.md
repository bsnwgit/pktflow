# pktFlow — Administrator Guide

Covers installing, configuring, and operating pktFlow. For day-to-day usage (dashboards, flow search, alerts), see [USER_GUIDE.md](USER_GUIDE.md). See the [README](../README.md) for the full technical/API reference, and [FEATURES.md](../FEATURES.md) for the maintained feature-status inventory.

## Installation

Requires a fresh Ubuntu Server 22.04/24.04 LTS host with `sudo`, and Node.js 20.x LTS installed beforehand for the frontend build (`install.sh` builds it automatically if `npm` is on `PATH`, but doesn't install Node itself).

```bash
git clone https://github.com/bsnwgit/pktflow.git
cd pktflow
bash install.sh
```

Prompts for install directory (default `/opt/pktflow`) and port (default `8766`), then handles system packages, ClickHouse, Python deps, schema, `config.yaml` + secret key, the admin user, the frontend build, and the systemd service. Prints the admin password **and ingest token** at the end — save both, neither is shown again. Both prompts are skippable for unattended installs via `PKTFLOW_INSTALL_DIR` / `PKTFLOW_PORT` env vars.

Open the app port in your firewall (`sudo ufw allow 8766/tcp`), then log in with the admin credentials.

## First-time setup checklist

1. **Change the admin password.**
2. **Set Base URL** (Settings → General) to the app's real externally-reachable address *before* configuring SSO or notifications — SAML ACS URLs and notification links are built from it.
3. **Point your NetFlow exporters** at pktFlow — either via a goflow2+Vector collector pipeline (recommended, HTTP POST with bearer token to `/api/ingest/flows`) or the built-in direct UDP listener (Settings → Ingest). See [Collector Configuration](../README.md#collector-configuration) in the README for the goflow2/Vector pipeline setup.
4. **Register your devices/samplers** (Settings → Devices) — this is an ingest allowlist, not just labeling; flows from an unregistered sampler IP are dropped, not just unlabeled.
5. **Set up Sites, NAT Mappings, and Traffic Rules** (Settings → Geo Map) if you want the Geo Map's arcs and markers to reflect your real site topology.
6. **Configure alert rules and notification channels** so the team gets paged.
7. **Set up backups** (Data → Backups) and confirm a manual run succeeds.
8. **Create accounts** for your team with appropriate roles.

## Users & roles

`admin` (full access), `analyst` (read + export), `viewer` (read-only). Manage at Settings → Security → Users (admin-only) — create, reset password, toggle active, assign role. The ★ next to a user marks them the **default admin**: if you ever disable *both* Local auth and SAML on the Auth sub-tab, the app skips the login page and auto-signs everyone in as that account instead of dead-ending — only appropriate on a trusted, access-controlled network. Only one user can hold the ★ at a time.

### Okta SAML SSO

Settings → Security → Auth: enable SAML, then either paste Okta's IdP metadata XML (auto-fills SSO URL/Entity ID/certificate) or enter them by hand. The ACS URL to register in Okta is shown read-only on the same tab, derived from **Base URL** — set that first. Local auth and SAML aren't mutually exclusive; both can be on at once. (Okta OIDC was deliberately dropped in favor of SAML — not a bug.)

## Settings reference

A section bar at the top of the page splits Settings in two: **Common** (**General · Security · Data · Notifications · User Keys · System**) and **pktFlow** (**Sources · Geo Map · Ingest**). The tab bar below shows only the selected section's tabs — if a tab isn't where you expect, switch sections. Deep links to a specific tab select the right section on their own. Security and Data have their own left-hand sub-tabs. Most settings apply immediately; the exceptions are called out below.

| Section | Tab | Sub-tab | Key settings | Needs restart? |
|---|---|---|---|---|
| **Common** | General | — | App name, **Port**, **Base URL**, timezone, Restart Service | Port: yes |
| | Security | Users | Accounts, roles, default-admin flag | no |
| | | Auth | Local auth toggle, session timeout, SAML config | no |
| | | Suite Integration | Suite token (inbound), Sibling pkt Apps (outbound pktIPAM connections) | no |
| | | AI Assistant | Local/self-hosted (Ollama, OpenAI-compatible endpoints) + cloud (Anthropic, OpenAI) providers, each independently enabled; local tried first. Scoped strictly to pktFlow's own domain — off-topic questions and prompt-injection/override attempts are refused server-side before ever reaching the provider. A provider has 180 seconds to answer before the request fails — sized for slow local models | no |
| | | SSL / TLS | Cert/key or PFX upload | restart to load new cert |
| | Data | Storage | Backend (ClickHouse default / DuckDB), retention days, cleanup, Test Connection | backend switch: yes |
| | | Backups | Schedule, rotation, manual run, restore | restore of config.yaml: yes |
| | Notifications | — | Slack/Email/PagerDuty/Webhook/Tracecat channels | no |
| | User Keys | — | Per-user lookup API keys + Lucidchart token (per-user, private) | no |
| | System | — | Version/build info, host and runtime details, open-source notices | no |
| **pktFlow** | Sources | — | Device/sampler registry (CSV import/export) | no |
| | Geo Map | — | Sites, Private/Public NAT Mapping, Traffic Rules, Line Style Catalog | no |
| | Ingest | — | Ingest method (http/udp/both), ingest token, UDP ports, source-IP allowlist, raw-stream broadcast | method/UDP port change: yes |

**Restart Service** (General tab) tries `sudo systemctl restart pktflow` first; if the service account lacks passwordless sudo for that (the common case), it falls back to sending itself SIGTERM and relying on systemd to bring it back up — which only works if the unit has `Restart=always` (the shipped template does). If you've customized the systemd unit, keep that setting or set up passwordless sudo for this button to keep working.

**Sites** (Settings → Geo Map → Sites) color the Geo Map's circle markers. Every install has one **Default** site (key `default`) that new NAT Mappings fall back to — its key is locked and it can't be deleted, but display name, colors, and IP/CIDR stay editable. A Site's **IP/CIDR** field (comma-separated) colors the *remote* end of a flow directly — if a flow's public IP falls inside it, that IP gets the site's marker color even with no NAT Mapping involved. This is separate from NAT Mappings, which color the *local* end by mapping a private CIDR to a representative public IP for geolocation. Use the clone icon on a Sites row to pre-fill the add form from that row (key left blank, since it must be unique) instead of starting blank.

**Private/Public NAT Mapping** (Settings → Geo Map → Private/Public NAT Mapping, renamed from Address Mappings) — same private→public CIDR topology as before, plus:
- Multiple rows may now share the same private and/or public CIDR; priority order (drag-and-drop, same as before) resolves which one wins when more than one matches.
- A **Show in legend** checkbox per row controls whether it appears in the Geo Map legend's new NAT Mappings section (name + a swatch in its Site's color).
- An **ISP DHCP** checkbox (left of the Add Mapping button) for networks with no static public IP. Checking it locks every existing mapping — Add is disabled, and edit/clone/delete icons disappear from every row, matching the backend, which stops matching any of them — and creates one synthetic **Default** mapping (`0.0.0.0/0` private CIDR, no public CIDR, tagged with a "DHCP" badge in the table) so Traffic Rules still has something to scope to. That row won't place anything on the map by itself since a DHCP-assigned public IP can't be geolocated. Unchecking it deletes the synthetic mapping and unlocks everything else — **if you built a Traffic Rule scoped to that Default mapping while DHCP was on, deleting it cascades and deletes that rule too**, same as manually deleting any other NAT Mapping.
- **Destination CIDR/Port** (optional, per row) — lets the same Private CIDR resolve to a *different* Public CIDR depending on the flow's destination. Blank on both = applies to any destination (the common case). This is how you model a firewall that NATs the same internal range out different public IPs depending on where the traffic is headed.

**Worked example — NAT that varies by destination port.** Say your firewall NATs `10.1.157.141` to `104.62.87.92` when the destination port is 53, and to `104.62.87.89` for every other port. To make the Geo Map (and any Traffic Rule) reflect that correctly, you need **two** NAT Mapping rows, not one:

| Name | Private CIDR | Destination Port | Public CIDR | Priority |
|---|---|---|---|---|
| Work-DNS | `10.1.157.141/32` | `53` | `104.62.87.92` | higher (drag above) |
| Work-Default | `10.1.157.141/32` | *(blank — any)* | `104.62.87.89` | lower (catch-all) |

A Traffic Rule with NAT Mapping = **Work-DNS**, Destination = `1.1.1.1`, Port = *(blank/any)*, Line Style = Solid Blue then behaves exactly as you'd expect: traffic from `10.1.157.141` to `1.1.1.1:53` matches Work-DNS first (its own Destination Port filter is satisfied), so the rule fires and the arc draws Solid Blue from `104.62.87.92`. Traffic from the same PC to `1.1.1.1:80` doesn't match Work-DNS (wrong port), falls through to Work-Default instead, and since no Traffic Rule is scoped to Work-Default, that flow draws as the neutral gray default line from `104.62.87.89` — a different marker location, correctly reflecting the real NAT. **Scope your Traffic Rule to the specific mapping row that represents the NAT you're trying to isolate** (Work-DNS here), not a generic single mapping covering the whole private range — that's the part that's easy to get backwards.

A NAT Mapping's own Destination CIDR/Port is resolved **per flow pair**, not once per private IP — so the same private IP can legitimately show as two separate markers on the map if its real-world NAT genuinely differs by destination, which is the whole point.

**Traffic Rules** (Settings → Geo Map → Traffic Rules) — Destination can now be **manual entry** (as before) or a **Site** picked from a dropdown, populated from Settings → Geo Map → Sites and resolved against that Site's `ip_cidr` live at request time (editing the Site's IP/CIDR later automatically updates every rule pointing at it). One or the other, never both, and **once a rule is created with one mode it's locked to it** — the edit form only shows that mode, and the backend rejects a PUT that tries to switch. Delete and recreate the rule to change modes. Rows support clone-to-prefill (pre-fills whichever mode the source rule uses) in addition to edit/delete.

## Ingest configuration

- **HTTP method** (recommended): a goflow2 + Vector collector pipeline transforms raw NetFlow v9 into JSON and POSTs it with a bearer token to `/api/ingest/flows`. See the README's [Collector Configuration](../README.md#collector-configuration) section for the full pipeline setup.
- **Direct UDP method**: a built-in listener accepts NetFlow v5/v9/IPFIX/sFlow with no external collector. Changing the ingest method or UDP ports needs a service restart — the listener only starts/stops at process boot.
- **Source IP allowlist**: comma-separated IPs/CIDRs restricting who may POST flows at all, in addition to the bearer token and device-registry checks. A rejected source fires the same unknown-sampler alert as an unregistered device.
- **NAT Translations** only populate from the direct UDP path (the goflow2/Vector HTTP path normalizes into a schema with no NAT fields) and only when the exporting device actually sends NAT event telemetry (Cisco ASA/ISR NSEL, Juniper SRX, pfSense/OPNsense with NAT logging) — most consumer gear doesn't support this, so an empty table there is often expected, not broken.

## Device / sampler registry

Settings → Sources (Devices): name, IP, site per sampler, with CSV import/export and a downloadable template. **This list gates ingestion** — an IP sending flows that isn't present and enabled here is dropped before storage, not just unlabeled. A previously-unseen sampler raises a `new_host` alert with a one-click registration link. Unknown/dismissed sources are tracked separately from registered devices.

> Known footgun (fixed, but worth knowing): the in-memory allowlist cache used to only get populated reactively through UI edits, so a service restart could silently drop all incoming flows as "unregistered" until someone next touched a device record — even though the registry itself was correct. The cache is now warmed from the registry at process startup, so this no longer happens; mentioned here in case you're troubleshooting an older deployed build.

## Alert engine

Rule types, grouped as they appear in the New Rule picker:

| Group | Rule types |
|---|---|
| Traffic | Threshold, Rate spike (vs. 7-day rolling baseline), Top talker, Elephant flow, Inter-site traffic |
| Security | Port / protocol, Connection burst, Port scan, Internal spread, Protocol anomaly |
| Infrastructure | Data gap (silent sampler), Unknown sampler detected, Ingest rate low |

Alerts auto-resolve when the condition clears on the next evaluation; analysts/admins can acknowledge without closing. Bulk-provision rules via CSV export/import/template on the Rules tab. Alert retention (days before old events purge) is set on Data → Storage alongside other retention settings, not on the Alerts page itself. Note some Traffic-group detail lookups (baselines, elephant-flow/port-scan/inter-site/asymmetric-flow) are ClickHouse-only — see Storage backend below.

Enabling a notification channel under Notifications doesn't send anything by itself — it just makes the channel available to a rule. Each channel has a **Send Test** button that performs a real dispatch with whatever's currently filled in, even unsaved.

## Storage backend

- **ClickHouse** (default, production): requires ClickHouse installed and reachable — `install.sh` sets this up. Flow retention (TTL) and manual cleanup are on Data → Storage.
- **DuckDB**: embedded, no external service. Covers the core query paths (search, top talkers/ports, protocol distribution, topology) but 19 alert-engine detail methods (baselines, elephant-flow/threshold/port-scan/inter-site/asymmetric-flow lookups) intentionally raise `NotImplementedError` under DuckDB — those alert types are ClickHouse-only for now.

Switching backends requires a service restart. Use **Test Connection** to confirm the currently configured backend is actually reachable.

## Backup & Restore

Configure schedule, rotation, and path at Data → Backups (or trigger immediately with **Run Backup Now**, or `POST /api/system/backup`). Each snapshot is a timestamped directory containing a consistent copy of `pktflow.db` (via SQLite's own backup API — safe against a live database) and, if enabled, a `flows` export from ClickHouse.

**Restoring:**
- Every listed snapshot has a **Restore…** link — restores directly from that on-server snapshot, no download/upload needed. Expanding it shows a checkbox per file present, so you can restore just one piece instead of everything.
- **Export bundle** downloads a `.tar.gz`; **Restore from bundle** uploads one back, with the same per-file selection.
- Restoring `config.yaml` invalidates existing sessions (JWT secret changes) and needs a service restart to actually apply.

## SSL/HTTPS

Upload a PFX/P12 bundle or separate PEM cert+key on Settings → Security → SSL/TLS, then restart the service (General tab) — the process reads `ssl_enabled`/cert paths from the settings DB at startup and passes them to uvicorn. Disable by deleting the cert on the same panel and restarting. Worth confirming end-to-end after upload (`curl -k https://localhost:<port>/api/health`) in your own environment.

## Suite Integration (pktHub + sibling apps)

- **Inbound**: Settings → Security → Suite Integration → copy the Suite Token, register pktFlow in pktHub's App Manager with it. Regenerating the token immediately revokes the old one.
- **Outbound (Internal IP Lookup)**: add a named connection to one or more pktIPAM instances on the same tab — name, pktIPAM base URL, and the Suite Token copied from that pktIPAM's own Suite Integration page. The first *enabled* connection is used for internal-IP lookups app-wide. **Test Connection** does a real authenticated `/api/suite/whoami` round trip, so a wrong/revoked token actually fails the test.

## Known issues worth knowing about

- **`workers` must stay `1`** in the systemd unit — WebSocket broadcasts are per-process; multiple workers would mean some connected browsers never see live updates.
- **goflow2 "template error" after a restart is normal** — NetFlow v9 templates are cached in-memory and lost on restart; resolves within seconds once the router sends its next template packet.
- **Orphaned goflow2 process holding the ingest port** — if the collector pipeline restarts while flows are active, the old process can survive and squat on the port; symptom is "service active, no flows arriving." Fix: find and `kill -9` the old process.
- **`ingest_http_port` in Settings → Ingest is informational only** — it does not control the app's actual listen port; that's Settings → General → Port.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u pktflow -n 50`; check `config.yaml` / env vars and `PKTFLOW_SECRET_KEY` |
| Flows arriving but nothing stored | Is the sampler IP registered and enabled under Settings → Sources? Check the source-IP allowlist too |
| No flows at all after a restart | Confirm the collector/exporter is actually pointed at this host+port; check for an orphaned goflow2 process on the ingest port |
| WebSocket updates not showing for some users | Confirm the systemd unit runs a single worker |
| A restored `config.yaml` didn't take effect | Restart the service — restoring never does this automatically |

## Upgrading

Pull the latest code, rebuild the frontend if you build manually (`cd frontend && npm install && npm run build`), then restart the service. Schema/database migrations run automatically on startup.
