# `src/jobs/` — BullMQ job handlers

> Background execution. Handlers are thin: they delegate to services and own
> persistence + telemetry. Registered in [../worker/index.ts](../worker/index.ts).

Flat layout — one file per job, `<name>.job.ts`. 11 job types.

---

## Background replay — web

```
POST /api/v1/regression/run  or  /run-plan
→ RegressionRunService.runSavedTestCase() / runPlan()
   (../services/testing/regression/regression-run.service.ts)
→ INSERT regression_runs + tests + test_executions
→ BullMQ enqueue
→ manual-test-run.job.ts
→ executePlaywrightTestWithRetry()   (fresh browser, NOT preview session)
→ per-step screenshot after EVERY step
→ ai-analysis.job.ts → bug detection
```

Per-step screenshot is `captureStepScreenshot`, gated by `SCREENSHOT_EACH_STEP_ENABLED`
(default ON) → `runtimeMeta.stepScreenshotUrl`. Video/trace still record only on
infra-retry.

---

## Background replay — mobile

Same entry as web; routing diverges at `dispatchMobileTest()`.

```
POST /api/v1/regression/run  or  /run-plan
→ RegressionRunService.runSavedTestCase()
→ branch on intent_test_cases.platform.startsWith('mobile_')
→ decideMaxMobileInFlight()  (../services/testing/regression/concurrency-decision.ts)
→ dispatchMobileTest()
→ INSERT regression_runs + tests + test_executions
→ QueueManager.addMobileTestJob()   (BullMQ producer)
→ mobile-test-run.job.ts — MobileTestRunJobHandler.process()
→ MobileRunnerClient.runSteps(sessionId, intentSteps, { screenshotEachStep:true })
→ CompiledPlanPersistenceService.persistFromRun → intent_test_cases.steps_json
→ per-step screenshots uploaded base64→URL
→ createTestResult() → dbAdminService.createMobileTestResult()
→ ai-analysis.job.ts → bug detection
```

**Concurrency.** `decideMaxMobileInFlight()` chooses the run's in-flight cap from
`REGRESSION_MOBILE_MAX_CONCURRENCY` + live runner pool capacity + test count. Falls
back to cap=1 (serial) on any failure path. Logged as
`[REGRESSION_RUN] Mobile concurrency decided`.

**The results table is FORKED.** `createMobileTestResult()` inserts into
`mobile_test_results`, NOT `test_results`; `browser` is CHECK-constrained to
`mobile-android` / `mobile-ios`. `ai_summary` is written back via
`dbAdminService.updateTestResult`, which tries `test_results` then falls back to
`mobile_test_results` (mirroring the read fallback in `getTestResult`) — so a mobile
run's `ai_summary` lands on its `mobile_test_results` row.

**`failedReason` + `healed` on a mobile step** —
[../services/mobile/step-failure-classifier.ts](../services/mobile/step-failure-classifier.ts).
`failedReason` maps the runner's STRUCTURED `errorClassification` (never the message
text), falling back to `resolvedVia` then, last, a timeout regex. `healed` cannot use
web's "compiled plan missed" notion: Flutter's `smartResolve` returns early on a text
finder (`resolvedVia: 'flutter_finder_first'`) before the compiled path and returns no
plan, so a matchable control never persists one. It keys on `enrichedHints` — built only
when the FULL resolver ran — plus a differing prior `bindingHints.label`, which is also
what fills the report's before/after diff. **`reduceRuntimeMeta`
([../services/testing/results/test-executed-steps-redis.service.ts](../services/testing/results/test-executed-steps-redis.service.ts))
is an allowlist:** a new `runtimeMeta` field added anywhere must be added there too, or
it survives the live WS broadcast but is dropped on the way to `tests.executed_steps`.

**Screenshot upload** — `uploadMobileStepScreenshots` in
[../services/storage/step-screenshot.service.ts](../services/storage/step-screenshot.service.ts),
gated by `SCREENSHOT_EACH_STEP_ENABLED` → `runtimeMeta.stepScreenshotUrl` +
`metadata.steps[].screenshot`.

**Mobile regression diverges from web in five ways:** (1) batch RPC (`runSteps`)
not per-step apply; (2) hardcoded `screenshotEachStep: true`; (3) NO heal layer
above the runner — mobile relies solely on the runner's per-step retry +
stabilization-retry tail, though a heal is now REPORTED (see below); (4) compiled-plan persistence happens explicitly via
`CompiledPlanPersistenceService.persistFromRun` (web persists differently); (5) sessions claimed
from a runner-side pool (warmup → cold-start fallback) and released in the
finally block. See `mobile-test-run.job.ts` for the full lifecycle.

