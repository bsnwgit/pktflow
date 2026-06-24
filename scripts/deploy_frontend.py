# pktFlow frontend deploy script.
# Run via Desktop Commander start_process (cmd shell) -- NOT python -c, output gets lost.
# Usage: python.exe "...pktFlow/scripts/deploy_frontend.py"
import paramiko, sys, os, time
sys.stdout.reconfigure(encoding='utf-8')

LOCAL_SRC  = r"C:\Users\user\My Drive\Documents\Claude\Projects\pktFlow\frontend\src"
REMOTE_SRC = "/mnt/software/pktflow/frontend/src"
KEY_PATH   = r"C:\Users\user\.ssh\corporate_infrastructure.pem"
HOST       = "10.20.30.5"

# ── Connect ────────────────────────────────────────────────────────────────────
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="ec2-user", pkey=key, timeout=15, banner_timeout=15)

# ── SFTP upload ────────────────────────────────────────────────────────────────
def sftp_mkdir_p(sftp, remote_dir):
    parts = remote_dir.split('/')
    path = ''
    for part in parts:
        if not part:
            path = '/'
            continue
        path = path.rstrip('/') + '/' + part
        try:
            sftp.stat(path)
        except FileNotFoundError:
            sftp.mkdir(path)

def upload_dir(sftp, local_dir, remote_dir):
    sftp_mkdir_p(sftp, remote_dir)
    for item in os.listdir(local_dir):
        local_path = os.path.join(local_dir, item)
        remote_path = remote_dir.rstrip('/') + '/' + item
        if os.path.isdir(local_path):
            upload_dir(sftp, local_path, remote_path)
        else:
            sftp.put(local_path, remote_path)
            print(f"  → {remote_path}")

print("=== 1/6 Uploading frontend/src to O2 ===")
sftp = client.open_sftp()
upload_dir(sftp, LOCAL_SRC, REMOTE_SRC)
sftp.close()
print("Upload complete.\n")

# ── SSH helper ─────────────────────────────────────────────────────────────────
def run(cmd, timeout=120):
    _, stdout, _ = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    rc  = stdout.channel.recv_exit_status()
    if out:
        print(out)
    return rc

NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

# ── Build steps ────────────────────────────────────────────────────────────────
print("=== 2/6 Copying to /tmp ===")
run("rm -rf /tmp/pktflow-fe && cp -r /mnt/software/pktflow/frontend /tmp/pktflow-fe && echo 'copy ok'")

print("\n=== 3/6 npm install ===")
# node_modules is gitignored — MUST run install after every fresh copy
rc = run(f"{NVM} && cd /tmp/pktflow-fe && npm install --silent 2>/dev/null && echo 'install ok' || echo 'INSTALL FAILED'")

print("\n=== 4/6 npm run build ===")
# Redirect build output to avoid Unicode UnicodeEncodeError; check exit code separately
rc = run(f"{NVM} && cd /tmp/pktflow-fe && npm run build > /dev/null 2>&1 && echo 'build ok' || echo 'BUILD FAILED'")
if rc != 0:
    print("\nBuild failed — run scripts/check_build.py to see the error output.")
    client.close()
    sys.exit(1)

print("\n=== 5/6 Deploying dist ===")
run("rm -rf /mnt/software/pktflow/frontend/dist && cp -r /tmp/pktflow-fe/dist /mnt/software/pktflow/frontend/dist && echo 'dist deployed'")

print("\n=== 6/6 Restarting pktflow ===")
run("sudo systemctl restart pktflow", timeout=30)
time.sleep(4)
run("systemctl is-active pktflow")
run("curl -s http://localhost:8766/api/ingest/stats")

client.close()
print("\nDeploy complete.")
