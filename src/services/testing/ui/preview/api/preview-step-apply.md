# `preview-step-apply.service.ts` — API Reference

> Source: [preview-step-apply.service.ts](../preview-step-apply.service.ts) (~2634 lines)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

`PreviewStepApplyService` executes a single user-directed step on a live preview browser session. Main entry for the "Apply" button in the editor — resolves elements, waits for readiness, performs the action (click, type, navigate, etc.), verifies post-action effect, guards against fake-success.

- **Owns:** action execution dispatch, post-action verification, compiled plan rebuild, fake-success guard.
- **Delegates to:** `IntentStepLintService` (candidate scoring), `LocatorPlanBuilder` (locator chain), `element-resolver.service` (LLM/vision fallback), `smartStepWait` (readiness phases).
- **Stateless:** all persistent state lives in `PreviewSessionService`.

## Exports

- **Class:** `PreviewStepApplyService` — single static method `applyStep()`.
- **Functions:**
  - `globToRegexPatternForWaitFor(glob: string): string`
  - `normalizeTypeActionValue(rawValue: string | undefined): string`
- **Types:** `ApplyResult`, `ClickPreState`, `ClickEffectSignal` (`'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'none'`), `StepDecisionTrace` (V23).
- **Re-exports:** `getEffectiveLabel(node)` is imported from [element-resolver.service.ts](../element-resolver.service.ts) and used throughout for canonical label extraction (title / alt / iconLabel / svgIcon / childTestId / customElementTag fallbacks). Trace consistency depends on it.

---

## Public methods

### `PreviewStepApplyService.applyStep(params): Promise<ApplyResult>`

```ts
static async applyStep(params: {
  previewSessionId: string;
  stepDraft: IntentStep;
  pageRef?: string;
  userId: string;
  selectedRef?: string;          // V3: user-confirmed element from clarify
  skipPostActionWait?: boolean;  // V12: caller handles settle via lookahead
  expectsNavigation?: boolean;   // V13: next step expects URL change
  skipCompiled?: boolean;        // ignore cached compiled plan
}): Promise<ApplyResult>
```

- **Visibility:** `public static`
- **Callers:** WS handler `preview:step:apply`; `PreviewRunService.runStepsOnPreview()` per step.
- **Parameters:**
  - `previewSessionId` — session UUID (must be owned by `userId`).
  - `stepDraft` — step (type, target, value, options).
  - `selectedRef` — user-picked element from clarification dialog; bypasses lint/resolver.
  - `skipPostActionWait` — skip DOM settle when caller will lookahead next step.
  - `expectsNavigation` — wraps click with `waitForNavigation` to capture URL change reliably.
  - `skipCompiled` — rebuild plan even if cached.
- **Returns `ApplyResult`:**
  - `success: boolean`
  - `error?: string`
  - `appliedStep?: IntentStep` — step enriched with evidence + compiled plan.
  - `urlChanged?: boolean`, `url?: string`
  - `attempts: number`
  - `highlight?: Array<{ ref, boundingBox, type }>` — elements to highlight in UI for debugging.
  - `fastPathSettled?: boolean` — `wait_for` took fast-path (URL already changed).
  - `waitForBranch?: 'fast_path' | 'runtime_settle' | 'runtime_changed' | 'slow_path' | 'no_matcher'`.
  - **`decisionTrace?: StepDecisionTrace` (V23)** — structured postmortem trace populated on every return path. Primary diagnostic surface; see schema below.
  - **`planQuality?: { unverified: boolean; reason?: string }` (V25)** — when a compiled plan was written but its validation failed (all locators dead, validation skipped, no validated matches), this flag tells callers the plan exists but should not be trusted as evidence on the next apply.
