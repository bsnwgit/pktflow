-- 027_alert_rule_type_expand.sql
-- alert_rules.rule_type had a CHECK constraint limited to the original 5
-- rule types ('threshold','rate_spike','port_protocol','new_host','data_gap').
-- The Alerts UI and app/alerts/engine.py were extended over time to support
-- 9 more types (top_talker, elephant_flow, inter_site_traffic,
-- connection_burst, port_scan, internal_spread, protocol_anomaly,
-- ingest_rate_low, clickhouse_size, asymmetric_flow) without the DB
-- constraint ever being updated, so saving any of those rule types raised a
-- sqlite3.IntegrityError -> 500 ("Failed to save rule"). SQLite can't ALTER
-- a CHECK constraint in place, so this rebuilds the table.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=OFF;

CREATE TABLE alert_rules_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    rule_type       TEXT NOT NULL
                        CHECK (rule_type IN (
                            'threshold','rate_spike','port_protocol','new_host','data_gap',
                            'top_talker','elephant_flow','inter_site_traffic','connection_burst',
                            'port_scan','internal_spread','protocol_anomaly','ingest_rate_low',
                            'clickhouse_size','asymmetric_flow'
                        )),
    conditions      TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific params
    time_window_min INTEGER NOT NULL DEFAULT 5,
    severity        TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info','warning','critical')),
    channels        TEXT NOT NULL DEFAULT '["inapp"]',  -- JSON array of channel names
    cooldown_min    INTEGER NOT NULL DEFAULT 30,
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired      TEXT
);

INSERT INTO alert_rules_new
    (id, name, description, enabled, rule_type, conditions, time_window_min,
     severity, channels, cooldown_min, created_by, created_at, updated_at, last_fired)
SELECT id, name, description, enabled, rule_type, conditions, time_window_min,
       severity, channels, cooldown_min, created_by, created_at, updated_at, last_fired
FROM alert_rules;

DROP TABLE alert_rules;
ALTER TABLE alert_rules_new RENAME TO alert_rules;

PRAGMA foreign_keys=ON;
