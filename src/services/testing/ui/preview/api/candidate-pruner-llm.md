# `candidate-pruner-llm.service.ts` — API Reference

> Source: [candidate-pruner-llm.service.ts](../candidate-pruner-llm.service.ts)
> Parent: [preview/CLAUDE.md](../CLAUDE.md)

## Overview

A fast LLM pre-filter that narrows the resolver's candidate set from ~60 down to ~15 **before** the main `resolveElement()` prompt. Cuts prompt size by ~45% and enables cross-script intent matching (e.g., Cyrillic label `МАТ` vs Latin user input `MAT`).

**Architecture invariants (do not break):**
- Identity fast-path runs on `allAllowed` (before pruner output), so wrong-element guards are preserved.
- Fail-open: every error path returns `prunerSkipped:true`; resolver receives the unmodified DOM-order top-60 set.
- Identity rescue: any node whose `id/testId/name/svgIcon/alt` matches the recorded fingerprint is force-included — the pruner cannot remove a deterministically-matched element.
- `invalidatePrunerForRef` mirrors `invalidateLlmSelectionsForRef` so V24 rejection guards flush both caches in one call.

**Cost model (Gemini 2.5 Flash Lite):** ~$0.000145 per call; resolver shrinks by ~$0.00032 → net cost-neutral. 60s TTL + singleflight dedup keep cost bounded under Apply-All bursts.

## Exports

### Functions
- `pruneCandidatesViaLLM(params): Promise<PrunerResult>` — main entry.
- `invalidatePrunerForRef({ rejectedRef, pageUrl, intentText }): void` — flush cache entries tied to a rejected ref. Called from post-click rejection guards alongside `invalidateLlmSelectionsForRef`.

### Types
- `PrunerResult` — `{ kept: InteractiveNode[], prunerSkipped: boolean, prunerSkipReason?: PrunerSkipReason, cacheHit?: boolean, latencyMs?: number }`.
- `PrunerCandidate` — subset of `InteractiveNode` fields sent to LLM.
- `PrunerSkipReason` — `'too_few' | 'too_many' | 'timeout' | 'llm_error' | 'parse_error' | 'pad_needed'`.

## Constants

| Symbol | Value | Purpose |
|---|---|---|
| `PRUNER_TOP_K_DEFAULT` | `15` | Target output size. |
| `PRUNER_TIMEOUT_MS` | `7000` | Bumped from 3s (V26) — p99 on dense Angular Material pages hit ~4-5s. Fail-open if exceeded. |
| `PRUNER_CACHE_TTL_MS` | `60_000` | 60s TTL (matches resolver cache). |
| `PRUNER_CACHE_MAX_SIZE` | `400` | LRU cap. |
| `PRUNER_SKIP_THRESHOLD` | `16` | Skip pruner when ≤ this many candidates (overhead not worth it). |
| `PRUNER_UPPER_BOUND` | `100` | Skip pruner when > this many candidates (heavy enterprise pages — LLM almost always times out anyway). |
| `PRUNER_MIN_OUTPUT` | `5` | If LLM returns fewer than this, pad from DOM-order input set. |
| `INTENT_PROMPT_CAP` | `500` | Intent truncation; cache key hashes the same truncated form. |

## `pruneCandidatesViaLLM(params)` — behaviour

**Parameters:**
- `candidates: InteractiveNode[]` — full candidate list (up to 60).
- `intentText: string` — user intent.
- `actionType: IntentActionType`.
- `recordedFingerprint?: TargetFingerprint` — for identity rescue.
- `bindingHints?: BindingHints`.
- `pageUrl: string` — for cache key.

**Skip conditions:**
- `candidates.length <= PRUNER_SKIP_THRESHOLD` (16) → skip, return all.
- `candidates.length > PRUNER_UPPER_BOUND` (100) → skip, return DOM-order top-60.

**On LLM success:**
1. Parse ref list from LLM output.
2. Force-include any identity-rescue nodes.
3. If output < `PRUNER_MIN_OUTPUT`, pad from input DOM-order.
4. Return `kept` array.

**On any failure:** return input unchanged + `prunerSkipped:true`.

## Wiring

Called from `resolveElement()` in `element-resolver.service.ts` at Stage 3.5 (between evidence shortcut and the main LLM select call). Transparent to callers — `resolveElement` API unchanged.

## Related

- [element-resolver.md](element-resolver.md) — primary caller; Stage 4.5 in the 5-stage waterfall.
- [preview-step-apply.md](preview-step-apply.md) — `invalidatePrunerForRef` called from rejection guard.
