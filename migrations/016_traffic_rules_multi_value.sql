-- 016_traffic_rules_multi_value.sql
-- Traffic Rules: allow multiple destination IPs/CIDRs and multiple ports (or
-- port ranges) per rule instead of exactly one each. Previously the DNS
-- example (1.1.1.1 and 9.9.9.9) needed two separate rules with the same Line
-- Style; now one rule can list both. dst_cidr -> dst_cidrs and
-- dst_port -> dst_ports, both comma-separated TEXT (e.g. "1.1.1.1,9.9.9.9"
-- or "53,8000-9000"). Existing single-value rows are preserved as one-item
-- lists. Matching is still first-hit wins in priority order — a rule now
-- matches if the destination falls in ANY of its listed CIDRs and/or ANY of
-- its listed ports/ranges.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE traffic_rules_v2 (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    address_mapping_id INTEGER REFERENCES address_mappings(id) ON DELETE CASCADE,
    dst_cidrs          TEXT,
    dst_ports          TEXT,
    line_style_id      INTEGER REFERENCES line_styles(id) ON DELETE SET NULL,
    priority           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (address_mapping_id IS NOT NULL OR dst_cidrs IS NOT NULL OR dst_ports IS NOT NULL)
);

INSERT INTO traffic_rules_v2 (id, name, address_mapping_id, dst_cidrs, dst_ports, line_style_id, priority, created_at)
SELECT id, name, address_mapping_id, dst_cidr, CAST(dst_port AS TEXT), line_style_id, priority, created_at
FROM traffic_rules;

DROP TABLE traffic_rules;
ALTER TABLE traffic_rules_v2 RENAME TO traffic_rules;

CREATE INDEX IF NOT EXISTS idx_traffic_rules_mapping ON traffic_rules(address_mapping_id);
CREATE INDEX IF NOT EXISTS idx_traffic_rules_priority ON traffic_rules(priority);
