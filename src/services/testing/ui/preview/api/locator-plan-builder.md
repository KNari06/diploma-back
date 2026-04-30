# `locator-plan-builder.service.ts` — API Reference

> Source: [locator-plan-builder.service.ts](../locator-plan-builder.service.ts) (~28KB)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

Builds a "compiled plan" — an ordered fallback chain of selector strategies — from a probed/resolved element. The plan must work **without** preview-session metadata (no `data-agent-ref`, no live snapshot), so it's portable to background replay/regression. At apply/replay time, the first matching strategy wins; if all fail, the LLM resolver is invoked.

Strategies in priority order: **role + accessible name** → **label** → **testId** → **id (non-dynamic)** → various scoped CSS (data-*, hash anchors, child testId via `:has()`, icon labels, row text, sibling-of-class) → **placeholder** → **aria-label standalone** → **name** → **title** → **text** (with optional landmark/container scoping) → **tag+testId combo**.

**Callers:**
- [preview-step-apply.service.ts](../preview-step-apply.service.ts) — first apply rebuilds the plan and persists it.
- [preview-run.service.ts](../preview-run.service.ts) — Apply All flow.
- Background replay (`manual-test-run.job.ts` via `IntentStepConverter`).

## Exports

### Class
`LocatorPlanBuilder` — static-only.

### Types (from `preview.types.ts`)
- `LocatorEntry = { strategy, value, confidence, roleName? }`.
- `TargetFingerprint = { tag, role, text?, boundingBox?, ariaState?, … }`.
- `CompiledStepPlan = { locatorPlan, action, preconditions, postconditions, context, meta, targetFingerprint }`.

### Strategy literals
`'role' | 'testId' | 'label' | 'placeholder' | 'text' | 'title' | 'css'`. **`ref` is intentionally NOT generated** (see "Replay contract" below).

### Constants
- `COMPILED_VERSION = '1.0.0'` — plan format.
- `RESOLVER_VERSION = '3.0.0'` — resolver format.
- `GENERIC_ROLES = { 'generic', 'none', 'presentation', 'group' }` — too vague, skipped.

---

## Public methods

### `LocatorPlanBuilder.buildCompiledPlan(params): CompiledStepPlan`

- **Parameters:**
  - `step: IntentStep` (action type, value, options).
  - `resolvedNode: InteractiveNode` — element resolved by probe or LLM.
  - `pageUrl: string`, `pageTitle?: string`.
  - `snapshotRef?: string`, `screenshotRef?: string`, `pageSignature?: string` — optional bookkeeping.
- **Returns `CompiledStepPlan`:**
  - `locatorPlan: LocatorEntry[]` — 0–~15 strategies in priority order.
  - `action`, `preconditions`, `postconditions`.
  - `context` — page metadata, timestamps, optional refs.
  - `meta` — `{ compiledVersion, resolverVersion }`.
  - `targetFingerprint` — for auto-heal identity check.
- **Side-effects:** debug logs (step id, node tag/role, strategy counts); warns if `locatorPlan` is empty.
- **Key steps:**
  1. `buildLocatorChain(resolvedNode)` — synthesize strategies.
  2. `buildTargetFingerprint(resolvedNode)` — snapshot identity.
  3. `determinePreconditions(step.type)` — readiness gates.
  4. `determinePostconditions(step.type, resolvedNode)` — post-action signals.
  5. Assemble plan with version markers + timestamps.
- **Gotchas:**
  - **`data-agent-ref` is never generated.** Apply only — replay sees no injected attrs.
  - **Dynamic ids skipped.** `node.isDynamicId` true → skip the id strategy. Mirror of `dynamic-id.util.ts` regex.
  - **Empty plan is valid** but weak (icon-only, no role/text/aria) — falls through to LLM.

### `LocatorPlanBuilder.buildCompiledPlanForNonTargetingAction(params): CompiledStepPlan`

For actions that don't target an element (`navigate`, `wait`, `scroll`, `refresh`, `wait_for`).

