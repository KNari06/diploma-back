# Testing Flow Audit (last 10 days)

This document is a living list of **potential issues / risks** found during a code audit of the end-to-end testing flow:
`/api/v1/chat` → plan → approval → test creation → queue/worker → Playwright → result storage → AI analysis → websocket updates.

## Scope

- Chat request processing + cancellation (`/api/v1/chat`, `/api/v1/chat/cancel`)
- Manual UI tests API (`/api/v1/manual-test/*`)
- Queues/jobs/worker (BullMQ + Redis)
- WebSocket + Redis bridge
- Playwright agent (execution, cancellation, artifacts)
- Intelligent testing core loop (orchestrator/main loop)

## Issues / Risks (living list)

### 1) Credits deducted before queue job creation (risk of charging without running)

- **Severity**: critical
- **Where**: `src/api/chat/ai_test/execution.ts` (`executeUiTestFlow`) + `src/config/queues.ts` (`QueueManager.addTestRunJob`)
- **Why**: credits are deducted *before* `ManualTestService.runTest()`, while queue add will throw if `redisAvailable === false`.
- **Impact**: user can be charged but test never starts.

### 2) Chat request cancellation is in-memory only

- **Severity**: high
- **Where**: `src/api/chat/shared/request-cancellation.ts`
- **Why**: active requests are tracked in local process memory; in multi-instance deployments `/chat/cancel` can hit a different instance.
- **Impact**: cancel may not stop the request; “ghost” requests continue.

### 3) Redis bridge subscribe order can drop messages (race window)

- **Severity**: medium
- **Where**: `src/services/websocket/redis-bridge.service.ts`
- **Why**: the `message` handler is attached after `subscribe()` call (comment says the opposite).
- **Impact**: rare event loss during startup.

### 4) WebSocket Redis subscriber has duplicated `case 'test:progress'`

- **Severity**: low
- **Where**: `src/websocket/redis-subscriber.ts`
- **Why**: duplicate switch-case suggests dead code / inconsistent routing.
- **Impact**: confusing, future bug-prone.

### 5) Test status may be overwritten after cancellation (race)

- **Severity**: high
- **Where**: `src/jobs/manual-test-run.job.ts` (`updateTestStatus`, failure path)
- **Why**: `updateTestIfNotCancelled` is used only for setting `running`, but later updates can still overwrite cancelled.
- **Impact**: cancelled tests become failed/completed.

### 6) `/api/v1/manual-test/result` is unauthenticated

- **Severity**: critical
- **Where**: `src/api/manualTest/manualTest.route.ts`
- **Why**: route is not protected by `requireAuth` and has no signature/token validation.
- **Impact**: anyone can inject test results and trigger downstream processing (AI analysis jobs).

### 7) Cancelled Playwright runs can be stored as `failed`

- **Severity**: critical
- **Where**:
  - `src/agent/playwright/test-result-formatter.ts` (`formatTestResult`)
  - `src/jobs/manual-test-run.job.ts` (`process`)
- **Why**:
  - formatter sets `status = success ? 'completed' : 'failed'` (no cancelled path)
  - job handler treats `!result.success` as failure and marks test as failed
- **Impact**: user cancellation becomes failed test in DB + wrong WebSocket events.

### 8) Conflicting “overall completion” logic (completed vs failed)

- **Severity**: critical
- **Where**:
  - `src/jobs/manual-test-run.job.ts` (`ManualTestResultJobHandler.updateOverallTestStatus`)
  - `src/services/testing/ui/manual/test-result-processor.ts` (`checkAndHandleTestCompletion`)
- **Why**: one path sets overall status based on failures; another marks status as `completed` when all browsers finished (even if failed).
- **Impact**: final test status becomes nondeterministic / incorrect.

### 9) Intelligent storage loses before/after screenshots

- **Severity**: medium
- **Where**: `src/services/testing/results/intelligent-test-storage.service.ts`
- **Why**: action results are saved using `result.screenshot` for both before/after, while `ActionResult` supports `screenshotBefore/After`.
- **Impact**: incomplete data for replay/visualization.

### 10) Playwright cancellation checks have no timeout and are “soft”

- **Severity**: medium
- **Where**: `src/agent/playwright/test-cancellation-checker.ts`
- **Why**: DB call has no timeout; non-cancel errors are swallowed.
- **Impact**: cancellation can be delayed/ignored under DB issues.

