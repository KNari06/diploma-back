# Refactor & test audit — Lite element-finding pipeline

qai-backend · 2026-06-05 · audited 9 files (~12,500 lines) across the `snapshot → agent picks element → locator resolution` path.

> **Plan only.** Nothing in here is applied. Findings are grounded in `qai-backend/CLAUDE.md`, `.claude/rules/*`, and `src/services/testing/ui/preview/CLAUDE.md`; anything not backed by a written rule is labelled *judgment call*.

## Scope

| File | Lines | Role in the pipeline |
|---|---:|---|
| `src/services/testing/ui/preview/element-resolver.service.ts` | 5609 | 3-stage resolver waterfall (identity → LLM → vision rescue) |
| `src/agent/core/lite/collectors/snapshot-collector.ts` | 3592 | builds `LiteSnapshot` (browser-side) + static `format()` string fed to every LLM |
| `src/services/testing/ui/preview/locator-plan-builder.service.ts` | 1695 | builds compiled locator plan from a resolved node |
| `src/services/testing/ui/preview/candidate-pruner-llm.service.ts` | 738 | LLM candidate pruning during resolution |
| `src/agent/core/lite/agents/snapshot-pruner.ts` | 316 | pre-`format()` element selection |
| `src/agent/core/lite/agents/observer-agent.ts` | 262 | LLM reads snapshot, picks element `ref` |
| `src/agent/core/lite/agents/observer-cache.ts` | 116 | snapshot/observation cache |
| `src/agent/core/lite/agents/parsed-snapshot.ts` | 88 | parses the formatted snapshot |
| `src/services/testing/ui/preview/locator-resolution.util.ts` | 86 | Playwright locator construction helpers |

Out-of-scope collaborators referenced by findings (not deep-audited): `recording-capture.service.ts`, `background-dom-collector.ts`, `snapshot-router.service.ts`, `dynamic-id.util.ts`, `lite-engine.ts`, `multi-agent-orchestrator.ts`.

## Findings (ranked)

