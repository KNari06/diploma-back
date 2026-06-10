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
| Scheduler | [src/scheduler/index.ts](src/scheduler/index.ts) | Cron + one-time triggers — enqueues regression runs. Local: own container. Prod: hosted in the worker behind a Redis leader lock (`SCHEDULER_IN_WORKER`, [leader.ts](src/scheduler/leader.ts)). |

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
| src/services/chat/ | Chat-side context + tracing: `editor-context.service.ts` (live page DOM/console/network → chat), `chat-test-trace.service.ts` (per-test-case chat JSONL trace → `test_logs/chat_test/`). | — |
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
…add/change a chat intent | `src/api/chat/<intent>/handler.ts` + register in `shared/handler-registry.ts` (map + descriptions) + routing message in `shared/routing.ts`
…resolve a descriptor ("payment tests","smoke") → test IDs | `src/services/testing/resolver/test-query-resolver.service.ts`; consumed via `shared/intent-target-resolution.ts`
…change request-understanding (ANALYZE/ENRICH/IMPROVE) | `src/ai/prompts/request-understanding-prompts.ts`
…add a chat management op (schedule/module/plan) | new `manage_*` intent calling `qa_manage_*` through `executeTool` (see `regression/shared/manage-tool.helper.ts`)
…add/change a yes-no / cancel / approval keyword (ru/en/kk) | `src/config/testing/intent-keywords.ts` (single source — NEVER inline a new list). Consumers: intent-fast-path, confirmation-classifier, compound-queue, manage-tool.helper. See Hard invariant #17.
…add/modify a BullMQ job | `src/jobs/<name>.job.ts` and register in `src/worker/index.ts`
…add a REST route | `src/api/<domain>/` (route + controller + service), wire in `src/index.ts`
…add a WS event | `src/websocket/handlers/<handler>.ts`. Preview events go in `preview.handler.ts`.
…run something on a schedule | `src/scheduler/`
…run AI agent (LiteEngine) | `src/agent/core/lite/lite-engine.ts` → `MultiAgentOrchestrator` in `agents/`
…run autonomous site exploration | `src/agent/core/lite/exploration/exploration-engine.ts`
…trace AI cost / token usage | `src/services/ai/cost/`, `src/services/ai/tracking/`
…work on the per-test-case ("AI Agent inside a test case") chat | `src/api/chat/chat.controller.ts` (testCaseId branch), `src/api/chat/general/handler.ts` (editor flow + trace), `src/services/chat/chat-test-trace.service.ts` — see Hard invariant #16
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
→ per-step screenshot after EVERY step (`captureStepScreenshot`, gated by `SCREENSHOT_EACH_STEP_ENABLED`, default ON) → `runtimeMeta.stepScreenshotUrl` (video/trace still record only on infra-retry)
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
→ per-step screenshots uploaded base64→URL (`uploadMobileStepScreenshots` in [step-screenshot.service.ts](src/services/storage/step-screenshot.service.ts), gated by `SCREENSHOT_EACH_STEP_ENABLED`) → `runtimeMeta.stepScreenshotUrl` + `metadata.steps[].screenshot`
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
Scheduler bundle ticks every 60s (the `TestSchedulerJobHandler` loop)
→ `processSchedules()` → `claimDueSchedule()` (atomic)
→ routes to `RegressionRunService.runPlan() | runModule() | runFlow()`
→ same web / mobile branches as above.

**Where the bundle runs:** local docker-compose runs a dedicated `scheduler` container ([src/scheduler/index.ts](src/scheduler/index.ts)). In prod the SAME bundle runs INSIDE the worker process, gated by `SCHEDULER_IN_WORKER=true` and a Redis **leader lock** ([src/scheduler/leader.ts](src/scheduler/leader.ts), key `${QUEUE_PREFIX}scheduler:leader`, 90s TTL / 30s refresh; acquire = `SET NX EX`, renew/release = atomic Lua compare-and-expire / compare-and-del) so one worker replica runs it at N>1. Guarantee is at-most-one in steady state, not hard mutex (a >90s leader stall opens a ≤30s double-run window, bounded because the sweeps are idempotent and schedule claims are atomic). Default OFF, so the two never fight; the lock is the backstop if both ever run against one Redis.

