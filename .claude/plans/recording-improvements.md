# Editor Recording Improvements — Detailed Plan

## Summary

Improve recording accuracy for the 3 most broken events: **Click (~70% → ~95%)**, **Scroll (~50% → ~90%)**, **Hover (~40% → ~90%)**. Plus minor fixes for Drag & Drop.

All changes are scoped to **recording-capture.service.ts** + **preview.handler.ts** (recording-only code). Zero impact on replay, agent, or test execution.

---

## CHANGE 1: PROBE_AT_POINT_FN — Smart Interactive Element Resolution

**File:** `recording-capture.service.ts` lines 121-195

**Problem:** Walk-up limited to 5 levels with hardcoded `interactiveTags` / `interactiveRoles` lists. Misses div-buttons with `onclick`, `tabindex`, `@click`, `cursor:pointer`. Stays on `<span>` inside deep component trees.

### What changes:

**1a. Replace the walk-up loop with a two-pass approach:**

```
Pass 1 — Collect ancestor chain (up to 12 ancestors):
  For each node from directHit to body, store:
    - tag
    - role
    - hasTabindex (tabindex !== null && tabindex !== '-1')
    - hasOnclick (onclick attribute exists)
    - hasFrameworkBinding (@click, ng-click, (click), x-on:click, v-on:click)
    - ariaLabel
    - className (first 100 chars)
    - all existing fields we already collect

Pass 2 — Pick best target from chain:
  Priority order (first match wins):
    1. Native interactive tag (button, a, input, select, textarea, summary)
    2. ARIA widget role (full list: button, link, checkbox, radio, tab,
       menuitem, menuitemcheckbox, menuitemradio, option, switch,
       combobox, slider, spinbutton, treeitem, gridcell, searchbox, textbox)
    3. Behavioral: tabindex >= 0 OR onclick OR framework binding
    4. CSS class heuristic: className matches /\b(btn|button|clickable|toggle|action)\b/i
       → Mark as candidate, keep walking
    5. If nothing found from chain: check cursor:pointer on directHit only
       (single getComputedStyle call — acceptable cost)
    6. If still nothing: return directHit as-is (fallback)
```

**1b. Increase walk limit from 5 to 12:**

Real-world component trees: MUI Button has 6 levels from `<path>` to `<button>`. Ant Design can have 7-8. 12 covers virtually everything without performance cost (DOM walk is O(1) per level).

**1c. Return `ancestorChain` alongside the chosen target:**

The probe returns an additional `ancestorChain` field — array of `{ tag, role, text, ariaLabel, className }` for each ancestor up to the chosen target. This is **not saved to DB** — it's used by the server-side fallback (Change 2) to decide if LLM consultation is needed.

**1d. Add `resolvedVia` field:**

Track how the target was chosen: `'nativeTag' | 'ariaRole' | 'behavioral' | 'cssClass' | 'cursorPointer' | 'directHit'`. Used for logging/debugging and to decide LLM fallback trigger.

### New ProbedElement fields:

```typescript
interface ProbedElement {
  // ... existing fields ...

  /** How the interactive target was resolved (V15) */
  resolvedVia?: 'nativeTag' | 'ariaRole' | 'behavioral' | 'cssClass' | 'cursorPointer' | 'directHit';

  /** Ancestor chain from directHit to chosen target — for server-side validation (V15, transient) */
  ancestorChain?: Array<{
    tag: string;
    role?: string;
    text?: string;
    ariaLabel?: string;
    className?: string;
  }>;
}
```

### What NOT changes:
- `PROBE_FOCUSED_FN` — stays as-is. `document.activeElement` is always correct.
- Return shape is backward-compatible — new fields are optional.

---

## CHANGE 2: Server-Side LLM Fallback for Ambiguous Elements

**File:** `recording-capture.service.ts` — new method `resolveInteractiveTarget()`

