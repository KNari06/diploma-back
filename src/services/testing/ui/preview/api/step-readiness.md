# `step-readiness.service.ts` — API Reference

> Source: [step-readiness.service.ts](../step-readiness.service.ts) (~84KB)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

Pre-action readiness wait. Runs **before** the next step's action (lookahead model), not after the previous one — by the time we click, all of: navigation, loaders, animations, overlays, and target visibility/state must have settled. Seven layers cover the typical SPA lifecycle. Layer thresholds and which layers run depend on the previous-action type (click after navigation needs full DOM-stable; type→type can stay light).

URL-change races are detected by polling + `framenavigated` event combined (cheaper than `waitForNavigation`, works for fully-client SPA route changes). DOM stability uses an animation-aware MutationObserver that filters CSS-animation noise so a constantly-pulsing skeleton doesn't make the wait time out.

**Callers:**
- [preview-step-apply.service.ts](../preview-step-apply.service.ts) — phase `'pre'` before each action.
- [preview-run.service.ts](../preview-run.service.ts) — lookahead between steps in Apply All.

## Exports

### Functions
- `waitForStepReadiness(params): Promise<LookaheadResult>` — main entry.
- `shouldSkipLookaheadAfter(prevAction): boolean` — quick gate used by run loop.
- 16 supporting check functions (navigation race, loader probe, animation settle, overlay probe, element-state, third-party API filter, …).

### Types
- `LookaheadResult` — `{ ok, branch, durationMs, reason?, traceEvents? }`.
- `LookaheadOptions` — `{ prevAction, currentUrl, expectsNavigation, action, target?, tracer?, hardCapMs? }`.
- `LookaheadTracer` — `(phase: string, payload: object) => void` for observability.
- `ReadinessCheckResult` — per-layer `{ ok, durationMs, info? }`.

---

## The 7 layers

Run in order; each layer can skip itself based on action type or signals.

