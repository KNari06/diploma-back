# `preview-session.service.ts` — API Reference

> Source: [preview-session.service.ts](../preview-session.service.ts) (~3679 lines)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

Singleton service that owns Playwright `BrowserContext` and `Page` lifecycle per user, one preview session per user maximum. Handles browser launch, page/context management, multi-tab support (V15+), snapshot throttling (500ms), TTL-based cleanup, native dialog handling, and lifecycle events. All page interactions (recording, applying steps, replaying tests) route through `InternalSession` state. Pairs with snapshot-collector for DOM extraction; per-user async locks prevent concurrent start/stop races.

## Exports

```ts
export class PreviewSessionService { … }
export const getPreviewSessionService = () => PreviewSessionService.getInstance();
```

### Types (re-exported / used)
- `InteractiveNode` — DOM element metadata (see [dom-analysis-extractor.md](dom-analysis-extractor.md)).
- `TargetFingerprint` — stable element hints.
- `PreviewSession` — public-shape: `{ id, userId, projectId, startUrl, createdAt, lastSeenAt, pageState }`.

### Constants
- `SESSION_TTL_MS` — 30 min (`PREVIEW_SESSION_CONFIG.sessionTtlMs`).
- `SESSION_CLEANUP_INTERVAL_MS` — 2 min.
- `SNAPSHOT_THROTTLE_MS` — 500 ms.
- `MAX_SESSIONS` — global cap on concurrent sessions.
- `MOUSE_INPUT_THROTTLE_MS`, `WHEEL_INPUT_THROTTLE_MS`, `KEYBOARD_TYPE_THROTTLE_MS`, `KEYBOARD_PRESS_THROTTLE_MS` — per-user input rate limits.

---

## `InternalSession` state (per active session)

| Field | Type | Purpose |
|---|---|---|
| `id`, `userId`, `projectId`, `startUrl` | string | identity |
| `createdAt`, `lastSeenAt` | number (ms) | TTL bookkeeping |
| `browser` | Playwright `Browser` | Chromium process |
| `context` | `BrowserContext` | session context (cookies, storage, auth) |
| `page` | `Page` | active page (= `pages[activeTabIndex]`) |
| `pages` | `Page[]` | all open tabs / popups |
| `activeTabIndex` | number | index into `pages` |
| `pageState` | `{ url, pageTitle, domNodes, pageText }` | last DOM snapshot |
| `lastSnapshotEmit` | number | last snapshot emission ts; `0` = invalidated |
| `lastEmittedSignature` | string | dedup marker (V20) |
| `lastPageSignature` | string | current page sig for change detection |
| `domVersion` | number | bumped on signature change |
| `contextVersion` | number | reserved |
| `contextData` | `Record<string, any>` | cross-step scratchpad (env vars, OTP, …) |
| `recording` | boolean | recording on/off |
| `recordingTypingBuffer` | object \| null | legacy char buffer (V22 prefers field session) |
| `recordingFieldSession` | object \| null | V22 Pkg8 single focus→blur transaction |
| `recordingLastUrl` | string | URL when recording started |
| `recordingDragState` | object \| null | drag-in-progress |
| `recordingLastTypeStep`, `recordingLastPressStep`, `recordingLastClickStep`, `recordingLastNavigateStep`, `recordingLastScrollStep` | object \| null | dedup / merge anchors |
| `recordingLastHover` | object \| null | last hover position |
| `recordingHoverChain` | array (≤4) | V22 Pkg5+ for multi-level menus |
| `recordingStepCount` | number | new-step counter (auto-stop at `RECORDING_MAX_STEPS`) |
| `dialogMode` | `'passive' \| 'recording' \| 'replay'` | native dialog handling |
| `pendingDialogAction` | `{ action: 'accept' \| 'dismiss', promptText? }` \| undefined | pre-installed action for apply/run |
| `pageSwitchInProgress` | boolean | mutex blocking snapshot during tab switch |

---

## Public methods

### `getInstance(): PreviewSessionService`
Internal — use the exported `getPreviewSessionService()`. Initializes the 2 min cleanup interval on first call. Always returns the same instance.

