# pktFlow — Incomplete & Untested Features

Generated: 2026-06-25  
Status of every planned feature that is not fully built and production-verified.

---

## Okta OIDC Authentication — NOT BUILT

**SAML 2.0 (Okta) is working.** OIDC is a separate implementation.

**Settings UI:** Tab 4 (Authentication) has Okta OIDC config fields (Issuer URL, Client ID, Client Secret, Redirect URI, group → role mapping).  
**Database:** `users.okta_sub` column exists.  
**Backend:** `app/auth/okta.py` **does not exist**. `app/auth/` only contains `local.py`.

**What needs building:** `app/auth/okta.py` with OIDC flow, callback handler registered in `app/api/auth.py`, and group → role resolution from the Okta token.

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

## Direct UDP NetFlow Ingest — NOT BUILT

**Settings UI:** Tab 3 (Ingest) has ingest method selector: HTTP POST / Direct UDP / Both, with UDP port fields.  
**Backend:** `app/ingest/udp_listener.py` **does not exist**. No UDP socket listener. Not registered in `app/main.py`.

**What needs building:** Async UDP listener that decodes NetFlow v5/v9/IPFIX directly (without goflow2/vector), normalizes records, and feeds into the same `IngestBuffer`.

---

## AI Assistant — BUILT, UNTESTED IN PRODUCTION

**Backend:** `app/api/ai.py` is complete — calls Anthropic claude-haiku-4-5 with flow context.  
**Frontend:** `AiAssistant.tsx` component exists and renders a chat panel.

**Blockers:** Requires `anthropic` Python package in the venv, and an Anthropic API key set in Settings → General. Neither has been verified on O2.

---

## Migration Mode — NOT BUILT

**Settings UI:** Tab 3 (Ingest) has a "Migration mode" toggle + O2 forwarding URL field.  
**Backend:** No logic to forward received flows on to a secondary destination. The field saves to the database but nothing reads it.

---

## "Test Connection" Button — Settings → Storage

Settings Tab 2 (Storage) has a "Test Connection" button for ClickHouse. There is no `/api/settings/test-connection` endpoint. The button exists in the UI with no wired backend action.

---

## Topology Node Click — Flow Drill-Down — NOT BUILT

Clicking a node in the topology graph should open a flow list filtered to that node's IP. Currently nodes are not interactive beyond hover tooltips.

**What needs building:** A click handler on topology nodes that navigates to the flows view pre-filtered by `src_ip=<node_ip> OR dst_ip=<node_ip>`.

---

## DuckDB Backend — BUILT, NOT PRODUCTION TESTED

`app/storage/duckdb.py` is fully implemented. It has **never been run against real data** on O2. The ClickHouse backend is the only one proven in production.

---

## Traffic by Port Page — NOT BUILT

New page planned: protocol mix chart, top ports by bytes/flows, traffic chart over time, full port inventory table (every dst_port seen), filterable by sampler/site.

---

## Sankey Flow Diagram — NOT BUILT

Visualization planned: `src_ip → dst_port → dst_ip` alluvial/Sankey chart with band width proportional to bytes. Use D3-sankey. Goes on the Traffic by Port page or its own tab.

---

## Summary Table

| Feature | Backend | Frontend | Tested |
|---------|---------|----------|--------|
| Okta OIDC auth | ❌ Not built | ✅ Settings UI | ❌ |
| Slack notifications | ✅ Written | ✅ Settings UI | ❌ |
| Email notifications | ✅ Written | ✅ Settings UI | ❌ |
| PagerDuty notifications | ✅ Written | ✅ Settings UI | ❌ |
| Webhook notifications | ✅ Written | ✅ Settings UI | ❌ |
| "Send Test" notification buttons | ❌ No endpoint | ✅ UI buttons | ❌ |
| AI assistant | ✅ Written | ✅ Written | ❌ |
| Direct UDP ingest | ❌ Not built | ✅ Settings UI | ❌ |
| Migration mode / forwarding | ❌ Not built | ✅ Settings UI | ❌ |
| Storage test connection | ❌ No endpoint | ✅ UI button | ❌ |
| DuckDB backend | ✅ Written | N/A | ❌ |
| Topology node click → flow drill-down | ❌ Not built | ❌ Not built | ❌ |
| Traffic by Port page | ❌ Not built | ❌ Not built | ❌ |
| Sankey flow diagram | ❌ Not built | ❌ Not built | ❌ |
