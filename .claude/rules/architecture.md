---
description: Architecture rules — layer breakdown, dependency direction, file size
alwaysApply: true
---

# Architecture Rules

## Layer breakdown

```
src/api/<domain>/           → HTTP only: parse request, call service, return response
src/services/<domain>/      → business logic, orchestration
src/services/<domain>/db/   → Supabase queries for this domain — no logic, no orchestration
src/jobs/                   → thin BullMQ handlers, delegate immediately to services
```

The domain-oriented folder structure is correct. What must be enforced is the `db/` sublayer within each domain.

## Dependency direction

```
Routes → Services → db/ sublayer → Supabase client
```

**Never:**
- Services import from `../../db/supabase` directly — go through `./db/`
- `db/` files contain business logic or call other services
- Route files call Supabase directly
- Job handlers contain domain logic — extract to a service

## The db/ sublayer

When adding Supabase queries to a service:
- Queries go in `src/services/<domain>/db/<domain>.db.ts`
- The service imports from `./db/`, never from `src/db/supabase` directly
- `db/` files: queries + row-to-type mapping only

This is what enables unit testing services without a real database.

## File size

- Service files over ~400 lines → one service is doing two jobs → split by responsibility
- Route files over ~150 lines → extract controller logic to service
- Never add to an oversized file — always split first

## When touching existing services that violate these rules

Extract the concern you're working on, don't perpetuate the violation. If a service directly queries Supabase, extract those queries to a `db/` file as part of your change.

## First db/ sublayer in production: regression pipeline

`src/services/testing/regression/db/` is the first domain that follows this rule:

| File | What it holds |
|---|---|
| `regression-test-query.db.ts` | Test-case / module / flow resolution reads (test cases, depends_on, step counts, module+flow access, tag/priority filters) |
| `regression.db.ts` | Query functions for priority resolver, web builder, save service, mobile dispatcher, project access, and workspace-member resolution |
| `regression-report.db.ts` | Run-report read queries (run lookup, batch enrichment of names / results / steps / negative-meta / phase-info) for `regression-report-assembler.service.ts` |
| `regression-run.db.ts` | Shared `regression_runs` / `test_executions` reads + writes (routing info, execution-ref preload, fast-auth telemetry, run insert, patch/finalize, zombie sweep, run listing) for the orchestrator and run service |

All three regression services (`regression-report-assembler.service.ts`,
`test-execution-orchestrator.service.ts`, `regression-run.service.ts`) now go
through `./db/` — none imports `supabaseAdmin` directly, and each is unit-tested.
This is the reference example for the `db/` sublayer pattern across the codebase.

## Negative-test domain (second db/ example)

`src/services/testing/negative/` follows the same rule:

| File | What it holds |
|---|---|
| `db/negative.db.ts` | All `intent_test_cases` reads/writes (source load, negative insert/delete/count/list) + `regression_plan_items` toggle read/update for the negative feature |
| `negative-test-generator.service.ts` | AI mutation generation → builds negative `intent_test_cases` (one `ai_check` step per negative; `assertionText` is REQUIRED — see below). Uses server-owned canonical payloads for xss/overflow (`fuzzing-config.ts`), not LLM-invented values |
| `negative-generation.service.ts` | Plan-scoped orchestration the controller used to inline (toggle / dispatch / list / status). Routes are thin |
| `negative-toggle-resolver.service.ts` (in `plans/`) | Toggle inheritance test_case → flow → module; reads plan items via `negative.db.ts` |

Negatives run on web AND mobile (NOT api): `expandNegatives` / `getEnabledTestCaseIds` skip only `testType !== 'ui'` — and mobile test cases ARE `testType:'ui'` (platform distinguishes web vs mobile), so they qualify. The generated `ai_check` assertion step MUST carry `assertionText` (both executors require it; `value`/`description` are not a fallback) — unit-tested in `negative/__tests__/`.

**Mobile negatives — the negative row inherits the source's identity.** `getSourceTestCase` loads, and `insertNegativeTestCase` copies, `platform` + `replay_strategy` + `parameters_schema` + `resource_bindings` + `mobile_variant_label` + `triggers` from the source onto the negative; `expandNegatives` copies the parent's `platform` onto the `ExpandedTestCase`. Without these a mobile negative dispatches as web (no `platform` → `!startsWith('mobile_')`) OR fails on SETUP (unresolved `{{param_*}}`, missing login `resource_bindings`, wrong app build) instead of on the mutation. `replay_strategy` is inherited, NOT the old hardcoded `'steps_json'` (not a valid CHECK value). `depends_on` is intentionally NOT copied — mobile ignores it (web-only precondition inlining). For mobile the trailing `ai_check` uses `options.aiCheckSource:'tree'` (runner → `ai_visual_check`); web uses `options.aiContextMode:'html+a11y'`. The generator drops a value-mutation that targets a non-input step type (mobile `open_app`/`swipe`/`permission`, or a click) — only `type`/`fill`/`select`/`check`/`uncheck` are value-mutable; `double_submit` only on click-class. Generation uses `AI_TASK_MODELS.negativeGeneration` (smart tier, env `OPENAI_MODEL_NEGATIVE_GEN`) and is paid-gated when any enabled source is mobile (mobile RUNS are Pro-only). The per-source generation lock is Redis-backed (`SET NX EX` + compare-and-del) so the API `regenerate` and the worker job don't double-generate across processes; a busy lock → `regenerate` returns `busy` (HTTP 409), the job treats it as `skipped`.