### `startSession({ userId, projectId, startUrl, viewport? }): Promise<{ previewSessionId, url, domNodes, screenshot? }>`

- **Callers:** `POST /api/v1/preview` ([preview.controller.ts](../../../../../api/preview/preview.controller.ts)); WS `preview:recording:start`.
- **Side-effects:**
  - Launches Chromium headless.
  - Creates `BrowserContext` with stealth, third-party blocker, auto-dismiss-overlays.
  - Attaches dialog handler, popup handler, crash handler, auth detector, external-nav trap.
  - Initializes `EditorTraceService` for the session.
  - Emits `preview:session:progress` (`launching_browser` 10% → `loading_page` 40/60% → `extracting_elements` 75% → `ready` 100%).
  - Closes any existing session for this userId first (under lock).
- **Throws:** `Error('Maximum preview sessions reached')` if `MAX_SESSIONS` reached. Friendly classified errors on navigation failure.
- **Steps:** lock → close-old → launch → context+page → handlers → goto (`waitUntil: 'domcontentloaded'`, 30 s) → wait-for-interactive → snapshot → store → emit ready.
- **Invariants:** one session per user; navigation uses `domcontentloaded`; initial snapshot must have ≥1 interactive element; cleanup guaranteed on failure (`safeCloseBrowserResources`).

### `resetSession({ sessionId, userId }): Promise<…|null>`

- **Caller:** `POST /api/v1/preview/reset`.
- **Side-effects:**
  - Creates fresh `BrowserContext` (clears cookies/storage/auth).
  - Atomically swaps old → new context/page; closes old after swap.
  - Resets `domVersion=1`, `lastSnapshotEmit=0`, `recording=false`, **`createdAt = now`**.
  - Calls `getSnapshot({ force: true })` to emit fresh DOM.
- **Returns:** snapshot result or `null` on auth failure.
- **Invariants:** swap is atomic; `createdAt` refresh invalidates evidence-shortcut on stale refs.

### `refreshPage(sessionId, userId): Promise<…|null>`

- **Caller:** `POST /api/v1/preview/refresh`, WS `preview:page:refresh`.
- **Side-effects:** `page.reload({ waitUntil: 'domcontentloaded' })`; marks external-nav trap to accept target URL; kicks off `getSnapshot` via `setImmediate` (non-blocking).
- **Returns:** lightweight status; full DOM follows asynchronously.

### `goBack(sessionId, userId)`, `goForward(sessionId, userId)`

- WS `preview:page:back` / `:forward`.
- `page.goBack()` / `page.goForward()` with `domcontentloaded` waitUntil.
- `goBack` fallback: if no history AND multi-tab session → `closeTab` (closes current popup, activates previous).
- Marks external-nav trap to accept the target URL.
- Kicks off async `getSnapshot`.

### `navigate(sessionId, url, userId?): Promise<…|null>`

- **Caller:** address bar.
- `page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30s })`.
- Marks external-nav trap to accept the new URL (no false alarm).
- Kicks off async `getSnapshot`.

### `getSnapshot(sessionId, userId?, options?): Promise<…|null>`

The hot path — called by recording handlers, apply/run, lint, periodic DOM tick, post-navigation.

**V26 routing.** Snapshot collection now goes through [`SnapshotRouter.collect()`](snapshot-router.md) instead of directly calling `SnapshotCollector`. The router decides between the legacy `page.evaluate` path and the new CDP-based hybrid pipeline (Etap 2) based on caller context and feature flags. Transparent to callers — same `LiteSnapshot` shape returned. `getSnapshot` passes `context: 'preview-tick'`, `lastDomNodeCount`, and `diagId` to the router. Router defaults to `evaluate` for now; CDP path opts in via `snapshot-router.config.ts` flags.

