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

Negatives run web-only: `expandNegatives` / `getEnabledTestCaseIds` skip `testType !== 'ui'`. The frontend hides the "Negative tests" checkbox for mobile/api items (qai-frontend `CreateRegressionDialog.jsx`, `ScopeTab.jsx`). The generated `ai_check` assertion step MUST carry `assertionText` (both executors require it; `value`/`description` are not a fallback) — unit-tested in `negative/__tests__/`.

**Per-negative control (June 2026).** A negative is RUNNABLE iff `negative_stale_reason IS NULL AND negative_enabled = TRUE` (column added in `20260610_intent_test_cases_negative_enabled.sql`; `getFreshNegativesBySources` enforces both). Endpoints (all under `/api/v1/regression`, thin controllers → `NegativeGenerationService`):
- `GET /plans/:id/negatives/estimate` — pre-run `{pendingSources, estimatedNegatives, estimatedMinutes}` (avg from parents' `test_executions.duration_ms`, fallback 45s).
- `POST /plans/:id/sources/:testCaseId/regenerate-negatives` — delete + regenerate, under a per-source mutex (`withSourceMutex`) shared with the job's `generateForSourceGuarded` so they never double-generate.
- `PATCH /negatives/:id` `{enabled}` and `DELETE /negatives/:id` — per-negative toggle/delete.

Per-negative + regenerate routes are NOT plan-scoped, so they authorize via project access (owner OR workspace member, `hasProjectAccess` mirroring `RegressionRunService`), not bare `user_id`. Frontend: `NegativeTestsPanel.jsx` (prominent toggle + plan estimate + inline preview with per-item enable/delete + regenerate); ScopeTab fetches the negatives list once and passes slices down.
