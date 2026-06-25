import sys, time
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

print("=== users ===")
run("sqlite3 /mnt/software/pktflow/pktflow.db \"SELECT username, role, is_active, (hashed_password IS NOT NULL) as has_pw, auth_provider FROM users\"")

print("\n=== key settings ===")
run("sqlite3 /mnt/software/pktflow/pktflow.db \"SELECT key, value FROM settings WHERE key IN ('base_url','okta_saml_enabled','okta_saml_sp_entity_id','okta_saml_idp_sso_url','auth_local_enabled')\"")

print("\n=== recent auth log lines ===")
run("sudo journalctl -u pktflow -n 50 --no-pager | grep -iE 'saml|login|auth|error|warn' | tail -20")

c.close()