- **`options`:** `{ force?, includeScreenshot?, onlyIfChanged?, includeDomNodes?, fullPage? }`.
- **Returns:** `{ url, pageTitle?, domNodes?, domVersion, pageSignature, screenshot?, changed }` or `null` on auth fail.
- **Side-effects:**
  - Throttled to **500 ms** unless `force=true` or `lastSnapshotEmit=0` (cache invalidated).
  - Collects DOM via snapshot-collector → extracts via [dom-analysis-extractor](dom-analysis-extractor.md).
  - Computes signature `hash(url, domAnalysis)`; bumps `domVersion` on change.
  - Writes trace events: `snapshot_result`, `snapshot_empty`, `snapshot_error`.
  - Handles edge cases: navigation in progress (`document.body == null`) returns previous state; zero-elements logged benign/warning.
- **Steps:**
  1. Ownership check.
  2. `pageSwitchInProgress` true → return `null` (blocks stale snapshot during switch).
  3. Throttled + not forced + cache valid → return cached `domNodes` if `includeDomNodes`, else `null`.
  4. Collect → extract → signature → bump version on change → update `pageState` → set `lastSnapshotEmit=now`.
- **Invariants:**
  - `lastSnapshotEmit=0` is the "force fresh" signal used by click/apply handlers.
  - `lastEmittedSignature` (V20 dedup) prevents redundant emits when DOM hash unchanged.
  - During tab switch, getSnapshot returns `null` to keep frontend from seeing stale DOM.

### `stopSession(sessionId, userId?): Promise<void>`

- **Callers:** `DELETE /api/v1/preview`, WS disconnect, cleanup interval.
- **Side-effects:**
  - `PreviewRunService.forceCancelOnSessionStop(sessionId)`.
  - Close + upload `EditorTraceService` (fire-and-forget upload).
  - Close all pages, context, browser via `safeCloseBrowserResources` (10 s timeout each).
  - Remove from `sessions` and `userToSession` maps.
- **Throws:** never (no-op if session already gone). Forbidden if `userId` mismatch.
- **Invariants:** force-cancel BEFORE closing context (`page.evaluate` against closed page would crash); cleanup must complete even on individual resource failure.

### `switchTab(sessionId, userId, tabIndex): Promise<boolean>`

- **Side-effects:**
  - Atomically updates `session.page` and `activeTabIndex`.
  - Resets snapshot state: `lastSnapshotEmit=0`, `lastPageSignature=''`, `lastEmittedSignature=''`.
  - Sets `pageSwitchInProgress=true` for the duration to block stale snapshots.
  - Updates `recordingLastUrl` if recording.
  - Calls `onPageSwitch` callback if registered (video stream / devtools restart).
  - Removes closed tabs from `pages` and adjusts `activeTabIndex`.
- **Returns:** `true` if successful, `false` on invalid index / closed tab.

### `closeTab(sessionId, userId, tabIndex): Promise<boolean>`

- **Side-effects:** closes the page, removes from `pages`. If was active, switches to adjacent tab and triggers `onPageSwitch`.
- **Invariant:** at least one tab always remains open; closing the last tab returns `false`.

### `executeMouseAction({ sessionId, userId, action, x, y, button?, clickCount? })`

- WS `preview:mouse:click` / `:down` / `:up`. (Move events are coalesced in the handler before reaching this method.)
- **Side-effects:**
  - `'click'` — probes external anchors first; **blocks external-origin/external-protocol links** and returns user-facing error. On success, invalidates `lastSnapshotEmit=0` so next snapshot is fresh.
  - `'down'`/`'up'` — moves mouse + fires; no snapshot invalidation.
  - Throttled per-user (`lastMouseInputAt`).
  - Coordinates clamped to viewport.
  - Updates `lastSeenAt`.
- **Returns:** `{ success, error?, needsSnapshot }`.

### `executeKeyboardType({ sessionId, userId, text })`

- WS `preview:keyboard:type`.
- `page.keyboard.type(text)`. Text capped at 500 chars (anti-DoS). Throttled per-user.

### `executeKeyboardPress({ sessionId, userId, key, modifiers? })`

- WS `preview:keyboard:press`.
- Holds modifiers via `keyboard.down`, presses key, releases. Throttled per-user.

### `executeMouseWheel({ sessionId, userId, x, y, deltaX, deltaY })`

- WS `preview:mouse:wheel`.
- `page.mouse.wheel`. Throttle window 500 ms (allows smooth bursts).

### `probeElementAt({ sessionId, userId, x, y })`