### 11) Confusing/unused result-processing queue path (`TEST_RESULT`)

- **Severity**: low
- **Where**: `src/config/queues.ts` (`QueueManager.addTestResultJob`)
- **Why**: the helper exists but is not referenced anywhere (likely dead path / unfinished integration).
- **Impact**: maintenance overhead, “two sources of truth” risk if someone starts using it later without aligning logic.

### 12) AI webhooks always emit `test.completed` + `status: 'completed'`

- **Severity**: medium
- **Where**: `src/jobs/ai-analysis.job.ts` (`sendWebhookNotifications`)
- **Why**: event name and payload hardcode completion semantics regardless of real test status.
- **Impact**: external integrations can receive incorrect lifecycle events (failed/cancelled reported as completed).

### 13) Manual completion handler can force `completed` even when test had failed browsers

- **Severity**: critical
- **Where**: `src/services/testing/ui/manual/test-result-processor.ts` (`checkAndHandleTestCompletion`)
- **Why**: when all browsers have final results, it updates `tests.status = 'completed'` and does not account for failures/cancelled.
- **Impact**: “failed” tests can end up “completed”, causing wrong UI/analytics/webhooks.

### 14) Cancellation-to-chat-session mapping has a race window

- **Severity**: low
- **Where**:
  - `src/api/chat/ai_test/execution.ts` (`executeUiTestFlow`) saves mapping **after** test creation
  - `src/services/testing/ui/manual/test-cancellation.ts` cancels by chat session using `test_chat_mappings`
- **Why**: there is a small time window where a newly created test is not yet mapped to chat session.
- **Impact**: `cancel-all-chat` may miss the newest test in edge cases.

### 15) Inconsistent userId typing between tables (UUID vs TEXT / “anonymous”)

- **Severity**: medium
- **Where**:
  - `src/services/testing/results/intelligent-test-storage.service.ts` stores `user_id` as string (incl. `'anonymous'`)
  - other DB tables treat `user_id` as UUID
- **Why**: schema mismatch risk / inconsistent joins across tables.
- **Impact**: broken analytics/joins/authorization assumptions for intelligent sessions.

### 16) Retry flow updates status to `pending` before ensuring jobs were queued + credits deducted after queueing

- **Severity**: high
- **Where**: `src/services/testing/ui/manual/test-retry.ts`
- **Why**:
  - status is reset to `pending` before verifying job enqueue succeeded for all browsers
  - credits are deducted **after** jobs are queued (ordering mismatch with `/manual-test/run` and chat flow)
- **Impact**: status can become `pending` while nothing is queued; or jobs queued but credit deduction fails (inconsistent state).

### 17) `/api/v1/manual-test/run` middleware credit check is fixed to 1 credit

- **Severity**: low
- **Where**: `src/api/manualTest/manualTest.route.ts` (`POST /run`)
- **Why**: route uses `requireCredits(1)` even for intelligent mode; actual deduction is done later.
- **Impact**: not a functional block (deduction still enforces), but misleading/extra traffic and inconsistent policy enforcement.

### 18) Retry does not clear old `test_results`, which breaks progress/completion calculations

- **Severity**: high
- **Where**:
  - `src/services/testing/ui/manual/test-retry.ts` (does not delete old results)
  - `src/api/manualTest/manualTest.route.ts` (`GET /:id/status` uses `results.length` for progress)
  - `src/services/testing/ui/manual/test-result-processor.ts` (`checkAndHandleTestCompletion` uses all results)
- **Why**: stale results from previous runs remain and can be counted as “completed browsers”.
- **Impact**: status/progress can become incorrect (e.g. “100%” immediately after retry), and completion may be computed prematurely.

### 19) Intelligent mode stores results in two different storages (duplication + drift risk)

- **Severity**: medium
- **Where**:
  - `src/jobs/manual-test-run.job.ts` writes `test_results`
  - `src/agent/playwright/artifacts-handler.ts` writes `intelligent_test_sessions` (+ visits/actions)
- **Why**: two parallel storages for the same run without a strict linking/transaction.
- **Impact**: partial writes and drift (one stored, the other failed) causing inconsistent UI/reporting.

### 20) Chat result formatter uses wrong field for detecting intelligent mode

