# `recording-capture.service.ts` — API Reference

> Source: [recording-capture.service.ts](../recording-capture.service.ts) (~3800 lines)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

Transforms raw browser events (clicks, typing, key presses, scroll, hover, navigation, drag-drop, file upload, select change) into `IntentStep` objects for the editor. Owns four core abstractions:

1. **`PROBE_AT_POINT_FN`** — in-page DOM probe walking the element tree from a click coordinate, returning a rich `ProbedElement` (testId, id, role, text, ARIA state, ancestor chain).
2. **Field Sessions** — single-shot open/close lifecycle for typing; reads live `input.value` on close (canonical text source).
3. **Scroll merging** — coalesces consecutive wheel events within a 3000ms window into one step.
4. **Binding Hints + Recorded Fingerprints** — semantic locators + structural snapshot that survive re-renders so the resolver can match and heal at apply time.

Service itself is stateless; recording state lives on `InternalSession` (page URL, step counter, buffers, timers). Delegates resolution to sister services.

## Exports

### Class
`RecordingCaptureService` — static-only.

### Types
- `ProbedElement` — element descriptor (testId, id, role, text, ariaLabel, labelText, ARIA state, framework hints, container/row context, bounding box, ancestor chain, `resolvedVia` label, iframe/cross-origin markers).
- `RecordingTypingBuffer` — `{ text, elementRef, elementLabel, lastCharAt, bindingHints, recordedFingerprint, isMultiline, pageUrl, iframeSelector }`.
- `RecordingDragState` — `{ startX, startY, startElement, startedAt, viewport }`.

### Constants

| Symbol | Value | Purpose |
|---|---|---|
| `MEANINGFUL_KEYS` | Set | Keys that produce a `press` step (Enter, Tab, Escape, Backspace, Delete, arrows, F1–F12). |
| `FLUSH_TRIGGER_KEYS` | Set | Keys that flush typing buffer (Enter, Tab, Escape). |
| `DRAG_DISTANCE_THRESHOLD` | `10` px | Min distance for mouse:down→mouse:up to be a drag (otherwise click). |
| `RECORDING_TYPING_DEBOUNCE_MS` | `1500` | Typing-buffer flush debounce. |
| `RECORDING_SCROLL_DEBOUNCE_MS` | `500` | Scroll-event debounce. |
| `RECORDING_SCROLL_MERGE_WINDOW_MS` | `3000` | Window for merging consecutive scrolls. |
| `HOVER_PROBE_THROTTLE_MS` | `200` | Hover probe throttle. |
| `RECORDING_MAX_TIME_MS` | `1_800_000` (30 min) | Max recording duration. Override via `WEB_RECORDING_MAX_TIME_MS` (`0` disables). |
| `RECORDING_MAX_STEPS` | `50` | Max new steps per session. Override via `WEB_RECORDING_MAX_STEPS` (`0` disables). |

---

## `PROBE_AT_POINT_FN` — in-page DOM probe

Stored as a string and injected via `page.evaluate()`. Symmetric with [dom-analysis-extractor.service.ts](../dom-analysis-extractor.service.ts) — both must use the same dynamic-id regex and ancestor-selection rules.

### Inputs
`(px, py)` — viewport pixel coordinates.

### Outputs (`ProbedElement`)
- **Identity:** `tag`, `testId` (`data-testid` / `data-test` / `data-qa`), `elementId` (non-generated DOM id), `role` (explicit/implicit).
- **Text/label:** `text` (innerText, capped 80 chars), `ariaLabel`, `labelText` (`<label>` or `aria-labelledby`), `placeholder`, `title`, `alt`.
- **ARIA state:** `ariaInvalid`, `ariaCurrent`, `ariaValueNow`, `ariaValueText`, `ariaControls`, `ariaHasPopup`, `ariaActiveDescendant`, `ariaExpanded`, `ariaPressed`, `checked`.
- **Framework hints:** `dataValue`, `childTestId`, `iconLabel` (SVG/icon), `svgIcon` (Angular Material), `customElementTag`, `vueScopeId`, `cssClass` (stable tokens), `bsToggle` / `bsTarget` (Bootstrap).
- **Row/list context:** `nearestRowText`, `siblingIndex` (nth-of-type), `dataRowKey` (Ant), `rowClickable`.
- **Spatial:** `boundingBox`, `isMultiline`.
- **Container:** `containerText` (nearest heading), `containerTitles` (up to 2), `nearestLandmark` (banner/navigation/main/complementary/contentinfo/form), `ancestorSummary` (compact `outer > middle > inner` chain), `ancestorChain` (array up to 6 levels with id/testId per segment).
- **Resolution:** `resolvedVia` ∈ `'nativeTag' | 'ariaRole' | 'behavioral' | 'cssClass' | 'cursorPointer' | 'directHit' | 'llm'`.
- **Cross-origin:** `iframeSelector`, `crossOriginIframe`, `unsupportedHost` (`'webview' | 'object' | 'embed'`).

