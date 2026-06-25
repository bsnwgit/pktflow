-- Migration 003: sampler dismissal tracking
-- Stores sampler IPs that have been dismissed from the Unknown Samplers review panel.
-- Dismissed entries are hidden from the "needs review" list but remain visible
-- in the collapsed Dismissed section where they can be reconsidered.

CREATE TABLE IF NOT EXISTS sampler_dismissals (
    sampler_ip   TEXT PRIMARY KEY,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
