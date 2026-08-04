-- Network assertions for intent_test_cases
--
-- Exploration already DERIVES network assertions during discovery: every flow's
-- successful API calls are captured for free by NetworkTracker, deduped, and
-- normalized into a stable shape by network-assertions.ts —
--   { type:'network', expect:'POST /api/auth returns 2xx',
--     source:{ method, urlPattern, status } }
-- — then attached to DiscoveredTestCase.assertions (test-case-builder.ts).
--
-- They were then THROWN AWAY on persist. exploration-storage.service.ts
-- flattened each one into a tag string (`assert:network:POST:/api/x:2xx`) with
-- the code's own admission that "the full TestAssertion shape is lost on
-- round-trip", and toIntentTestCase never referenced `assertions` at all. Those
-- tags are write-only — nothing in the codebase reads them back — so they are a
-- filterable label, never a verification. Result: every discovered web test's
-- only pass criterion was a terminal `ai_check`, an LLM re-judging free text an
-- LLM wrote, which cannot catch a broken API behind a UI that still renders.
--
-- WHY A COLUMN AND NOT A STEP: an assertion of this kind is test-case-level, not
-- positional — "this flow hits POST /api/auth and it must return 2xx" is a
-- property of the run, not of step 4. The IntentStep type vocabulary is a fixed
-- persisted set consumed by the converter, the step linter, replay and the
-- frontend; inventing a step type to carry non-positional data would bend all
-- four. jsonb keeps the full TestAssertion shape intact and leaves the step list
-- meaning exactly what it means today.
--
-- NOT the same axis as anything already on this table: `tags` is user-facing
-- labels, `expected_result` is prose for a human, and `status` is lifecycle
-- (draft|published|archived). This column is machine-checkable expectations.
--
-- Nullable with no default: NULL/absent means "no network expectations recorded"
-- (manually-authored tests, imports, pre-existing rows) and MUST be treated as
-- "nothing to verify" — never as "verified and empty". Replay skips verification
-- entirely when it is absent, so every existing row keeps its current behaviour.

ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS network_assertions JSONB;

COMMENT ON COLUMN public.intent_test_cases.network_assertions IS
  'Machine-checkable network expectations derived during exploration: TestAssertion[] of {type:"network", expect, source:{method, urlPattern, status}}. urlPattern is id-parameterized (/orders/:id) and verification compares STATUS FAMILY (2xx), so a per-run id or a 200->204 change cannot false-fail. NULL = no expectations recorded (manual/imported tests) and means "nothing to verify", NOT "verified empty". Test-case-level on purpose — not positional like steps_json. Capped at 8 entries by the producer (network-assertions.ts).';