**Schedule types:** a `test_schedules` row is either **recurring** (`schedule_type='recurring'`, a 5-field `cron_expression` + `timezone`; `claimDueSchedule` advances `next_run_at` to the next occurrence) or **one_time** (`schedule_type='one_time'`, an absolute `run_at`; `claimDueSchedule` fires once then flips `is_active=false`). Due-detection is identical for both (`next_run_at <= NOW()`); only the claim/advance step differs. Create/update accept exactly one of `cronExpression` or `runAt` ([schedule.service.ts](src/services/testing/schedules/schedule.service.ts), [schedules.controller.ts](src/api/schedules/schedules.controller.ts), `qa_manage_schedule`).

Also in the scheduler bundle (24h sweeps, single-instance — now guarded by the leader lock when hosted in the worker): `ArtifactRetentionJob` ([artifact-retention.job.ts](src/jobs/artifact-retention.job.ts)) prunes `${userId}/step-screenshots/...` older than `SCREENSHOT_RETENTION_DAYS`. Per-step screenshot knobs live in [env.ts](src/config/environment/env.ts) / [config/features/screenshot-capture.ts](src/config/features/screenshot-capture.ts): `SCREENSHOT_EACH_STEP_ENABLED` (default ON), `SCREENSHOT_FORMAT` (`webp`/`jpeg`), `SCREENSHOT_QUALITY`, `SCREENSHOT_RETENTION_DAYS`. Final/bug screenshots (`${userId}/screenshots/...`) are a SEPARATE prefix the retention job never touches.

### Chat → test creation / management (intent-driven router)
POST `/api/chat/message` → `handleChat()` ([src/api/chat/chat.controller.ts](src/api/chat/chat.controller.ts))
→ pending-state interceptors (run BEFORE parsing, global chat only):
   exploration-confirm → manage-confirm ([regression/shared/manage-confirmation.ts](src/api/chat/regression/shared/manage-confirmation.ts)) → compound-continuation ([shared/compound-queue.ts](src/api/chat/shared/compound-queue.ts))
→ `parseUserIntent()` ([src/services/ai/intent/intent-parser.service.ts](src/services/ai/intent/intent-parser.service.ts)) — one LLM call now ALSO returns an `analysis` block
   (ANALYZE + IMPROVE folded in, see [src/ai/prompts/request-understanding-prompts.ts](src/ai/prompts/request-understanding-prompts.ts)):
   `targetSelector{type,value}` (descriptor), `executionModifiers{browser,…}`, `isCompound/subRequests`, `manage{…}`, `lookbackDays`.
→ post-parse enrichment ([shared/intent-target-resolution.ts](src/api/chat/shared/intent-target-resolution.ts)):
   `TestQueryResolver` resolves a descriptor → concrete IDs ([src/services/testing/resolver/test-query-resolver.service.ts](src/services/testing/resolver/test-query-resolver.service.ts));
   on ambiguity, a conditional 2nd LLM call (ENRICH) narrows candidates.
→ compound splitter (if `isCompound`): run step 1, queue the rest; advance-after-success per turn.
→ `routeToHandler()` ([shared/routing.ts](src/api/chat/shared/routing.ts)) → handler from `INTENT_HANDLERS` registry.

**Intents (23)** in [shared/handler-registry.ts](src/api/chat/shared/handler-registry.ts): platform_test, api_test, api_flow_test,
general_chat, needs_clarification, save_test, run_regression, run_plan, run_module, run_by_tag, create_plan,
add_to_plan, analyze_failure, test_recommendations, coverage_analysis, editor_action, mobile_test, mobile_action,
mobile_agent, **flaky_report, manage_schedule, manage_module, manage_plan** (the last 4 added in the management phase;
they call existing `qa_manage_*` tools through `executeTool`, not the SubAgentPipeline).