- **Parameters:** `step`, `pageUrl`, `pageTitle?`.
- **Returns:** plan with empty `locatorPlan`, no `targetFingerprint`, postconditions per action type.
- **Side-effects:** debug log only.

---

## Strategy chain (in order added)

| # | Strategy | Confidence | Generated when | Selector form (at executor) |
|---|---|---|---|---|
| 1 | `role` + accessible name | 0.9 | role exists, not generic, accessible name from `labelText` ∥ `ariaLabel` ∥ `title` (V23) ∥ `text`. | `getByRole(role, { name })` |
| 2 | `label` | 0.85 | `node.labelText` present. | `getByLabel(value)` |
| 3 | `testId` | 0.8 | `node.testIdAttr` present. | `getByTestId(value)` / `[data-testid=…]` |
| 4 | `css` (id) | 0.78 | `node.id` non-dynamic. | `[id="…"]` |
| 5 | `css` (hash anchor href) | 0.72 | `<a href="#…">` with stable fragment (≥3 chars, not numeric/UUID-ish). | `a[href="#…"]` |
| 6 | `css` (childTestId via `:has()`) | 0.77 | icon-only wrapper with `node.childTestId`. | `<tag>:has([data-testid=…])` |
| 7 | `css` (icon label SVG `<title>`) | 0.62 | descriptor-poor icon, no testId/text/aria/labelText. | `<tag>:has(svg title:text-is("…"))` |
| 7' | `css` (icon library data-attrs) | 0.60 | data-lucide / data-feather / data-icon / data-iconify-name. | `<tag>:has([data-lucide="…"], …)` |
| 8 | `css` (data-value) | 0.74 | `node.dataValue` (selects, chips). | `<tag>[data-value="…"]` |
| 9 | `css` (data-row-key) | 0.78 | `node.dataRowKey` (Ant Design tables). | `[data-row-key="…"]` |
| 10 | `css` (nearest row text) | 0.73 | `node.nearestRowText` AND no testId/dataRowKey, first cell 3–60 chars. | `tr:has-text("…") <tag>` (or `li:has-text(…)` with conf 0.68). |
| 11 | `css` (sibling-of-class `:nth-of-type`) | 0.62 | descriptor-poor, stable first class. | `.<class>:nth-of-type(N)` |
| 12 | `css` (Bootstrap toggle+target combo) | 0.76 / 0.72 | `bsToggle` ∧ `bsTarget` (combo) or `bsTarget` alone. | `[data-bs-toggle=…][data-bs-target=…]` |
| 13 | `placeholder` | 0.75 | `node.placeholder`. | `getByPlaceholder(value)` |
| 14 | `label` (aria-label standalone) | 0.8 | `node.ariaLabel ≥ 2 chars`, not already used by `role`. | `getByLabel(value)` |
| 15 | `css` (name attribute) | 0.7 | `node.name` ≥ 2 chars, not `_`-prefixed. | `<tag>[name="…"]` |
| 16 | `title` | 0.7 | `node.title` ≥ 2 chars. | `getByTitle(value)` |
| 17 | `text` (bare) | 0.7 | `node.text` ≥ 2 chars, not already used by `role`. | `getByText(value)` |
| 18 | `css` (landmark + text) | 0.78 / 0.76 | bare text added AND `nearestLandmark`. | `[role="…"] >> text="…"` (and tag form). |
| 19 | `css` (container title + text) | 0.74 | bare text added AND `containerTitles[]` (top 2). | `:has-text("title") >> text="…"` |
| 20 | `css` (tag + testId combo) | 0.65 | `node.tag` AND `testIdAttr` AND id strategy NOT added. | `<tag>[data-testid=…]` |

**Dedup rules:** the bare-text and aria-label-standalone strategies skip themselves if the role strategy already used the same value. Container titles are capped at top 2 to keep the plan compact.

