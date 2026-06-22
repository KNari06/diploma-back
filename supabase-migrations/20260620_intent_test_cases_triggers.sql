-- =============================================================================
-- Triggers — per-test event→action rules forwarded to the mobile runner
-- =============================================================================
-- A trigger is a user-defined rule the mobile runner matches BEFORE the
-- built-in permission policy: when an unexpected blocking surface appears
-- (native permission prompt, any dialog, or a dialog containing some text),
-- run the matching action (allow/deny the permission, tap a labelled button,
-- or go back).
--
-- Stored per-test on `intent_test_cases` (mirrors `resource_bindings`), echoed
-- into the BullMQ mobile job, and forwarded verbatim in the run-steps body.
-- The runner validates the exact same shape (qait-mobile-runner
-- src/api/schemas/run.schema.ts triggerSchema) and stashes them on the session
-- for its trigger engine.
--
-- Shape (TypeScript — canonical cross-repo contract):
--   Array<{
--     id: string,
--     condition:
--       | { kind: 'permission_dialog' }
--       | { kind: 'any_dialog' }
--       | { kind: 'dialog_text', contains: string },
--     action:
--       | { kind: 'permission', decision: 'allow' | 'deny' }
--       | { kind: 'tap', text: string }
--       | { kind: 'back' }
--   }>
--
-- There is NO `source` field — that's runner-internal (defaults to 'user').
-- Empty array (the default) means "no user triggers" — the runner falls back
-- to its built-in permission policy.

BEGIN;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS triggers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Tests-that-carry-a-trigger-kind queries (analytics, audit). GIN on the JSONB
-- array indexes each element for fast containment matches:
--   WHERE triggers @> '[{"condition":{"kind":"permission_dialog"}}]'
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_triggers
  ON intent_test_cases USING GIN (triggers);

COMMENT ON COLUMN intent_test_cases.triggers IS 'Array of {id, condition, action} event→action rules forwarded verbatim to the mobile runner (run-steps body). Matched before the built-in permission policy. Empty array = no user triggers.';

COMMIT;