- **Severity**: low
- **Where**: `src/services/testing/results/test-results-formatter.service.ts`
- **Why**: it checks `test.options?.intelligentMode`, but intelligent mode is stored as a dedicated column (`tests.intelligent_mode`).
- **Impact**: wrong UX messaging (“Standard” vs “Intelligent”) and confusion in chat history.

### 21) Two different credit deduction mechanisms for UI tests (risk of divergence)

- **Severity**: medium
- **Where**:
  - `src/services/core/credit-cost-tracker.service.ts` → `UserCreditsService.deductCredits` (used by chat flow and `/manual-test/run`)
  - `src/services/testing/ui/manual/test-credits.ts` → RPC `deduct_test_credits` (used by retry flow)
- **Why**: different charging paths and metadata/transaction models can drift over time.
- **Impact**: inconsistent balances/transactions, harder debugging and potential double-charge or missing-charge edge cases.

### 22) IntelligentTest API: `getTestFlow` does not enforce ownership (sessionId enumeration risk)

- **Severity**: critical
- **Where**: `src/api/intelligentTest/intelligentTest.controller.ts` (`getTestFlow`)
- **Why**: endpoint returns flow by `sessionId` without checking that the session belongs to `req.user.id`.
- **Impact**: a user who learns a valid `sessionId` can access another user’s test flow.

### 23) IntelligentTest API: `getTestFindings` does not enforce ownership (sessionId enumeration risk)

- **Severity**: critical
- **Where**: `src/api/intelligentTest/intelligentTest.controller.ts` (`getTestFindings`)
- **Why**: it queries `intelligent_test_findings` by `session_id` only, without verifying that the session belongs to the current user.
- **Impact**: a user who learns a valid `sessionId` can access another user’s findings/bugs.

### 24) Playwright trace API is unauthenticated and trusts client-provided `userId`

- **Severity**: critical
- **Where**: `src/api/playwright/playwright.route.ts` + `src/api/playwright/playwright.controller.ts`
- **Why**:
  - all endpoints appear to be **public** (no `requireAuth`)
  - upload requires `userId` in body and uses it for storage path and DB record
  - read/list endpoints accept `userId` as query parameter for filtering, but it is optional and not tied to auth
- **Impact**: anyone can upload traces under someone else’s `userId`, list traces, and potentially access/guess trace files and test step data.

### 25) Queue status endpoints are unauthenticated and leak job metadata

- **Severity**: high
- **Where**: `src/api/manualTest/queue-status.route.ts` + `src/api/manualTest/queue-status.controller.ts`
- **Why**: endpoints are exposed without `requireAuth` and return job IDs + `testId` + browser + failure reasons.
- **Impact**: information leak (test IDs, operational data), potential reconnaissance for attackers.

### 26) Reports API does not enforce test ownership when generating/reading reports

- **Severity**: high
- **Where**: `src/api/reports/reports.controller.ts`
- **Why**:
  - endpoints are protected by `requireAuth`, but controller uses `supabaseAdmin` to fetch `test_results` by `test_id` without checking that the test belongs to `req.user.id`
  - `getReport` returns report by `testId` without ownership check (depends on how `TestReportGeneratorService.getReportByTestId` is implemented)
- **Impact**: any authenticated user could potentially access/generate a report for another user’s `testId` if they know/guess it.

### 27) TestReportGeneratorService.getReportByTestId has no ownership concept

- **Severity**: medium
- **Where**: `src/services/testing/results/test-report-generator.service.ts`
- **Why**: report retrieval is purely by `testId` using `supabaseAdmin`, without any user context.
- **Impact**: if an API endpoint calls this without validating ownership (as `reports.controller.ts` does), cross-user data exposure is possible.

### 28) Playwright trace endpoints allow read/delete/parse by `testId` or `traceId` without auth

- **Severity**: critical
- **Where**: `src/api/playwright/playwright.controller.ts`
- **Why**:
  - `getTrace`: allows fetching signed URL for a trace by `id` with optional `userId` filter (not tied to auth)
  - `listTraces`: lists by `testId` or `userId` from query
  - `getTraceFilesByUser`: lists all trace files for any `userId` from query
  - `getTraceSteps`: extracts steps for a `testId` (no ownership checks)
  - `deleteTrace`: deletes by `id` with optional `userId` filter (not tied to auth)
- **Impact**: data exfiltration (trace steps, metadata) and destructive operations (delete) by unauthenticated callers.
