# Quick verify: confirm vpn_mappings table exists with seeded rows, and
# that the /api/flows/geo endpoint responds (200) after the VPN migration.
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

KEY_PATH = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
HOST     = "172.23.80.5"

key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="ec2-user", pkey=key, timeout=15, banner_timeout=15)

def run(cmd, timeout=20):
    _, stdout, _ = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    if out:
        print(out)
    return out

print("=== vpn_mappings table contents ===")
run(r"""python3 -c "
import sqlite3
db = sqlite3.connect('/mnt/software/pktflow/pktflow.db')
rows = db.execute('SELECT group_name, site_name, entry_type, cidr_or_ip FROM vpn_mappings ORDER BY group_name, site_name, entry_type').fetchall()
for r in rows:
    print(f'  {r[0]:<10} {r[1]:<12} {r[2]:<5} {r[3]}')
print(f'  Total rows: {len(rows)}')
" """)

print()
print("=== /api/flows/geo endpoint ===")
run("curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8766/api/flows/geo?window=1h' -H 'Authorization: Bearer bad' && echo ' (auth check — 401 is expected)'")

print()
print("=== pktflow service ===")
run("systemctl is-active pktflow && curl -s http://localhost:8766/api/ingest/stats")

client.close()
