# `element-resolver.service.ts` — API Reference

> Source: [element-resolver.service.ts](../element-resolver.service.ts) (~3000 lines)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

LLM-first element selection engine — resolves user intent ("click login button", "type email") to live DOM elements via a 5-stage waterfall: structural filter → identity fast-path → evidence shortcut → LLM semantic select → vision rescue. Returns a `LintResult` with resolved ref, confidence, `resolverPath` label, alternatives, and rule-trace diagnostics.

Identity fast-path and evidence shortcut short-circuit expensive LLM calls when a recorded fingerprint or cached hint is reliable.

**Callers:**
- [preview-step-apply.service.ts](../preview-step-apply.service.ts) — apply
- [intent-step-lint.service.ts](../intent-step-lint.service.ts) — lint candidates for the user
- [preview-run.service.ts](../preview-run.service.ts) — Apply All
- `command-executor.ts` (regression replay) — heal-mode

## Exports

### Functions
- `resolveElement(params): Promise<LintResult>` — main entry.
- `buildAllowedSets(nodes, actionType): AllowedSetResult` — sync structural filter.
- `buildCandidateText(node): string` — semantic textualization for LLM batch. **V26:** includes `dataState` field — Radix/shadcn/Vaul `data-state` attribute (`open`, `closed`, `checked`, `unchecked`, `on`, `off`, `active`, `inactive`), deduplicated against equivalent `aria-*` values to avoid redundant hints.
- `sanitizeIntent(step): string` — normalize + redact intent.
- **`getEffectiveLabel(node): string` (V23)** — canonical label resolution; consolidates 12 identity sources in priority order: `labelText` → `ariaLabel` → `title` → `alt` → `text` → `placeholder` → `iconLabel` → `svgIcon` → `childTestId` → `dataValue` → `dataRowKey` → `customElementTag`. Imported and used by `preview-step-apply.service.ts` and `intent-step-lint.service.ts` so trace labels and candidate display stay consistent across services.

### Types
- `AllowedSetResult` = `{ hardAllowed, softAllowed, ruleTrace }`.
- `RuleTraceEntry` = `{ ruleId, version, action: 'exclude'|'boost'|'penalize', evidence, affectedRefs }`.
- `LlmSelectResult` = `{ status, selectedRef, confidence, reason, alternativeRefs?, suggestion?, latencyMs, cacheHit }`.
- `ResolverSuggestion` = `{ issue, hint, examples? }`.
- `ScreenshotResult` = base64 string OR `{ base64, clipPageTop?, scrollY? }`.

### Constants

| Symbol | Value | Purpose |
|---|---|---|
| `ACTION_TO_TAGS` | record | Allowed tags per action (click → button/a/div/span/...; type → input/textarea). |
| `CLICK_ALLOWED_ROLES` | set | Roles passing click filter without tag match. |
| `SELECT_ALLOWED_ROLES` | set | combobox/listbox/option/menu/menuitem. |
| `SELECT_SOFT_TAGS` | set | `['button','div','span','input','a','li']` — common tags soft-allowed for `select` actions so custom dropdown triggers aren't hard-excluded. |
| `WRITABLE_ACTIONS` | set | `{fill, type, clear}`. |
| `STATE_AWARE_ACTIONS` | record | check (→unchecked), uncheck (→checked), open/close (→aria-expanded). |
| `LLM_SELECT_TIMEOUT_MS` | `8000` | Outer LLM timeout (whole stage). |
| `LLM_SELECT_PER_PROVIDER_TIMEOUT_MS` (V26) | from `llmCircuitBreaker.perProviderTimeoutMs` | Per-provider budget. Outer timeout enforces total; inner timeout per provider lets the fallback (OpenAI) fire when primary (Gemini) hangs. Fixes May-2026 outage where Gemini timeout starved OpenAI. |
| `MAX_CANDIDATES_FOR_LLM` | `70` | LLM batch size. |
| `LLM_SELECT_CACHE_TTL_MS` | `900_000` (15 min) | Cache lifetime. |
| `LLM_SELECT_CACHE_MAX_SIZE` | `2000` | LRU max. |
| ~~`SCORED_SLOT_RATIO`~~ | _removed (V26)_ | Pre-score & sort function deleted; replaced by DOM-order cap + LLM candidate pruner (Phase 2/3). |

---

## The 5-stage waterfall

### Stage 1 — `buildAllowedSets(nodes, actionType, viewport?)` (sync structural filter)

