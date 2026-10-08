-- Branchline D1 schema migration
-- 002_merge_sha.sql
-- Adds the merge-commit SHA to merged rows (tiers 1-2).

ALTER TABLE merges ADD COLUMN merge_sha TEXT;  -- SHA of the merge commit, NULL unless status='merged'
