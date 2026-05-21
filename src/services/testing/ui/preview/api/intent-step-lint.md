# `intent-step-lint.service.ts` — API Reference

> Source: [intent-step-lint.service.ts](../intent-step-lint.service.ts) (~85KB)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

Lints user-written step descriptions against the live page → returns 0–5 ranked candidates with confidence scores, ambiguity detection, clarification messages and degraded-mode fallback. **Wraps** [element-resolver.service.ts](../element-resolver.service.ts) — the resolver returns "best single match", lint adds candidate scoring, multi-candidate gating, UI clarification flow, and graceful behaviour when the LLM is down.

**Callers:**
- Editor "Find" button (debounced lint, `forceFreshSnapshot=true`)
- [preview-step-apply.service.ts](../preview-step-apply.service.ts) — pre-flight check before execute
- [preview-run.service.ts](../preview-run.service.ts) — LLM diagnosis on failure
- Tests — candidate ranking, scoring edge cases

## Exports

### Class
`IntentStepLintService` — static-only.

### Functions
- `isEvidenceShortcutNodeCompatible(step, node, pageUrl): { ok, reason }` — exported for testing; validates a cached node against the action type.

### Imports of note
- `getEffectiveLabel` from [element-resolver.service.ts](../element-resolver.service.ts) (V23) — canonical label resolution for clarification examples, candidate rendering, and recorded-fingerprint text-token collection. Replaces the ad-hoc `labelText || ariaLabel || text || placeholder` chain in 3+ locations and keeps lint output consistent with apply-time traces.

### Types (re-exported from `preview.types.ts`)
- `LintResult`, `LintCandidate`.
- `LintStatus = 'resolved' | 'ambiguous' | 'not_found' | 'error' | 'needs_clarification'`.

### Constants
- `WEIGHTS` — scoring multipliers (see table below).
- `CONFIDENCE` — thresholds (HIGH=0.8, MEDIUM=0.5, LOW=0.3, RULE_SCORE_FLOOR=0.15, AI_FALLBACK_THRESHOLD=0.4, AMBIGUOUS_THRESHOLD=0.15).
- `ACTION_TO_ELEMENT_TYPES` — action → tag mapping (`type: ['input','textarea','div']`, etc.).
- `WRITABLE_ACTIONS` — `{ fill, type, clear }`.
- `STATE_AWARE_ACTIONS` — `{ check: { requiredState: 'unchecked', field: 'checked' }, … }`.
- `DEGRADED_FP_WEIGHT = 0.7`, `DEGRADED_BBOX_WEIGHT = 0.3` — fingerprint-driven re-rank in degraded mode.

---

## Public methods

### `lintStep(params): Promise<LintResult>`

Pure rule-based, no LLM. Used as fallback and for tests.

- **Parameters:** `previewSessionId`, `stepDraft`, `pageRef?`, `userId`.
- **Returns:** `LintResult` with `status: 'resolved' | 'ambiguous' | 'not_found' | 'error'`, `confidence (0–1)`, top-5 `candidates`, `message`, `highlight: [{ ref, boundingBox, type: 'success'|'warning'|'error' }]`.
- **Side-effects:** snapshot fetch via `getPreviewSessionService().getSnapshot()`; audit log to `intent_resolve.log`. **No LLM calls.**
- **Throws:** never (errors come back as `status: 'error'`).
- **Key steps:**
  1. Snapshot of interactive nodes.
  2. Non-targeting actions (navigate, wait, …) return `'resolved'` early.
  3. `scoreCandidate()` per node.
  4. Hard-reject invisible / disabled / readonly-for-fill / state-mismatch.
  5. Filter `score > 0`, sort desc.
  6. Floor check: if top confidence < `RULE_SCORE_FLOOR (0.15)` → `'not_found'`.
  7. Ambiguity: `(top - runner-up) / top ≤ AMBIGUOUS_THRESHOLD (0.15)` → `'ambiguous'`.
- **Gotchas:**
  - **Score floor 0.15** — tag-only matches (no label/aria/text overlap) drop to `'not_found'` instead of misleading "did you mean?".
  - **Hard rejects can have score 0.** Filtered, never shown.
  - **Max-score denominator** uses label+role+type+autocomplete weights, not all weights summed.

