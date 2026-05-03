# `snapshot-router.service.ts` — API Reference (Etap 2 / WIP)

> Sources:
> [snapshot-router.service.ts](../snapshot-router.service.ts),
> [cdp-snapshot.service.ts](../cdp-snapshot.service.ts),
> [snapshot-diff.util.ts](../snapshot-diff.util.ts).
> Config: [src/config/testing/snapshot-router.config.ts](../../../../../config/testing/snapshot-router.config.ts).
> Design notes: `docs/etap2-cdp/`.
> Parent: [preview/CLAUDE.md](../CLAUDE.md).

> **Status — Etap 2 Week 1 (May 2026):** the router and config are production-shipped (defaults to legacy evaluate path, zero behavior change). The CDP service itself is a skeleton — only Phase 2 (raw-bundle fetch) is fleshed out; phases 1, 3, 3c-Eval, 4, 5 throw `Error('TODO')` and aren't called yet. **Do not flip flags to `applied`/`cdp` mode in production until the phases land and shadow-mode validation completes (Week 2-4).**

## Overview

`SnapshotRouter` is the single entry point all snapshot collection now goes through. Its job is to decide between:

1. The legacy `page.evaluate`-based path (`SnapshotCollector` — current production behaviour).
2. The new CDP-based hybrid pipeline (`CdpSnapshotService`) — gathers DOM via `DOMSnapshot.captureSnapshot` + `Accessibility.getFullAXTree` in parallel, maps to `LiteElement[]` in Node.js, and runs ONE small `page.evaluate` for runtime-only fields (React fiber, checkbox state). Target: 8-15× speedup on dense pages.

`SnapshotDiff` is a validation harness: when shadow mode runs both paths, the diff util compares the two `LiteSnapshot`s with field-level granularity (1px bbox tolerance) and emits a divergence report.

## Exports

### Classes / functions
- `SnapshotRouter.collect(page, options): Promise<LiteSnapshot>` — single entry; mirrors `SnapshotCollector.collect()` signature.
- `CdpSnapshotService.collect(page, options): Promise<LiteSnapshot>` — CDP-based path. Accepts `existingCdpSession` (Week 5: piggyback on preview-video-stream's session).
- `diffSnapshots(a, b): SnapshotDiffReport` — pure utility for shadow-mode validation.

### Types
- `SnapshotRouterFlags` — `{ useCdpForBackground_shadow, useCdpForBackground, useCdpForPreview_shadow, useCdpForPreview, denseThreshold }` (all booleans default `false`; `denseThreshold = 2000`).
- `SnapshotRouterContext` — `'preview-tick' | 'preview-apply' | 'background-regression' | 'lite-engine' | 'unknown'`.
- `CdpSnapshotError` — typed failure for fallback decisions: `'page_gone' | 'cdp_payload_too_large' | 'ax_domain_unavailable' | 'cdp_send_failed' | 'malformed_response'`.
- `SnapshotDiffReport` — top-level diffs (url, title, activeModalRef, viewport) + element identity mismatches (`onlyInA`, `onlyInB`) + per-element field divergences + histogram of divergent field names + match verdict.

## `SnapshotRouter.collect()` — routing logic

Returns one of three sources:

- **`'cdp_with_fallback'`** — Try CDP first; on any `CdpSnapshotError` silently fall back to evaluate.
- **`'cdp'`** — CDP only, no fallback (reserved; no caller currently maps to this).
- **`'evaluate'`** — Legacy (current default for everything).

### Decision rules
- `context === 'background-regression'` AND `useCdpForBackground` flag true → `cdp_with_fallback`.
- `context === 'preview-apply'` AND `useCdpForPreview` flag true AND `lastDomNodeCount >= denseThreshold` → `cdp_with_fallback`.
- Otherwise → `'evaluate'`.

### Shadow mode
When `useCdpForBackground_shadow` (background) OR `useCdpForPreview_shadow` (preview + dense page) is true, run **both** paths concurrently via `Promise.allSettled`. Production returns the evaluate result; CDP runs only to feed `diffSnapshots()` divergence log. CDP failure never affects production.

## CDP coordination & invariants

- **Never opens a duplicate CDP session for preview.** When the caller provides `existingCdpSession`, `CdpSnapshotService` reuses it (Week 5 — preview piggyback). Otherwise it opens its own and detaches it in `finally` to avoid leaks. This honours the project-wide invariant in [.claude/rules/critical-patterns.md](../../../../../../.claude/rules/critical-patterns.md): **only `preview-video-stream.service.ts` owns the screencast CDP session.**
- **Refs (`data-agent-ref`) are written to the DOM** and reuse `window.__agentRefCounter` + `window.__agentFingerprintMap` — same mechanism as today's collector, so evidence shortcuts survive across the new path.
- **Phase timings** attached to the snapshot as `__cdpPhaseTimings` (mirrors `__debugStats`).
- **Symmetry contract:** the fingerprint key shape and `firstTextFragment` extraction MUST stay byte-equivalent with `snapshot-collector.ts` and [recording-capture.md](recording-capture.md). Drift = wrong-element bugs at apply time.

## Configuration

[snapshot-router.config.ts](../../../../../config/testing/snapshot-router.config.ts) — `const`-based feature flags (no env vars yet — early-stage rollout uses code-as-source-of-truth to avoid staging misconfiguration; env wrappers are a follow-up).

## Wiring (current call sites)

- [preview-session.service.ts:865-876](../preview-session.service.ts) — initial snapshot at session start uses `SnapshotRouter.collect(page, { context: 'preview-tick', skipStabilityWait: true, diagId: sessionId })`.
- [preview-session.service.ts:2287-2297](../preview-session.service.ts) — preview-tick polling during recording uses `SnapshotRouter.collect(page, { context: 'preview-tick', lastDomNodeCount, diagId })`.
- [recording-capture.service.ts](../recording-capture.service.ts) — **NOT** wired yet. The `PROBE_AT_POINT_FN` recorder probe stays Playwright-based; etap 2 is snapshot-only, not point-probe.
- Background replay / regression — pending Week 2-3 once Phase 1/3/4/5 land.

## Risk register

1. **Skeleton phase WIP.** Most `CdpSnapshotService` phases throw `Error('TODO')`. Don't enable `applied`-mode flags before the phases land.
2. **Symmetry burden.** Fingerprint key shape (lines 1215-1227 of `cdp-snapshot.service.ts`) MUST match `snapshot-collector.ts` byte-for-byte. Mitigated by shadow-mode divergence reports (Week 3).
3. **Payload limit.** DOMSnapshot >20MB rejected → fallback. Edge cases: deeply nested SVG, huge inlined stylesheets.
4. **Accessibility domain availability.** `Accessibility.getFullAXTree` may not exist on older Chromium builds → DS-only mapping fallback (manual role compute, lossy WAI-ARIA cascade). Warns once per build.
5. **Iframe support incomplete.** DS captures cross-origin iframes, but ref assignment only handles main frame. Multi-doc ref collision avoidance deferred to a separate iframe project.

## Related

- [preview-session.md](preview-session.md) — `getSnapshot()` consumer.
- [dom-analysis-extractor.md](dom-analysis-extractor.md) — downstream `LiteSnapshot` consumer.
- [recording-capture.md](recording-capture.md) — symmetry partner for `firstTextFragment`.
- [.claude/rules/critical-patterns.md](../../../../../../.claude/rules/critical-patterns.md) — "Never create raw CDP sessions" invariant.
