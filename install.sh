#!/bin/bash
# pktFlow install script — Ubuntu Server 22.04/24.04 LTS
# Usage: bash install.sh
# Prompts for the install directory (default /opt/pktflow) and port (default
# 8766) when run interactively.
# Override defaults with env vars to skip the prompts, e.g.:
#   PKTFLOW_INSTALL_DIR=/opt/pktflow PKTFLOW_SERVICE_USER=pktflow PKTFLOW_PORT=8766 bash install.sh

set -euo pipefail

# -- Pre-flight: do not run as root ---------------------------------------------
# This script calls sudo itself for the few steps that need it. Running the
# whole thing as root instead leaves $INSTALL_DIR, the venv and the database
# owned by root, which the service user then cannot write — the service starts,
# fails to open its own database, and crash-loops.
if [ "$(id -u)" -eq 0 ]; then
    echo "ERROR: don't run this with sudo or as root." >&2
    echo "       Run it as your normal user — it calls sudo itself where needed:" >&2
    echo "         bash install.sh" >&2
    exit 1
fi

if [ -z "${PKTFLOW_INSTALL_DIR:-}" ] && [ -t 0 ]; then
    read -rp "Install directory [/opt/pktflow]: " INSTALL_DIR_INPUT
    INSTALL_DIR="${INSTALL_DIR_INPUT:-/opt/pktflow}"
else
    INSTALL_DIR="${PKTFLOW_INSTALL_DIR:-/opt/pktflow}"
fi
# Normalize: expand a leading ~ (read/env vars don't do this automatically —
# a literal "~" ends up baked into the config and the systemd unit, and
# systemd rejects a WorkingDirectory that isn't an absolute path), and
# strip any trailing slash so the REPO_DIR/INSTALL_DIR string-equality
# check below (in-place install guard) isn't fooled by "/path/" vs "/path".
case "$INSTALL_DIR" in
    "~") INSTALL_DIR="$HOME" ;;
    "~/"*) INSTALL_DIR="$HOME/${INSTALL_DIR#\~/}" ;;
