-- 013_address_mappings.sql
-- Merge vpn_mappings + wan_mappings into one address_mappings table. Both
-- tables always did the same job (private CIDR -> external CIDR/IP for
-- geolocation) with only a labeling difference between them; `category`
-- keeps that distinction as a cosmetic badge. Traffic Types goes away in
-- favor of picking a Line Style directly per entry. `priority` (lower wins)
-- replaces the old hardcoded gp>s2s>wan ordering for when both ends of a
-- flow match different entries.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS address_mappings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    group_name    TEXT NOT NULL DEFAULT 'other',
    category      TEXT NOT NULL DEFAULT 'wan' CHECK (category IN ('wan', 'vpn')),
    private_cidr  TEXT NOT NULL UNIQUE,
    public_cidr   TEXT NOT NULL,
    line_style_id INTEGER REFERENCES line_styles(id) ON DELETE SET NULL,
    priority      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_address_mappings_group ON address_mappings(group_name);
CREATE INDEX IF NOT EXISTS idx_address_mappings_priority ON address_mappings(priority);

-- Migrate existing VPN mappings (category = 'vpn'), deriving line_style_id
-- from the old entry_type -> traffic_types -> line_styles chain.
INSERT INTO address_mappings (name, group_name, category, private_cidr, public_cidr, line_style_id, priority, created_at)
SELECT
    v.site_name,
    v.group_name,
    'vpn',
    v.cidr_or_ip,
    v.public_ip,
    (SELECT t.line_style_id FROM traffic_types t WHERE t.name = v.entry_type),
    ROW_NUMBER() OVER (ORDER BY v.id) - 1,
    v.created_at
FROM vpn_mappings v;

-- Migrate existing WAN mappings (category = 'wan'), continuing the priority
-- sequence after the VPN rows so nothing collides.
INSERT INTO address_mappings (name, group_name, category, private_cidr, public_cidr, line_style_id, priority, created_at)
SELECT
    w.name,
    w.group_name,
    'wan',
    w.private_cidr,
    w.wan_cidr,
    (SELECT t.line_style_id FROM traffic_types t WHERE t.name = w.entry_type),
    (SELECT COUNT(*) FROM vpn_mappings) + ROW_NUMBER() OVER (ORDER BY w.id) - 1,
    w.created_at
FROM wan_mappings w;

DROP TABLE vpn_mappings;
DROP TABLE wan_mappings;
DROP TABLE traffic_types;
