# WebSocket Preview Handler v7

## Overview

The preview handler registers all `preview:*` socket events for the step editor live preview subsystem. It is the single entry point for live communication between the web editor client and the Playwright browser session backend. The handler manages:

- **Session ownership & auth**: All events validate the user owns the preview session before executing
- **Rate limiting**: Prevents client-side abuse via connection-level throttling
- **Recording state**: Captures clicks, typing, navigation as trainable steps with AI semantic matching
- **Live preview**: Real-time DOM snapshots, video CDP screencast, DevTools data (network, HTML, a11y)
- **Step lifecycle**: Lint → clarify → apply → run, with inter-step delay stamping

Key services integrated: `PreviewSessionService`, `RecordingCaptureService`, `PreviewStepApplyService`, `PreviewRunService`, `IntentStepLintService`.

---

## Module-Level Constants & State

### Timing

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECORDING_TYPING_DEBOUNCE_MS` | 1500 | Time window: accumulate keystrokes before flushing Type step |
| `HOVER_PROBE_THROTTLE_MS` | 200 | Min delay between element-under-cursor probes (Cursor-style highlight) |
| `RECORDING_SCROLL_DEBOUNCE_MS` | 500 | Time window: accumulate wheel/scroll deltas before flushing Scroll step |
| `RECORDING_SCROLL_MERGE_WINDOW_MS` | 3000 | Time window: merge consecutive scroll steps on same container |
| `RECORDING_MAX_TIME_MS` | 1800000 (30 min) | Auto-stop recording if unattended beyond this; override: `WEB_RECORDING_MAX_TIME_MS` env |
| `RECORDING_MAX_STEPS` | 50 | Auto-stop recording after this many NEW steps; override: `WEB_RECORDING_MAX_STEPS` env |

### Per-Socket/Session State Maps

| State | Key | Holds |
|-------|-----|-------|
| `recordingTypingTimers` | session ID | Debounce timer for accumulating keystrokes |
| `recordingScrollTimers` | session ID | Debounce timer + accumulated wheel delta |
| `recordingAutoStopTimers` | session ID | Idle-timeout timer (clears on manual stop/disconnect) |
| `hoverProbeState` | `${socketId}:${sessionId}` | Last probe time, element key, coords, in-flight flag, page URL (nav guard) |
| `moveCoalesceState` | `${socketId}:${sessionId}` | Latest mouse coords, flush-scheduled flag |
| `wheelCoalesceState` | `${socketId}:${sessionId}` | Accumulated wheel delta, last coords, flush flag |
| `previewSubscriptions` | socket ID | Set of room names (preview sessions) this socket is subscribed to |
| `pendingClarifications` | `${sessionId}:${stepId}` | Candidates from last lint (for Show Alternatives flow) |
| `confirmedSelections` | `${sessionId}:${stepId}` | User's element selection from clarify picker |

---

## WebSocket Events

### Subscription & Lifecycle

#### `subscribe:preview`
- **Direction:** client→server
- **Trigger:** Editor loads a preview session or reconnects
- **Payload (in):** `{ previewSessionId: string }`
- **Server steps:**
  1. Validate user is authenticated (requireUser)
  2. Rate limit check (subscribe bucket)
  3. Validate previewSessionId not empty
  4. Check session ownership via `sessionService.isSessionOwned()`
  5. Join socket to room `preview:${sessionId}`; track subscription count per room
  6. On first subscriber: start preview streams (video CDP + devtools polling)
  7. Emit initial `preview:page` with domNodes snapshot
  8. Emit `preview:viewport` with device pixel ratio for coordinate mapping
- **Response event:** `preview:page` (immediate), `preview:viewport`, `error` on validation failure
- **Side-effects:** Increments room ref count; triggers `startPreviewStreams()` if count=0
- **Gotchas:** Idempotent (already subscribed = no-op); does NOT update signature dedup map (per-socket emit only)

#### `unsubscribe:preview`
- **Direction:** client→server
- **Trigger:** Editor closes preview, tab closes, or explicit unsubscribe
- **Payload (in):** `{ previewSessionId: string }`
- **Server steps:**
  1. Validate user
  2. Leave socket from room
  3. Decrement room ref count
  4. On last subscriber (count→0): stop all preview streams (video, devtools) via `stopPreviewStreams()`
  5. Clear hover probe, move coalesce, and wheel coalesce state for this socket+session pair
- **Response event:** None (fire-and-forget)
- **Side-effects:** Stops video/devtools streaming when last subscriber leaves; cleans up ephemeral state maps

---

### Step Lifecycle: Lint, Clarify, Apply, Run

#### `preview:step:lint`
- **Direction:** client→server
- **Trigger:** User clicks Find button or auto-lint after typing pauses (debounced)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    stepDraft: PreviewIntentStep      // incomplete step (may have only description)
    pageRef?: string                   // optional: page context
    includeAlternatives?: boolean      // if true, ask for candidates
    auditTrigger?: 'find_button'      // V25 — explicit user-action context for audit log
  }
  ```
