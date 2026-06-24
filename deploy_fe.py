import paramiko
import os
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

LOCAL_SRC = r'C:\Users\robert.barnett\My Drive\Documents\Claude\Projects\pktFlow\frontend\src'
REMOTE_SRC = '/mnt/software/pktflow/frontend/src'
KEY_PATH = r'C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem'

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('172.23.80.5', username='ec2-user', pkey=key, timeout=15, banner_timeout=15)
print('Connected')

sftp = client.open_sftp()

def sftp_put_dir(local_dir, remote_dir):
    try:
        sftp.stat(remote_dir)
    except FileNotFoundError:
        sftp.mkdir(remote_dir)
    for item in os.listdir(local_dir):
        local_path = os.path.join(local_dir, item)
        remote_path = remote_dir + '/' + item
        if os.path.isdir(local_path):
            sftp_put_dir(local_path, remote_path)
        else:
            sftp.put(local_path, remote_path)

print('Syncing frontend/src...')
sftp_put_dir(LOCAL_SRC, REMOTE_SRC)
sftp.close()
print('Sync done')

def run(cmd):
    _, stdout, stderr = client.exec_command(cmd, timeout=120)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    print(f'$ {cmd[:70]}')
    if out: print(out)
    if err: print('ERR:', err[:300])

run('rm -rf /tmp/pktflow-fe && cp -r /mnt/software/pktflow/frontend /tmp/pktflow-fe')
run('export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd /tmp/pktflow-fe && npm install 2>&1 | tail -3')
run('export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd /tmp/pktflow-fe && npm run build 2>&1 | tail -10')
run('rm -rf /mnt/software/pktflow/frontend/dist && cp -r /tmp/pktflow-fe/dist /mnt/software/pktflow/frontend/dist')
run('sudo systemctl restart pktflow')
run('sleep 4 && systemctl is-active pktflow')
run('ls /mnt/software/pktflow/frontend/dist/assets/ | grep -E "DeviceView|Ports|Alerts|Users"')

client.close()
print('Done')