**V26:** accepts optional `viewport: { width, height }` for accurate modal-coverage calculation on long scrollable pages (fixes 9% → 100% underestimation when page bbox high-water-mark was used as a proxy).

Partitions nodes into `hardAllowed` / `softAllowed` based on deterministic rules. **No hardcoded text matching** — semantic decisions are deferred to LLM.

Rules in order:
1. **Visibility** — `isVisible=false` → HARD EXCLUDE (only hard rule).
2. **Disabled** — `isDisabled=true` → SOFT PENALTY.
3. **ReadOnly for writable actions** → SOFT PENALTY.
4. **Type compatibility** for `type` action — SOFT PENALTY on mismatch.
5. **State-aware gates** (check/uncheck/open/close) — SOFT PENALTY on mismatch.
6. **Tag/role compatibility** — framework-clickable / contenteditable / custom dropdowns → SOFT PENALTY (rather than exclude).
7. **Overlay/modal** — `isTopMostAtCenter=false` or modal-mismatch → SOFT PENALTY. Modals covering ≥30% viewport HARD-exclude background elements.
8. **Dynamic id** — `isDynamicId=true` → SOFT PENALTY.

`hardAllowed` = passed all rules without soft penalty. `softAllowed` = at least one soft penalty. No node is in both. `ruleTrace` is the audit log.

### Stage 2 — Identity fast-path (sync)

Skipped entirely for `wait` and `wait_for` action types (no element targeting needed).

Triggers when a `recordedFingerprint` (or `compiled.targetFingerprint`) is present and there are ≥1 allowed nodes. Checks whether the recorded element's stable identity (`id`, `testId`, `svgIcon`, `customElementTag`, `href` (V26)) matches a UNIQUE live candidate.

**Uniqueness gate:** exactly 1 match → return immediately; ≥2 matches → try narrowing by tag; still ambiguous → fall through to LLM.

`resolverPath ∈ { 'identity_id', 'identity_testid', 'identity_svgicon', 'identity_custom_element', 'identity_href' (V26) }`.

**V26 — `identity_href`.** SPA links with semantic URLs (`/courses/mat-smart`, `/admin/users/42`) get a tier-1 fast-path between testId and svgIcon. Stable across origin rewrites; especially useful for Angular `routerLink` and Vue Router targets where `id`/`testId` may be missing.

Skipped when no recorded fingerprint, 0 allowed candidates, or ambiguous (let LLM use context).

### Stage 3 — Evidence shortcut (sync)

When step has `lastSuccessRef` from prior successful apply (manually-added steps without recording info). If the previously-resolved ref is still findable in the live allowed set, return it.

`resolverPath = 'evidence_shortcut'`.

### Stage 4 — LLM selection (async, Gemini Flash Lite)

Triggers when ≥1 allowed candidates and stages 2–3 didn't fire.

Preprocessing:
1. **DOM-order cap + candidate pruner (V26).** The old "pre-score & sort with 60/40 scored/DOM-order split" was removed. Now: take candidates in DOM order up to the cap, then optionally run them through the LLM-based candidate pruner (Phase 2/3 — see below).
   - Search text per node (`buildNodeSearchText`) still includes `alt`, `iconLabel`, `svgIcon`, `childTestId`, `customElementTag` (V23) — captures icon-only / Angular Material / Vue targets.
2. **Build candidate text** — `buildCandidateText(node)`, ≤200 chars.
3. **Mark duplicates** — `[N of M]` suffix + `(CONTEXT: ...)` for disambiguation.
4. **Scene summary** — detect expanded dropdowns, selected tabs, active modals for top-down LLM context.

**Stage 4.5 — LLM candidate pruner (V25/V26).** Optional intermediate stage between candidate build and the main selection prompt:
- **Modes:** `'shadow'` (run in parallel, log only) / `'applied'` (replace `candidatesToProcess`) / `'skipped'` / `'disabled'`. Outcome surfaces in `LintResult._prunerOutcome`.
- **Hard-pad:** up to 5 hard-allowed candidates dropped by the pruner are re-included to keep the prompt safe. Order is preserved (descending pruner confidence); duplicate marking carries through.
- **Skip rules:** disabled, or input candidate set ≤16 (no win available).
- **Cache key includes `descDigest`** — hash of `recordedDescription`. Prevents collisions on same intent text but different element descriptions.

