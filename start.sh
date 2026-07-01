#!/bin/bash
# pktFlow start wrapper — conditionally enables SSL
# Auto-detects /mnt/software/pktflow/ssl/server.crt + server.key on startup.
# To enable HTTPS: upload cert/key via Settings → Integrations → SSL / TLS, then restart.
# To disable HTTPS: remove the cert via Settings (or rm /mnt/software/pktflow/ssl/server.*), then restart.

SSL_CERT="/mnt/software/pktflow/ssl/server.crt"
SSL_KEY="/mnt/software/pktflow/ssl/server.key"
UVICORN="/mnt/software/pktflow/venv/bin/uvicorn"
ARGS="app.main:app --host 0.0.0.0 --port 8766 --workers 1 --log-level info"

if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
    echo "[pktflow] SSL detected — starting HTTPS"
    exec "$UVICORN" $ARGS --ssl-certfile "$SSL_CERT" --ssl-keyfile "$SSL_KEY"
else
    echo "[pktflow] No SSL files — starting HTTP"
    exec "$UVICORN" $ARGS
fi
