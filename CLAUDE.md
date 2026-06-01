# QAIT Backend — Navigation Map

> Read this first. Use it to find which directory to open, then read that directory's `CLAUDE.md`.
> Don't grep blindly across `src/` — go through the map.

**Stack:** Express + TypeScript + Playwright + OpenAI/Gemini + Supabase + BullMQ (Redis) + Socket.IO
**Scale:** ~765 TS files. 3 processes (api, worker, scheduler). 11 BullMQ job types. 50+ REST routes. ~140 WS events.

---

## Three processes

| Process | Entry | Purpose |
|---|---|---|
| API | [src/index.ts](src/index.ts) | HTTP + Socket.IO server. Owns preview sessions (live browsers). |
| Worker | [src/worker/index.ts](src/worker/index.ts) | BullMQ consumer. Runs all background jobs (replay, AI analysis, exploration). |
| Scheduler | [src/scheduler/index.ts](src/scheduler/index.ts) | Cron triggers — enqueues regression runs. |

Run: `npm run dev` (API), `npm run worker`, `npm run scheduler`.

---

## Top-level map of `src/`

| Folder | What's in there | Has own CLAUDE.md |
|---|---|---|
| [src/services/testing/ui/preview/](src/services/testing/ui/preview/) | **Editor / Preview / Recording / Replay.** The hot zone. | ✅ |
| [src/agent/core/lite/](src/agent/core/lite/) | LiteEngine + 5 multi-agents + Pipeline v2 + Exploration v2. | ⏳ TODO |
| [src/services/ai/](src/services/ai/) | LLM clients (OpenAI/Gemini), prompts, intent parser, cost tracking, embeddings, memory. | ⏳ TODO |
| [src/ai/prompts/](src/ai/prompts/) | All prompt builders. Intent, chat, test plan, API flow, intelligent testing. | ⏳ TODO |
| [src/jobs/](src/jobs/) | BullMQ job handlers (11 types). | ⏳ TODO |
| [src/api/](src/api/) | 50+ REST controllers, grouped by domain. | ⏳ TODO |
| [src/websocket/](src/websocket/) | Socket.IO server + handlers. Most events live in `handlers/preview.handler.ts`. | ⏳ TODO |
| [src/services/testing/](src/services/testing/) | Non-preview testing services (regression, plans, results, executions, fixtures, exploration). | — |
| [src/services/test-resource/](src/services/test-resource/) | Polymorphic test resources — `auth` (logins), `environment`, `secret` adapters live here; `data_fixture` queued. | ✅ |
| [src/services/kb/](src/services/kb/) | Knowledge base (skills, patterns) for auto-learn. | — |
| [src/services/skills/](src/services/skills/) | Skill registry — composable test capabilities. | — |
| src/services/mobile/ | Mobile runner integration (scrcpy, redroid, a11y agent). | — |
| src/services/integrations/ | Jira, Stripe, Telegram, Allure, Git webhooks. | — |
| [src/config/](src/config/) | AI model config, queues, env, features, testing knobs. | — |
| [src/db/](src/db/) | Supabase client + helpers. Schema lives in `supabase-migrations/`. | — |
| [src/middleware/](src/middleware/) | Auth, rate limiting, request logging, error handler. | — |
| src/utils/ | Helpers — only put truly reusable cross-domain code here. | — |
| src/types/ | Shared types not bound to a single feature. | — |

**Rule of thumb:** if a folder has a `CLAUDE.md`, read it before working in that folder. If it doesn't and there are >8 files, ask whether to create one.

---

## Where things live (cheat sheet)

