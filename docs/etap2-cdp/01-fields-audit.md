# Etap 2 — CDP Snapshot Migration: Fields Audit

**Goal:** для каждого поля `LiteElement` определить откуда оно возьмётся в CDP path
(DOMSnapshot raw / AXTree / minimal `page.evaluate` runtime / Node-side derived).

**Source of truth:** `src/agent/core/lite/lite-types.ts` LiteElement interface (~70 fields).

**CDP capabilities** (verified May 2026):
- `DOMSnapshot.captureSnapshot` — DOM tree, attributes, computed styles, layout bounds, paintOrders, textValue, stacking contexts. **NO**: event listeners, accessibility roles, JS runtime state.
- `Accessibility.getFullAXTree` — implicit ARIA roles, computed accessible names, ignored flag with reasons, parent/childIds, focusable/focused/pressed/checked properties.
- `DOMDebugger.getEventListeners` — only direct `addEventListener` registrations; **does NOT** detect React synthetic events (delegated single root listener), Vue v-on, Angular (click) — they hide listeners behind framework runtime.

---

## Legend

| Source | Meaning |
|---|---|
| **DS** | DOMSnapshot.captureSnapshot — direct from raw arrays |
| **AX** | Accessibility.getFullAXTree |
| **EVAL** | minimal `page.evaluate` (runtime JS) — required, no CDP alternative |
| **DERIVE** | Node.js post-process (walk over DS data) — no extra CDP/eval call |
| **EXISTING** | Reuses existing service / Playwright API |
| **PROBE** | Recorder probe (PROBE_AT_POINT_FN) — not snapshot, point-probe at click; unchanged |

---

## Per-field source map

