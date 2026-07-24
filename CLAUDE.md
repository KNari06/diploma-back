# QAIT Backend — Navigation Map

> Read this first. Use it to find which directory to open, then read that directory's `CLAUDE.md`.
> Don't grep blindly across `src/` — go through the map.

**Stack:** Express + TypeScript + Playwright + OpenAI/Gemini + Supabase + BullMQ (Redis) + Socket.IO
**Scale:** ~765 TS files. 3 processes (api, worker, scheduler). 11 BullMQ job types. 50+ REST routes. ~140 WS events.

---

## Three processes

| Process   | Entry                                            | Purpose                                                                                                                                                                                         |
| --------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API       | [src/index.ts](src/index.ts)                     | HTTP + Socket.IO server. Owns preview sessions (live browsers).                                                                                                                                 |
| Worker    | [src/worker/index.ts](src/worker/index.ts)       | BullMQ consumer. Runs all background jobs (replay, AI analysis, exploration).                                                                                                                   |
| Scheduler | [src/scheduler/index.ts](src/scheduler/index.ts) | Cron + one-time triggers — enqueues regression runs. Local: own container. Prod: hosted in the worker behind a Redis leader lock (`SCHEDULER_IN_WORKER`, [leader.ts](src/scheduler/leader.ts)). |

Run: `npm run dev` (API), `npm run worker`, `npm run scheduler`.

---

## Top-level map of `src/`

| Folder                                                               | What's in there                                                                                                                                                                          | Has own CLAUDE.md |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [src/services/testing/ui/preview/](src/services/testing/ui/preview/) | **Editor / Preview / Recording / Replay.** The hot zone.                                                                                                                                 | ✅                |
| [src/agent/core/lite/](src/agent/core/lite/)                         | LiteEngine + 5 multi-agents + Pipeline v2 + Exploration v2.                                                                                                                              | ✅ (starter)      |
| [src/services/ai/](src/services/ai/)                                 | LLM clients (OpenAI/Gemini), prompts, intent parser, cost tracking, embeddings, memory.                                                                                                  | ⏳ TODO           |
| [src/ai/prompts/](src/ai/prompts/)                                   | All prompt builders. Intent, chat, test plan, API flow, intelligent testing.                                                                                                             | ⏳ TODO           |
| [src/jobs/](src/jobs/)                                               | BullMQ job handlers (11 types).                                                                                                                                                          | ⏳ TODO           |
| [src/api/](src/api/)                                                 | 50+ REST controllers, grouped by domain.                                                                                                                                                 | ⏳ TODO           |
| [src/websocket/](src/websocket/)                                     | Socket.IO server + handlers. Most events live in `handlers/preview.handler.ts`.                                                                                                          | ⏳ TODO           |
| [src/services/testing/](src/services/testing/)                       | Non-preview testing services (regression, plans, results, executions, fixtures, exploration).                                                                                            | —                 |
| [src/services/test-resource/](src/services/test-resource/)           | Polymorphic test resources — `auth` (logins), `environment`, `secret` adapters live here; `data_fixture` queued.                                                                         | ✅                |
| src/services/chat/                                                   | Chat-side context + tracing: `editor-context.service.ts` (live page DOM/console/network → chat), `chat-test-trace.service.ts` (per-test-case chat JSONL trace → `test_logs/chat_test/`). | —                 |
| [src/services/kb/](src/services/kb/)                                 | Knowledge base (skills, patterns) for auto-learn.                                                                                                                                        | —                 |
| [src/services/skills/](src/services/skills/)                         | Skill registry — composable test capabilities.                                                                                                                                           | —                 |
| src/services/mobile/                                                 | Mobile runner integration (scrcpy, redroid, a11y agent).                                                                                                                                 | —                 |
| src/services/integrations/                                           | Jira, Stripe, Telegram, Allure, Git webhooks.                                                                                                                                            | —                 |
| src/services/telegram-tasks/                                         | **QAIT Tasker** — Telegram group task tracker. Webhook ingest (`api/telegram-tasks/`) → AI reconcile (`telegram-task-ai.service.ts`, gpt-5.4-mini tool-use) → Supabase (`db/`, tables `telegram_tasks`/`telegram_messages`). Daily 10:00 Almaty batch (`jobs/telegram-task-sweep.job.ts`, registered in all 3 scheduler paths). Feature-gated `TELEGRAM_TASKS_ENABLED` (default off). | —                 |
| [src/config/](src/config/)                                           | AI model config, queues, env, features, testing knobs.                                                                                                                                   | —                 |
| [src/db/](src/db/)                                                   | Supabase client + helpers. Schema lives in `supabase-migrations/`.                                                                                                                       | —                 |
| [src/middleware/](src/middleware/)                                   | Auth, rate limiting, request logging, error handler.                                                                                                                                     | —                 |
| src/utils/                                                           | Helpers — only put truly reusable cross-domain code here.                                                                                                                                | —                 |
| src/types/                                                           | Shared types not bound to a single feature.                                                                                                                                              | —                 |