When you need to… | Open
---|---
…understand preview/replay/recording/auto-healing | [src/services/testing/ui/preview/CLAUDE.md](src/services/testing/ui/preview/CLAUDE.md)
…add a new resource kind (env/secret/fixture/...) | [src/services/test-resource/CLAUDE.md](src/services/test-resource/CLAUDE.md)
…change LLM behaviour for element resolution | `preview/element-resolver.service.ts`, `preview/intent-step-lint.service.ts`
…change a prompt | `src/ai/prompts/*.ts`
…add/modify a BullMQ job | `src/jobs/<name>.job.ts` and register in `src/worker/index.ts`
…add a REST route | `src/api/<domain>/` (route + controller + service), wire in `src/index.ts`
…add a WS event | `src/websocket/handlers/<handler>.ts`. Preview events go in `preview.handler.ts`.
…run something on a schedule | `src/scheduler/`
…run AI agent (LiteEngine) | `src/agent/core/lite/lite-engine.ts` → `MultiAgentOrchestrator` in `agents/`
…run autonomous site exploration | `src/agent/core/lite/exploration/exploration-engine.ts`
…trace AI cost / token usage | `src/services/ai/cost/`, `src/services/ai/tracking/`
…check DB schema | `supabase-migrations/supabase-schema.sql`

---

## Hot flows (entry → exit)

### Recording (user records actions in live editor)
WS `preview:keyboard:type` / `preview:mouse:click`
→ [preview.handler.ts](src/websocket/handlers/preview.handler.ts)
→ `RecordingCaptureService.captureStep()` ([recording-capture.service.ts](src/services/testing/ui/preview/recording-capture.service.ts))
→ emit `preview:recording:step:capture`
→ DB persist (batched).

### Apply single step in live preview
WS `preview:step:apply`
→ `PreviewStepApplyService.applyStep()` ([preview-step-apply.service.ts](src/services/testing/ui/preview/preview-step-apply.service.ts))
→ `LocatorPlanBuilder` → `waitForStepReadiness()` → Playwright action
→ `ElementResolver` (LLM fallback) if compiled plan missed
→ emit `preview:step:apply:result`.

### Apply All / Run from start (live preview)
WS `preview:run:start`
→ `PreviewRunService.runSavedSteps()` ([preview-run.service.ts](src/services/testing/ui/preview/preview-run.service.ts))
→ stops recording → loop `applyStep()` → emits progress
→ `preview:run:complete`.

### Background replay (regression / scheduled) — web
POST `/api/v1/regression/run` or `/run-plan`
→ `RegressionRunService.runSavedTestCase()` / `runPlan()` ([regression-run.service.ts](src/services/testing/regression/regression-run.service.ts))
→ INSERT `regression_runs` + `tests` + `test_executions`
→ BullMQ enqueue
→ [manual-test-run.job.ts](src/jobs/manual-test-run.job.ts)
→ `executePlaywrightTestWithRetry()` (fresh browser, NOT preview session)
→ post-run [ai-analysis.job.ts](src/jobs/ai-analysis.job.ts) → bug detection.

### Background replay (regression / scheduled) — mobile
Same entry as web; routing diverges at `dispatchMobileTest()`.
POST `/api/v1/regression/run` or `/run-plan`
→ `RegressionRunService.runSavedTestCase()` → branch on `intent_test_cases.platform.startsWith('mobile_')`
→ **Phase 4 (May 2026)** `decideMaxMobileInFlight()` ([concurrency-decision.ts](src/services/testing/regression/concurrency-decision.ts)) chooses the run's in-flight cap from `REGRESSION_MOBILE_MAX_CONCURRENCY` + live runner pool capacity + test count. Falls back to cap=1 (serial) on any failure path. Logged as `[REGRESSION_RUN] Mobile concurrency decided`.
→ `dispatchMobileTest()` ([regression-run.service.ts:566+](src/services/testing/regression/regression-run.service.ts))
→ INSERT `regression_runs` + `tests` + `test_executions`
→ `QueueManager.addMobileTestJob()` (BullMQ producer)
→ [mobile-test-run.job.ts](src/jobs/mobile-test-run.job.ts) — `MobileTestRunJobHandler.process()`
→ `MobileRunnerClient.runSteps(sessionId, intentSteps, { screenshotEachStep:true })` (REST to qait-mobile-runner)
→ runner returns `RunStepsResult` per-step with screenshot + evidence
→ `persistCompiledPlansFromRun()` writes compiled plans back to `intent_test_cases.steps_json`
→ `createTestResult()` inserts into `test_results` with aggregated stats
→ **Phase 2 telemetry** ([20260516_mobile_telemetry.sql](supabase-migrations/20260516_mobile_telemetry.sql)): per-test wallclock (`app_setup_ms`, `scenario_steps_ms`, `test_steps_ms`, `session_claim_ms`, `cold_start_used`) written into `test_executions` in `mobile-test-run.job.ts` finally block; aggregated into `regression_runs.total_*` by `TestCompletionHandlerService.recomputeRunStatus()` at run finalisation. Best-effort, NEVER fails the test path.
→ post-run [ai-analysis.job.ts](src/jobs/ai-analysis.job.ts) → bug detection.

