# `preview-run.service.ts` — API Reference

> Source: [preview-run.service.ts](../preview-run.service.ts)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

`PreviewRunService` orchestrates "Run from start" / "Apply All". Executes an `IntentStep[]` sequentially on a live preview session with WS progress, cancel, retries (deterministic + LLM-diagnosed), best-effort DB persistence and trace upload.

- **Owns:** `activeRuns` registry (per-session run state), the run loop, retry logic, run-level WS protocol.
- **Delegates to:** `PreviewStepApplyService.applyStep()` per step, `PreviewSessionService` for the page.
- **Does NOT own** the Playwright session.

## Exports

- **Class:** `PreviewRunService` — static-only.
- **Interface:** `PreviewRunSummary` — return shape, also consumed by chat tools / AI agents.
- **Internal helpers:** `attemptLLMDiagnosisAndRetry`, `interpolateContextVariables`, `withTimeout`, `raceAbort`, `waitForDOMStability`, `collectLightPageSummary`.

---

## Public methods

### `runSavedSteps(previewSessionId, intentTestCaseId, userId, options?): Promise<PreviewRunSummary>`

- **Visibility:** `public static`.
- **Callers:** WS `preview:run:start`, API controller.
- **Parameters:**
  - `previewSessionId` — must exist and be owned by `userId`.
  - `intentTestCaseId` — DB lookup for steps + `startUrl`.
  - `options.inlineSteps?` — if provided, save to DB first then run (atomic save+run for "Apply All").
  - `options.startUrl?` — override startUrl when `inlineSteps` provided.
  - `options.authReset?: 'always' | 'never'` — clear cookies/localStorage. **Default `'never'`** since 2026-04-20 (was `'always'`, broke onboarding tours).
  - `options.startFromIndex?` — "Apply New Only" mode: skip steps `0..N-1`, no goto, no auth-reset; forces `authReset='never'`.
- **Returns:** `PreviewRunSummary`.
- **Side-effects:**
  - DB write via `IntentTestCaseService.update()` if `inlineSteps`.
  - DB read via `IntentTestCaseService.getById()`.
  - WS: `preview:run:started`, `preview:run:step`, `preview:run:completed` (via delegated `runStepsOnPreview`).
- **Throws:**
  - `"Run already in progress for this session"` — `activeRuns` collision.
  - `"Session not owned by user"`.
  - `"Test case not found or has no saved steps"`.
  - `"No steps to run"`.
  - `"Test case has no startUrl or url"` — fallback to recording-time URL also failed.
- **Key steps:**
  1. Guard `activeRuns` + ownership.
  2. Resolve steps + `startUrl` (inline → save first, else load from DB, else recording-time fallback).
  3. Clamp `startFromIndex`; force `authReset='never'` if `startFromIndex > 0`.
  4. Delegate to `runStepsOnPreview()` with `persistAppliedSteps=true`, `_skipOwnershipCheck=true`.

### `runStepsOnPreview(previewSessionId, steps, startUrl, userId, options?): Promise<PreviewRunSummary>`

- **Visibility:** `public static`.
- **Callers:** `runSavedSteps()` (with persist), chat/AI agent tools (ephemeral, no persist).
- **Parameters:**
  - `steps: IntentStep[]`, `startUrl: string`.
  - `options.intentTestCaseId?` — for trace metadata + DB persistence (only when `persistAppliedSteps=true`).
  - `options.persistAppliedSteps?` — default `false`. If `true`, batch-persist enriched steps at run end.
  - `options.authReset?` — default `'never'`.
  - `options._skipOwnershipCheck?` — internal; `runSavedSteps` sets it.
  - `options.startFromIndex?` — "Apply New Only".
- **Returns:** `PreviewRunSummary`:
  - `success` — `failedSteps === 0 && !cancelled && !timedOut`.
  - `totalSteps`, `passedSteps`, `failedSteps`, `skippedSteps`.
  - `cancelled`, `timedOut`, `duration` (ms).
  - `failedStepDetails?` — first 5 failures `{ stepIndex, description, action, error? }`.
  - `firstError?` — first failed step's error (AI-friendly summary).
- **Side-effects:**
  - WS emits (see "Events" below).
  - DB writes via `IntentTestCaseService.updateAppliedSteps()` if `persistAppliedSteps`.
  - Trace JSONL via `LiteTraceWriter`: `run_start`, `step_start`, `[url_mismatch]`, `step_result`, `run_end`.
  - Calls `PreviewStepApplyService.applyStep()` per step.
  - `diagnoseStepBlocker()` LLM on step failure.
  - `collectLightPageSummary()` for fail context.
  - Mutates session: `lastSnapshotEmit`, `lastPageSignature`, closes extra tabs.
  - Mutates `activeRuns[previewSessionId]`.