- **Side-effects:**
  - Playwright actions on the live page.
  - WS emits: `preview:loading` (navigate progress), session state on tab switches and dialogs.
  - Trace writes: `step_start`, `step_result` events (LiteTraceWriter).
  - **`decisionTrace` aggregation (V23):** mutated throughout every code path (compiled / identity / evidence / lint / LLM / overlay / click-effect). Initialized at action entry, populated by each stage, returned on `ApplyResult.decisionTrace`. Structured logging contract — not a WS emit.
  - Updates session `contextData` (for `store` meta-steps).
  - May auto-switch active tab if `step.tabIndex` differs (V15).
  - **LLM cache invalidation on rejection (V25):** when a pre-click or post-click guard rejects the resolver pick, two caches are invalidated for that pageUrl/intent: `invalidateTokensForText(recordedText)` (stable-tokens) and `invalidatePrunerForRef({ rejectedRef, pageUrl, intentText })` (candidate pruner). Logged but not surfaced in `ApplyResult`. Rationale: cached output that produced a wrong pick once should be re-derived next run.
  - **Fingerprint backfill on success (V26):** on successful click (compiled or LLM path), stable identity fields are copied from the live node into `appliedStep.recordedFingerprint` **only when the recorded slot is empty** (never overwrites). Backfilled fields: `firstTextFragment`, `href`, `elementId`, `testIdAttr`, `name`, `alt`, `svgIcon`, `iconLabel`, `customElementTag`, `cssClass`, `ariaControls`, `vueScopeId`, `childTestId`, `nearestLandmark`, `title`, `containerTitles`. Logged as `[PREVIEW_APPLY] Backfilled missing identity fields`. Rationale: keep authored steps catching up to recorder fidelity over time.
  - **Failure evidence (V26):** failure paths route through `_buildFailureResult()` which calls `collectFailureEvidence()` and attaches a `StepFailureEvidence` bundle to the trace. Persisted by the WS handler if `intentTestCaseId` is set (see [preview-handler.md](preview-handler.md) `preview:step:needs-review`).
- **Throws:** `Error` on session not found, DOM selection failure, action timeout, unrecoverable Playwright error.
- **Key steps:**
  1. **Scratchpad interpolation** — resolve `{{key}}` placeholders from session `contextData`.
  2. **Meta-step handling** — `store`, `switch_tab`, `dialog`, `download` are non-action; handled and returned early.
  3. **Auto-tab-switch** — if `step.tabIndex !== activeTabIndex`, switch first.
  4. **Non-targeting actions** — `navigate`, `wait`, `scroll`, `wait_for` execute without element targeting; return early.
  5. **Element resolution** — `IntentStepLintService.lintStep()` for candidates; try `selectedRef` first, then top candidates with retry.
  6. **Readiness wait** — `smartStepWait(phase: 'pre')` action-specific (click → actionable+modal-clear, type → editable, …).
  7. **Execute action** — dispatch to action handler (see `executeAction` below).
  8. **Post-action verify** — detect URL change, dialog, focus shift, detach, new tab, DOM change, ARIA change.
  9. **Fake-success guard** — weak signal + fingerprint mismatch + has ground truth → FAIL despite action completion.
  10. **Compiled plan rebuild** — on success, upgrade compiled plan for offline use.
- **Invariants / gotchas:**
  - **Modal blocking guard (V11):** non-targeting actions skip modal detection; targeting actions return early if modal detected before action.
  - **URL fast-path (V13/V15):** if `wait_for.changedFrom` URL already differs from current URL, skip URL-wait and settle DOM (3s budget). Avoids race when previous click had `expectsNavigation`.
  - **Budget split for `wait_for` (V13):**
    - Auto-injected: 2s URL wait → 3s page-settle fallback.
    - Manual: `(timeoutMs - 1.5s)` URL wait → 1.5s settle fallback.
  - **Post-action buffer (V15.3):** `noWaitAfter: true` actions get +1s before snapshot invalidation so handlers run.
  - **Field-session single-shot:** `type` records one input.value snapshot from blur/navigation; if value didn't change, the recording event is removed, not stored.
  - **Fake-success trap:** weak signal (`focus`/`none`/`newtab`) + fingerprint mismatch + recorded fingerprint → FAIL even if action succeeded.
  - **Soft-pass on no-effect (V23):** when a manually-added step (no recorded fingerprint) executes against a plausible candidate but produces no observable effect, the action is accepted as success and `decisionTrace.softPassedOnNoEffect = true`. Prevents stalling on idempotent / already-in-state actions; trace flag lets postmortem audit the relaxed acceptance.
  - **Substring text-field tolerance (V23):** in fuzzy text-field matching the candidate scoring now allows morphological variants (3-char substring or prefix overlap) before falling back to Damerau-Levenshtein. Affects RU/KZ/multilingual sites where stem variation previously dropped valid candidates.
  - **`LocatorPlanBuilder.buildCompiledPlan()` is async (V26).** Every call site now uses `await`. Treat this as a breaking signature change for anyone building plans outside this service.
  - **Recorded fingerprint is authoritative; backfill never overwrites (V26).** Only empty slots are filled.
  - **Plan-quality flag (V25).** If `planQuality.unverified === true`, callers should rebuild the plan rather than treat it as evidence on the next run.

