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
- `SnapshotRouterFlags` — `{ useCdpForBackground_shadow, useCdpForBackground, useCdpForPreview_shadow, useCdpForPreview, useCdpForPreviewPoll, denseThreshold }` (all booleans default `false`; `denseThreshold = 2000`; `useCdpForPreviewPoll` added May 2026 for the 500ms periodic-tick route).
- `SnapshotRouterContext` — 13 values: `'preview-tick' | 'preview-apply' | 'preview-poll' | 'background-regression' | 'lite-engine' | 'lite-action' | 'lite-verification' | 'lite-recovery' | 'pipeline-observe' | 'exploration-survey' | 'exploration-flow' | 'exploration-dismiss' | 'page-interactive-check' | 'legacy-orchestrator' | 'unknown'`.
- `CdpSnapshotError` — typed failure for fallback decisions: `'page_gone' | 'cdp_payload_too_large' | 'ax_domain_unavailable' | 'cdp_send_failed' | 'malformed_response'`.
- `SnapshotDiffReport` — top-level diffs (url, title, activeModalRef, viewport) + element identity mismatches (`onlyInA`, `onlyInB`) + per-element field divergences + histogram of divergent field names + match verdict.

## `SnapshotRouter.collect()` — routing logic

Returns one of three sources:

- **`'cdp_with_fallback'`** — Try CDP first; on any `CdpSnapshotError` silently fall back to evaluate.
- **`'cdp'`** — CDP only, no fallback (reserved; no caller currently maps to this).
- **`'evaluate'`** — Legacy (current default for everything).

### Decision rules
- `context === 'background-regression'` AND `useCdpForBackground` flag true → `cdp_with_fallback`.
- `context === 'preview-apply'` AND `useCdpForPreview` flag true → `cdp_with_fallback`. (**dense-page gate removed May 2026** — `denseThreshold` is deprecated and kept only as shadow-sampling throttle, not a routing gate.)
- `context` maps to `preview-poll` risk group AND `useCdpForPreviewPoll` flag true → `cdp_with_fallback`. (Env var: `SNAPSHOT_USE_CDP_PREVIEW_POLL`.)
- `context === 'legacy-orchestrator'` maps to `'ai'` risk group.
- Otherwise → `'evaluate'`.

### Shadow mode
When `useCdpForBackground_shadow` (background) OR `useCdpForPreview_shadow` (preview) is true, run **both** paths concurrently via `Promise.allSettled`. Production returns the evaluate result; CDP runs only to feed `diffSnapshots()` divergence log. CDP failure never affects production. **Dense-page gate removed** — shadow now runs on ALL pages when the flag is on (only sampling rate `denseThreshold` throttles how often).

## CDP coordination & invariants

- **Screencast-collision measured trade-off (Etap 2).** `CdpSnapshotService` opens its own `CDPSession` via `context.newCDPSession(page)` and detaches it in `finally`. Empirical results from `cdp-screencast-collision.integration.test.ts`:
  - Sparse pages (snapshot <16ms): no FPS impact.
  - Dense pages (snapshot ~90ms): brief drop to ~11 FPS during snapshot, recovers to 60 FPS immediately after.
  - Piggyback on `preview-video-stream`'s screencast session: **100% freeze — worse than a separate session.** Therefore `existingCdpSession` option is NOT for the screencast session — it's reserved for a future dedicated snapshot session (Week 5, TBD).
  - **Calling `Accessibility.enable`** on any session in preview still freezes video — still banned.
  - The old "NEVER create CDP sessions" rule has been revised: separate sessions are fine for background/regression; for preview the trade-off is acceptable for apply/lint paths, but `preview-poll` (500ms periodic tick) requires extra FPS validation before enabling (`useCdpForPreviewPoll` flag stays OFF until validated).
  - See [.claude/rules/critical-patterns.md](../../../../../../.claude/rules/critical-patterns.md) §2 for the updated rule.
- **Refs (`data-agent-ref`) are written to the DOM** and reuse `window.__agentRefCounter` + `window.__agentFingerprintMap` — same mechanism as today's collector, so evidence shortcuts survive across the new path.
- **Phase timings** attached to the snapshot as `__cdpPhaseTimings` (mirrors `__debugStats`).
- **Symmetry contract:** the fingerprint key shape and `firstTextFragment` extraction MUST stay byte-equivalent with `snapshot-collector.ts` and [recording-capture.md](recording-capture.md). Drift = wrong-element bugs at apply time.

## Configuration

[snapshot-router.config.ts](../../../../../config/testing/snapshot-router.config.ts) — `const`-based feature flags. Env-var overrides now wired for the preview-poll route (`SNAPSHOT_USE_CDP_PREVIEW_POLL`); others still code-as-source-of-truth.

**`denseThreshold` status:** field retained in config but no longer gates routing decisions. Only limits shadow-mode sampling rate (default: shadow on 100% of calls regardless of node count).

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
6. **Boolean-falsy normalization in `diffSnapshots()`.** `false`, `undefined`, and `null` are now collapsed to the same "falsy" state when diffing boolean fields. Prevents noisy divergence reports for fields that legitimately default differently between evaluate and CDP paths.

## Related

- [preview-session.md](preview-session.md) — `getSnapshot()` consumer.
- [dom-analysis-extractor.md](dom-analysis-extractor.md) — downstream `LiteSnapshot` consumer.
- [recording-capture.md](recording-capture.md) — symmetry partner for `firstTextFragment`.
- [.claude/rules/critical-patterns.md](../../../../../../.claude/rules/critical-patterns.md) — "Never create raw CDP sessions" invariant.
