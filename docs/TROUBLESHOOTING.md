# pktFlow — Troubleshooting

Symptom, cause, and the command that proves which cause it is.

Placeholders follow [DATAFLOW.md](../DATAFLOW.md): `<ROUTER_IP>` is a sampler,
`<COLLECTOR_IP>` a goflow2/Vector host, `<APP_SERVER_IP>` this server, and
`<INSTALL_DIR>` the install directory (`/opt/pktflow` by default).

For the pipeline itself, read [DATAFLOW.md](../DATAFLOW.md) before changing
anything in the ingest path. For behaviour that is deliberately absent, see
[Known behaviour that is not a fault](#known-behaviour-that-is-not-a-fault) at
the end — several "bugs" reported against pktFlow are entries in
[INCOMPLETE_FEATURES.md](../INCOMPLETE_FEATURES.md).

---

## Contents

- [The first five minutes](#the-first-five-minutes)
- [The service will not start](#the-service-will-not-start)
- [The service runs but nothing answers](#the-service-runs-but-nothing-answers)
- [The UI is blank, stale, or 404](#the-ui-is-blank-stale-or-404)
- [Login and accounts](#login-and-accounts)
- [No flows are arriving](#no-flows-are-arriving)
- [Flows arrive but are not stored](#flows-arrive-but-are-not-stored)
- [Storage — ClickHouse and DuckDB](#storage--clickhouse-and-duckdb)
- [Dashboards, queries and the map](#dashboards-queries-and-the-map)
- [Alerts](#alerts)
- [Notifications](#notifications)
- [Suite integration and IP lookups](#suite-integration-and-ip-lookups)
- [A config change did not take effect](#a-config-change-did-not-take-effect)
- [TLS / HTTPS](#tls--https)
- [Backup and restore](#backup-and-restore)
- [Upgrades and migrations](#upgrades-and-migrations)
- [Performance and disk](#performance-and-disk)
- [Uninstalling and reinstalling](#uninstalling-and-reinstalling)
- [Known behaviour that is not a fault](#known-behaviour-that-is-not-a-fault)
- [What to capture before reporting a problem](#what-to-capture-before-reporting-a-problem)

---

## The first five minutes

Run these in order. They separate "the process is dead" from "the process is
fine and the problem is upstream", which decides everything after it.

```bash
sudo systemctl status pktflow --no-pager
```

```bash
sudo journalctl -u pktflow -n 100 --no-pager
```

```bash
sudo tail -n 100 <INSTALL_DIR>/logs/pktflow.log
```

```bash
sudo ss -ltnp | grep 8766
```

```bash
curl -s http://127.0.0.1:8766/api/health
```

```bash
curl -s http://127.0.0.1:8766/api/ingest/stats
```

| What you see | Go to |
|---|---|
| `inactive (dead)` or `failed` | [The service will not start](#the-service-will-not-start) |
| `activating (auto-restart)`, repeatedly | [The service will not start](#the-service-will-not-start) |
| Running, but nothing on 8766 | [The service runs but nothing answers](#the-service-runs-but-nothing-answers) |
| Health 200, UI blank or 404 | [The UI is blank, stale, or 404](#the-ui-is-blank-stale-or-404) |
| Health 200, dashboards empty | [No flows are arriving](#no-flows-are-arriving) |
| `/api/ingest/stats` counters rising, still no data on screen | [Flows arrive but are not stored](#flows-arrive-but-are-not-stored) |

Check the log file **and** the journal. The unit appends stdout and stderr to
`<INSTALL_DIR>/logs/pktflow.log`, so the journal can look nearly empty while the
real traceback is in the file. Failures early in startup land in the journal
instead.

---

## The service will not start

```bash
sudo journalctl -u pktflow -n 200 --no-pager
sudo tail -n 200 <INSTALL_DIR>/logs/pktflow.log
```

If neither shows anything useful, run it in the foreground — the fastest way to
see a traceback that never reached a log:

```bash
sudo -u <service-user> \
  PKTFLOW_CONFIG=<INSTALL_DIR>/config.yaml \
  PKTFLOW_INSTALL_DIR=<INSTALL_DIR> \
  <INSTALL_DIR>/venv/bin/python -m app.server
```

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | venv missing packages, or built against a different Python | `<INSTALL_DIR>/venv/bin/pip install -r requirements.txt`. If Python was upgraded under it, delete and rebuild the venv |
| `yaml.scanner.ScannerError` | `config.yaml` is not valid YAML — usually a tab, or an unquoted value containing `:` | `python3 -c "import yaml; yaml.safe_load(open('<INSTALL_DIR>/config.yaml'))"` and fix the line it names |
| Complaint about `secret_key` or `credential_key` | Left at `CHANGE_ME_…` | `openssl rand -hex 32` for `secret_key`; `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` for `credential_key` |
| `Address already in use` | Something else holds 8766 | `sudo ss -ltnp \| grep 8766`. Stop it, or change `port:` in `config.yaml` and restart |
| `Permission denied` binding the port | A port below 1024 was configured | The pktFlow unit does **not** set `CAP_NET_BIND_SERVICE`. Use the default high port, or add the capability to the unit deliberately |
| `Permission denied` on the DB or log directory | Install dir not owned by the service user | `sudo chown -R <service-user>:<service-group> <INSTALL_DIR>` |
| `unable to open database file` | Wrong `db_path`, or its parent directory is missing | Fix `db_path` in `config.yaml` |
| Fernet `InvalidToken` | `credential_key` changed after credentials were stored | See [A config change did not take effect](#a-config-change-did-not-take-effect) |
| Nothing in the journal, unit `failed` | Malformed unit, or a wrong `ExecStart` path | `systemd-analyze verify /etc/systemd/system/pktflow.service`; confirm `<INSTALL_DIR>/venv/bin/python` exists |

### It restarts forever

pktFlow's unit uses `Restart=always`, not `on-failure`. This is deliberate: the
app's in-UI restart falls back to sending itself SIGTERM when it has no
passwordless sudo for `systemctl restart`, and a clean SIGTERM is not a
"failure" — under `on-failure` the service would stop and stay down.

The cost is that a genuinely broken app restarts forever. Read the log rather
than watching the status, and stop it while you investigate:

```bash
sudo systemctl stop pktflow
```

### It runs by hand but not under systemd

Environment. The unit sets exactly two variables:

```
Environment=PKTFLOW_CONFIG=<INSTALL_DIR>/config.yaml
Environment=PKTFLOW_INSTALL_DIR=<INSTALL_DIR>
```

Config resolution is `PKTFLOW_*` env vars, then `config.yaml` found via
`$PKTFLOW_CONFIG` → `$PKTFLOW_INSTALL_DIR/config.yaml` → `./config.yaml` →
`~/.pktflow/config.yaml`, then built-in defaults. An env var beats the file
silently, and `WorkingDirectory` decides what `./config.yaml` means.

```bash
systemctl cat pktflow
systemctl show pktflow -p Environment
```

---

## The service runs but nothing answers

```bash
sudo ss -ltnp | grep 8766
```

`host:` and `port:` are read from `config.yaml` at every process start — they
are deliberately **not** in the unit file, so Settings → General → Port needs
only a restart, never a unit edit.

- Nothing on 8766 but the process is alive → it bound elsewhere. Check
  `config.yaml`.
- Bound to `127.0.0.1` → reachable only from the host. Set `host: "0.0.0.0"` and
  restart.

Then work outward one hop at a time:

```bash
curl -sv http://127.0.0.1:8766/api/health
curl -sv http://<APP_SERVER_IP>:8766/api/health   # from this host
curl -sv http://<APP_SERVER_IP>:8766/api/health   # from another machine
```

| Where it breaks | Cause |
|---|---|
| Fails on loopback | Not a network problem — go back to [the service will not start](#the-service-will-not-start) |
| Works on loopback, fails on the host's own IP | Bound to loopback, or a host firewall |
| Works on the host, fails from elsewhere | `ufw`/`nftables`/`iptables`, a security group, or routing |
| Connects then hangs | A middlebox, or the app blocked on something — read the log |
| TLS error | HTTPS against an HTTP listener or the reverse. See [TLS / HTTPS](#tls--https) |

```bash
sudo ufw status verbose
```

---

## The UI is blank, stale, or 404

The backend serves the built SPA from `frontend/dist`, mounting `/assets` and
falling through to `index.html` for SPA routes — but only if `frontend/dist`
exists.

| Symptom | Cause | Fix |
|---|---|---|
| `{"detail":"Not Found"}` at the root | The frontend was never built | `cd frontend && npm install && npm run build`, then restart. `install.sh` builds it only if `npm` is already on `PATH` — Node.js 20.x LTS is a prerequisite it does not install |
| Blank page, console 404s on `/assets/index-*.js` | `dist` is stale or half-built; `index.html` names hashed bundles that no longer exist | Rebuild, then hard-refresh (Ctrl/Cmd-Shift-R) |
| Old UI after an upgrade | The browser cached `index.html`, pinning the old bundles | Hard refresh. If it persists for everyone, the rebuild did not run |
| UI loads, every call 401 | Session expired — see [Login and accounts](#login-and-accounts) |
| UI loads, every call blocked by CORS | The frontend is on a different origin from the API | Normally the same origin serves both. Only list an exact origin in `cors_origins` if you host the frontend separately; never `"*"` with credentialed requests |
| The UI shows another app's name | A deploy pointed at the wrong install directory — every app in the suite has the same tree shape, so a misaimed sync succeeds and still passes health checks | Compare `curl -s http://localhost:8766/openapi.json \| head -c 120` with the `<title>` from `curl -s http://localhost:8766/`. If they disagree, restore `frontend/` from a backup or redeploy from a pktFlow checkout |

---

## Login and accounts

Auth is bcrypt password hashing plus JWT — a short-lived access token and a
refresh token. Roles are `admin` / `analyst` / `viewer`.

| Symptom | Cause | Fix |
|---|---|---|
| 401 immediately after logging in | Clock skew invalidates the token's `exp` | `timedatectl` on the server; fix NTP |
| Logged out every few minutes | The refresh call is failing | Check the browser network tab and the app log |
| Password rejected as too short | Minimum 8 characters on every path | Use a longer one |
| A user sees fewer pages than expected | Role, not a fault | `viewer` and `analyst` are deliberately narrower than `admin` |
| Locked out of every account | No admin session left | Reset the hash directly — below |

### Resetting the admin password

With the service stopped, on the host. Confirm the column names first rather
than assuming them:

```bash
sudo systemctl stop pktflow
sqlite3 <INSTALL_DIR>/pktflow.db ".schema users"
```

Generate the hash with the app's own venv so the bcrypt version matches:

```bash
<INSTALL_DIR>/venv/bin/python -c "import bcrypt; print(bcrypt.hashpw(b'NewPassword1!', bcrypt.gensalt()).decode())"
```

`UPDATE` the row, restart, then change the password again through the UI. Back
the database up first.

---

## No flows are arriving

**The single most common problem, and the app being healthy tells you nothing
about it.**

### Check this first: is the sampler in the device registry?

**A sampler can be sending flows perfectly and have every single record
discarded, silently, because its IP is not registered under Settings →
Sources.** This is the most common cause of "everything is configured and
nothing appears", and it applies to **both ingest modes** — the transport
settings control what is allowed to *arrive*, the device registry controls what
is allowed to *persist*:

> Settings → Devices is the gateway for what's allowed to persist — a sampler
> can be sending flows on the wire, but nothing is stored unless its IP is
> registered there and marked Allowed.
> — [`app/ingest/normalizer.py:153`](../app/ingest/normalizer.py)

An unregistered sampler's records are dropped at normalisation and a "new host"
alert is raised. **That is the diagnostic signal**: `new_host` alerts firing
while nothing is stored means exactly this.

- Settings → Sources, and add the sampler.
- `GET /api/devices/unknown-samplers` lists samplers seen but not registered,
  split into unknown and dismissed. A sampler previously *dismissed* stays
  dismissed and keeps being dropped — `DELETE /api/devices/dismiss/<ip>`
  reverses that.
- Records with no valid sampler address are also dropped: a `SamplerAddress` of
  `0.0.0.0`, empty or missing is rejected outright. If Vector is not carrying
  the sampler address through, everything is discarded for this reason instead.

The registry cache is refreshed on startup and after a settings change. If you
added a device and nothing changed, restart the service.

### Then establish which ingest path you are running

pktFlow supports two, and they fail in completely different ways:

Settings → Ingest, or the `ingest_method` setting: `http`, `udp`, or `both`.

```
Mode 1 (http)  Router → UDP → collector host: goflow2 | Vector → POST /api/ingest/flows → ClickHouse
Mode 2 (udp)   Router → UDP → pktFlow's own listener → ClickHouse
```

Mode 1 is the recommended, production-proven path — goflow2 handles NetFlow v9
and IPFIX template negotiation, and it needs no inbound firewall change here.
Mode 2 is built and selectable but **off by default**.

**Changing the ingest method or either UDP port requires an actual service
restart.** The UDP listener only starts or stops at process startup, so saving
the Settings form alone switches nothing live. This catches people out
repeatedly.

### Step 1 — is anything on the wire at all?

Run this on whichever host should be receiving: the collector host in Mode 1,
this server in Mode 2.

```bash
sudo tcpdump -ni any udp port 2055 -c 20
```

No packets means the problem is the router or the network, not pktFlow. Check
the exporter's configuration, its destination address and port, and anything
between them. Nothing further in this section will help until packets arrive.

### Step 2 — Mode 1: the collector host

```bash
sudo systemctl status goflow2-vector --no-pager
sudo journalctl -u goflow2-vector -n 100 --no-pager
```

goflow2 and Vector run as one piped command under a single unit, so **either
half dying takes the pipe down**. Vector retries with exponential backoff when
pktFlow is unreachable, so a queue draining late looks like a burst, not a loss.

| Symptom | Cause |
|---|---|
| Pipe restarts constantly | One half is exiting — read the journal for which |
| goflow2 decodes nothing after a restart | It caches NetFlow v9 templates and loses them on restart. Routers resend within seconds — if it stays empty, the exporter is not sending templates |
| Vector reports connection errors | It cannot reach `http://<APP_SERVER_IP>:8766/api/ingest/flows` — test that URL from the collector host |

### Step 3 — Mode 1: is pktFlow accepting the POSTs?

`POST /api/ingest/flows` returns **204 No Content** on success, which is what
Vector expects. The failures are specific:

| Response | Meaning | Fix |
|---|---|---|
| `401 Invalid ingest token` | An `ingest_token` is set and the bearer token does not match | Copy the token from Settings → Ingest into Vector's `auth.token`. `install.sh` sets this token, so a fresh install already has one |
| `403 Source not in allowed hosts` | The collector's IP is not in `allowed_hosts` | Add the collector's IP or CIDR in Settings. **An empty list allows everything** — so a 403 means the list is non-empty and does not include this source. This also raises a "new host" alert |
| `400 Invalid JSON` | The body is neither a JSON array nor NDJSON | Check Vector's `encoding.codec` |
| 204, but nothing appears | Records were accepted and then dropped in normalisation | See [Flows arrive but are not stored](#flows-arrive-but-are-not-stored) |

Test the endpoint by hand from the collector host:

```bash
curl -i -X POST http://<APP_SERVER_IP>:8766/api/ingest/flows \
  -H "Authorization: Bearer <INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '[]'
```

An empty array is accepted and returns 204 without storing anything. That
isolates the token and the allowlist from record content — but note it proves
nothing about the device registry, which is checked later, per record, during
normalisation.

### Step 4 — Mode 2: the built-in UDP listener

| Symptom | Cause |
|---|---|
| Nothing received | `ingest_method` is `http` — the listener is off by default. Set it to `udp` or `both` and restart |
| Listener on, still nothing | Check the port: `ingest_udp_port_netflow` (2055) and `ingest_udp_port_sflow` (6343) are settings, not `config.yaml` entries |
| Port not open | `sudo ss -lunp \| grep 2055` — note `-u` for UDP |
| An orphaned process holds the port | A previous goflow2 left running will silently take the packets. Find and stop it |

### Step 5 — the allowlist and token apply to Mode 1 only

`allowed_hosts` and `ingest_token` guard the HTTP endpoint. They do not filter
the UDP listener. If you switched modes and expected the allowlist to still
apply, it does not.

---

## Flows arrive but are not stored

`/api/ingest/stats` reports the buffer's state — records held and total flushed.

```bash
curl -s http://127.0.0.1:8766/api/ingest/stats
```

Records are buffered and flushed when a size threshold is reached or
`ingest_buffer_flush_secs` elapses, whichever comes first. This is deliberate:
ingest is a hot path, and per-record work would not keep up.

| Symptom | Cause | Fix |
|---|---|---|
| `total_flushed` stays at zero while records arrive | Flushes are failing against the storage backend | Read the app log for the storage error, then [Storage](#storage--clickhouse-and-duckdb) |
| `total_flushed` rises, dashboards still empty | The data is stored but the query is not finding it — usually a time-range or timezone mismatch | Widen the range; check the sampler's clock |
| **Every record dropped, `new_host` alerts firing** | **The sampler is not registered under Settings → Sources** | The commonest cause by a distance — see [Check this first](#check-this-first-is-the-sampler-in-the-device-registry) |
| Every record dropped, no alerts | `SamplerAddress` is `0.0.0.0`, empty or absent | Check Vector is carrying the sampler address through |
| Some records vanish silently | Normalisation dropped them | The log records `Buffered N/M records` at debug level. Raise `log_level` to `debug` and compare N against M |
| Everything drops in normalisation | Field-name shape mismatch | The normaliser accepts Vector's snake_case output and goflow2's PascalCase protobuf-JSON. A third shape will not normalise — check what Vector is actually emitting |
| Malformed records | Individually skipped, logged at debug as `Skipping malformed flow record` | Raise `log_level` to `debug` to see the offending record |
| Data appears in bursts, minutes late | Vector queued while pktFlow or ClickHouse was unreachable, then drained | Expected behaviour. Fix the underlying outage |
| A short gap after every restart | The buffer drains on shutdown, but anything in flight at a hard kill is lost | Stop the service cleanly rather than killing it |

---

## Storage — ClickHouse and DuckDB

The backend is the `storage_backend` **setting** (`clickhouse` or `duckdb`),
selectable in Settings → Data → Storage. `config.yaml` carries only the
connection details. Settings → Data has a **Test Connection** button backed by
`/api/system/test-connection`.

```bash
sudo systemctl status clickhouse-server --no-pager
clickhouse-client --query "SELECT 1"
clickhouse-client --query "SELECT count() FROM pktflow.flows"
```

The schema defines `pktflow.flows`, `pktflow.flows_hourly` and
`pktflow.flows_daily`.

| Symptom | Cause | Fix |
|---|---|---|
| `Connection refused` | ClickHouse is down, or `clickhouse_host`/`clickhouse_port` are wrong | Native protocol is 9000 by default |
| `Authentication failed` | `clickhouse_user`/`clickhouse_password` wrong | A default install uses `default` with an empty password |
| `Table doesn't exist` | Schema never applied, or applied to another database | Re-apply `clickhouse/schema.sql` — it is written to be safe to re-run |
| ClickHouse will not start | Frequently memory on a small host | `journalctl -u clickhouse-server` for the real reason |
| Switching backend "lost" the data | The two backends are separate stores; switching does not migrate | Switch back to see it again |
| DuckDB errors about a locked file | DuckDB allows one write connection | `workers` must be 1 on a DuckDB backend |
| Disk filling | Retention too long, or not applied | `retention_days_raw` (default 90) and `retention_days_hourly` (default 365). Changing `retention_days_raw` pushes a new TTL into the storage backend |

### Alerts behave differently under DuckDB — by design

Nineteen alert-engine detail queries raise `NotImplementedError` under DuckDB
rather than being built out. Rule types that depend on them — `threshold`,
`rate_spike`, `elephant_flow`, `inter_site_traffic`, `port_scan` and the
baseline-driven types — **will not evaluate correctly on DuckDB**.

ClickHouse is the only backend with full alert-engine coverage. If alerts stopped
working after a backend switch, this is why, and it is not a fault to fix in
configuration.

---

## Dashboards, queries and the map

| Symptom | Cause | Fix |
|---|---|---|
| A panel is empty | Usually genuinely no data in that range | Widen the time range before assuming a fault |
| Queries time out on long ranges | Scan volume | Narrow the range. Queries are built to filter on time first; a range that covers everything reads the whole table |
| Live updates missing for some users | State that is per-process being split across workers | Confirm the unit runs a single worker |
| The geo map is empty | No geo configuration, or the addresses are private | Private ranges have no public geolocation |
| Clicking an IP on the geo map does nothing | Deliberate — see [Known behaviour](#known-behaviour-that-is-not-a-fault) | Use the map's click-to-explore into Flow Explorer, where IPs have full lookup |
| NAT mappings look wrong | Address-mapping rules | Check Traffic Rules and Address Mappings; `scripts/verify_vpn.py` exists for VPN-path checks |
| Topology missing devices | Enrichment has nothing to match on | Devices are annotated from flow data — an unseen device will not appear |

---

## Alerts

Rule types: `data_gap`, `new_host`, `threshold`, `rate_spike`, `port_protocol`,
`top_talker`, `elephant_flow`, `inter_site_traffic`, `connection_burst`,
`port_scan`, `internal_spread`, `protocol_anomaly`, `ingest_rate_low`,
`clickhouse_size`.

| Symptom | Cause |
|---|---|
| No alerts of any kind | Nothing is being evaluated because no flows are arriving — fix ingest first |
| Some rule types never fire, others do | You are on the DuckDB backend — see [Storage](#storage--clickhouse-and-duckdb) |
| `new_host` fires constantly, and nothing is being stored | An unregistered sampler is being dropped at normalisation, raising this alert on every batch. Register it under Settings → Sources — see [No flows are arriving](#check-this-first-is-the-sampler-in-the-device-registry) |
| `new_host` fires on a genuinely new device | Working as intended. A source rejected by the HTTP allowlist also raises it |
| `data_gap` / `ingest_rate_low` firing | These are doing their job — the pipeline has stopped. Go to [No flows are arriving](#no-flows-are-arriving) |
| `clickhouse_size` firing | Disk or retention — see [Performance and disk](#performance-and-disk) |
| Alerts fire once and never again | Deduplication on the rule |
| Old alerts disappearing | `alert_event_retention_days` (default 90) prunes `alert_events` and `notification_log` |

---

## Notifications

Channels are in-app, Slack, Email (SMTP), PagerDuty, generic Webhook and
Tracecat, dispatched from `app/alerts/engine.py`. Each has a **Send Test**
button in Settings → Notifications, backed by
`POST /api/settings/test-notification` — a real send using the saved settings,
not a stub.

Senders are written never to raise: a broken Slack webhook must not stop an
alert reaching the other channels. That is correct, and it also means **a
failing channel looks like nothing happening**. Use Send Test to get the error.

| Symptom | Cause |
|---|---|
| In-app alerts appear, external ones do not | The channel is disabled or incomplete — Send Test will say which |
| Email never arrives | SMTP host, port, TLS, credentials, or a relay refusing the sender address. Test SMTP independently from the host |
| Slack returns 4xx | Webhook revoked or malformed — regenerate it in Slack |
| Webhook target sees nothing | Method, payload template or headers. The template is Jinja2 and a malformed one can fail at render time |
| PagerDuty or Tracecat silent | Both are written and wired to Send Test but have not been confirmed against a live service — treat a first-time setup as unproven and use Send Test |

---

## Suite integration and IP lookups

Apps authenticate to each other with a shared suite token. Outbound lookups
need egress.

| Symptom | Cause |
|---|---|
| Internal IPs show no context | Needs a configured, enabled pktIPAM connection under Settings → Integrations |
| A sibling connection's health check fails on TLS | Suite calls verify the target's certificate. Fix the target's certificate, or clear verify-TLS for that connection |
| Reverse DNS or ASN lookups empty | These use MXToolbox — check egress and the integration's last error |
| Everything broke after rotating the token | The token is shared; every consumer needs updating |

---

## A config change did not take effect

Four distinct causes, easily confused.

**You edited the wrong file.** Env vars beat the file silently:

```bash
systemctl show pktflow -p Environment
```

**You did not restart.** Nothing in `config.yaml` is re-read live, and restoring
a backed-up `config.yaml` never restarts the service — that is the most common
variant of this.

**The setting is not in `config.yaml` at all.** `config.yaml` holds startup and
infrastructure only: host, port, workers, secrets, paths, ClickHouse and DuckDB
connection details. Storage backend, retention, ingest method and ports, ingest
token, allowed hosts, alert rules and notification channels all live in
**SQLite** and are managed in the UI. Editing `config.yaml` for those does
nothing.

**It is a UI setting that needs a restart.** Restart and re-test when unsure.

### `credential_key` changed or was lost

Stored secrets are Fernet-encrypted with `credential_key`. Change it and every
existing secret becomes undecryptable — you get `InvalidToken`, not a helpful
message. Restore the old key, or re-enter every stored credential. Nothing else
recovers them. This is why `uninstall.sh` keeps `config.yaml` by default.

Note that the API redacts secret values — `ingest_token` and
`notify_email_password` among them — so reading a setting back will not show you
what is stored.

---

## TLS / HTTPS

The SSL settings (`ssl_enabled`, `ssl_certfile`, `ssl_keyfile`) are read in
`app/server.py::main()` — the function the systemd unit actually calls — and
passed into uvicorn when a cert is enabled and both paths resolve.

This was previously wired into an `if __name__ == "__main__":` block in
`app/main.py`, which the real entrypoint never executes, so the settings never
reached uvicorn. That is fixed. If you are on an older build and HTTPS silently
never engages, that is the cause. The orphaned `start.sh` wrapper was deleted in
the same change — pktFlow's unit runs `python -m app.server` directly, unlike
pktLog.

| Symptom | Cause | Fix |
|---|---|---|
| Still HTTP after uploading a cert | Not restarted | Restart the service |
| `ERR_SSL_PROTOCOL_ERROR` | HTTPS against an HTTP listener | Confirm which scheme it bound |
| Certificate warning | Self-signed, or the SAN does not cover the hostname people type | Expected for self-signed |
| Will not start after a cert upload | Key does not match the cert, or is unreadable by the service user | Compare `openssl x509 -noout -modulus -in cert.pem \| openssl md5` with `openssl rsa -noout -modulus -in key.pem \| openssl md5` |

Verify end to end after any change:

```bash
curl -k https://127.0.0.1:8766/api/health
```

---

## Backup and restore

Scheduled backups write timestamped `backup_*` directories under the backup
root. Settings live in SQLite, not `config.yaml`.

| Symptom | Cause |
|---|---|
| No backups appearing | The schedule is off, or the settings are unset |
| Backups fail | Backup root not writable, or the disk is full |
| Restore "worked" but nothing changed | A restored `config.yaml` never restarts the service — restart it |
| Restored onto a different host and secrets fail | `credential_key` differs; restore `config.yaml` too |

For a manual snapshot, stop the service and copy everything except `venv/` and
`frontend/node_modules`. **Never copy a live SQLite database with `cp`** — take
all three of `pktflow.db`, `-wal` and `-shm` with the service stopped, or use
`sqlite3 … ".backup"`.

---

## Upgrades and migrations

Migrations are numbered `.sql` files run on startup, tracked in `_migrations`,
written to be idempotent.

```bash
git pull
cd frontend && npm install && npm run build && cd ..
sudo systemctl restart pktflow
```

Re-running `install.sh` is the better route when a release drops or renames a
file: it detects the existing install, reports the version it found, and offers
to uninstall first so no stale module is left importable. Data is kept, and the
port you enter is applied to the existing `config.yaml` without touching another
line. `PKTFLOW_REMOVE_EXISTING=1` (or `0`) answers that prompt from a script;
non-interactive runs upgrade in place.

| Symptom | Cause |
|---|---|
| `no such column` / `no such table` | Migrations did not run — the app failed earlier in startup. Read the log |
| A migration fails | Hand-edited schema, or a partially applied earlier one. Compare `SELECT * FROM _migrations` against `ls migrations/`. Restore from backup before experimenting |
| App upgraded, UI did not | Frontend not rebuilt, or browser cache |
| `VERSION` looks wrong | It is bumped by `scripts/bump_version.py` and never hand-edited |

---

## Performance and disk

```bash
df -h
du -sh <INSTALL_DIR>/*
```

| Symptom | Where to look |
|---|---|
| Disk filling | `logs/`, `backups/`, `flows.duckdb`, and ClickHouse's own store — which `du` on the install directory will not show |
| Ingest dropping under load | `/api/ingest/stats`; then whether the storage backend is keeping up |
| Queries slow | Time range first, then ClickHouse health, then retention |
| Live updates only working for some users | Multiple workers splitting per-process state — use one |
| Memory climbing | Check retention and query sizes before assuming a leak |
| Slow at one time of day | A scheduled job — backup or retention |

Flow volume is high and bursty by nature. Sustained ingest that outruns the
storage backend shows up as a rising buffer, not as errors.

---

## Uninstalling and reinstalling

`install.sh` copies `uninstall.sh` into the install directory, so it is on the
host without the repo:

```bash
bash <INSTALL_DIR>/uninstall.sh
```

It reads the install directory from the systemd unit, stops and removes the
service, and deletes the code and the venv. **Data is kept by default** —
`config.yaml`, `pktflow.db` and its `-wal`/`-shm`, `logs/`, `backups/`, anything
under `ssl/`, and `flows.duckdb`. It asks separately about those, defaulting to
no.

| Flag | Effect |
|---|---|
| *(none)* | Remove service, code and venv; keep data. Prompts first |
| `--purge` | Also delete config, database, logs, backups and TLS material. Not recoverable |
| `--dry-run` | Print what would be removed; change nothing |
| `--yes` | Skip prompts — required non-interactively |
| `--dir PATH` | Install directory, if the unit file is already gone |

- Re-running `install.sh` against the same directory picks the kept data back
  up, so the admin password and every setting survive a non-purge uninstall.
- An install directory that is itself a git checkout is detected, and its source
  tree is never deleted — only the unit and the venv go.
- `--purge` does **not** drop the ClickHouse database `pktflow`: ClickHouse may
  be shared with the rest of the suite. The uninstaller prints the
  `DROP DATABASE` for you to run.

**Never mirror over an install directory with `rsync --delete`.** Live state
sits beside the code — `config.yaml`, the database and its `-wal`/`-shm`,
`venv/`, `logs/`, `backups/`, `ssl/`, `flows.duckdb`,
`frontend/node_modules`.

---

## Known behaviour that is not a fault

Checked against [INCOMPLETE_FEATURES.md](../INCOMPLETE_FEATURES.md). Reporting
these as bugs wastes time.

- **An unregistered sampler's flows are discarded, not queued.** The device
  registry is the gate on what may persist, deliberately — it is not a filter
  that can be bypassed by getting the transport right.
- **Direct UDP ingest is off by default.** It is built and selectable
  (`ingest_method`), not missing. Changing it needs a service restart.
- **Alert types that need baselines do not work under DuckDB.** Nineteen
  alert-engine detail queries raise `NotImplementedError` there, deliberately.
  ClickHouse is the only backend with full coverage.
- **Clicking an IP on the Geo Map does not open a lookup.** Deliberate: the map
  renders IPs through Leaflet tooltip HTML and native SVG `<title>`, neither of
  which can host the lookup component. Click-to-explore routes into Flow
  Explorer, where the same IPs get the full treatment.
- **Device pickers in Device View and Topology are plain text.** HTML does not
  allow interactive content inside `<option>`.
- **Traffic by Port has no sidebar entry.** The page is built and works; it is
  reachable by URL only.
- **Slack / Email / PagerDuty / Webhook / Tracecat are unconfirmed against live
  services.** All five are implemented and wired to a real Send Test. None has
  been confirmed arriving at a real workspace, inbox or service. Use Send Test
  before trusting a channel.
- **The DuckDB backend has not been confirmed under sustained production
  volume.** Core query paths work; that is a different claim.

There are no automated tests in this repository. Anything reported as verified
here was verified by hand.

---

## What to capture before reporting a problem

1. `VERSION`, and how it was installed — `install.sh`, in-place checkout, or manual.
2. `systemctl status pktflow` plus the last 200 lines of **both** the journal and
   `logs/pktflow.log`.
3. `config.yaml` **with `secret_key`, `credential_key` and any passwords removed**.
4. Which ingest mode: the `ingest_method` setting.
5. `curl -s http://127.0.0.1:8766/api/health` and
   `curl -s http://127.0.0.1:8766/api/ingest/stats`, run **on the host**.
6. For a data problem: `tcpdump` output proving packets arrive at all, and for
   Mode 1 the last 100 lines of the collector's `goflow2-vector` journal.
7. What changed immediately before it broke — an upgrade, a config edit, a
   certificate, a network change. This answers more cases than the logs do.

Never paste real secrets, tokens, keys, or an unredacted `config.yaml`.