**Rule of thumb:** if a folder has a `CLAUDE.md`, read it before working in that folder. If it doesn't and there are >8 files, ask whether to create one.

---

## Where things live (cheat sheet)

| When you need to…                                                     | Open                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| …understand preview/replay/recording/auto-healing                     | [src/services/testing/ui/preview/CLAUDE.md](src/services/testing/ui/preview/CLAUDE.md)                                                                                                               |
| …add a new resource kind (env/secret/fixture/...)                     | [src/services/test-resource/CLAUDE.md](src/services/test-resource/CLAUDE.md)                                                                                                                         |
| …change LLM behaviour for element resolution                          | `preview/element-resolver.service.ts`, `preview/intent-step-lint.service.ts`                                                                                                                         |
| …change a prompt                                                      | `src/ai/prompts/*.ts`                                                                                                                                                                                |
| …add/change a chat intent                                             | `src/api/chat/<intent>/handler.ts` + register in `shared/handler-registry.ts` (map + descriptions) + routing message in `shared/routing.ts`                                                          |
| …resolve a descriptor ("payment tests","smoke") → test IDs            | `src/services/testing/resolver/test-query-resolver.service.ts`; consumed via `shared/intent-target-resolution.ts`                                                                                    |
| …change request-understanding (ANALYZE/ENRICH/IMPROVE)                | `src/ai/prompts/request-understanding-prompts.ts`                                                                                                                                                    |
| …add a chat management op (schedule/module/plan)                      | new `manage_*` intent calling `qa_manage_*` through `executeTool` (see `regression/shared/manage-tool.helper.ts`)                                                                                    |
| …add/change a yes-no / cancel / approval keyword (ru/en/kk)           | `src/config/testing/intent-keywords.ts` (single source — NEVER inline a new list). Consumers: intent-fast-path, confirmation-classifier, compound-queue, manage-tool.helper. See Hard invariant #17. |
| …add/modify a BullMQ job                                              | `src/jobs/<name>.job.ts` and register in `src/worker/index.ts`                                                                                                                                       |
| …add a REST route                                                     | `src/api/<domain>/` (route + controller + service), wire in `src/index.ts`                                                                                                                           |
| …add a WS event                                                       | `src/websocket/handlers/<handler>.ts`. Preview events go in `preview.handler.ts`.                                                                                                                    |
| …invalidate the test-suites editor's caches on a CRUD mutation        | Emit `project:{testcase,flow,module}:mutated` to the `project:<id>` room via `webSocketService.emit{TestCase,Flow,Module}Mutation` (helpers in [project-mutation-emit.ts](src/websocket/helpers/project-mutation-emit.ts)). Client joins via `subscribe:project` (fail-closed: owner OR active workspace member, [subscription.handler.ts](src/websocket/handlers/subscription.handler.ts)). |
| …run something on a schedule                                          | `src/scheduler/`                                                                                                                                                                                     |
| …run AI agent (LiteEngine)                                            | `src/agent/core/lite/lite-engine.ts` → `MultiAgentOrchestrator` in `agents/`                                                                                                                         |
| …run autonomous site exploration                                      | `src/agent/core/lite/exploration/exploration-engine.ts`                                                                                                                                              |
| …trace AI cost / token usage                                          | `src/services/ai/cost/`, `src/services/ai/tracking/`                                                                                                                                                 |
| …work on the per-test-case ("AI Agent inside a test case") chat       | `src/api/chat/chat.controller.ts` (testCaseId branch), `src/api/chat/general/handler.ts` (editor flow + trace), `src/services/chat/chat-test-trace.service.ts` — see Hard invariant #16              |
| …change a user's plan/tier (any write site)                           | `src/services/core/plan.service.ts` (`PlanService.setUserPlan`) — the SINGLE funnel for **individual** plan writes (keeps `users.{plan_id,plan,plan_status}` + `user_credits.{subscription_plan,subscription_status,grace_limit}` in sync). Stripe webhooks (individual) and self-serve route through it. **Admin panel** grants go through `src/services/core/admin-plan-grant.service.ts` (`AdminPlanGrantService.grant`, behind `POST /api/v1/user/plan/assign`): individual (`free`/`pro`) → `setUserPlan`; B2B tiers (`pilot`/`small_business`/`middle_business`/`enterprise`) → `UserCreditsService.grantBusinessPlan` (credits/grace/**price** → `credit_transactions.cost_usd`, admin can override credits+price for a discount) + `writeUserBusinessPlanMirror` (plan.db) which mirrors the slug onto `users.plan`/`plan_status` with `plan_id=null` (no pricing_plans row for B2B) so the row stops drifting. **Credits belong to the USER only** — B2B Stripe invoices AND the ops `scripts/assign-workspace-plan.ts` grant to the buyer's `user_credits` via `grantBusinessPlan` (NOT a workspace). Paid-feature gating (`isPaidUser` → `plan-access.db.ts` `userHasPaidBusinessPlan`) reads the user's own `user_credits.subscription_plan` (binary free-vs-paid; NO per-tier gate). `subscription_plan` slug union lives once in `user-credits.service.ts` (`SubscriptionPlanSlug`). The individual `ultra` ("Team") plan is RETIRED (`is_active=false`, 0 users) — real Team/Enterprise = the B2B tiers. The `workspace_credits`/`workspace_credit_transactions` tables + `deduct_workspace_credits` RPC are now dead (`workspace-credits.service.ts` removed); a schema-drop migration is deferred to its own PR. |
| …work on referrals by link (partner tracking + reward)               | `src/services/core/referral.service.ts` (+ `db/referral.db.ts`) — attribution is first-touch set-once (DB-enforced) applied in `auth.controller` verify/login/OAuth + `POST /referrals/attribute`; partner reward is a **revenue share** — `ReferralsFeature` `REFERRAL_REWARD_RATE` (0.70) × the real invoice amount, for the referred user's first `REFERRAL_REWARD_MONTHS` (2) payments, then 0%; `rewardOnPayment` fires from `stripe.controller.ts` on EVERY paid invoice (window enforced by COUNTING prior reward rows, not billing reason), per-invoice-idempotent via `partner_reward_transactions.stripe_invoice_id` (append-only ledger, `amount`=cents). **Partnership is DECOUPLED from `role`** (July 2026): a partner login is a normal `role='user'` product user (gets a workspace + trial credits) who ALSO has a linked `partners.auth_user_id` row. `/auth/me` returns `isPartner` (derived from that link) — the frontend `/partner` guard keys off `isPartner`, NOT role, so a partner uses the platform AND the referral dashboard with one account. `markUserAsPartnerLogin` only sets `status='approved'` (never role); self-serve no longer skips partners. `attributeUser` has a **self-referral guard** (a user can't be attributed to a partner whose `auth_user_id` is themselves) so a partner can't earn the revenue share on their own subscription. Feature-gated `REFERRALS_ENABLED` (default off). Migrations `20260713_referrals.sql` + `20260714_referral_revenue_share.sql`. |
| …send a transactional email (welcome/approval/invite/purchase/report) | `src/services/core/email.service.ts` (`EmailService`) — see "Transactional email" flow below                                                                                                         |
| …check DB schema                                                      | `supabase-migrations/supabase-schema.sql`                                                                                                                                                            |
| …add/change a **prod** env var (not just `env.ts`)                    | See "Env vars: local vs prod" below — prod env lives in `qait-infra/azure/terraform/.env`, NOT here                                                                                                   |
| …read a runtime trace / log                                           | `test_logs/<feature>/<YYYY-MM-DD_HH-MM-SS>_<testId>.jsonl` — `editor/` (preview traces), `chat_test/` (per-test-case chat). Always-on JSONL; auto-pruned after `EDITOR_LOG_RETENTION_DAYS` (default 3) by `src/jobs/artifact-retention.job.ts` |

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
→ `CompiledPlanPersistenceService.persistFromRun` writes compiled plans back to `intent_test_cases.steps_json`
→ per-step screenshots uploaded base64→URL (`uploadMobileStepScreenshots` in [step-screenshot.service.ts](src/services/storage/step-screenshot.service.ts), gated by `SCREENSHOT_EACH_STEP_ENABLED`) → `runtimeMeta.stepScreenshotUrl` + `metadata.steps[].screenshot`
→ `MobileTestRunJobHandler.createTestResult()` (private wrapper) → `dbAdminService.createMobileTestResult()` inserts into the FORKED `mobile_test_results` table (NOT `test_results`; `browser` is CHECK-constrained to `mobile-android`/`mobile-ios`) with aggregated stats
→ **Phase 2 telemetry** ([20260516_mobile_telemetry.sql](supabase-migrations/20260516_mobile_telemetry.sql)): per-test wallclock (`app_setup_ms`, `scenario_steps_ms`, `test_steps_ms`, `session_claim_ms`, `cold_start_used`) written into `test_executions` in `mobile-test-run.job.ts` finally block; aggregated into `regression_runs.total_*` by `TestCompletionHandlerService.recomputeRunStatus()` at run finalisation. Best-effort, NEVER fails the test path.
→ post-run [ai-analysis.job.ts](src/jobs/ai-analysis.job.ts) → bug detection → writes `ai_summary` back via `dbAdminService.updateTestResult` (which tries `test_results` then falls back to `mobile_test_results`, mirroring the read fallback in `getTestResult` — so a mobile run's `ai_summary` lands on its `mobile_test_results` row).

**Mobile regression diverges from web in five ways:** (1) batch RPC (`runSteps`)
not per-step apply; (2) hardcoded `screenshotEachStep: true`; (3) NO heal layer
above the runner — mobile relies solely on the runner's per-step retry +
stabilization-retry tail; (4) compiled-plan persistence happens explicitly via
`CompiledPlanPersistenceService.persistFromRun` (web persists differently); (5) sessions claimed
from a runner-side pool (warmup → cold-start fallback) and released in the
finally block. See `mobile-test-run.job.ts` for the full lifecycle.

**Dedicated emulator per workspace** (gated by `DEDICATED_MOBILE_EMULATOR_ENABLED`, default off). Before the pool→warmup→cold ladder, `MobileSessionAcquisitionService.acquireSession` runs a **tier-0 dedicated intercept**: `resolveDedicatedDevice(workspaceId, platform)` ([dedicated-device.service.ts](src/services/mobile/dedicated-device.service.ts) → [db/dedicated-device.db.ts](src/services/mobile/db/dedicated-device.db.ts), table `workspace_dedicated_device`) returns the workspace's pinned `runner_serial` or null. On a hit it pins the session (`createSession({deviceSelector:{serial}, ownerId:workspaceId, dedicated:true})`, `sessionSource:'dedicated'`), SKIPS the shared ladder, and on cleanup calls `endDedicatedSession` (reset-without-destroy) instead of `destroySession` — the runner keeps the container alive. NO shared-pool fallback on failure (preserves isolation). The same intercept runs at the other 3 session-birth sites: editor warmup + auto-boot ([session.controller.ts](src/api/mobile/session.controller.ts)). `workspaceId` is ALWAYS server-derived (job payload or access-checked `project.workspace_id`), never the request body. Runner side: per-serial DEVICE_BUSY lock + TTL/eviction exclusion + `POOL_ANDROID_EXCLUDED_PORTS` (qait-mobile-runner). Map populated MANUALLY by ops (no auto-provision) — see qait-infra `setup-emulator-vm.sh`. iOS is shared-only in v1 (no remote simulator farm).

### Scheduled cron

Scheduler bundle ticks every 60s (the `TestSchedulerJobHandler` loop)
→ `processSchedules()` → `claimDueSchedule()` (atomic)
→ routes to `RegressionRunService.runPlan() | runModule() | runFlow()`
→ same web / mobile branches as above.

**Where the bundle runs:** local docker-compose runs a dedicated `scheduler` container ([src/scheduler/index.ts](src/scheduler/index.ts)). In prod the SAME bundle runs INSIDE the worker process, gated by `SCHEDULER_IN_WORKER=true` and a Redis **leader lock** ([src/scheduler/leader.ts](src/scheduler/leader.ts), key `${QUEUE_PREFIX}scheduler:leader`, 30s TTL; acquire = `SET NX EX`, renew/release = atomic Lua compare-and-expire / compare-and-del) so one worker replica runs it at N>1. Adaptive cadence: a non-leader re-contends every 5s, a leader renews every 10s — so after a worker restart the new leader takes over within ~tens of seconds (not the minutes the old 90s-TTL/30s-poll caused, which made schedules fire ~4-5 min late post-deploy). Guarantee is at-most-one in steady state, not hard mutex (a >30s leader stall opens a ≤10s double-run window, bounded because the sweeps are idempotent and schedule claims are atomic). Default OFF, so the two never fight; the lock is the backstop if both ever run against one Redis.

**Schedule types:** a `test_schedules` row is either **recurring** (`schedule_type='recurring'`, a 5-field `cron_expression` + `timezone`; `claimDueSchedule` advances `next_run_at` to the next occurrence) or **one_time** (`schedule_type='one_time'`, an absolute `run_at`; `claimDueSchedule` fires once then flips `is_active=false`). Due-detection is identical for both (`next_run_at <= NOW()`); only the claim/advance step differs. Create/update accept exactly one of `cronExpression` or `runAt` ([schedule.service.ts](src/services/testing/schedules/schedule.service.ts), [schedules.controller.ts](src/api/schedules/schedules.controller.ts), `qa_manage_schedule`).

Also in the scheduler bundle (24h sweeps, single-instance — now guarded by the leader lock when hosted in the worker): `ArtifactRetentionJob` ([artifact-retention.job.ts](src/jobs/artifact-retention.job.ts)) prunes `${userId}/step-screenshots/...` older than `SCREENSHOT_RETENTION_DAYS`; `ExpiringPlansJob` ([expiring-plans.job.ts](src/jobs/expiring-plans.job.ts)) emails paid users whose plan expires within 3 days (see Transactional email → `sendPlanExpiringEmail`). New sweeps MUST be registered in all THREE scheduler entrypoints ([index.ts](src/scheduler/index.ts) local, [leader.ts](src/scheduler/leader.ts) worker-bundle, [job-daily.ts](src/scheduler/job-daily.ts) Cloud Run cron) — registering only in `index.ts` means it never runs in prod. Per-step screenshot knobs live in [env.ts](src/config/environment/env.ts) / [config/features/screenshot-capture.ts](src/config/features/screenshot-capture.ts): `SCREENSHOT_EACH_STEP_ENABLED` (default ON), `SCREENSHOT_FORMAT` (`webp`/`jpeg`), `SCREENSHOT_QUALITY`, `SCREENSHOT_RETENTION_DAYS`. Final/bug screenshots (`${userId}/screenshots/...`) are a SEPARATE prefix the retention job never touches.

### Chat → test creation / management (intent-driven router)

POST `/api/chat/message` → `handleChat()` ([src/api/chat/chat.controller.ts](src/api/chat/chat.controller.ts))
→ pending-state interceptors (run BEFORE parsing, global chat only):
exploration-confirm → manage-confirm ([regression/shared/manage-confirmation.ts](src/api/chat/regression/shared/manage-confirmation.ts)) → run-existing-confirm ([shared/run-existing-confirmation.ts](src/api/chat/shared/run-existing-confirmation.ts)) → compound-continuation ([shared/compound-queue.ts](src/api/chat/shared/compound-queue.ts))
→ `parseUserIntent()` ([src/services/ai/intent/intent-parser.service.ts](src/services/ai/intent/intent-parser.service.ts)) — one LLM call now ALSO returns an `analysis` block
(ANALYZE + IMPROVE folded in, see [src/ai/prompts/request-understanding-prompts.ts](src/ai/prompts/request-understanding-prompts.ts)):
`targetSelector{type,value}` (descriptor), `executionModifiers{browser,…}`, `isCompound/subRequests`, `manage{…}`, `lookbackDays`.
→ post-parse enrichment ([shared/intent-target-resolution.ts](src/api/chat/shared/intent-target-resolution.ts)):
`TestQueryResolver` resolves a descriptor → concrete IDs ([src/services/testing/resolver/test-query-resolver.service.ts](src/services/testing/resolver/test-query-resolver.service.ts));
on ambiguity, a conditional 2nd LLM call (ENRICH) narrows candidates.
→ **confirm-or-explore guard** (global chat, `platform_test`, non-exploration, non-compound; [chat.controller.ts](src/api/chat/chat.controller.ts) STEP 5.5): `TestCaseResolverService.resolve({…, ownerOnly:true})` → if any saved test case clears the partial floor (≥0.50), store the candidates ([shared/run-existing-confirmation.ts](src/api/chat/shared/run-existing-confirmation.ts) `storePendingRunExisting`) and ASK the user to confirm (single→yes/no, multi→pick N) instead of Lite-running; the next turn's run-existing-confirm interceptor runs the chosen case via `RegressionRunService.runSavedTestCase` (auto web/mobile, threads `chatSessionId` so the run streams progress/result into the chat panel like a Lite run). If nothing matches, reply suggesting the **Explore** section (`TestCaseResolverService.userHasAnyTests` tailors the copy). `ownerOnly`/`userHasAnyTests` are owner-scoped to match the owner-scoped runner (`getSavedTestCase`) — surfacing a workspace-mate's test would dead-end on confirm. NEVER silently Lite-runs a typed "test X". Replaced the old auto-redirect-to-run_regression + prefilled-steps Smart Resolver.
→ compound splitter (if `isCompound`): run step 1, queue the rest; advance-after-success per turn.
→ `routeToHandler()` ([shared/routing.ts](src/api/chat/shared/routing.ts)) → handler from `INTENT_HANDLERS` registry.

**Intents (23)** in [shared/handler-registry.ts](src/api/chat/shared/handler-registry.ts): platform*test, api_test, api_flow_test,
general_chat, needs_clarification, save_test, run_regression, run_plan, run_module, run_by_tag, create_plan,
add_to_plan, analyze_failure, test_recommendations, coverage_analysis, editor_action, mobile_test, mobile_action,
mobile_agent, **flaky_report, manage_schedule, manage_module, manage_plan** (the last 4 added in the management phase;
they call existing `qa_manage*\*`tools through`executeTool`, not the SubAgentPipeline).

### Self-serve "magic first test" (PLG, gated by `AUTO_APPROVE_SIGNUP`)

Sign up → first auth (`verifyEmail` / `completeOAuthHandler` in [auth.controller.ts](src/api/auth/auth.controller.ts))
→ `SelfServeProvisioningService.provision()` ([self-serve-provisioning.service.ts](src/services/core/self-serve-provisioning.service.ts)) — approve user + create workspace+project + grant trial credits/plan (no-op unless flag on; never throws). On the FIRST pending→approved transition it also fires `EmailService.sendApprovalEmail` (fire-and-forget) — the ONLY place auto-approved users get the "You're in!" email; the admin PATCH path is the other.
→ POST `/api/v1/explorations/start` ([explorations.controller.ts](src/api/explorations/explorations.controller.ts)) `{ url, projectId?, preset? }`, gated by `requireApproved` + `requireCredits`
→ validate URL + IDOR-guard projectId → `QueueManager.addExplorationJob()` on the `'quick'` budget preset (~2 min, [types.ts](src/agent/core/lite/exploration/types.ts) `EXPLORATION_PRESETS`)
→ returns `202 { explorationId }` → poll GET `/api/v1/explorations/:id` for discovered test cases → one-click `POST /:id/run-discovered`.

### Transactional email (`EmailService`, [email.service.ts](src/services/core/email.service.ts))

Nodemailer over Gmail SMTP (`smtp.gmail.com:587`, user `yera@qait.dev`, pass `SMTP_PASSWORD`). New transport per send; `EmailService.verifyConfig()` runs once at boot ([index.ts](src/index.ts)) and loudly logs a dead/missing credential (non-fatal). Auth-flow emails (magic link / password reset / verification / new-user invite) are sent by **Supabase**, NOT this service.

All HTML built through one shared `buildEmailTemplate()` (light, table-based, Outlook-safe) + builders (`buildWelcomeHtml` / `buildPlanPurchasedHtml` / `buildGeneralInfoHtml` / `buildTestFailedEmail` / `buildCriticalIssuesEmail` / `buildSupportReportEmail` / `buildNewUserSignupEmail`); the `build*Html` variants are reused by `scripts/preview-email-templates.ts` (`npx tsx`, port 3555).

Senders + triggers:

- `sendWelcomeEmail` — on `POST /auth/signup` ([auth.controller.ts](src/api/auth/auth.controller.ts)), states the configured free grant (`INDIVIDUAL_PLANS.free.credits`), NOT a live balance (the trial grant lands later on verify/login).
- `sendApprovalEmail` / `sendRejectionEmail` — admin `PATCH /auth/users/:id/status` (guarded by `prevUser.status !== status`) + self-serve `provision()`.
- `sendWorkspaceInvite` — workspace invite/resend for EXISTING users ([workspace-members.service.ts](src/services/core/workspace-members.service.ts)); new users go via Supabase invite.
- `sendPlanPurchasedEmail` — Stripe `invoice.payment_succeeded` ([stripe.controller.ts](src/api/stripe/stripe.controller.ts)), AFTER the dedup guards and ONLY for first-purchase/one-off (`billing_reason !== 'subscription_cycle'`) so renewals don't spam.
- `sendGeneralInfoEmail` — admin broadcast `POST /auth/admin/send-info-email` (`requireAuth + requireAdmin`, capped at 500 recipients/call); also the generic queue path (`addNotificationJob({type:'email'})` → `sendGenericEmail`) for test-failed / critical-issues / support-report / new-signup.
- `sendPlanExpiringEmail` — daily `ExpiringPlansJob` sweep ([expiring-plans.job.ts](src/jobs/expiring-plans.job.ts) → [subscription-lifecycle.service.ts](src/services/core/subscription-lifecycle.service.ts) → `db/subscription-lifecycle.db.ts`) for paid users whose `current_period_end` is within 3 days. Per-period dedup via `users.expiry_reminder_sent_for` (one email per period). Registered in ALL THREE scheduler paths ([index.ts](src/scheduler/index.ts), [leader.ts](src/scheduler/leader.ts), [job-daily.ts](src/scheduler/job-daily.ts)).
- `sendPaymentFailedEmail` — Stripe `invoice.payment_failed` ([stripe.controller.ts](src/api/stripe/stripe.controller.ts)), ONLY on the final retry (`next_payment_attempt == null`) so dunning retries don't spam.
- `sendSubscriptionCanceledEmail` — Stripe `customer.subscription.deleted` or `.updated` with `status === 'canceled'` only (NOT transient past_due/unpaid/paused).

Invariants: (a) every send returns `{success,error}` and is fire-and-forget — callers MUST log a resolved `{success:false}`, not only `.catch()` thrown errors (a dead credential resolves falsy, never throws). (b) every caller-supplied string in HTML goes through `esc()`; every caller-supplied URL in an `href` goes through `safeUrl()` (http/https/mailto only, else `#`).

---

## Hard invariants (do not violate)

These are codified across the codebase. Also see [.claude/rules/critical-patterns.md](.claude/rules/critical-patterns.md) for the long form.

1. **Never reuse the screencast CDP session in preview.** Piggybacking on the `video-stream` session causes 100% video freeze. In preview contexts, `CdpSnapshotService` opens its own session and detaches in `finally` — that is safe. In background/regression contexts `context.newCDPSession(page)` is always fine. For DevTools outside Etap 2, prefer Playwright built-ins (`page.accessibility.snapshot()`, `page.content()`). See [critical-patterns.md](.claude/rules/critical-patterns.md) section 2 for the full trade-off.
2. **WebSocket handlers must always emit a response.** Silent `return` = frontend stuck on "Loading…" forever. Even on error paths.
3. **Recording and step apply are mutually exclusive in a preview session.** Recording auto-stops when a run starts (`PreviewRunService.isRunning()` guard).
4. **Replay path uses `waitUntil: 'load'`, never `'domcontentloaded'`.** Different timing semantics — don't mix.
5. **OpenAI role mapping:** DB stores `'ai'`, OpenAI requires `'assistant'`. Always pass through `convertRoleForOpenAI()` from `utils/helpers/chat-helpers`.
6. **CSS selector escaping:** use `CSS.escape()` when interpolating IDs (React 18 `useId()` produces colons that break selectors).
7. **Element resolution is a 3-stage waterfall:** compiled plan → LLM resolver → smart locator. Never skip a stage. **One sanctioned exception:** a step with `options.useScreenshotOnly` forces vision-only resolution — `resolveElement` short-circuits to a screenshot/vision pass at the top (before identity/evidence/compiled/LLM) and hard-fails (`not_found`) if vision finds nothing, and the pre-resolveElement fast-paths (evidence shortcut in `intent-step-lint`, compiled fast-path in `preview-step-apply`, evidence+compiled in `command-executor`) are all gated off the same flag so a forced step reaches the gate. This is per-step and opt-in only.
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

## Env vars: local vs prod (how to actually change a prod value)

Adding a var to [env.ts](src/config/environment/env.ts) makes it exist in code — it
does **NOT** set it in prod. Local and prod are two separate places:

- **Local:** `qai-backend/.env` (dotenv). Only affects your machine.
- **Prod:** the backend runs on **Azure Container Apps**, and its env is managed in
  **`qait-infra/azure/terraform/`**, NOT here and NOT in the deploy pipeline (the
  GitLab `deploy:api` job only swaps the image). A dev edits **one** file —
  `qait-infra/azure/terraform/.env` — and the terraform CI ([azure/terraform/.gitlab-ci.yml](../qait-infra/azure/terraform/.gitlab-ci.yml))
  buckets every line into three:
  1. **`SECRET_KEYS`** (in that `.gitlab-ci.yml`) → a top-level tfvar feeding a
     `secret {}` block. A secret ALSO needs a `variable` + `secret {}` +
     `env { secret_name }` in [container-apps.tf](../qait-infra/azure/terraform/container-apps.tf)
     (see how `jwt-secret` is wired).
  2. **`INFRA_KEYS`** → skipped (terraform-controlled OR already a hardcoded `env {}`
     block in `container-apps.tf`; a name that's hardcoded there MUST be in
     `INFRA_KEYS` or you get a duplicate-env error).
  3. **everything else** → an `app_env` map → a `dynamic "env"` block on BOTH
     containers. **So a plain flag = just add `NAME=value` to that `.env`, nothing
     else.** (`MOBILE_RUNNER_ENABLED` / `COMPANION_ENABLED` are the examples.)

  Merge to the branch the infra pipeline watches → it runs `terraform plan` →
  `apply` → the Container App rolls a new revision with the value. No image rebuild.

**The trap (see [../LESSONS.md](../LESSONS.md)):** a feature gated by a
default-off flag is **dark in prod until the flag is set in that shared `.env`** —
having it `true` in your local `.env` proves nothing about prod. "Done" isn't done
until the prod value is wired there. This is exactly how the companion relay shipped
to prod but returned 503 until `COMPANION_ENABLED=true` was added to the infra `.env`.

## Pre-commit checks

```bash
npm run type-check
npm run lint
```

Don't deploy without explicit approval. See [.claude/rules/general.md](.claude/rules/general.md).