**V23 — `title` as accessible-name source.** Per WAI-ARIA Accessible Name Computation, `title` is a valid name source when `aria-label` / `aria-labelledby` / `<label>` are absent. Fixes Angular `routerLink` icon menus and similar icon-only triggers. Note: this strategy intentionally does NOT lift derived display labels (`iconLabel`, `svgIcon`, `childTestId`, `customElementTag`) — those are for resolver display, not for Playwright's `getByRole({ name })` which matches the actual a11y tree.

**CSS escaping:** all interpolated values pass through `escapeCssAttrValue()` — `\` → `\\`, `"` → `\"`, `]` → `\]`, `[` → `\[`, newlines → space.

**Class-skip regex (sibling-index strategy):** skips framework-generated classes `^(jss\d+|sc-[a-zA-Z0-9]{6,}|css-[a-z0-9]{6,}|makeStyles-)`.

---

## Target fingerprint

`buildTargetFingerprint(resolvedNode)` snapshots the element's identity for auto-heal:

- `tag`, `role`, optional `text` (truncated).
- `boundingBox` (if available).
- `ariaState` — checked / expanded / pressed / current / valueNow / valueText / invalid.
- Identity hints — id, testId, labelText, ariaLabel, dataValue, childTestId, svgIcon, customElementTag.
- Container hints — `nearestLandmark`, `containerTitles`, `ancestorSummary`.

The resolver's identity fast-path (in [element-resolver.md](element-resolver.md)) reads this back at apply time.

---

## Plan upgrade rules (auto-heal)

When apply fails and a compiled plan exists, the apply service rebuilds the chain with current candidates. The new plan **wins** (replaces the cached one) if it:

- adds strategies absent from the original, OR
- changes the primary strategy (e.g. `text` → `role + name`), OR
- has more total strategies.

Otherwise the apply falls back to fingerprint-driven LLM/vision rescue.

Upgrades are session-local — not persisted unless the apply succeeds afterwards (then the fresh plan is saved with `appliedStep`).

## Replay contract — why `ref` is excluded

`data-agent-ref` is the most stable locator while a preview session is live, but it's injected **only by the preview session**. Background replay / regression jobs run in fresh browser contexts with no injection. Including `ref` in the plan would waste the highest-priority slot on a strategy that always misses → slow fallback to LLM.

The compiled-locator-executor also filters out `ref` strategies, but the root fix is to never generate them. See lines around 49–54 of the source.

---

## Pre/post-conditions

`determinePreconditions(actionType)`:

| Action | Preconditions |
|---|---|
| `click`, `type`, `select`, `check`, `uncheck`, `toggle` | `['visible', 'enabled']` |
| `assert` | `['visible']` |
| `hover`, `scroll` | `['visible']` |
| `press` | `['attached']` (keyboard, no visibility) |
| Others | `[]` |

`determinePostconditions(actionType, node?)`:

| Action | Postconditions |
|---|---|
| `click` | `['navigation']` for links / `['domChange']` otherwise |
| `type`, `select`, `check`, `uncheck`, `toggle` | `['stateChange']` |
| `navigate` | `['urlChange']` |
| `open`, `close` | `['domChange', 'stateChange']` |
| `hover` | `['domChange']` |
| Others | `[]` |

---

## Constants summary

- **Min lengths:** role/text ≥ 2 chars; row text 3–60; icon label ≥ 2; title/name/placeholder ≥ 2.
- **Container title cap:** top 2 per plan.
- **Generic roles excluded:** `generic`, `none`, `presentation`, `group`.
- **Versions:** `COMPILED_VERSION='1.0.0'`, `RESOLVER_VERSION='3.0.0'`.
- **Dynamic-id filter:** delegated to `dynamic-id.util.ts` (`node.isDynamicId`).

## Related

- [preview-step-apply.md](preview-step-apply.md), [element-resolver.md](element-resolver.md), [recording-capture.md](recording-capture.md).
- `dynamic-id.util.ts` — id classifier (must stay in sync with recorder's regex).
- `IntentStepConverter` — used by background replay; filters `ref` strategy as defence-in-depth.