**Mobile regression diverges from web in five ways:** (1) batch RPC (`runSteps`)
not per-step apply; (2) hardcoded `screenshotEachStep: true`; (3) NO heal layer
above the runner — mobile relies solely on the runner's per-step retry +
stabilization-retry tail; (4) compiled-plan persistence happens explicitly via
`persistCompiledPlansFromRun()` (web persists differently); (5) sessions claimed
from a runner-side pool (warmup → cold-start fallback) and released in the
finally block. See `mobile-test-run.job.ts` for the full lifecycle.

### Scheduled cron
`src/scheduler/index.ts` ticks every 60s
→ `TestSchedulerJobHandler.processSchedules()` → `claimDueSchedule()` (atomic)
→ routes to `RegressionRunService.runPlan() | runModule() | runFlow()`
→ same web / mobile branches as above.

### Chat → test creation
POST `/api/chat/message`
→ `IntentParserService.parse()` ([src/services/ai/intent/](src/services/ai/intent/))
→ routing in `src/api/chat/shared/routing.ts`
→ creates intent test case / api test / general chat reply.

---

## Hard invariants (do not violate)

These are codified across the codebase. Also see [.claude/rules/critical-patterns.md](.claude/rules/critical-patterns.md) for the long form.

1. **Never reuse the screencast CDP session in preview.** Piggybacking on the `video-stream` session causes 100% video freeze. In preview contexts, `CdpSnapshotService` opens its own session and detaches in `finally` — that is safe. In background/regression contexts `context.newCDPSession(page)` is always fine. For DevTools outside Etap 2, prefer Playwright built-ins (`page.accessibility.snapshot()`, `page.content()`). See [critical-patterns.md](.claude/rules/critical-patterns.md) section 2 for the full trade-off.
2. **WebSocket handlers must always emit a response.** Silent `return` = frontend stuck on "Loading…" forever. Even on error paths.
3. **Recording and step apply are mutually exclusive in a preview session.** Recording auto-stops when a run starts (`PreviewRunService.isRunning()` guard).
4. **Replay path uses `waitUntil: 'load'`, never `'domcontentloaded'`.** Different timing semantics — don't mix.
5. **OpenAI role mapping:** DB stores `'ai'`, OpenAI requires `'assistant'`. Always pass through `convertRoleForOpenAI()` from `utils/helpers/chat-helpers`.
6. **CSS selector escaping:** use `CSS.escape()` when interpolating IDs (React 18 `useId()` produces colons that break selectors).
7. **Element resolution is a 3-stage waterfall:** compiled plan → LLM resolver → smart locator. Never skip a stage.
8. **DRY before writing new logic:** `rg "<thing>" src/ --type ts` first. There's a high chance it already exists.
9. **`{{key}}` interpolation goes through `resolvePlaceholders`** ([src/utils/interpolation/resolve-placeholders.ts](src/utils/interpolation/resolve-placeholders.ts)). Three call sites used to do the same `.replace(/\{\{…\}\}/g, …)` against different source maps; that divergence is gone. New variable sources (env / secret / data_fixture / future kinds) are added by passing one more `VariableSource` to the helper, never by writing another regex. Selectors / `elementDescription` are intentionally NOT interpolated — keep it that way.
10. **Anywhere that EMITS, LOGS, or PERSISTS a step body after interpolation must redact `secrets.*` values.** Helpers: `resolvePlaceholders` (substitution) is paired with `redactSecrets` / `buildStepRedactor` ([src/utils/interpolation/redact-step.ts](src/utils/interpolation/redact-step.ts)) and `executor.redactString` / `executor.redactRuntimeMeta` (for background replay). When you add a new sink (WS event, JSONL writer, DB column, third-party API call, LLM prompt) carrying interpolated `value`/`url`/`assertionText`/`description`, run it through one of these. **DB persistence is the special case:** store the original `{{...}}` placeholder, not the resolved value (see `preserveOriginalStep` in `preview-run.service.ts`). Otherwise re-runs see a stale literal forever.
11. **Telemetry writes are best-effort — NEVER fail the test path.** Phase 2 (May 2026) instrumentation writes per-test wallclock to `test_executions` and per-run aggregates to `regression_runs`. Every write is wrapped in try/catch that `logger.warn`s and swallows. A row that's missing analytics columns is a degraded audit trail, NOT a failed test. New telemetry sinks added by anyone MUST follow the same pattern. Single funnel for the per-run aggregation: `TestCompletionHandlerService.recomputeRunStatus()` — no other code path may write to `regression_runs.total_*_ms` columns.
12. **Step persistence (`tests.executed_steps`) is owned by the PRODUCER, in-process.** Whoever runs the test appends each step to the Redis buffer via `TestExecutedStepsRedisService.appendStepCompleted` in its own process — `test-executor.ts` (background replay + lite) and `mobile-test-run.job.ts`. The worker then drains the buffer to Postgres via `finalizeToDb` in the job's `finally` ([manual-test-run.job.ts](src/jobs/manual-test-run.job.ts), [mobile-test-run.job.ts](src/jobs/mobile-test-run.job.ts)). `webSocketService.emitTestStepCompleted` is **broadcast-only** — do NOT re-add an `appendStepCompleted` call there: it would only fire on the main process via a pub/sub re-emit (racy / absent for background runs) AND double-count the producer's append. The report assembler collapses duplicate step indices (keep-last) as a safety net, but the contract is one in-process append per step.

