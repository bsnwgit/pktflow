# pktFlow build error checker.
# Run when deploy_frontend.py reports BUILD FAILED to see TypeScript/Vite errors.
# Assumes /tmp/pktflow-fe exists with node_modules (deploy_frontend.py ran npm install).
# Usage: python.exe "...pktFlow/scripts/check_build.py"
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

KEY_PATH = r"C:\Users\user\.ssh\corporate_infrastructure.pem"
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("10.20.30.5", username="ec2-user", pkey=key, timeout=15, banner_timeout=15)

NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
cmd = f'{NVM} && cd /tmp/pktflow-fe && npm run build 2>&1 | tail -60'
_, stdout, _ = client.exec_command(cmd, timeout=120)
print(stdout.read().decode('utf-8', errors='replace'))
client.close()