### Resolution strategy (wrapper → icon descent)

Walks `elementsFromPoint` and chains ancestors up to 12 levels, then picks the best target in priority order:

1. **Native interactive tag** (`button`, `a`, `input`, `select`, `textarea`, `summary`) → `resolvedVia='nativeTag'`.
2. **ARIA widget role** (`button`, `link`, `checkbox`, `radio`, `tab`, `combobox`, `textbox`, …) → `'ariaRole'`.
3. **Behavioral** (`tabindex`, `onclick`, framework click bindings: `(click)`, `@click`, React `__reactProps$.onClick`) → `'behavioral'`.
4. **CSS class** (`btn`, `button`, `clickable`, `toggle-btn`) → `'cssClass'`.
5. **Computed `cursor:pointer`** → `'cursorPointer'`, climbs to highest ancestor sharing the cursor.
6. **Direct hit** otherwise → `'directHit'`.

Post-selection fixes:
- **Clickable row promotion** — child of `<tr>` with `cursor:pointer` or hover-class → promote to `<tr>`.
- **MUI OutlinedInput fieldset → input** — fieldset (`notchedOutline` / `MuiOutlinedInput-notchedOutline`) → walk up and pick the inner `<input>`.
- **Label → control elevation** — child of `<label>` → follow `for=` or pick the only form control descendant.
- **Wrapper → icon descent** — selected target is generic (`div/span/button`) with exactly one child `svg[id] / img[id] / i[id]` carrying a stable id, AND click hit lies inside icon's bounding rect (±2px) → descend to the icon. Fixes Element Plus / MUI IconButton patterns where the icon, not the wrapper, holds the semantic id.

### Dynamic-id regex (must mirror [dynamic-id.util.ts](../dynamic-id.util.ts))

Filters: UUIDs, long hex tokens (≥24 hex), 20+ alphanumeric, epoch timestamps (10+ digits), `:r…:`/`:R…:` (React useId), `radix-`, `mui-`, `headlessui-`, `chakra-`, `downshift-`, Angular CDK/Material, Ant Design, PrimeVue, BootstrapVue, Lit, Ionic, Quasar, Naive UI, Salesforce, AngularJS `ng-…`, Emotion/styled-components long-hash prefix `_[a-zA-Z0-9]{12,}`. Filtered ids drop out of `elementId` and `ancestorChain`.

### Ancestor summary
Compact `header#layout-header > div.icon-group > svg` string. Priority per segment: testId → id → role → text → class. Travels with every step's fingerprint and gives the resolver structural context for icon-only / unlabelled elements.

---

## Field session lifecycle

A field session is a single-shot open/close lifecycle for typing in a focused input/textarea/contenteditable.

1. **`openFieldSession()`** — fires on first `preview:keyboard:type` to a focused input. Records element ref, initial value, binding hints (role, label, name, id, aria-label), recorded fingerprint.
2. **Buffer accumulates** — keystrokes update `lastCharAt` but are not emitted.
3. **`closeFieldSession()`** — fires on blur, click elsewhere, navigation, recording stop, paste detect, focus shift to a different input. Reads **live** `input.value` (or `element.textContent` for contenteditable) via Playwright `locator.inputValue()`. Compares to initial value:
   - Changed → emit a single `type` step with the live value.
   - Unchanged → emit `preview:recording:step:remove` (rolls back the focus event).

**Single-shot rule:** one focus→blur cycle = one Type step. Re-focusing opens a NEW session. Non-reentrant: the open session is cleared *before* awaiting `inputValue()`.

**Canonical value source:** live DOM, NOT sum of buffered keystrokes. Captures autocomplete, paste, undo/redo, IME composition.

---

## Public methods

### `probeForRecording(page, x, y): Promise<ProbedElement | null>`

- **Visibility:** `public static`.
- **Caller:** [preview.handler.ts](../../../../../websocket/handlers/preview.handler.ts) click path.
- **Returns:** `ProbedElement` or `null`.
- **Side-effects:** debug logs on null result; iframe descent attempts; `<webview>` detection.
- **Throws:** never (errors caught, logged, null returned).
- **Key steps:**
  1. `page.evaluate(PROBE_AT_POINT_FN, x, y)` in main frame.
  2. If target is `<iframe>` with `resolvedVia='directHit'` → descend via `probeInChildFrames` (April 2026 regression fix).
  3. `<webview>` → `unsupportedHost` marker.
  4. Null → try `probeInChildFrames` for iframe-hosted dashboards.
  5. Still null → look for `<webview>`/`<object>`/`<embed>` via bounding-rect intersection.