**Per-provider AbortControllers (V26).** The selection LLM call has TWO timeouts:
- Outer `LLM_SELECT_TIMEOUT_MS` enforces total budget.
- Inner `LLM_SELECT_PER_PROVIDER_TIMEOUT_MS` per provider (Gemini, OpenAI fallback). Cascade is one-way (outer → inner): primary timeout no longer starves the fallback.

Two prompt modes:
- **Apply mode (default)** — user authoring step. Returning `null` is correct for no-match.
- **Heal mode** — existing step broken during regression. Bias toward "find closest match".

Confidence floors:
- Apply: ≥ `0.55` to resolve (lifted from 0.4 in April 2026 to filter false positives).
- Heal: ≥ `0.4` (looser, pre-filtered by recorded fingerprint).

Both prompts include rules 1–18 (below).

Returns `LlmSelectResult`. `resolverPath = 'llm'`.

### Stage 5 — Vision rescue (async, Gemini Flash Vision)

Triggers in three cases:
- **Initial:** `allowedCount=0` (all structural rules excluded). Rescue from excluded-but-visible.
- **Proactive:** all candidates are blind icon-only buttons with no label/hint — text LLM can't disambiguate.
- **Reactive:** stage 4 returned low-confidence on visual elements (img/svg/canvas).

Prompt = same rules + screenshot annotation + viewport size. Can return ref OR a `boundingBox` in screenshot space (mapped to viewport via `mapVisionBboxToViewport`).

Confidence floor: `0.5`. Distance penalty for bbox→DOM mapping: 0 if contained, up to 0.3 if 100px+ away.

**Etap 1D.4 — `recordedDescription` soft hint.** When the calling step has a stored `recordedDescription`, the vision and selection prompts include it as a 3rd channel alongside the recorded fingerprint and binding hints. Acts as disambiguation only — does NOT override identity-tier matches. Useful for similar-text candidates and generic intents.

`resolverPath = 'vision'`.

---

## HardAllowed vs SoftAllowed

- **HardAllowed:** passed all hard rules (visibility); no penalty hints.
- **SoftAllowed:** passed hard rules but carries soft hints (disabled, covered, non-standard tag, dynamic id, state mismatch). LLM gets the hints in the rule trace and applies judgement (e.g. disabled button is still a valid target if user wants to verify the disabled state).

False negatives (filtering out valid candidates) are worse than false positives (passing questionable candidates to LLM). LLM is better at context-aware filtering than rigid rules.

---

## "Rules 1–18" LLM prompt

Located in `LLM_SHARED_RULES` + `LLM_SELECT_APPLY_PROMPT` / `LLM_SELECT_HEAL_PROMPT`.

1. **Cross-language semantic match** — `войти` = `sign in` = `登录`.
2. **Action-type semantics** — click→button/link, type→input, select→dropdown, …
3. **Identity priority** — TIER 1 (testId/id/dataRowKey/icon) ≫ TIER 2 (value/bsToggle) ≫ TIER 3 (text/aria) ≫ TIER 4 (position/css).
4. **State-at-record awareness** — expanded/collapsed, checked/unchecked, invalid, current=page, valueNow.
5. **Icon buttons w/o text** — match by aria-label/title/icon-hint (eye→show password, X→close, gear→settings).
6. **Visual properties** — `[color]`, `[shape]`, `[icon: class]`; tie-breaker only.
7. **Spatial layout** — modal center, drawer/sidebar edge, dropdown below trigger; prefer elements inside the active layer.
8. **Page-state-driven** — `[expanded]`/`[selected]`/`[active-layer]` governs visibility of children.
9. **Ancestor path hint (V22)** — `header#layout-header > div.icon-group > svg` as soft structural filter.
10. **`[N of M]` duplicates** — use `(CONTEXT: …)` to disambiguate.
11. **Partial / abbreviated descriptions** — match most specific, not broadest.
12. **Relative positioning** — directional / proximity / ordinal / table grid.
13. **Confidence scale** — 0.95–1.0 TIER 1 exact; 0.85–0.95 TIER 2; 0.7–0.85 TIER 3; 0.5–0.7 plausible; <0.5 don't return.
14. **Only use provided refs** — never invent.
15. **JSON-only response.**
16. **(Apply-critical) ID-as-description** — intent like `'layout-header-setting'` is a recorded id, not free text. Match only if a candidate has that exact id; else return `null`. Prevents fake-success.
17. **Adjacency ≠ same function** — spatial proximity is tie-breaker only.
18. **NO loudest-CTA fallback** — when nothing matches, return `null`, not "Submit"/"Click me!".

