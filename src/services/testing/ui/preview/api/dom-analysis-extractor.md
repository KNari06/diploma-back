# `dom-analysis-extractor.service.ts` — API Reference

> Source: [dom-analysis-extractor.service.ts](../dom-analysis-extractor.service.ts) (~17KB)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

Transforms a `LiteSnapshot` (raw page collection from `agent/core/lite/collectors/snapshot-collector.ts`) into a normalized `InteractiveNode[]` for the resolver/lint candidate set, and into `DomAnalysisData` for persistent storage in `intelligent_page_visits.dom_analysis`. Strips sensitive data (no values, only `hasValue` flags), truncates long text, populates ARIA state, validation flags, hierarchy hints and visual properties.

**Symmetry contract:** `extractInteractiveNodes()` and `recording-capture.service.ts`'s `PROBE_AT_POINT_FN` MUST use the same Tier-1/Tier-2 selection rules, the same dynamic-id regex, and the same text normalization. Breaking this symmetry causes silent wrong-element bugs (recording sees X, resolver doesn't). See [.claude/rules/wrong-element-debugging.md](../../../../../../.claude/rules/wrong-element-debugging.md).

## Exports

### Class
`DomAnalysisExtractorService` — static-only.

### Types
- `InteractiveNode` — re-exported from [preview.types.ts](../preview.types.ts); see fields below.
- `DomAnalysisData = { interactiveNodes, url?, title?, capturedAt, version }`.

### Constants
- `MAX_INTERACTIVE_NODES = 500` — caps payload (raised from 200 for modern dashboards).
- `MAX_TEXT_LENGTH = 100` — text/label truncation.
- `MAX_PARENT_CHAIN_LENGTH = 6` — ancestor chain depth cap.
- `DOM_ANALYSIS_VERSION = '2.0'` — V2 adds ARIA state, validation, labels, hierarchy.

---

## Public methods

### `DomAnalysisExtractorService.extract(snapshot): DomAnalysisData`

- **Caller:** `IntelligentTestStorageService` (after step apply); lint endpoints that need the storable form.
- **Parameters:** `snapshot: LiteSnapshot`.
- **Returns:** `{ interactiveNodes, url?, title?, capturedAt, version: '2.0' }`.
- **Side-effects:** debug log when `MAX_INTERACTIVE_NODES` reached. Pure function otherwise.
- **Steps:** call `extractNodes(snapshot)`; wrap with metadata.

### `DomAnalysisExtractorService.extractNodes(snapshot): InteractiveNode[]`

- **Caller:** element resolver candidate building, intent linter, [preview-step-apply](../preview-step-apply.service.ts).
- **Parameters:** `snapshot: LiteSnapshot`.
- **Returns:** array, ≤ 500 entries, in document order.
- **Side-effects:** none (input snapshot unchanged).
- **Steps:**
  1. Iterate `snapshot.elements`.
  2. Skip disabled + non-visible (these are filtered, not retained as soft penalties at this layer).
  3. Convert each via internal `elementToInteractiveNode()`.
  4. Stop at `MAX_INTERACTIVE_NODES`.

### `DomAnalysisExtractorService.getVersion(): string`

Returns `DOM_ANALYSIS_VERSION` (`'2.0'`). Used by API contracts and migrations.

---

## `InteractiveNode` field reference

Grouped by purpose. All fields are optional unless marked.

### Identity
| Field | Type | Meaning |
|---|---|---|
| `ref` | `string?` | `data-agent-ref` (preview only; never in replay). |
| `tag` | `string` | HTML tag (lowercase). |
| `id` | `string?` | HTML id attribute (filtered; framework-generated dropped). |
| `testIdAttr` | `string?` | `data-testid` / `data-test` / `data-cy` / `data-qa` / `data-automation-id`. |

### Semantics & roles
| Field | Type | Meaning |
|---|---|---|
| `role` | `string?` | Explicit ARIA role or computed via `implicit-role.util.ts`. |
| `type` | `string?` | Input type (`text`, `password`, `checkbox`, `submit`, …). |
| `frameworkClickable` | `'react'\|'vue'\|'angular'\|...?` | Framework that bound a click handler. |

### Text/label
| Field | Type | Meaning |
|---|---|---|
| `text` | `string?` | `innerText`, NFC-normalized, max 100 chars. |
| `labelText` | `string?` | `<label for>` / wrapping `<label>` / `aria-labelledby`. |
| `ariaLabel` | `string?` | `aria-label` attribute. |
| `title` | `string?` | `title` attribute (tooltips; critical for icon-only). |
| `placeholder` | `string?` | `placeholder` attribute. |
| `isIconButton` | `boolean?` | Button has only icon child(ren). |
| `iconLabel` | `string?` | Semantic icon name (SVG `<title>`, sprite ref, `data-lucide`, FontAwesome class, …). |
| `svgIcon` | `string?` | Angular Material registry name (e.g. `chevron-left-outline`). |
| `iconClasses` | `string?` | Class tokens related to icon library. |
| `childTestId` | `string?` | `data-testid` of single icon child when wrapper has none. |