| # | Name | Checks | Timeout (default) | Triggered by | When skipped |
|---|---|---|---|---|---|
| 0 | Challenge page detect | Cloudflare/Turnstile/reCAPTCHA gate | ~500ms probe | always | already on challenge → fail-fast (don't wait, surface to user) |
| 1 | SPA navigation race | URL change via `framenavigated` + 50ms polling | ~3000ms | `expectsNavigation`, prevAction is `click`/`navigate`/`open` | type/hover/scroll prevAction |
| 2 | Loading indicators | spinners (`.spinner`, `[role="progressbar"]`, `aria-busy`), skeletons | ~3000ms | always | none |
| 3 | API idle (diagnostic) | same-origin XHR/fetch outstanding | ~2000ms (capped) | always (advisory only) | reaches hard-cap; bypassed when third-party noise dominates |
| 4 | CSS animation settle | computed `animation-name` ≠ `none` on target or ancestors | ~500ms | when target locator known | static element, no animation |
| 5 | Overlay obstruction | `elementFromPoint(target.center)` ≠ target | ~1000ms | when target locator known | non-targeting actions (navigate/wait/scroll) |
| 6 | Element state (action-specific) | visible / enabled / attached / topmost | ~500ms hard-cap per locator | always for targeting actions | non-targeting |

**Ordering rationale:** if there's a navigation pending (1) we must wait first or all later layers see stale DOM. Loaders (2) before animations (4) because animations may attach to skeleton elements that vanish on data load. API idle (3) is diagnostic only — third-party trackers (Datadog/Sentry/Google Analytics) are filtered, but this layer is advisory and capped, never blocks alone. Overlays (5) check after layout settles. Element state (6) last — by then the target is the right node.

---

## Public functions

### `waitForStepReadiness(params): Promise<LookaheadResult>`

```ts
{
  page: Page;
  prevAction?: IntentActionType;        // type of previous step
  currentUrl: string;
  expectsNavigation?: boolean;          // hint from previous step's expectsNavigation
  action: IntentActionType;             // current action type
  target?: { locator: Locator; ref: string };
  tracer?: LookaheadTracer;
  hardCapMs?: number;                   // overall timeout, default ~6000ms
}
```

- **Visibility:** exported function.
- **Caller:** [preview-step-apply.service.ts](../preview-step-apply.service.ts) (`smartStepWait('pre')`), [preview-run.service.ts](../preview-run.service.ts).
- **Returns `LookaheadResult`:**
  - `ok: boolean`.
  - `branch: 'fast' | 'navigation' | 'loaders' | 'animation' | 'overlay' | 'element' | 'hardcap'`.
  - `durationMs: number`.
  - `reason?: string` — failure code.
  - `traceEvents?: object[]` — phase events when `tracer` provided.
- **Side-effects:** ephemeral logs; tracer events. No mutation of page state.
- **Throws:** never; failures returned as `ok: false` with reason.
- **Key steps:**
  1. Fast path: `shouldSkipLookaheadAfter(prevAction)` true → return `ok: true, branch: 'fast'` immediately.
  2. Layer 0 — challenge probe. If gate detected → `ok: false, reason: 'challenge_page'`.
  3. Layer 1 — navigation race. Hybrid `framenavigated` event + 50ms URL poll, 300ms early-exit if URL stable.
  4. Layer 2 — loaders. Polls common selectors + `aria-busy`.
  5. Layer 3 — API idle (diagnostic only, capped, third-party filtered).
  6. Layer 4 — animation settle on `target` and ancestors.
  7. Layer 5 — overlay probe via `elementFromPoint`.
  8. Layer 6 — element state per action type (see calibration below).
  9. Hard-cap reached → `ok: false, branch: 'hardcap', reason: 'lookahead_timeout'`. Apply still proceeds; hard-cap is advisory.
- **Gotchas:**
  - **Action-type calibration** (table below) controls which checks fire and their thresholds.
  - **Third-party host filter** prevents Datadog/Sentry/GA from making API-idle wait forever.
  - **Animation filter** dedupes by URL + class name and ignores animations that loop (`animation-iteration-count: infinite`) for >2s.
  - **Per-locator hard-cap 500ms** — never let one layer block the lookahead beyond its slice.
  - **Blind settle fallback** — if a layer's primitive throws, fall back to a 200ms blind wait rather than fail.

### `shouldSkipLookaheadAfter(prevAction): boolean`

- Returns `true` for previous actions that don't materially change the DOM state, so the next action can run immediately.
- **Returns `true` for:** `'wait'`, `'scroll'`, `'hover'`, `'press'` (key without focus change), pure `assert`/`ai_check`. **Returns `false` for:** `'click'`, `'navigate'`, `'open'`, `'close'`, `'type'` (debounce-driven re-renders), `'select'`, `'check'`/`'uncheck'`/`'toggle'`, `'upload'`, `'drag_and_drop'`.

---

## Action-type calibration (Layer 6)

| Action type | Required state |
|---|---|
| `click`, `dblclick`, `contextmenu`, `type`, `select`, `check`, `uncheck`, `toggle`, `drag_and_drop` | visible + enabled + topmost |
| `assert`, `hover`, `scroll` | visible |
| `press` | attached (no visibility — keyboard only) |
| `upload` | attached + accepts files (filechooser may be hidden) |
| `navigate`, `wait`, `wait_for`, `ai_check`, `dialog`, `download`, `switch_tab` | layer skipped (non-targeting) |

For `type`-after-`type` the lookahead stays light: layers 0/4/5 typically skip because the target hasn't moved.

---

## Algorithm details

### Layer 1 — SPA navigation race

Listens for `framenavigated` AND polls `page.url()` every 50ms. Whichever fires first wins. After 300ms of stable URL, layer exits with `ok: true`. If `expectsNavigation` was true and we didn't see a URL change within hard-cap → `reason: 'navigation_expected_but_did_not_happen'` (advisory; the next layers still run).

### Layer 3 — API idle filter

Only counts pending requests whose host is NOT in the third-party blacklist:

```
google-analytics.com, googletagmanager.com, doubleclick.net, googlesyndication.com,
sentry.io, datadoghq.com, datadoghq.eu, mixpanel.com, segment.io, hotjar.com,
intercom.io, fullstory.com, newrelic.com, bugsnag.com, cloudflareinsights.com,
posthog.com, amplitude.com, …
```

Also dedupes by URL — multiple in-flight `/api/poll` calls count once.

### Layer 4 — animation settle

Reads computed `animation-name` on target + ancestors. Skips layers if all animations loop forever (`infinite` keyword) — those are perpetual UI noise (skeleton shimmer) and should not block. Otherwise waits for `animationend` or up to ~500ms.

### Layer 6 — element state retry loop

Parallel checks (`isVisible`, `isEnabled`, `isAttached`, topmost-at-center). 500ms per locator hard-cap. Settle delay scales: 150ms default, 500ms after navigation (DOM is busier post-load).

---

## Constants & timing

| Symbol | Value | Purpose |
|---|---|---|
| Hard-cap (overall) | ~6000ms | Outer timeout for the whole lookahead. |
| Layer 0 (challenge) | ~500ms | Probe. |
| Layer 1 (navigation race) | ~3000ms | URL stable window 300ms. Poll interval 50ms. |
| Layer 2 (loaders) | ~3000ms | Polls common spinner selectors + `aria-busy`. |
| Layer 3 (API idle) | ~2000ms cap | Advisory only. |
| Layer 4 (animation) | ~500ms | Skips infinite animations. |
| Layer 5 (overlay) | ~1000ms | `elementFromPoint` probe. |
| Layer 6 (element state) | ~500ms / locator | Parallel checks. |
| DOM stability | 150ms / 500ms (post-nav) | MutationObserver quiet window. |
| Per-locator hard-cap | 500ms | Per-layer slice budget. |

Defaults overridable via `playwright-tuning.ts`.

---

## Trace events

When `tracer` is provided, each layer emits a phase event:

```
challenge_start / challenge_done
nav_race_start / nav_race_done(url, durationMs)
loaders_start / loaders_done(remaining, durationMs)
api_idle_start / api_idle_done(pending, filtered)
animation_start / animation_done(elements, infinite)
overlay_start / overlay_done(blocked)
element_state_start / element_state_done(state)
hardcap_reached(branch, durationMs)
```

Used by editor trace JSONL for postmortem.

---

## Error handling

- **Stale locator** — element vanished mid-check → returns `ok: false, reason: 'locator_stale'`; apply will retry/re-resolve.
- **Navigation delay** — `expectsNavigation` true, no URL change → advisory; apply proceeds (the action itself may have been a NOP).
- **Overlay** — non-target topmost → `ok: false, reason: 'overlay'`; apply triggers auto-dismiss-overlays attempt.
- **Animation overflow** — infinite animation → ignored, layer reports `ok: true`.

Layer-level failures **do not throw** — result.ok=false is the signal. Hard cap is the only "blind" exit.

## Related

- [preview-step-apply.md](preview-step-apply.md) — calls `waitForStepReadiness('pre')` before action.
- [preview-run.md](preview-run.md) — calls between steps as lookahead.
- `wait-phases/*.ts` — primitives used by each layer.
- `auto-dismiss-overlays.ts` — overlay-rescue path triggered on layer 5 fail.