### Self-serve "magic first test" (PLG, gated by `AUTO_APPROVE_SIGNUP`)
Sign up → first auth (`verifyEmail` / `completeOAuthHandler` in [auth.controller.ts](src/api/auth/auth.controller.ts))
→ `SelfServeProvisioningService.provision()` ([self-serve-provisioning.service.ts](src/services/core/self-serve-provisioning.service.ts)) — approve user + create workspace+project + grant trial credits/plan (no-op unless flag on; never throws)
→ POST `/api/v1/explorations/start` ([explorations.controller.ts](src/api/explorations/explorations.controller.ts)) `{ url, projectId?, preset? }`, gated by `requireApproved` + `requireCredits`
→ validate URL + IDOR-guard projectId → `QueueManager.addExplorationJob()` on the `'quick'` budget preset (~2 min, [types.ts](src/agent/core/lite/exploration/types.ts) `EXPLORATION_PRESETS`)
→ returns `202 { explorationId }` → poll GET `/api/v1/explorations/:id` for discovered test cases → one-click `POST /:id/run-discovered`.

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
13. **Chat write/management ops go through `executeTool`, never the raw skill or a hand-rolled confirm.** The `manage_*` intent handlers call `qa_manage_*` via `executeTool` ([src/services/skills/tool-executor.ts](src/services/skills/tool-executor.ts)) so the centralized confirm-preview guard (in `SkillRegistry`, keyed `sessionId:toolName`), loop-detection, retry, and timeout all apply. Two-phase confirm is deterministic: turn 1 → `confirm:false` (preview, op cached in Redis via [manage-confirmation.ts](src/api/chat/regression/shared/manage-confirmation.ts)), turn 2 "yes" → re-run the SAME cached args with `confirm:true`. Never write on the first turn; never echo the tool's LLM-targeted "WRITE operation requires confirmation" message to the user (surface a human preview instead).
14. **Chat pending-state (manage-confirm / compound-queue) is Redis-keyed by `chatSessionId` ONLY (no userId fallback) and MUST be cleared on cancel + error.** A userId fallback leaks a pending flow across the user's other sessions. `/chat/cancel` and the controller's error path both call `clearPendingCompound`. The compound splitter advances **after** a step succeeds — never before (a clarification/confirm answer must retry the same step, not drive the next one).
15. **Unicode word boundaries: use `(?![\p{L}\p{N}])`, never `\b`, for affirmative/cancel/keyword regex.** JS `\b` is ASCII-only, so `\bда\b` / `\bхватит\b` never match Cyrillic. This bit the confirmation classifier and the compound cancel-phrase regex; both now use the unicode lookahead.
16. **Per-test-case chat (`testCaseId` present) is the editor surface — three rules hold together.** (a) **Exclusive WS routing:** `emitChatMessage`/`emitChatProcessingStep`/`emitChatTestUpdate` with a `testCaseId` route ONLY to `chat:tc:<testCaseId>`, never also to `chat:<sessionId>` ([websocket.service.ts](src/websocket/core/websocket.service.ts)); `subscribe:chat:testcase` joins ONLY that room (never `chat:<sid>`). Both global and editor `Chat` share ONE socket, so emitting an editor event to `chat:<sid>` would surface it in the global chat. The frontend filter is the second guard: a global chat accepts a `chat:*` event only when `event.sessionId` matches its live ref OR the pending `localStorage` id (first-message window) — an event with another sessionId is dropped ([homeSocketBindings.ts](../qai-frontend/apps/desktop/src/renderer/app/home/realtime/homeSocketBindings.ts)). (b) **mode is forced to `'editor'`** in the controller for tc-scope ([chat.controller.ts](src/api/chat/chat.controller.ts)) so the executor's editor flow (generate steps → confirm → run on preview → save) activates; the lite/pro toggle is a global-chat concept and must never reach a tc-chat. (c) **Scope-awareness:** `testCaseId`/`testCaseName` are threaded into `buildExecutorPrompt` + a system-prompt TEST-CASE SCOPE block so "save/update" edits THIS test case (`qa_update_test_case_steps`), not a duplicate (`qa_create_test_case`). Trace for analysis: `ChatTestTraceService` → `test_logs/chat_test/` (best-effort, scrubs `{{secrets.*}}`/inline creds, TTL-evicted).
17. **Chat control-word lists (affirmative / cancel / rejection / chitchat / confirmation-markers) live ONLY in [intent-keywords.ts](src/config/testing/intent-keywords.ts) — never inline.** They were duplicated across four call sites (intent-fast-path, confirmation-classifier, compound-queue, manage-tool.helper) and Kazakh kept getting forgotten. The `MultiLangList` type makes `{en,ru,kk}` REQUIRED (build fails if a language is dropped); a contract test asserts anchors + unicode-boundary behavior. These lists are an **optimization + regex fallback, NOT the classifier** — the LLM (`parseUserIntent` GPT pass / Gemini→OpenAI in confirmation-classifier) is the language-agnostic source of truth and covers the long tail. Keep buckets to high-frequency anchor forms; do not chase completeness. Build regexes via `toBoundaryRegex` (unicode `(?![\p{L}\p{N}])`, never ASCII `\b` — see #15). Note: this is the chat-intent control-word registry; DOM/element-text keyword lists (submit/close/destructive matched in `page.evaluate`) stay local to their services by design.

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