| # | Area | Sev | File:line | Issue | Rule | Proposal | Effort/Risk |
|---|---|---|---|---|---|---|---|
| 1 | dep-direction / arch | **High** | `snapshot-collector.ts:21` | Agent-layer collector imports `@/services/testing/ui/preview/landmark.util`; combined with `snapshot-router.service.ts` importing `SnapshotCollector` back, this is a **true import cycle** (services → agent → services). | CLAUDE.md "Nothing calls backwards"; architecture.md dependency direction | Promote `landmark.util` + `implicit-role.util` to `src/utils/aria/`; update the 3 cross-layer callers. Cycle disappears. | S / low |
| 2 | duplication / correctness | **High** | `snapshot-collector.ts:1236` & `:2134`; `recording-capture.service.ts:1097` & `:1390`; `background-dom-collector.ts:512` | **5 divergent inline copies** of the framework-generated-id heuristic. `background-dom-collector.ts` still carries over-broad `/^react-[a-z0-9]+/i` (removed from canonical util in V22 — matches `react-tutorial-link`). Short copies miss ~30 patterns the canonical util has → same element "dynamic" in one path, "stable" in another. | CLAUDE.md #8 DRY; preview/CLAUDE.md #5 (recorder/snapshot symmetry) | One authoritative pattern set: a JS template-string export interpolated into every `page.evaluate` body + a pure `dynamic-id-filter.ts` for importable/testable use. Align all copies, fix the `react-` regex, add MUST-MATCH comments. | S / med |
| 3 | arch / cohesion / test | **High** | `snapshot-collector.ts:3406` | `format()` (186 lines) — the LLM-facing serializer — lives in a browser-side DOM collector and is a **distinct, prompt-shaped concern**. Has **zero unit tests** despite being pure (`LiteSnapshot → string`) and feeding observer/pruner/lite-engine/resolver. | architecture.md layer responsibilities; CLAUDE.md "change a prompt → src/ai/prompts" | Extract to `snapshot-formatter.ts` (or `ai/prompts/lite-snapshot-prompt.ts`) as `formatSnapshotForLlm(...)`, with `normalizeHref`/`priorityScore` as named helpers. Unblocks unit tests (#A,#B,#C below). | M / med |
| 4 | arch / cohesion | **High** | `element-resolver.service.ts:2076` | Three large prompt constants (`LLM_SHARED_RULES`, `LLM_SELECT_APPLY_PROMPT`, `LLM_SELECT_HEAL_PROMPT`, ~670 lines total) embedded in the orchestrator service. | CLAUDE.md cheat-sheet "change a prompt → src/ai/prompts"; prompt-optimization.md | Move to `src/ai/prompts/editor-resolver-prompts.ts` (already a referenced file). Service keeps only call orchestration. | M / low |
| 5 | cohesion / dep-direction | **High** | `element-resolver.service.ts:778–1551` | A block of **pure semantic-text utils** (`getEffectiveLabel`, `cyrFold`, `semanticTokens`, `nodeIdentityTokens`, `hasTokenOverlap`, `buildCandidateText`, `buildSceneSummary`, `markDuplicatesWithContext`, `sanitizeIntent`) lives in the 5609-line orchestrator. 3 sibling services import `getEffectiveLabel` back from it. | CLAUDE.md file-size; architecture.md (siblings shouldn't import impl details from an orchestrator) | Extract to `preview/candidate-text.util.ts`. Prerequisite for slimming the resolver. Mechanical import updates. | M / med |
| 6 | cohesion | **High** | `snapshot-collector.ts:176–3061` | `collect()` mixes two named concerns inside one `page.evaluate`: (a) interactive-element collection and (b) page-state metadata (modal/transient/obstacle detection, parent-ref-chain, page-structure, page-alerts, credentials/visual-content extraction). | CLAUDE.md file-size ("name two responsibilities") | Extract detector bodies as injected JS-string bundles (`page-state-detectors.ts`), following the existing `LANDMARK_EVALUATE_BUNDLE` pattern; keep single evaluate boundary. **Highest-risk — do last.** | L / high |
| 7 | duplication | Med | `candidate-pruner-llm.service.ts:325` ↔ `element-resolver.service.ts:2971` | Fingerprint-hint serialization (tag/role/elementId/testId/text/aria/href/containerTitles…) duplicated with minor format drift; new fingerprint fields routinely missed in one. | CLAUDE.md #8 DRY | Shared `buildFingerprintHintLines(fp, format)` in `preview/fingerprint-hint.util.ts`. | M / low |
| 8 | duplication | Med | `snapshot-collector.ts:107`; `recording-capture.service.ts:634` & `:2144` | Text normalizer (NFC + invisible-char strip + ws-collapse) has 3 inline browser-context copies under 2 names (`normLiveText`/`normProbeText`). | CLAUDE.md #8 DRY; preview/CLAUDE.md #5 | Single JS template-string constant (`NORM_TEXT_FN_SRC`) interpolated into both evaluate bodies; server-side `text-normalizer.util.ts` stays canonical. | S / low |
| 9 | cohesion | Med | `element-resolver.service.ts:1655` | Vision-rescue path (`rescueWithGeminiFlash`, ~240 lines) is an independent LLM concern (own input/prompt/threshold/trigger) only joined by file co-location. | architecture.md file-size | Extract to `preview/vision-rescue.util.ts` (+ screenshot helpers). | S / low |
| 10 | cohesion | Med | `locator-plan-builder.service.ts:57` | Two concerns: pure `buildLocatorChain` (20+ strategy branches) vs `LocatorPlanBuilder` class doing live-page `count()` validation + plan assembly. | architecture.md file-size | Extract `buildLocatorChain` + `filterAndSortPlan` to `locator-chain-builder.ts`. | M / med |
| 11 | arch (judgment) | Med | `locator-plan-builder.service.ts:1468` | `buildCompiledPlan` takes an optional `page` and runs browser `count()` validation inline — build-time data transform mixed with browser I/O. | architecture.md layer table (*judgment call*) | Extract `validateOnPage` to a `CompiledPlanValidator`; builder returns unvalidated plan, callers validate as step 2. | M / med |
| 12 | arch | Med | `snapshot-pruner.ts:272`; `observer-agent.ts:46` | Prompt builders (`buildPrompt`) inlined as private methods in the agent layer. | CLAUDE.md "change a prompt → src/ai/prompts" | Move to `ai/prompts/snapshot-pruner-prompts.ts` and `ai/prompts/observer-agent-prompts.ts`. Also makes them unit-testable. | S / low |
| 13 | duplication / arch | Low | `observer-cache.ts:18`; `snapshot-pruner.ts:58`; `candidate-pruner-llm.service.ts:127`; `element-resolver.service.ts` (`llmSelectCache`) | **4 hand-rolled LRU-with-TTL caches** with the same eviction/`getUrlBase`/`invalidateForUrl` logic. | CLAUDE.md #8 DRY; critical-patterns.md #5 | Generic `LruTtlCache<K,V>` in `src/utils/core/`; callers keep only key construction. | M / low |
| 14 | dep-direction | Med | `compiled-locator-executor.ts:30` | `agent/execution` imports `locator-resolution.util` from the preview-services layer (upward dep for a Playwright helper). | architecture.md dependency direction | Promote `locator-resolution.util` to `src/utils/playwright/` (or `src/agent/utils/selectors/`); both callers import downward. | S / low |
| 15 | duplication | Low | `element-resolver.service.ts:1583,1631` | Generic LLM-JSON parsing helpers (`extractFirstJsonObject`, `safeParseJsonResponse`) embedded in the largest file. | CLAUDE.md #8 DRY | Move to `src/utils/parsing/json-repair.util.ts`; grep for dupes across `services/ai`. | S / low |
| 16 | arch / duplication | Low | `element-resolver.service.ts:3242–3310` | Hand-rolled Gemini→OpenAI fallback duplicates provider-fallback policy that belongs in the AI layer. | architecture.md; CLAUDE.md #8 | Add `generateTextWithFallback(...)` to `services/ai/core/ai-provider.service.ts`; resolver calls it. | M / med |

## Refactor plan (sequenced)

Ordered so low-risk, high-unblock work lands first and risky surgery last. Dependencies called out.

1. **Promote shared utils to `src/utils/`** — `landmark.util`, `implicit-role.util` → `src/utils/aria/`; `locator-resolution.util` → `src/utils/playwright/`. *Fixes #1 (import cycle) and #14.* Mechanical, low risk; do first so later extractions sit on clean layering. (depends-on: none)
2. **Extract semantic-text utils** from `element-resolver` → `preview/candidate-text.util.ts`. *Fixes #5; prerequisite for #4, #9 and the resolver slim-down.* (depends-on: none)
3. **Extract `format()` → `snapshot-formatter.ts`** with `normalizeHref`/`priorityScore` as named exports. *Fixes #3; immediately unblocks tests #A–#C.* (depends-on: none)
4. **Consolidate framework-id heuristic** — one JS template-string source + pure `dynamic-id-filter.ts`; align all 5 copies, **fix `background-dom-collector` over-broad `/^react-/`**, add MUST-MATCH comments. *Fixes #2 (active correctness divergence); unblocks test #D.* (depends-on: none — but coordinate with recorder owners for the symmetry contract)
5. **Move prompts to `src/ai/prompts/`** — resolver (#4 table-row), pruner + observer (#12). (depends-on: step 2 for the serializers that move with `candidate-text.util`)
6. **Generic `LruTtlCache`** in `src/utils/core/`; refactor the 4 caches. *Fixes #13.* (depends-on: none)
7. **Shared helpers**: `buildFingerprintHintLines` (#7), `NORM_TEXT_FN_SRC` template (#8), `json-repair.util` (#15), `generateTextWithFallback` (#16). (depends-on: none; #15 before #5 if the prompt module needs JSON parsing)
8. **Slim `element-resolver`**: extract `vision-rescue.util.ts` (#9); isolate the allowed-set builder. (depends-on: steps 2, 5)
9. **Split `locator-plan-builder`**: `locator-chain-builder.ts` + `CompiledPlanValidator` (#10, #11). (depends-on: step 1)
10. **`snapshot-collector` page-state bundles** (#6) — highest risk, do last; follow `LANDMARK_EVALUATE_BUNDLE` as the reference. (depends-on: steps 1, 3)

## Test-coverage plan

**Current coverage**
- Good: `candidate-pruner-llm.service.test.ts` (fail-open, caching, singleflight, invalidation — no gaps); `element-resolver.test.ts` + `-honesty-guard.test.ts` (confidence thresholds, `buildAllowedSets`, token-overlap); `parsed-snapshot.test.ts` (refs, non-element refs, source preservation); `locator-plan-builder.token-chain.test.ts` (enrichment path); `snapshot-collector.shadow-dom.test.ts` (browser-side traversal).
- **Zero tests:** `snapshot-collector.format()`, `snapshot-pruner.ts`, `observer-cache.ts`, `observer-agent.ts`, `locator-resolution.util.ts`, the inline `liveLooksGenerated` filter.

**Make-testable-first** (extractions that unblock unit tests — map to refactor steps 3, 4, 5, 6):
- `normalizeHref`, `priorityScore`, `format()` out of the collector (step 3).
- `liveLooksGenerated` → `dynamic-id-filter.ts` (step 4).
- `buildPrompt`/`buildCompactList` (pruner, observer) → exported prompt builders (step 5).
- Cache logic → `LruTtlCache` (step 6).

**Proposed tests** (behavior-named; unit, colocated `__tests__/` per testing.md; mock only the LLM/Playwright boundary):
- **#A** `snapshot-formatter.test.ts` — href normalizer: "strips query string, keeps hash", "same-text links with different paths produce different hrefs", "truncates to 120 chars", "falls back for relative href", "handles mailto:/tel: without throwing". *(secret-redaction invariant — no mocks.)*
- **#B** same file — priority/keep: "inputs sort before buttons before links when over cap", "keepRefs overrides legacy sort", "keepRefs preserves input order".
- **#C** same file — markers: one case per flag (`[INSIDE_MODAL]`, `[DISABLED]`, `[COVERED]`, `[STATE=…]` incl. dedup vs `ariaExpanded`), "exposes href for links", "never exposes raw input value", "returns 'No interactive elements found' for empty".
- **#D** `dynamic-id-filter.test.ts` — "true for React `:r1:` / Radix / MUI / Headless / Element-Plus / UUID", "false for `login-submit-button`", "false for `submit-btn-1`", "id over 80 chars not treated as stable".
- **#E** `observer-cache.test.ts` — TTL hit/expiry (fake timers), LRU eviction at capacity, upsert-not-evict, `invalidateForUrl` ignores query string.
- **#F** `snapshot-pruner.test.ts` (mock `LitePromptBuilder.askJson`) — "returns null at/under cap", "force-includes modal elements omitted by LLM", "drops hallucinated refs", "returns null when keep < min", cache TTL/eviction/invalidate.
- **#G** `locator-resolution.util.test.ts` (mock Playwright Page/Locator) — strategy→method mapping (css/ref/role/label/testId/placeholder/title/text), "unknown strategy returns null", `safeCountWithTimeout` resolves / times-out→-1 / throws→0.
- **#H** extend `element-resolver.test.ts` — waterfall transitions: "identity-id fast-path returns without LLM call", "compiled plan with strong identity contradiction falls through to LLM".
- **#I** `observer-agent` prompt test (after extraction) — conditional sections present only when their inputs are set (recovery / credentials / positioned-elements); "no LLM call → returns null".

**Not worth testing** (per testing.md): live DOM-dependent code that must stay browser-side — accessible-name cascade (`snapshot-collector.ts:757`), modal/z-index detection (`:176`); these remain covered by browser integration tests. LLM-call orchestration itself (mock the boundary, don't test the model).

## Out of scope / deferred

- **Duplicate `disabled` key** in the `LiteElement` literal (`snapshot-collector.ts:2559` & `:2611`) — real bug (second key wins, `aria-disabled` branch dead). Already spawned as a separate task; keep out of this refactor.
- Pre-existing unrelated breakage surfaced incidentally: `allure-csv-parser.ts` missing `csv-parse/sync` dependency (type-check failure); lint "irregular whitespace" at `snapshot-collector.ts:107`.
- `lite-engine.ts` (6407) and `multi-agent-orchestrator.ts` (1641) — consumers of `format()`, not deep-audited; their size is a separate audit.
- No `supabaseAdmin` / `@/db/supabase` violations found in any in-scope file — that invariant is clean across the pipeline.

## Open questions

- **Recorder/snapshot symmetry owner:** consolidating the framework-id heuristic (step 4) touches `recording-capture.service.ts` whose fingerprints must stay byte-aligned with the collector. Who owns sign-off on changing the shared pattern set?
- **Prompt extraction & behavior drift:** moving `format()` and the resolver prompts is mechanical, but any wording normalization changes what the LLM sees — confirm a before/after eval (e.g. on documentolog.com) is run before merge.
- **`src/ai/prompts/` vs colocated:** the cheat-sheet says prompts live in `src/ai/prompts/`, but the lite agents keep prompts under `agent/core/lite/`. Confirm the target home for observer/pruner/snapshot-format prompts so the move matches team convention.
