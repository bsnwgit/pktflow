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

`app/api/ai.py` is complete — multi-provider now: local/self-hosted (Ollama, or any
OpenAI-compatible endpoint) tried first, then cloud (Anthropic, OpenAI), each independently
enabled in Settings → Security → AI Assistant. Anthropic's model is configurable (default
`claude-haiku-4-5-20251001`, selectable Sonnet `claude-sonnet-5` or Opus `claude-opus-4-8`).
`AiAssistant.tsx` renders the chat panel. `anthropic>=0.30.0` is a declared dependency in
`requirements.txt` for the Anthropic provider; the local and OpenAI providers use plain
`httpx` calls, no extra dependency. What's unverified: nobody has confirmed any of these
providers actually working end-to-end against a real key/server in a production deployment.

---

## DuckDB Storage Backend — CORE PATHS WORKING, ALERT-ENGINE GAPS BY DESIGN

`app/storage/duckdb.py` implements the core query paths used by the main UI (search, top
talkers/ports, protocol distribution, topology) and is selectable in Settings → Data → Storage.
An earlier crash (missing `get_top_ports` abstract method) has been fixed. What's still
incomplete, **deliberately**: 19 alert-engine detail-query methods (baselines, elephant-flow /
threshold / port-scan / inter-site / asymmetric-flow lookups, etc.) raise `NotImplementedError`
under DuckDB rather than being built out — so `threshold`, `rate_spike`, and similar alert rule
types that depend on those queries won't evaluate correctly under DuckDB. ClickHouse remains the
only backend with full alert-engine coverage. Whether the DuckDB path has been run against
real, sustained production traffic (vs. just fixed-and-verified-not-to-crash) has not been
confirmed.

---

## SSL/TLS Auto-Detection — FIXED (was broken against the process entrypoint)

**This was a genuine, verified gap between documented and actual behavior — now fixed
(commit `0f673e1`, "Fix SSL/TLS settings never reaching uvicorn at the real entrypoint").**

Previously, the code that read `ssl_enabled` / `ssl_certfile` / `ssl_keyfile` from the settings DB
and passed them into `uvicorn.run()` lived in an `if __name__ == "__main__":` block at the bottom
of `app/main.py`, which only executes when `app/main.py` is run directly as a script — something
neither the systemd `ExecStart` (`python -m app.server`, which imports `app.main` as a module) nor
a direct `uvicorn app.main:app ...` CLI invocation actually does.

**Fix applied:** the SSL-settings read + forwarding logic was moved into `app/server.py::main()`
— the function the systemd unit actually calls. It reads the same three settings keys from
SQLite before calling `uvicorn.run()` and passes `ssl_certfile`/`ssl_keyfile` through when a cert
is enabled and both paths resolve. The orphaned `start.sh` wrapper (which built the same uvicorn
args correctly but was never referenced by `install.sh` or `pktflow.service`) was deleted as part
of the same commit, since its logic now lives in the real entrypoint instead.

**What's still unverified:** the code path is now confirmed correct by inspection, but nobody has
run the full loop (upload a cert via Settings → Security → SSL/TLS → restart → `curl -k
https://localhost:<port>/api/health`) against a live deployment in this environment to confirm
uvicorn actually binds in HTTPS mode end-to-end. Worth a quick real-world check before fully
trusting it in production, but this is no longer a known code-level gap.

---

## IP Lookup Gaps — DELIBERATE, NOT REGRESSIONS

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
| SSL/TLS auto-detect | ✅ Fixed — wired into `app/server.py`'s real entrypoint | ✅ Settings UI | ⚠️ Code path confirmed correct; live cert-upload+restart not confirmed in this environment |
| Storage Test Connection | ✅ Built (`/api/system/test-connection`) | ✅ UI button | ✅ Yes |
| Topology node click → flow drill-down | ✅ Built | ✅ Built | ✅ Yes |
| Traffic by Port page | ✅ Built | ✅ Built (URL-only, not in sidebar nav) | ✅ Yes |
| Sankey flow diagrams | ✅ Built (Analytics + Device View) | ✅ Built | ✅ Yes |
| NAT Translations | ✅ Built (direct UDP path only) | ✅ Built | ✅ Yes, empty table expected unless exporter+ingest-mode support NAT event fields |
| Internal IP Lookup (pktIPAM) | ✅ Built | ✅ Built | ✅ Yes, pending a configured pktIPAM connection |
| Default admin / auto-login | ✅ Built | ✅ Built | ✅ Yes |
| Reverse DNS (PTR) lookup | ✅ Built (MXToolbox `ptr` command) | ✅ Built | ✅ Yes |
| ASN lookup (`AsnLink`) | ✅ Built | ✅ Built | ✅ Yes |
| Geo Map IP lookup | ❌ Not built (deliberate) | ❌ Not built (deliberate) | — |

---

*See [FEATURES.md](FEATURES.md) for the full current feature inventory and [README.md](README.md)
for install/config instructions and API reference. Update this file when a status changes rather
than letting it drift — the previous version of this file sat stale for a full cycle of major
feature work before this rewrite.*
