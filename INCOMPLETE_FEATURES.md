# pktFlow — Incomplete & Untested Features

Generated: 2026-07-01. Rewritten: 2026-07-20 — the previous version of this file predated the
goflow2/Vector ingest pipeline, the Address Mappings/Traffic Rules Geo Map rebuild, and several
other cycles of work, and had drifted badly from what's actually in the codebase (it described
several features — direct UDP ingest, the storage Test Connection button, Topology drill-down,
Traffic by Port, Sankey diagrams, notification test endpoints — as "not built" when they are, in
fact, built and working). This rewrite is checked directly against the current code in `app/` and
`frontend/src/`, not against old commit messages.

Status of every feature that is not fully built and production-verified, or that has a real,
verified gap between documented/intended behavior and what the code currently does.

---

## Notification Channels — CODE WRITTEN, NOT CONFIRMED IN PRODUCTION

Dispatch methods for Slack, Email (SMTP), PagerDuty, generic Webhook, and Tracecat all exist and
are implemented directly in `app/alerts/engine.py` (the `app/alerts/notifiers/` package itself is
just an empty `__init__.py` — the dispatch code was never split out into it). `POST
/api/settings/test-notification` is a real endpoint backing each channel's "Send Test" button in
Settings → Notifications — it actually posts to Slack / sends SMTP / etc. using the saved
settings, it is not a stub. What's unverified: nobody has confirmed a message from any of these
channels actually arriving at a real live Slack workspace / SMTP inbox / PagerDuty
service / Tracecat webhook in production.

| Channel | Status | Notes |
|---------|--------|-------|
| Slack | Written, wired to Send Test | Uses `httpx` — present in `requirements.txt` |
| Email (SMTP) | Written, wired to Send Test | Uses `aiosmtplib` — present in `requirements.txt` |
| PagerDuty | Written, wired to Send Test | Untested against Events API v2 |
| Webhook | Written, wired to Send Test | Uses `jinja2` for payload templating (present in `requirements.txt`) — template rendering could still fail on a malformed template; not exercised against a real endpoint |
| Tracecat | Written, wired to Send Test | Newest of the five; least exercised |
| In-app (alert_events table) | Working | Confirmed — this is just SQLite writes, no external dependency |

---

## AI Assistant — BUILT, NOT CONFIRMED USED WITH A LIVE KEY IN PRODUCTION

`app/api/ai.py` is complete — calls the Anthropic Messages API with flow context, using a
configurable model (Settings → Security → AI Assistant → AI model; default
`claude-haiku-4-5-20251001`, selectable Sonnet `claude-sonnet-5` or Opus `claude-opus-4-8`).
`AiAssistant.tsx` renders the chat panel. `anthropic>=0.30.0` is a declared dependency in
`requirements.txt`. What's unverified: nobody has confirmed this actually working end-to-end
against a real Anthropic API key in a production deployment.

---

## DuckDB Storage Backend — CORE PATHS WORKING, ALERT-ENGINE GAPS BY DESIGN

`app/storage/duckdb.py` implements the core query paths used by the main UI (search, top
talkers/ports, protocol distribution, topology) and is selectable in Settings → Data → Storage.
An earlier crash (missing `get_top_ports` abstract method) has been fixed. What's still
incomplete, **deliberately**: 18 alert-engine detail-query methods (baselines, elephant-flow /
threshold / port-scan / inter-site / asymmetric-flow lookups, etc.) raise `NotImplementedError`
under DuckDB rather than being built out — so `threshold`, `rate_spike`, and similar alert rule
types that depend on those queries won't evaluate correctly under DuckDB. ClickHouse remains the
only backend with full alert-engine coverage. Whether the DuckDB path has been run against
real, sustained production traffic (vs. just fixed-and-verified-not-to-crash) has not been
confirmed.

---

## SSL/TLS Auto-Detection — LIKELY BROKEN AGAINST THE CURRENT PROCESS ENTRYPOINT

This is a genuine, verified gap between documented and actual behavior, not just an untested
feature — worth prioritizing over the others in this file.

The code that reads `ssl_enabled` / `ssl_certfile` / `ssl_keyfile` from the settings DB and passes
them into `uvicorn.run()` lives in an `if __name__ == "__main__":` block at the bottom of
`app/main.py`. That block only executes when `app/main.py` is run directly as a script
(`python -m app.main`). Neither of the two ways this app has actually been started reach it:

