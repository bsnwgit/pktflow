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
| | | SSL / TLS | Cert/key or PFX upload | restart to load new cert |
| | Data | Storage | Backend (ClickHouse default / DuckDB), retention days, cleanup, Test Connection | backend switch: yes |
| | | Backups | Schedule, rotation, manual run, restore | restore of config.yaml: yes |
| | Notifications | — | Slack/Email/PagerDuty/Webhook/Tracecat channels | no |
| | Resonance | — | Embedded assistant — server address, key, who may open it, placement (admin only) | no |
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

**Worked example — NAT that varies by destination port.** Say your firewall NATs `10.0.0.41` to `203.0.113.92` when the destination port is 53, and to `203.0.113.89` for every other port. To make the Geo Map (and any Traffic Rule) reflect that correctly, you need **two** NAT Mapping rows, not one:

| Name | Private CIDR | Destination Port | Public CIDR | Priority |
|---|---|---|---|---|
| Work-DNS | `10.0.0.41/32` | `53` | `203.0.113.92` | higher (drag above) |
| Work-Default | `10.0.0.41/32` | *(blank — any)* | `203.0.113.89` | lower (catch-all) |

A Traffic Rule with NAT Mapping = **Work-DNS**, Destination = `203.0.113.1`, Port = *(blank/any)*, Line Style = Solid Blue then behaves exactly as you'd expect: traffic from `10.0.0.41` to `203.0.113.1:53` matches Work-DNS first (its own Destination Port filter is satisfied), so the rule fires and the arc draws Solid Blue from `203.0.113.92`. Traffic from the same PC to `203.0.113.1:80` doesn't match Work-DNS (wrong port), falls through to Work-Default instead, and since no Traffic Rule is scoped to Work-Default, that flow draws as the neutral gray default line from `203.0.113.89` — a different marker location, correctly reflecting the real NAT. **Scope your Traffic Rule to the specific mapping row that represents the NAT you're trying to isolate** (Work-DNS here), not a generic single mapping covering the whole private range — that's the part that's easy to get backwards.

A NAT Mapping's own Destination CIDR/Port is resolved **per flow pair**, not once per private IP — so the same private IP can legitimately show as two separate markers on the map if its real-world NAT genuinely differs by destination, which is the whole point.

**Traffic Rules** (Settings → Geo Map → Traffic Rules) — Destination can now be **manual entry** (as before) or a **Site** picked from a dropdown, populated from Settings → Geo Map → Sites and resolved against that Site's `ip_cidr` live at request time (editing the Site's IP/CIDR later automatically updates every rule pointing at it). One or the other, never both, and **once a rule is created with one mode it's locked to it** — the edit form only shows that mode, and the backend rejects a PUT that tries to switch. Delete and recreate the rule to change modes. Rows support clone-to-prefill (pre-fills whichever mode the source rule uses) in addition to edit/delete.

## Ingest configuration

- **HTTP method** (recommended): a goflow2 + Vector collector pipeline transforms raw NetFlow v9 into JSON and POSTs it with a bearer token to `/api/ingest/flows`. See the README's [Collector Configuration](../README.md#collector-configuration) section for the full pipeline setup.
- **Direct UDP method**: a built-in listener accepts NetFlow v5/v9/IPFIX/sFlow with no external collector. Changing the ingest method or UDP ports needs a service restart — the listener only starts/stops at process boot.
- **Source IP allowlist**: comma-separated IPs/CIDRs restricting who may POST flows at all, in addition to the bearer token and device-registry checks. A rejected source fires the same unknown-sampler alert as an unregistered device.

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

### Managed mode

pktHub can put this app into **Managed mode**, which stops people reaching its UI directly and sends them to the hub instead. Nothing needs configuring here: the hub sends the address to redirect to when it applies the lock, because that address is built from the hub's own Base URL and this app's id in the hub's registry, and neither is visible from this side.

The lock redirects rather than shuts down. Anything carrying a valid suite token passes through untouched, as do `/api/health`, `/api/suite/`, `/api/auth/` and the paths a hub-rendered page needs, so pktHub itself keeps working normally.

**It expires on its own.** Every call from pktHub refreshes a heartbeat and the lock releases after five minutes without one, so it does not depend on the hub coming back — a lock only pktHub could lift would strand this app exactly when pktHub is what broke. `GET /api/suite/mode` reports the current state without authentication.

The redirect address can also be set by hand at Settings → Integrations → Suite Integration, for an install with no pktHub in front of it. It takes http/https only, since every visitor follows it while the lock is on, and pktHub overwrites it whenever it applies a lock — so leaving it blank is normal.

- **Inbound**: Settings → Security → Suite Integration → copy the Suite Token, register pktFlow in pktHub's App Manager with it. Regenerating the token immediately revokes the old one.
- **Outbound (Internal IP Lookup)**: add a named connection to one or more pktIPAM instances on the same tab — name, pktIPAM base URL, and the Suite Token copied from that pktIPAM's own Suite Integration page. The first *enabled* connection is used for internal-IP lookups app-wide. **Test Connection** does a real authenticated `/api/suite/whoami` round trip, so a wrong/revoked token actually fails the test.

## Known issues worth knowing about

- **`workers` must stay `1`** in the systemd unit — WebSocket broadcasts are per-process; multiple workers would mean some connected browsers never see live updates.
- **goflow2 "template error" after a restart is normal** — NetFlow v9 templates are cached in-memory and lost on restart; resolves within seconds once the router sends its next template packet.
- **Orphaned goflow2 process holding the ingest port** — if the collector pipeline restarts while flows are active, the old process can survive and squat on the port; symptom is "service active, no flows arriving." Fix: find and `kill -9` the old process.
- **`ingest_http_port` in Settings → Ingest is informational only** — it does not control the app's actual listen port; that's Settings → General → Port.

