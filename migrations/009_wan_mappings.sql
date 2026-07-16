-- 009_wan_mappings.sql
-- WAN address mappings: associate a site's private CIDR/IP with its known
-- public WAN IP (or block) so the geo map can place regular (non-VPN)
-- internet-egress traffic at the correct physical site, the same way
-- vpn_mappings already does for GP/S2S traffic.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS wan_mappings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,                  -- display name e.g. "Site A WAN"
    group_name   TEXT NOT NULL DEFAULT 'other',   -- site group, configured in Settings → Geo Map → Site Groups
    wan_cidr     TEXT NOT NULL UNIQUE,             -- public WAN IP (as /32) or a larger CIDR block
    private_cidr TEXT NOT NULL UNIQUE,             -- private CIDR/IP matched against flow src/dst for this site
    entry_type   TEXT NOT NULL DEFAULT 'wan',      -- references traffic_types.name
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wan_mappings_group ON wan_mappings(group_name);