esac
INSTALL_DIR="${INSTALL_DIR%/}"
case "$INSTALL_DIR" in
    /*) ;;
    *)  echo "ERROR: install directory must be an absolute path (got '$INSTALL_DIR')." >&2
        exit 1 ;;
esac
if [ -z "${PKTFLOW_PORT:-}" ] && [ -t 0 ]; then
    read -rp "Port [8766]: " PORT_INPUT
    PORT="${PORT_INPUT:-8766}"
else
    PORT="${PKTFLOW_PORT:-8766}"
fi
# An unusable port reaches systemd unnoticed otherwise: the unit starts, the
# server fails to bind, systemd retries, and the install "succeeds" with
# nothing listening. Reject it here, while someone is watching.
case "$PORT" in
    ''|*[!0-9]*)
        echo "ERROR: port must be a number (got '$PORT')." >&2
        exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "ERROR: port must be between 1 and 65535 (got $PORT)." >&2
    exit 1
fi
LOG_DIR="${PKTFLOW_LOG_DIR:-$INSTALL_DIR/logs}"
SERVICE_USER="${PKTFLOW_SERVICE_USER:-$(whoami)}"
SERVICE_GROUP="${PKTFLOW_SERVICE_GROUP:-$SERVICE_USER}"
VENV="$INSTALL_DIR/venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR"

echo "=== pktFlow Installer ==="
echo "Install dir: $INSTALL_DIR"
echo "Service user: $SERVICE_USER"
echo "Port: $PORT"
echo ""

# -- Existing installation ------------------------------------------------------
# Installing a new release over an old one leaves the previous app/ and
# migrations/ in place: modules the new version no longer ships stay
# importable, and the venv keeps pins requirements.txt has since moved past.
# Offer to clear that out first. Data — the config, the database, logs,
# backups and uploaded TLS material — is kept either way.
PREV_INSTALL=0
REMOVE_EXISTING=0
UNIT_FILE="/etc/systemd/system/pktflow.service"
if [ -f "$UNIT_FILE" ] || [ -d "$INSTALL_DIR/app" ] || [ -d "$INSTALL_DIR/venv" ]; then
    PREV_INSTALL=1
fi

if [ "$PREV_INSTALL" -eq 1 ]; then
    PREV_VERSION="(unknown)"
    if [ -f "$INSTALL_DIR/VERSION" ]; then
        PREV_VERSION="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null || echo '(unknown)')"
    fi
    echo "Found an existing pktFlow installation at $INSTALL_DIR (version $PREV_VERSION)."

    # A unit pointing somewhere else means the operator is moving the install.
    # Say so — the old directory keeps its database, and that is not obvious.
    PREV_UNIT_DIR=""
    if [ -f "$UNIT_FILE" ]; then
        PREV_UNIT_DIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" | head -1)"
    fi
    if [ -n "$PREV_UNIT_DIR" ] && [ "$PREV_UNIT_DIR" != "$INSTALL_DIR" ]; then
        echo "  NOTE: the installed service runs from $PREV_UNIT_DIR, not $INSTALL_DIR."
        echo "        That directory and its data are left alone; this install takes"
        echo "        over the service name and the port."
    fi

    if [ "$REPO_DIR" = "$INSTALL_DIR" ]; then
        # Nothing to remove — the install dir is this checkout, so the "old"
        # files and the new ones are the same files.
        echo "  Installing in place; the upgrade applies to this tree directly."
    elif [ -n "${PKTFLOW_REMOVE_EXISTING:-}" ]; then
        REMOVE_EXISTING="$PKTFLOW_REMOVE_EXISTING"
    elif [ -t 0 ]; then
        echo "  Uninstalling it first gives a clean install — stale modules and a"
        echo "  stale venv are removed. Your data is kept either way."
        read -rp "Uninstall the existing version first? [Y/n]: " REMOVE_INPUT
        case "$REMOVE_INPUT" in
            [nN]|[nN][oO]) REMOVE_EXISTING=0 ;;
            *)             REMOVE_EXISTING=1 ;;
        esac
    else
        # Non-interactive: upgrade over the top unless explicitly told
        # otherwise, so an unattended re-run never removes more than it must.
        REMOVE_EXISTING=0
    fi

    if [ "$REMOVE_EXISTING" = "1" ]; then
        if [ -f "$REPO_DIR/uninstall.sh" ]; then
            echo "  Removing the existing installation (keeping data)..."
            bash "$REPO_DIR/uninstall.sh" --keep-data --yes --dir "$INSTALL_DIR"
        else
            echo "  WARNING: uninstall.sh is not next to install.sh — continuing with"
            echo "           an in-place upgrade instead."
        fi
    fi
    echo ""
fi

# A port already answered by something else is the other common way a fresh
# install comes up dead. Only checked on a fresh install: on a re-install the
# listener is this app's own service, which is expected.
if [ "$PREV_INSTALL" -eq 0 ] && command -v ss &>/dev/null; then
    if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
        echo "WARNING: port $PORT is already in use on this host:"
        ss -ltn "sport = :$PORT" 2>/dev/null | sed 's/^/    /' || true
        if [ -t 0 ]; then
            read -rp "Continue anyway? [y/N]: " PORT_CONFIRM
            case "$PORT_CONFIRM" in
                [yY]|[yY][eE][sS]) ;;
                *) echo "Aborted. Re-run and choose a free port."; exit 1 ;;
            esac
        else
            echo "         Continuing anyway (non-interactive)."
        fi
        echo ""
    fi
fi

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/10] Installing system packages..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    libxmlsec1-dev libxmlsec1-openssl libxml2-dev pkg-config gcc \
    curl ca-certificates gnupg apt-transport-https

# ── 2. Create directories ─────────────────────────────────────────────────────
echo "[2/10] Creating directories..."
BACKUP_DIR="$INSTALL_DIR/backups"
sudo mkdir -p "$INSTALL_DIR"
sudo mkdir -p "$LOG_DIR"
sudo mkdir -p "$BACKUP_DIR"
# Owned by the invoking user for now so the steps below don't need sudo;
# re-owned to $SERVICE_USER:$SERVICE_GROUP at the end (step 9).
sudo chown "$(whoami):$(whoami)" "$INSTALL_DIR" "$LOG_DIR" "$BACKUP_DIR"

# ── 3. Install ClickHouse ─────────────────────────────────────────────────────
echo "[3/10] Checking ClickHouse..."
if ! command -v clickhouse-server &>/dev/null; then
    echo "  Installing ClickHouse..."
    curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
        | sudo gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg

    ARCH="$(dpkg --print-architecture)"
    echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=${ARCH}] https://packages.clickhouse.com/deb stable main" \
        | sudo tee /etc/apt/sources.list.d/clickhouse.list > /dev/null

    sudo apt-get update
    sudo apt-get install -y clickhouse-server clickhouse-client
    sudo systemctl enable clickhouse-server
    sudo systemctl start clickhouse-server
    echo "  ClickHouse installed and started."
else
    echo "  ClickHouse already installed. Ensuring it's running..."
    sudo systemctl start clickhouse-server || true
fi

# Wait for ClickHouse to be ready
echo "  Waiting for ClickHouse..."
for i in {1..10}; do
    clickhouse-client --query "SELECT 1" &>/dev/null && break
    sleep 2
done

# ── 4. Initialize ClickHouse schema ──────────────────────────────────────────
echo "[4/10] Initializing ClickHouse schema..."
clickhouse-client --multiquery < "$REPO_DIR/clickhouse/schema.sql" && echo "  Schema applied."

# ── 5. Python virtualenv ──────────────────────────────────────────────────────
echo "[5/10] Setting up Python virtualenv..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REPO_DIR/requirements.txt"
echo "  Python dependencies installed."

# ── 6. Copy app files ─────────────────────────────────────────────────────────
echo "[6/10] Copying application files..."
if [ "$REPO_DIR" = "$INSTALL_DIR" ]; then
    echo "  Install dir is the repo checkout itself — nothing to copy."
else
    cp "$REPO_DIR/VERSION"        "$INSTALL_DIR/"
    cp "$REPO_DIR/uninstall.sh"   "$INSTALL_DIR/"
    cp -r "$REPO_DIR/app"         "$INSTALL_DIR/"
    cp -r "$REPO_DIR/migrations"  "$INSTALL_DIR/"
    cp -r "$REPO_DIR/clickhouse"  "$INSTALL_DIR/"
    cp -r "$REPO_DIR/scripts"     "$INSTALL_DIR/"
    cp -r "$REPO_DIR/docs"        "$INSTALL_DIR/"
fi

# ── 7. Config file ────────────────────────────────────────────────────────────
echo "[7/10] Setting up config..."
if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$REPO_DIR/config.example.yaml" "$INSTALL_DIR/config.yaml"
    # Generate a random secret key
    SECRET=$(openssl rand -hex 32)
    sed -i "s/CHANGE_ME_generate_with_openssl_rand_hex_32/$SECRET/" "$INSTALL_DIR/config.yaml"
    # Generate a Fernet key for encrypting stored credentials at rest
    CRED_KEY=$("$VENV/bin/python3" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
    sed -i "s#CHANGE_ME_generate_with_fernet_generate_key#$CRED_KEY#" "$INSTALL_DIR/config.yaml"
    sed -i "s#/opt/pktflow#$INSTALL_DIR#g" "$INSTALL_DIR/config.yaml"
    sed -i "s/^port: 8766/port: $PORT/" "$INSTALL_DIR/config.yaml"
    echo "  Config created at $INSTALL_DIR/config.yaml"
    echo "  !! Review and update cors_origins before production use !!"
else
    # Keep the existing config — it holds the JWT secret, the credential
    # encryption key and anything edited since. The port, though, was just
    # typed at the prompt, so apply that and leave every other line alone.
    CURRENT_PORT="$(sed -n 's/^port:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$INSTALL_DIR/config.yaml" | head -1)"
    if [ -n "$CURRENT_PORT" ] && [ "$CURRENT_PORT" != "$PORT" ]; then
        sed -i "s/^port:[[:space:]]*[0-9][0-9]*/port: $PORT/" "$INSTALL_DIR/config.yaml"
        echo "  Existing config kept — port updated ($CURRENT_PORT -> $PORT)."
    else
        echo "  Existing config kept (port is already $PORT)."
    fi
