-- 026_nat_mapping_dst_scoping.sql
-- Traffic Rules rework, part 1: lets a NAT Mapping's private->public resolution
-- vary by the flow's destination, matching real-world firewalls that NAT the
-- same private range differently depending on destination CIDR/port (e.g. a
-- firewall using a different public egress IP for DNS traffic than everything
-- else). app/api/flows.py resolves these per flow pair, first-match-wins in
-- priority order — same pattern already used for Traffic Rules' own
-- dst_cidrs/dst_ports. Blank/NULL on either field = applies to any
-- destination, same as today.
--
-- Also adds traffic_rules.dst_site_key: an alternative to manually typing a
-- destination CIDR/IP — pick a Site instead, and matching resolves that
-- Site's current ip_cidr live at request time. A rule may use dst_cidrs OR
-- dst_site_key, never both (enforced below and in app/api/traffic_rules.py).

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

ALTER TABLE nat_mappings ADD COLUMN dst_cidrs TEXT;
ALTER TABLE nat_mappings ADD COLUMN dst_ports TEXT;

CREATE TABLE traffic_rules_v2 (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    nat_mapping_id INTEGER REFERENCES nat_mappings(id) ON DELETE CASCADE,
    dst_cidrs      TEXT,
    dst_site_key   TEXT REFERENCES sites(name) ON DELETE SET NULL,
    dst_ports      TEXT,
    line_style_id  INTEGER REFERENCES line_styles(id) ON DELETE SET NULL,
    priority       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (nat_mapping_id IS NOT NULL OR dst_cidrs IS NOT NULL OR dst_site_key IS NOT NULL OR dst_ports IS NOT NULL),
    CHECK (dst_cidrs IS NULL OR dst_site_key IS NULL)
);

INSERT INTO traffic_rules_v2 (id, name, nat_mapping_id, dst_cidrs, dst_ports, line_style_id, priority, created_at)
    SELECT id, name, nat_mapping_id, dst_cidrs, dst_ports, line_style_id, priority, created_at
    FROM traffic_rules;

DROP TABLE traffic_rules;
ALTER TABLE traffic_rules_v2 RENAME TO traffic_rules;

CREATE INDEX IF NOT EXISTS idx_traffic_rules_mapping ON traffic_rules(nat_mapping_id);
CREATE INDEX IF NOT EXISTS idx_traffic_rules_priority ON traffic_rules(priority);
CREATE INDEX IF NOT EXISTS idx_traffic_rules_site ON traffic_rules(dst_site_key);