- **Server steps:**
  1. Validate user
  2. Rate limit check (lint bucket)
  3. Import `IntentStepLintService` dynamically
  4. Call `lintStepWithAI()` with `forceFreshSnapshot: true` (explicit user moment), forwarding `auditTrigger`
  5. If status=`needs_clarification`: store candidates in `pendingClarifications` map, emit `preview:step:clarify` event (if includeAlternatives=true)
  6. Always emit `preview:step:lint:result` with status, message, candidates (if requested), highlight, interpretation, **`suggestion?` (V25 — coaching hint for AMBIGUOUS state, spreads only when present)**
- **Response event:** `preview:step:lint:result`, optionally `preview:step:clarify`
- **Side-effects:** Fresh DOM collect (~170ms); LLM call for semantic matching; populates clarification cache
- **Gotchas:** `includeAlternatives=true` triggers both clarify event AND lint:result with candidates; `includeAlternatives=false` emits candidates=[] even on needs_clarification (user must click Show Alternatives to get candidates)

#### `preview:step:clarify:select`
- **Direction:** client→server
- **Trigger:** User selects one candidate from clarify picker (Show Alternatives flow)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    stepId: string                 // the original step draft id
    selectedRef: string            // the chosen candidate ref
  }
  ```
- **Server steps:**
  1. Validate user, required fields
  2. Look up pending clarification from cache via key `${sessionId}:${stepId}`
  3. Find matching candidate by ref (error lint:result if absent)
  4. Delete the pending clarification; store selection in `confirmedSelections` map for use by next apply
  5. Emit `preview:step:lint:result` with `status: 'resolved'`, `confidence: 1.0`, the selected candidate and a success highlight — **no re-lint / no LLM call** (user confirmation is treated as ground truth)
- **Response event:** `preview:step:lint:result` (resolved, confidence 1.0)
- **Side-effects:** Stores confirmed selection (consumed by preview:step:apply next). No LLM call.
- **Gotchas:** If pending clarification not found or expired, emit error lint:result; selection only valid for ONE apply (deleted after apply succeeds)

#### `preview:step:apply`
- **Direction:** client→server
- **Trigger:** User clicks Apply on a step (after optional clarification)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    stepDraft: PreviewIntentStep
    pageRef?: string
    intentTestCaseId?: string         // if provided, auto-persist appliedStep to DB
  }
  ```
- **Server steps:**
  1. Validate user, rate limit
  2. Guard: abort if `PreviewRunService.isRunning()` (cannot apply during active run)
  3. Normalize step options (timeout, replaceContent, pressEnter)
  4. Check for confirmed selection from clarify flow; if found, pass to apply service
  5. Call `PreviewStepApplyService.applyStep()` (executes step on live page)
  6. On success: emit `preview:step:apply:result` immediately. **(V26)** also clears any stale `failureEvidence` on the step before persistence.
  7. **On failure (V26):** if a `StepFailureEvidence` bundle is attached AND `intentTestCaseId` provided AND no run is active — persist the bundle to DB and emit `preview:step:needs-review` to the room. Skipped during batch apply to avoid spam.
  8. If `intentTestCaseId` provided: auto-persist sanitized `appliedStep` to DB via `IntentTestCaseService`.
  9. Async (setImmediate): collect fresh snapshot; if DOM changed, emit `preview:page` to room with updated domNodes
  10. Clean up confirmed selection from map (only after success)
- **Response event:** `preview:step:apply:result`, optionally `preview:step:needs-review` (V26 on failure), then async `preview:page` if DOM changed
- **Side-effects:** Playwright action on live page; updates recording URL baseline (for nav step dedup); DB persist if intentTestCaseId provided; dedups page snapshots by signature; **(V26)** failure-evidence persistence + needs-review broadcast
- **Gotchas:** Blocks during active run (PreviewRunService check); confirmed selection deleted only on success (allows retry); page emit dedups by signature (second-level dedup after per-socket check); needs-review event only fires when no run is active.

#### `mobile:step:apply`
- **Direction:** client→server
- **Trigger:** Mobile editor applies a step (WebSocket equivalent of POST /mobile/sessions/:id/apply)
- **Payload (in):**
  ```typescript
  {
    mobileSessionId: string
    stepDraft: PreviewIntentStep
    intentTestCaseId?: string
  }
  ```
