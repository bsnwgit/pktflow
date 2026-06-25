"""
Deploy SSL certificate upload feature + set up the start.sh wrapper on O2.

What this script does:
  1. SFTP updated app/api/system.py to O2
  2. Create /mnt/software/pktflow/start.sh — wrapper that conditionally adds SSL flags
  3. Update /etc/systemd/system/pktflow.service ExecStart to use start.sh
  4. daemon-reload
  5. Sync frontend/src + rebuild + deploy dist
  6. Restart pktflow + verify
"""
import os, sys, time
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

LOCAL_BASE  = r"C:\Users\robert.barnett\My Drive\Documents\Claude\Projects\pktFlow"
REMOTE_BASE = "/mnt/software/pktflow"
NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key = paramiko.RSAKey.from_private_key_file(r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("172.23.80.5", username="ec2-user", pkey=key, timeout=15, banner_timeout=15)

def run(cmd, timeout=120):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode('utf-8', errors='replace').strip()
    err = e.read().decode('utf-8', errors='replace').strip()
    if out: print(out)
    if err: print("STDERR:", err)
    return out

sftp = c.open_sftp()

# ── 1. Backend ────────────────────────────────────────────────────────────────
print("=== 1/6  Uploading system.py ===")
sftp.put(f"{LOCAL_BASE}\\app\\api\\system.py", f"{REMOTE_BASE}/app/api/system.py")
print("✓ app/api/system.py")

# ── 2. Create start.sh wrapper ────────────────────────────────────────────────
print("\n=== 2/6  Creating start.sh ===")
start_sh = """\
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
"""
# Write to tmp then move to final location
tmp_start = "/tmp/pktflow_start.sh"
with sftp.open(tmp_start, 'w') as f:
    f.write(start_sh)
run(f"mv {tmp_start} {REMOTE_BASE}/start.sh && chmod +x {REMOTE_BASE}/start.sh && echo '✓ start.sh'")

# ── 3. Update pktflow.service on O2 ──────────────────────────────────────────
print("\n=== 3/6  Updating pktflow.service ===")

# Read current service file
_, o, _ = c.exec_command("cat /etc/systemd/system/pktflow.service", timeout=10)
svc_content = o.read().decode('utf-8', errors='replace')

if "start.sh" in svc_content:
    print("✓ pktflow.service already using start.sh — no change needed")
else:
    # Replace the ExecStart block with the wrapper call
    import re
    # Replace multi-line ExecStart (may span multiple lines with backslash continuation)
    new_svc = re.sub(
        r'ExecStart=.*?(?=\n[^\s]|\Z)',
        f'ExecStart=/bin/bash {REMOTE_BASE}/start.sh',
        svc_content,
        flags=re.DOTALL
    )
    # Write updated service file via tmp
    tmp_svc = "/tmp/pktflow_new.service"
    with sftp.open(tmp_svc, 'w') as f:
        f.write(new_svc)
    run(f"sudo cp {tmp_svc} /etc/systemd/system/pktflow.service && echo '✓ service file updated'")
    run("sudo systemctl daemon-reload && echo '✓ daemon-reload'")

sftp.close()

# ── 4. Frontend sync + build ──────────────────────────────────────────────────
print("\n=== 4/6  Syncing frontend/src ===")

sftp2 = c.open_sftp()

def sftp_put_tree(sftp, local_dir, remote_dir):
    for root, dirs, files in os.walk(local_dir):
        rel = os.path.relpath(root, local_dir).replace("\\", "/")
        remote_root = remote_dir if rel == "." else f"{remote_dir}/{rel}"
        try: sftp.mkdir(remote_root)
        except: pass
        for fn in files:
            sftp.put(os.path.join(root, fn), f"{remote_root}/{fn}")

sftp_put_tree(sftp2, f"{LOCAL_BASE}\\frontend\\src", f"{REMOTE_BASE}/frontend/src")
sftp2.close()
print("✓ frontend/src synced")

print("\n=== 5/6  Building frontend ===")
_, o, _ = c.exec_command(
    f"cd /tmp && rm -rf pktflow-fe && cp -r {REMOTE_BASE}/frontend pktflow-fe && "
    f"{NVM} && cd /tmp/pktflow-fe && npm install --silent && "
    f"npm run build > /dev/null 2>&1 && echo 'build ok' || echo 'BUILD FAILED'",
    timeout=120
)
result = o.read().decode('utf-8', errors='replace').strip()
print(result)
if 'FAILED' in result:
    c.close()
    sys.exit(1)

_, o, _ = c.exec_command(
    f"rm -rf {REMOTE_BASE}/frontend/dist && cp -r /tmp/pktflow-fe/dist {REMOTE_BASE}/frontend/dist && echo '✓ dist deployed'",
    timeout=15
)
print(o.read().decode('utf-8', errors='replace').strip())

# ── 5. Restart + verify ───────────────────────────────────────────────────────
print("\n=== 6/6  Restarting pktflow ===")
_, o, _ = c.exec_command("sudo systemctl restart pktflow", timeout=20)
o.read()
time.sleep(4)

_, o, _ = c.exec_command("systemctl is-active pktflow", timeout=10)
status = o.read().decode('utf-8', errors='replace').strip()
print("pktflow:", status)

_, o, _ = c.exec_command("curl -s http://localhost:8766/api/ingest/stats", timeout=10)
print(o.read().decode('utf-8', errors='replace').strip())

c.close()
print("\nDeploy complete.")
print("Visit Settings → Integrations → SSL / TLS to upload your cert and key.")
