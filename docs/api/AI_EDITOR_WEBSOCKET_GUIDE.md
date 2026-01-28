# AI Editor (Preview Step Editor) — Frontend Integration Guide

## What it is

AI Editor is a realtime "Step Editor" for browser testing. The frontend lets a user describe an action (example: type `student12` into "Username input"), and the backend resolves the target element on the currently open preview page, highlights it, optionally asks the user to clarify between similar elements, and then executes the action.

Core idea: **the backend does not guess selectors**. It resolves targets using **semantic page data** (DOM snapshot) and stable element refs (`data-agent-ref`).

## Main backend components (conceptually)

- **Preview session**: keeps a Playwright page alive per `previewSessionId` and provides page snapshots (interactive nodes + stable refs).
- **WebSocket preview handler**: receives editor requests, enforces ownership/rate limits, emits page updates, lint results, and clarify requests.
- **Lint service**: resolves a step draft into ranked candidate elements (rule-based first, then LLM semantic matching when needed).
- **Apply service**: executes the step on the Playwright page. If the user already clarified, apply uses the user-selected element ref directly.

## How the frontend should interact (event-driven)

The backend is **fully event-driven**: it only does work when the frontend emits WebSocket events. "Auto lint after 3 seconds" is a **frontend debounce UX**, not a backend timer.

### 1) Subscribe to preview updates

- Emit `subscribe:preview` with `previewSessionId`.
- Backend immediately emits `preview:page` with the current page state including:
  - `url`: current page URL
  - `domNodes`: interactive elements for linting
  - `screenshot`: JPEG base64 string (no `data:` prefix) — use to render "live" browser preview
- Listen for subsequent `preview:page` events after apply actions.

### 2) Lint (resolve element candidates for a user step)

Trigger lint in either of these UX patterns:

- **Manual**: user clicks "Find using description".
- **Auto**: debounce input changes (example: 2–3 seconds after last edit) and emit lint automatically.

Emit `preview:step:lint` with:

- `previewSessionId`
- `stepDraft` (see "StepDraft fields" below)
- `pageRef` (optional)

Handle response:

- Listen to `preview:step:lint:result`.
  - If `status` is `resolved`: show highlight and allow "Apply".
  - If `status` is `ambiguous`: show top candidates, suggest refining description/hints, optionally re-lint.
  - If `status` is `not_found`: show message; allow user to refine description/hints and re-lint.
  - If `status` is `error`: show message; allow retry.

### 3) Clarify (when backend needs user to choose)

If backend cannot pick a single winner confidently, it emits `preview:step:clarify` (separate event) containing up to **3** candidate options.

Frontend should:

- Render a small selection UI: "Did you mean A / B / C?"
- Use the provided `label`, `reason`, and optional `boundingBox` to help the user choose.

When user selects one option, emit `preview:step:clarify:select` with:

- `previewSessionId`
- `stepId`
- `selectedRef`

Backend will respond with `preview:step:lint:result` status `resolved` for UI consistency (highlight + confidence=1.0).

Clarify TTL:

- Pending clarification expires after ~5 minutes.
- Confirmed selection is also kept ~5 minutes for apply.

### 4) Apply (execute the step)

Emit `preview:step:apply` with:

- `previewSessionId`
- `stepDraft` (same as lint)
- `pageRef` (optional)

Handle response:

- Listen to `preview:step:apply:result` (emitted immediately with result).
- If `success=true`, backend asynchronously emits `preview:page` with fresh snapshot + screenshot (only if page changed).

Important behavior:

- If the user already clarified, the backend will use that selection (by stable `ref`) and will not re-lint.
- Confirmed selection is cleared **only after successful apply**; if apply fails, the user can retry apply without re-clarifying (until TTL expires).

## StepDraft fields (what to send)

Required minimum:

- `id`: stable step identifier (used to bind clarify/apply)
- `type`: action type (`fill`, `click`, `wait`, `select`, `hover`, `scroll`, `press`, `check`, `uncheck`, `toggle`, `open`, `close`, `navigate`, `assert`)
- `description`: user intent / target description (main signal for matching)

Common fields:

- `value`:
  - required for `fill` (text), `select` (option value), `press` (key), `navigate` (URL)
  - optional for lint, required for apply when the action needs a value

Optional accuracy hints (recommended when available):

- `bindingHints.role`
- `bindingHints.label`
- `bindingHints.placeholder`
- `bindingHints.nearText`
- `bindingHints.autocomplete`
- `bindingHints.type`

Execution options (supported by backend):

- `options.replaceContent` (fill): when `false`, backend uses typing behavior instead of replacing
- `options.pressEnter` (fill): when `true`, backend presses Enter after fill
- `options.timeout` (wait): wait duration in ms (backend clamps to a maximum of 60000ms)

## When AI is invoked

AI is used only as a fallback for **semantic matching** when rule-based confidence is low or resolution is ambiguous:

