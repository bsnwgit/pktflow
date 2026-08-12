# Quick verify: confirm vpn_mappings table exists with seeded rows, and
# that the /api/flows/geo endpoint responds (200) after the VPN migration.
#
# Usage:
#   PKTFLOW_SSH_HOST=<host> PKTFLOW_SSH_USER=<user> PKTFLOW_SSH_KEY=<path-to-pem> python3 verify_vpn.py
# or:
#   python3 verify_vpn.py --host <host> --user <user> --key <path-to-pem> [--install-dir /opt/pktflow]
import argparse
import os
import sys

import paramiko

sys.stdout.reconfigure(encoding='utf-8')


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("PKTFLOW_SSH_HOST"),
                         help="SSH host/IP of the pktFlow server")
    parser.add_argument("--user", default=os.environ.get("PKTFLOW_SSH_USER"),
                         help="SSH username")
    parser.add_argument("--key", default=os.environ.get("PKTFLOW_SSH_KEY"),
                         help="Path to SSH private key (.pem)")
    parser.add_argument("--install-dir", default=os.environ.get("PKTFLOW_INSTALL_DIR", "/opt/pktflow"),
                         help="Remote pktFlow install directory (default: /opt/pktflow)")
    args = parser.parse_args()
    missing = [name for name, val in (("--host/PKTFLOW_SSH_HOST", args.host),
                                       ("--user/PKTFLOW_SSH_USER", args.user),
                                       ("--key/PKTFLOW_SSH_KEY", args.key)) if not val]
    if missing:
        parser.error(f"missing required value(s): {', '.join(missing)}")
    return args


def run(client, cmd, timeout=20):
    _, stdout, _ = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    if out:
        print(out)
    return out


def main():
    args = parse_args()

    key = paramiko.RSAKey.from_private_key_file(args.key)
    client = paramiko.SSHClient()
    # Verify the host key rather than trusting whatever is presented first.
    # AutoAddPolicy made the initial connection — the one that establishes
    # trust — unauthenticated, so anything in between could impersonate the
    # target and capture the SSH credentials. Connect once by hand to record
    # the key, or set PKT_SSH_TRUST_NEW_HOSTS=1 to accept a new one.
    client.load_system_host_keys()
    for _known in (os.environ.get("PKT_SSH_KNOWN_HOSTS"),
                   os.path.expanduser("~/.ssh/known_hosts")):
        if _known and os.path.exists(_known):
            try:
                client.load_host_keys(_known)
            except OSError:
                pass
    # RejectPolicy unconditionally. An earlier version of this fix kept an
    # AutoAddPolicy escape hatch behind an environment variable, which is
    # exactly the blind first-contact trust the fix exists to remove — it just
    # moved it behind a flag. Point PKT_SSH_KNOWN_HOSTS at a file instead: a
    # host key can be recorded deliberately, which is auditable, where
    # "accept whatever answers this time" is not.
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(args.host, username=args.user, pkey=key, timeout=15, banner_timeout=15)

    db_path = f"{args.install_dir}/pktflow.db"

    print("=== vpn_mappings table contents ===")
    run(client, f"""python3 -c "
import sqlite3
db = sqlite3.connect('{db_path}')
rows = db.execute('SELECT group_name, site_name, entry_type, cidr_or_ip FROM vpn_mappings ORDER BY group_name, site_name, entry_type').fetchall()
for r in rows:
    print(f'  {{r[0]:<10}} {{r[1]:<12}} {{r[2]:<5}} {{r[3]}}')
print(f'  Total rows: {{len(rows)}}')
" """)

    print()
    print("=== /api/flows/geo endpoint ===")
    run(client, "curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8766/api/flows/geo?window=1h' "
                "-H 'Authorization: Bearer bad' && echo ' (auth check — 401 is expected)'")

    print()
    print("=== pktflow service ===")
    run(client, "systemctl is-active pktflow && curl -s http://localhost:8766/api/ingest/stats")

    client.close()


if __name__ == "__main__":
    main()