- **Server steps:** Identical to `preview:step:apply`, but routes to mobile session context
- **Response event:** `mobile:step:apply:result`
- **Side-effects:** Identical to web preview; DB persist if intentTestCaseId provided

---

### Input: Mouse

#### `preview:mouse:move`
- **Direction:** client→server
- **Trigger:** Mouse moves over preview viewport (high frequency, ~10ms intervals)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    x: number
    y: number
  }
  ```
- **Server steps:**
  1. Validate user, rate limit
  2. Coalesce: record latest (x, y) in `moveCoalesceState`; schedule ONE `executeMouseAction('move')` per tick via setImmediate
  3. Side effect 1 (recording): update `recordingLastHover` with (x, y, timestamp) if recording
  4. Side effect 2 (hover probe): **DISABLED in May 2026** (`REACT_HOVER_PROBE_ENABLED = false`). The hover outline is now painted by the in-page `preview-hover-overlay.service.ts` listening to `mousemove` directly inside the iframe — no server-side PROBE per move, no `preview:element:hover` emit. The legacy throttle + `probeInteractiveElementAt` + emit code is guarded so it can be re-enabled as a cross-origin-iframe fallback if needed.
- **Response event:** None (fire-and-forget)
- **Side-effects:**
  - Coalesces multiple moves per event loop into ONE Playwright call
  - Records hover position for click step pre-probe
  - (Legacy, disabled) Emits hover element for React-rendered highlight
  - Skips probe during active run (clears hover)
  - Guards against stale probe after page navigation
- **Gotchas:** Coalesce means `executeMouseAction()` may lag coords by 1 tick, but hover probe + recording use LATEST coords from map (race-safe); probe result filtered by reject reason (v23) to distinguish "no element" vs "cross-origin" vs "non-interactive"

#### `preview:mouse:click`
- **Direction:** client→server
- **Trigger:** User clicks on preview
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    x: number
    y: number
    button?: 'left' | 'right' | 'middle'
    clickCount?: 1 | 2
    modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean }
  }
  ```
- **Server steps:**
  1. Validate user, rate limit
  2. If recording: pre-click probe for click-target element state (reuse fresh hover if <500ms old and inside bbox)
  3. Execute click: `sessionService.executeMouseAction('click', x, y, button, clickCount)`
  4. Emit snapshot if changed
  5. If recording + valid element:
     - Check for cross-origin iframe or unsupported host (<webview>, <object>, <embed>); emit warning + skip step
     - Flush pending scroll + typing + close field session (preserve step order)
     - Build hover chain (V22): emit hover-steps for ancestor popup triggers (80ms dwell for menus, 400ms for others)
     - Build click step via `RecordingCaptureService.inferClickActionType()` (dblclick/right-click support)
     - Emit recording step immediately (non-blocking); run LLM in background
     - If LLM refines element: emit `preview:recording:step:update` with same id
- **Response event:** `preview:page` (snapshot), `preview:recording:warning` (cross-origin), `preview:recording:step`
- **Side-effects:**
  - Recording captures element state BEFORE click (not after)
  - Hover chain merges multi-level menus into ordered hover steps
  - Binding hints + recorded fingerprint attached for first-apply resolution
  - Step id reused for LLM update (frontend merges by id)
- **Gotchas:**
  - Pre-click probe re-uses cached hover if recent and inside bbox (v18) to match visual highlight
  - Double-click coalescing (v21): second click within 100ms reuses first click's step id so LLM update goes to correct row
  - Cross-origin iframe clicks silently skip step creation (cannot record into separated browsing context)
  - Hover chain falls back to lastHover if chain empty (legacy path)

#### `preview:mouse:down`, `preview:mouse:up`
- **Direction:** client→server
- **Trigger:** Mouse button pressed/released
- **Payload (in):** `{ previewSessionId, x, y, button? }`
- **Server steps:** Execute `sessionService.executeMouseAction('down'/'up', ...)` immediately; emit snapshot if needed
- **Response event:** `preview:page` (snapshot if changed)
- **Side-effects:** Non-recording (drag state is implicit in page state); snapshot validates page responded