- Evaluates `PROBE_AT_POINT_FN` to walk `elementsFromPoint`. Returns `ProbedElement` or error.
- Symmetric with [dom-analysis-extractor](dom-analysis-extractor.md) (Tier-1/Tier-2 selection rules MUST match).

### `probeInteractiveElementAt({ sessionId, userId, x, y, withRejectReason? })`

- Wraps `RecordingCaptureService.probeForRecording()` and matches against current `session.pageState.domNodes`.
- **Returns:** `{ tag, label, boundingBox, resolvedVia }` on success; `{ rejectReason }` when `withRejectReason=true` and probe finds no interactive target.
- **Caller:** `preview:mouse:probe` WS event (V26 on-demand element inspect).

### `setContextData({ sessionId, userId, key, value }): Promise<{ version, data } | null>`

- Updates session `contextData` scratchpad key/value.
- **Returns:** `{ version: number, data: Record<string,any> }` or `null` if session not found.
- **Caller:** `preview:context:set` WS event.

### `setViewport({ sessionId, userId, width, height })`

- `page.setViewportSize({ width, height })` + notifies video stream. Does not reload the page.

---

## Timing & cleanup

- **Snapshot throttle 500 ms.** `force=true` or `lastSnapshotEmit=0` skips it.
- **TTL 30 min** on idle. **Cleanup task every 2 min** removes sessions where `now - lastSeenAt > TTL`.
- **`lastSeenAt`** updated on every user action.

## Multi-tab management

- `BrowserContext` may have multiple pages. Popups (window.open / `target=_blank`) auto-added via `context.on('page')`.
- `switchTab` swaps active page, invalidates snapshot, fires `onPageSwitch` callback (video/devtools follow).
- `closeTab` prevents closing the last remaining tab.

## Native dialogs

- `dialogMode='passive'` (default) auto-dismisses `alert`/`confirm`/`prompt`/`beforeunload`.
- `'recording'` waits for user choice (captures step).
- `'replay'` honours `pendingDialogAction` pre-installed by [preview-step-apply](preview-step-apply.md).

## Context scratchpad

- `contextData` is the per-session `Record<string, any>`. Used for env vars, OTP codes, login fixtures, anything cross-step.
- Updated by apply/run handlers; persists for the session lifetime.

## DevTools integration

- HTML / accessibility / network / console requests routed to `preview-devtools-collector.service.ts`.
- `page.accessibility.snapshot()` for a11y tree; `page.content()` for HTML.
- Network via Playwright events; console via `page.on('console')`.
- **Never use a raw CDP session here** — `preview-video-stream.service.ts` owns the only allowed CDP session.

---

## Error handling

- All public methods return `{ success, error? }` or `null` — never throw to callers.
- Logs tagged `[PREVIEW_SESSION]` with sessionId, userId, action, error.
- Navigation errors classified by `classifyNavigationError` → friendly user messages.

## Invariants & gotchas

1. **One session per user.** New `startSession` closes the old one.
2. **Snapshot invalidation = `lastSnapshotEmit=0`.** Click/apply set it.
3. **`lastEmittedSignature` (V20) dedup** prevents redundant emits.
4. **Per-user lock** serializes start/stop/reset.
5. **`safeCloseBrowserResources`** with 10 s per-resource timeout — no hangs.
6. **`resetSession` bumps `createdAt`** to invalidate evidence-shortcut.
7. **`pageSwitchInProgress`** blocks `getSnapshot` during switchTab.
8. **Popups auto-tracked** via `context.on('page')`.
9. **Address-bar / back / forward / refresh mark intent** on external-nav trap.
10. **Cleanup is idempotent.** Trace upload is fire-and-forget.

## Related

- [preview-handler.md](preview-handler.md) — WS events that route into this service.
- [preview-step-apply.md](preview-step-apply.md), [preview-run.md](preview-run.md) — consumers.
- [recording-capture.md](recording-capture.md) — uses `probeElementAt`.
- `preview-video-stream.service.ts` — sole CDP session owner.
- `preview-devtools-collector.service.ts` — DevTools tab data.
- `editor-trace.service.ts` — JSONL session traces.