**Trigger:** When `resolvedVia === 'directHit'` (probe couldn't find any interactive ancestor) OR `resolvedVia === 'cssClass'` (low confidence heuristic).

### Flow:

```
probeForRecording() returns ProbedElement with resolvedVia
    ↓
preview.handler.ts click handler checks resolvedVia
    ↓
if (resolvedVia === 'directHit' || resolvedVia === 'cssClass'):
    call RecordingCaptureService.resolveInteractiveTarget(page, probedElement)
    ↓
    resolveInteractiveTarget:
      1. Check LLM cache (Map<string, number>) — keyed by
         `${directHitTag}|${parentTag}|${parentRole}|${parentClass}`
         If cached → use chain[cachedIndex] → return updated ProbedElement

      2. LLM call (small/fast model, e.g. GPT-4o-mini or Gemini Flash):
         Prompt: "Given this DOM ancestor chain from a click target,
                  which element is the interactive control the user intended to click?
                  Return the 0-based index."
         Input: ancestorChain (tag, role, text, ariaLabel, className for each)
         Output: { index: number }

      3. Cache the result

      4. Re-probe the chosen ancestor for full ProbedElement data
         (get its ref, boundingBox, ariaExpanded, etc.)

      5. Return updated ProbedElement with resolvedVia: 'llm'
```

### Latency budget:
- LLM call: ~200-400ms (small model, small prompt ~100 tokens)
- Happens AFTER the click was already executed (probe is pre-click, but we do another probe post-click for state — so this fits in the existing async gap)
- Cache hit: 0ms (in-memory Map, per recording session)
- Expected LLM calls per session: 2-5 (most patterns cache quickly)

### Cache key design:
```
Key: `${directHitTag}|${parent1Tag}.${parent1ClassName?.split(' ')[0]}|${parent2Tag}`
Example: "span|div.MuiButton-label|button.MuiButton-root"
```
This caches across similar component instances on the same page.

### New method signature:

```typescript
static async resolveInteractiveTarget(
  page: Page,
  probed: ProbedElement,
  llmCache: Map<string, number>,
): Promise<ProbedElement>
```

---

## CHANGE 3: Scroll Recording Fix

**File:** `preview.handler.ts` (mouse:wheel handler) + `recording-capture.service.ts` (captureScroll)

### Problems:
1. Records absolute pixels — breaks on different viewport/content
2. No scroll container detection — scrolling a `<div>` records as page scroll
3. Race condition — scroll event fires before SPA content loads
4. Micro-scrolls recorded (any amount)

### Fixes:

**3a. Detect scroll container:**

Add `elementFromPoint` at scroll coordinates to find which element is being scrolled. Walk up to find the first scrollable ancestor (`overflow: auto|scroll`, or `document.scrollingElement`).

New field in scroll step: `options.scrollTarget`:
```typescript
{
  scrollTarget?: {
    isPage: boolean;           // true = page scroll, false = container scroll
    containerSelector?: string; // CSS selector of the scrollable container
    containerRef?: string;      // data-agent-ref if available
  }
}
```

**3b. Record "scroll to element" instead of pixels:**

After scroll completes (debounce fires), find the **element that became visible** near the top of the viewport. Store as `scrollToRef` or `scrollToText`. This survives layout changes.

Implementation: After debounce, call `page.evaluate` to find the first element in viewport center that has meaningful text/role.

**3c. Minimum threshold:**

Ignore scroll < 50px (trackpad noise). Current code records any deltaY ≠ 0.

**3d. Race condition guard:**

Before recording scroll, check if page has loaded:
```typescript
// In wheel handler, before accumulating
if (!page.url() || page.url() === 'about:blank') return;
```

Also: delay scroll recording start until first meaningful content is loaded (check against recording baseline URL).

### captureScroll changes:

```typescript
static captureScroll(
  accumulatedDeltaY: number,
  pageUrl?: string,
  accumulatedDeltaX?: number,
  scrollTarget?: { isPage: boolean; containerSelector?: string; containerRef?: string },
  scrollToElement?: { text?: string; ref?: string },
): PreviewIntentStep | null
```

---

## CHANGE 4: Hover Recording Fix

**File:** `preview.handler.ts` (mouse:move handler + click handler hover logic)

### Problems:
1. 200ms-5s window too wide — catches accidental passes
2. No check if hover actually matters (no :hover effects)
3. "Different element" comparison uses directHit ref — fails for children of same button

### Fixes:

**4a. Increase minimum hover dwell time to 400ms:**

Change from 200ms to 400ms. Real dropdown-triggering hovers require the user to pause.

**4b. Compare by resolved interactive parent, not directHit:**

Current: stores `lastHoverRef` from probe (might be `<span>` inside button).
Click handler compares `lastHoverRef !== clickElementRef`.
If both are children of the same `<button>` → false positive hover.

Fix: After Change 1, probe returns the resolved interactive parent. Store and compare **that** ref.

**4c. Only record hover if it preceded a click on a DIFFERENT interactive element:**

This is already the intent, but the comparison is broken. With resolved targets, it works correctly.

**4d. Add hover necessity check (optional, V2):**

After recording the hover but before emitting, check if a `visibility` or `display` change happened on any element near the click target. If nothing appeared/disappeared → suppress the hover step.

Implementation: Compare a lightweight DOM snapshot (count of visible elements in a rect around click target) before hover vs after hover. If same → hover was cosmetic-only → skip.

For V1: Skip this. The 400ms threshold + correct element comparison will eliminate most false positives. Add the DOM snapshot check in V2 if needed.

---

## CHANGE 5: buildBindingHints — Enrich with `text` and `tag`

**File:** `recording-capture.service.ts` method `buildBindingHints`

### Problem:
Current hints: `{ role, label, placeholder, nearText, type, autocomplete }`. Missing `text` and `tag` — the two most useful fields for LLM resolver at replay time.

### Fix:

```typescript
static buildBindingHints(element: ProbedElement): BindingHints {
  const hints: BindingHints = {};
  if (element.role) hints.role = element.role;
  if (element.labelText) hints.label = element.labelText;
  if (element.placeholder) hints.placeholder = element.placeholder;
  if (element.ariaLabel) hints.nearText = element.ariaLabel;
  if (element.containerText && !hints.nearText) hints.nearText = element.containerText;
  if (element.type) hints.type = element.type;
  if (element.name) hints.autocomplete = element.name;
  // V15: Add text content for better LLM resolution at replay
  if (element.text) hints.text = element.text;
  // V15: Add tag for structural matching
  if (element.tag) hints.tag = element.tag;
  return hints;
}
```

### BindingHints type update:

```typescript
interface BindingHints {
  // ... existing fields ...
  text?: string;   // V15
  tag?: string;    // V15
}
```

---

## CHANGE 6: Drag & Drop — Use Resolved Interactive Target

**File:** `preview.handler.ts` (mouse:down + mouse:up handlers)

### Problem:
Same probe issue as click — drag start/end elements might be `<span>` instead of `<div draggable>`.

### Fix:
Apply the same enriched PROBE_AT_POINT_FN. Additionally, in the walk-up loop, check for `draggable="true"` attribute:

```
// In Pass 2 priority, add before behavioral:
   3.5. draggable="true" attribute → choose this element
```

No other changes needed — captureDragAndDrop already uses buildBindingHints which will benefit from Changes 1 and 5.

---

## CHANGE 7: getElementLabel — Include `text` for more roles

**File:** `recording-capture.service.ts` method `getElementLabel`

### Problem:
Current code only uses `text` for `tag === 'a' || tag === 'button' || role === 'button' || role === 'link'`. But many interactive elements have text: `role="tab"`, `role="menuitem"`, `role="option"`, `<summary>`, etc.

### Fix:

```typescript
static getElementLabel(element: ProbedElement | null): string {
  if (!element) return 'element';

  const textRoles = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'treeitem',
  ]);
  const textTags = new Set(['a', 'button', 'summary', 'th', 'label']);

  return (
    element.ariaLabel
    || element.labelText
    || (textTags.has(element.tag) || (element.role && textRoles.has(element.role))
      ? element.text
      : undefined)
    || element.placeholder
    || element.name
    || element.role
    || element.tag
  )?.slice(0, 60) || 'element';
}
```

---

## Implementation Order

| Step | Change | Risk | Effort | Files |
|------|--------|------|--------|-------|
| 1 | **Change 1**: PROBE_AT_POINT_FN rewrite | Medium | ~2h | recording-capture.service.ts |
| 2 | **Change 5**: buildBindingHints + BindingHints type | Low | ~20min | recording-capture.service.ts, preview.types.ts |
| 3 | **Change 7**: getElementLabel expansion | Low | ~10min | recording-capture.service.ts |
| 4 | **Change 4**: Hover fixes | Low | ~30min | preview.handler.ts |
| 5 | **Change 3**: Scroll fixes | Medium | ~1.5h | preview.handler.ts, recording-capture.service.ts |
| 6 | **Change 6**: Drag & Drop | Low | ~15min | recording-capture.service.ts (already benefits from Change 1) |
| 7 | **Change 2**: LLM fallback | Medium | ~1.5h | recording-capture.service.ts, preview.handler.ts |

**Total: ~6 hours**

Steps 1-4 are the highest impact / lowest risk — they improve accuracy immediately without adding LLM dependency. Step 7 (LLM fallback) is the safety net for the remaining edge cases.

---

## Testing Strategy

1. **Manual**: Record test on sites with known problematic patterns:
   - MUI demo page (deep nesting, div-buttons)
   - Tailwind UI (div-with-onclick patterns)
   - Ant Design (complex trees)
   - A plain HTML form (regression)

2. **Unit tests**: Update `recording-capture.service.test.ts`:
   - Test `isInteractive()` against known patterns
   - Test `buildBindingHints()` returns text/tag
   - Test `getElementLabel()` for expanded role list

3. **Replay validation**: Record → Apply All on the same sites. Compare step count and success rate before/after.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `getComputedStyle(cursor)` slow on heavy pages | Low | Only called once for directHit element, not per ancestor. Benchmarked: <1ms |
| LLM cache miss rate high | Medium | Cache key uses component class pattern, not instance. Same MUI Button pattern caches once for all instances on page |
| Scroll `elementFromPoint` returns wrong container | Low | Fall back to page scroll if container detection fails |
| Existing test recordings broken by new data shape | None | All new ProbedElement fields are optional. Existing data in DB untouched. Only new recordings get enriched data |
| 12-level walk too deep, picks wrong ancestor | Low | Priority order ensures native tags/ARIA roles win. If we reach level 12, it's almost always correct |