Apply-mode also enforces:
- Rule 19: reject gibberish/irrelevant text.
- Rule 21: intent quality (SPECIFIC/GENERIC/VAGUE) caps confidence.
- Rule 22: emit `suggestion` payload on no-match/low-conf to coach the user.

Heal-mode overrides:
- A: prefer any reasonable match over `null`.
- B: recorded fingerprint is primary evidence (text may have drifted).
- C: identity → shape → text.
- D: state drift normal — hint not filter.
- E: positional drift normal — tie-breaker only.
- F: adjacency ≠ function (same as apply).
- G: ID-as-intent (same as apply rule 16).

---

## Public functions

### `resolveElement(params): Promise<LintResult>`

```ts
{
  previewSessionId: string;
  stepDraft: IntentStep;
  domNodes: InteractiveNode[];
  pageUrl: string;
  includeAlternatives?: boolean;            // default false
  screenshot?: ScreenshotResult | (() => Promise<ScreenshotResult | null>);  // lazy callback OK
  mode?: 'apply' | 'heal';                  // default 'apply'
  viewport?: { width: number; height: number };  // V26 — used for modal-coverage calculations
  recordedDescription?: string;             // Etap 1D.4 — soft hint for vision rescue + LLM selection
}
```

- **Returns `LintResult`:**
  - `status: 'resolved' | 'not_found' | 'needs_clarification'`.
  - `message`, `confidence`, `candidates: LintCandidate[]`.
  - `highlight: Array<{ ref, boundingBox, type: 'success' | 'warning' }>`.
  - `resolverPath: 'identity_id' | 'identity_testid' | 'identity_svgicon' | 'identity_custom_element' | 'identity_href' (V26) | 'evidence_shortcut' | 'compiled' | 'llm' | 'vision' | …`.
  - `cacheHit`, `suggestion?`, `alternativesIncluded?`, `needsAiFallback?`, `degradedMode?`.
  - `_ruleTrace?`, `_hardAllowedCount?`, `_softAllowedCount?`.
  - `_pruneMs?: number` (V25) — pruner latency.
  - `_prunerOutcome?: 'shadow' | 'applied' | 'skipped' | 'disabled'` (V25) — candidate-pruner status.
- **Side-effects:** LLM call (~200ms typical), vision call (~6s timeout) if screenshot, cache reads/writes, trace writes.
- **Key steps:**
  1. Skip non-targeting actions (`navigate`, `wait`, `ai_check`, `switch_tab`).
  2. `buildAllowedSets()`.
  3. Identity fast-path → evidence shortcut.
  4. Branch by `allowedCount`:
     - `0` → vision rescue or `not_found` + suggestions.
     - `1` → still send to LLM for semantic verification (single node may be wrong).
     - `≥2` → pre-score sort, build batch, mark duplicates, LLM select.
  5. Proactive vision when all candidates are blind icons.
  6. LLM selection w/ recorded fingerprint + prior apply hints as soft evidence.
  7. Reactive vision second-opinion on visual elements with low LLM confidence.
- **Invariants / gotchas:**
  - Identity fast-path requires uniqueness; otherwise LLM (only LLM uses context).
  - **Semantic floor (apply):** confidence ≥ 0.55 but chosen candidate shares zero meaningful tokens with intent → treat as no-match. Fake-success prevention.
  - **Semantic floor — substring tolerance (V23):** "shared meaningful token" definition relaxed — accepts a 3-char substring match OR prefix overlap, not only exact set membership. E.g. `папка` ⊆ `папкалар` now passes. Multilingual stems (RU/KZ/agglutinative) that previously failed at 0.55 now pass when truly relevant.
  - Vision returns screenshot-space coordinates → map to viewport before comparing to `node.boundingBox`.
  - Screenshot lazy callback memoized once per call; reused across rescue/proactive/second-opinion (≤3 calls).
  - Cache key includes `mode` — apply vs heal cached separately.
  - Circuit breaker on repeated LLM failures.

### `buildAllowedSets(nodes, actionType): AllowedSetResult`