- **Notes:** iframe descent translates coordinates back to viewport space. Cross-origin iframes return `crossOriginIframe: true`.

### `probeFocusedElement(page): Promise<ProbedElement | null>`

- **Caller:** preview.handler.ts focus path (when typing arrives without explicit focus event).
- **Side-effects:** none.
- **Steps:** `page.evaluate(PROBE_FOCUSED_FN)` in main frame; fallback to `probeFocusedInChildFrames`.

### `resolveInteractiveTarget(page, probed, x, y): Promise<ProbedElement | null>`

- **Caller:** preview.handler.ts (V15 LLM fallback for low-confidence probes).
- **Side-effects:** LLM call (fast model, ~100 tokens), cached in `llmResolutionCache` keyed by structural hash of `ancestorChain`.
- **Steps:**
  1. Cache lookup → instant return on hit.
  2. LLM picks index into chain.
  3. Re-probe at original `(x, y)` from the chosen ancestor.
  4. Cache the decision.

### `capturePress(key, modifiers?): IntentStep | null`

- **Returns:** `press` step, or `null` if `key` not in `MEANINGFUL_KEYS`.
- **Description:** `"Press <Mod>+<key>"` or `"Press <key>"`.

### `captureClick(probed, pageUrl): IntentStep`

- **Returns:** `click` / `dblclick` / `contextmenu` step (action inferred from element role).
- **Steps:** infer action type → `buildDescription` → `buildBindingHints` → `buildRecordedFingerprint` → set `evidence.pageUrl`, `confidence`, `lastSuccessRef`.

### `captureNavigation(currentUrl, previousUrl): IntentStep | null`

- **Returns:** `navigate` / `back` / `forward` / `refresh` step, or `null` if URLs are equivalent.
- **Steps:** normalize URLs (`normalizeUrlForComparison`); detect type from history vs URL/hash diff.

### `captureScroll(deltaY, pageUrl, deltaX?, hints?, containerSel?): IntentStep`

- **Returns:** `scroll` step.
- **Steps:** description `"Scroll <direction> <px>px"`, store actual `deltaY` (not hardcoded), attach `containerSelector` if provided.

### `captureHover(element, pageUrl?): IntentStep`

- **Returns:** `hover` step with binding hints + recorded fingerprint.

### `captureDragAndDrop(startElement, endElement, startX, startY, endX, endY, pageUrl): IntentStep`

- **Returns:** `drag-drop` step.
- **Guard:** distance < `DRAG_DISTANCE_THRESHOLD` (10 px) → treat as click (handled by click path).

### `captureFileUpload(uploadedFiles, target?, pageUrl?): IntentStep`

- **Returns:** `upload` step.
- **Caller:** preview.handler.ts `filechooser` event.
- **Stores:** file count, first filename (truncated), target binding hints.

### `flushTypingBuffer(buffer, triggeredByEnter?): IntentStep | null`

- **Caller:** preview.handler.ts on debounce expiry or `Enter` (legacy path; field session is primary).
- **Returns:** `type` step, or `null` if buffer empty.
- **Notes:** `options.pressEnter = true` if `triggeredByEnter`.

### `captureSelectChange({ label, text, value, bindingHints, pageUrl }): IntentStep`

- **Caller:** preview.handler.ts injected select-change listener.
- **Returns:** `select` step with `value` = chosen option value.

### `buildDescription(actionType, element, value?): string`
### `buildBindingHints(element): BindingHints`
### `buildRecordedFingerprint(element): TargetFingerprint`

Helpers used by capture methods:
- `buildDescription` — human-readable step text; truncates value preview to 40 chars.
- `buildBindingHints` — flattens `role`, `name`, `id`, `ariaLabel`, `placeholder`, `testId`, label text; filters dynamic ids.
- `buildRecordedFingerprint` — structural snapshot (tag, role, descriptors, ARIA state, ancestor summary). Resolver uses it at apply time to identify the same element.

---

## Capture flows

### Click
```
preview:mouse:click(x, y, detail, buttons)
  → probeForRecording(page, x, y)         [iframe descent / webview detection]
  → buildBindingHints / buildRecordedFingerprint
  → inferClickActionType(probed)          → 'click' | 'dblclick' | 'contextmenu'
  → captureClick(probed, pageUrl)
  → emit preview:recording:step:capture
  → write editor trace
```

