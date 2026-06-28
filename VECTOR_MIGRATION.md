# Migrating Collectors to pktFlow

How to switch existing goflow2 + Vector collectors from a previous sink (e.g. OpenObserve, Elasticsearch, or another TSDB) to pktFlow.

---

## Phase 1 — Parallel (recommended — validate before cutover)

Run both sinks simultaneously. pktFlow receives data while your existing system continues unchanged. Zero risk during validation.

### On each collector host

Edit `/opt/vector/vector.toml` and add a pktFlow sink alongside your existing one:

```toml
# ── Existing sink (leave in place during validation) ─────────────────────────
[sinks.previous_system]
type = "http"
inputs = ["add_site"]
uri = "http://<PREVIOUS_SYSTEM_HOST>:<PORT>/api/<collection_path>"
encoding.codec = "json"
# ... your existing auth config ...

# ── NEW: pktFlow sink ─────────────────────────────────────────────────────────
[sinks.pktflow]
type = "http"
inputs = ["add_site"]
uri = "http://<APP_SERVER_IP>:<APP_PORT>/api/ingest/flows"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN>"    # ← from pktFlow Settings → Ingest
request.timeout_secs = 10
healthcheck.enabled = false
```

Restart the service on each collector:
```bash
sudo systemctl restart goflow2-vector.service
sudo systemctl status goflow2-vector.service
```

### Verify parallel mode is working

1. Open pktFlow Dashboard → device cards should appear within 2 minutes
2. Check ingest stats: `curl http://<APP_SERVER_IP>:<APP_PORT>/api/ingest/stats`
3. Run for 24–48 hours to confirm data quality and flow counts match

---

## Phase 2 — Cutover (remove old sinks)

Once pktFlow is validated, remove the previous system sink from each collector's `vector.toml`. Keep only `[sinks.pktflow]`.

Restart each collector:
```bash
sudo systemctl restart goflow2-vector.service
```

Your previous system stops receiving new records. Existing data is preserved until its own retention expires.

---

## Verification commands

```bash
# Confirm pktFlow is receiving flows
curl -s http://<APP_SERVER_IP>:<APP_PORT>/api/ingest/stats

# Check pktFlow service health
curl -s http://<APP_SERVER_IP>:<APP_PORT>/api/health

# Watch pktFlow logs
tail -f /var/log/pktflow/pktflow.log

# Confirm ClickHouse is ingesting
clickhouse-client --query "SELECT count() FROM pktflow.flows WHERE timestamp >= now() - INTERVAL 5 MINUTE"
```