- Pure function (no side-effects).
- **Steps:** detect active modal (role=dialog, `isInsideActiveModal`, ≥30% coverage); per node apply hard then soft rules; push to `hardAllowed` or `softAllowed`; record trace entries.
- **Notes:** modal detection is position-aware (cookie banners at edges aren't blockers). Dynamic-id flag is set during snapshot collection, not here.

### `buildCandidateText(node): string`

- ≤200 chars.
- **Format (priority):** `[container > section] label | title: ... | icon-button | icon: SettingsIcon | near: row context | role=button | <button> | @(x,y,wxh) | [disabled, expanded] | [grey, rounded] | value: selected`.
- No hardcoded text match — labels flow through. Icon hints (`childTestId`, `svgIcon`, `iconLabel`, `customElementTag`) are critical for icon-only buttons.

### `sanitizeIntent(step): string`

- Returns ≤500 char normalized intent. Replaces `step.value` with `[VALUE]` redaction unless `step.type === 'select'` (value is part of the target there).

---

## LLM cache

- `llmSelectCache: Map<string, { result, createdAt }>`.
- TTL `900_000` ms; max `2000` entries; LRU eviction (drop oldest 25% by age, then purge expired).
- **Key includes:** mode, normalized URL (origin+pathname), page signature (refs + content hash of first 10 nodes), action type, intent text hash, recorded-fingerprint digest, prior apply-hints digest, all candidate refs.
- Hit rate: ~40–60% on typical Editor + Apply All flows.
- Metrics via `cacheMetrics.inc('llm-select', 'hit'|'miss')`.

---

## Vision rescue specifics

**Inputs:** intent + action type, top-15 a11y-rich candidates, screenshot, viewport dims.

**Prompt additions:** "Look at the screenshot visually"; can return `boundingBox` in screenshot pixel space if ref isn't in candidate list.

**Confidence floor:** `0.5`.

**Bbox sanity:** reject `NaN`, negative values, `>10000`. Allow small negative overflow (`-50`) for rounding noise.

**Mapping:** screenshot bbox → viewport bbox via `mapVisionBboxToViewport()`. Distance penalty 0 (contained) → 0.3 (>100px away from any node).

---

## State & timing

- **In-memory state only:**
  - `llmSelectCache`.
  - `llmSelectFailures` + `llmSelectBreakerOpenUntil` (circuit breaker).
  - Screenshot memoization within a single `resolveElement()` call.
- **Timeouts:** LLM 8000ms; vision 6000ms; overall typically <2s (identity fast-path) to <5s (LLM + vision).
- **Lost on process restart.**

### Phase timings (V23)

LLM stage now logs a phase breakdown alongside the existing `latencyMs`:

- `prepareMs` — prompt building, candidate batching, scene summary.
- `llmCallMs` — network call to Gemini Flash Lite.
- `postMs` — JSON parse, validation, candidate matching.
- `promptChars` — total prompt size for cost/limit tracking.

**SLA breach guard:** if `llmCallMs > LLM_SELECT_TIMEOUT_MS × 1.5` (i.e. >12s when timeout is 8s), `logger.warn()` fires. Diagnostic-only, no impact on the result. Surfaced in editor trace JSONL.

## Confidence calibration (apply)

| Band | Evidence | When |
|---|---|---|
| 0.90–1.00 | TIER 1 exact (id/testId/dataValue) or label == intent | Only when one candidate clearly outranks. |
| 0.75–0.89 | TIER 2 exact (value/bsToggle) or exact text + role fit | Strong semantic match. |
| 0.55–0.74 | Partial match, intent words in text or role fits but text drifted | i18n, restyle. |
| <0.55 | Weak guess | DO NOT return; return `null`. |

Common pitfalls: optimism bias (0.85 when evidence is 0.6); using adjacency to override semantics; returning low-confidence pick instead of `needs_clarification`.

## Error handling

- **LLM JSON parse / timeout / malformed** — 3-pass repair (strict → backslash-double → control-char strip); on failure throw, caller retries/degrades.
- **Vision failure** — fall back to text LLM or `needs_clarification`.
- **Circuit breaker** — N failures in fast succession → open M seconds → return `not_found` with suggestions instead of blocking.
- **Empty `domNodes`** — return `not_found` with `needsAiFallback: true`.

## Related

- [preview-step-apply.md](preview-step-apply.md), [intent-step-lint.md](intent-step-lint.md), [dom-analysis-extractor.md](dom-analysis-extractor.md), [locator-plan-builder.md](locator-plan-builder.md).
- [candidate-pruner-llm.md](candidate-pruner-llm.md) — Stage 4.5 pre-filter service.
- [.claude/rules/wrong-element-debugging.md](../../../../../../.claude/rules/wrong-element-debugging.md).
