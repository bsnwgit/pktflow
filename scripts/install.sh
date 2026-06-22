#!/bin/bash
# pktFlow install script
# Run as ec2-user on the O2 server (172.23.80.5)
# Usage: bash install.sh

set -euo pipefail

INSTALL_DIR="/mnt/software/pktflow"
LOG_DIR="/mnt/software/logs"
VENV="$INSTALL_DIR/venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== pktFlow Installer ==="
echo "Install dir: $INSTALL_DIR"
echo ""

# ── 1. Create directories ─────────────────────────────────────────────────────
echo "[1/8] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$LOG_DIR"

# ── 2. Install ClickHouse ─────────────────────────────────────────────────────
echo "[2/8] Checking ClickHouse..."
if ! command -v clickhouse-server &>/dev/null; then
    echo "  Installing ClickHouse..."
    curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
        | sudo gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg

    # For Amazon Linux 2 / RHEL-based
    sudo tee /etc/yum.repos.d/clickhouse.repo > /dev/null << 'EOF'
[clickhouse-stable]
name=ClickHouse - Stable Repository
baseurl=https://packages.clickhouse.com/rpm/lts/
gpgcheck=1
gpgkey=https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key
enabled=1
EOF
    sudo yum install -y clickhouse-server clickhouse-client
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

# ── 3. Initialize ClickHouse schema ──────────────────────────────────────────
echo "[3/8] Initializing ClickHouse schema..."
clickhouse-client --multiquery < "$REPO_DIR/clickhouse/schema.sql" && echo "  Schema applied."

# ── 4. Python virtualenv ──────────────────────────────────────────────────────
echo "[4/8] Setting up Python virtualenv..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REPO_DIR/requirements.txt"
echo "  Python dependencies installed."

# ── 5. Copy app files ─────────────────────────────────────────────────────────
echo "[5/8] Copying application files..."
cp -r "$REPO_DIR/app"         "$INSTALL_DIR/"
cp -r "$REPO_DIR/migrations"  "$INSTALL_DIR/"
cp -r "$REPO_DIR/clickhouse"  "$INSTALL_DIR/"
cp -r "$REPO_DIR/scripts"     "$INSTALL_DIR/"

# ── 6. Config file ────────────────────────────────────────────────────────────
echo "[6/8] Setting up config..."
if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$REPO_DIR/config.example.yaml" "$INSTALL_DIR/config.yaml"
    # Generate a random secret key
    SECRET=$(openssl rand -hex 32)
    sed -i "s/CHANGE_ME_generate_with_openssl_rand_hex_32/$SECRET/" "$INSTALL_DIR/config.yaml"
    echo "  Config created at $INSTALL_DIR/config.yaml"
    echo "  !! Review and update cors_origins before production use !!"
else
    echo "  Config already exists — skipping."
fi

# ── 7. Generate ingest token + create admin user ──────────────────────────────
echo "[7/8] Initializing database and admin user..."
INGEST_TOKEN=$(openssl rand -hex 24)
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

# ── 8. Install systemd service ────────────────────────────────────────────────
echo "[8/8] Installing systemd service..."
sudo cp "$REPO_DIR/pktflow.service" /etc/systemd/system/pktflow.service
sudo systemctl daemon-reload
sudo systemctl enable pktflow
sudo systemctl start pktflow

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              pktFlow installed successfully!             ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  URL:           http://%-35s║\n" "$(hostname -I | awk '{print $1}'):8080"
echo "║  Username:      admin                                    ║"
printf "║  Password:      %-43s║\n" "$ADMIN_PASS"
echo "║                                                          ║"
echo "║  Ingest token (for vector.toml):                         ║"
printf "║  %-58s║\n" "$INGEST_TOKEN"
echo "║                                                          ║"
echo "║  SAVE THESE CREDENTIALS — they won't be shown again!     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Update vector.toml on each collector (see VECTOR_MIGRATION.md)"
echo "  2. Log into pktFlow and review Settings"
echo "  3. Verify flows appear in the Dashboard"
