-- 010_badge_text_hex.sql
-- site_groups.badge_text switched from a Tailwind text-color class (e.g.
-- "text-gray-300") to a raw hex color, driven by a <input type="color">
-- picker in Settings → Geo Map → Site Groups. Convert existing rows seeded
-- with the old Tailwind class strings to their hex equivalents so the badge
-- doesn't silently lose its text color / the picker doesn't show a broken value.

UPDATE site_groups SET badge_text = '#d1d5db' WHERE badge_text = 'text-gray-300';
UPDATE site_groups SET badge_text = '#ddd6fe' WHERE badge_text = 'text-violet-200';
UPDATE site_groups SET badge_text = '#a7f3d0' WHERE badge_text = 'text-emerald-200';
