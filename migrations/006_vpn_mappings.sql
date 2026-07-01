-- 006_vpn_mappings.sql
-- VPN site mappings: associate RFC-1918 subnets/IPs with a public firewall IP
-- so the geo map can geolocate private-IP traffic to the correct physical site.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS vpn_mappings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name   TEXT NOT NULL,                  -- display name e.g. "Site-A", "Site-B", "Cloud Site"
    group_name  TEXT NOT NULL DEFAULT 'other',  -- "medical" or "dental"
    public_ip   TEXT NOT NULL,                  -- public firewall IP used for geo lookup
    cidr_or_ip  TEXT NOT NULL UNIQUE,           -- RFC-1918 CIDR (e.g. "10.42.0.0/16") or single IP
    entry_type  TEXT NOT NULL DEFAULT 's2s'
                    CHECK (entry_type IN ('gp', 's2s')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vpn_mappings_group ON vpn_mappings(group_name);

-- ── Medical group ──────────────────────────────────────────────────────────────
-- Site-A site (access.example.com GlobalProtect, firewall 203.0.113.10)
INSERT OR IGNORE INTO vpn_mappings (site_name, group_name, public_ip, cidr_or_ip, entry_type) VALUES
    ('Site-A',     'medical', '203.0.113.10',     '172.27.28.0/24', 's2s'),
    ('Site-A',     'medical', '203.0.113.10',     '172.27.37.0/24', 'gp');

-- Site-B site (vpn.extractsystems.com GlobalProtect, firewall 147.202.193.217)
INSERT OR IGNORE INTO vpn_mappings (site_name, group_name, public_ip, cidr_or_ip, entry_type) VALUES
    ('Site-B', 'medical', '147.202.193.217', '192.168.44.0/24', 's2s');

-- ── Dental group ───────────────────────────────────────────────────────────────
-- Cloud Site (access.example.com + remote.example.com GlobalProtect portals;
--           AZ2A + AZ2B firewalls, GP load-balanced; geo pinned to AZ2A primary)
INSERT OR IGNORE INTO vpn_mappings (site_name, group_name, public_ip, cidr_or_ip, entry_type) VALUES
    ('Cloud Site', 'dental', '3.130.211.110', '10.42.0.0/16',  'gp'),   -- access.example.com GP
    ('Cloud Site', 'dental', '3.130.211.110', '10.43.0.0/16',  'gp'),   -- remote.example.com GP
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.32.219',  's2s'),  -- AZ2A interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.50.76',   's2s'),  -- AZ2A interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.56.186',  's2s'),  -- AZ2A interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.33.8',    's2s'),  -- AZ2A interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.81.236',  's2s'),  -- AZ2B interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.64.53',   's2s'),  -- AZ2B interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.84.172',  's2s'),  -- AZ2B interface
    ('Cloud Site', 'dental', '3.130.211.110', '10.19.33.26',   's2s');  -- AZ2B interface