#### `preview:mouse:wheel`
- **Direction:** client→server
- **Trigger:** User scrolls (high frequency)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    x: number
    y: number
    deltaX: number
    deltaY: number
  }
  ```
- **Server steps:**
  1. Coalesce: accumulate delta into `wheelCoalesceState` per socket+session; schedule ONE `executeMouseAction('wheel', accDelta)` per tick
  2. If recording: accumulate scroll into `recordingScrollTimers` (debounce 500ms); on timer fire, emit Scroll step
  3. Merge optimization: if previous scroll on same container <3s old, merge into single step (v10)
- **Response event:** None (fire-and-forget)
- **Side-effects:**
  - Coalesces multiple wheel events per tick into ONE Playwright call with summed deltas
  - Recording accumulates scroll separately: debounce flushes Type step, merges consecutive scrolls within 3s window
- **Gotchas:** Coalesce means Playwright call is 1 tick delayed; recording debounce is 500ms (independent of coalesce)

#### `preview:mouse:probe` (V26)
- **Direction:** client→server
- **Trigger:** UI requests an on-demand element probe at coordinates (decoupled from hover state — used by inspector / debug overlays).
- **Payload (in):**
  ```typescript
  { previewSessionId: string; x: number; y: number }
  ```
- **Server steps:**
  1. Validate session ownership.
  2. Rate-limit via the same mouse bucket as other mouse events.
  3. Call `RecordingCaptureService.probeForRecording(page, x, y)`.
  4. Emit `preview:mouse:probe:result` with the `ProbedElement` (same shape returned by hover probe).
- **Response event:** `preview:mouse:probe:result` — `{ previewSessionId, x, y, element, timestamp }`.
- **Side-effects:** none beyond the probe `page.evaluate`.
- **Gotchas:** uses the mouse rate-limit bucket; never blocks recording state.

---

### Input: Keyboard

#### `preview:keyboard:type`
- **Direction:** client→server
- **Trigger:** User types in editor (high frequency, ~50ms intervals)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    text: string               // single char or multi-char paste
  }
  ```
- **Server steps:**
  1. Validate user, rate limit
  2. Execute type: `sessionService.executeKeyboardType(text)` (Playwright type)
  3. Emit snapshot if changed
  4. If recording:
     - Check for pending paste flag (set by keyboard:press on Ctrl+V)
     - If paste: close field session first (emit its Type step with pre-paste value), emit Paste step, return
     - Else: accumulate text into buffer; probe focused element (label, ref, binding hints)
     - Open field session if new target (closes prior session first)
     - Reset debounce timer (1500ms)
     - On timer fire: emit Type step or merge with previous if same element
- **Response event:** `preview:page` (snapshot)
- **Side-effects:**
  - Recording buffers keystrokes, probe element lazily on FIRST character
  - Field session captures live input.value on close (source of truth vs keystroke buffer)
  - Debounce merges consecutive typing in same field into one step (reuses step id)
  - Paste triggers dedicated step (not merged into typing buffer)
- **Gotchas:**
  - Field session debounce interaction (v22): if session open, mid-typing debounce is pre-empted (session closes on blur/nav, reads live value)
  - Paste resets field session (new session opened for post-paste typing)
  - Multi-line fields (<textarea>) get special merge logic (v10)