### Telemetry

Migration [20260516_mobile_telemetry.sql](../../supabase-migrations/20260516_mobile_telemetry.sql):
per-test wallclock (`app_setup_ms`, `scenario_steps_ms`, `test_steps_ms`,
`session_claim_ms`, `cold_start_used`) written into `test_executions` in
`mobile-test-run.job.ts`'s finally block; aggregated into `regression_runs.total_*`
by `TestCompletionHandlerService.recomputeRunStatus()` at run finalisation.
Best-effort, NEVER fails the test path — see root CLAUDE.md Hard invariant #11.

> **NOTE:** the `scenario_setup` resource kind was removed, so `scenario_steps_ms` /
> `scenario_step_count` / `total_scenario_ms` now only ever reflect the generic compiled
> prologue (usually 0) — these columns + the `admin-regression-metrics` scenario analytics
> are dead-but-retained pending a deferred teardown PR.

### Dedicated emulator per workspace

Gated by `DEDICATED_MOBILE_EMULATOR_ENABLED`, default off.

Before the pool→warmup→cold ladder, `MobileSessionAcquisitionService.acquireSession`
runs a **tier-0 dedicated intercept**: `resolveDedicatedDevice(workspaceId, platform)`
([../services/mobile/dedicated-device.service.ts](../services/mobile/dedicated-device.service.ts)
→ [db/dedicated-device.db.ts](../services/mobile/db/dedicated-device.db.ts), table
`workspace_dedicated_device`) returns the workspace's pinned `runner_serial` or null.

On a hit it pins the session (`createSession({deviceSelector:{serial}, ownerId:workspaceId, dedicated:true})`,
`sessionSource:'dedicated'`) **on a client built from the row's `runner_url`, not
the job's default client** — the dispatcher sets `runnerUrl` from
`resolveRunnerUrlForHost` (the SHARED runner) and never reads the dedicated row,
while tier-0 binds every later call to `dedicated.runnerUrl`; creating on one host
and using on another 404s as `SESSION_RECLAIMED` and no dedicated run can complete
(2026-08-08). A null `runner_url` legitimately means the default runner serves the
device. It SKIPS the shared ladder, and on cleanup calls
`endDedicatedSession` — app-state reset, then the runner RELEASES the session id, with
no device teardown, so the container stays alive but the serial is free for the next run.
(Before 2026-08-08 it only reset, leaving an immortal record that made every later run on
that container fail `DEVICE_BUSY` until the runner restarted.) NO shared-pool fallback on
failure (preserves isolation) — instead the create retries a bounded 3 times on
`DEVICE_BUSY` only, since `MOBILE_WORKER_CONCURRENCY` (default 2) lets two runs of one
dedicated workspace genuinely overlap.

The same intercept runs at the other 3 session-birth sites: editor warmup + auto-boot
([../api/mobile/session.controller.ts](../api/mobile/session.controller.ts)).
`workspaceId` is ALWAYS server-derived (job payload or access-checked
`project.workspace_id`), never the request body. Runner side: per-serial DEVICE_BUSY
lock + TTL/eviction exclusion + `POOL_ANDROID_EXCLUDED_PORTS` (qait-mobile-runner).
Map populated MANUALLY by ops (no auto-provision) — see qait-infra
`setup-emulator-vm.sh`. iOS is shared-only in v1 (no remote simulator farm).

---

## Regression Doctor — proposed fixes for failed steps

```
user clicks "Analyze failures" in the run report
→ POST /api/v1/regression/runs/:runId/doctor/analyze   (regression.controller.ts)
→ QueueManager.addRegressionDoctorJob()
→ regression-doctor.job.ts
→ collectFailedSteps()   (../services/regression-doctor/failed-step-collector.ts)
   → test_executions (failed) → tests.executed_steps → first failing step
   → matched to intent_test_cases.steps_json BY STEP ID
→ analyzeFailedStep()    (../services/regression-doctor/step-fix-agent.ts)
   → verdict test_fix | app_bug | unclear, patch only for test_fix
→ INSERT regression_doctor_findings → WS `regression:doctor:ready`
→ user clicks Apply → POST /regression/doctor/findings/:id/apply → apply.service.ts
```

**It is NEVER enqueued automatically.** One vision call per failed test means a
nightly suite that fails for an environmental reason would bill for findings
nobody asked for, so `recomputeRunStatus` deliberately does not start it. The
only producer is the REST endpoint above.

