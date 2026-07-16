-- 012_badge_bg_hex.sql
-- site_groups.badge_bg switched from a Tailwind background class (e.g.
-- "bg-gray-700") to a raw hex color, same treatment as badge_text in
-- 010_badge_text_hex.sql, now driven by a <input type="color"> picker.
-- Convert existing rows seeded with the old Tailwind class strings to their
-- hex equivalents so the badge doesn't silently lose its background / the
-- picker doesn't show a broken value.

UPDATE site_groups SET badge_bg = '#374151' WHERE badge_bg = 'bg-gray-700';
UPDATE site_groups SET badge_bg = '#5b21b6' WHERE badge_bg = 'bg-violet-800';
UPDATE site_groups SET badge_bg = '#065f46' WHERE badge_bg = 'bg-emerald-800';