#### `preview:keyboard:press`
- **Direction:** client→server
- **Trigger:** Special key pressed (Enter, Escape, Ctrl+V, etc.)
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    key: string              // 'Enter', 'Escape', 'Control', etc.
    modifiers?: { shift?, ctrl?, meta?, alt? }
  }
  ```
- **Server steps:**
  1. Validate user, rate limit
  2. Execute key press: `sessionService.executeKeyboardPress(key, modifiers)`
  3. Emit snapshot if changed
  4. If recording:
     - Detect Ctrl+V / Cmd+V: set `recordingPendingPaste` flag (next type event will emit Paste step)
     - Detect Enter (newline): 
       - If multiline field + recording: flush typing buffer + emit Type step
       - If single-line field: close field session (submit intent); may emit form submission step
     - Detect Escape: close field session + clear hover (menu navigation cleanup)
     - Detect Tab: close field session (focus shift)
- **Response event:** `preview:page` (snapshot), optionally `preview:recording:step`
- **Side-effects:**
  - Sets pending paste flag for next type event
  - Closes field session on newline/escape/tab
  - Emits form submission step on Enter (single-line field)
- **Gotchas:**
  - Newline behavior is context-aware (multiline vs single-line)
  - Tab closes session but may not emit step (focus shift is implicit)

---

### Page Navigation

#### `preview:page:refresh`
- **Direction:** client→server
- **Trigger:** User clicks refresh button or presses F5
- **Payload (in):** `{ previewSessionId }`
- **Server steps:**
  1. Validate user, rate limit (pageAction bucket)
  2. Guard: abort if run active
  3. Call `sessionService.refreshPage()`
  4. Emit page action result (success/error)
  5. Arm first-frame guarantee for video stream (CDP screencast may pause during reload)
  6. If recording:
     - Flush pending scroll + typing + close field session
     - Emit refresh step (or merge with previous if same URL + <5s old)
     - Update recording URL baseline
- **Response event:** `preview:page:action:result` (via `emitPageActionResult`)
- **Side-effects:** Page reloads; video stream re-arms; recording emits navigate step; field session closed
- **Gotchas:** First-frame guarantee re-arms (v13) because CDP may not emit frames immediately after reload; refresh coalesces consecutive same-URL refreshes into single step with count

#### `preview:page:back`, `preview:page:forward`
- **Direction:** client→server
- **Trigger:** User clicks back/forward button
- **Payload (in):** `{ previewSessionId }`
- **Server steps:** Similar to refresh; call `sessionService.goBack()` or `goForward()`; if recording, emit navigate step
- **Response event:** `preview:page:action:result`
- **Side-effects:** Page navigates; recording emits navigate step; field session closed

#### `preview:page:reset`
- **Direction:** client→server
- **Trigger:** User clicks "Reset to original URL" button
- **Payload (in):** `{ previewSessionId }`
- **Server steps:**
  1. Validate user, rate limit
  2. Stop recording (if active) with reason 'reset'
  3. Call `sessionService.resetPage()` (navigate to original URL)
  4. Emit reset result
  5. Emit fresh snapshot
- **Response event:** `preview:page:action:result`, then `preview:page`
- **Side-effects:** Stops recording; navigates to baseline URL; clears all step buffers

---

### Tab Management

#### `preview:tab:switch`
- **Direction:** client→server
- **Trigger:** User clicks tab in tab bar
- **Payload (in):** `{ previewSessionId, tabIndex }`
- **Server steps:**
  1. Validate user
  2. Call `sessionService.switchTab(tabIndex)`
  3. Emit `preview:tab:switched` with updated tab list
  4. If recording + switch successful: emit switch_tab recording step
- **Response event:** `preview:tab:switched`, optionally `preview:recording:step`
- **Side-effects:** Changes active page; video/devtools reattach to new page; recording emits step

#### `preview:tab:close`
- **Direction:** client→server
- **Trigger:** User clicks × on non-root tab
- **Payload (in):** `{ previewSessionId, tabIndex }`
- **Server steps:**
  1. Validate user, rate limit
  2. Guard: refuse if last tab (root protection)
  3. Call `sessionService.closeTab(tabIndex)`
  4. Broadcast `preview:tab:closed` to room (all subscribers notified)
- **Response event:** `preview:tab:closed` (room broadcast) or nothing (if refused)
- **Side-effects:** Closes page/tab; if closed tab was active, switches to next tab (triggers page switch internally)

---

### Viewport & Device

#### `preview:viewport:set`
- **Direction:** client→server
- **Trigger:** User changes device preset or manually sets width/height
- **Payload (in):** `{ previewSessionId, width, height }`
- **Server steps:**
  1. Validate user, dimensions
  2. Call `sessionService.setViewport(width, height)` (Playwright setViewportSize)
  3. Restart video stream at new resolution (CDP screencast reattach)
  4. Emit fresh snapshot via `emitSnapshotForHandshake()` (bypasses signature dedup—client needs new coords)
  5. Emit `preview:viewport` with new dimensions for client coordinate rescaling
- **Response event:** `preview:viewport`, then async `preview:page`
- **Side-effects:** Playwright viewport changes; video stream restarts; DOM reflows; snapshot dedups are bypassed (handshake mode)
- **Gotchas:** Must bypass signature dedup (v20) because domNodes boundingBox changes due to reflow; client uses handshake mode to sync coordinates

---

### DevTools: Network, HTML, Accessibility

#### `preview:network:detail:request`
- **Direction:** client→server
- **Trigger:** User clicks on a network request in DevTools panel
- **Payload (in):** `{ previewSessionId, id }`  (request id)
- **Server steps:**
  1. Validate user, session ownership
  2. Fetch request detail from DevTools collector via `collector.getNetworkDetail(id)`
  3. Emit `preview:network:detail` with headers, body, timing, etc.
- **Response event:** `preview:network:detail`
- **Side-effects:** None (read-only)

#### `preview:network:list:request`
- **Direction:** client→server
- **Trigger:** User opens DevTools Network panel (initial load)
- **Payload (in):** `{ previewSessionId }`
- **Server steps:**
  1. Validate user, session ownership
  2. Fetch network summary list from collector via `collector.getNetworkItems()`
  3. Emit `preview:network:list` with array of request summaries
- **Response event:** `preview:network:list`
- **Side-effects:** None (read-only)

#### `preview:html:request`
- **Direction:** client→server
- **Trigger:** User opens DevTools HTML tab (initial load or refresh)
- **Payload (in):** `{ previewSessionId, domVersion }`  (client's current DOM version)
- **Server steps:**
  1. Validate user, session ownership
  2. Fetch HTML from collector via `collector.fetchHtml(currentDomVersion)`
  3. Emit `preview:html:update` with HTML string (may be truncated), domVersion, truncated flag
- **Response event:** `preview:html:update`
- **Side-effects:** None (read-only); dedupes by domVersion (only sends if changed)

#### `preview:accessibility:request`
- **Direction:** client→server
- **Trigger:** User opens DevTools Accessibility tab (initial load or refresh)
- **Payload (in):** `{ previewSessionId, domVersion }`
- **Server steps:**
  1. Validate user, session ownership
  2. Fetch a11y tree from collector via `collector.fetchAccessibility(currentDomVersion)`
  3. Emit `preview:accessibility:update` with tree array, domVersion, truncated flag
- **Response event:** `preview:accessibility:update`
- **Side-effects:** None (read-only); dedupes by domVersion

---

### Context & Environment (Step Variables)

#### `preview:context:set`
- **Direction:** client→server
- **Trigger:** User sets environment variables / context data in editor settings
- **Payload (in):**
  ```typescript
  {
    previewSessionId: string
    data: Record<string, string>   // key-value pairs (e.g., username, email)
  }
  ```
- **Server steps:**
  1. Validate user, session ownership
  2. Call `sessionService.setContextData(previewSessionId, contextData)`
  3. Emit `preview:context:updated` to room
- **Response event:** `preview:context:updated`
- **Side-effects:** Persists context in session state; available for step interpolation ({{variable}} syntax)

---

### Session Inspection (V26)

#### `preview:session:inspect`
- **Direction:** client→server
- **Trigger:** UI pre-Run check — does the live preview already have an authenticated session? Powers the "Active session detected" banner.
- **Payload (in):** `{ previewSessionId: string }`
- **Server steps:**
  1. Validate ownership.
  2. Read same-origin cookies + sessionStorage + localStorage **counts only** (no values, privacy-safe).
  3. Emit `preview:session:inspect:result` with `{ cookieCount, sessionStorageKeyCount, localStorageKeyCount }`.
- **Response event:** `preview:session:inspect:result`
- **Side-effects:** none (read-only).
- **Gotchas:** no throttle bucket; rate-limited via generic auth/validation.

---

### Recording Upload (V26)

The recording upload flow now has client→server response events to complete the prompt initiated by the server.

#### `preview:recording:upload:resolve`
- **Direction:** client→server
- **Trigger:** User picks a file in response to a server-initiated `preview:recording:upload:prompt`.
- **Payload (in):** `{ previewSessionId, stepId, file: { handle, metadata } }`
- **Server steps:** download → `setFiles()` workflow → emit upload step capture.

#### `preview:recording:upload:cancel`
- **Direction:** client→server
- **Trigger:** User dismisses the upload chooser.
- **Payload (in):** `{ previewSessionId, stepId }`
- **Server steps:** cleanup; no step captured.

---

### Dialog & Auth (V26)

#### `preview:dialog:response`
- **Direction:** client→server
- **Trigger:** Generic dialog confirmation flow (alert/confirm bypass).
- **Payload (in):** internal — see source. Consumed by alert/confirm bypass logic.

#### `preview:auth:dismiss`
- **Direction:** client→server
- **Trigger:** User dismisses the login-wall detection banner.
- **Side-effects:** logged for audit; non-fatal (warn on handler error).

---

## Server → Client Events (Broadcast/Push)

### State & Snapshots

| Event | Direction | Trigger | Payload | Purpose |
|-------|-----------|---------|---------|---------|
| `preview:page` | server→client | On subscribe, after apply, DOM tick | `{ previewSessionId, url, pageTitle, domVersion, pageSignature, domNodes[], timestamp }` | Live page snapshot with coordinate data |
| `preview:viewport` | server→client | On subscribe, after viewport:set | `{ previewSessionId, viewport: {width, height}, devicePixelRatio, timestamp }` | Viewport metadata for coordinate mapping |
| `preview:element:hover` | server→client | **DISABLED May 2026** — `REACT_HOVER_PROBE_ENABLED = false`. Code retained behind the flag for cross-origin-iframe fallback. The in-page `preview-hover-overlay.service.ts` replaces this. | `{ previewSessionId, element: {tag, label, boundingBox}, timestamp }` | (legacy) Cursor-style element highlight |
| `preview:hover-overlay:set` | client→server | FE flips in-page hover overlay mode when `previewNavigationMode` toggles | `{ previewSessionId, mode: 'navigation' \| 'recording' \| 'off' }` | Drives `setHoverOverlayMode` in [`preview-hover-overlay.service.ts`](../preview-hover-overlay.service.ts) |
| `preview:pick:start` / `:cancel` | client→server | One-shot read-only element picker | `{ previewSessionId }` | Drives [`preview-element-pick.service.ts`](../preview-element-pick.service.ts) |
| `preview:pick:state` | server→client | Pick mode entered / exited | `{ previewSessionId, active, reason?, error?, timestamp }` | Tracks pick session lifecycle |
| `preview:pick:result` | server→client | Pick fired — one-shot per session | `{ previewSessionId, description?, stableId?, testId?, ref?, tag?, recordedFingerprint?, bindingHints?, suggestedAction?, lint?, timestamp }` | Identity + suggested action for the manual step form |
| `preview:recording:warning` | server→client | Click on cross-origin/unsupported host | `{ previewSessionId, type, message, iframeSelector?, hostKind?, timestamp }` | Warn user recording cannot capture this element |

### Step & Run Results

| Event | Trigger | Payload |
|-------|---------|---------|
| `preview:step:lint:result` | `preview:step:lint` | `{ status, message, confidence, candidates[], highlight[], interpretation?, applyDisabled?, suggestion?, timestamp }` |
| `preview:step:clarify` | `preview:step:lint` (includeAlternatives=true) | `{ previewSessionId, stepId, candidates[], interpretation, message, timestamp }` |
| `preview:step:apply:result` | `preview:step:apply` | `{ success, error?, appliedStep?, timestamp }` |
| `preview:step:needs-review` (V26) | apply failure with `failureEvidence` and no active run | `{ previewSessionId, stepId, intentTestCaseId, summary: { lastError, totalAttempts, pageUrl, originatingStrategy }, timestamp }` |
| `mobile:step:apply:result` | `mobile:step:apply` | `{ success, error?, appliedStep?, timestamp }` |
| `preview:mouse:probe:result` (V26) | `preview:mouse:probe` | `{ previewSessionId, x, y, element, timestamp }` |
| `preview:session:inspect:result` (V26) | `preview:session:inspect` | `{ previewSessionId, cookieCount, sessionStorageKeyCount, localStorageKeyCount }` |
| `preview:recording:upload:prompt` (V26) | server requests file from user | `{ previewSessionId, stepId, accept?, multiple? }` |
| `preview:recording:upload:warning` (V26) | upload flow degraded | `{ previewSessionId, stepId, reason: 'no_file_selected' \| 'capture_failed' \| 'listener_setup_failed' }` |
| `preview:page:action:result` | `preview:page:*` (refresh, back, forward) | `{ action, success, error?, timestamp }` |

### Recording

| Event | Trigger | Payload | Purpose |
|-------|---------|---------|---------|
| `preview:recording:step` | Click, keyboard, scroll, navigate (during recording) | `{ previewSessionId, step: PreviewIntentStep, highlight?, timestamp }` | New trainable step captured |
| `preview:recording:step:update` | LLM refinement (bg) | `{ previewSessionId, step: {...with refined type/description}, timestamp }` | Update step after semantic analysis |

### Tab State

| Event | Trigger | Payload |
|-------|---------|---------|
| `preview:tab:switched` | `preview:tab:switch` | `{ previewSessionId, tabs[], activeTabIndex, timestamp }` |
| `preview:tab:closed` | `preview:tab:close` | `{ previewSessionId, tabs[], activeTabIndex, closedTabIndex, timestamp }` |

### DevTools Streaming

| Event | Trigger | Payload |
|-------|---------|---------|
| `preview:network:list` | `preview:network:list:request` | `{ previewSessionId, items: [...] }` |
| `preview:network:detail` | `preview:network:detail:request` | `{ previewSessionId, id, headers, body, timing, ... }` |
| `preview:html:update` | `preview:html:request` or DOM tick | `{ previewSessionId, domVersion, html, truncated }` |
| `preview:accessibility:update` | `preview:accessibility:request` or a11y tick | `{ previewSessionId, domVersion, tree[], truncated }` |

### Context

| Event | Trigger | Payload |
|-------|---------|---------|
| `preview:context:updated` | `preview:context:set` | `{ previewSessionId, data, timestamp }` |

### Video Stream (CDP Screencast)

The handler delegates video frame emission to `PreviewVideoStreamRegistry.startStream()`. Frames are pushed via namespaced room emit asynchronously, not in response to client events. See `getPreviewVideoStreamRegistry()` for streaming lifecycle.

---

## Critical Invariants

1. **Must-Respond Rule**: Every request event gets a response event (or error event). Never leave client hanging.
2. **Ownership Check**: All events validate `sessionService.isSessionOwned(previewSessionId, userId)` before state mutation.
3. **Recording ↔ Run Mutual Exclusion**: Cannot apply steps while run is active; cannot start new recording while run active.
4. **Rate Limiting**: Each socket gets throttled per event type (subscribe, mouse, keyboard, pageAction, lint, apply). Burst = rejected with error event.
5. **Snapshot Dedup**: DOM snapshots are deduplicated by signature hash (second-level after per-socket tracking). Viewport:set and clarify:select bypass dedup (handshake mode).
6. **Coalescing**: Mouse move/wheel events are coalesced per event loop tick to prevent Playwright call flood; recording debounces separately.
7. **Field Session SoT**: When field session is open, live input.value on close is the canonical Type step value (not keystroke buffer).
8. **Hover Chain**: Multi-level menu hovers emit in order (V22), with adaptive dwell thresholds (80ms popup-trigger, 400ms else).

---

## Exports

```typescript
// Main handler factory
export function registerPreviewHandler(socket: TypedSocket, io: Server<ClientToServerEvents, ServerToClientEvents>): void

