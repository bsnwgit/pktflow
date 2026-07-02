-- 007_geo_map_config.sql
-- Configurable Geo Map system: site groups, line style catalog, traffic types.
-- Also recreates vpn_mappings without the hardcoded entry_type CHECK constraint
-- so that user-defined traffic types can be referenced freely.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ── Site Groups ──────────────────────────────────────────────────────────────
-- Replaces hardcoded GROUP_COLOR / GROUP_STROKE / badge classes in the frontend.
-- fill_color / stroke_color: hex color strings used for Leaflet circle markers.
-- badge_bg / badge_text: Tailwind classes used for group badges in the Settings UI.

CREATE TABLE IF NOT EXISTS site_groups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,              -- key stored in vpn_mappings.group_name
    display_name TEXT NOT NULL,                     -- human-readable label
    fill_color   TEXT NOT NULL DEFAULT '#60a5fa',   -- hex, circle fill
    stroke_color TEXT NOT NULL DEFAULT '#93c5fd',   -- hex, circle border
    badge_bg     TEXT NOT NULL DEFAULT 'bg-gray-700',
    badge_text   TEXT NOT NULL DEFAULT 'text-gray-300',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO site_groups (name, display_name, fill_color, stroke_color, badge_bg, badge_text) VALUES
    ('medical', 'Medical', '#a78bfa', '#c4b5fd', 'bg-violet-800',  'text-violet-200'),
    ('dental',  'Dental',  '#34d399', '#6ee7b7', 'bg-emerald-800', 'text-emerald-200'),
    ('other',   'Other',   '#60a5fa', '#93c5fd', 'bg-gray-700',    'text-gray-300');

-- ── Line Style Catalog ────────────────────────────────────────────────────────
-- Visual catalog of arc line styles available to traffic types.
-- color_hex: the arc stroke color.
-- dash_pattern: SVG stroke-dasharray value; empty string = solid line.

CREATE TABLE IF NOT EXISTS line_styles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    color_hex    TEXT NOT NULL DEFAULT '#6b7280',
    dash_pattern TEXT NOT NULL DEFAULT '',          -- '' = solid
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO line_styles (name, label, color_hex, dash_pattern) VALUES
    ('gp_line',     'Dash-Dot (Green)',  '#10b981', '8,3,8,3,2,3'),
    ('s2s_line',    'Dashed (Blue)',     '#3b82f6', '10,5'),
    ('wan_line',    'Solid (Red)',       '#ef4444', ''),
    ('dotted_gray', 'Dotted (Gray)',     '#6b7280', '2,4'),
    ('dash_orange', 'Dashed (Orange)',   '#f97316', '8,4');

-- ── Traffic Types ─────────────────────────────────────────────────────────────
-- Maps a user-defined traffic type name to a line style.
-- name: stored in vpn_mappings.entry_type.
-- is_default = 1 marks the fallback type used for unmatched (non-VPN) WAN flows.

CREATE TABLE IF NOT EXISTS traffic_types (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    line_style_id INTEGER REFERENCES line_styles(id) ON DELETE SET NULL,
    is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO traffic_types (name, label, line_style_id, is_default) VALUES
    ('gp',  'GlobalProtect VPN', (SELECT id FROM line_styles WHERE name = 'gp_line'),  0),
    ('s2s', 'Site-to-Site VPN',  (SELECT id FROM line_styles WHERE name = 's2s_line'), 0),
    ('wan', 'WAN Traffic',       (SELECT id FROM line_styles WHERE name = 'wan_line'),  1);

CREATE INDEX IF NOT EXISTS idx_traffic_types_default ON traffic_types(is_default);

-- ── Relax vpn_mappings entry_type constraint ─────────────────────────────────
-- SQLite does not support ALTER COLUMN, so we recreate the table without the
-- CHECK (entry_type IN ('gp', 's2s')) constraint. Existing rows are preserved.

CREATE TABLE IF NOT EXISTS vpn_mappings_v2 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name   TEXT NOT NULL,
    group_name  TEXT NOT NULL DEFAULT 'other',
    public_ip   TEXT NOT NULL,
    cidr_or_ip  TEXT NOT NULL UNIQUE,
    entry_type  TEXT NOT NULL DEFAULT 's2s',    -- references traffic_types.name
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO vpn_mappings_v2 (id, site_name, group_name, public_ip, cidr_or_ip, entry_type, created_at)
    SELECT id, site_name, group_name, public_ip, cidr_or_ip, entry_type, created_at
    FROM vpn_mappings;

DROP TABLE vpn_mappings;
ALTER TABLE vpn_mappings_v2 RENAME TO vpn_mappings;

CREATE INDEX IF NOT EXISTS idx_vpn_mappings_group ON vpn_mappings(group_name);