### State
| Field | Type | Meaning |
|---|---|---|
| `isInteractive` | `boolean?` | Always true (filter property). |
| `isVisible` | `boolean?` | Visible (display/visibility/opacity/viewport). |
| `isDisabled` | `boolean?` | `disabled` attribute or aria-equivalent. |
| `isContentEditable` | `boolean?` | `contenteditable="true"`. |
| `tabIndex` | `number?` | `tabindex >= 0`. |
| `hasOnclick` | `boolean?` | Inline `onclick`. |
| `hasAriaHaspopup` | `boolean?` | `aria-haspopup` present. |

### ARIA state (V2)
| Field | Type | Meaning |
|---|---|---|
| `checked` | `boolean?` | Checkbox/radio. |
| `ariaExpanded` | `boolean?` | Dropdown/accordion. |
| `ariaPressed` | `boolean?` | Toggle button. |
| `ariaSelected` | `boolean?` | Tab/listbox option. |
| `ariaChecked` | `boolean \| 'mixed' ?` | Custom checkbox. |
| `ariaCurrent` | `string?` | Pagination/stepper marker (`page`, `step`, `true`, …). |
| `ariaValueNow` | `number?` | Slider/spinbutton current value. |
| `ariaValueText` | `string?` | Slider/spinbutton text label. |
| `ariaInvalid` | `boolean?` | Form validation flag. |

### Form & data
| Field | Type | Meaning |
|---|---|---|
| `name` | `string?` | HTML `name`. |
| `autocomplete` | `string?` | `email`, `username`, `current-password`, … |
| `required` | `boolean?` | `required` or `aria-required`. |
| `readOnly` | `boolean?` | `readonly` or `aria-readonly`. |
| `invalid` | `boolean?` | `aria-invalid` or `:invalid`. |
| `hasValue` | `boolean?` | **Privacy-safe flag** — value not stored. |
| `dataValue` | `string?` | `data-value` / `<option value>`. |

### Hierarchy & container
| Field | Type | Meaning |
|---|---|---|
| `parentRefChain` | `string[]?` | Refs of key ancestors, closest-first, depth ≤ 6. |
| `containerRef` | `string?` | Nearest form/dialog/section. |
| `containerTitles` | `string[]?` | Titles of key containers (legend, fieldset, heading). |
| `nearestLandmark` | `string?` | ARIA landmark (banner/navigation/main/complementary/form/search). |
| `customElementTag` | `string?` | Closest semantic custom element ancestor (`app-button`, `my-icon`, …). |

### Tables / lists
| Field | Type | Meaning |
|---|---|---|
| `dataRowKey` | `string?` | Stable row id (Ant Design `data-row-key`). |
| `rowClickable` | `boolean?` | Heuristic flag (cursor:pointer + hover style). |
| `nearestRowText` | `string?` | Sibling cell text — uniqueness anchor. |
| `siblingIndex` | `number?` | nth-of-type among same-class siblings. |
| `arrowDir` | `'left'\|'right'\|'up'\|'down' ?` | Cardinal direction from SVG path geometry. |

### Bootstrap / popups
| Field | Type | Meaning |
|---|---|---|
| `bsToggle` | `string?` | `data-bs-toggle` (`modal`, `dropdown`, …). |
| `bsTarget` | `string?` | `data-bs-target` selector. |
| `ariaHasPopup` | `string?` | `aria-haspopup` value. |
| `ariaActiveDescendant` | `string?` | `aria-activedescendant` id. |

### Visual (V8)
| Field | Type | Meaning |
|---|---|---|
| `backgroundColor` | `string?` | Named color (red/grey/blue/light-grey/dark-red/...). |
| `textColor` | `string?` | Named foreground color. |
| `shapeHint` | `string?` | `rounded` / `pill` / `circle` / `slightly-rounded`. |
| `sizeHint` | `'small'\|'medium'\|'large' ?` | Pixel-dimension category. |
| `iframeSource` | `string?` | Same-origin iframe name/id. |

### Geometry & visibility
| Field | Type | Meaning |
|---|---|---|
| `boundingBox` | `{ x, y, width, height }?` | Rounded ints. |
| `isTopMostAtCenter` | `boolean?` | `elementFromPoint(center)` returns this element or descendant. |
| `isInsideActiveModal` | `boolean?` | Inside the active modal/dialog/popover layer. |
| `isDynamicId` | `boolean?` | `id` matches dynamic-id regex (see below). |

---

## Tier-1 / Tier-2 selection (symmetry with `PROBE_AT_POINT_FN`)

### Tier-1 — interactive selectors (high confidence)

Native tags: `button`, `a`, `input`, `select`, `textarea`, `summary`, `details`, `label`.

