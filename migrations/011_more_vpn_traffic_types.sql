-- 011_more_vpn_traffic_types.sql
-- Round out the VPN Site Mappings "Type" dropdown with the common VPN
-- categories beyond GlobalProtect (gp) and Site-to-Site (s2s). Left
-- unstyled (line_style_id NULL) — assign a line style/color for each via
-- Settings → Geo Map → Traffic Types.

INSERT OR IGNORE INTO traffic_types (name, label, line_style_id, is_default) VALUES
    ('remote_access', 'Remote Access VPN', NULL, 0),
    ('cloud_vpn',      'Cloud VPN',         NULL, 0),
    ('ssl_vpn',        'SSL VPN',           NULL, 0);
