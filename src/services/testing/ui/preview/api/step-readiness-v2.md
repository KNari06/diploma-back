# `step-readiness-v2.service.ts` — API Reference

> Source: [step-readiness-v2.service.ts](../step-readiness-v2.service.ts)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)
> See also: [step-readiness.md](step-readiness.md) (V1 — current production default)

## Overview

**Smart waiter (V2).** Confirms the next step's element is ready for action on a stable page. Goal: real readiness, not just speed.

Design principles:
- **One deadline** — phases are NOT additive. All checks share a single budget.
- **Soft-escape at 70% budget** — `pageStable` gate releases and identity degrades `strong→weak` to avoid permanent polling on SPAs.
- **Identity does not block `ready=true`** except on explicit `mismatch` — caller gets the signal and decides (re-resolve before click).
- **Fail-open** — all checks are hard-capped at `perCheckCapMs (500ms)`; Playwright's 30s actionability can never consume the full budget.
- **No `if (isPreview/isBackground)` inside** — only parameters.

**Deployment mode:** controlled by `STEP_READINESS_CONFIG.v2` (env flag `STEP_READINESS_V2_MODE = off | shadow | primary`). Default `off`. Shadow mode runs V2 in parallel with V1 and logs divergence; V1 result is always returned.

## Exports

### Functions
- `waitForStepReadinessV2(page, step, locator, options?): Promise<ReadinessV2Result>` — main entry.
- `runV1WithShadow(page, step, locator, options?): Promise<V1Result>` — wraps V1 call + parallel V2 shadow. Used by `preview-run.service.ts` lookahead waits. Returns V1 result; V2 divergence logged only.

### Types

#### `ReadinessV2Options`
| Field | Type | Default | Purpose |
|---|---|---|---|
| `maxWaitMs` | `number` | preview=5000, background=7000 | Total budget. |
| `prevActionType` | `IntentActionType?` | — | Drives quiet-window length. |
| `prevUrl` | `string?` | — | Stability signal source. |
| `recordedDelayMs` | `number?` | — | Recorded inter-step delay; applied only on missed deadline. |
| `tracer` | `ReadinessV2Tracer?` | — | Optional structured tracer (same shape as V1). |

#### `ReadinessV2Result`
| Field | Type | Meaning |
|---|---|---|
| `ready` | `boolean` | Safe to act? `level1 ✓ AND identity ≠ mismatch`. |
| `waited` | `number` | ms spent waiting. |
| `confidence` | `'high' \| 'medium' \| 'low'` | All signals green → `high`. |
| `flags.elementCheckPassed` | `boolean` | Level 1: count + visible + enabled. |
| `flags.actionablePassed` | `boolean` | Level 2: bbox stable + in viewport + not obstructed + pointer-events. |
| `flags.identityMatch` | `IdentityMatch` | Level 3: fingerprint check result. |
| `flags.pageStablePassed` | `boolean` | DOM quiet-window consensus (or dropped by soft-escape). |
| `flags.hadNoLocator` | `boolean` | Could not build any locator from compiled plan or evidence. |
| `flags.softEscapeUsed` | `boolean` | Budget ≥70% spent — soft-OR gate triggered. |
| `failureReason?` | `ReadinessV2FailureReason` | Set when `ready=false`. |
| `autoWaitApplied` | `boolean` | `waited > autoWaitThreshold` — significant wait telemetry signal. |
| `skipReason?` | `string` | Set when action type is in skip-list. |

#### `IdentityMatch`
`'strong' | 'weak' | 'mismatch' | 'no_fingerprint'`

#### `ReadinessV2FailureReason`
`'element_not_visible' | 'element_not_attached' | 'element_disabled' | 'element_obstructed' | 'element_unstable' | 'identity_drift' | 'no_locator' | 'deadline' | 'skip'`

## Readiness levels

### Level 1 — Existence
- `click/type/select/check/...` → visible + enabled.
- `assert/hover/scroll` → visible only.
- `press/upload` → attached only.
- Non-targeting actions (`wait`, `wait_for`, `ai_check`, `dialog`, `download`, `switch_tab`) → skip entirely.

### Level 2 — Physical actionability
- BBox stable (re-checked after first pass).
- In viewport.
- Not obstructed by overlay (pointer-events test).
- Not `inert` or `aria-disabled`.

### Level 3 — Identity match
Compares live element attributes against `step.recordedFingerprint`. Returns:
- `strong` — id/testId/name match.
- `weak` — text/role/tag match only.
- `mismatch` — recorded fingerprint present but no field matches live node.
- `no_fingerprint` — nothing to compare (manual step, no recorded data).

**Only `mismatch` blocks `ready=true`** — signals caller to re-resolve before acting.

### pageStable gate
DOM tail quiet-window + same-origin XHR idle consensus. Released at 70% budget (soft-escape) regardless of state.

## Soft-escape

After 70% of `maxWaitMs`:
- `pageStable` gate released (no longer required).
- Identity level downgrades: `strong → weak` requirement.
- Result may be `ready=true` with `flags.softEscapeUsed=true`.

## Action-type classification

| Class | Members |
|---|---|
| Non-targeting (skip) | `wait, wait_for, ai_check, wait_for_email, dialog, download, switch_tab` |
| Needs visible + enabled | `click, type, select, check, uncheck, toggle, dblclick, contextmenu, open, close, drag_and_drop` |
| Needs visible only | `assert, hover, scroll` |
| Needs attached only | `press, upload` |

## Wiring (current call sites)

- `preview-run.service.ts` — lookahead waits after each step success use `runV1WithShadow()` (shadow mode, V2 diagnostic only).
- Direct use in `preview-step-apply.service.ts` pending `STEP_READINESS_V2_MODE=primary`.
- Background replay pending.

## Related

- [step-readiness.md](step-readiness.md) — V1 production implementation.
- [preview-run.md](preview-run.md) — `runV1WithShadow` caller.
- [preview-step-apply.md](preview-step-apply.md) — future primary caller.