- The current systemd unit's `ExecStart` runs `python -m app.server`, and `app/server.py`'s own
  `main()` calls `uvicorn.run("app.main:app", host=..., port=..., workers=1, ...)` — this
  **imports** `app.main` as a module (so its `__main__` block never runs) and does not forward
  any SSL kwargs of its own.
- The previously-committed unit ran `uvicorn app.main:app --host ... --port 8766 ...` via the
  `uvicorn` CLI directly — same problem, `app.main` is imported, not executed as `__main__`.

`start.sh` in the repo root *does* build the `--ssl-certfile`/`--ssl-keyfile` uvicorn arguments
correctly by checking for cert files on disk — but it is not referenced by `install.sh` or by
either version of `pktflow.service`, so it appears to be orphaned.

**Net effect:** uploading a cert via Settings → Security → SSL/TLS and restarting the service may
not actually cause the running process to serve HTTPS. This needs to be confirmed end-to-end
(upload → restart → curl the port over HTTPS) against a real deployment before anyone relies on
it, and is likely worth fixing in `app/server.py` (read the same three settings keys there,
same as the dead code in `app/main.py` already does) rather than restoring `start.sh`.

---

## IP Lookup Gaps — DELIBERATE, NOT REGRESSIONS

- **Reverse DNS (PTR) lookup** for public IPs — not built. Was in the original plan as a
  no-API-key-needed third data point alongside ipinfo.io/AbuseIPDB in the public IP Lookup modal;
  never added. (The separate internal/pktIPAM lookup modal does show hostname via DHCP/DNS
  records, but that's a different code path.)
- **Geo Map IP lookup** — deliberately not wired. Geo Map's IPs render through raw Leaflet HTML
  tooltip strings and native SVG `<title>` elements, neither of which can host the `IpLink` React
  component without a different architecture. Geo Map's click-to-explore already routes into Flow
  Explorer, where the same IPs get full lookup treatment.
- **`<select>`/`<option>` device pickers** (Device View/Topology dropdowns) — HTML doesn't allow
  interactive content inside `<option>`, so these stay plain text by necessity, not oversight.

---

## Summary Table

| Feature | Backend | Frontend | Verified in production |
|---------|---------|----------|------------------------|
| goflow2/Vector ingest | ✅ Built | N/A | ✅ Yes |
| Direct UDP ingest | ✅ Built (`app/ingest/udp_listener.py`) | ✅ Settings UI | Selectable, off by default |
| Slack / Email / PagerDuty / Webhook / Tracecat notifications | ✅ Written | ✅ Settings UI + Send Test | ❌ Not confirmed against a live service |
| AI assistant | ✅ Written | ✅ Written | ❌ Not confirmed with a live API key |
| DuckDB backend | ✅ Core paths | N/A | ⚠️ Alert-engine gaps by design; production volume unconfirmed |
| SSL/TLS auto-detect | ⚠️ Likely broken against current entrypoint | ✅ Settings UI | ❌ Needs end-to-end verification |
| Storage Test Connection | ✅ Built (`/api/system/test-connection`) | ✅ UI button | ✅ Yes |
| Topology node click → flow drill-down | ✅ Built | ✅ Built | ✅ Yes |
| Traffic by Port page | ✅ Built | ✅ Built (URL-only, not in sidebar nav) | ✅ Yes |
| Sankey flow diagrams | ✅ Built (Analytics + Device View) | ✅ Built | ✅ Yes |
| Internal IP Lookup (pktIPAM) | ✅ Built | ✅ Built | ✅ Yes, pending a configured pktIPAM connection |
| Default admin / auto-login | ✅ Built | ✅ Built | ✅ Yes |
| Reverse DNS (PTR) lookup | ❌ Not built | ❌ Not built | — |
| Geo Map IP lookup | ❌ Not built (deliberate) | ❌ Not built (deliberate) | — |

---

*See [FEATURES.md](FEATURES.md) for the full current feature inventory and [README.md](README.md)
for install/config instructions and API reference. Update this file when a status changes rather
than letting it drift — the previous version of this file sat stale for a full cycle of major
feature work before this rewrite.*
