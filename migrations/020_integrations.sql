-- Named connections to sibling pkt* apps pktflow pulls data from (currently
-- just pktIPAM, for internal-IP lookups). Multiple named instances are
-- supported, same table shape as pktIPAM's own integrations table.
CREATE TABLE IF NOT EXISTS integrations (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,   -- user-given label, e.g. "Main pktIPAM"
    app_name          TEXT NOT NULL DEFAULT 'pktipam',
    base_url          TEXT NOT NULL DEFAULT '',
    suite_token       TEXT NOT NULL DEFAULT '',
    enabled           INTEGER NOT NULL DEFAULT 1,
    health_status     TEXT NOT NULL DEFAULT 'unknown',
    last_health_check TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_app_name ON integrations(app_name);