### `lintStepWithAI(params): Promise<LintResult>`

Main entry. Calls `resolveElement()` (LLM + vision); falls back to rule-based on degraded LLM.

- **Parameters:**
  - `previewSessionId`, `stepDraft`, `pageRef?`, `userId`.
  - `includeAlternatives?: boolean` — return full candidate list (default `false`).
  - `forceFreshSnapshot?: boolean` — bypass 500ms snapshot cache (set by Find button & apply).
  - `auditTrigger?: 'find_button' | 'auto_lint' | 'apply_prelint' | 'pick_dry_run' | 'other'` — audit label. `pick_dry_run` is set by `preview-element-pick.service.ts` when the picker validates a captured element (May 2026).
- **Returns `LintResult` with optional fields:**
  - `degradedMode?: boolean`, `degradedReason?: 'url_mismatch' | 'llm_timeout' | 'llm_error' | 'circuit_breaker_open'`.
  - `cacheHit?: boolean` — evidence shortcut hit (confidence `0.95`).
  - `clarificationQuestion?: string` — LLM-generated "did you mean?" message.
  - `interpretation?: string` — one-line summary of what the user wants.
  - `aiFallbackReason?: 'semantic_zero'` — resolver found nodes but none semantically match.
  - **`phaseTimings?: { snapshotMs, resolveMs, totalMs, domNodeCount }` (V23)** — per-phase performance breakdown. `snapshotMs` includes DOM collection + extraction; `resolveMs` is the resolver call; `totalMs` is end-to-end; `domNodeCount` is the size of the candidate pool. Used by editor latency tracing and slow-page diagnostics (logs warn when `snapshotMs > 1000`).
- **Side-effects:** snapshot fetch (forced or 500ms cached); LLM call via `resolveElement()`; vision rescue if needed; trace writes to `EditorTraceService`; AI activity feed via `withAIContext()`. **(V26)** the entire body is wrapped in `withAIContext({ userId })` so every downstream LLM call (resolver, candidate-pruner, vision) is logged against the user via `AsyncLocalStorage` — without this wrapper LLM calls were dropped as "no userId" and never billed/audited.
- **Throws:** never.
- **Key steps:**
  1. Non-targeting actions → `'resolved'` early.
  2. **URL guard:** step recorded on URL A, lint on URL B → `'not_found'` "wrong page" (avoids showing random links). **Identity rescue escape hatch (V26):** if a TIER-1 signal (`elementId`, `testIdAttr`, `href`, or `htmlName`) has a unique live match, the URL guard is suppressed and identity fast-path fires instead — prevents false `not_found` when compiled plan baked a destination URL post-action. Source of truth: `evidence.pageUrl` preferred over `compiled.context.pageUrl` (evidence is capture-time, compiled can drift).
  3. **Evidence shortcut:** `lastSuccessRef` cached, still visible, action-type compatible → `'resolved'`, conf `0.95` (zero-cost).
  4. **`resolveElement()`** → candidates or `needs_clarification`.
  5. Resolver degraded → `lintStepWithRuleBasedFallback()` with real cause.
  6. Resolver returned `semantic_zero` → generate clarification, return `needs_clarification`.
  7. `needs_clarification` → `generateClarificationQuestion()` for scenario-aware message.
  8. Trace every path to JSONL.
- **Gotchas:**
  - **Evidence-shortcut TTL 60 min** (`EVIDENCE_REF_TTL_MS`) OR session started after evidence recorded → invalid. Prevents stale refs across reloads.
  - **URL-guard normalization** = origin + pathname only; SPA same-URL different-content is NOT caught.
  - **`includeAlternatives=false` (default)** returns 0 candidates on resolved/not_found/error; only `needs_clarification` returns the candidate list for UI selection.
  - **Degraded fallback** passes the real cause to clarification — message blames LLM outage, not the user's wording.
  - **Screenshot is lazy:** captured only when vision rescue triggers (not eager).

---

## Critical private helpers

### `lintStepWithRuleBasedFallback(params, snapshot, resolverDegradedReason?)`