---

## Memory vs CLAUDE.md split

- **CLAUDE.md** (this file + per-module ones) = facts about the **code**. Kept next to the code, evolves with PRs.
- **`~/.claude/projects/.../memory/`** = facts about the **user, project history, incidents, preferences**. Long-term, cross-session.

If you find code-shaped knowledge in memory (e.g. "Key Files", "Data Flow"), it belongs here, not there.

---

## When you change code, update the map

If a change is significant enough that future-you would want to know about it, update the relevant CLAUDE.md in the same PR. See [.claude/rules/structure.md](.claude/rules/structure.md) for what counts as significant.

Quick checklist:
- New top-level service or class in a hot folder → add a row in that folder's `CLAUDE.md` file table.
- New WS event or REST route → update the relevant flow section.
- New invariant ("never do X here") → add to the folder's CLAUDE.md "Invariants" section, or to this file's "Hard invariants" if it's project-wide.
- Renamed/moved/deleted a file mentioned in any CLAUDE.md → update or remove the reference.

---

## Architecture

See [.claude/rules/architecture.md](.claude/rules/architecture.md) — layer breakdown, `db/` sublayer contract, dependency direction, file size rules.

See [.claude/rules/testing.md](.claude/rules/testing.md) — mock boundary, what to test and where, file placement, naming.

---

## Pre-commit checks

```bash
npm run type-check
npm run lint
```

Don't deploy without explicit approval. See [.claude/rules/general.md](.claude/rules/general.md).
