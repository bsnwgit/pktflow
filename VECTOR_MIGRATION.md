# Collector Migration — O2 → pktFlow

How to switch the GoFlow2 collectors from sending netflow to OpenObserve over to pktFlow.

---

## Phase 1 — Parallel (recommended — validate before cutover)

Run both sinks simultaneously. pktFlow receives data while O2 continues unchanged. Zero risk.

### Medical Collector (172.23.80.11)

Edit `/mnt/software/vector/vector.toml`:

```toml
# ── Existing O2 sink (leave in place during validation) ──────────────────────
[sinks.openobserve]
type = "http"
inputs = ["add_site"]
uri = "http://172.23.80.5:5080/api/default/medical_netflow/_json"
encoding.codec = "json"
auth.strategy = "basic"
auth.user = "itops@vynecorp.com"
auth.password = "Mf7N5JzLiYGWKeB7xLuyPj3sf"

# ── NEW: pktFlow sink ─────────────────────────────────────────────────────────
[sinks.pktflow]
type = "http"
inputs = ["add_site"]
uri = "http://172.23.80.5:8080/api/ingest/flows"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN_FROM_INSTALL>"    # ← paste from install output
request.timeout_secs = 10
healthcheck.enabled = false
```

Restart the service:
```bash
sudo systemctl restart goflow2-vector.service
sudo systemctl status goflow2-vector.service
```

### Dental Collector (10.56.57.181)

Edit `/mnt/software/vector/vector.toml` — same pattern, change URI to `dental_netflow`:

```toml
[sinks.pktflow]
type = "http"
inputs = ["add_site"]
uri = "http://172.23.80.5:8080/api/ingest/flows"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "<INGEST_TOKEN_FROM_INSTALL>"
request.timeout_secs = 10
healthcheck.enabled = false
```

Restart:
```bash
sudo systemctl restart goflow2-vector.service
```

### Verify parallel mode is working

1. Open pktFlow Dashboard → device cards should appear within 2 minutes
2. Check ingest stats: `curl http://172.23.80.5:8080/api/ingest/stats`
3. Run for 24–48 hours to confirm data quality

---

## Phase 2 — Cutover (remove O2 netflow sinks)

Once pktFlow is validated, remove the O2 sink from both `vector.toml` files.

**Medical** — remove the `[sinks.openobserve]` block, keep only `[sinks.pktflow]`

**Dental** — same

Restart both collectors:
```bash
# On medical (172.23.80.11):
sudo systemctl restart goflow2-vector.service

# On dental (10.56.57.181):
sudo systemctl restart goflow2-vector.service
```

O2 will stop receiving new netflow records. Existing O2 netflow data is preserved
until its 180-day retention expires.

---

## Verification commands

```bash
# Confirm pktFlow is receiving flows
curl -s http://172.23.80.5:8080/api/ingest/stats

# Check pktFlow service health
curl -s http://172.23.80.5:8080/api/health

# Watch pktFlow logs
tail -f /mnt/software/logs/pktflow.log

# Confirm ClickHouse is ingesting
clickhouse-client --query "SELECT count() FROM pktflow.flows WHERE timestamp >= now() - INTERVAL 5 MINUTE"
```
