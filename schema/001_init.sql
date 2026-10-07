-- Branchline D1 schema
-- 001_init.sql

CREATE TABLE IF NOT EXISTS branches (
  name       TEXT PRIMARY KEY,
  intent     TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  touches    TEXT NOT NULL,          -- JSON array of glob patterns
  base_sha   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',  -- open | merged | needs-resolution | abandoned
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS merges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch     TEXT NOT NULL,
  base       TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT 'main',
  tier       INTEGER,                 -- 1 | 2 | 3, NULL while queued
  status     TEXT NOT NULL DEFAULT 'queued', -- queued | merged | needs-resolution | failed
  artifact   TEXT,                    -- JSON conflict artifact for tier 3
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (branch) REFERENCES branches(name)
);

CREATE INDEX IF NOT EXISTS idx_merges_status ON merges(status);
CREATE INDEX IF NOT EXISTS idx_branches_status ON branches(status);
