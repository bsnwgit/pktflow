"""
Update vector.toml on both collectors to use HTTPS for pktflow ingest.
The cert is for *.vynedental.com so we disable cert verification for the IP-based connection.
"""
import sys, re
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

PKTFLOW_HTTPS = "https://172.23.80.5:8766/api/ingest/flows"

def fix_vector(host, user, key_path, label):
    print(f"\n{'='*50}")
    print(f"=== {label} ({host}) ===")
    key = paramiko.RSAKey.from_private_key_file(key_path)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, pkey=key, timeout=15, banner_timeout=15)

    def run(cmd):
        _, o, e = c.exec_command(cmd, timeout=20)
        out = o.read().decode('utf-8', errors='replace').strip()
        err = e.read().decode('utf-8', errors='replace').strip()
        if out: print(out)
        if err: print("ERR:", err)
        return out

    # Read current vector.toml
    _, o, _ = c.exec_command("cat /mnt/software/vector/vector.toml", timeout=10)
    toml = o.read().decode('utf-8', errors='replace')

    print("--- current URI line ---")
    for line in toml.splitlines():
        if 'uri' in line.lower() or 'http' in line.lower():
            print(" ", line)

    # Replace http:// with https:// in the URI
    new_toml = re.sub(
        r'(uri\s*=\s*["\'])http://',
        r'\1https://',
        toml
    )

    # Add tls.verify_certificate = false if not already present
    if 'verify_certificate' not in new_toml:
        # Add after the [sinks.*] section's uri line
        new_toml = re.sub(
            r'(uri\s*=\s*"https://[^"]+"\s*\n)',
            r'\1verify_certificate = false\n',
            new_toml
        )

    if new_toml == toml:
        print("No changes needed (already HTTPS or pattern not found)")
    else:
        # Write updated config
        sftp = c.open_sftp()
        # Backup first
        run("cp /mnt/software/vector/vector.toml /mnt/software/vector/vector.toml.bak")
        with sftp.open("/mnt/software/vector/vector.toml", "w") as f:
            f.write(new_toml)
        sftp.close()
        print("--- updated URI line ---")
        for line in new_toml.splitlines():
            if 'uri' in line.lower() or 'http' in line.lower() or 'verify' in line.lower():
                print(" ", line)
        # Restart vector service
        run("sudo systemctl restart goflow2-vector && echo 'restarted'")
        import time; time.sleep(3)
        run("systemctl is-active goflow2-vector")

    c.close()

# Medical collector
fix_vector(
    host="172.23.80.11",
    user="ec2-user",
    key_path=r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem",
    label="Medical Collector"
)

# Dental collector
fix_vector(
    host="10.56.57.181",
    user="ec2-user",
    key_path=r"C:\Users\robert.barnett\.ssh\corporate_infrastructure.pem",
    label="Dental Collector"
)

print("\n=== Done. Flows should resume within 30 seconds. ===")