ARIA roles: `button`, `link`, `tab`, `menuitem`, `checkbox`, `radio`, `switch`, `slider`, `spinbutton`, `textbox`, `searchbox`, `combobox`, `gridcell`, `rowheader`, `columnheader`, `option`.

Attribute-based: `[onclick]`, `[tabindex]:not([tabindex="-1"])`, `[contenteditable="true"]`, `[draggable="true"]`.

Framework: `[ng-click]`, `[v-on:click]`, `[x-on:click]`, `[@click]`, React `__reactProps$.onClick`, jQuery delegated.

### Tier-2 — framework + cursor:pointer walk (lower confidence)

Custom components not matching Tier-1, scanned globally:
- `cursor: pointer` computed style.
- Framework-bound elements (React/Vue/Angular).
- Icon-only elements with stable identity (id/testId/icon-tag).
- Ancestor delegation detection (parent has handler).
- Visual signals: hover classes, toggle classes.

**Filters:** skip `pointer-events: none`, elements smaller than 5×5 px, `<label>` wrappers without click handler, pure text nodes.

### Symmetry rules (must match `PROBE_AT_POINT_FN`)

1. Text normalization (NFC + invisible-char strip + whitespace collapse).
2. Dynamic-id regex (`isDynamicId()`).
3. Implicit role computation (`computeImplicitRole`).
4. Framework detection list.
5. Tier-1/Tier-2 acceptance criteria + min-size gate.

A change in one place without the other = wrong-element bug.

---

## Active modal / overlay detection

### `isInsideActiveModal`

Set by snapshot collector, exposed here. Detection layers:

1. **Iron-clad selectors:** `.modal.show`, `.modal.active`, `[role="dialog"]:not([aria-hidden="true"])`, `.popover.show`, `.tooltip.show`, `[data-headlessui-state*="open"]`, `.ReactModal__Overlay`, etc.
2. **Heuristics:** `aria-modal="true"`, backdrop + sibling dialog, z-index layering.

Resolver boosts candidates inside the active modal context.

### `isTopMostAtCenter`

Per element: `document.elementFromPoint(centerX, centerY)` (pierces shadow DOM); walk up ancestor chain; if original element is in the chain → `true`. Resolver penalises non-topmost as covered by overlay.

---

## Dynamic-id classification

Delegated to [dynamic-id.util.ts](../dynamic-id.util.ts). Patterns include:

- React `useId`: `:rN:`, `:RN:`.
- Vue `__BVID__`, `el-id-N`.
- Angular Material: `mat-form-field-label-N`, `mat-option-N`.
- MUI: `mui-N`, `popup-N`.
- Radix / Headless UI: `radix-…`, random suffixes.
- Bootstrap/Popper: `popover-<uuid>`, `tooltip-<uuid>`.
- Generic: UUID/GUID, long hex (≥24 chars), `id-<random>`, `temp-id-<uuid>`.

`isDynamicId: true` excludes the id from compiled plans (see [locator-plan-builder.md](locator-plan-builder.md)) and triggers a soft penalty in the resolver's structural filter.

---

## Helpers

- `rgbToNamedColor(rgb)` — `rgb(...)` / `rgba(...)` → human name (`red`, `grey`, …) or `undefined`.
- `borderRadiusToShape(radius, bounds?)` — `50%` → `'circle'`, `16px` → `'rounded'`, …
- `truncateText(text, max=100)` — trim + truncate; `undefined` for empty.

## Constants summary

| Constant | Value | Purpose |
|---|---|---|
| `MAX_INTERACTIVE_NODES` | 500 | Cap on extracted nodes. |
| `MAX_TEXT_LENGTH` | 100 | Text/label truncation. |
| `MAX_PARENT_CHAIN_LENGTH` | 6 | Ancestor depth cap. |
| `DOM_ANALYSIS_VERSION` | `'2.0'` | Schema version. |

## Invariants

1. `node.id` and `node.testIdAttr` are populated whenever the snapshot collector found them — drives identity fast-path.
2. Text fields are NFC-normalized — same as record-time, enables fingerprint matching across scripts.
3. No sensitive data — `hasValue` flag instead of value.
4. Parent chain ≤ 6.
5. `version` field always present in `DomAnalysisData`.
6. Document order preserved.

## Related

- `agent/core/lite/collectors/snapshot-collector.ts` — collects `LiteSnapshot` from page (Tier-1/Tier-2 origin).
- [recording-capture.md](recording-capture.md) — owns `PROBE_AT_POINT_FN`, the symmetry partner.
- `dynamic-id.util.ts`, `implicit-role.util.ts`, `text-normalizer.util.ts` — shared utilities.
- [element-resolver.md](element-resolver.md) — consumes `InteractiveNode[]`.
- [intent-step-lint.md](intent-step-lint.md) — scores candidates from this set.
- [.claude/rules/wrong-element-debugging.md](../../../../../../.claude/rules/wrong-element-debugging.md) — diagnostic order for symmetry breaks.