### Identity & basic
| Field | Source | Notes |
|---|---|---|
| `ref` | **DERIVE** | Generate `data-agent-ref` attribute via single-call `page.evaluate` (DS doesn't write attrs back to DOM). Same monotonic counter scheme as today. |
| `tag` | **DS** | `nodes.nodeName[i]` → strings table. |
| `role` | **AX** | Implicit role for native HTML, computed by Chrome accessibility engine. Currently we compute manually via `computeRole` — AX gives it free. |
| `name` (accessible name) | **AX** | `axNode.name` — computed name cascade per WAI-ARIA. Currently we run our own cascade (labelText → ariaLabel → text). |
| `firstTextFragment` | **DERIVE** | Walk DS `nodes.textValue` + child indexes via `parentIndex`, find first non-decorative text leaf. |

### HTML attributes (all DOMSnapshot.attributes)
| Field | Source | Notes |
|---|---|---|
| `type` | **DS** | `<input type="...">` |
| `placeholder` | **DS** | |
| `autocomplete` | **DS** | |
| `inputmode` | **DS** | |
| `htmlName` | **DS** | `name` attribute |
| `htmlId` | **DS** | `id` attribute |
| `ariaLabel` | **DS** | |
| `title` | **DS** | |
| `ariaCurrent` | **DS** | |
| `ariaValueText` | **DS** | |
| `dataValue` | **DS** | `data-value` attribute |
| `childTestId` | **DERIVE** | Walk children via `parentIndex`, find direct icon child with `data-testid`. |
| `iconLabel` | **DERIVE** | Walk children: SVG `<title>`, sprite `<use href>`, data-lucide/feather/icon attrs. Same logic as current. |
| `bsToggle` | **DS** | `data-bs-toggle` |
| `bsTarget` | **DS** | `data-bs-target` |
| `ariaHasPopup` | **DS** | |
| `ariaActiveDescendant` | **DS** | |
| `dataRowKey` | **DS** | |
| `arrowDir` | **DERIVE** | SVG path geometry walk. Inspecting `d=` attribute of `<path>` children — DS gives us all attrs. |
| `href` | **DS** | For `<a>` only. Note: DS gives RAW value; we need absolute URL — derive from `documentURL` + relative href. |

### Runtime properties (page.evaluate REQUIRED — no CDP alternative)
| Field | Source | Notes |
|---|---|---|
| `value` | **EVAL** | `el.value` runtime property (not attribute). Privacy-sensitive — replace with `__masked__` if non-empty in production. |
| `checked` | **EVAL** | `el.checked` runtime. Note: HTML `<input checked>` attribute is DS-visible but is INITIAL state; current state can differ. |
| `disabled` | **EVAL** + **DS** | DS gives `disabled` attribute and `aria-disabled`; EVAL needed for `el.disabled` property which can be programmatically set. Hybrid: use DS first, EVAL for completeness. |
| `hasValue` | **EVAL** | Derived from `el.value` — needed even if value masked. |
| `ariaExpanded` | **DS** | Attribute. |
| `ariaPressed` | **DS** | Attribute. |
| `ariaSelected` | **DS** | Attribute. |
| `ariaChecked` | **DS** | Attribute (`true`/`false`/`mixed`). |
| `ariaValueNow` | **DS** for attr, **EVAL** for native input.value (range/number/progress/meter) | Hybrid: prefer attr, fallback to runtime via EVAL. |
| `required` | **DS** | Attribute. |
| `readOnly` | **DS** + **EVAL** | DS attribute + aria-readonly. EVAL for `el.readOnly` runtime property (some frameworks set it programmatically). |
| `invalid` | **EVAL** | `el.matches(':invalid')` + aria-invalid attribute. |
| `isContentEditable` | **EVAL** | `el.isContentEditable` is a computed property, not attribute. |
| `tabIndex` | **DS** | `tabindex` attribute. **Caveat:** `el.tabIndex` runtime can differ on focusable elements without explicit attr. For full correctness — EVAL fallback. |
| `hasOnclick` | **EVAL** | `el.onclick !== null` is runtime; `onclick=` attribute also DS-visible. Hybrid. |
| `hasAriaHaspopup` | **DS** | Attribute exists check. |

### Computed styles
| Field | Source | Notes |
|---|---|---|
| `visible` | **DERIVE** from DS computedStyles | display !== 'none' && visibility !== 'hidden' && opacity > 0. Same logic as today. |
| `computedZIndex` | **DS** computedStyles | Request `'z-index'` in `computedStyles` array. |
| `isPositioned` | **DS** computedStyles | `position` !== 'static'. |
| `isTopMostAtCenter` | **DERIVE** from DS layout.paintOrders + bounds | Use paintOrders to determine which element is on top at the center point of bbox. |
| `bounds` | **DS** | `layout.bounds[i]` = `[x, y, width, height]`. |
| `backgroundColor` | **DS** computedStyles | Request `'background-color'`. |
| `textColor` | **DS** computedStyles | Request `'color'`. |
| `borderRadius` | **DS** computedStyles | Request `'border-radius'`. |

### Framework detection (EVAL only)
| Field | Source | Notes |
|---|---|---|
| `frameworkClickable` | **EVAL** | **Single biggest CDP gap.** Requires `Object.keys(el)` to find `__reactFiber$`, `__reactInternalInstance$`, `el.__vue__`, `el.__vueParentComponent`, `el.__ngContext__`, `el._ngHost`. Plus attribute checks for Alpine (`x-data`, `x-on:click`), HTMX (`hx-get` etc), Stimulus (`data-action`). Some checks (Alpine/HTMX/Stimulus) are attribute-based and DS-visible, but framework runtime markers (React fiber) require EVAL. |

### Hierarchy & context
| Field | Source | Notes |
|---|---|---|
| `parentRefChain` | **DERIVE** | DS `parentIndex[]` walk-up. Need `ref` of each parent → done after ref-assignment pass. |
| `containerRef` | **DERIVE** | DS walk to nearest form/dialog/section. |
| `containerTitles` | **DERIVE** | Walk parents, look for `<h1>`-`<h6>`/`role=heading`/`<legend>`. DS gives all needed data. |
| `context` | **DERIVE** | "inside: Product Card 'iPhone 15'" — derived from containers. |
| `nearestRowText` | **DERIVE** | Walk to nearest `<tr>`/`role=row`/`li[role=option]` and concat sibling cell texts. DS-walkable. |
| `siblingIndex` | **DERIVE** | Position among same-class siblings. DS-walkable. |

### Modal / overlay
| Field | Source | Notes |
|---|---|---|
| `isInsideActiveModal` | **DERIVE** | Same 4-rule heuristic, applied in Node.js post-process: role=dialog, aria-modal, native `<dialog open>`, positional fallback (z-index ≥ 1000 + 30%+ viewport coverage + cursor:pointer + class regex). All signals in DS. |
| `LiteSnapshot.activeModalRef` | **DERIVE** | Output of modal detection pass. |

### Shadow DOM
| Field | Source | Notes |
|---|---|---|
| `isInsideShadowDOM` | **DS** | DS `nodes.shadowRoots.index/value` — contains shadow root nodes. Walk up to determine. |
| `isSlotted` | **DERIVE** + **DS** | Slotted = light DOM rendered in shadow slot. DS exposes slot info; combined walk needed. |
| `slotName` | **DS** | `slot` attribute on slotted element + assigned slot name. |
| `shadowDepth` | **DERIVE** | Count shadow root traversals when walking up `parentIndex`. |

### Iframes
| Field | Source | Notes |
|---|---|---|
| `iframeSource` | **DS** | DS captures multiple `documents` (one per iframe) with `frameId`. Each element knows its document. Cross-origin iframes — supported by DS (BIG win). |

### Computed labels (current logic)
| Field | Source | Notes |
|---|---|---|
| `labelText` | **DERIVE** | `<label for=>` walk, wrapping `<label>`, aria-labelledby — all walkable from DS. AX `name` is preferred but `labelText` is more raw. |
| `isIconButton` | **DERIVE** | Heuristic: only SVG/img children, no text. DS-walkable. |

### Visuals (V8)
| Field | Source | Notes |
|---|---|---|
| `iconClasses` | **DS** | `class` attribute filter for icon-related (fa-*, material-icons, etc). |

### Etap 1B.2 fields (we added recently)
| Field | Source | Notes |
|---|---|---|
| `routerLink` | **DS** | `routerlink` attribute. |
| `formControlName` | **DS** | `formcontrolname` attribute. |
| `vueScopeId` | **DS** | `data-v-XXXXXXXX` attribute walk. **NOTE:** currently NOT in snapshot-collector (only in recorder); this audit reveals we already have a known gap. CDP path can fix it cheaply. |
| `cssClass` | **DS** | `class` attribute, post-filtered same way as recorder. **NOTE:** also NOT in current snapshot-collector — same gap. CDP path closes it. |

---

## Source distribution summary

| Source | Field count | % |
|---|---|---|
| DS direct | ~25 | 36% |
| AX | 2 | 3% |
| DERIVE (Node post-process from DS) | ~22 | 31% |
| EVAL (page.evaluate, runtime) | ~14 | 20% |
| Hybrid DS+EVAL | ~7 | 10% |

**Pure DS+AX coverage: ~70%.** Remaining ~30% require either Node-side derivation (cheap, no extra round trips) or one batched `page.evaluate` for runtime fields.

## Critical EVAL fields (cannot avoid)

These ALWAYS require `page.evaluate` and define the lower bound of latency for the CDP hybrid:

1. `frameworkClickable` (React fiber detection)
2. `value` / `hasValue` (input runtime state)
3. `checked` (current vs initial)
4. `isContentEditable` (computed property)
5. `invalid` (`:invalid` pseudo-class match)
6. `hasOnclick` (runtime listener)
7. `el.disabled` / `el.readOnly` runtime property fallback

**One batched `page.evaluate` collecting all of these in single round-trip is required.** Estimated cost: ~200-500ms on 11k DOM (vs 12-16s for full collector today).

---

## Symmetry contract — recorder ↔ snapshot

Recorder probe (`PROBE_AT_POINT_FN`) is **unchanged** in this migration. It uses different code path (point-probe at click coords, walks cursor:pointer, builds ProbedElement).

The fields that MUST agree byte-for-byte between recorder probe and snapshot collector:
- `id`, `testIdAttr`, `name`, `formControlName`, `routerLink`, `vueScopeId`
- Text normalisation (NFC + invisible-char strip + whitespace collapse)
- `dynamic-id.util.ts` regex set
- `firstTextFragment` extraction algorithm
- `class` token filter

**These are all DS+DERIVE in the new path** — no EVAL needed for them, so they're symmetry-safe.

---

## Performance projection

For a 11k DOM page (juz40 folders dense scenario):

| Operation | Today | CDP hybrid |
|---|---|---|
| DOMSnapshot.captureSnapshot | — | ~80-250ms |
| Accessibility.getFullAXTree | — | ~150-300ms (parallel with DS) |
| WS transport (5-10MB JSON) | — | ~150-400ms |
| Node.js mapping (DS → LiteElement) | — | ~300-500ms |
| Batched `page.evaluate` (runtime fields) | — | ~200-500ms |
| Modal detection (Node-side) | — | ~50-100ms |
| `page.evaluate` walk (current) | **12-16s** | — |
| **TOTAL** | **12-16s** | **~1-1.7s** |

**Speedup: 8-15×.** No coverage loss when EVAL covers runtime fields properly.

---

## Open questions for Week 2

1. **paintOrder vs explicit z-index** for `isTopMostAtCenter` — paintOrder is more reliable but requires geometric reasoning over bounds.
2. **Cross-origin iframe** field path — DS gives them but our `LiteElement.iframeSource` carries iframe URL, not `frameId`. Need translation.
3. **Closed shadow DOM** — DS exposes them via `shadowRootType` but our `EVAL` for runtime fields can't access closed roots from outside. Need to decide: skip closed-shadow framework detection, or invoke EVAL inside shadow root context (Playwright `page.frameLocator`-style).
4. **Performance threshold for "dense"** — at what DOM-node count CDP becomes profitable vs current 12-16s? Probably anything > 2000 nodes.

---

## Decision log

- ✅ **Hybrid CDP + minimal EVAL** chosen over pure CDP (lossy on framework detection).
- ✅ **AXTree is critical** — gets us `role` + `name` for free; without it we'd duplicate existing `computeRole` logic.
- ✅ **`ref` assignment requires one extra `page.evaluate`** (write `data-agent-ref` attributes); same as today.
- ✅ **Existing `SnapshotCollector.collect` stays as fallback** — never removed.
