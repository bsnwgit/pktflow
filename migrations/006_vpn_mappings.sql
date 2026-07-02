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
