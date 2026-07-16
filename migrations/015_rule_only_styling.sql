-- 015_rule_only_styling.sql
-- Address Mappings no longer carry their own Line Style — Traffic Rules is
-- now the single source of visual styling on the Geo Map, removing the old
-- ambiguity of "is this arc's color coming from the mapping or a rule
-- override?". A rule with an address_mapping_id and no destination filter
-- now acts as that mapping's default style (it must sit below any more
-- specific rules for the same mapping in priority order, since matching is
-- first-hit top-to-bottom).

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Recreate traffic_rules without the old CHECK (dst_cidr or dst_port
-- required) constraint — a rule may now match on address_mapping_id alone.
CREATE TABLE traffic_rules_v2 (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    address_mapping_id INTEGER REFERENCES address_mappings(id) ON DELETE CASCADE,
    dst_cidr           TEXT,
    dst_port           INTEGER,
    line_style_id      INTEGER REFERENCES line_styles(id) ON DELETE SET NULL,
    priority           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (address_mapping_id IS NOT NULL OR dst_cidr IS NOT NULL OR dst_port IS NOT NULL)
);
INSERT INTO traffic_rules_v2 SELECT * FROM traffic_rules;
DROP TABLE traffic_rules;
ALTER TABLE traffic_rules_v2 RENAME TO traffic_rules;
CREATE INDEX IF NOT EXISTS idx_traffic_rules_mapping ON traffic_rules(address_mapping_id);
CREATE INDEX IF NOT EXISTS idx_traffic_rules_priority ON traffic_rules(priority);

-- Port each existing address_mappings.line_style_id into an equivalent
-- catch-all rule (no destination filter) so map appearance is preserved.
-- Appended after any existing rules (lowest priority) so specific rules
-- already scoped to the same mapping keep winning first.
INSERT INTO traffic_rules (name, address_mapping_id, dst_cidr, dst_port, line_style_id, priority)
SELECT
    am.name || ' (default)',
    am.id,
    NULL,
    NULL,
    am.line_style_id,
    (SELECT COALESCE(MAX(priority) + 1, 0) FROM traffic_rules) + ROW_NUMBER() OVER (ORDER BY am.id) - 1
FROM address_mappings am
WHERE am.line_style_id IS NOT NULL;

-- Address Mappings no longer carry a style of their own.
ALTER TABLE address_mappings DROP COLUMN line_style_id;
