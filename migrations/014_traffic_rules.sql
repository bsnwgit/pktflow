-- 014_traffic_rules.sql
-- Traffic Rules: refine arc classification beyond an Address Mapping's
-- default Line Style. A rule optionally scopes to one address_mappings row
-- (NULL = any) and matches on a destination CIDR/IP and/or a destination
-- port (at least one required) — e.g. "traffic to 203.0.113.1 or 203.0.113.9" or
-- "any traffic to port 53" gets its own Line Style instead of blending into
-- the address mapping's generic line. `priority` (lower wins) resolves
-- conflicts when more than one rule matches the same flow.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS traffic_rules (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    address_mapping_id INTEGER REFERENCES address_mappings(id) ON DELETE CASCADE,  -- NULL = any address mapping
    dst_cidr          TEXT,                            -- destination CIDR/IP to match; NULL = any destination
    dst_port          INTEGER,                         -- destination port to match; NULL = any port
    line_style_id     INTEGER REFERENCES line_styles(id) ON DELETE SET NULL,
    priority          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (dst_cidr IS NOT NULL OR dst_port IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_traffic_rules_mapping ON traffic_rules(address_mapping_id);
CREATE INDEX IF NOT EXISTS idx_traffic_rules_priority ON traffic_rules(priority);