**Re-clicking is safe.** `addRegressionDoctorJob` reuses the `doctor-${runId}`
job id: a job still waiting or active returns `alreadyRunning` instead of
duplicating, and a job merely sitting in the completed set (this queue keeps 25)
is removed first — otherwise BullMQ would refuse the id and "Analyze again"
would silently do nothing. The job itself skips every step that already has a
finding, so a second analysis only pays for what is new.

**The job's return value is the only record that an analysis happened.** Zero
findings and never-analyzed are the same empty table, so the run report would
redraw its idle prompt after a completed analysis and look like the button did
nothing. `GET /runs/:runId/doctor` therefore also returns
`QueueManager.getRegressionDoctorJobStatus(runId)`, which reads the retained
`doctor-<runId>` job: its `returnvalue` carries `findingsCreated`, `skipped` and
`skipReasons` (the per-reason counts from the collector), and the panel uses
them to say what it looked at and why it proposed nothing. Best-effort — a null
degrades the wording, never the request. Anything added to that return value
must stay JSON-serializable, since BullMQ is the storage.

**The collector retries for the trace.** `tests.executed_steps` is drained from
Redis to Postgres in the test job's `finally`, so a user who clicks the moment a
run turns red can beat the write. `failed-step-collector.ts` re-reads empty
traces at 0/2s/4s — the same race `../services/kb/auto-learn.service.ts` guards
against.

**A runtime step id is not always an authored step id.** Resource-prologue steps
are injected by `mobile-test-run.job.ts`; inlined preconditions become
`pre_<src>_<id>`; linked test cases become `link_<tc>_<id>` (and linking runs on
mobile). The collector accepts an exact `steps_json[].id` match only — there is
deliberately no positional fallback, because an index from one test case
addresses a different step in another.

**An applied patch must invalidate what the resolver reads first.**
`bindingHints.label || placeholder || description` is the runner's resolution
order and `compiled` short-circuits ahead of all of it with no staleness cutoff,
so `patch-applier.ts` replaces the hints wholesale and drops the compiled plan.
The write goes straight to `steps_json` rather than through
`IntentTestCaseService.update()`, whose V16 merge would re-hydrate the compiled
plan it just dropped — which is why the apply path reproduces that service's
side effects (`markNegativesStale`, flow-cache invalidation) by hand.

---

## Scheduled cron

```
Scheduler bundle ticks every 60s (TestSchedulerJobHandler loop)
→ processSchedules() → claimDueSchedule()   (atomic)
→ RegressionRunService.runPlan() | runModule() | runFlow()
→ same web / mobile branches as above
```

**Where the bundle runs.** Local docker-compose runs a dedicated `scheduler` container
([../scheduler/index.ts](../scheduler/index.ts)). In prod the SAME bundle runs INSIDE
the worker process, gated by `SCHEDULER_IN_WORKER=true` and a Redis **leader lock**
([../scheduler/leader.ts](../scheduler/leader.ts), key `${QUEUE_PREFIX}scheduler:leader`,
30s TTL; acquire = `SET NX EX`, renew/release = atomic Lua compare-and-expire /
compare-and-del) so one worker replica runs it at N>1.

Adaptive cadence: a non-leader re-contends every 5s, a leader renews every 10s — so
after a worker restart the new leader takes over within ~tens of seconds (not the
minutes the old 90s-TTL/30s-poll caused, which made schedules fire ~4-5 min late
post-deploy). Guarantee is at-most-one in steady state, not hard mutex (a >30s leader
stall opens a ≤10s double-run window, bounded because the sweeps are idempotent and
schedule claims are atomic). Default OFF, so the two never fight; the lock is the
backstop if both ever run against one Redis.

**Schedule types.** A `test_schedules` row is either **recurring**
(`schedule_type='recurring'`, a 5-field `cron_expression` + `timezone`;
`claimDueSchedule` advances `next_run_at` to the next occurrence) or **one_time**
(`schedule_type='one_time'`, an absolute `run_at`; `claimDueSchedule` fires once then
flips `is_active=false`). Due-detection is identical for both
(`next_run_at <= NOW()`); only the claim/advance step differs. Create/update accept
exactly one of `cronExpression` or `runAt`
([../services/testing/schedules/schedule.service.ts](../services/testing/schedules/schedule.service.ts),
[../api/schedules/schedules.controller.ts](../api/schedules/schedules.controller.ts),
`qa_manage_schedule`).

