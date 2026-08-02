-- 025_nat_mappings_rename.sql
-- "Address Mappings" is renamed to "Private/Public NAT Mapping" throughout
-- the app. This migration:
--   1. Renames the address_mappings table to nat_mappings.
--   2. Renames traffic_rules.address_mapping_id (FK) to nat_mapping_id.
--   3. Drops the UNIQUE constraint on private_cidr — multiple rows may now
--      share the same private and/or public CIDR; existing priority order
--      (drag-and-drop) already resolves which one wins on conflict.
--   4. Adds nat_mappings.show_in_legend — controls a new "Address Mappings"
--      section on the Geo Map legend, same pattern as sites.show_in_legend.
--      Defaults to 1 so existing rows keep showing up after this migration.

PRAGMA journal_mode=WAL;

-- nat_mappings is a foreign-key PARENT of traffic_rules (ON DELETE CASCADE).
-- With foreign_keys=ON, SQLite fires cascade deletes on child rows when a
-- parent table is dropped, not just on an explicit DELETE — the DROP TABLE
-- below would silently wipe every traffic_rules row scoped to a mapping.
-- Foreign key enforcement is off by default per-connection anyway (SQLite
-- requires it to be explicitly turned on), so this is just being explicit
-- rather than relying on that default.
PRAGMA foreign_keys=OFF;

ALTER TABLE address_mappings RENAME TO nat_mappings;

CREATE TABLE nat_mappings_v2 (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    site_key       TEXT NOT NULL DEFAULT 'default',
    category       TEXT NOT NULL DEFAULT 'wan' CHECK (category IN ('wan', 'vpn')),
    private_cidr   TEXT NOT NULL,
    public_cidr    TEXT NOT NULL,
    priority       INTEGER NOT NULL DEFAULT 0,
    show_in_legend INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO nat_mappings_v2 (id, name, site_key, category, private_cidr, public_cidr, priority, created_at)
    SELECT id, name, site_key, category, private_cidr, public_cidr, priority, created_at
    FROM nat_mappings;

DROP TABLE nat_mappings;
ALTER TABLE nat_mappings_v2 RENAME TO nat_mappings;

CREATE INDEX IF NOT EXISTS idx_nat_mappings_site ON nat_mappings(site_key);
CREATE INDEX IF NOT EXISTS idx_nat_mappings_priority ON nat_mappings(priority);

ALTER TABLE traffic_rules RENAME COLUMN address_mapping_id TO nat_mapping_id;

PRAGMA foreign_keys=ON;