### Typing (field session)
```
preview:keyboard:type
  → probeFocusedElement(page)
  → openFieldSession(page, ref, initialValue, fingerprint)
  [keystrokes update buffer, no emits]
  [debounce 1500ms expires OR blur/click/nav]
  → closeFieldSession()
       reads input.value via Playwright
       compare to initialValue:
         changed   → emit preview:recording:step:capture (type)
         unchanged → emit preview:recording:step:remove
  → write editor trace
```

### Scroll (merge)
```
preview:mouse:wheel(deltaX, deltaY)
  → if pending timer AND now - lastEmittedAt < 3000ms (merge window):
       accumulate deltas, reset 500ms debounce
  → else:
       flush previous (if any), start fresh timer
  [debounce 500ms expires]
  → flushPendingScroll()
       within merge window → emit :update on previous step
       outside              → emit :capture (new step)
  → write editor trace
```

### Hover
```
preview:mouse:move(x, y)
  → coalesce moves per event-loop tick
  → throttle: skip if last probe < 200ms ago
  → probeForRecording(page, x, y)
  → element changed since last probe? → captureHover + emit :capture
  → else                              → no-op
  → write editor trace
```

### Navigation
```
page.on('framenavigated' | 'load' | history) →
  closeFieldSession + flushPendingScroll + flushPendingTyping (forced)
  captureNavigation(currentUrl, previousUrl)
  emit preview:recording:step:capture (navigate / back / forward / refresh)
  write editor trace
```

### Drag-drop
```
preview:mouse:down(x, y) → probeForRecording → store dragState
[mouse moves coalesced, no emits]
preview:mouse:up(x, y)   → probeForRecording (end element)
  distance ≥ 10 px → captureDragAndDrop → emit :capture
  distance < 10 px → fall through to click handler
write editor trace
```

---

## State (lives on `InternalSession`)

| Field | Type | Purpose |
|---|---|---|
| field session | `RecordingTypingBuffer \| null` | Open typing session: ref, initial value, hints, fingerprint. |
| scroll merge buffer | `{ deltaY, deltaX, containerSelector, timer, emittedAt }` | Pending scroll accumulation + merge window. |
| step counter | `number` | New steps recorded; auto-stops at `RECORDING_MAX_STEPS`. |
| recording state | `boolean` | Recording active? |
| auto-stop timer | `Timeout?` | Fires at `RECORDING_MAX_TIME_MS`; cleared on stop/disconnect. |
| typing debounce | `Timeout?` | Flushes after 1500ms inactivity. |
| hover throttle | `{ lastProbeAt, lastElementKey, probeInFlight, pageUrl, latestX, latestY }` | Dedup rapid moves. |
| page URL guard | `string` | Prevents stale hover probes after navigation. |
| `llmResolutionCache` | `Map<structuralHash, chainIndex>` | Memoizes `resolveInteractiveTarget` decisions. |

---

## Invariants & gotchas

1. **Single-shot field sessions.** One focus→blur cycle = one Type step. Re-focus opens a NEW session. Non-reentrant.
2. **Canonical value source.** `input.value` at close time, not buffered keystrokes.
3. **Scroll merge window.** Scrolls within 3000ms of last emit are merged; 500ms inactivity flushes.
4. **Dynamic-id filtering.** Inline regex must mirror [dynamic-id.util.ts](../dynamic-id.util.ts). Drift causes wrong-element bugs.
5. **Wrapper → icon descent.** Generic wrapper with single icon child + click inside icon's bbox (±2px) → descend.
6. **Symmetry contract.** `PROBE_AT_POINT_FN` and `dom-analysis-extractor` MUST use the same selection criteria + same dynamic-id regex. Divergence = "wrong element clicked" class of bugs (see [.claude/rules/wrong-element-debugging.md](../../../../../../.claude/rules/wrong-element-debugging.md)).
7. **Iframe descent.** Coordinates translated to child-frame viewport. Cross-origin → `crossOriginIframe: true`.
8. **Debounce + throttle interaction.** Typing 1500 / scroll 500 / scroll-merge 3000 / hover 200 — different on purpose to avoid cross-event stutter.
9. **Auto-stop.** `RECORDING_MAX_STEPS=50` and `RECORDING_MAX_TIME_MS=30min`. Apply or commit before re-recording.

## Skipped / not covered

Implementation details of `getElementLabel`, `getProbedLabel`, `inferClickActionType`, `injectSelectChangeListener`, `injectAutofillListener`, private iframe helpers — read inline if needed.