## Resonance (embedded assistant)

Settings → Resonance (admin only). Adds an assistant launcher to the bottom corner of every page. The assistant itself runs on the resonance server; pktFlow only decides who may open it.

**Setting it up.** Paste the **interface server** address — not resonance's admin portal, which answers on a different address and serves `embed.js` too, so it looks right until the session call returns "not found" — then the key you were issued. Choose which roles may use it, press **Test Connection**, and only then switch **Enabled** on. Test Connection works whether or not the feature is enabled; always prove a key before putting the widget in front of users. Every field ships blank, so a fresh install shows nothing until it is pointed at a resonance server of its own.

Two things have to line up on the resonance side, and both fail silently when they don't:

- **This install's origin** must be on the key's allow-list. The exact string is shown ready to copy on the same page. Behind a reverse proxy, fill in **pktFlow's own address** yourself — what the app detects is the internal address, not the one users type.
- **Speakers Name** must be on for the key. Without it resonance records nothing, so there is no trace of who asked what.

**Reachability, twice over.**

- Resonance must be reachable **from the browser**, over HTTPS, with a certificate those browsers already trust. An untrusted certificate produces an empty widget and nothing in the console to explain it.
- pktFlow also calls resonance **server to server**, so this host must resolve resonance's name and trust its certificate — the browser doing both is not enough. Python verifies against its own bundled roots rather than the system store, so a certificate signed by an internal CA is trusted by every browser on the network and still rejected here. Point **CA bundle** at the system store instead (`/etc/ssl/certs/ca-certificates.crt` on Debian and Ubuntu).

**What it can reach.** Individual flow records, the top talkers in a window, the exporters sending flow data, the configured sites and their ranges, the collection summary, alert rules and the alerts they have fired, and pktFlow's own diagnostic log. Every call is made by pktFlow's own page on the session of whoever is signed in, so it reaches only what that person could already open. `/.well-known/resonance.json` lists exactly what is on offer.

**Flow search is capped harder than anything else in the suite**, and deliberately: a flow record is wide and an unbounded window over a busy exporter is millions of them. A window is always applied (an hour by default), the page is a fraction of what the Flow Explorer returns, and the true match count comes back alongside — so the assistant reports "eleven thousand matched, here are twenty-five" instead of presenting a page as the whole answer.

**What it can never do**, at any role level: purge a sampler's history, change retention, or create, edit or delete a site, NAT mapping or traffic rule.

Documentation is published separately at `GET /api/resonance/docs`, to a suite token or an admin session — the guides shipped with the running version.

**What each role can do.** Set per role. *No access* hides the launcher entirely. *Read only* lets the assistant look at the operations above. *Read and write* also lets it act — and adds exactly three things, no more: acknowledge one alert, acknowledge all of them, and switch an existing alert rule on or off. Resonance stops and reads the actual values back to the person before it runs any of them.

**A level never exceeds the role.** Two checks have to agree: the level set here, and pktFlow's own rule for the thing being done. Switching a rule is an analyst's to do in the interface, so a viewer set to *Read and write* still cannot.

Where no role is set to *Read and write*, the write operations are withheld from the published grant altogether, so there is nothing at the resonance end that could be turned on. Every write the assistant performs is recorded in the application log with who asked for it.

**Credentials.** pktFlow never sends a login to resonance. It vouches for whoever is signed in and gets back a short-lived, single-use code the browser spends on opening the panel. The key is encrypted at rest and never reaches the browser.

**If it never appears.** Diagnostics reports how many users could not load the widget in the last week; the usual causes are an ad blocker, a wrong server address, or resonance being unreachable. Repeated failures pause the integration for a few minutes rather than hammering resonance — the panel says so while it is paused, and a successful Test Connection clears it.

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

Re-running `install.sh` also works, and is the better route when a release drops
or renames a file: it detects the existing install, reports the version it
found, and offers to uninstall it first so no stale module is left importable.
Your data is kept either way, and the port you enter at the prompt is applied to
the existing `config.yaml` without touching another line of it. Set
`PKTFLOW_REMOVE_EXISTING=1` (or `0`) to answer that prompt from a script;
non-interactive runs upgrade in place.

## Uninstalling

`install.sh` copies `uninstall.sh` into the install directory, so it is on the
host without the repo:

```bash
bash /opt/pktflow/uninstall.sh
```

It reads the install directory from the systemd unit, stops and removes the
service, and deletes the application code and the virtualenv. **Data is kept by
default** — `config.yaml` (which holds the JWT secret and the credential
encryption key), `pktflow.db` and its `-wal`/`-shm`, `logs/`, `backups/` and
anything uploaded under `ssl/`, `flows.duckdb`. It asks separately before
removing those, and that prompt defaults to no.

| Flag | Effect |
|---|---|
| *(none)* | Remove the service, the code and the venv; keep data. Prompts first. |
| `--purge` | Also delete the config, database, logs, backups and TLS material. Not recoverable. |
| `--dry-run` | Print what would be removed; change nothing. |
| `--yes` | Skip the prompts — required for a non-interactive run. |
| `--dir PATH` | Install directory, if the unit file is already gone. |

Re-running `install.sh` afterwards against the same directory picks the kept
data back up, so the admin password and every setting survive an uninstall that
was not a `--purge`.

An install directory that is itself a git checkout (an in-place install) is
detected, and its source tree is never deleted — only the unit and the venv go.

`--purge` does not drop the ClickHouse database `pktflow`: ClickHouse is a
separate service that may be shared with the rest of the suite. The uninstaller
prints the `DROP DATABASE` command for you to run if you want it gone.

