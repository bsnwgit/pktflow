import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

key = paramiko.RSAKey.from_private_key_file(r'C:\Users\user\.ssh\corporate_infrastructure.pem')
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.20.30.5', username='ec2-user', pkey=key, timeout=15, banner_timeout=15)
print('Connected')

def run(label, cmd):
    _, stdout, stderr = client.exec_command(cmd, timeout=60)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    print(f'\n[{label}]')
    if out: print(out)
    if err: print('ERR:', err[:400])

run('build check', 'ls /tmp/pktflow-fe/dist/assets/ | head -20')
run('copy dist', 'rm -rf /mnt/software/pktflow/frontend/dist && cp -r /tmp/pktflow-fe/dist /mnt/software/pktflow/frontend/dist && echo copied')
run('restart', 'sudo systemctl restart pktflow')
run('status', 'sleep 4 && systemctl is-active pktflow')
run('ingest stats', 'curl -s http://localhost:8766/api/ingest/stats')

client.close()
print('\nDone')