fi

# ── 8. Generate ingest token + create admin user ──────────────────────────────
echo "[8/10] Initializing database and admin user..."
INGEST_TOKEN=$(openssl rand -hex 24)
DB_EXISTED=0
[ -f "$INSTALL_DIR/pktflow.db" ] && DB_EXISTED=1
ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=' | head -c 16)

"$VENV/bin/python3" - << PYEOF
import asyncio, sys
sys.path.insert(0, '$INSTALL_DIR')
import os; os.environ['PKTFLOW_CONFIG'] = '$INSTALL_DIR/config.yaml'

from app.database import init_db
from app.auth.local import hash_password
import aiosqlite, json
from app.config import get_settings

async def setup():
    await init_db()
    async with aiosqlite.connect(get_settings().db_path) as db:
        # Set ingest token
        await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('ingest_token', ?)",
            (json.dumps('$INGEST_TOKEN'),)
        )
        # Create admin user if not exists
        hashed = hash_password('$ADMIN_PASS')
        await db.execute(
            "INSERT OR IGNORE INTO users (username, email, hashed_password, role) VALUES (?,?,?,?)",
            ('admin', 'admin@pktflow.local', hashed, 'admin')
        )
        await db.commit()
    print("  Database initialized.")

asyncio.run(setup())
PYEOF

