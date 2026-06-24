"""Deploy alert engine + condition builder UI."""
import paramiko, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

KEY_PATH = r'C:\Users\user\.ssh\corporate_infrastructure.pem'
LOCAL_ROOT = r'C:\Users\user\My Drive\Documents\Claude\Projects\pktFlow'
REMOTE_ROOT = '/mnt/software/pktflow'

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.20.30.5', username='ec2-user', pkey=key, timeout=15, banner_timeout=15)
print('Connected')

sftp = client.open_sftp()

# ── Push backend files ─────────────────────────────────────────────────────────
BACKEND_FILES = [
    'app/storage/base.py',
    'app/storage/clickhouse.py',
    'app/storage/duckdb.py',
    'app/alerts/engine.py',
    'app/api/flows.py',
    'app/api/settings.py',
    'app/api/ws.py',
    'app/ingest/buffer.py',
    'app/main.py',
]
for rel in BACKEND_FILES:
    local = os.path.join(LOCAL_ROOT, rel)
    remote = f'{REMOTE_ROOT}/{rel}'
    sftp.put(local, remote)
    print(f'  PUT {rel}')

# ── Push frontend/src ──────────────────────────────────────────────────────────
LOCAL_SRC = os.path.join(LOCAL_ROOT, 'frontend', 'src')
REMOTE_SRC = f'{REMOTE_ROOT}/frontend/src'

def sftp_put_dir(local_dir, remote_dir):
    try:
        sftp.stat(remote_dir)
    except FileNotFoundError:
        sftp.mkdir(remote_dir)
    for item in os.listdir(local_dir):
        lp = os.path.join(local_dir, item)
        rp = remote_dir + '/' + item
        if os.path.isdir(lp):
            sftp_put_dir(lp, rp)
        else:
            sftp.put(lp, rp)

print('\nSyncing frontend/src...')
sftp_put_dir(LOCAL_SRC, REMOTE_SRC)
sftp.close()
print('Sync done')

# ── Build + deploy frontend ────────────────────────────────────────────────────
def run(label, cmd):
    _, stdout, stderr = client.exec_command(cmd, timeout=180)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    print(f'\n[{label}]')
    if out: print(out[-2000:])
    if err: print('ERR:', err[:400])

run('cp src to /tmp', 'rm -rf /tmp/pktflow-fe && cp -r /mnt/software/pktflow/frontend /tmp/pktflow-fe')
run('npm install', 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd /tmp/pktflow-fe && npm install 2>&1 | tail -3')
run('npm build', 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd /tmp/pktflow-fe && npm run build 2>&1 | tail -15')
run('copy dist', 'rm -rf /mnt/software/pktflow/frontend/dist && cp -r /tmp/pktflow-fe/dist /mnt/software/pktflow/frontend/dist && echo copied')
run('restart', 'sudo systemctl restart pktflow')
run('status', 'sleep 4 && systemctl is-active pktflow')
run('chunks', 'ls /mnt/software/pktflow/frontend/dist/assets/ | grep -iE "alert|Alerts"')
run('ingest', 'curl -s http://localhost:8766/api/ingest/stats')

client.close()
print('\nDone')