**Negatives MUST set `expectedOutcome:'error'` on the mutated step.** `buildNegativeSteps` marks the mutated value/submit step (and the duplicate for `double_submit`, and the trailing `ai_check`) with `expectedOutcome:'error'`. The converter forwards this to `command.intentMeta.expectedOutcome` and the replay executor's 4xx branch ([test-executor.ts](../../src/agent/playwright/core/test-executor.ts) ~line 1114) treats a same-origin validation 4xx as a PASS. Without it the flag defaults to `'success'`, so an app that CORRECTLY rejects the bad input flips `allSuccess=false` and the negative fails for the wrong reason (inverted pass/fail). Note: the `aiCheck` command path itself does NOT yet invert on `expectedOutcome` — it only verifies `assertionText`, so write `expectedBehavior` to describe the error state ("shows validation error"), not the happy path.

**Per-negative control (June 2026).** A negative is RUNNABLE iff `negative_stale_reason IS NULL AND negative_enabled = TRUE` (column added in `20260610_intent_test_cases_negative_enabled.sql`; `getFreshNegativesBySources` enforces both). Endpoints (all under `/api/v1/regression`, thin controllers → `NegativeGenerationService`):
- `GET /plans/:id/negatives/estimate` — pre-run `{pendingSources, estimatedNegatives, estimatedMinutes}` (avg from parents' `test_executions.duration_ms`, fallback 45s).
- `POST /plans/:id/sources/:testCaseId/regenerate-negatives` — delete + regenerate, under a per-source mutex (`withSourceMutex`) shared with the job's `generateForSourceGuarded` so they never double-generate.
- `PATCH /negatives/:id` `{enabled}` and `DELETE /negatives/:id` — per-negative toggle/delete.

Per-negative + regenerate routes are NOT plan-scoped, so they authorize via project access (owner OR workspace member, `hasProjectAccess` mirroring `RegressionRunService`), not bare `user_id`. Frontend: `NegativeTestsPanel.jsx` (prominent toggle + plan estimate + inline preview with per-item enable/delete + regenerate); ScopeTab fetches the negatives list once and passes slices down.

## Preview / intent-test-case domain (third db/ example)

`src/services/testing/ui/preview/` follows the same rule for its CRUD service:

| File | What it holds |
|---|---|
| `db/intent-test-case.db.ts` | All `intent_test_cases` reads/writes (create / owner-scoped get / internal get / project list + count / dependency-closure + name resolution / steps_json read+write / owner update / delete / mark-negatives-stale) plus the `projects.workspace_id` access-check read and the `regression_plan_items` cleanup delete. Query-builder factories — each returns the awaitable Supabase query, so the service keeps its existing error-handling, logging, and merge logic |
| `intent-test-case.service.ts` | Orchestration only: precondition DFS, the V16/V27 step-merge + compiled-plan invalidation, the `canWriteTestCase` access gate (owner OR workspace member), cache invalidation, and row → `IntentTestCase` mapping (`mapToIntentTestCase`). No `supabaseAdmin` import |

## Regression Doctor domain (fourth db/ example)

`src/services/regression-doctor/` splits its queries by direction, because the
read and write paths have no query in common and different lifetimes — one runs
in a background job, the other behind a user click:

| File | What it holds |
|---|---|
| `db/regression-doctor.db.ts` | READ path for analysis: failed executions of a run (`test_executions`, which is the only table linking a run to BOTH the execution and the authored `test_case_id`), the `tests.executed_steps` trace, authored test cases, Bug Inspector summaries from both results tables, and the finding INSERT |
| `db/regression-doctor-apply.db.ts` | WRITE path: finding load, `steps_json` optimistic write (`updated_at` gate, reports rows written), snapshot insert/delete, finding status flips, negatives-stale reuse |
| `failed-step-collector.ts` | Run → "this step of this test case broke": first failing step per failed test, matched to `steps_json` by id only, with the finalize-race retry and the injected-id guards |
| `step-fix-agent.ts` / `step-fix-prompt.ts` / `screenshot-inline.ts` | One LLM call per failing step: the call + validation, the prompt, and the screenshot inlining respectively |
| `patch-applier.ts` | Pure steps-in/steps-out patching for the three actions, including the `bindingHints` + `compiled` invalidation that makes a fix take effect at replay |

**`tests` has no `intent_test_case_id`.** The run → authored-case link is
`test_executions.test_case_id`; the executed test's id lives inside
`test_executions.result->>'testId'`. The Doctor's first implementation selected
`tests(intent_test_case_id)` and therefore threw on its first query.