# ── 9. Build frontend ─────────────────────────────────────────────────────────
# Not installing Node.js itself here (see README Requirements — version
# management is left to the operator), but if it's already present (as the
# Quick Start instructs installing beforehand), just build it — there's no
# reason to leave this as a manual step when we can.
echo "[9/10] Building frontend..."
FRONTEND_BUILT=0
if command -v npm &>/dev/null; then
    ( cd "$REPO_DIR/frontend" && npm install --no-audit --no-fund && npm run build )
    if [ "$REPO_DIR/frontend/dist" != "$INSTALL_DIR/frontend/dist" ]; then
        mkdir -p "$INSTALL_DIR/frontend"
        rm -rf "$INSTALL_DIR/frontend/dist"
        cp -r "$REPO_DIR/frontend/dist" "$INSTALL_DIR/frontend/dist"
    fi
    FRONTEND_BUILT=1
    echo "  Frontend built and deployed."
else
    echo "  npm not found — skipping (Node.js 20.x is required; see README Requirements)."
    echo "  The web UI will return \"Not Found\" until you build it manually — see the"
    echo "  banner at the end of this script for the exact commands."
fi

# ── 10. Install systemd service ───────────────────────────────────────────────
echo "[10/10] Installing systemd service..."
# Re-own the install/log dirs to the service user before starting the service.
sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR" "$LOG_DIR"
sed \
    -e "s#__INSTALL_DIR__#$INSTALL_DIR#g" \
    -e "s#__LOG_DIR__#$LOG_DIR#g" \
    -e "s#__SERVICE_USER__#$SERVICE_USER#g" \
    -e "s#__SERVICE_GROUP__#$SERVICE_GROUP#g" \
    "$REPO_DIR/pktflow.service" | sudo tee /etc/systemd/system/pktflow.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable pktflow
sudo systemctl start pktflow

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              pktFlow installed successfully!             ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  URL:           http://%-34s║\n" "$(hostname -I | awk '{print $1}'):$PORT"
if [ "$DB_EXISTED" -eq 0 ]; then
    echo "║  Username:      admin                                    ║"
    printf "║  Password:      %-41s║\n" "$ADMIN_PASS"
else
    echo "║  Existing install — admin credentials unchanged          ║"
fi
echo "║                                                          ║"
# Shown on every run, not only the first: step 8 writes this with INSERT OR
# REPLACE, so a re-install rotates the token and every collector already
# shipping to this host stops until its vector.toml is updated.
if [ "$DB_EXISTED" -eq 0 ]; then
    echo "║  Ingest token (for vector.toml):                         ║"
else
    echo "║  Ingest token — ROTATED, update your collectors:         ║"
fi
printf "║  %-56s║\n" "$INGEST_TOKEN"
echo "║                                                          ║"
echo "║  SAVE THESE CREDENTIALS — they won't be shown again!     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
if [ "$FRONTEND_BUILT" -eq 0 ]; then
    echo "!! Frontend was NOT built (npm not found) — the web UI will show"
    echo "!! {\"detail\":\"Not Found\"} until you run:"
    echo "!!   cd $REPO_DIR/frontend && npm install && npm run build"
    if [ "$REPO_DIR/frontend/dist" != "$INSTALL_DIR/frontend/dist" ]; then
        echo "!!   mkdir -p $INSTALL_DIR/frontend && cp -r $REPO_DIR/frontend/dist $INSTALL_DIR/frontend/dist"
    fi
    echo "!!   sudo systemctl restart pktflow"
    echo ""
fi
echo "Next steps:"
echo "  1. Update vector.toml on each collector (see VECTOR_MIGRATION.md)"
echo "  2. Log into pktFlow and review Settings"
echo "  3. Verify flows appear in the Dashboard"