### Stale-run reaper (5 min)

`StaleRunReaperJob` ([stale-run-reaper.job.ts](stale-run-reaper.job.ts) → `StaleReaperService`)
finalizes runs / tests / explorations stranded in `running`/`pending` when no completion event
ever arrived (worker crash, job never picked up, Redis flush). It is the ONLY backstop — the
API used to run its own `cleanupZombieRuns` interval on every replica; that was deleted
([ADR-0027](../../../.claude/decisions/20260809-run-staleness-is-measured-by-progress.md)).

**Staleness is measured by PROGRESS, never by run age.** `isRunProgressStale` (exported from
[../services/testing/results/test-completion-handler.service.ts](../services/testing/results/test-completion-handler.service.ts))
takes the newest of the run's `started_at`, `last_segment_dispatched_at`, and every child
execution's `started_at`/`completed_at`; a run is dead only when all of them are past the
threshold. Anchoring on `regression_runs.started_at` alone force-failed the still-live children
of any suite that legitimately ran longer than the window. Threshold:
`STALE_RUN_THRESHOLD_MIN` (default 30) in [../config/testing/run-staleness.ts](../config/testing/run-staleness.ts) —
one constant shared by the sweep and by `recomputeRunStatus`'s own guard, so they cannot drift.

### 24h sweeps

Also in the scheduler bundle (single-instance — guarded by the leader lock when hosted
in the worker):

| Sweep | What it does |
| --- | --- |
| `ArtifactRetentionJob` ([artifact-retention.job.ts](artifact-retention.job.ts)) | Prunes `${userId}/step-screenshots/...` older than `SCREENSHOT_RETENTION_DAYS` |
| `ExpiringPlansJob` ([expiring-plans.job.ts](expiring-plans.job.ts)) | Emails paid users whose plan expires within 3 days (see [../services/core/CLAUDE.md](../services/core/CLAUDE.md) → `sendPlanExpiringEmail`) |
| `MobileOrphanSweepJob` ([mobile-orphan-sweep.job.ts](mobile-orphan-sweep.job.ts)) | Reclaims mobile build blobs no row references — a CI publish that dies between the PUT and `finalize` leaves an object nothing else collects. **Deletion is opt-in** (`MOBILE_ORPHAN_SWEEP_DELETE`, default off); until then it reports what it would reclaim |

**The orphan sweep's reference check is deliberately over-broad, and must stay
that way.** A blob survives if ANY of `mobile_app_builds.storage_path`,
`settings.mobileApp.storagePath`, `settings.mobileApps[platform].storagePath`, or
`settings.mobileAppVariants[platform][].latest.storagePath` names it, plus a 24h
minimum age. `mobile_app_builds` alone is NOT sufficient — `pruneOldBuilds`
deletes rows, so the legacy settings slot can outlive the row it was written
from, and deleting that object breaks editor warm-up with an install failure.
Both database reads fail CLOSED: if it cannot tell a live build from an orphan,
it deletes nothing. Any new place that stores a `storagePath` must be added to
`loadSettingsReferences`.

> **New sweeps MUST be registered in all THREE scheduler entrypoints** —
> [../scheduler/index.ts](../scheduler/index.ts) (local),
> [../scheduler/leader.ts](../scheduler/leader.ts) (worker-bundle),
> [../scheduler/job-daily.ts](../scheduler/job-daily.ts) (Cloud Run cron).
> Registering only in `index.ts` means it never runs in prod.

Per-step screenshot knobs live in [../config/environment/env.ts](../config/environment/env.ts)
/ [../config/features/screenshot-capture.ts](../config/features/screenshot-capture.ts):
`SCREENSHOT_EACH_STEP_ENABLED` (default ON), `SCREENSHOT_FORMAT` (`webp`/`jpeg`),
`SCREENSHOT_QUALITY`, `SCREENSHOT_RETENTION_DAYS`. Final/bug screenshots
(`${userId}/screenshots/...`) are a SEPARATE prefix the retention job never touches.

---

## Invariants

1. **Step persistence (`tests.executed_steps`) is owned by the PRODUCER, in-process.**
   See root CLAUDE.md Hard invariant #12 — do NOT add `appendStepCompleted` to
   `webSocketService.emitTestStepCompleted`.
2. **Telemetry writes never fail the test path.** Root CLAUDE.md Hard invariant #11.
3. **Register every new job in [../worker/index.ts](../worker/index.ts)**, and every new
   sweep in all three scheduler entrypoints (above).