---

## `StepDecisionTrace` (V23)

Structured payload returned in `ApplyResult.decisionTrace`. Every resolver path, overlay block, and click-effect verification populates the relevant section. Used by editor postmortem UI and trace JSONL aggregation.

| Field | Meaning |
|---|---|
| `resolverPath` | Which path resolved the element (`compiled` / `identity_id` / `identity_testid` / `identity_svgicon` / `identity_custom_element` / `evidence_shortcut` / `llm` / `vision` / `not_found`). |
| `compiled` | `{ tried: boolean, hit: boolean, strategy?, fallthroughReason? }` — compiled fast-path attempt and why it fell through. |
| `identity` | Identity fast-path diagnostics: `{ recordedId?, recordedTestId?, liveIdsSample?, idMatch?, uniqueness? }`. |
| `evidence` | Evidence-shortcut diagnostics: `{ lastSuccessRef?, hit?, reason? }`. |
| `llm` | LLM stage breakdown: `{ candidatesCount, prepareMs, llmCallMs, postMs, promptChars, confidence?, slaBreached? }`. |
| `chosen` | Snapshot of the picked element: `{ ref, label, role, tag, testId? }` (label via `getEffectiveLabel`). |
| `recorded` | Recorded fingerprint snapshot when present. |
| `fingerprintMatch` | `'match' \| 'mismatch' \| 'missing'` verdict against `recorded`. |
| `overlayBlock` | If overlay detected: `{ blocked: boolean, blockerRef?, recoveryAttempted? }`. |
| `clickEffectSignal` | Post-action effect (`url` / `dialog` / `aria` / `focus` / `detach` / `dom` / `newtab` / `none`). |
| `softPassedOnNoEffect` | `true` when V23 soft-pass accepted an action with no observable effect (manual-add only). |
| `timing` | Phase breakdown: `{ readinessMs, resolveMs, actionMs, postVerifyMs, totalMs }`. |
| `failureBundle` | (V26) `StepFailureEvidence` attached on failure paths via `_buildFailureResult()` + `collectFailureEvidence()`. Powers `preview:step:needs-review` WS event and DB persistence. |

---

## Critical private helpers

### `waitForPageSettled(page, timeoutMs, _quietMs): Promise<boolean>`

- **Visibility:** private async.
- **Purpose:** detect when DOM mutations have settled to baseline noise (animations done, React paused).
- **Returns:** `true` if quiet, `false` on timeout.
- **Algorithm:**
  - MutationObserver on `document.body`.
  - Slice timeline into 200ms windows.
  - Skip first 400ms (action burst).
  - Establish baseline = lowest mutation count per window post-burst.
  - Settled when current window ≤ `1.5 × baseline` OR ≤ 2 mutations/window absolute.
- **Constants:** `WINDOW_MS=200`, `OBSERVATION_BURST_MS=400`, `ABSOLUTE_QUIET=2`, `BASELINE_MULT=1.5`.

### `executeWaitFor(page, matcher, timeoutMs, isAutoInjected)`

- **Visibility:** private async.
- **Purpose:** SPA-safe URL/state waiting via `page.waitForFunction`.
- **Returns:** `{ success, error?, degraded? }` — `degraded === 'page_settled'` on URL fallback.
- **Matcher precedence:** `changedFrom` → `regex` → `glob` → `substring` → `domain`.
- **V13 URL-change fallback:** on `changedFrom` timeout, try `waitForPageSettled()` as degraded signal. Budget depends on `isAutoInjected`.
- **V13 context-lost short-circuit:** if execution context destroyed (cross-origin nav), check final URL vs `changedFrom`; treat as success if different.
- **Recovery:** empty matcher → synthesize `changedFrom: currentUrl` to prevent 1ms early returns on stale steps.