- **Caller:** `lintStepWithAI()` only.
- **Returns:** `LintResult` with `degradedMode: true, degradedReason: <cause>`.
- **Steps:**
  1. `lintStep()` (rule-based).
  2. Confidence ≥ `0.7` → return `resolved` immediately.
  3. No candidates → return `not_found`.
  4. Multiple low-conf candidates: `rankCandidatesByFingerprint()` against `stepDraft.compiled.targetFingerprint`.
  5. Fingerprint winner score ≥ `0.55` AND margin ≥ `0.12` → return `resolved`.
  6. Else → `generateClarificationQuestion(scenario='AI_DEGRADED')` → `needs_clarification`.

### `scoreCandidate(node, step)` → `{ score, reasons, hardReject }`

Stateless scorer. Hard rejects: disabled; readonly+fill/type/clear. Multiplicative penalty/boost order: penalties first (invisible -100, disabled -50, not-topmost -20, readonly -40, state-mismatch -80, dynamic-id -30); then boosts (testId 150 / labelText 120 / aria 100 / text 90 / placeholder 85 / partial 70–90 / role 30 / type 40 / autocomplete 60 / container title 35 / container keyword 20 / tag-for-action 10).

**V23 — title and alt as accessible-name sources.** `node.title` (tooltip, critical for icon-only buttons) and `node.alt` (image accessible name) are now treated alongside `ariaLabel` for matching purposes. No new `WEIGHTS` keys — the existing aria/text tier covers them. Observable: icon-only buttons with only a `title=` attribute now rank correctly instead of dropping to tag-only.

### `rankCandidatesByFingerprint(candidates, domNodes, recordedFp)`

Re-rank against `recordedFp`. Combined score: `0.7 × structuralOverlap + 0.3 × bboxProximity`. Cyrillic↔Latin fold-aware. Used only in degraded mode + multi-candidate.

### `classifyClarifyScenario(input)`

Deterministic classifier (no LLM). Returns one of:
- `PAGE_MISMATCH` — recorded URL ≠ current URL.
- `AI_DEGRADED` — LLM resolver failed.
- `NO_RECORDED_MATCH` — recorded TIER1 (id/testId) not in any candidate.
- `AMBIGUOUS_RIGHT_PAGE` — >1 candidate, conf ≥ 0.5.
- `VAGUE_DESC` — recorded FP exists, conf < 0.5, intent < 25 chars.
- `GENERIC` — fallthrough.

**V23 — extended candidate text comparison.** Scenario detection now matches against `alt`, `iconLabel`, `svgIcon`, `childTestId`, `customElementTag` in addition to the existing label/aria/text fields. Same return enum, same signature — only precision improves (fewer false `GENERIC` for icon-only Angular Material / Vue components).

### `generateClarificationQuestion(params)` → `{ question, interpretation, examples }`

- Two-tier LLM: Gemini Flash Lite (5s) → GPT-5.4 mini fallback (5s). Deterministic fallback per scenario if both fail.
- Prompt encodes scenario directive + recorded fingerprint + top-3 candidates + intent language detection (RU/EN/…).
- **Examples are validated** — only labels that appear in real candidates are kept (no hallucinations).
- **Scenario gating:** `PAGE_MISMATCH` / `AI_DEGRADED` / `NO_RECORDED_MATCH` return `examples=[]` (not helpful in those cases).

---

## Clarification flow — when `needs_clarification` fires

1. **Ambiguous on right page** — multiple candidates near-equal score on the correct URL.
2. **Semantic zero** — resolver found nodes but LLM said "none of these match"; lint generates clarification + examples.
3. **Low confidence + degraded LLM** — rule-based candidates < 0.7 and fingerprint didn't decide.
4. **`includeAlternatives=true`** — Find button "Show alternatives" returns all candidates.
5. **Manual entry without recorded data** — no `compiled.targetFingerprint`, no `evidence.pageUrl` → classified as GENERIC or VAGUE_DESC.

**UI behaviour:** `status='needs_clarification'` → frontend shows candidate list (highlight boxes + labels + roles) + clarification message. User picks one → `preview:step:clarify:select` → step's `compiled.targetFingerprint` updated; next lint takes the evidence shortcut.

