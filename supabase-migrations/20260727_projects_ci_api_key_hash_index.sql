-- Index the CI/CD API-key hash so `requireCiApiKey` is a LOOKUP, not a scan.
--
-- Before this, the middleware fetched up to 100 CI-keyed projects, UNORDERED,
-- and linear-scanned them in Node. Past 100 such projects an arbitrary subset
-- of *valid* keys returned 401 — a silent, unreproducible auth failure whose
-- blast radius grows with customer count.
--
-- Replacing that with `.eq('settings->ciApiKey->>hash', ...)` is correct but,
-- without this index, a full sequential scan of `projects` on every CI request
-- — trading one scale problem for another. `projects` has no index on
-- `settings` at all (grep 'ciApiKey' over this folder returned zero hits
-- before this file).
--
-- Partial on `settings->'ciApiKey' IS NOT NULL`: only projects that have ever
-- generated a CI key belong in it. The caller RESTATES that predicate in its
-- WHERE clause (`.not('settings->ciApiKey','is',null)`, kept alongside the
-- `.eq`) so the planner can prove the partial predicate and actually use this
-- index — a partial index whose predicate the query doesn't imply is dead
-- weight.
--
-- Plain CREATE INDEX, not CONCURRENTLY: `projects` is a small table (one row
-- per customer project), so the ACCESS EXCLUSIVE lock is momentary, and
-- CONCURRENTLY cannot run inside a transaction block — which the migration
-- path may wrap this in. Same reasoning as the partial index in
-- 20260517_account_deletion.sql. If `projects` ever grows to a scale where the
-- lock matters, re-issue this as its own non-transactional CONCURRENTLY
-- migration.

CREATE INDEX IF NOT EXISTS idx_projects_ci_api_key_hash
  ON projects ((settings->'ciApiKey'->>'hash'))
  WHERE settings->'ciApiKey' IS NOT NULL;

COMMENT ON INDEX idx_projects_ci_api_key_hash IS
  'CI/CD API-key auth lookup (requireCiApiKey). Partial: only projects with a ciApiKey. Callers must keep the "settings->ciApiKey IS NOT NULL" filter in the query so this index is used.';
