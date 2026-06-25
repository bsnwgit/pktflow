"""
Check SAML config and sync entity ID with base_url.
"""
import sys, json
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

key = paramiko.RSAKey.from_private_key_file(r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("172.23.80.5", username="ec2-user", pkey=key, timeout=15, banner_timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=20)
    out = o.read().decode('utf-8', errors='replace').strip()
    err = e.read().decode('utf-8', errors='replace').strip()
    if out: print(out)
    if err: print("ERR:", err)
    return out

VENV_PY = "/mnt/software/pktflow/venv/bin/python3"

fix_py = r"""
import sqlite3, json

DB = "/mnt/software/pktflow/pktflow.db"
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Show relevant SAML settings
print("=== current SAML settings ===")
for r in conn.execute("""
    SELECT key, value FROM settings
    WHERE key IN ('base_url','okta_saml_enabled','okta_saml_sp_entity_id',
                  'okta_saml_idp_sso_url','okta_saml_idp_entity_id')
"""):
    print(f"  {r['key']} = {r['value']}")

# Derive what the ACS URL and entity ID should be from base_url
row = conn.execute("SELECT value FROM settings WHERE key='base_url'").fetchone()
base_url = json.loads(row[0]).rstrip('/') if row else 'http://172.23.80.5:8766'
acs_url = f"{base_url}/api/auth/saml/callback"
entity_id = f"{base_url}/api/auth/saml/metadata"

print(f"\n=== derived URLs from base_url = {base_url} ===")
print(f"  ACS URL (Okta 'Single Sign On URL'):  {acs_url}")
print(f"  Entity ID (Okta 'Audience URI'):       {entity_id}")

# Update sp_entity_id to match base_url
conn.execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ("okta_saml_sp_entity_id", json.dumps(entity_id))
)
conn.commit()
print(f"\nokta_saml_sp_entity_id updated to: {entity_id}")
print("\nMake sure Okta has:")
print(f"  Single Sign On URL  = {acs_url}")
print(f"  Audience URI (SP Entity ID) = {entity_id}")
conn.close()
"""

sftp = c.open_sftp()
with sftp.open("/tmp/fix_auth.py", "w") as f:
    f.write(fix_py)
sftp.close()

run(f"{VENV_PY} /tmp/fix_auth.py")

print("\n=== last SAML log lines ===")
run("sudo journalctl -u pktflow -n 50 --no-pager | grep -i saml | tail -10")

c.close()
