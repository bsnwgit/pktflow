# pktFlow — Incomplete & Untested Features

Generated: 2026-06-23  
Status of every planned feature that is not fully built and production-verified.

---

## Alert Engine — Rule Types

### threshold, rate_spike, port_protocol — NOT IMPLEMENTED
**File:** `app/alerts/engine.py` — `_evaluate_rule()`

The engine loop exists and `data_gap` + `new_host` rules fire correctly. The other three rule types hit this code and silently do nothing:

```python
# Additional rule types (threshold, rate_spike, port_protocol) — Phase 4
# Placeholder: skip for now
return
```

**What needs building:**
- `threshold` — query ClickHouse for aggregate metric (bytes/packets/flows) over a time window, compare to the configured threshold
- `rate_spike` — compare current rate to rolling 7-day baseline from ClickHouse, fire if ratio exceeds configured multiplier
- `port_protocol` — scan recent flows for matches on configured port/protocol/direction combinations

**Alert rule conditions UI** in `Alerts.tsx` sends `conditions: {}` for all rule types — the condition builder form is a generic text area, not per-rule-type field sets. The UI needs rule-type-aware condition fields alongside the engine work.

---

## Okta OIDC Authentication — NOT BUILT

**Settings UI:** Tab 4 (Authentication) has full Okta config fields (Issuer URL, Client ID, Client Secret, Redirect URI, group → role mapping).  
**Database:** `users.okta_sub` column exists.  
**Backend:** `app/auth/okta.py` **does not exist**. `app/auth/` only contains `local.py`.  
No OIDC callback route, no token exchange, no group-to-role mapping logic.

**What needs building:** `app/auth/okta.py` with OIDC flow, callback handler registered in `app/api/auth.py`, and group → role resolution from the Okta token.

---

## Direct UDP NetFlow Ingest — NOT BUILT

**Settings UI:** Tab 3 (Ingest) has ingest method selector: HTTP POST / Direct UDP / Both, with UDP port fields (NetFlow 2055, sFlow 6343).  
**Backend:** `app/ingest/udp_listener.py` **does not exist**. No UDP socket listener. Not registered in `app/main.py`.

**What needs building:** Async UDP listener that decodes NetFlow v5/v9/IPFIX directly (without goflow2/vector), normalizes records, and feeds into the same `IngestBuffer`.

---

## Notification Channels — CODE WRITTEN, UNTESTED

The dispatch methods exist in `app/alerts/engine.py` for Slack, Email, PagerDuty, and Webhook, but **none have been tested against real services**.

| Channel | Status | Known risks |
|---------|--------|-------------|
| **Slack** | Written | Needs `httpx` — may not be in venv |
| **Email** | Written | Needs `aiosmtplib` — not in requirements.txt |
| **PagerDuty** | Written | Needs `httpx`, untested against Events API v2 |
| **Webhook** | Written | Needs `jinja2` — not verified in venv; template render could fail on malformed templates |
| **In-app** | Working | This is just the alert_events table — confirmed working |

**Also:** Settings page has "Send Test" buttons for each notification channel. There are **no backend endpoints** for these (`/api/settings/test-notification` or similar does not exist).

---

## Data Retention & Rollup — PARTIALLY BUILT

**Raw retention:** Settings `retention_days_raw` → calls `update_retention_ttl()` on the storage backend → sets ClickHouse TTL. **This works.**

**Aggregate rollup tables:** The architecture doc specifies hourly and daily rollup tables with their own longer retention. These tables may exist in `clickhouse/schema.sql` but the **rollup job that populates them does not exist**. There is no scheduled task writing to `flows_hourly` or `flows_daily`.

**Manual retention cleanup button:** Settings UI has a trigger button + last-run timestamp. No backend endpoint for manual cleanup trigger exists.

---

## AI Assistant — BUILT, UNTESTED IN PRODUCTION

**Backend:** `app/api/ai.py` is complete — calls Anthropic claude-haiku-4-5 with flow context.  
**Frontend:** `AiAssistant.tsx` component exists and renders a chat panel.

**Blockers:** Requires `anthropic` Python package in the venv, and an Anthropic API key set in Settings → General. Neither has been verified on O2. The component may not be wired into any page layout that renders it.

---

## Migration Mode — NOT BUILT

**Settings UI:** Tab 3 (Ingest) has a "Migration mode" toggle + O2 forwarding URL field (`http://10.20.30.5:5080/api/default/medical_netflow/_json`).

**Backend:** No logic to forward received flows on to a secondary destination. The field saves to the database but nothing reads it.

---

## "Test Connection" Button — Settings → Storage

Settings Tab 2 (Storage) has a "Test Connection" button for ClickHouse. There is no `/api/settings/test-connection` endpoint or equivalent. The button exists in the UI with no wired backend action.

---

## Device Import from CSV — NOT BUILT

The architecture doc specifies a CSV import option in the device registry. The Devices settings tab has no import button in the current implementation.

---

## Unknown Samplers Section — NOT BUILT

Architecture doc specifies a section in Settings → Devices showing IPs that have sent flow data but are not in the device registry, with a prompt to add or block them. This view does not exist. The `new_host` alert fires correctly, but there is no UI surface for reviewing and acting on unknown samplers outside of the alert event list.

---

## WebSocket Live Updates — NOT BUILT

Architecture doc specifies WebSocket connections for live Dashboard updates (flows/sec, active alerts badge). The current Dashboard uses polling (REST GET every few seconds). No WebSocket routes exist in the backend.

---

## DuckDB Backend — BUILT, NOT PRODUCTION TESTED

`app/storage/duckdb.py` is fully implemented with connection pooling and all query methods. It was written as an alternate backend for low-traffic deployments. It has **never been run against real data** and has not been verified on O2. The ClickHouse backend is the only one proven in production.

---

## Summary Table

| Feature | Backend | Frontend | Tested |
|---------|---------|----------|--------|
| threshold / rate_spike / port_protocol alerts | ❌ Not built | ⚠️ Generic only | ❌ |
| Alert condition builder (per rule type) | ❌ | ❌ | ❌ |
| Okta OIDC auth | ❌ Not built | ✅ Settings UI | ❌ |
| Direct UDP ingest | ❌ Not built | ✅ Settings UI | ❌ |
| Slack notifications | ✅ Written | ✅ Settings UI | ❌ |
| Email notifications | ✅ Written | ✅ Settings UI | ❌ |
| PagerDuty notifications | ✅ Written | ✅ Settings UI | ❌ |
| Webhook notifications | ✅ Written | ✅ Settings UI | ❌ |
| "Send Test" notification buttons | ❌ No endpoint | ✅ UI buttons | ❌ |
| Aggregate rollup (hourly/daily) | ❌ No job | N/A | ❌ |
| Manual retention cleanup trigger | ❌ No endpoint | ✅ UI button | ❌ |
| AI assistant | ✅ Written | ✅ Written | ❌ |
| Migration mode / O2 forwarding | ❌ Not built | ✅ Settings UI | ❌ |
| Storage test connection | ❌ No endpoint | ✅ UI button | ❌ |
| Device CSV import | ❌ Not built | ❌ Not built | ❌ |
| Unknown samplers UI | ❌ Not built | ❌ Not built | ❌ |
| WebSocket live updates | ❌ Not built | ❌ Not built | ❌ |
| DuckDB backend | ✅ Written | N/A | ❌ |