### `executeAction(page, step, candidate, preResolvedLocator?, options?)`

- **Visibility:** private async.
- **Purpose:** action dispatch (click, type, select, hover, press, scroll, navigate, wait, assert, upload, …).
- **Returns:** `{ success, error?, urlChanged }`.
- **Action types:**
  - `type` — text input with special-input detection (range/color/date), paste mode, human-like typing, post-blur validation.
  - `click` — optional modifiers, hover+pause, new-tab detection, optional `waitForNavigation`.
  - `select` — native `<select>` vs custom dropdown.
  - `hover` — retry on overlay block, adaptive post-hover settle.
  - `press` — key on element or page.
  - `scroll` — element/window/container, post-scroll settle.
  - `wait`, `navigate`, `assert` — straightforward.
  - `upload` — file chooser or drag-drop fallback (V9).
  - State-verifiable: `dblclick`, `contextmenu`, `drag_and_drop`, `toggle`, `check`, `uncheck`, `open`, `close`.
- **Pre-action wait:** `smartStepWait(phase: 'pre')` unless `disableStabilityChecks`.
- **Post-action settle:** implicit in Playwright; some actions use `noWaitAfter: true` + 1s buffer (V15.3).

### `shouldUpgradeCompiledPlan(existing, candidate): boolean`

- **Visibility:** private static.
- **Purpose:** returns `true` if the freshly-built `candidate` plan is stronger than `existing` — i.e., adds new strategy types or has a higher-priority primary strategy (per `STRATEGY_RANK`).

### `derivePlanQuality(compiled): { unverified, reason? } | undefined`

- **Visibility:** private static.
- **Purpose:** derives the `planQuality` field. Returns `undefined` on happy path; `{ unverified: true, reason }` when validation was skipped, all locators were dead, or no validated locators remain. Possible `reason` values: `'validation_skipped'`, `'all_locators_dead'`, `'no_validated_locators'`.

### `buildBindingHintsFromNode(node): BindingHints`

- **Visibility:** private static.
- **Purpose:** builds a full `BindingHints` object (15+ fields) from a live resolved `InteractiveNode`. Includes Angular-specific fields (`routerLink`, `formControlName` — Etap 1B.2), ARIA state snapshot (`ariaExpanded`, `ariaPressed`, `checked`, etc.), and full spatial context (`containerTitles`, `nearestLandmark`, `siblingIndex`, etc.). Mirrors V22 recorder hint symmetry for manually-added steps.

### `buildSyntheticFingerprintFromNode(node): TargetFingerprint`

- **Visibility:** private static.
- **Purpose:** synthesizes a `recordedFingerprint` from a live LLM-resolved node (for manually-added steps that have no recorder-captured fingerprint). Only called when the node has stable identity fields.

### `dismissParasiticOverlay(page, step, locatorContext): Promise<boolean>`

- **Visibility:** private async (Etap 1A.5).
- **Purpose:** conditionally dismisses lightweight overlays (cookie banners, tooltip-style blocker) that appear between readiness check and action. Returns `true` if an overlay was dismissed.

### `_buildFailureResult(opts): ApplyResult`

- **Visibility:** private static (V26 Batch A).
- **Purpose:** centralized failure-result factory. Calls `collectFailureEvidence()`, attaches a `StepFailureEvidence` bundle, sets `decisionTrace.failureBundle`. Used by every failure path to ensure uniform evidence capture. `originatingStrategy` enum identifies which resolver stage failed.

### `captureClickPreState(page, step): Promise<ClickPreState>`

- **Visibility:** private async.
- **Returns:** `{ urlBefore, focusedRef, recordedFingerprint }`.
- **Used by:** `verifyClickHadEffect`.

### `verifyClickHadEffect(page, preState): Promise<ClickEffectSignal>`