- **Throws:**
  - `"Run already in progress for this session"`.
  - `"Session not owned by user"` (unless `_skipOwnershipCheck`).
  - `"Session has no active page"`.
- **Key steps:**
  1. Guard `activeRuns` + ownership.
  2. Initialize `RunState` (running, cancelled, startTime, abortController, currentStepIndex).
  3. Set global timeout: `min(15min, 60s + 15s × steps)`.
  4. Acquire page; init `LiteTraceWriter`, `StepTelemetryCollector`.
  5. Emit `preview:run:started`.
  6. Reset session state, close extra tabs.
  7. **Navigation block** (skipped if `startFromIndex > 0`):
     - Detect if already on `startUrl`; reload, else goto.
     - Clear cookies/localStorage if `authReset === 'always'` → emit `preview:run:auth-reset`.
     - `waitForDOMStability()` post-navigation.
     - URL-mismatch detection → emit `preview:run:url-mismatch`.
  8. **Step loop:**
     - Per-step URL-mismatch check.
     - Interpolate `{{email.otp}}`, etc.
     - `applyStep()` with abort signal + URL-based cache policy (disableCaching if URL changed since last step).
     - On success: emit `'pass'`, update tracked URL, lookahead wait for next step (7-layer via `runV1WithShadow()` — runs V1 and V2 step-readiness in parallel, logs divergence, returns V1 result; V2 result is diagnostic only).
     - On failure: deterministic retry (settle 1.5s, re-execute); if still fails, LLM diagnosis + selector wait + retry once.
     - On cancel: emit remaining as `'skipped'` and break.
     - On timeout: set flag, abort, break.
  9. **Cleanup (finally with timeout guards):**
     - Clear timeout, release `activeRuns`.
     - Emit `preview:run:completed`.
     - Close trace writer (10s cap); fire-and-forget upload to Storage.
     - Best-effort email-inbox cleanup.
- **Invariants / gotchas:**
  - **One run per session** (`activeRuns` guard).
  - **`authReset` default `'never'`** (changed 2026-04-20). Clearing localStorage broke `joyride:seen` and similar onboarding state.
  - **`startFromIndex` skips goto + auth-reset.** Caller must ensure preview is in correct state.
  - **URL-based cache policy.** `disableCaching` if URL changed since previous step → avoids stale locator plans.
  - **Global timeout** scales with step count: 5 steps ≈ 2.25min, 20 ≈ 6min, 100 hits 15min cap.
  - **Step retry:** deterministic first; if confident + retryable, LLM diagnosis + suggested selector wait → one retry.
  - **Lookahead wait** after pass uses 7-layer readiness (nav race, DOM stable, API idle, animations, overlays, element visible, action-specific).
  - **Cancel propagation** via `AbortSignal`. `raceAbort(promise, signal)` interrupts long ops.
  - **Per-step trace** (`step_start` / `step_result`) for postmortem correlation.
  - **Fake-success guard** lives in `PreviewStepApplyService`; `runStepsOnPreview` honours its FAIL.
  - **30s hard-purge** of `activeRuns` if finally crashes (prevents deadlock).

### `cancelRun(previewSessionId, userId): boolean`

- **Visibility:** `public static`.
- **Callers:** WS `preview:run:cancel`; session cleanup.
- **Returns:** `true` if an active run was cancelled, `false` if there was nothing to cancel.
- **Side-effects:** when a run is active, sets `runState.cancelled = true` and calls `runState.abortController.abort()`.
- **Throws:** `"Session not owned by user"` (only when a run IS active and owned by another user).
- **Notes:**
  - Owner-checked (no cross-user cancel) — the owner check runs only after confirming a run exists.
  - **Idempotent:** safe to call when no run is active — returns `false` (no throw). The frontend fires `preview:run:cancel` as best-effort cleanup on editor/preview close, by which point the run has usually already finished; treating "nothing to cancel" as an error previously produced noisy `error` logs + a spurious `INTERNAL_ERROR` on the socket for a normal close.
  - For unconditional teardown (browser close, idle timeout) use `forceCancelOnSessionStop`, which additionally skips the owner check.

### `forceCancelOnSessionStop(previewSessionId): void`

- **Visibility:** `public static`.
- **Callers:** `PreviewSessionService.stopSession()` (browser close, idle timeout, user ends preview).
- **Side-effects:** sets cancelled + aborts, **silent no-op if no run**. Schedules 30s hard-purge as cleanup safety net.
- **Throws:** never.
- **Notes:**
  - No owner check (lifecycle-driven).
  - Does NOT delete `activeRuns` itself — finally block does that. The 30s timeout is a safety net for crashed finally.

### `isRunning(previewSessionId): boolean`

- **Visibility:** `public static`.
- **Callers:** recording state machine (blocks new captures during a run); UI status.
- **Returns:** `runState?.running && !runState?.cancelled`.
- **Side-effects:** none.

