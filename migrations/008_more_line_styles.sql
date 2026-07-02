-- 008_more_line_styles.sql
-- Expands the line_styles catalog with 5 additional styles covering
-- solid fills and varied dash patterns across more colors.

PRAGMA journal_mode=WAL;

INSERT OR IGNORE INTO line_styles (name, label, color_hex, dash_pattern) VALUES
    ('solid_green',      'Solid (Green)',        '#10b981', ''),
    ('solid_blue',       'Solid (Blue)',         '#3b82f6', ''),
    ('dash_purple',      'Dashed (Purple)',      '#a855f7', '8,4'),
    ('dotted_yellow',    'Dotted (Yellow)',      '#fbbf24', '2,4'),
    ('long_dash_cyan',   'Long Dash (Cyan)',     '#06b6d4', '12,4');
