-- 024_sites_rename.sql
-- "Site Groups" is renamed to "Sites" throughout the app. This migration:
--   1. Renames the site_groups table to sites.
--   2. Renames address_mappings.group_name (which referenced site_groups.name)
--      to address_mappings.site_key.
--   3. Adds sites.ip_cidr — a comma-separated list of IP/CIDR values used to
--      place remote (public) traffic at this site's marker color on the Geo
--      Map, the same way address_mappings already does for the local end.
--   4. Renames the seeded 'other' row to 'default' — every install has
--      exactly one Default site, identified by this key. The key is locked
--      in the API (see app/api/geo_config.py); display name/colors/ip_cidr
--      stay editable. Existing address_mappings pointing at 'other' move to
--      'default' along with it so nothing goes unmatched.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

ALTER TABLE site_groups RENAME TO sites;
ALTER TABLE sites ADD COLUMN ip_cidr TEXT NOT NULL DEFAULT '';

ALTER TABLE address_mappings RENAME COLUMN group_name TO site_key;

UPDATE sites SET name = 'default', display_name = 'Default'
    WHERE name = 'other' AND NOT EXISTS (SELECT 1 FROM sites WHERE name = 'default');

UPDATE address_mappings SET site_key = 'default' WHERE site_key = 'other';