---

## Constants

### Scoring weights

| Key | Value | Purpose |
|---|---|---|
| `TESTID_EXACT_MATCH` | 150 | Most stable identifier. |
| `LABEL_TEXT_EXACT` | 120 | Associated `<label>` text. |
| `LABEL_EXACT_MATCH` | 100 | aria-label exact. |
| `ARIA_LABEL_MATCH` | 90 | aria-label partial. |
| `PLACEHOLDER_MATCH` | 85 | Input placeholder. |
| `NAME_ATTR_MATCH` | 70 | `name` attribute. |
| `TEXT_CONTAINS` | 50 | Element text. |
| `ROLE_MATCH` | 30 | ARIA role. |
| `TYPE_MATCH` | 40 | Input type. |
| `AUTOCOMPLETE_MATCH` | 60 | HTML autocomplete. |
| `CONTAINER_HINT_MATCH` | 20 | Parent section text. |
| `CONTAINER_TITLE_MATCH` | 35 | Explicit container title. |
| `DYNAMIC_ID_PENALTY` | -30 | Framework-generated id. |
| `DISABLED_PENALTY` | -50 | Disabled element. |
| `READONLY_PENALTY` | -40 | Readonly for fill/type. |
| `NOT_VISIBLE_PENALTY` | -100 | Invisible. |
| `NOT_TOPMOST_PENALTY` | -20 | Covered by overlay. |
| `STATE_MISMATCH_PENALTY` | -80 | Wrong state for action. |

### Confidence thresholds

| Key | Value | Meaning |
|---|---|---|
| `HIGH` | `0.8` | Auto-resolve. |
| `MEDIUM` | `0.5` | Resolve with medium-confidence message. |
| `LOW` | `0.3` | Below → ambiguous or not_found. |
| `AMBIGUOUS_THRESHOLD` | `0.15` | `(top - runner-up) / top ≤ 0.15` → ambiguous. |
| `AI_FALLBACK_THRESHOLD` | `0.4` | Below + ambiguous → trigger LLM. |
| `RULE_SCORE_FLOOR` | `0.15` | Tag-only matches dropped to `not_found`. |

### Timing
- **Snapshot throttle:** 500ms (cached) unless `forceFreshSnapshot`.
- **Clarification LLM:** 5s per model, two-tier (Gemini → GPT).
- **Evidence-shortcut TTL:** **60 minutes** (`EVIDENCE_REF_TTL_MS = 60 * 60 * 1000` in `evidence-shortcut.utils.ts`) or session start (whichever earlier). _Note: previous versions of this doc said "5 minutes" — that was wrong; corrected May 2026._

---

## State

In-memory only:
- `cacheMetrics` — hit/miss counters (`evidence-shortcut` category, per-reason breakdown).
- `EditorTraceService` JSONL append-only logs.

No persistent caches. Rule-based scoring is stateless.

## Examples

```ts
// High-confidence resolve
const r = await IntentStepLintService.lintStepWithAI({
  previewSessionId: 'sess-123',
  stepDraft: { id: 'step-1', type: 'click', description: 'Click the login button',
               bindingHints: { label: 'Login' } },
  userId: 'user-456',
  forceFreshSnapshot: true,
});
// → { status: 'resolved', confidence: 0.92, candidates: [{ ref:'node-42', label:'Login', confidence:0.92 }] }
```

```ts
// Ambiguous → clarification
// → { status: 'needs_clarification', candidates: [{label:'Submit'}, {label:'Submit Form'}],
//     clarificationQuestion: 'Found 2 matching elements. Please refine…' }
```

```ts
// LLM degraded → rule-based fallback
// → { status:'needs_clarification', degradedMode:true, degradedReason:'llm_timeout',
//     candidates:[…], clarificationQuestion:'AI resolver unavailable…' }
```

## Related

- [element-resolver.md](element-resolver.md), [preview-step-apply.md](preview-step-apply.md), [preview-session.md](preview-session.md), `evidence-shortcut.utils.ts`, `editor-trace.service.ts`, `preview.types.ts`.
