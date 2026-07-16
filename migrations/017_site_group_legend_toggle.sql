-- 017_site_group_legend_toggle.sql
-- Site Groups: add a per-group "show in legend" toggle. Every group currently
-- always appears in the Geo Map legend's Sites section unconditionally; this
-- lets a less-relevant group (e.g. a generic "Other" fallback) be hidden from
-- the legend without deleting the group itself. Defaults to shown (1) so
-- existing groups keep their current behavior.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

ALTER TABLE site_groups ADD COLUMN show_in_legend INTEGER NOT NULL DEFAULT 1 CHECK (show_in_legend IN (0, 1));
