import paramiko
import time

key = paramiko.RSAKey.from_private_key_file(r'C:\Users\user\.ssh\corporate_infrastructure.pem')
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.20.30.5', username='ec2-user', pkey=key, timeout=15, banner_timeout=15)

sftp = client.open_sftp()
local_file = r'C:\Users\user\My Drive\Documents\Claude\Projects\pktFlow\frontend\src\pages\DeviceView.tsx'
remote_file = '/mnt/software/pktflow/frontend/src/pages/DeviceView.tsx'
sftp.put(local_file, remote_file)
sftp.close()
print('SFTP upload complete')

_, out, err = client.exec_command('rm -rf /tmp/pktflow-fe && cp -r /mnt/software/pktflow/frontend /tmp/pktflow-fe', timeout=30)
out.read(); err.read()
print('Copied to /tmp')

build_cmd = r'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd /tmp/pktflow-fe && npm install --silent 2>&1 | tail -3 && npm run build 2>&1 | tail -15'
_, out, err = client.exec_command(build_cmd, timeout=120)
build_out = out.read().decode()
build_err = err.read().decode()
print('BUILD STDOUT:', build_out.encode('ascii', errors='replace').decode())
print('BUILD STDERR:', build_err.encode('ascii', errors='replace').decode())

_, out, err = client.exec_command('rm -rf /mnt/software/pktflow/frontend/dist && cp -r /tmp/pktflow-fe/dist /mnt/software/pktflow/frontend/dist', timeout=30)
out.read(); err.read()
print('Dist copied back')

_, out, err = client.exec_command('sudo systemctl restart pktflow', timeout=15)
out.read(); err.read()
time.sleep(4)

_, out, err = client.exec_command('systemctl is-active pktflow', timeout=10)
print('Service:', out.read().decode().strip())

_, out, err = client.exec_command('ls /mnt/software/pktflow/frontend/dist/assets/ | grep -i device', timeout=10)
print('Assets:', out.read().decode().strip())

client.close()
print('Done.')