// Helpers (non-critical, may be internal)
function emitRecordingStep(...): void          // Stamps inter-step delay + tabIndex
function emitPageActionResult(...): void       // Emit page action success/error
function emitSnapshotAlways(...): void         // Force emit snapshot
function emitSnapshotIfChanged(...): void      // Dedup-aware emit
function emitSnapshotForHandshake(...): void   // Bypass dedup (viewport/clarify)
function startPreviewStreams(...): void        // Start video + devtools on first subscriber
function stopPreviewStreams(...): void         // Stop video + devtools on last unsubscriber
function closeFieldSession(...): void          // Close typing session, emit Type step
function flushPendingScroll(...): void         // Emit accumulated scroll step
function flushPendingTyping(...): void         // Emit accumulated type step
```

---

## Error Handling

All handlers emit `error` event on validation/auth failure:
```typescript
socket.emit('error', {
  code: 'RATE_LIMITED' | 'VALIDATION_ERROR' | 'FORBIDDEN' | 'SUBSCRIPTION_ERROR' | ...,
  message: string,
  timestamp: ISO string
})
```

Non-critical side effects (hover probe, recording capture, LLM refinement) fail gracefully and log warnings without blocking the response.

---

## Example: Click-to-Recording Flow

```
User clicks on "Add to Cart" button
  ↓