- Rule-based scoring runs first.
- If confidence is high, backend resolves without AI.
- Otherwise, backend calls an LLM to rank candidates and provide brief reasons.
- If LLM indicates multiple equally good matches, backend asks the user to clarify (max 3 options).

The AI is constrained:

- It can only choose from provided candidate refs (no hallucinated refs).
- It returns structured output: interpretation + ranked refs + confidence + optional clarification question.

## Highlighting

Backend returns highlight instructions in lint/apply results:

- `ref` identifies the element (stable `data-agent-ref`)
- optional `boundingBox` can be used for overlay positioning

Frontend is responsible for drawing highlights in the UI.

## Screenshot streaming

Backend streams page screenshots via `preview:page` events:

- **Format**: JPEG base64 (no `data:image/jpeg;base64,` prefix)
- **Quality**: 60 (balance between size and clarity)
- **Max size**: ~900KB — if screenshot exceeds this, the `screenshot` field may be omitted
- **Throttle**: 500ms per session — rapid actions may skip intermediate screenshots
- **Diff detection**: Backend only emits `preview:page` after apply if page actually changed (URL or DOM structure)

Frontend rendering:

```javascript
// Example: render screenshot in img element
if (payload.screenshot) {
  img.src = `data:image/jpeg;base64,${payload.screenshot}`;
}
```

## Interactive preview control

Backend supports direct mouse and keyboard control of the preview browser for debugging coordinate-based steps and manual exploration.

### Coordinate mapping (frontend responsibility)

Backend uses **viewport coordinates** (0..viewportWidth-1, 0..viewportHeight-1). Frontend must map UI mouse events:

1. Listen to `preview:viewport` event after subscribe to get viewport dimensions.
2. Calculate scale: `scale = min(containerW / viewportW, containerH / viewportH)`
3. Calculate offsets: `offsetX = (containerW - viewportW * scale) / 2`, `offsetY = (containerH - viewportH * scale) / 2`
4. Map: `x = (mouseX - containerLeft - offsetX) / scale`, `y = (mouseY - containerTop - offsetY) / scale`
5. Clamp: `x = clamp(x, 0, viewportW-1)`, `y = clamp(y, 0, viewportH-1)`

### Mouse events

| Event                 | Payload                                          | Description                    |
| --------------------- | ------------------------------------------------ | ------------------------------ |
| `preview:mouse:move`  | `{previewSessionId, x, y}`                       | Hover (no snapshot)            |
| `preview:mouse:click` | `{previewSessionId, x, y, button?, clickCount?}` | Click (snapshot if changed)    |
| `preview:mouse:down`  | `{previewSessionId, x, y, button?}`              | Drag start                     |
| `preview:mouse:up`    | `{previewSessionId, x, y, button?}`              | Drag end (snapshot if changed) |
| `preview:mouse:wheel` | `{previewSessionId, deltaX, deltaY}`             | Scroll (snapshot if changed)   |

All mouse events respond with `preview:mouse:result { success, action, error?, timestamp }`.

### Keyboard events

| Event                    | Payload                               | Description                                                |
| ------------------------ | ------------------------------------- | ---------------------------------------------------------- |
| `preview:keyboard:type`  | `{previewSessionId, text}`            | Insert text (max 500 chars, snapshot if changed)           |
| `preview:keyboard:press` | `{previewSessionId, key, modifiers?}` | Press key (e.g., `key: 'Enter'`, `modifiers: ['Control']`) |

Both respond with `preview:mouse:result` and may emit `preview:page` if page changed.

### Rate limits

- **Mouse**: 100 events/10s (10/sec sustained)
- **Keyboard**: 50 events/10s

### Usage example

```javascript
let viewport = null;

socket.on("preview:viewport", (data) => {
  viewport = data.viewport;
});

// On preview mousemove
function onMouseMove(e) {
  if (!viewport) return;
  const coords = mapToViewport(e, viewport, containerRect);
  socket.emit("preview:mouse:move", { previewSessionId, ...coords });
}

// On preview click
function onClick(e) {
  if (!viewport) return;
  const coords = mapToViewport(e, viewport, containerRect);
  socket.emit("preview:mouse:click", { previewSessionId, ...coords });
}
```

Use interactive control for: debugging coordinate-based steps (canvas, drag&drop, maps), manual exploration, inspecting hover effects. Not a replacement for step-based workflow (lint + apply).

## Not supported (UI controls that should be disabled or ignored for now)

These controls are not wired in backend at the moment:

- "Use CSS selector"
- "Disable stability checks"
- "Disable caching"
- "Key press delay"
- "Act within iframe / Configure iframe"

## Practical frontend UX recommendations

- Debounce lint calls (example: 2–3 seconds) to avoid spamming; backend also rate-limits.
- Show "Linting…" while waiting for `preview:step:lint:result` or `preview:step:clarify`.
- In clarify UI, show the candidate label + reason, and optionally highlight candidates while hovering the selection list.
- On apply failure, keep the user's clarified selection (backend does) and show a "Retry apply" action.
- Render `screenshot` from `preview:page` to show live browser state instead of "waiting for snapshot".
