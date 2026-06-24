"""Push backend files and restart pktflow."""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

KEY_PATH = r'C:\Users\user\.ssh\corporate_infrastructure.pem'
LOCAL_ROOT = r'C:\Users\user\My Drive\Documents\Claude\Projects\pktFlow'
REMOTE_ROOT = '/mnt/software/pktflow'

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.20.30.5', username='ec2-user', pkey=key, timeout=15, banner_timeout=15)
print('Connected')

import os
sftp = client.open_sftp()
for rel in ['app/alerts/engine.py']:
    local = os.path.join(LOCAL_ROOT, rel)
    remote = f'{REMOTE_ROOT}/{rel}'
    sftp.put(local, remote)
    print(f'  PUT {rel}')
sftp.close()

def run(label, cmd):
    _, stdout, stderr = client.exec_command(cmd, timeout=30)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    print(f'[{label}] {out or ""} {("ERR:"+err[:200]) if err else ""}')

run('restart', 'sudo systemctl restart pktflow')
run('status', 'sleep 4 && systemctl is-active pktflow')
run('ingest', 'curl -s http://localhost:8766/api/ingest/stats')

client.close()
print('Done')