preview:mouse:click
  ├─ Pre-click probe for element state
  ├─ Execute click via Playwright
  ├─ Emit preview:page (snapshot)
  └─ If recording:
      ├─ Flush pending typing/scroll (preserve order)
      ├─ Close field session (emit Type step with live input.value)
      ├─ Build hover chain (ancestors that meet dwell threshold)
      ├─ Emit hover-steps
      ├─ Build click step from pre-click element + binding hints + recorded fingerprint
      ├─ Emit preview:recording:step immediately (non-blocking)
      └─ Run LLM in background → if element refined, emit preview:recording:step:update (same id)
```

```
User clicks "Find" on a vague step
  ↓
preview:step:lint (includeAlternatives: true)
  ├─ Force-fresh snapshot collect (~170ms)
  ├─ Call IntentStepLintService.lintStepWithAI()
  ├─ If needs_clarification:
  │    ├─ Store candidates in pendingClarifications map
  │    ├─ Emit preview:step:clarify (with candidates)
  │    └─ Emit preview:step:lint:result (candidates[], applyDisabled: true)
  ├─ User clicks one candidate from picker
  │    ↓
  │    preview:step:clarify:select
  │    ├─ Store selection in confirmedSelections map
  │    ├─ Re-lint with selectedRef constraint
  │    └─ Emit preview:step:lint:result (updated, applyDisabled: false)
  ├─ User clicks Apply
  │    ↓
  │    preview:step:apply
  │    ├─ Fetch confirmed selection
  │    ├─ Call PreviewStepApplyService.applyStep(selectedRef)
  │    ├─ Emit preview:step:apply:result (success)
  │    ├─ Delete selection from map (only on success)
  │    └─ Emit preview:page (if DOM changed)
```

