#!/bin/bash
set -e

# pktFlow Docker entrypoint
# Ensures data directories exist and seeds the default admin user on first run,
# then starts the application.

# ── Ensure data directories ───────────────────────────────────────────────────
mkdir -p /data/logs /data/ssl

# ── Seed default admin user (first-run only) ─────────────────────────────────
# The app's init_db() handles this during startup via PKTFLOW_ADMIN_USER and
# PKTFLOW_ADMIN_PASSWORD environment variables. Nothing extra needed here.

# ── Start application ─────────────────────────────────────────────────────────
exec "$@"
