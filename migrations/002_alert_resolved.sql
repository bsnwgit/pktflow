-- Migration 002: add resolved_at and auto_resolved to alert_events
-- Distinguishes engine auto-resolve from user-initiated ACK

ALTER TABLE alert_events ADD COLUMN resolved_at TEXT;
ALTER TABLE alert_events ADD COLUMN auto_resolved INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_alert_events_resolved ON alert_events(resolved_at);
