-- Migration 005: Application log table for in-app troubleshooting viewer
-- Ring buffer enforced by the handler (max 10,000 rows); indices kept small.

CREATE TABLE IF NOT EXISTS app_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    level       TEXT    NOT NULL,   -- DEBUG | INFO | WARNING | ERROR | CRITICAL
    level_no    INTEGER NOT NULL,   -- 10 | 20 | 30 | 40 | 50
    logger      TEXT    NOT NULL,   -- e.g. pktflow.ingest
    message     TEXT    NOT NULL,
    exc_info    TEXT    NULL        -- formatted traceback, only present on exceptions
);

CREATE INDEX IF NOT EXISTS idx_app_logs_ts       ON app_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_level_no ON app_logs (level_no);
CREATE INDEX IF NOT EXISTS idx_app_logs_logger   ON app_logs (logger);