- **Visibility:** private async.
- **Returns:** discriminator `'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'none'`.
- **Signals:**
  - `'url'` — page URL changed.
  - `'focus'` — focused element changed.
  - `'dom'` — new elements appeared or recorded element detached.
  - `'aria'` — ARIA state (`checked`, `expanded`, `pressed`) changed.
  - `'dialog'` — `alert/confirm/prompt` opened.
  - `'newtab'` — `target="_blank"` opened a new tab.
  - `'detach'` — recorded element no longer in DOM.
  - `'none'` — nothing observable.

### `verifyModalActuallyBlocks(page, modal): Promise<boolean>`

- **Visibility:** private async.
- **Purpose:** confirm modal is real before treating it as a blocker; rejects phantom/invisible modals.

### `detectOverlayBlockingCandidate(page, candidate): Promise<boolean>`

- **Visibility:** private async.
- **Purpose:** check if a specific click target is overlapped by an overlay before action.

### Exported helpers

- `globToRegexPatternForWaitFor(glob)` — convert glob (`/user/*/profile`) to regex for `wait_for`.
- `normalizeTypeActionValue(rawValue)` — preserve exact whitespace/newlines (undo frontend trimming).

---

## Constants & timing values

| Constant | Value | Meaning |
|---|---|---|
| `MAX_ATTEMPTS` | `STEP_APPLY_CONFIG.maxAttempts` | Candidate retry budget. |
| `ACTION_TIMEOUT` | `STEP_APPLY_CONFIG.actionTimeoutMs` | Default action timeout. |
| `POST_ACTION_SETTLE_TIMEOUT` | `STEP_APPLY_CONFIG.postActionSettleTimeoutMs` | DOM-settle wait after action. |
| `WINDOW_MS` | `200` | MutationObserver window. |
| `OBSERVATION_BURST_MS` | `400` | Skip-window at action start. |
| `ABSOLUTE_QUIET` | `2` | Mutations/window threshold for static pages. |
| `BASELINE_MULT` | `1.5` | Settle threshold multiplier. |
| `SETTLE_MAX_MS` (auto-inject) | `3000` | Page-settle fallback for auto-injected `wait_for`. |
| `SETTLE_MAX_MS` (manual) | `1500` | Page-settle fallback for manual `wait_for`. |
| `FILECHOOSER_QUICK_TIMEOUT` | `3000` | Upload dialog wait. |

## Internal action sets

```ts
STATE_VERIFIABLE_ACTIONS = new Set([
  'check','uncheck','toggle','open','close','type','click','upload',
]);
NON_TARGETING_ACTIONS = new Set([
  'navigate','wait','scroll','wait_for','ai_check','wait_for_email','dialog','download',
]);
DOM_MUTATING_ACTIONS = new Set([
  'hover','click','open','close','toggle','dblclick','contextmenu','drag_and_drop',
]);
POST_ACTION_BUFFER_ACTIONS = new Set([
  'click','dblclick','contextmenu','press','type','toggle','check','uncheck','open','close',
]);
```

## State

Service is stateless. Persistent state lives in:
- `PreviewSessionService` — page context, snapshots, DOM cache, active tab, dialog handlers, `contextData`.
- `IntentTestCase` rows — drafts, compiled plans.
- In-page `window.__qaitSettleState` — MutationObserver state for `waitForPageSettled`.

---

## Notable details

- **`{{key}}` interpolation** at apply time enables cross-step data flow (OTPs, extracted text, IDs).
- **V3 `selectedRef` override** bypasses lint/resolver entirely.
- **V13 `expectsNavigation`** wraps click with `waitForNavigation`.
- **V13 auto-tab-switch** retries via async popup handlers.
- **V15.3 `noWaitAfter`** for fast actions; lookahead handles inter-step settle.
- **V15 `wait_for` fast-path** when URL already changed.
- **Download verification** waits for download event, checks filename, cancels (preview never saves files).
- **Post-blur validation** for long text inputs catches frameworks that lose `fill()` content.

## See also

- [.claude/rules/wrong-element-debugging.md](../../../../../../.claude/rules/wrong-element-debugging.md)
- [element-resolver.md](element-resolver.md)
- [intent-step-lint.md](intent-step-lint.md)
- [step-readiness.md](step-readiness.md)
- [locator-plan-builder.md](locator-plan-builder.md)