### `__dangerousClearRunsForTests(): void`

- **TEST ONLY.** Clears module-scoped `activeRuns`. Do not call in production code.

---

## Constants

```ts
const BASE_RUN_TIMEOUT_MS    = 60 * 1000;       // 1 min setup budget
const PER_STEP_TIMEOUT_MS    = 15 * 1000;       // 15s per step
const MAX_RUN_TIMEOUT_MS     = 15 * 60 * 1000;  // 15 min hard cap
const CLEANUP_TIMEOUT_MS     = 10_000;          // finally block budget
const RETRY_SETTLE_MS        = 1500;            // pre-retry settle
const NO_RETRY_STEP_TYPES    = new Set([
  'ai_check','wait','wait_for_email','dialog','download','switch_tab',
]);
const URL_MISMATCH_HINT_MAX_STEPS = 5;

// V26 — per-run compiled-plan failure budget
const MAX_COMPILED_FAILS_IN_ROW = 3;   // disable compiled planning after N consecutive misses
const MAX_COMPILED_FAILS_TOTAL  = 5;   // also disable after N cumulative misses across the run
```

**Compiled-failure budget (V26).** Two run-scoped counters (`compiledFailuresInRow`, `compiledFailuresTotal`) decide when to stop building compiled plans for the rest of the run:

- Consecutive failures: a successful step **resets `inRow` to 0**, a compiled-plan miss increments it. At `≥ MAX_COMPILED_FAILS_IN_ROW (3)`, compiled planning is disabled.
- Total failures: incremented on every miss, never reset. At `≥ MAX_COMPILED_FAILS_TOTAL (5)`, compiled planning is disabled.
- Replaces the old "skip compiled after first failure" rule. Allows recovery from a single bad plan while still catching post-deploy regressions where every plan is stale.

## Env vars

- **`PREVIEW_TRACE_DECISIONS`** (V23) — when truthy, every `preview:run:step` event includes the full `decisionTrace` payload. In `NODE_ENV !== 'production'` it defaults to ON. In production it defaults to OFF — opt in per deploy when capturing postmortems. The gate lives in `shouldEmitDecisionTrace()`.

## State

```ts
const activeRuns = new Map<string, RunState>();

interface RunState {
  running: boolean;
  cancelled: boolean;
  startTime: number;
  currentStepIndex: number;
  abortController: AbortController;
}
```

- One entry per session max. Released by finally block; 30s hard-purge as safety net.

---

## WebSocket events emitted

### `preview:run:started`
```ts
{ previewSessionId, totalSteps, startUrl, ephemeral, timestamp }
```
`ephemeral=true` for draft runs (`persistAppliedSteps=false`).

### `preview:run:auth-reset`
```ts
{ previewSessionId, cleared, timestamp }
```
Only when `authReset === 'always'`.

### `preview:run:url-mismatch`
```ts
{ previewSessionId, recordedUrl, actualUrl, sameOrigin, sourceStepIndex, timestamp }
```
`sameOrigin=false` typically means SSO redirect.

### `preview:run:step`
Status-discriminated:
- `'running'` — `{ stepIndex, stepId, action, description }`.
- `'pass'` — adds `url?`, `appliedStep?` (enriched), `retried?`.
- `'fail'` — adds `error` (augmented), `failScreenshot?` (base64 JPEG, 500KB cap), `failPageSummary?` (`{ url, title, headings, landmarks }`).
- `'skipped'` — minimal payload.
- `'cancelled'` — emitted as `skipped` when run was cancelled.

**V23 — optional `decisionTrace?` field.** All emit sites for `pass` / `fail` / `skipped` may carry `decisionTrace: StepDecisionTrace` (the same payload returned by `PreviewStepApplyService.applyStep()` — see [preview-step-apply.md](preview-step-apply.md)). Inclusion is gated by the `shouldEmitDecisionTrace()` helper (module-private) which returns `true` when `PREVIEW_TRACE_DECISIONS` env var is truthy or `NODE_ENV !== 'production'`. In production the field is omitted to keep WS payloads small; turn the env on per-deploy for postmortem capture.

### `preview:run:completed`
```ts
{
  previewSessionId, success, totalSteps,
  passedSteps, failedSteps, skippedSteps,
  cancelled, timedOut, duration, timestamp,
  stepTelemetry?: {
    firstNavigationTime?, avgStepDuration?, longestStepDuration?, ...
  },
}
```
Always emitted, even on error/timeout.

---

## Related

- [preview-step-apply.md](preview-step-apply.md)
- [preview-session.md](preview-session.md)
- [step-readiness.md](step-readiness.md)
- `IntentTestCaseService`, `StepTelemetryCollector`, `LiteTraceWriter`, `diagnoseStepBlocker()`.
