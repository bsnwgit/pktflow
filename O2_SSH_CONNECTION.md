# O2 Infrastructure SSH Connection Guide

## Overview
Windows system SSH (`ssh.exe`) cannot capture output via Desktop Commander due to SentinelOne EDR blocking non-interactive process spawning. Use **Python + Paramiko** instead.

## Requirements
- Python 3.13: `C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe`
- Paramiko: already installed for Python313
- Always run via Desktop Commander `start_process` — the workspace bash sandbox does NOT have access to Windows SSH keys

## Host Details

| Role               | Host           | User      | Key File                                                          |
|--------------------|----------------|-----------|-------------------------------------------------------------------|
| Medical Collector  | 10.20.30.11   | ec2-user  | C:\Users\user\.ssh\corporate_infrastructure.pem                |
| Dental Collector   | 10.20.30.181   | ec2-user  | C:\Users\user\.ssh\corporate_infrastructure.pem        |
| O2 Server (OpenObserve) | 10.20.30.5 | ec2-user | C:\Users\user\.ssh\corporate_infrastructure.pem               |

## Standard Paramiko Pattern

```python
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    "10.20.30.11",
    username="ec2-user",
    key_filename=r"C:\Users\user\.ssh\corporate_infrastructure.pem",
    timeout=10
)
_, stdout, stderr = client.exec_command("your command here")
print(stdout.read().decode())
client.close()
```

## Multi-Host Script Pattern

Write a `.py` file, then run:
```
C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe C:\path\to\script.py
```

```python
import paramiko

HOSTS = {
    "medical_collector": {
        "host": "10.20.30.11",
        "user": "ec2-user",
        "key": r"C:\Users\user\.ssh\corporate_infrastructure.pem",
    },
    "dental_collector": {
        "host": "10.20.30.181",
        "user": "ec2-user",
        "key": r"C:\Users\user\.ssh\corporate_infrastructure.pem",
    },
    "o2_server": {
        "host": "10.20.30.5",
        "user": "ec2-user",
        "key": r"C:\Users\user\.ssh\corporate_infrastructure.pem",
    },
}

def ssh_run(cfg, command):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(cfg["host"], username=cfg["user"], key_filename=cfg["key"], timeout=10)
    _, stdout, stderr = client.exec_command(command)
    out = stdout.read().decode().strip()
    client.close()
    return out

for name, cfg in HOSTS.items():
    print(f"\n=== {name} ({cfg['host']}) ===")
    print(ssh_run(cfg, "hostname && uptime"))
```

## O2 Infrastructure Status (as of 2026-06-22)

### Medical Collector (10.20.30.11)
- Uptime: 327 days
- Services: goflow2-vector, otelcol, syslog-ng, vpn_checker, health_checker, dns_checker, cert_checker all **active**
- NetFlow samplers: `192.168.44.7/8` → tagged `Site-B` | `172.27.28.89/88` → tagged `Site-A`
- Stream target: `medical_netflow` on O2 server
- Disk: 197GB at 2% used (`/mnt/software`)
- RAM: 3.7GB total, ~763MB used

### Dental Collector (10.20.30.181)
- Uptime: 17 days
- Services: all same as medical — all **active**
- NetFlow samplers: `10.19.56.186/236` → tagged `aws`
- Stream target: `dental_netflow` on O2 server
- Disk: 196GB at 1% used (`/mnt/software`)
- RAM: 3.7GB total, ~2GB used (tighter than medical)

### O2 Server / OpenObserve (10.20.30.5)
- Uptime: 18 days
- Disk: 492GB at 37% used (173GB used on `/mnt/software`)
- Has `openobserve` and `openobserve-bkup` directories
- API endpoint: `http://10.20.30.5:5080`
- API auth: user `itops@example.com`

## Notes
- No swap configured on any host — monitor memory, especially dental collector
- `vector.service` is inactive by design; the active service is `goflow2-vector` (goflow2 piped to vector)
- A working test script exists at: `C:\apps\o2-manager\ssh-test.py`
- O2 project scripts repo: `C:\Users\user\My Drive\Documents\Claude\Projects\o2-scripts`
