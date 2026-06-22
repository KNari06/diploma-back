/**
 * CDP Snapshot Service (Etap 2 — Week 2)
 *
 * Hybrid CDP pipeline: gathers raw DOM/styles/layout via
 * `DOMSnapshot.captureSnapshot`, accessibility roles/names via
 * `Accessibility.getFullAXTree`, and runtime fields (framework
 * detection, current input state, contenteditable, :invalid pseudo)
 * via a single batched `page.evaluate`. Output: a `LiteSnapshot`
 * byte-compatible with the existing `SnapshotCollector.collect()`.
 *
 * Why hybrid (not pure CDP):
 *   `DOMSnapshot.captureSnapshot` does NOT return event listeners,
 *   React fiber refs, JS runtime properties (el.checked, el.value,
 *   el.isContentEditable). `DOMDebugger.getEventListeners` doesn't
 *   detect React 17+ synthetic events (single delegated root listener,
 *   real handlers hidden behind framework runtime). Per-element
 *   evaluate would mean N round-trips; we batch into one call.
 *
 * Performance target (verified projection in 01-fields-audit.md):
 *   11k-DOM page: 200ms DS + 200ms AX + 300ms WS transport + 400ms
 *   Node mapping + 400ms batched evaluate ≈ 1.5s. Compare to today's
 *   12-16s. ~10× speedup, 100% field coverage.
 *
 * Skeleton phase (this file):
 *   - Public entry signature locked
 *   - Phase functions stubbed with explicit `throw new Error('TODO …')`
 *   - Caller in SnapshotRouter still falls through to
 *     `SnapshotCollector.collect` (router does NOT call this service yet)
 *   - Implementation lands incrementally in tasks 2.2 through 2.6
 *
 * What this module NEVER does:
 *   - Replace the recorder probe (`PROBE_AT_POINT_FN`) — point-probe
 *     stays unchanged.
 *   - Mutate the DOM beyond writing `data-agent-ref` attributes (one
 *     evaluate that mirrors today's collector behaviour).
 *   - Persist anything — pure read.
 *   - Open new CDP sessions when an existing one is provided
 *     (preview piggyback path, Week 5).
 */

import type { CDPSession, Frame, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@/utils/core/logger';
import { isDevelopment } from '@/config/environment/env';
import type { LiteElement, LiteSnapshot, ObstacleFact, TransientStateInfo } from '@/agent/core/lite/lite-types';
import {
  POSITIONAL_CANDIDATES_SELECTOR,
  IRON_CLAD_MODAL_SELECTORS,
  CLOSE_BUTTON_SELECTOR,
  INTERACTIVE_CHILDREN_SELECTOR,
} from '@/agent/utils/selectors/modal-detection';
import { isDynamicId as isDynamicIdUtil } from './dynamic-id.util';
import { LANDMARK_ROLES, LANDMARK_TAG_TO_ROLE } from './landmark.util';

/**
 * Computed style names requested from `DOMSnapshot.captureSnapshot`.
 * The order is significant — `layout.styles[i]` is a parallel array
 * of indexes into the strings table, in the same order as this list.
 *
 * Picked to cover everything the existing forEach in
 * `snapshot-collector.ts` reads via `getComputedStyle`:
 *   - visibility decision: display / visibility / opacity
 *   - interactivity hints: cursor / pointer-events
 *   - stacking / overlay: position / z-index
 *   - V8 visual matching: background-color / color / border-radius
 *
 * Adding fields later is cheap (Chrome serialises fast); removing
 * requires checking every consumer of `LiteElement.computedZIndex`,
 * `backgroundColor`, etc.
 */
const REQUESTED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'cursor',
  'pointer-events',
  'position',
  'z-index',
  'background-color',
  'color',
  'border-radius',
] as const;

export interface CdpSnapshotOptions {
  /**
   * Pre-existing CDP session to reuse. Set when piggybacking on the
   * screencast session in preview (Week 5). Avoids
   * `context.newCDPSession()` which would conflict with the singleton
   * `Page.startScreencast` per invariant #3 in preview/CLAUDE.md.
   *
   * When `undefined`, the service opens its own session (safe in
   * background regression — no screencast there).
   */
  existingCdpSession?: CDPSession;
  /** Forwarded for parity with SnapshotCollector. */
  fullPage?: boolean;
  /**
   * When true, skip the DOM stability wait. Used by preview when the
   * caller (`waitForDOMStability` in preview-session) already settled
   * the page. Mirrors `SnapshotCollector.collect({skipStabilityWait})`.
   */
  skipStabilityWait?: boolean;
  /**
   * Caller diagnostic id — propagated into log lines so shadow-mode
   * divergence analysis can correlate by session/run.
   */
  diagId?: string;
  /**
   * Forensic rejection logging — opt-in, DEV-ONLY.
   *
   * When true AND `isDevelopment` (NODE_ENV === 'development'),
   * every node that gets dropped in mapToLiteElements (tier1 /
   * iconish / tier2), findElement (refAssign), or the dedup pass
   * is recorded with `{ tag, attrs, bbox, reason }` and written to
   * a per-snapshot JSONL file under `test_logs/editor/`. The raw
   * DS payload (~1.5 MB) and live page HTML (~1 MB) are also
   * dumped alongside for offline diagnosis.
   *
   * **Production behaviour: the flag is IGNORED.** isDevelopment
   * gate inside collect() short-circuits, no JSONL, no DS dump,
   * no HTML dump. The reason: dump sizes × every user-triggered
   * lint would fill the prod disk within days.
   *
   * **CALLER RESPONSIBILITY: still gate this at the call site.**
   * The service-level dev gate is defence in depth; callers MUST
   * still pass `forensicRejections` only for user-initiated lint
   * (find_button / apply_prelint), not for idle ticks. Mis-gated
   * caller in DEV would produce ~3 MB per second per session.
   *
   * Use case: debugging "the element I want is missing from the
   * candidate list" bugs (May 2026 bi.group close-X incident).
   */
  forensicRejections?: boolean;
}

/**
 * Phase timings — emitted alongside the snapshot for observability.
 * Mirrors the structure already present on snapshot-collector results
 * (`__debugStats`) so dashboards can compare.
 */
export interface CdpPhaseTimings {
  domSnapshotMs: number;
  axTreeMs: number;
  cdpParallelMs: number; // wall-clock: max(domSnapshot, axTree)
  mappingMs: number;
  runtimeEvaluateMs: number;
  modalDetectionMs: number;
  /**
   * Phase 5b — transientState + obstacleFacts + Layer 2 modal fallback,
   * single batched evaluate. Typical: 30-80ms on dense pages (one round-
   * trip + getComputedStyle on positioned candidates only).
   */
  overlayStateMs: number;
  totalMs: number;
}

/**
 * Hard cap on raw DOMSnapshot JSON size. Pages above this threshold
 * blow the WS pipe (~5-10MB is acceptable, 20MB+ starts hiccuping the
 * screencast in preview piggyback path) and serialised mapping in
 * Node burns CPU long enough that fallback to evaluate is faster.
 *
 * The cap is approximate — measured on `JSON.stringify(domSnapshot)`
 * length once received. We don't reject the call mid-stream; CDP
 * returns the full payload first, then we measure and decide whether
 * to throw and let the router fall back.
 *
 * 20MB chosen from audit projection: 11k-DOM page produces ~5-10MB.
 * 2× headroom catches outliers (deeply nested SVG / huge stylesheets)
 * without false-positives on legitimate dense pages.
 */
const DOM_SNAPSHOT_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Memoised "we already warned about Accessibility domain being
 * unavailable" flag — keyed by Chromium build id so a fresh container
 * re-emits the warning. Avoids logging once per snapshot when an
 * older Chromium genuinely doesn't expose the domain.
 *
 * Module-level Map — process-lifetime memoisation. Acceptable because
 * Chromium build id is fixed per process.
 */
const axDomainWarnedFor = new Set<string>();

/**
 * Errors we throw for the router fallback path. Caller (router)
 * MUST treat any thrown error as a fallback signal — not as success.
 *
 * Categorised for shadow-mode metrics: when CDP path fails, we want
 * to know WHY in aggregate, not log a generic "CDP failed".
 */
export type CdpSnapshotFailureKind =
  /** Page navigated mid-call, target document gone. */
  | 'page_gone'
  /** DOMSnapshot returned, but JSON exceeds payload limit. */
  | 'cdp_payload_too_large'
  /** Accessibility domain unavailable on this Chromium build. */
  | 'ax_domain_unavailable'
  /** CDP send rejected (general — connection drop, frame detach). */
  | 'cdp_send_failed'
  /** Returned data malformed (no `documents` array). */
  | 'malformed_response';

export class CdpSnapshotError extends Error {
  constructor(public readonly kind: CdpSnapshotFailureKind, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CdpSnapshotError';
  }
}

/**
 * Internal type — raw CDP data plus derived helpers passed between
 * phase functions. Not exported because consumers should treat this
 * service as a black box that returns `LiteSnapshot`.
 */
interface RawCdpBundle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  domSnapshot: any; // Protocol.DOMSnapshot.CaptureSnapshotResponse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axTree: any;      // Protocol.Accessibility.GetFullAXTreeResponse
}

// ─────────────────────────────────────────────────────────────────
// Forensic rejection logging (May 2026)
//
// Opt-in per-snapshot JSONL trace of every element dropped by the
// pipeline stages. Triggered only by user-initiated lint/Find (not
// idle preview-tick), so the disk cost is bounded.
//
// Used for diagnosing "target was never collected" bugs without
// adding cross-stage state to the regular fast path — every record
// is shaped {tag, attrs, bbox, reason} and pushed to a per-stage
// array carried through the collect() call.
// ─────────────────────────────────────────────────────────────────

/** Compact per-element record carried in `passed.sample` / `rejected[]` / `final.elements`. */
interface ForensicNode {
  tag: string;
  attrs: Record<string, string>;
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** DS-node index inside the source document — lets you cross-reference
   *  with the raw CDP DOMSnapshot dump when really deep diagnosis is needed. */
  dsNodeIdx?: number;
  /** Truncated visible text (≤60 chars). NEVER includes input.value or any
   *  resolved `{{secrets.*}}` (those never reach this layer — collector
   *  reads attrs, not runtime fields). */
  text?: string;
}

interface ForensicRejection extends ForensicNode {
  reason: string;
  /** Optional structured diagnosis — populated for refAssign / dedup where
   *  the WHY is non-trivial. tier1/iconish/tier2 use `reason` alone. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diag?: Record<string, any>;
}

interface ForensicStageRecord {
  stage: 'summary' | 'tier1' | 'iconish' | 'tier2' | 'refAssign' | 'dedup' | 'final';
  inputCount: number;
  passedCount: number;
  rejected: ForensicRejection[];
  /** Optional small sample of nodes that PASSED the stage. Sampled at
   *  most ~10 entries — enough to confirm "did the target survive?"
   *  without ballooning the file on a 500-node page. */
  passedSample?: ForensicNode[];
  /** Stage wall-clock in ms. Useful when chasing perf regressions. */
  durationMs?: number;
  /** Free-form per-stage extras (counters, hit rates, etc.). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
}

interface ForensicCollector {
  diagId: string;
  /** Snapshot start wall-clock — used to compute per-stage durations. */
  startedAt: number;
  /** Captured at the end of collect() so the `summary` stage can carry
   *  context (URL, viewport, document count, phase timings). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary?: Record<string, any>;
  /** Captured at the end — final element list snapshot for "did it survive?" */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  final?: { elementCount: number; elements: ForensicNode[]; extra?: Record<string, any> };
  stages: ForensicStageRecord[];
}

const FORENSIC_LOGS_DIR = path.join(process.cwd(), 'test_logs', 'editor');
/** Attributes we keep on each rejection record — small but diagnostic.
 *  Wider than the v1 list to capture framework-specific hints (alpine,
 *  htmx, qwik) and a11y signals that often distinguish the target from
 *  decorative siblings on icon-heavy pages. */
const FORENSIC_INTEREST_ATTRS = [
  'id', 'class', 'role', 'type', 'name', 'href', 'xlink:href',
  'aria-label', 'aria-labelledby', 'aria-controls', 'aria-haspopup', 'aria-expanded',
  'data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-test-element', 'data-track',
  'data-action', 'data-bind', 'data-toggle',
  'tabindex', 'title', 'alt', 'placeholder',
] as const;

/** How many `passed.sample` entries to keep per stage. Tuned so the JSONL
 *  stays scannable (~10 lines per stage) while still showing both
 *  identity-rich (first matches usually have id/testId) and bbox-only
 *  (later matches) nodes. */
const FORENSIC_PASSED_SAMPLE_SIZE = 10;
/** Cap on final.elements — every surviving element is recorded so you can
 *  grep for "is my target in there at all?" in one place. 500 is the
 *  MAX_TOTAL_ELEMENTS cap anyway, so this is effectively "all". */
const FORENSIC_FINAL_ELEMENT_CAP = 500;

function pickForensicAttrs(attrs: DecodedAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORENSIC_INTEREST_ATTRS) {
    const v = attrs.get(key);
    if (v !== undefined && v !== '') out[key] = v.length > 120 ? v.slice(0, 120) : v;
  }
  // Class lists get long fast; truncate aggressively to keep JSONL compact.
  if (out.class && out.class.length > 80) out.class = out.class.slice(0, 80) + '…';
  return out;
}

function bboxToForensic(
  bounds: { x: number; y: number; width: number; height: number } | undefined,
): ForensicRejection['bbox'] {
  if (!bounds) return null;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    w: Math.round(bounds.width),
    h: Math.round(bounds.height),
  };
}

/**
 * Build a compact ForensicNode from a fully-mapped LiteElement. Used by
 * `passedSample` and `final.elements` arrays so they share the same shape
 * as `rejected[]` — one jq filter works across the whole JSONL.
 */
function liteElementToForensic(el: LiteElement): ForensicNode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elAny = el as any;
  // bbox=null when:
  //   - el.bounds genuinely absent, OR
  //   - tier1.noBounds-rescue (real bounds were missing, we faked
  //     {0,0,0,0} for refAssign Stage A/C to work). Honest reporting
  //     here keeps `jq '.bbox == null'` queries reliable.
  const isRescued = elAny.__noBoundsRescued === true;
  return {
    tag: el.tag,
    attrs: {
      ...(el.id ? { id: el.id } : {}),
      ...(el.testIdAttr ? { 'data-testid': el.testIdAttr } : {}),
      ...(el.role ? { role: el.role } : {}),
      ...(el.htmlName ? { name: el.htmlName } : {}),
      ...(el.ariaLabel ? { 'aria-label': el.ariaLabel } : {}),
      ...(el.placeholder ? { placeholder: el.placeholder } : {}),
      ...(el.href ? { href: el.href } : {}),
      ...(el.type ? { type: el.type } : {}),
      ...(el.ref ? { ref: el.ref } : {}),
      ...(isRescued ? { '__rescue': 'noBounds' } : {}),
    },
    bbox: (el.bounds && !isRescued)
      ? {
        x: Math.round(el.bounds.x),
        y: Math.round(el.bounds.y),
        w: Math.round(el.bounds.width),
        h: Math.round(el.bounds.height),
      }
      : null,
    dsNodeIdx: elAny.__dsNodeIndex,
    ...(el.text ? { text: el.text.slice(0, 60) } : {}),
  };
}

/**
 * Best-effort async write. Fire-and-forget — the caller does NOT await
 * this, so the snapshot return path is not blocked by disk I/O. Critical
 * on cloud VMs with network-attached storage where `writeFileSync` can
 * block the event loop for tens of ms.
 *
 * Errors are swallowed — forensic logging must NEVER fail a snapshot
 * collect (CLAUDE.md invariant 11: telemetry writes are best-effort).
 */
/**
 * Quality score for dedup-survivor selection. Higher wins.
 * A noBounds-rescue node (DS had no layout row — decorative/offscreen
 * glyph kept only for id-fallback) or a zero-area box scores 0; a node
 * with a real rendered box scores 1. Used by `dedupeElementsByRef` to
 * pick which element survives when two share a ref. See the doculite
 * incident note at that call site.
 */
function dedupSurvivorScore(el: LiteElement): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rescued = (el as any).__noBoundsRescued === true;
  const w = el.bounds?.width ?? 0;
  const h = el.bounds?.height ?? 0;
  if (rescued || w <= 0 || h <= 0) return 0;
  return 1;
}

/**
 * Resolve ref collisions in place: for every `ref` that appears more than
 * once, keep the single highest-scoring element (real bbox beats
 * noBounds/zero-area; ties keep the earliest array index for stable,
 * deterministic output) and return the dropped entries' indices.
 *
 * Pure helper extracted from `collect()` so the keep-winner policy is
 * unit-testable. MUTATES `elements` (splices losers out) and returns the
 * losers so the caller can emit forensic rejections. Entries without a
 * `ref` are left untouched.
 */
function dedupeElementsByRef(elements: LiteElement[]): LiteElement[] {
  const winnerByRef = new Map<string, number>(); // ref -> winning index
  for (let i = 0; i < elements.length; i++) {
    const ref = elements[i].ref;
    if (!ref) continue;
    const prev = winnerByRef.get(ref);
    if (prev === undefined) {
      winnerByRef.set(ref, i);
    } else if (dedupSurvivorScore(elements[i]) > dedupSurvivorScore(elements[prev])) {
      // Strictly-better candidate replaces the incumbent. `>` (not `>=`)
      // keeps the earlier index on ties — stable and deterministic.
      winnerByRef.set(ref, i);
    }
  }
  const losers: LiteElement[] = [];
  // Iterate high→low so splices don't shift indices we still need to test.
  for (let i = elements.length - 1; i >= 0; i--) {
    const ref = elements[i].ref;
    if (!ref) continue;
    if (winnerByRef.get(ref) === i) continue; // the survivor
    losers.push(elements[i]);
    elements.splice(i, 1);
  }
  // `losers` was built high→low; reverse to document order for stable
  // forensic output.
  losers.reverse();
  return losers;
}

function writeForensicJsonl(collector: ForensicCollector): void {
  if (collector.stages.length === 0 && !collector.summary && !collector.final) return;
  // Serialize on the caller thread (cheap CPU work) so the snapshot of
  // the stages object can't be mutated between fire and actual write.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeDiagId = collector.diagId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  const filePath = path.join(FORENSIC_LOGS_DIR, `${safeDiagId}_forensic_${ts}.jsonl`);
  const writeTs = new Date().toISOString();

  // JSONL line builder — uniform shape across all stages so a single jq
  // filter can scan the whole file. `stage` is the discriminator.
  const lines: string[] = [];

  // Line 1 — summary header. Always first when present so a reader
  // can `head -n1 file.jsonl | jq` to get context without scanning.
  if (collector.summary) {
    lines.push(JSON.stringify({
      ts: writeTs,
      diagId: collector.diagId,
      stage: 'summary',
      ...collector.summary,
    }));
  }

  // Stage lines in pipeline order.
  for (const s of collector.stages) {
    lines.push(JSON.stringify({
      ts: writeTs,
      diagId: collector.diagId,
      stage: s.stage,
      input: { count: s.inputCount },
      passed: {
        count: s.passedCount,
        ...(s.passedSample && s.passedSample.length > 0
          ? { sample: s.passedSample }
          : {}),
      },
      rejected: s.rejected,
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.extra ? { extra: s.extra } : {}),
    }));
  }

  // Final line — surviving elements snapshot. Lets you grep for
  // attributes of the target right next to all the dropped ones.
  if (collector.final) {
    lines.push(JSON.stringify({
      ts: writeTs,
      diagId: collector.diagId,
      stage: 'final',
      elementCount: collector.final.elementCount,
      elements: collector.final.elements,
      ...(collector.final.extra ? { extra: collector.final.extra } : {}),
    }));
  }

  const payload = lines.join('\n') + '\n';
  const totalRejected = collector.stages.reduce((a, s) => a + s.rejected.length, 0);

  // Run mkdir + writeFile off the critical path. .catch() prevents
  // unhandled-rejection crashes; logger.debug keeps the trail visible
  // when investigating "why didn't the forensic file appear".
  void fs.promises.mkdir(FORENSIC_LOGS_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(filePath, payload, 'utf8'))
    .then(() => {
      logger.info('[CDP_SNAPSHOT] Forensic rejection log written', {
        diagId: collector.diagId,
        filePath,
        stageCount: collector.stages.length,
        totalRejected,
      });
    })
    .catch((err) => {
      logger.debug('[CDP_SNAPSHOT] Forensic write failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Deep-dump companion to `writeForensicJsonl`. Writes the raw CDP
 * DOMSnapshot payload and the live page HTML to disk alongside the
 * JSONL — same basename, sibling files. Lets the operator confirm
 * "is the target node even in the data?" without re-running the lint.
 *
 * Best-effort: all errors swallowed (CLAUDE.md invariant 11).
 *
 * Cost:
 *   - DS dump: 2-15MB JSON on dense pages, ~50ms to stringify
 *   - HTML dump: 0.5-5MB, single page.content() call
 * Acceptable because forensic mode itself is opt-in (only user-triggered
 * lint sets it), so the disk hit is bounded to a handful per session.
 *
 * Filename pattern (matches the JSONL emit):
 *   <safeDiagId>_forensic_<ts>_ds.json
 *   <safeDiagId>_forensic_<ts>_html.html
 *
 * The shared timestamp lets `ls -lt` group them, and `_ds`/`_html`
 * suffixes are filter-friendly:
 *   ls test_logs/editor/<sessionId>_forensic_*_ds.json | tail -1
 */
async function writeForensicArtifacts(
  collector: ForensicCollector,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawDomSnapshot: any,
  page: Page,
): Promise<void> {
  // Same filename derivation as writeForensicJsonl — keep them lockstep
  // so the artifacts are obviously paired in `ls` output. We approximate
  // the JSONL's timestamp by recomputing here; if the two writes happen
  // in different ms ticks they end up with different timestamps. That's
  // acceptable because the diagId prefix is enough to find the trio.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeDiagId = collector.diagId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  const basePath = path.join(FORENSIC_LOGS_DIR, `${safeDiagId}_forensic_${ts}`);

  // Fire DS dump and HTML dump in parallel. Both fail-open.
  const dsPath = `${basePath}_ds.json`;
  const htmlPath = `${basePath}_html.html`;

  const dsPromise = (async () => {
    try {
      // JSON.stringify can be 100-300ms on dense pages. Acceptable on
      // a debug path, but we explicitly do it OFF the event loop tick
      // that returned the snapshot (caller is .catch()'d, not awaited).
      const dsString = JSON.stringify(rawDomSnapshot);
      await fs.promises.mkdir(FORENSIC_LOGS_DIR, { recursive: true });
      await fs.promises.writeFile(dsPath, dsString, 'utf8');
      logger.info('[CDP_SNAPSHOT] Forensic DS dump written', {
        diagId: collector.diagId,
        filePath: dsPath,
        sizeBytes: Buffer.byteLength(dsString),
      });
    } catch (err) {
      logger.debug('[CDP_SNAPSHOT] Forensic DS dump failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  const htmlPromise = (async () => {
    try {
      // page.content() can throw on closed/navigating pages. Best-effort.
      const html = await page.content();
      await fs.promises.mkdir(FORENSIC_LOGS_DIR, { recursive: true });
      await fs.promises.writeFile(htmlPath, html, 'utf8');
      logger.info('[CDP_SNAPSHOT] Forensic HTML dump written', {
        diagId: collector.diagId,
        filePath: htmlPath,
        sizeBytes: Buffer.byteLength(html),
      });
    } catch (err) {
      logger.debug('[CDP_SNAPSHOT] Forensic HTML dump failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  await Promise.all([dsPromise, htmlPromise]);
}

// ─────────────────────────────────────────────────────────────────
// Mapping helpers (Phase 3a/3b building blocks)
//
// These live above the class because they're pure functions over
// DS shape — easier to unit-test in isolation, and the class
// methods stay focused on orchestration.
// ─────────────────────────────────────────────────────────────────

/** Decoded HTML attributes as plain key→value map. */
type DecodedAttrs = Map<string, string>;

/**
 * DS attributes are stored as a flat array of alternating
 * `[nameStringIdx, valueStringIdx, nameStringIdx, valueStringIdx, ...]`.
 * Decode into a Map for ergonomic lookup downstream.
 */
function decodeAttributes(rawAttrs: unknown, getStr: (idx: number) => string): DecodedAttrs {
  const out: DecodedAttrs = new Map();
  if (!Array.isArray(rawAttrs)) return out;
  for (let i = 0; i + 1 < rawAttrs.length; i += 2) {
    const name = getStr(rawAttrs[i]).toLowerCase();
    const value = getStr(rawAttrs[i + 1]);
    if (!name) continue;
    out.set(name, value);
  }
  return out;
}

/**
 * Decoded computed styles, one entry per `REQUESTED_COMPUTED_STYLES` slot.
 * Indexes match the order we passed to DOMSnapshot.captureSnapshot.
 */
type DecodedStyles = {
  display: string;
  visibility: string;
  opacity: string;
  cursor: string;
  pointerEvents: string;
  position: string;
  zIndex: string;
  backgroundColor: string;
  color: string;
  borderRadius: string;
};

/**
 * `layout.styles[i]` is a flat array of string indexes, parallel to
 * REQUESTED_COMPUTED_STYLES. Decode into named fields.
 */
function decodeStylesForLayoutIdx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layout: any,
  layoutIdx: number,
  getStr: (idx: number) => string,
): DecodedStyles | undefined {
  const stylesArr: number[][] | undefined = layout.styles;
  if (!Array.isArray(stylesArr)) return undefined;
  const slot = stylesArr[layoutIdx];
  if (!Array.isArray(slot)) return undefined;
  // Order MUST match REQUESTED_COMPUTED_STYLES.
  return {
    display: getStr(slot[0]),
    visibility: getStr(slot[1]),
    opacity: getStr(slot[2]),
    cursor: getStr(slot[3]),
    pointerEvents: getStr(slot[4]),
    position: getStr(slot[5]),
    zIndex: getStr(slot[6]),
    backgroundColor: getStr(slot[7]),
    color: getStr(slot[8]),
    borderRadius: getStr(slot[9]),
  };
}

/**
 * Bounds are a flat `[x, y, width, height]` array per layout slot.
 */
function decodeBoundsForLayoutIdx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layout: any,
  layoutIdx: number,
): { x: number; y: number; width: number; height: number } | undefined {
  const bounds = layout.bounds;
  if (!Array.isArray(bounds)) return undefined;
  const b = bounds[layoutIdx];
  if (!Array.isArray(b) || b.length < 4) return undefined;
  return { x: b[0], y: b[1], width: b[2], height: b[3] };
}

/**
 * Tags considered structurally interactive without further checks.
 * Mirrors the Tier-1 selector set the SnapshotCollector emits today.
 */
// Mirrors evaluate-path's `interactiveSelectors` core list. NOTE:
// `label` deliberately excluded — evaluate-path doesn't treat <label>
// as interactive (the input it labels is what users click). Including
// it in CDP made shadow-mode show CDP returning 2 extra elements
// per form (one per <label>), all of which the resolver would never
// pick. `summary`/`details` likewise dropped — evaluate handles them
// via separate `summary` selector entry below in tier-1 supplements.
const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'select', 'textarea',
  'option',
]);

/**
 * ARIA roles considered interactive (Tier-1 supplement). Native tag
 * coverage above already gets `role=button` etc. for free, but custom
 * `<div role="button">` needs this list.
 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'option', 'treeitem',
  'row', 'cell', 'gridcell', 'columnheader', 'rowheader',
  'switch', 'checkbox', 'radio', 'combobox', 'listbox',
  'menu', 'searchbox', 'spinbutton', 'slider', 'textbox',
]);

/**
 * Filter: is this DS node interactive enough to keep in the
 * LiteElement output? Two-tier:
 *   1. Native interactive tag → keep
 *   2. Has interactive ARIA role → keep
 *   3. Has tabindex >= 0 → keep
 *   4. Has cursor:pointer → keep (Tier-2; framework div with onClick)
 *
 * Symmetry contract: matches snapshot-collector Tier-1+Tier-2 filter
 * so both sources see the same population. Drift here causes
 * shadow-mode false-positives.
 */
/**
 * Tier-1 interactive node check — strong, deterministic signals that
 * an element is a known interactive control. No cap; every Tier-1 hit
 * is included.
 *
 * MUST stay symmetric with the evaluate-path's `interactiveSelectors`
 * array in snapshot-collector.ts (~line 763). When evaluate adds a new
 * selector and we don't, CDP path silently skips that element class —
 * happens silently because the shadow-mode diff lists it under
 * `onlyInEvaluate`.
 */
function isInteractiveNodeTier1(
  tagName: string,
  attrs: DecodedAttrs,
): boolean {
  // Native interactive HTML elements
  if (INTERACTIVE_TAGS.has(tagName)) return true;

  // Semantic structural tags evaluate-path includes
  if (tagName === 'li' || tagName === 'canvas') return true;
  if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3') return true;
  if (tagName === 'summary') return true;

  // ARIA widget roles
  const role = attrs.get('role')?.toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  // Additional roles from evaluate-path's interactiveSelectors
  if (role === 'menuitemcheckbox' || role === 'menuitemradio'
      || role === 'alertdialog' || role === 'toolbar') {
    return true;
  }

  // tabindex >= 0 (focusable via keyboard)
  const tabindex = attrs.get('tabindex');
  if (tabindex !== undefined && tabindex !== '-1') {
    const n = parseInt(tabindex, 10);
    if (!isNaN(n) && n >= 0) return true;
  }

  // Attribute-based interactive signals (no role / no native tag,
  // but framework-bound or test-targeted).
  if (attrs.has('onclick')) return true;
  // Runtime framework click handler (React fiber / Vue / Angular) stamped by
  // tagFrameworkClickable BEFORE captureSnapshot — invisible to an
  // attribute-only DOMSnapshot otherwise. See FRAMEWORK_CLICK_MARKER.
  if (attrs.has(FRAMEWORK_CLICK_MARKER)) return true;
  if (attrs.has('data-testid') || attrs.has('data-test') || attrs.has('data-test-id')
      || attrs.has('data-cy') || attrs.has('data-qa')) return true;
  if (attrs.has('data-toggle') || attrs.has('aria-haspopup')) return true;
  if (attrs.get('draggable') === 'true') return true;
  if (attrs.has('contenteditable')) {
    const v = attrs.get('contenteditable');
    if (v === 'true' || v === '') return true;
  }

  // Native <dialog open>
  if (tagName === 'dialog' && attrs.has('open')) return true;

  // Framework-specific event attribute markers
  // (Alpine.js x-on:click, HTMX hx-*, Stimulus data-action,
  //  Knockout data-bind, Qwik on:click)
  if (attrs.has('x-on:click') || attrs.has('on:click')) return true;
  if (attrs.has('hx-get') || attrs.has('hx-post') || attrs.has('hx-put')
      || attrs.has('hx-delete') || attrs.has('hx-patch')) return true;
  if (attrs.has('data-hx-get') || attrs.has('data-hx-post')) return true;
  if (attrs.has('data-action') || attrs.has('data-bind')) return true;

  return false;
}

/**
 * Icon-ish secondary pass check — element is an SVG/i/img/path with
 * a stable id or testid, even though it has no interactive role.
 * Mirrors evaluate-path's secondary pass at snapshot-collector.ts
 * ~line 1126. Critical for icon-only buttons / branded logos that
 * don't have role=button but DO have stable id (e.g. `<img id="logo">`).
 *
 * Without this, recorder records `<img id="logo">` with id, recorder
 * resolver tries identity fast-path on id="logo", but CDP snapshot
 * doesn't include the img → no match → fallback to LLM → wrong CTA.
 */
function isInteractiveIconish(
  tagName: string,
  attrs: DecodedAttrs,
): boolean {
  if (tagName !== 'svg' && tagName !== 'i' && tagName !== 'img' && tagName !== 'path') {
    return false;
  }
  const rawId = attrs.get('id') || '';
  const idLooksGenerated = !!rawId && (
    /^el-id-/i.test(rawId)
    || /^radix-/.test(rawId)
    || /^:r[0-9a-z]+:$/i.test(rawId)
    || /^mui-/i.test(rawId)
    || /^headlessui-/i.test(rawId)
    || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rawId)
  );
  const hasStableId = !!rawId && !idLooksGenerated && rawId.length < 80;
  const hasTestIdAttr = attrs.has('data-testid')
    || attrs.has('data-test-id')
    || attrs.has('data-test')
    || attrs.has('data-cy')
    || attrs.has('data-qa');
  // V-bigroup-2 May 2026 — iconish on CSS-Modules sites:
  //   bi.group close-X SVG had neither id nor testId (CSS-Modules
  //   strips identifiers), but DID carry aria-label / role="button"
  //   on the wrapper. Previous predicate returned 0 iconish hits on
  //   the entire bi.group page. These are now accepted:
  //     - aria-label / role / aria-* hint → screen-reader-targeted icon
  //     - href (svg/img inside <a>; sometimes inlined as direct attr)
  //     - title attr (tooltips often live here for icon-only buttons)
  //   Tier-2 cursor:pointer pass also picks these up if the parent has
  //   pointer; this predicate covers the case where DS layout puts the
  //   icon itself in `cursor: default` but the wrapper has pointer.
  const hasAriaHint = attrs.has('aria-label')
    || attrs.has('aria-labelledby')
    || attrs.has('role');
  const hasTitle = attrs.has('title');
  const hasHref = attrs.has('href') || attrs.has('xlink:href');
  return hasStableId || hasTestIdAttr || hasAriaHint || hasTitle || hasHref;
}

/**
 * Tier-2 interactive node check — cursor:pointer signals a
 * framework-bound clickable (React onClick on a div, Vue @click on
 * span, etc.). Critically: this MUST be capped, otherwise a page
 * with global `cursor:pointer` CSS rule (or app-wide hover effect)
 * floods the snapshot with thousands of false-positive children
 * (every <i>, <span> in a button gets included). Evaluate path uses
 * MAX_SECONDARY_ELEMENTS = 300; we mirror that.
 *
 * Why this matters in production:
 *   On a 5000-button toolbar where each button has 2 child elements
 *   inheriting cursor:pointer, an UNCAPPED Tier-2 returns 15000+
 *   elements. Phase 3.5 / Phase 4 then run per-element work on each
 *   one — dense pages become 30× SLOWER than evaluate path
 *   (measured: 6.5s CDP vs 0.7s evaluate on a 5000-button synthetic).
 *   The cap keeps us at parity with evaluate-path semantics.
 */
function isInteractiveNodeTier2(
  styles: DecodedStyles | undefined,
): boolean {
  return styles?.cursor === 'pointer';
}

/**
 * @deprecated Use isInteractiveNodeTier1/Tier2 directly so the caller
 * can apply a cap to Tier-2 hits. Kept as a thin wrapper for
 * backwards-compat in tests.
 */
function isInteractiveNode(
  tagName: string,
  attrs: DecodedAttrs,
  styles: DecodedStyles | undefined,
): boolean {
  return isInteractiveNodeTier1(tagName, attrs) || isInteractiveNodeTier2(styles);
}

/**
 * Marker attribute stamped on framework-clickable elements (React fiber /
 * Vue instance/vnode / Angular context with a real click handler) by
 * `tagFrameworkClickable` BEFORE `DOMSnapshot.captureSnapshot`, then read by
 * `isInteractiveNodeTier1` to promote them to Tier-1 so they survive the
 * MAX_TIER2_ELEMENTS cap.
 *
 * WHY (restores invariant #5 — collector symmetry): the evaluate-path
 * collector (snapshot-collector.ts "Tier 1: Framework event bindings") detects
 * runtime JS-prop handlers in-page and includes those elements. A CDP
 * DOMSnapshot exposes attributes + computed styles but NOT JS-prop handlers —
 * React keeps `onClick` in the fiber (`__reactProps$*.onClick`), Vue in the
 * instance/vnode — so the CDP path was framework-BLIND and a role-less
 * `<div onClick>` (e.g. documentolog.com/en "Login": `<div><svg/><p>Login</p>
 * </div>`) was only a `cursor:pointer` Tier-2 candidate. On dense pages (>300
 * such nodes) the cap dropped it and the resolver never saw it ("element not
 * found"). Stamping a marker pre-capture closes the gap and re-aligns the two
 * collectors. NOTE: attribute-based frameworks (Alpine/HTMX/Stimulus/Knockout/
 * Qwik) are ALREADY Tier-1 here via attribute checks — only the runtime
 * frameworks need this pass.
 *
 * Removed again in collect()'s finally so it never persists on the live
 * (screencast) DOM. Read ONLY by the Tier-1 predicate and never copied into
 * the LiteElement (the builder uses curated fields), so it cannot leak into
 * the resolver / LLM payload.
 */
const FRAMEWORK_CLICK_MARKER = 'data-qait-fwclick';

/**
 * Toggle for the framework-clickable promotion pass. Module const (not env)
 * so it's trivially revertible — flip to false to restore the pre-fix
 * behaviour where the Tier-2 cap may drop JS-prop-onClick buttons.
 */
const PROMOTE_FRAMEWORK_CLICKABLE = true;

/** Symmetric cap with evaluate-path's MAX_SECONDARY_ELEMENTS. */
const MAX_TIER2_ELEMENTS = 300;

/**
 * Hard cap on TOTAL elements returned (Tier-1 + Tier-2 combined).
 *
 * History (May 2026):
 *   - v1: 500. Mirrored `MAX_INTERACTIVE_NODES = 500` in
 *     dom-analysis-extractor.service.ts. Worked for sparse pages.
 *   - v2: 1500. The bi.group close-X audit revealed dense modals where
 *     365 tier-1 + 135 tier-2 = 500 was hit, dropping 761 tier-2
 *     candidates. Even with tier-2 priority sort fix, dense pages
 *     (admin panels, design systems, e-commerce with 50+ icon buttons
 *     per row) can starve the priority-sorted tier-2 cohort if tier-1
 *     alone exceeds 500.
 *     Trade-off measured on bi.group:
 *       - +3× memory (~1MB → ~3MB per snapshot)
 *       - +2-3× refAssign / Phase 4 latency (~21ms → ~60ms)
 *       - LLM prompt size UNCHANGED (pruner caps to 15 regardless)
 *     Net wall-clock impact: ~80ms → ~200ms total snapshot. Within
 *     budget for the lint path (5s LLM dominates anyway).
 *
 * IMPORTANT: this MUST stay in sync with `MAX_INTERACTIVE_NODES` in
 * dom-analysis-extractor.service.ts. If the CDP cap is higher than the
 * extractor cap, priority-sorted tier-2 nodes get dropped by the
 * downstream extractor in document order — losing the very priority
 * ordering this cap was raised to preserve. Bumping one without the
 * other is the bug class to watch for. Bumping logged in CLAUDE.md.
 */
const MAX_TOTAL_ELEMENTS = 1500;

/**
 * Build a `LiteElement` from a single DS node + its AX cross-reference.
 *
 * What we DO populate here (Phase 3b — direct from raw):
 *   - tag, type, role, name, accessible name
 *   - HTML attributes (id, name, placeholder, title, etc.)
 *   - bounds, computedZIndex, isPositioned
 *   - visible (derived from styles)
 *   - href (raw — absolute URL resolution requires page context;
 *     consumers tolerate relative href today)
 *
 * What we DON'T populate here (later phases):
 *   - ref (Phase 3.5 batched evaluate writes data-agent-ref)
 *   - parentRefChain / containerTitles (Phase 3c needs refs assigned
 *     first, then walks DS parentIndex)
 *   - frameworkClickable / runtime fields (Phase 4 evaluate)
 *   - isInsideActiveModal (Phase 5 detection)
 *   - icon detection / firstTextFragment / nearestRowText (Phase 3c
 *     ancestor walks; same data already in raw, just postprocess)
 */
function buildLiteElementFromNode(args: {
  tagName: string;
  attrs: DecodedAttrs;
  bounds: { x: number; y: number; width: number; height: number };
  styles: DecodedStyles | undefined;
  axNode: unknown;
  dsNodeIndex: number;
  docIndex: number;
  /**
   * Resolved document URL for the DS document this node belongs to.
   * Required for matching CDP DocumentSnapshot to a Playwright `Frame`
   * during Phase 3.5 ref assignment — the only reliable bridge between
   * the two APIs (Playwright doesn't expose CDP frameId; URL is what
   * both sides agree on). Empty string for the main frame is fine —
   * Phase 3.5 short-circuits docIndex=0 to `page.mainFrame()` directly.
   */
  docUrl?: string;
  /**
   * Direct-child text content for this DS node, accumulated from
   * `nodes.textValue` (text leaves whose parentIndex points at this
   * node). Distinct from AX `name` — `text` is the raw visible string,
   * `name` is the WAI-ARIA cascade. Both are needed: `text` for
   * resolver matching on icon-poor div-buttons, `name` for accessible
   * name fingerprint match.
   */
  rawText?: string;
}): LiteElement {
  const { tagName, attrs, bounds, styles, axNode } = args;

  // Implicit role from AX takes priority — Chrome's accessibility
  // engine has the canonical implementation. Fallback: explicit
  // role attribute. If neither, leave empty — buildAllowedSets
  // tolerates missing role for native tags via tag map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axRole = (axNode as any)?.role?.value as string | undefined;
  const explicitRole = attrs.get('role') ?? undefined;
  const rawRole = (axRole || explicitRole || '').toLowerCase();
  // Framework-clickable role promotion (collector symmetry, invariant #5).
  // A role-less `<div onClick>` / `<span onClick>` carrying FRAMEWORK_CLICK_MARKER
  // is a real button to the user, but Chrome's AX engine labels it role="generic".
  // That presentational role makes the LLM candidate pruner drop it AND trips the
  // resolver's structural-actionability guard (isPresentationalRole + no
  // affordance) — so the CDP path can't resolve it while the evaluate path (which
  // surfaces it as a button) can. Promote to `button`. Scoped to div/span so a
  // React onScroll/animation handler on an <h1>/<p> (the known false-positive
  // class the actionability guard exists to catch) is NOT mislabelled.
  const role = (
    attrs.has(FRAMEWORK_CLICK_MARKER)
    && (rawRole === '' || rawRole === 'generic' || rawRole === 'none')
    && (tagName === 'div' || tagName === 'span')
  ) ? 'button' : rawRole;

  // Accessible name from AX. Per WAI-ARIA spec, AX `name` already
  // applied the full label cascade (aria-labelledby > aria-label >
  // label > placeholder > title > text content), so we don't repeat
  // it here. Empty string is meaningful — "AX engine declared this
  // element nameless"; don't synthesise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axName = ((axNode as any)?.name?.value as string | undefined) ?? '';

  // Visibility — display/visibility/opacity gate. Same logic as today.
  const visible = !!styles
    && styles.display !== 'none'
    && styles.visibility !== 'hidden'
    && parseFloat(styles.opacity || '1') > 0;

  // computedZIndex — null when 'auto'/non-numeric (matches LiteElement).
  let computedZIndex: number | null | undefined;
  if (styles?.zIndex && styles.zIndex !== 'auto') {
    const z = parseInt(styles.zIndex, 10);
    computedZIndex = isNaN(z) ? null : z;
  } else if (styles) {
    computedZIndex = null;
  }

  // ── Identity fields (Q5 audit fix May 2026) ────────────────────
  // Identity fast-path in element-resolver (preview-step-apply.service)
  // requires `id`, `testIdAttr`, AND `isDynamicId` populated on every
  // element. The recorder probe + evaluate-path collector both fill
  // these; CDP path was dropping them silently. Without them:
  //   - identity_id / identity_testid resolverPaths NEVER fire on CDP
  //   - locator-plan-builder loses id/testId strategies (line ~220-237)
  //   - compiled-plan match scoring loses 2 of its strongest signals
  // Filtered through shared `isDynamicId()` util — same regex as
  // recorder, fingerprint, and locator-plan-builder. Bytewise symmetry.
  const rawId = attrs.get('id') || '';
  const idIsDynamic = rawId ? isDynamicIdUtil(rawId) : false;
  const stableId = (rawId && !idIsDynamic && rawId.length < 80) ? rawId : undefined;
  const testIdAttr = attrs.get('data-testid')
    || attrs.get('data-test-id')
    || attrs.get('data-test')
    || attrs.get('data-cy')
    || attrs.get('data-qa')
    || attrs.get('data-test-element')
    || attrs.get('data-track')
    || undefined;

  const el: LiteElement = {
    // ref intentionally empty here — Phase 3.5 fills it via batched
    // DOM write. Consumers MUST NOT rely on ref before Phase 3.5
    // completes; mapping is internal.
    ref: '',
    role,
    name: axName,
    // Raw visible text (DS textValue → trimmed, capped at ~100 chars)
    // — see args.rawText doc for the AX-name-vs-raw-text rationale.
    // Undefined when no direct text child exists (icon-only buttons,
    // empty containers); resolver consumers must tolerate this.
    text: args.rawText && args.rawText.length > 0 ? args.rawText : undefined,
    tag: tagName,
    visible,
    // Identity fields — see Q5 block above. `id` is stable-only
    // (dynamic generated IDs filtered out); `testIdAttr` covers all
    // common test-id conventions; `isDynamicId` exposes the
    // determination so consumers don't re-run the regex.
    id: stableId,
    testIdAttr,
    isDynamicId: idIsDynamic || undefined,
    type: attrs.get('type') || undefined,
    placeholder: attrs.get('placeholder') || undefined,
    autocomplete: attrs.get('autocomplete') || undefined,
    // ═══════════════════════════════════════════════════════════════
    // Phase 3c-DS — fields the existing collector reads via
    // attributes/styles only. Filling them here avoids paying for an
    // evaluate round-trip in Phase 4. Symmetry with snapshot-collector
    // — these implementations mirror the in-page logic byte-for-byte.
    // ═══════════════════════════════════════════════════════════════
    //
    // contenteditable: spec says empty string === 'true' (legacy
    // default behaviour), so both 'true' and '' enable editing.
    isContentEditable:
      attrs.get('contenteditable') === 'true' || attrs.get('contenteditable') === ''
        ? true
        : undefined,
    // onclick attribute presence — the SnapshotCollector counterpart.
    // This DOES NOT detect React synthetic onClick (that requires
    // runtime fiber introspection in Phase 4). Same gap as today.
    hasOnclick: attrs.has('onclick') || undefined,
    // Framework detection split into two halves:
    //   - Attribute-based frameworks (Alpine, HTMX, Stimulus,
    //     Knockout, Qwik) → derived in Node from DS attrs.
    //   - JS-runtime frameworks (React, Vue, Angular, Svelte,
    //     jQuery) → require Phase 4 evaluate.
    // We populate the attribute half here. Phase 4 will OVERRIDE
    // when a JS-runtime framework is detected on the same element
    // (React's runtime presence is more authoritative than an
    // attribute heuristic on a wrapper element).
    frameworkClickable: detectAttributeBasedFramework(attrs),
    inputmode: attrs.get('inputmode') || undefined,
    htmlName: attrs.get('name') || undefined,
    htmlId: attrs.get('id') || undefined,
    ariaLabel: attrs.get('aria-label') || undefined,
    title: attrs.get('title') || undefined,
    ariaCurrent: attrs.get('aria-current') || undefined,
    // Radix/shadcn/Vaul data-state — symmetric with collector
    // (snapshot-collector.ts ~line 1740). PURE ADDITIVE: undefined when
    // absent; length-cap 30 chars to mirror collector. Trim only,
    // do NOT lowercase (Radix uses camelCase like 'forceMount').
    dataState: ((): string | undefined => {
      const raw = (attrs.get('data-state') || '').trim();
      return raw.length > 0 && raw.length < 30 ? raw : undefined;
    })(),
    ariaValueText: attrs.get('aria-valuetext') || undefined,
    dataValue: attrs.get('data-value') || undefined,
    bsToggle: attrs.get('data-bs-toggle') || undefined,
    bsTarget: attrs.get('data-bs-target') || undefined,
    ariaHasPopup: attrs.get('aria-haspopup') || undefined,
    ariaActiveDescendant: attrs.get('aria-activedescendant') || undefined,
    dataRowKey: attrs.get('data-row-key') || undefined,
    href: tagName === 'a' ? attrs.get('href') || undefined : undefined,
    // Etap 1B.2 — Angular routerLink + formControlName. Symmetric with
    // snapshot-collector.ts:2492-2499 and PROBE_AT_POINT_FN. Same length
    // gates: drop pathologically long values (cap-at-source 200/80) but
    // preserve typical paths/names by slicing to 100/60. HTML attrs are
    // case-insensitive — DS decoder lowercases keys, so 'routerlink' and
    // 'formcontrolname' are the canonical lookup keys here regardless of
    // how the source HTML wrote them ('routerLink' / 'RouterLink' / etc).
    routerLink: ((): string | undefined => {
      const v = attrs.get('routerlink');
      return v && v.length > 0 && v.length < 200 ? v.slice(0, 100) : undefined;
    })(),
    formControlName: ((): string | undefined => {
      const v = attrs.get('formcontrolname');
      return v && v.length > 0 && v.length < 80 ? v.slice(0, 60) : undefined;
    })(),
    // ARIA boolean states — DS attributes are strings ('true'/'false');
    // normalise to boolean | undefined so downstream consumers don't
    // re-parse.
    ariaExpanded: parseTriState(attrs.get('aria-expanded')),
    ariaPressed: parseTriState(attrs.get('aria-pressed')),
    ariaSelected: parseTriState(attrs.get('aria-selected')),
    // ariaChecked supports 'mixed' as a third state.
    ariaChecked: parseAriaChecked(attrs.get('aria-checked')),
    required: attrs.has('required'),
    // readOnly: attribute presence + aria-readonly. Runtime fallback
    // (el.readOnly programmatic) lands in Phase 4 enrichment.
    readOnly: attrs.has('readonly') || attrs.get('aria-readonly') === 'true',
    // ariaValueNow: attribute path; native-input fallback (range/number)
    // handled by Phase 4 since it requires runtime el.value.
    ariaValueNow: parseFloatOrUndefined(attrs.get('aria-valuenow')),
    // tabIndex from attribute; runtime fallback for focusable elements
    // without explicit attr lands in Phase 4.
    tabIndex: parseTabIndex(attrs.get('tabindex')),
    hasAriaHaspopup: attrs.has('aria-haspopup'),
    bounds,
    computedZIndex,
    isPositioned: styles ? styles.position !== 'static' : undefined,
    backgroundColor: styles?.backgroundColor || undefined,
    textColor: styles?.color || undefined,
    borderRadius: styles?.borderRadius || undefined,
  };

  // iframeSource — public field on LiteElement that consumers can use
  // to detect "this node lives in an iframe". Mirrors the legacy
  // background-collector's `containerTitles: ["iframe: <url>"]` hint
  // but typed and structured. Only populated for non-main docs so
  // single-frame pages don't get noise. Survives the strip pass
  // because it's a real LiteElement field (unlike __docIndex).
  if (args.docIndex !== 0 && args.docUrl) {
    el.iframeSource = args.docUrl;
  }

  // Stash internal indexes for ancestry / shadow walks in Phase 3c.
  // Stripped before LiteSnapshot leaves the service.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any).__dsNodeIndex = args.dsNodeIndex;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any).__docIndex = args.docIndex;
  // Document URL — only stashed for non-main frames; Phase 3.5 uses it
  // to find the matching Playwright Frame for per-frame ref assignment.
  // Stripped before LiteSnapshot leaves the service alongside __docIndex.
  if (args.docUrl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).__docUrl = args.docUrl;
  }
  return el;
}

/** Parse 'true'/'false'/etc. to boolean | undefined. */
function parseTriState(v: string | undefined): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** aria-checked extra: 'mixed' state. */
function parseAriaChecked(v: string | undefined): boolean | 'mixed' | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'mixed') return 'mixed';
  return undefined;
}

function parseFloatOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * tabindex parsing — only return when present and parseable.
 * `LiteElement.tabIndex` consumers (buildAllowedSets) check for
 * `>= 0`, so we preserve negative explicit values too.
 */
function parseTabIndex(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Implicit landmark role for HTML5 sectioning tags.
 *
 * Thin wrapper around the shared LANDMARK_TAG_TO_ROLE table from
 * `./landmark.util` — that table is keyed by uppercase `Element.tagName`,
 * but the CDP path works with lowercase `nodeName` strings from
 * `DOMSnapshot.captureSnapshot`, so we uppercase before the lookup.
 *
 * Single source of truth lives in `./landmark.util`. May 2026 B6 audit
 * fix moved the `<form>` mapping into that util as well, so this
 * wrapper no longer carries a local fallback — symmetry across
 * snapshot-collector / cdp-snapshot / background-dom-collector /
 * recorder (invariant #5) is now structural rather than convention.
 */
function tagToImplicitLandmarkRole(tag: string): string | undefined {
  return LANDMARK_TAG_TO_ROLE[tag.toUpperCase()];
}

/**
 * Compute `isSensitiveInput` flag in Node from element fields already
 * mapped in Phase 3b. Mirrors the existing snapshot-collector logic
 * around `~line 1689` (SENSITIVE_AUTOCOMPLETE + name/id regex). We
 * keep the regex inline rather than imported because:
 *   - the in-page collector duplicates it inline anyway (it can't
 *     import from Node)
 *   - drift between paths is exactly what we audit in shadow mode;
 *     pulling from a shared util would HIDE drift behind one
 *     refactor that touches both files
 *
 * Privacy contract: any change to this function MUST land alongside
 * the in-page equivalent in snapshot-collector.ts. A false-negative
 * here means a password value gets `hasValue: true` reported through
 * the WS pipe — never raw, but presence-leak.
 */
function computeIsSensitiveInput(el: LiteElement): boolean {
  if (el.tag !== 'input' && el.tag !== 'textarea' && el.tag !== 'select') return false;
  if (el.type === 'password') return true;

  // Tokenise autocomplete the same way as the in-page collector
  // (HTML spec uses space-separated tokens; e.g. `current-password`).
  const autocompleteTokens = new Set(
    (el.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean),
  );
  const SENSITIVE_AUTOCOMPLETE = ['password', 'current-password', 'new-password', 'username', 'email', 'tel', 'phone'];
  if (SENSITIVE_AUTOCOMPLETE.some((s) => autocompleteTokens.has(s))) return true;

  // Name/id regex — same patterns as snapshot-collector. Two sets:
  //   credential-shaped (password / secret) → match
  //   identity-shaped (user / login / email / phone) → match
  // Combined into one regex per field to halve test count.
  const nameAttr = el.htmlName || '';
  const idAttr = el.htmlId || '';
  const SENSITIVE_NAME_RE = /password|passwd|pwd|secret|credential|user|username|login|email|phone|tel|mobile/i;
  if (SENSITIVE_NAME_RE.test(nameAttr) || SENSITIVE_NAME_RE.test(idAttr)) return true;

  return false;
}

/**
 * Framework detection from HTML attributes alone — no JS runtime
 * required. Mirrors the `if (el.hasAttribute('x-data') ...)` block in
 * snapshot-collector's `frameworkClickable` IIFE. Phase 4 will run a
 * second pass to detect JS-runtime frameworks (React fiber / Vue /
 * Angular / Svelte / jQuery) and OVERRIDE the result here when it
 * finds a stronger signal — runtime presence wins over attribute hint
 * because a `<div hx-get="..." onClick={reactHandler}>` is more
 * authoritatively React than HTMX from a behavioural standpoint.
 *
 * Symmetry: the order and exact regex shapes match the existing
 * collector. Drift here means buildAllowedSets behaves differently
 * between CDP and evaluate paths — caught by shadow-mode diff in
 * Week 3, but cheaper to get right now.
 */
function detectAttributeBasedFramework(attrs: DecodedAttrs): LiteElement['frameworkClickable'] {
  // Alpine: x-data root marker, x-on:click directive, @click shorthand.
  if (attrs.has('x-data') || attrs.has('x-on:click') || attrs.has('@click')) {
    return 'alpine';
  }
  // HTMX: hx-* and data-hx-* directives.
  if (
    attrs.has('hx-get') || attrs.has('hx-post') || attrs.has('hx-put')
    || attrs.has('hx-delete') || attrs.has('hx-patch')
    || attrs.has('data-hx-get') || attrs.has('data-hx-post')
  ) {
    return 'htmx';
  }
  // Stimulus: `data-action="event->controller#method"` shape.
  const dataAction = attrs.get('data-action');
  if (dataAction && /\w+->\w+#\w+/.test(dataAction)) {
    return 'stimulus';
  }
  // Knockout: data-bind with click/event/submit/value.
  const dataBind = attrs.get('data-bind');
  if (dataBind && /click\s*:|event\s*:|submit\s*:|value\s*:/.test(dataBind)) {
    return 'knockout';
  }
  // Qwik: `on:click$` / `onClick$` style attributes (compiled).
  // Iterate attribute keys — DecodedAttrs already lowercased names.
  for (const name of attrs.keys()) {
    // Qwik's compiled output uses `on:`/`on$`/`onCamelCase$`. Browser
    // normalises attribute names to lowercase, so we lose the
    // mixed-case `onClick$` form here — but `on:click` and `on$click`
    // survive and are the more common Qwik output. Acceptable
    // documented limitation.
    if (/^on[:$]/.test(name)) return 'qwik';
  }
  return undefined;
}

export class CdpSnapshotService {
  /**
   * Collect a `LiteSnapshot` via the CDP hybrid pipeline.
   *
   * Throws on any unrecoverable error — the SnapshotRouter catches and
   * falls back to `SnapshotCollector.collect`. The router NEVER hides
   * the error from logs; it is the single place that decides what to
   * do about it.
   */
  static async collect(
    page: Page,
    options: CdpSnapshotOptions = {},
  ): Promise<LiteSnapshot> {
    const startedAt = Date.now();
    const diagId = options.diagId;

    // Phase 0: acquire CDP session.
    // - existingCdpSession path is intentionally first — when caller
    //   provides a session (preview piggyback) we MUST not open a new
    //   one (would race with screencast).
    // - new-session path opens a session and detaches in `finally` so
    //   the browser-side handle is released; missing this is the
    //   classic "CDP sessions accumulate, browser slows down" leak.
    const cdp = options.existingCdpSession ?? await page.context().newCDPSession(page);
    const ownsCdpSession = options.existingCdpSession === undefined;
    // Count of elements stamped by Phase 1.5 — drives the finally cleanup so we
    // only pay the untag round-trip when something was actually marked.
    let fwClickTagged = 0;

    try {
      // Phase 1: optional stability wait. Skipped when the caller
      // already settled the page (e.g. preview-session.waitForDOMStability).
      // TODO Task 2.2: import VisualStability and call waitForStable
      // when !skipStabilityWait. Until then, behaviour matches the
      // current SnapshotCollector skip-path.

      // Phase 2: parallel CDP requests. Both calls hit the same WS
      // pipe but Chrome processes them concurrently — wall time is
      // max(DS, AX), not sum. This is the only point where we eat
      // the CDP round-trip cost — measure it precisely.
      // Phase 1.5: stamp framework-clickable elements (React fiber / Vue /
      // Angular runtime click handlers) with FRAMEWORK_CLICK_MARKER BEFORE
      // captureSnapshot, so isInteractiveNodeTier1 promotes them to Tier-1 and
      // they survive the Tier-2 cap (restores collector symmetry, invariant
      // #5). Best-effort: a failure here must never block the snapshot, so it
      // swallows its own errors and just returns 0 (= pre-fix behaviour). Runs
      // via page.evaluate (Playwright managed channel) — NOT a CDP-session
      // reuse, so invariant #3 (screencast) is unaffected.
      if (PROMOTE_FRAMEWORK_CLICKABLE) {
        fwClickTagged = await this.tagFrameworkClickable(page, diagId);
      }

      const cdpStart = Date.now();
      const raw = await this.fetchRawBundle(cdp, diagId);
      const cdpParallelMs = Date.now() - cdpStart;
      // Per-call latencies stashed by fetchRawBundle for observability.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsMs = (raw.domSnapshot as any).__dsMs ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const axMs = (raw as any).__axMs ?? 0;

      // Phase 3: Node-side mapping (DOMSnapshot + AXTree → LiteElement[]).
      // Pure CPU work in Node — no further round trips. Most of the
      // existing `snapshot-collector.ts` logic that derives fields
      // from raw DOM (text walks, ancestor chains, parent class
      // tokens, container titles, modal heuristics) lives here.
      // Forensic collector — populated only when caller opted in AND
      // we're running in a dev environment. The JSONL alone is ~200KB
      // per snapshot, but writeForensicArtifacts also dumps the raw DS
      // payload (~1.5MB) and live HTML (~1MB). A handful of those per
      // session per user fills production disk inside a week, so prod
      // never writes them. Local dev gets the full set for debugging.
      //
      // Caller-side gating (`forensicRejections: true` only on
      // user-initiated find_button / apply_prelint) is the FIRST line
      // of defense; this env check is the SECOND, in case a future
      // caller forgets the auditTrigger gate.
      const forensic: ForensicCollector | undefined = (options.forensicRejections && isDevelopment)
        ? { diagId: diagId ?? 'unknown', startedAt, stages: [] }
        : undefined;

      const mappingStart = Date.now();
      const elements = this.mapToLiteElements(raw, forensic);
      const mappingMs = Date.now() - mappingStart;

      // Phase 3.5: assign data-agent-ref attributes via single
      // page.evaluate. Required BEFORE Phase 4 because Phase 4 queries
      // elements by `[data-agent-ref="…"]` selectors. Reuses the
      // existing window.__agentRefCounter + __agentFingerprintMap so
      // refs are STABLE across React re-renders and snapshots — the
      // same invariant `evidence.lastSuccessRef` depends on. If we
      // generated fresh refs on every CDP collect, the evidence
      // shortcut would break for every step on every replay.
      const refAssignStart = Date.now();
      await this.assignAgentRefs(page, elements);
      // Defense: assignAgentRefs's internal compaction operates on a
      // per-document sub-array (`byDoc.get(0)`) which, despite the
      // comment in that method, is NOT the same Array reference as
      // `elements` when `__docIndex` is absent (the common single-doc
      // case). The sub-array's length gets truncated, but `elements`
      // itself keeps every entry — including ones whose `findElement()`
      // returned null and got `ref: ''`. Without this filter those
      // empty-ref elements survive into the LiteSnapshot, where they
      // confuse downstream consumers (`new Map(elements.map(e =>
      // [e.ref, e]))` collapses them to a single key, identity rescue
      // can match them to recorded fingerprints with empty href, etc).
      // Surfaced via shadow-mode divergence logs (`onlyInCdp: ["", ...]`).
      // Keep filter here even when the per-doc compactor works — it's
      // O(n) and idempotent on already-clean arrays.
      const beforeFilter = elements.length;
      const refAssignRejected: ForensicRejection[] = [];
      // Sample of elements that DID get a ref — answers "did my target
      // survive ref assignment?". Bias toward identity-rich entries.
      const refAssignPassed: ForensicNode[] | undefined = forensic ? [] : undefined;
      if (refAssignPassed) {
        for (const el of elements) {
          if (!el.ref) continue;
          if (refAssignPassed.length >= FORENSIC_PASSED_SAMPLE_SIZE) break;
          const node = liteElementToForensic(el);
          const hasIdentity = !!(node.attrs.id || node.attrs['data-testid'] || node.attrs['aria-label'] || node.attrs.role || node.text);
          if (!hasIdentity && refAssignPassed.length >= Math.floor(FORENSIC_PASSED_SAMPLE_SIZE / 2)) continue;
          refAssignPassed.push(node);
        }
      }
      for (let i = elements.length - 1; i >= 0; i--) {
        if (!elements[i].ref) {
          if (forensic) {
            const el = elements[i];
            // Classify WHY findElement returned null so dropped-element
            // pattern analysis ("are most drops descriptor-poor anonymous
            // divs?" vs "is it bbox-mismatch on a specific class?") is
            // possible with a single jq group_by.
            const hasId = !!el.id;
            const hasTestId = !!el.testIdAttr;
            const hasName = !!el.htmlName;
            const hasAriaLabel = !!el.ariaLabel;
            const hasBbox = !!(el.bounds && el.bounds.width > 0 && el.bounds.height > 0);
            let likelyCause: string;
            if (!hasId && !hasTestId && !hasName && !hasAriaLabel && !hasBbox) {
              likelyCause = 'no-identity-no-bbox';
            } else if (!hasBbox) {
              likelyCause = 'noBbox.descriptorFailedToMatch';
            } else if (!hasId && !hasTestId && (el.tag === 'div' || el.tag === 'span')) {
              likelyCause = 'genericTagBboxCollision';
            } else {
              likelyCause = 'bboxMismatchOrPageMutated';
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inPageDiag = (el as any).__refAssignDiag;
            refAssignRejected.push({
              ...liteElementToForensic(el),
              reason: 'refAssign.findElementReturnedNull',
              diag: {
                likelyCause,
                hasId, hasTestId, hasName, hasAriaLabel, hasBbox,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                docIdx: (el as any).__docIndex,
                // In-page diagnostics from runRefAssignmentInFrame.
                // These are the SMOKING-GUN fields: walkUp shows the
                // exact px-drift between DS bbox and live bbox per
                // ancestor; computedTransform shows whether the page
                // is using CSS transforms (the #1 cause of bbox drift);
                // atPoint shows what elementFromPoint actually returned
                // (separates "overlay collision" from "page mutated").
                ...(inPageDiag ? {
                  stageHit: inPageDiag.stageHit,
                  atPoint: inPageDiag.atPoint,
                  walkUp: inPageDiag.walkUp?.slice(0, 8) ?? [],
                  descendTried: inPageDiag.descendTried,
                  descendFound: inPageDiag.descendFound,
                  computedTransform: inPageDiag.computedTransform,
                  computedOpacity: inPageDiag.computedOpacity,
                  computedVisibility: inPageDiag.computedVisibility,
                } : {}),
              },
            });
          }
          elements.splice(i, 1);
        }
      }
      const droppedEmptyRefs = beforeFilter - elements.length;
      if (droppedEmptyRefs > 0) {
        logger.debug('[CDP_SNAPSHOT] Dropped elements with empty ref after assignAgentRefs', {
          diagId: options.diagId,
          dropped: droppedEmptyRefs,
          remaining: elements.length,
        });
      }
      if (forensic) {
        // Aggregate likelyCause distribution so the reader sees the
        // dominant failure mode without grouping by hand.
        const causeCounts: Record<string, number> = {};
        for (const r of refAssignRejected) {
          const c = r.diag?.likelyCause ?? 'unknown';
          causeCounts[c] = (causeCounts[c] || 0) + 1;
        }
        forensic.stages.push({
          stage: 'refAssign',
          inputCount: beforeFilter,
          passedCount: elements.length,
          rejected: refAssignRejected,
          passedSample: refAssignPassed,
          durationMs: Date.now() - refAssignStart,
          extra: { causeCounts },
        });
      }

      // DEFENSE-IN-DEPTH against ref duplicates (May 2026 bi.group fix).
      //
      // The `findElement` last-resort branch that produced duplicates is
      // now closed (returns null instead of the overlay node). But the
      // resolver's correctness depends on a hard invariant: each `ref`
      // identifies exactly ONE LiteElement per snapshot. A single future
      // regression upstream (cache key collision, new overlay-detection
      // edge case, framework re-render race) could re-introduce dupes —
      // and the resolver would silently click the wrong element again.
      //
      // Strategy: scan post-filter elements, group by ref, drop entries
      // beyond the first for any ref that appears > 1 times. We drop
      // rather than reassign because:
      //   - reassigning would break `evidence.lastSuccessRef` stability
      //     for legitimately-resolved past steps;
      //   - the first occurrence is usually the correct one (it landed
      //     in the cache from a prior, uncontested snapshot).
      // Logged as a warn so any non-zero dropCount in prod surfaces as
      // a real regression we need to chase.
      const beforeDedup = elements.length;
      const dedupStart = forensic ? Date.now() : 0;
      const dupSamples: Array<{ ref: string; tag: string; text: string }> = [];
      const dedupRejected: ForensicRejection[] = [];
      // QUALITY-AWARE keep-winner (2026-06): when two elements share a ref,
      // the previous "keep the first in array order" rule let a zero-bbox
      // noBounds-rescue node (DS had no layout row for it — typically a
      // decorative/offscreen glyph) win over a fully-rendered element. The
      // doculite incident: a hidden iframe's noBounds <svg> at array index
      // 0 evicted the visible password <input>. Array position is NOT a
      // correctness signal. `dedupeElementsByRef` scores each entry and
      // keeps the highest (real bbox > noBounds/zero-area; ties → earliest
      // index). The cross-frame `d{docIdx}_` prefix above makes real
      // collisions rare now; this stays as defense-in-depth for same-frame
      // collisions (cache-key clash, overlay re-render race).
      const dedupLosers = dedupeElementsByRef(elements);
      for (const el of dedupLosers) {
        const ref = el.ref ?? '';
        if (dupSamples.length < 5) {
          dupSamples.push({
            ref,
            tag: el.tag,
            text: (el.text || el.name || '').slice(0, 30),
          });
        }
        if (forensic) {
          dedupRejected.push({
            ...liteElementToForensic(el),
            reason: 'dedup.duplicateRef',
            diag: {
              collidedWithRef: ref,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              docIdx: (el as any).__docIndex,
            },
          });
        }
      }
      const droppedDupes = beforeDedup - elements.length;
      if (forensic) {
        // Aggregate which refs caused the most collisions — surfaces
        // the e24×46 "overlay collision" pattern at a glance.
        const collisionCounts: Record<string, number> = {};
        for (const r of dedupRejected) {
          const ref = r.diag?.collidedWithRef as string | undefined;
          if (ref) collisionCounts[ref] = (collisionCounts[ref] || 0) + 1;
        }
        forensic.stages.push({
          stage: 'dedup',
          inputCount: beforeDedup,
          passedCount: elements.length,
          rejected: dedupRejected,
          durationMs: Date.now() - dedupStart,
          extra: { collisionCounts },
        });
      }
      if (droppedDupes > 0) {
        logger.warn('[CDP_SNAPSHOT] Dropped duplicate-ref elements after assignAgentRefs', {
          diagId: options.diagId,
          dropped: droppedDupes,
          beforeDedup,
          afterDedup: elements.length,
          samples: dupSamples,
        });
      }
      const refAssignMs = Date.now() - refAssignStart;

      // Phase 3c-Node: ancestry walks over DS parentIndex (no extra
      // round-trip). Populates parentRefChain, containerTitles,
      // nearestLandmark, isInsideShadowDOM/depth/slotName. These rely
      // entirely on DS data + refs already assigned in Phase 3.5.
      this.populateAncestryFieldsFromDs(elements, raw);

      // Phase 4: batched runtime enrichment (single page.evaluate).
      // Per audit, the unavoidable EVAL fields are:
      //   frameworkClickable / value / hasValue / checked /
      //   isContentEditable / invalid / hasOnclick / runtime fallbacks
      //   for disabled & readOnly.
      // One evaluate over all refs keeps it ~200-500ms on 11k DOM.
      const evalStart = Date.now();
      await this.enrichWithRuntimeFields(page, elements);
      const runtimeEvaluateMs = Date.now() - evalStart;

      // Phase 3c-Eval: DOM-walking fields that DS+Node CANNOT compute
      // cheaply (firstTextFragment text-node walks, isIconButton
      // cloneNode trick, labelText label[for=]/wrapping resolution,
      // nearestRowText sibling cell concat). Single batched evaluate.
      // Runs AFTER Phase 4 so frameworkClickable runtime override
      // already settled — this evaluate doesn't touch that field.
      const ancestryEvalStart = Date.now();
      await this.enrichWithDomWalkFields(page, elements);
      const ancestryEvalMs = Date.now() - ancestryEvalStart;
      logger.debug('[CDP_SNAPSHOT] Ancestry-eval phase', {
        diagId,
        ancestryEvalMs,
        elementCount: elements.length,
      });
      // Roll Phase 3.5 cost into the same bucket as Phase 4 for the
      // public timings — both are page.evaluate round-trips, distinct
      // from CDP. Adding a third bucket would require LiteSnapshot
      // type change for marginal observability gain.
      void refAssignMs; // tracked separately in debug log only
      logger.debug('[CDP_SNAPSHOT] Ref assignment phase', {
        diagId,
        refAssignMs,
        elementCount: elements.length,
      });

      // Phase 5: modal/active-overlay detection.
      // Same 4-rule heuristic as today, but applied in Node post-process
      // because all signals (role, aria-modal, dialog[open], z-index,
      // bbox coverage, class regex) are already in `raw` + `elements`.
      // This phase also writes `LiteSnapshot.activeModalRef` and the
      // per-element `isInsideActiveModal` flag.
      const modalStart = Date.now();
      let activeModalRef = this.detectModalsInPlace(elements, raw);
      const modalDetectionMs = Date.now() - modalStart;

      // Phase 5b: overlay state — transientState + obstacleFacts +
      // Layer 2 modal positional fallback. Single batched evaluate.
      // Runs AFTER Layer 1 modal so we can pass the already-detected
      // ref and skip Layer 2 work when iron-clad signals already won.
      const overlayStart = Date.now();
      const overlayState = await this.enrichWithOverlayState(page, activeModalRef);
      const overlayStateMs = Date.now() - overlayStart;
      // Promotion order (most-trusted signal wins):
      //   1. Phase 5 Node-side bestRef (modal IS in interactive set —
      //      already in `activeModalRef`).
      //   2. Phase 5b layer1ModalRef rescue (modal exists in DS but
      //      wasn't interactive; evaluate found + assigned ref).
      //   3. Phase 5b layer2ModalRef positional fallback.
      //
      // Iron-clad ARIA always beats positional heuristics — so layer1
      // rescue is checked BEFORE layer2 promotion.
      if (!activeModalRef && overlayState.layer1ModalRef) {
        activeModalRef = overlayState.layer1ModalRef;
      }
      if (!activeModalRef && overlayState.layer2ModalRef) {
        activeModalRef = overlayState.layer2ModalRef;
      }

      // Phase 6: assemble final LiteSnapshot.
      const totalMs = Date.now() - startedAt;
      const phaseTimings: CdpPhaseTimings = {
        domSnapshotMs: dsMs,
        axTreeMs: axMs,
        cdpParallelMs,
        mappingMs,
        runtimeEvaluateMs,
        modalDetectionMs,
        overlayStateMs,
        totalMs,
      };

      // Strip internal stash (`__dsNodeIndex`, `__docIndex`, `__docUrl`)
      // before returning — they were used by Phase 3c-Node, Phase 5
      // walks, and Phase 3.5 per-frame ref assignment, and must not
      // leak into consumers (LiteElement type doesn't expose them,
      // but they exist on the object via `as any` casts).
      // Cleanup is in-place: same array, no allocation. Note:
      // `__refAssignDiag` / `__refAssignContext` are NOT deleted here —
      // they're needed by the forensic emit BELOW. Deleted in a second
      // pass after the emit.
      for (const el of elements) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__dsNodeIndex;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__docIndex;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__docUrl;
      }

      const snapshot: LiteSnapshot = {
        url: page.url(),
        title: await page.title().catch(() => ''),
        elements,
        timestamp: Date.now(),
        activeModalRef,
        // viewport intentionally read from page.viewportSize() — same as
        // the evaluate path. Kept here so buildAllowedSets gets accurate
        // modal-coverage ratio without falling back to bbox high-water
        // mark heuristic.
        viewport: page.viewportSize() ?? undefined,
        // Phase 5b artefacts. `transientState` always present (defaults
        // to `{isTransient: false}` when nothing matched) so consumers
        // can rely on the field's existence; `obstacleFacts` undefined
        // when empty (matches evaluate-path semantics).
        transientState: overlayState.transientState ?? { isTransient: false },
        obstacleFacts: overlayState.obstacleFacts,
      };

      // Stash phase timings on the snapshot for offline analysis.
      // Same pattern as snapshot-collector's `__debugStats`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (snapshot as any).__cdpPhaseTimings = phaseTimings;

      // Final summary at DEBUG level — every successful CDP snapshot
      // would otherwise emit TWO info logs (`[CDP_SNAPSHOT] Collected`
      // here + `[SNAPSHOT_ROUTER] Collected` upstream). On preview-tick
      // (~2 calls/sec) that's 7000+ lines/hour per worker — log
      // aggregation choking. The router-level log already surfaces
      // `source: 'cdp'` + `durationMs` for operators; this richer
      // payload (timings/shape/runtime stats) lives at debug for
      // post-hoc deep dives. Bump to info temporarily when investigating
      // a specific incident via per-process LOG_LEVEL=debug. Includes:
      //   - timings: per-phase + total wall-clock
      //   - shape coverage: counts of populated load-bearing fields
      //     (transientState/obstacleFacts/activeModalRef + runtime fields)
      //   - sample of populated runtime fields so we can spot regressions
      //     at-a-glance (e.g., `frameworkClickable: 0/450` → all missing)
      const runtimeStats = elements.reduce(
        (acc, el) => {
          if (el.frameworkClickable !== undefined) acc.frameworkClickable++;
          if (el.checked !== undefined) acc.checked++;
          if (el.hasValue !== undefined) acc.hasValue++;
          if (el.isContentEditable === true) acc.contentEditable++;
          if (el.invalid === true) acc.invalid++;
          if (el.firstTextFragment) acc.withText++;
          return acc;
        },
        { frameworkClickable: 0, checked: 0, hasValue: 0, contentEditable: 0, invalid: 0, withText: 0 },
      );

      // Forensic JSONL — best-effort, must not affect collect timing
      // surface beyond the small per-stage push work already done.
      if (forensic) {
        // Compose `summary` header — context for everything that follows.
        // Lets the reader answer "what page / which frame / how big a DOM"
        // without grepping other log files.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dsAny = raw.domSnapshot as any;
        // Page context captured in the refAssign evaluate — has scroll,
        // DPR, document readiness, DOM mutation count. Stored on the
        // outer `elements` array (not on any specific element, which
        // could be filter-dropped) — see assignAgentRefs for the
        // attach site.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pageContext = (elements as any).__refAssignContext;
        forensic.summary = {
          url: snapshot.url.slice(0, 200),
          title: snapshot.title?.slice(0, 100),
          viewport: snapshot.viewport,
          documents: Array.isArray(dsAny?.documents) ? dsAny.documents.length : 0,
          activeModalRef: snapshot.activeModalRef,
          isTransient: snapshot.transientState?.isTransient === true,
          obstacleCount: snapshot.obstacleFacts?.length ?? 0,
          totalMs,
          phases: phaseTimings,
          runtimeFieldCoverage: runtimeStats,
          ...(pageContext ? {
            scroll: { x: pageContext.scrollX, y: pageContext.scrollY },
            devicePixelRatio: pageContext.devicePixelRatio,
            documentReady: pageContext.documentReady,
            domMutationsDuringSnapshot: pageContext.domMutationsDuringSnapshot,
            evalViewport: { w: pageContext.viewportW, h: pageContext.viewportH },
          } : {}),
        };

        // `final` — every surviving element in compact form. Lets you
        // jq-search by tag/attrs/text in the same file as rejections.
        forensic.final = {
          elementCount: elements.length,
          elements: elements.slice(0, FORENSIC_FINAL_ELEMENT_CAP).map(liteElementToForensic),
          extra: {
            refsUnique: new Set(elements.map((e) => e.ref).filter(Boolean)).size,
            elementsWithoutRef: elements.filter((e) => !e.ref).length,
            elementsWithEmptyBbox: elements.filter((e) => !e.bounds || (e.bounds.width === 0 && e.bounds.height === 0)).length,
          },
        };

        writeForensicJsonl(forensic);

        // Diagnostic deep-dump (May 2026, bi.group close-X investigation).
        // When forensic mode is on, also dump the RAW DS payload and the
        // live page HTML to disk alongside the JSONL. This is the last
        // line of defense for "target node is missing from DS entirely"
        // bugs — without these dumps we can only see what survived our
        // pipeline, not what CDP actually returned.
        //
        // Format: same basename as the JSONL, sibling files with
        // suffixes `_ds.json` and `_html.html`. Fire-and-forget; large
        // payloads (~5-10MB on dense pages) — write off the critical
        // path so the snapshot return is not blocked.
        //
        // To opt out per-snapshot, the caller can avoid setting
        // `forensicRejections`. There is no separate flag — these
        // dumps share the same trigger as the JSONL because they're
        // only useful TOGETHER (the JSONL tells you what was dropped,
        // the DS/HTML tell you what was even there to begin with).
        writeForensicArtifacts(forensic, raw.domSnapshot, page).catch(() => { /* swallow */ });
      }

      // Second cleanup pass — remove forensic-only properties from
      // surviving elements so they don't leak into LiteSnapshot
      // consumers (resolver, locator-plan-builder). Deferred from the
      // first cleanup pass because forensic emit above needs to read
      // them.
      for (const el of elements) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__refAssignDiag;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__noBoundsRescued;
      }
      // Array-level property cleanup (different scope from element-level).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (elements as any).__refAssignContext;

      logger.debug('[CDP_SNAPSHOT] Collected', {
        diagId,
        url: snapshot.url.slice(0, 100),
        elementCount: elements.length,
        // Phase timings — eyeball wall-clock vs evaluate path's typical
        // 12-16s on dense pages. CDP target on the same page is ~1.5s.
        timings: phaseTimings,
        // Shape contract — these MUST be populated for ObserverAgent /
        // pruner / element-resolver to behave correctly. Zeros here
        // signal a regression in Phase 0 enrichment.
        shape: {
          hasTransientState: snapshot.transientState !== undefined,
          isTransient: snapshot.transientState?.isTransient === true,
          obstacleCount: snapshot.obstacleFacts?.length ?? 0,
          hasActiveModal: snapshot.activeModalRef !== undefined,
          activeModalRef: snapshot.activeModalRef,
        },
        // Runtime field coverage — counts how many elements got Phase 4
        // enrichment. `frameworkClickable: 0` on a React/Vue page is a
        // smoking gun (Phase 4 evaluate failed silently or the framework
        // detector regressed).
        runtime: runtimeStats,
      });

      return snapshot;
    } finally {
      // Remove the framework-click markers stamped pre-capture so they never
      // persist on the live (screencast) DOM under the page-under-test. Runs
      // even on the error path; skipped when nothing was tagged so a page with
      // no framework-clickable elements pays no extra round-trip. Best-effort
      // (page may already be gone).
      if (PROMOTE_FRAMEWORK_CLICKABLE && fwClickTagged > 0) {
        await this.untagFrameworkClickable(page).catch(() => { /* page gone — nothing to clean */ });
      }

      // Detach only sessions we opened — a caller-supplied session
      // belongs to them and we must not pull it out from under them.
      if (ownsCdpSession) {
        try {
          await cdp.detach();
        } catch {
          // Detach errors are non-actionable — most commonly happen
          // when the page already closed mid-collect. Swallow to keep
          // the original error surface visible above this finally.
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase implementations — stubbed for the skeleton.
  // Each TODO references the audit (01-fields-audit.md) for the
  // exact source mapping each field needs.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Phase 2 — parallel CDP fetches.
   *
   * Issues two CDP commands in parallel and assembles the raw bundle.
   * AXTree is treated as best-effort: if Chromium build doesn't
   * expose the Accessibility domain, we warn once and proceed with
   * DOMSnapshot only — downstream mapping falls back to manual
   * `computeRole` for implicit ARIA, same logic as today.
   *
   * Failure routing (all throw `CdpSnapshotError` for router fallback):
   *   - DS rejected: page_gone / cdp_send_failed
   *   - DS payload >20MB: cdp_payload_too_large
   *   - DS malformed (no documents[]): malformed_response
   *   - AX rejected: ax_domain_unavailable (warn-once, fall through
   *     with empty axTree — NOT thrown; mapping handles)
   */
  /**
   * Phase 1.5 — stamp framework-clickable elements with FRAMEWORK_CLICK_MARKER
   * before DOMSnapshot.captureSnapshot. Mirrors the evaluate-path collector's
   * "Tier 1: Framework event bindings" runtime detection (snapshot-collector.ts)
   * so the CDP path stops being framework-blind (invariant #5).
   *
   * Scope: ONLY runtime frameworks (React fiber / Vue instance+vnode / Angular
   * context) whose handlers live in JS, not attributes — attribute frameworks
   * (Alpine/HTMX/Stimulus/Knockout/Qwik) are already Tier-1 via attribute checks
   * in isInteractiveNodeTier1. Native tags / onclick / href / tabindex are
   * skipped (already Tier-1, keeps the marker set tight).
   *
   * A CONFIRMED handler is required (no "fiber present → assume clickable"
   * fallback the evaluate path's doc-order-capped secondary pass can afford),
   * because Tier-1 here is effectively uncapped — over-tagging would balloon
   * the list. Measured on real React pages: a few dozen elements.
   *
   * Best-effort: returns the tagged count; swallows all errors (a failed
   * evaluate just restores pre-fix behaviour — never blocks the snapshot).
   */
  private static async tagFrameworkClickable(page: Page, diagId?: string): Promise<number> {
    try {
      const count = await page.evaluate((mark: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        if (!doc || !doc.body) return 0;
        const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SUMMARY', 'LABEL', 'DETAILS']);
        const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'switch', 'checkbox', 'radio']);
        let tagged = 0;
        const els = doc.querySelectorAll('*');
        // Perf guard: above this DOM size the per-element React-key scan
        // (Object.keys on every non-native element) erodes the CDP path's whole
        // reason for existing — speed. Skip promotion on pathologically large
        // pages; they're already lossy under the Tier-2 / MAX_TOTAL_ELEMENTS cap,
        // so a missed framework-clickable wrapper is the rare tail there. Return
        // -1 so the caller logs the skip (not a silent cap).
        if (els.length > 5000) return -1;
        for (let i = 0; i < els.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const el = els[i] as any;
          // Skip elements already Tier-1 via attributes — tagging adds nothing.
          if (NATIVE.has(el.tagName)) continue;
          if (el.hasAttribute('onclick') || el.hasAttribute('href') || el.hasAttribute('tabindex')) continue;

          let clickable = false;
          // React — handler lives in the props bag (__reactProps$<id>).
          try {
            const keys = Object.keys(el);
            for (let k = 0; k < keys.length; k++) {
              const key = keys[k];
              if (key.charCodeAt(0) === 95 && key.indexOf('__reactProps$') === 0) {
                const p = el[key];
                if (p && (p.onClick || p.onChange || p.onMouseDown)) clickable = true;
                break;
              }
            }
          } catch { /* hostile getter — ignore */ }
          // Vue 2 — $listeners; Vue 3 — vnode.props.
          if (!clickable && el.__vue__) {
            const ls = el.__vue__.$listeners || {};
            if (ls.click || ls.input || ls.change) clickable = true;
          }
          if (!clickable && el.__vueParentComponent) {
            const vnode = el.__vueParentComponent.vnode;
            const vp = vnode && vnode.props;
            if (vp && (vp.onClick || vp.onInput || vp.onChange)) clickable = true;
          }
          // Angular — context marker + an interactive signal.
          if (!clickable && (el.__ngContext__ || el._ngHost)) {
            const role = (el.getAttribute('role') || '').toLowerCase();
            const cls = (el.getAttribute('class') || '').toLowerCase();
            if (INTERACTIVE_ROLES.has(role) || /btn|button|click|link/.test(cls)) clickable = true;
          }

          if (clickable) { el.setAttribute(mark, '1'); tagged++; }
        }
        return tagged;
      }, FRAMEWORK_CLICK_MARKER);
      if (count === -1) {
        // Perf guard tripped — DOM too large; promotion skipped this collect.
        logger.debug('[CDP_SNAPSHOT] framework-clickable promotion skipped — DOM too large', { diagId });
        return 0;
      }
      if (count > 0) {
        logger.debug('[CDP_SNAPSHOT] framework-clickable promotion stamped elements', { diagId, count });
      }
      return count;
    } catch (err) {
      logger.debug('[CDP_SNAPSHOT] tagFrameworkClickable failed (non-fatal)', {
        diagId, error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /** Remove every FRAMEWORK_CLICK_MARKER stamped by tagFrameworkClickable. */
  private static async untagFrameworkClickable(page: Page): Promise<void> {
    await page.evaluate((mark: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      if (!doc) return;
      const els = doc.querySelectorAll('[' + mark + ']');
      for (let i = 0; i < els.length; i++) els[i].removeAttribute(mark);
    }, FRAMEWORK_CLICK_MARKER);
  }

  private static async fetchRawBundle(cdp: CDPSession, diagId?: string): Promise<RawCdpBundle> {
    const dsStart = Date.now();
    const axStart = Date.now();
    let dsMs = 0;
    let axMs = 0;

    // Fire both in parallel. We track per-call latency separately
    // even though they're concurrent — useful when AX domain is slow
    // and DS finished fast (or vice versa); the wall-clock max of
    // the two is the real cost, but per-call detail catches
    // pathological skew (e.g. AX hung at 4s while DS took 300ms).
    const dsPromise = cdp
      .send('DOMSnapshot.captureSnapshot', {
        computedStyles: [...REQUESTED_COMPUTED_STYLES],
        includeDOMRects: true,
        includePaintOrder: true,
      })
      .then((res) => {
        dsMs = Date.now() - dsStart;
        return res;
      });

    const axPromise = cdp
      .send('Accessibility.getFullAXTree')
      .then((res) => {
        axMs = Date.now() - axStart;
        return res;
      })
      .catch((err) => {
        axMs = Date.now() - axStart;
        // Warn-once per Chromium build. We don't have a build-id
        // available here cheaply; use the error message as the dedup
        // key — same Chromium emits the same string. Imperfect but
        // OK for an info-level warning.
        const key = String(err?.message ?? err).slice(0, 80);
        if (!axDomainWarnedFor.has(key)) {
          axDomainWarnedFor.add(key);
          logger.warn('[CDP_SNAPSHOT] Accessibility domain unavailable, falling back to DS-only mapping', {
            diagId,
            error: key,
          });
        }
        // Return an empty-ish AXTree shape. Mapping checks for
        // `nodes?.length` before using it; missing tree means
        // computeRole fallback per-element.
        return { nodes: [] };
      });

    let domSnapshot: unknown;
    let axTree: unknown;
    try {
      [domSnapshot, axTree] = await Promise.all([dsPromise, axPromise]);
    } catch (err) {
      // DS rejected — Promise.all rejects on first reject. AX is
      // already wrapped in `.catch` above, so this branch is always
      // a DS failure. Categorise common causes for metric grouping.
      const msg = err instanceof Error ? err.message : String(err);
      const kind: CdpSnapshotFailureKind = /no.+document|target.+closed|frame.+detached/i.test(msg)
        ? 'page_gone'
        : 'cdp_send_failed';
      throw new CdpSnapshotError(kind, `DOMSnapshot.captureSnapshot failed: ${msg}`, err);
    }

    // Sanity-check the DS payload before doing anything with it.
    // Stringify cost is one-time and acceptable — we'd be doing it
    // anyway during mapping. Catches: oversized payloads, missing
    // documents array (Chromium edge case on partially-loaded pages).
    if (!domSnapshot || typeof domSnapshot !== 'object') {
      throw new CdpSnapshotError('malformed_response', 'DOMSnapshot returned non-object response');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dsAny = domSnapshot as any;
    if (!Array.isArray(dsAny.documents) || dsAny.documents.length === 0) {
      throw new CdpSnapshotError(
        'malformed_response',
        `DOMSnapshot has no documents (got ${typeof dsAny.documents})`,
      );
    }

    // Approximate payload size. `Buffer.byteLength(JSON.stringify(...))`
    // gives the actual UTF-8 byte length (vs `.length` which counts
    // UTF-16 code units and undercounts non-ASCII strings). Same JSON
    // pass either way — but the byte count is the metric we actually
    // compare against the byte-denominated limit.
    const approxBytes = Buffer.byteLength(JSON.stringify(domSnapshot), 'utf8');
    if (approxBytes > DOM_SNAPSHOT_PAYLOAD_LIMIT_BYTES) {
      throw new CdpSnapshotError(
        'cdp_payload_too_large',
        `DOMSnapshot payload ${(approxBytes / 1024 / 1024).toFixed(1)}MB exceeds ${
          DOM_SNAPSHOT_PAYLOAD_LIMIT_BYTES / 1024 / 1024
        }MB limit`,
      );
    }

    // Pin per-call timings on the bundle so the caller can include
    // them in CdpPhaseTimings. We pass via mutation rather than a
    // separate return value to keep the public bundle shape stable
    // for tests / mock consumers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsAny as any).__dsMs = dsMs;
    return {
      domSnapshot: dsAny,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      axTree: axTree as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __axMs: axMs,
    } as unknown as RawCdpBundle;
  }

  /**
   * Phase 3 — DOMSnapshot + AXTree → LiteElement[] mapping.
   *
   * Sequenced sub-phases:
   *   3a. Build string-table accessor + AX-by-backendNodeId map
   *   3b. Walk DS nodes, filter to interactive, build candidate list
   *   3c. Per-candidate: attributes / styles / bounds / AX role + name
   *
   * Ref assignment (data-agent-ref writes) is intentionally a SEPARATE
   * phase (3.5) handled by `assignAgentRefs` — must run AFTER mapping
   * (we need to know which nodes are interactive) and BEFORE the
   * runtime enrichment (Phase 4) which queries elements via
   * `[data-agent-ref="…"]`.
   *
   * Postprocess fields requiring parent walks (parentRefChain,
   * containerTitles, isInsideShadowDOM, etc.) handled by Phase 3c
   * once refs are assigned — see `populateAncestryFields`.
   */
  private static mapToLiteElements(raw: RawCdpBundle, forensic?: ForensicCollector): LiteElement[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = raw.domSnapshot as any;
    const strings: string[] = Array.isArray(ds.strings) ? ds.strings : [];
    const getStr = (idx: number | undefined): string => {
      if (typeof idx !== 'number' || idx < 0 || idx >= strings.length) return '';
      return String(strings[idx] ?? '');
    };

    // AX-by-backendNodeId index. AX nodes carry a `backendDOMNodeId`
    // matching DS `nodes.backendNodeId[i]`. O(1) lookup so per-element
    // mapping stays linear over DS nodes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axNodes: any[] = Array.isArray(raw.axTree?.nodes) ? raw.axTree.nodes : [];
    const axByBackendId = new Map<number, unknown>();
    for (const n of axNodes) {
      const id = n?.backendDOMNodeId;
      if (typeof id === 'number') axByBackendId.set(id, n);
    }

    const elements: LiteElement[] = [];

    // Per-stage rejection accumulators — allocated ONLY when forensic
    // mode is on. The hot path (preview-tick / regression) sees
    // `forensic === undefined` here and pays for no extra arrays /
    // counters. Every loop-body branch already does `if (forensic)`,
    // so undefined here means "skip everything forensic-related".
    const tier1Rejected: ForensicRejection[] | undefined = forensic ? [] : undefined;
    const iconishRejected: ForensicRejection[] | undefined = forensic ? [] : undefined;
    const tier2Rejected: ForensicRejection[] | undefined = forensic ? [] : undefined;
    // Bounded passed-samples — first N kept that have ANY identity hint
    // (id / testId / aria-label / text). We bias toward identity-rich
    // samples so the JSONL shows useful entries even when the page has
    // hundreds of anonymous div-buttons. Falls back to first N if no
    // identity-rich nodes are found.
    const tier1Passed: ForensicNode[] | undefined = forensic ? [] : undefined;
    const iconishPassed: ForensicNode[] | undefined = forensic ? [] : undefined;
    const tier2Passed: ForensicNode[] | undefined = forensic ? [] : undefined;
    let tier1Considered = 0;
    let tier1Kept = 0;
    let tier1NoBoundsRescued = 0; // tier1 nodes kept with bbox=(0,0,0,0) — DS had no layout-row.
    let iconishConsidered = 0;
    let iconishKept = 0;
    let tier2Considered = 0;
    let tier2Kept = 0;
    const mapStartedAt = forensic ? Date.now() : 0;

    // Helper to push a passed-sample with identity bias. Skips entries
    // when the cap is already hit OR when this entry has no useful
    // hint AND we already have FORENSIC_PASSED_SAMPLE_SIZE/2 identity-
    // free entries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recordPassed = (arr: ForensicNode[] | undefined, tagName: string, attrs: DecodedAttrs, bounds: { x:number;y:number;width:number;height:number } | undefined, dsNodeIdx: number, rawText: string | undefined) => {
      if (!arr || arr.length >= FORENSIC_PASSED_SAMPLE_SIZE) return;
      const pickedAttrs = pickForensicAttrs(attrs);
      const hasIdentity = !!(pickedAttrs.id || pickedAttrs['data-testid'] || pickedAttrs['aria-label'] || pickedAttrs.role || (rawText && rawText.length > 0));
      // After half the slots are used, only accept identity-rich entries.
      if (!hasIdentity && arr.length >= Math.floor(FORENSIC_PASSED_SAMPLE_SIZE / 2)) return;
      arr.push({
        tag: tagName,
        attrs: pickedAttrs,
        bbox: bboxToForensic(bounds),
        dsNodeIdx,
        ...(rawText ? { text: rawText.slice(0, 60) } : {}),
      });
    };

    // Walk every document (main frame + same-origin iframes; cross-
    // origin iframes show up as separate documents too — DS gives all
    // of them at once, the audit win we get for free vs today's
    // evaluate path which silently skips them).
    const documents = Array.isArray(ds.documents) ? ds.documents : [];
    for (let docIdx = 0; docIdx < documents.length; docIdx++) {
      const doc = documents[docIdx];
      if (!doc?.nodes) continue;
      const nodes = doc.nodes;
      const layout = doc.layout ?? {};
      // documentURL is a StringIndex into the `strings` table. For
      // main frame it equals the page URL; for iframes it's the iframe
      // src (or about:blank for empty iframes). Used by Phase 3.5 to
      // route per-frame evaluate to the right Playwright Frame.
      const docUrl: string = docIdx === 0 ? '' : getStr(doc.documentURL);

      // layout.nodeIndex maps layout-row → DS node index. We need the
      // inverse: DS node index → layout row, so we can read bounds /
      // computed styles for any node we keep.
      const layoutByNodeIdx = new Map<number, number>();
      const layoutNodeIndex: number[] = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
      for (let i = 0; i < layoutNodeIndex.length; i++) {
        layoutByNodeIdx.set(layoutNodeIndex[i], i);
      }

      // Text accumulator. CDP `captureSnapshot` stores a node's text in the
      // FLAT `nodeValue` array (string index, or -1 for none) — NOT in
      // `textValue`, which is the RareStringData of `<textarea>` values only
      // and is EMPTY on pages without textareas. (The previous code read
      // `textValue`, so the CDP path never recovered text-node text at all —
      // it leaned entirely on AX `name`, which is empty for role=generic
      // div-buttons; that is the documentolog "Login" miss.) We build two maps
      // off the #text (nodeType 3) nodes:
      //   • textByParentIdx     — a node's DIRECT child text.
      //   • descendantTextByIdx — text from DEEPER descendants (bounded depth),
      //                           bubbled up to ancestors.
      // Why both: a descriptor-poor wrapper `<div><svg/><p>Login</p></div>`
      // (documentolog header; role=generic, empty AX name) has NO direct text —
      // the label lives one level down. Without subtree text the resolver has
      // no string to match "Login" against and rejects it. The evaluate-path
      // collector reads `el.textContent` (full subtree), so this realigns the
      // two collectors (invariant #5). Per-node cap 100 chars.
      const textByParentIdx = new Map<number, string>();
      const descendantTextByIdx = new Map<number, string>();
      {
        const nodeValue: number[] = Array.isArray(nodes.nodeValue) ? nodes.nodeValue : [];
        const nodeType: number[] = Array.isArray(nodes.nodeType) ? nodes.nodeType : [];
        const parentIdx: number[] = Array.isArray(nodes.parentIndex) ? nodes.parentIndex : [];
        const MAX_BUBBLE_DEPTH = 4;
        const append = (map: Map<number, string>, key: number, chunk: string): void => {
          const existing = map.get(key) ?? '';
          if (existing.length >= 100) return;
          map.set(key, ((existing.length > 0 ? existing + ' ' : '') + chunk).slice(0, 100));
        };
        for (let i = 0; i < nodeValue.length; i++) {
          if (nodeType[i] !== 3) continue;             // TEXT_NODE only (skip comment/cdata)
          const vIdx = nodeValue[i];
          if (typeof vIdx !== 'number' || vIdx < 0) continue;
          const chunk = getStr(vIdx).trim();
          if (chunk.length === 0) continue;
          const directParent = parentIdx[i];
          if (typeof directParent !== 'number' || directParent < 0) continue;
          append(textByParentIdx, directParent, chunk);
          // Bubble to ancestors ABOVE the direct parent so a clickable wrapper
          // inherits its descendants' visible text.
          let anc = parentIdx[directParent];
          let depth = 0;
          while (typeof anc === 'number' && anc >= 0 && depth < MAX_BUBBLE_DEPTH) {
            append(descendantTextByIdx, anc, chunk);
            anc = parentIdx[anc];
            depth++;
          }
        }
      }
      // Direct text wins; descendant subtree text is the fallback. AX name is
      // applied separately in buildLiteElementFromNode, so this only fills the
      // case where a kept element has neither direct text nor an AX name.
      const effectiveText = (idx: number): string | undefined => {
        const direct = textByParentIdx.get(idx);
        if (direct && direct.length > 0) return direct;
        return descendantTextByIdx.get(idx);
      };

      const nodeCount = Array.isArray(nodes.nodeName) ? nodes.nodeName.length : 0;

      // Two-pass strategy:
      //   Pass 1 (tier1): every semantic interactive (button/a/input/
      //     [role=button]/[tabindex=0]) — UNCAPPED. These are real
      //     controls; we never want to drop them.
      //   Pass 2 (tier2): cursor:pointer fallbacks — CAPPED at
      //     MAX_TIER2_ELEMENTS. Without the cap, pages with global
      //     cursor:pointer CSS flood with thousands of decorative
      //     children (each <i>/<span> inside a button), making CDP
      //     orders of magnitude slower than evaluate path.
      //
      // Single-pass with embedded cap would risk dropping a tier1 hit
      // late in the document because tier2 hits early filled the
      // budget — that would silently miss real buttons. Splitting
      // the passes is the only correct order.
      let tier2Added = 0;

      // Pass 1: tier-1, capped at MAX_TOTAL_ELEMENTS (1500 after the
      // bi.group bump). Pages with >1500 semantic-interactive children
      // (rare — only huge data grids / infinite-scroll feeds) get
      // clipped. Better to clip here than to do per-element Phase 4
      // work on elements that would be discarded downstream anyway.
      // Tier-1 is checked FIRST so semantic buttons/links never lose
      // their slot to cursor:pointer noise (tier-2 fallback).
      for (let i = 0; i < nodeCount; i++) {
        if (elements.length >= MAX_TOTAL_ELEMENTS) {
          if (forensic) {
            // We stop walking, but record this as a single capacity event
            // rather than per-node — avoids flooding the JSONL.
            tier1Rejected!.push({
              tag: '(cap)', attrs: { remainingNodes: String(nodeCount - i) }, bbox: null,
              reason: 'tier1.maxTotalElementsReached',
            });
          }
          break;
        }
        const tagName = getStr(nodes.nodeName?.[i]).toLowerCase();
        if (!tagName || tagName.startsWith('#')) continue;
        const attrs = decodeAttributes(nodes.attributes?.[i], getStr);

        if (forensic) tier1Considered++;
        if (!isInteractiveNodeTier1(tagName, attrs)) {
          // Tier-1 not interactive — too noisy to record every <div> /
          // <span>. Pass to tier1.5 / tier-2 (re-evaluated below) so
          // skipping silently here is correct. Only record nodes that
          // PASS tier-1 but get dropped by bounds/layout — those are
          // the surprising ones.
          continue;
        }

        const layoutIdx = layoutByNodeIdx.get(i);
        let bounds = layoutIdx !== undefined ? decodeBoundsForLayoutIdx(layout, layoutIdx) : undefined;
        // V-bibgroup-2 May 2026 — Tier-1 noBounds rescue:
        //   DS occasionally omits layout-row for nodes that ARE visible
        //   in the live DOM (paint-layer skipping, sub-pixel rendering,
        //   position:fixed children of complex stacking contexts).
        //   bi.group close-X buttons fell into this gap: <button> tags
        //   with valid getBoundingClientRect at evaluate time, but no
        //   DS bounds → previously dropped silently.
        //   Solution: keep them in elements[] with zero bbox.
        //   refAssign Stage A (id/testId/name) and Stage C (descriptor
        //   fallback by aria-label/placeholder) can still recover the
        //   live node; if no descriptor matches, refAssign returns null
        //   and the post-filter drops it harmlessly.
        let boundsWereMissing = false;
        if (!bounds) {
          bounds = { x: 0, y: 0, width: 0, height: 0 };
          boundsWereMissing = true;
        }
        const styles = layoutIdx !== undefined ? decodeStylesForLayoutIdx(layout, layoutIdx, getStr) : undefined;

        const backendId = nodes.backendNodeId?.[i];
        const axNode = typeof backendId === 'number' ? axByBackendId.get(backendId) : undefined;

        const elBuilt = buildLiteElementFromNode({
          tagName, attrs, bounds, styles, axNode,
          dsNodeIndex: i, docIndex: docIdx, docUrl,
          rawText: effectiveText(i),
        });
        if (boundsWereMissing) {
          // Mark rescue so forensic / consumers can distinguish "real
          // 0×0 element" from "DS had no layout, we kept it for ID
          // fallback". `liteElementToForensic` reads this and emits
          // bbox:null instead of bbox:{0,0,0,0}, which keeps the
          // jq-filter on `.bbox == null` honest.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (elBuilt as any).__noBoundsRescued = true;
        }
        elements.push(elBuilt);
        if (forensic) {
          tier1Kept++;
          if (boundsWereMissing) tier1NoBoundsRescued++;
          recordPassed(tier1Passed, tagName, attrs, bounds, i, textByParentIdx.get(i));
        }
      }

      // Build set of indexes added by Pass 1 so subsequent passes
      // can skip them. We re-scan the node array in Pass 1.5 / Pass 2
      // — small overhead vs. the duplication we'd cause otherwise.
      const tier1Indexes = new Set<number>();
      for (const el of elements) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idx = (el as any).__dsNodeIndex;
        if (typeof idx === 'number' && (el as unknown as { __docIndex?: number }).__docIndex === docIdx) {
          tier1Indexes.add(idx);
        }
      }

      // Pass 1.5: icon-ish elements with stable id / testid.
      // <svg id="...">, <i id="..." class="icon">, <img id="logo">,
      // <path data-testid="...">. Mirrors evaluate-path's secondary
      // pass (snapshot-collector.ts ~line 1126). UNCAPPED — these
      // are explicitly-named UI elements, not decorative noise; the
      // stable-id requirement is the cap. Without this pass:
      //   - logo images miss from snapshot → recorder records
      //     `<img id="logo">`, identity fast-path fires on id, no
      //     match in CDP path → resolver falls through to LLM →
      //     wrong CTA picked.
      //   - icon-only toolbar buttons (Element Plus, Material) miss
      //     when their <i id="..."> child carries the stable id.
      for (let i = 0; i < nodeCount; i++) {
        if (elements.length >= MAX_TOTAL_ELEMENTS) break;
        if (tier1Indexes.has(i)) continue;

        const tagName = getStr(nodes.nodeName?.[i]).toLowerCase();
        if (!tagName || tagName.startsWith('#')) continue;
        const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
        if (!isInteractiveIconish(tagName, attrs)) continue;

        if (forensic) iconishConsidered++;
        const layoutIdx = layoutByNodeIdx.get(i);
        const bounds = layoutIdx !== undefined ? decodeBoundsForLayoutIdx(layout, layoutIdx) : undefined;
        if (!bounds) {
          if (forensic) {
            iconishRejected!.push({
              tag: tagName, attrs: pickForensicAttrs(attrs), bbox: null,
              reason: 'iconish.noBounds',
            });
          }
          continue;
        }
        // Min-size gate matches evaluate-path (5×5) — filters out
        // 0-size hidden icon placeholders without dropping typical
        // 16-32px button glyphs.
        if (bounds.width < 5 || bounds.height < 5) {
          if (forensic) {
            iconishRejected!.push({
              tag: tagName, attrs: pickForensicAttrs(attrs), bbox: bboxToForensic(bounds),
              reason: 'iconish.tooSmall',
            });
          }
          continue;
        }
        const styles = layoutIdx !== undefined ? decodeStylesForLayoutIdx(layout, layoutIdx, getStr) : undefined;

        const backendId = nodes.backendNodeId?.[i];
        const axNode = typeof backendId === 'number' ? axByBackendId.get(backendId) : undefined;

        elements.push(buildLiteElementFromNode({
          tagName, attrs, bounds, styles, axNode,
          dsNodeIndex: i, docIndex: docIdx, docUrl,
          rawText: effectiveText(i),
        }));
        if (forensic) {
          iconishKept++;
          recordPassed(iconishPassed, tagName, attrs, bounds, i, textByParentIdx.get(i));
        }
        tier1Indexes.add(i);
      }

      // Pass 2: tier-2 (cursor:pointer) — TWO-PHASE.
      //
      // ROOT-CAUSE NOTE (May 2026 bi.group close-X audit):
      //   The previous implementation walked DS in document order and
      //   accepted the first 300 cursor:pointer matches that fit under
      //   MAX_TOTAL_ELEMENTS. On bi.group the close-X SVG wrapper
      //   <span class="c-PJLV c-cSaKLY"> with cursor:pointer and bbox
      //   (925, 168.5, 32, 32) was at DS-walk position ~2649, behind
      //   ~135 unrelated cursor:pointer nodes (card hover decorations,
      //   inline links, etc). The cap fired AT 500 total = 135 tier2
      //   accepted, our close-X NEVER reached.
      //
      // Fix: COLLECT all tier-2 candidates first, then SORT by priority:
      //   1. Small bbox (16-64px) — icons, action buttons (close, menu,
      //      arrow, settings — the high-value targets on dense pages)
      //   2. position: absolute|fixed — overlay-style UI (modal close,
      //      floating actions, toast dismiss)
      //   3. Has aria-* / role / data-state attrs — Radix/HeadlessUI
      //      semantic widgets
      //   4. Larger / generic — the long tail
      //
      // Then accept up to the cap from the sorted list. Close-X is now
      // in tier 1+2 (small bbox + absolute), guaranteed inclusion.
      type Tier2Candidate = {
        nodeIdx: number;
        tagName: string;
        attrs: DecodedAttrs;
        bounds: { x: number; y: number; width: number; height: number };
        styles: DecodedStyles;
        priority: number;
      };
      const tier2Candidates: Tier2Candidate[] = [];

      // Phase 2a: collect all tier-2 candidates from DS.
      for (let i = 0; i < nodeCount; i++) {
        if (tier1Indexes.has(i)) continue;

        const tagName = getStr(nodes.nodeName?.[i]).toLowerCase();
        if (!tagName || tagName.startsWith('#')) continue;

        const layoutIdx = layoutByNodeIdx.get(i);
        if (layoutIdx === undefined) continue;
        const styles = decodeStylesForLayoutIdx(layout, layoutIdx, getStr);
        if (!isInteractiveNodeTier2(styles)) continue;

        if (forensic) tier2Considered++;
        const bounds = decodeBoundsForLayoutIdx(layout, layoutIdx);
        if (!bounds) {
          if (forensic) {
            const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
            tier2Rejected!.push({
              tag: tagName, attrs: pickForensicAttrs(attrs), bbox: null,
              reason: 'tier2.noBounds',
            });
          }
          continue;
        }

        const attrs = decodeAttributes(nodes.attributes?.[i], getStr);

        // Compute priority score — LOWER = more important.
        // Bands: 0-icon (smallest), 1-overlay (positioned), 2-aria, 3-default.
        // Within band: smaller bbox first (icons before banners).
        let priority = 3;
        const isSmallIcon = bounds.width <= 64 && bounds.height <= 64
          && bounds.width >= 8 && bounds.height >= 8;
        const isOverlayPositioned = styles ? (styles.position === 'absolute' || styles.position === 'fixed') : false;
        const hasAriaSemantic = attrs.has('aria-label') || attrs.has('aria-haspopup')
          || attrs.has('aria-expanded') || attrs.has('role') || attrs.has('data-state');
        if (isSmallIcon && isOverlayPositioned) priority = 0;          // floating icon-button — top
        else if (isSmallIcon) priority = 1;                            // any icon-sized clickable
        else if (isOverlayPositioned) priority = 1;                    // floating panel/button
        else if (hasAriaSemantic) priority = 2;                        // semantic widget
        // else priority = 3 (default — long-tail)

        // Mix bbox-area tiebreaker (smaller = earlier) into priority by
        // shifting into a fractional component. Bbox area is bounded by
        // viewport ≈ 1280*720 = 921600. log2 gives 20-bit range; we'd
        // rather not depend on log — use raw area / 1e7 so it stays a
        // small float compared to integer priority.
        const area = bounds.width * bounds.height;
        const finalScore = priority + Math.min(area / 1e7, 0.99);

        tier2Candidates.push({
          nodeIdx: i,
          tagName,
          attrs,
          bounds,
          styles: styles ?? { display: '', visibility: '', opacity: '', cursor: '', pointerEvents: '', position: '', zIndex: '', backgroundColor: '', color: '', borderRadius: '' },
          priority: finalScore,
        });
      }

      // Phase 2b: sort by priority (lower = first), then fill up to caps.
      tier2Candidates.sort((a, b) => a.priority - b.priority);

      for (const c of tier2Candidates) {
        if (tier2Added >= MAX_TIER2_ELEMENTS) {
          if (forensic) {
            tier2Rejected!.push({
              tag: '(cap)', attrs: { remainingCandidates: String(tier2Candidates.length - tier2Added) }, bbox: null,
              reason: 'tier2.maxTier2ElementsReached',
            });
          }
          break;
        }
        if (elements.length >= MAX_TOTAL_ELEMENTS) {
          if (forensic) {
            tier2Rejected!.push({
              tag: '(cap)', attrs: { remainingCandidates: String(tier2Candidates.length - tier2Added) }, bbox: null,
              reason: 'tier2.maxTotalElementsReached',
            });
          }
          break;
        }
        const backendId = nodes.backendNodeId?.[c.nodeIdx];
        const axNode = typeof backendId === 'number' ? axByBackendId.get(backendId) : undefined;

        elements.push(buildLiteElementFromNode({
          tagName: c.tagName, attrs: c.attrs, bounds: c.bounds, styles: c.styles, axNode,
          dsNodeIndex: c.nodeIdx, docIndex: docIdx, docUrl,
          rawText: effectiveText(c.nodeIdx),
        }));
        if (forensic) {
          tier2Kept++;
          recordPassed(tier2Passed, c.tagName, c.attrs, c.bounds, c.nodeIdx, textByParentIdx.get(c.nodeIdx));
        }
        tier2Added++;
      }
    }

    if (forensic) {
      // `inputCount` here is "nodes that passed the predicate gate"
      // (isInteractiveNodeTier1 / isInteractiveIconish / cursor:pointer),
      // NOT "nodes walked". Non-interactive nodes are skipped silently
      // to keep JSONL size bounded — recording every <div> would balloon
      // the file 50-100×. `(cap)` sentinel entries cover the
      // MAX_TOTAL_ELEMENTS / MAX_TIER2_ELEMENTS cutoff cases.
      const mappingDuration = Date.now() - mapStartedAt;
      forensic.stages.push({
        stage: 'tier1',
        inputCount: tier1Considered,
        passedCount: tier1Kept,
        rejected: tier1Rejected ?? [],
        passedSample: tier1Passed,
        // All three mapping passes share the same outer loop, so we
        // attribute the total mapping duration to tier1 (the bulk of
        // mapping work) rather than triple-counting. iconish/tier2
        // durations are nested and tiny relative to tier1.
        durationMs: mappingDuration,
        // noBoundsRescued counts elements kept despite DS having no
        // layout-row. They aren't in rejected[] — they passed — but
        // they're a distinct cohort worth tracking separately so the
        // jq query for "real drops" remains `.rejected | length`.
        ...(tier1NoBoundsRescued > 0 ? { extra: { noBoundsRescued: tier1NoBoundsRescued } } : {}),
      });
      forensic.stages.push({
        stage: 'iconish',
        inputCount: iconishConsidered,
        passedCount: iconishKept,
        rejected: iconishRejected ?? [],
        passedSample: iconishPassed,
      });
      forensic.stages.push({
        stage: 'tier2',
        inputCount: tier2Considered,
        passedCount: tier2Kept,
        rejected: tier2Rejected ?? [],
        passedSample: tier2Passed,
      });
    }

    return elements;
  }

  /**
   * Phase 3.5 — assign `data-agent-ref` to each interactive element
   * via a single batched `page.evaluate`.
   *
   * Why this is the most subtle phase in the whole CDP path:
   *
   *   1. Refs MUST be STABLE across snapshots. Every consumer of
   *      `evidence.lastSuccessRef` (PreviewStepApplyService evidence
   *      shortcut, RecordingCaptureService.lastSuccessRef) assumes a
   *      ref captured on apply N still resolves the SAME element on
   *      replay N+1. Reset the counter and you silently invalidate
   *      every cached ref in the DB.
   *
   *   2. Refs MUST survive React re-renders. The existing
   *      SnapshotCollector achieves this via `__agentFingerprintMap`
   *      keyed by tag+role+id+testId+5-deep DOM path. Without
   *      reusing this map we generate fresh refs each render and
   *      lose evidence shortcuts on every Apply All.
   *
   *   3. Refs MUST be unique across documents. Cross-origin iframes
   *      have separate `window.__agentRefCounter` instances, so
   *      `e23` in main frame and `e23` in iframe collide for the
   *      Node-side LiteElement. Today's collector skips iframes
   *      entirely so this isn't an issue; CDP path picks them up,
   *      so we prefix with iframe origin to avoid collisions.
   *
   * Implementation strategy:
   *   - Build a list of [docIndex, dsNodeIndex, fingerprint] tuples
   *     from `elements`. fingerprint is computed in Node from the
   *     fields we ALREADY mapped — same algorithm as in-page
   *     getElementFingerprint, no extra evaluate cost.
   *   - One page.evaluate per document (typically 1, sometimes
   *     several with iframes). Each evaluate looks up the right
   *     element by fingerprint match in window.__agentFingerprintMap,
   *     reusing cached ref or assigning new from window.__agentRefCounter.
   *
   * Why NOT querying by some new identifier we generate:
   *   - We'd add a second source of truth (Node-counter vs in-page
   *     counter) and they'd drift the moment the page reloads
   *     during preview tick.
   *   - In-page state survives tab navigation; Node-side state
   *     doesn't. Reusing window.* keeps single source.
   */
  private static async assignAgentRefs(page: Page, elements: LiteElement[]): Promise<void> {
    if (elements.length === 0) return;

    // Group elements by document. Each DS document corresponds to a
    // distinct execution context: main frame at docIdx=0, then one per
    // iframe (same-origin AND cross-origin — DS gives all of them).
    // Same-origin iframes accept frame.evaluate; cross-origin reject
    // with "evaluate" disallowed and we drop those elements (the
    // post-collect filter in collect() removes them by empty ref).
    const byDoc = new Map<number, LiteElement[]>();
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      const key = docIdx ?? 0;
      const list = byDoc.get(key) ?? [];
      list.push(el);
      byDoc.set(key, list);
    }

    // Per-document ref assignment. main frame always docIdx=0 (DS
    // contract). For iframes we look up the matching Playwright Frame
    // by URL — Playwright doesn't expose CDP frameId directly, but
    // both sides agree on the document URL. Multiple frames sharing
    // the same URL are rare (server-rendered iframe gallery); when it
    // happens we pick the first match and accept best-effort.
    //
    // URL normalization: Chromium and Playwright sometimes report the
    // same iframe with cosmetic differences — trailing slash on root
    // (`https://x.com` vs `https://x.com/`), upper-case in host
    // (`Example.COM` from a server-rendered src vs `example.com` from
    // Playwright). Strict equality misses these; normalize both sides
    // to host-lowercase + path-default-slash before compare. We DO
    // NOT touch query/hash because some sites use them as iframe
    // identifiers (cache-busting `?v=N` etc — equality is the right
    // signal there). Fallback to raw equality if URL parser fails on
    // either side (data: URIs, malformed src — rare but possible).
    const normalizeFrameUrl = (rawUrl: string): string => {
      if (!rawUrl) return rawUrl;
      try {
        const u = new URL(rawUrl);
        // Empty path → '/'. Other paths kept as-is (no implicit
        // trailing-slash strip — `/foo/` and `/foo` are distinct
        // routes for many SPA routers).
        const path = u.pathname || '/';
        return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}${u.hash}`;
      } catch {
        return rawUrl;
      }
    };
    for (const [docIdx, docElements] of byDoc.entries()) {
      if (docElements.length === 0) continue;

      // Resolve target Frame for this document.
      let frame: Frame | null = null;
      let frameDescriptor = 'main';
      if (docIdx === 0) {
        frame = page.mainFrame();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const docUrl = (docElements[0] as any).__docUrl as string | undefined;
        if (docUrl && docUrl !== 'about:blank') {
          const normalisedDocUrl = normalizeFrameUrl(docUrl);
          frame = page.frames().find((f) => {
            if (f.isDetached()) return false;
            const frameUrl = f.url();
            // Cheap fast-path: raw equality first. Only normalize when
            // raw fails — saves URL-parse round-trips on the common
            // case where both sides agree exactly.
            return frameUrl === docUrl
              || normalizeFrameUrl(frameUrl) === normalisedDocUrl;
          }) ?? null;
          frameDescriptor = `iframe@${docUrl.slice(0, 60)}`;
        }
        if (!frame) {
          // No matching live Playwright frame (cross-origin frame that
          // detached, navigated, or just ungettable from outside). The
          // elements stay with empty refs; collect()'s defense filter
          // drops them. Log once per ref-assignment cycle so operators
          // notice stale-iframe drift on their site.
          logger.debug('[CDP_SNAPSHOT] Skipping iframe ref assignment — no matching Playwright frame', {
            docIdx,
            docUrl,
            droppedElements: docElements.length,
          });
          continue;
        }
      }

      let refsByIndex: string[];
      try {
        refsByIndex = await this.runRefAssignmentInFrame(frame, docElements);
      } catch (err) {
        // Cross-origin frame, frame detached mid-eval, or context
        // destroyed by navigation. Same outcome as null-frame: leave
        // the elements with empty refs and let the post-collect filter
        // drop them. Cross-origin is the canonical case here.
        logger.debug('[CDP_SNAPSHOT] Frame ref assignment failed (likely cross-origin)', {
          docIdx,
          frameDescriptor,
          droppedElements: docElements.length,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Attach the per-element diag to the LiteElement itself so the
      // forensic emit in collect() can read it by index. Stored under
      // `__refAssignDiag` symbol-property — invisible to LiteElement
      // type consumers, deleted in collect()'s cleanup pass.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const diags = (docElements as any).__refAssignDiags as any[] | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (docElements as any).__refAssignContext as any | undefined;
      if (diags) {
        for (let i = 0; i < docElements.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (docElements[i] as any).__refAssignDiag = diags[i];
        }
      }
      // Page context is doc-level (one per frame). Hoist onto the
      // OUTER `elements` array itself (it's a NodeJS Array, properties
      // attach fine). Putting it on `docElements[0]` was buggy:
      // docElements[0] is the first element of THIS document, and that
      // element may get dropped by the empty-ref filter below — the
      // context goes to the trash with it. The outer-array approach
      // survives all element splices; collector reads from
      // (elements as any).__refAssignContext.
      // We only set for the MAIN frame (docIdx=0) — iframe context is
      // less useful at the summary level. Could be promoted to a
      // map<docIdx, ctx> if iframe forensic becomes important.
      if (ctx && docIdx === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (elements as any).__refAssignContext = ctx;
      }

      // Compact in place: assign refs and drop entries whose findElement
      // returned null in-page (empty ref). The same loop as before, just
      // applied to whichever per-doc array we processed.
      //
      // CROSS-FRAME REF UNIQUENESS (2026-06 doculite login fix):
      //   Each frame runs `runRefAssignmentInFrame` in ITS OWN execution
      //   context with ITS OWN `window.__agentRefCounter`, so EVERY frame
      //   restarts numbering at `e0`. With ≥2 frames the same ref string
      //   (`e0`, `e1`, …) is minted independently in each — violating the
      //   snapshot-global invariant "each ref identifies exactly ONE
      //   LiteElement" (see the dedup block in collect()). Real incident:
      //   doculite OAuth login renders a hidden `oauth/integration` iframe
      //   whose lone noBounds <svg ArrowDropDownIcon> took `e0` — colliding
      //   with the main-frame password <input> (also `e0`). The global
      //   dedup then dropped the password field and the resolver never saw
      //   it ("element not found" on a plainly-visible field).
      //
      //   Fix: namespace non-main frames with a `d{docIdx}_` prefix so refs
      //   are globally unique across the snapshot. The MAIN frame (docIdx=0)
      //   keeps its bare `eN` refs — it holds ~all real targets, and bare
      //   refs are what every existing recording/evidence already carries.
      //   This is safe because `eN`-shaped refs are explicitly treated as
      //   DOM-counter-unstable and never persisted as a cross-run cache key
      //   (see step-readiness.service.ts guard `^(e\d+|s\d+|bg-\d+)$`).
      const refPrefix = docIdx === 0 ? '' : `d${docIdx}_`;
      let writeIdx = 0;
      for (let i = 0; i < docElements.length; i++) {
        const ref = refsByIndex[i] ?? '';
        if (!ref) continue;
        docElements[i].ref = refPrefix ? `${refPrefix}${ref}` : ref;
        docElements[writeIdx++] = docElements[i];
      }
      docElements.length = writeIdx;
      // NOTE: docElements is a *new* Array (built by `byDoc.set` above),
      // not a view into `elements`. Truncating it does NOT remove the
      // empty-ref entries from the caller's `elements` array. The
      // outer collect() routine has a post-pass that filters
      // `elements` by !ref to enforce the contract (see "Defense"
      // comment block where assignAgentRefs is called).
    }
  }

  /**
   * Run the in-page ref-assignment evaluate against a specific Frame.
   * Same algorithm for main and iframe — only the execution context
   * (which `document` / `window` it sees) differs. Extracted from the
   * legacy single-frame implementation when iframe support landed.
   */
  private static async runRefAssignmentInFrame(
    frame: Frame,
    docElements: LiteElement[],
  ): Promise<string[]> {
    type RefAssignmentRequest = {
      tag: string;
      role: string;
      type: string;
      name: string;          // form `name` attribute
      id: string;
      ariaLabel: string;
      placeholder: string;
      testId: string;
      // Visible text (incl. from descendants — see LiteElement.text). Drives the
      // Stage C text fallback for descriptor-poor wrappers (id-less `<div onClick>`
      // whose label lives in a child) when Stage B's bbox match flakes.
      text: string;
      // Identity slot for selector — first non-dynamic id/testId/name
      // gives us a fast path. When all are absent we fall back to
      // bbox + tag matching in-page (rare; only for descriptor-poor
      // anonymous divs).
      bboxX: number;
      bboxY: number;
      bboxW: number;
      bboxH: number;
    };

    // Build requests carrying the ORIGINAL index so refs can be returned
    // in element order regardless of how we process internally. We sort
    // before evaluate so that high-specificity requests (stable id /
    // testId / small bbox) run FIRST and claim their DOM nodes before
    // generic-tag overlay-area requests get a chance to collide.
    //
    // Why this matters: when DS yields parent-before-child order and the
    // parent is an overlay wrapper div, the wrapper's request runs first
    // and locks `data-agent-ref` on the wrapper. Later child requests
    // then see the wrapper as "already assigned" and (correctly) skip
    // it — but the OLD bug was returning that wrapper anyway. With the
    // current findElement (`refAlreadyAssigned` check), the wrapper
    // doesn't block children, but ordering still affects WHICH node
    // each ref attaches to. Specific-first ordering minimises walk-up
    // collisions and keeps refs attached to the most specific element.
    type Indexed = RefAssignmentRequest & { __origIdx: number; __area: number; __specificity: number };
    // Resolve scroll offset to normalize bounds from document-space to
    // viewport-space.
    //
    // CDP `DOMSnapshot.bounds` is DOCUMENT-relative — origin at top-left
    // of the document, not the viewport. The in-page evaluate below
    // calls `elementsFromPoint(cx, cy)` and `getBoundingClientRect()`
    // which are VIEWPORT-relative. Without subtracting scroll, every
    // element below the fold is silently rejected at refAssign with
    // `findElementReturnedNull / atPoint: null` (measured 543/639 = 85%
    // of refAssign rejections on a `scrollY=500` bi.group capture, with
    // the target "Астана" button — doc-y=792.5 → viewport-y=292.5 —
    // being one of the casualties).
    //
    // ⚠️ Which scroll? LIVE, not snapshot.
    //   `getBoundingClientRect()` (used by `bboxScore`) reads the LIVE
    //   DOM scroll. If we subtracted the snapshot-time scroll (stashed
    //   in `__docScrollY`), `bboxScore` would compare:
    //       req.bboxY = doc-y - snapshotScroll
    //       r.y      = doc-y - liveScroll  (from getBoundingClientRect)
    //   When the user scrolled between captureSnapshot and refAssign
    //   (~50ms gap) the difference exceeds TOL_EXACT=10px and bboxScore
    //   returns 'mismatch' → element silently dropped.
    //
    //   Reading scroll INSIDE the evaluate body (`win.scrollX/Y`) closes
    //   the race: same instant as getBoundingClientRect, same coord
    //   space. Snapshot-time scroll (`__docScrollX/Y`) is used only as
    //   a forensic hint — see `liteElementToForensic` consumers.
    //
    // ⚠️ Per-iframe scroll: each iframe has its own scroll position.
    //   `assignAgentRefs` already groups by `docIdx`, so each call to
    //   `runRefAssignmentInFrame` runs inside ONE frame. Reading
    //   `win.scrollX/Y` inside that frame's evaluate is therefore
    //   frame-local — correct for both main page and iframes.
    //
    // Stage-A identity selectors (id/testId/name) don't read bbox at
    // all, so the scroll subtraction is a no-op for them. Only Stage B
    // (bbox walk-up) and Stage C (descriptor + bbox tiebreaker) actually
    // need viewport coords.

    const indexed: Indexed[] = docElements.map((el, idx) => {
      const id = el.htmlId || '';
      const testIdAttr = el.testIdAttr || '';
      const bboxW = el.bounds?.width ?? 0;
      const bboxH = el.bounds?.height ?? 0;
      // Specificity score, lower = process first:
      //   0 = has stable id          (unique selector, can't collide)
      //   1 = has testId             (typically unique)
      //   2 = has aria-label / name  (often unique within form/region)
      //   3 = bbox-only              (must rely on geometry)
      let specificity = 3;
      if (id) specificity = 0;
      else if (testIdAttr) specificity = 1;
      else if (el.ariaLabel || el.htmlName) specificity = 2;
      // Bounds stay DOCUMENT-relative on the request payload. The
      // evaluate body subtracts live `win.scrollX/Y` once at entry so
      // every comparison downstream (elementsFromPoint,
      // getBoundingClientRect, bboxScore IoU) runs in viewport space.
      // Public `el.bounds` is NOT modified — downstream consumers
      // (resolver, recording, forensic logs) continue to see
      // document-relative bounds, preserving the existing contract.
      return {
        tag: el.tag,
        role: el.role || '',
        type: el.type || '',
        name: el.htmlName || '',
        id,
        ariaLabel: el.ariaLabel || '',
        placeholder: el.placeholder || '',
        testId: testIdAttr,
        text: el.text || '',
        bboxX: el.bounds?.x ?? 0,
        bboxY: el.bounds?.y ?? 0,
        bboxW,
        bboxH,
        __origIdx: idx,
        __area: bboxW * bboxH,
        __specificity: specificity,
      };
    });
    // Sort: most specific first; within same specificity, smaller bbox
    // first (children before parents). Both bbox-0 elements (noBounds
    // rescue) sort by specificity only — they go to Stage A/C anyway.
    indexed.sort((a, b) => {
      if (a.__specificity !== b.__specificity) return a.__specificity - b.__specificity;
      return a.__area - b.__area;
    });

    // Strip orchestration-only fields before sending to evaluate.
    const requests: RefAssignmentRequest[] = indexed.map((r) => ({
      tag: r.tag, role: r.role, type: r.type, name: r.name,
      id: r.id, ariaLabel: r.ariaLabel, placeholder: r.placeholder, testId: r.testId,
      text: r.text,
      bboxX: r.bboxX, bboxY: r.bboxY, bboxW: r.bboxW, bboxH: r.bboxH,
    }));

    // The evaluate body MUST mirror the existing snapshot-collector
    // logic byte-for-byte. We cannot read the source of that function
    // from here (browser context vs Node), so the algorithm is
    // duplicated. Drift here is the single biggest risk for
    // evidence shortcut breakage.
    //
    // Symmetry contract documented in 01-fields-audit.md: same
    // window.__agentRefCounter, same __agentFingerprintMap key shape
    // (tag|role|type|name|id|ariaLabel|placeholder|testId|text|domPath),
    // same "use cached ref if found, else allocate new" logic.
    // The evaluate body runs in browser context — `window`, `document`,
    // `Element`, `CSS` are all browser globals. Node TypeScript doesn't
    // know them; we use `any` casts at the boundary rather than wider
    // lib options (would pollute the whole file with browser types).
    // Extended return contract (May 2026 forensic v2): the evaluate
    // returns refs PLUS per-request diagnostics (walk-up trace, scoring
    // detail, what elementFromPoint returned). Diagnostics are collected
    // unconditionally — overhead is tiny (one extra object per
    // failed-find) and we always have access to it when forensic mode
    // requests it at the Node layer. Refs path is unaffected.
    interface WalkUpDiagEntry {
      depth: number;
      /** Which z-stack layer from elementsFromPoint this entry came
       *  from. Layer 0 = topmost (what elementFromPoint would return).
       *  Layers > 0 mean we pierced an overlay to find this candidate. */
      layer: number;
      tag: string;
      live: { x: number; y: number; w: number; h: number } | null;
      score: 'exact' | 'loose' | 'mismatch';
      dx: number;
      dy: number;
      taken: boolean;
    }
    interface ReqDiag {
      atPoint: { tag: string; id: string; classFirst: string; stackDepth?: number } | null;
      walkUp: WalkUpDiagEntry[];
      descendTried: number;
      descendFound: number;
      stageHit:
        | 'A.id' | 'A.testId' | 'A.name'
        | 'B.exact'              // walk-up free match, exact bbox
        | 'B.loose'              // walk-up free match, IoU ≥ 0.5 (formerly 'B.iou')
        | 'B.mismatch'           // walk-up free match, but bbox is mismatched (specific-tag last resort)
        | 'B.taken'              // walk-up generic-tag, only candidate was already ref-taken
        | 'B.descend.exact'      // descend fallback, exact bbox among children
        | 'B.descend.loose'      // descend fallback, non-exact among children
        | 'B.last-resort-taken'  // specific-tag, all free exhausted, fell back to taken ancestor
        | 'C.ariaLabel' | 'C.placeholder'
        | 'null';
      computedTransform?: string;
      computedOpacity?: string;
      computedVisibility?: string;
    }
    interface PageContext {
      scrollX: number;
      scrollY: number;
      devicePixelRatio: number;
      documentReady: string;
      domMutationsDuringSnapshot: number;
      viewportW: number;
      viewportH: number;
    }
    interface EvalResult { refs: string[]; diags: ReqDiag[]; context: PageContext }

    // Tolerate test mocks that return a bare `string[]` (legacy shape)
    // — wrap into the new EvalResult contract on Node side. Production
    // browser context returns the structured object below.
    const rawEvalResult = await frame.evaluate((reqs: RefAssignmentRequest[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = (globalThis as any).window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssEscape: (v: string) => string = (globalThis as any).CSS?.escape
        ?? ((v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

      if (typeof win.__agentRefCounter !== 'number') win.__agentRefCounter = 0;
      if (!win.__agentFingerprintMap) win.__agentFingerprintMap = new Map();

      // Live scroll offset for document→viewport conversion.
      //
      // CDP DOMSnapshot.bounds is document-relative. elementsFromPoint
      // and getBoundingClientRect are viewport-relative. We subtract
      // live `win.scrollX/Y` once here, then ALL downstream math in
      // this evaluate body (bboxScore comparisons, elementsFromPoint
      // calls, IoU calculations) runs in viewport space — consistent
      // with the page's live coordinate system.
      //
      // Live (not snapshot) scroll is the right choice: between
      // captureSnapshot (Node side) and this evaluate (page side) the
      // page may scroll. `getBoundingClientRect` reads from the LIVE
      // DOM, so we must subtract the LIVE scroll to keep both sides in
      // the same space. Snapshot-time scroll is stashed on
      // LiteElement.__docScrollY for forensic comparison only.
      //
      // Defaults to 0 if win has no scrollX/Y (test mocks, exotic
      // contexts). Safe: 0 means "no offset", matches pre-fix behaviour
      // on the common scrollY=0 case.
      const liveScrollX: number = typeof win.scrollX === 'number'
        ? win.scrollX
        : (typeof win.pageXOffset === 'number' ? win.pageXOffset : 0);
      const liveScrollY: number = typeof win.scrollY === 'number'
        ? win.scrollY
        : (typeof win.pageYOffset === 'number' ? win.pageYOffset : 0);

      // Normalize bounds in-place: every downstream consumer of
      // req.bboxX/Y assumes viewport space from this point. We do this
      // BEFORE the helper closures (bboxScore, findElement) capture
      // `reqs` so they see the normalized values automatically.
      if (liveScrollX !== 0 || liveScrollY !== 0) {
        for (let i = 0; i < reqs.length; i++) {
          // Skip rescue-mode entries with empty bbox — they go through
          // Stage A (id/testId/name) or Stage C (descriptor) which
          // don't read bboxX/Y. Subtracting scroll from 0/0 would just
          // create misleading negative coords in diag logs.
          if (reqs[i].bboxW > 0 || reqs[i].bboxH > 0) {
            reqs[i].bboxX = reqs[i].bboxX - liveScrollX;
            reqs[i].bboxY = reqs[i].bboxY - liveScrollY;
          }
        }
      }

      const out: string[] = [];
      // Per-request diagnostics. Same length as `out` / `reqs` — index aligns.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const diags: any[] = [];

      // Lightweight DOM mutation counter for the duration of this evaluate.
      // Surfaces "DOM is mutating while we measure" pages — useful when
      // bbox shifts look mysterious. MutationObserver is cheap; we
      // disconnect at the end of the function.
      let domMutationCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mutObserver: any = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const MO = (globalThis as any).MutationObserver;
        if (MO && doc?.documentElement) {
          mutObserver = new MO(() => { domMutationCount++; });
          mutObserver.observe(doc.documentElement, {
            childList: true, subtree: true, attributes: true, characterData: false,
          });
        }
      } catch { /* ignore */ }

      // Helper: find the candidate element for a request. Strategy:
      //   1. By id (CSS escaped).
      //   2. By bbox + tag walk (cheap fallback).
      // We don't iterate elementsFromPoint because bbox center can be
      // covered by overlay; instead use elementFromPoint at center as
      // a verification step after finding via attributes.
      /**
       * Bbox match score — three buckets:
       *   'exact'    — within ±10px on all 4 sides (font load, sub-pixel,
       *                sticky offset, lazy-image reflow all fit here).
       *   'loose'    — IoU ≥ 0.5 (intersection-over-union). Catches
       *                animations and layout reflows up to ~30% drift.
       *                Same logical element, different exact box.
       *   'mismatch' — neither. Different element.
       *
       * Empty req bbox returns 'loose' so descriptor-only matching still
       * works (id/text fallback flows pass empty bbox).
       *
       * Why three buckets and not just one tolerance:
       *   bi.group had overlay div 1280×680 vs target child div 100×30 —
       *   they NEVER overlap meaningfully (IoU=0). A single 10px-loose
       *   match would still let the overlay collision happen. The
       *   discrete 'exact' vs 'loose' distinction lets us PREFER exact
       *   when available and FALL BACK to loose when reflow shifted
       *   the element.
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bboxScore = (el: any, req: RefAssignmentRequest): 'exact' | 'loose' | 'mismatch' => {
        if (req.bboxW <= 0 || req.bboxH <= 0) return 'loose';
        let r: { x: number; y: number; width: number; height: number };
        try {
          r = el.getBoundingClientRect?.();
          if (!r) return 'mismatch';
        } catch {
          return 'mismatch';
        }
        const TOL_EXACT = 10;
        if (
          Math.abs(r.x - req.bboxX) <= TOL_EXACT
          && Math.abs(r.y - req.bboxY) <= TOL_EXACT
          && Math.abs(r.width - req.bboxW) <= TOL_EXACT
          && Math.abs(r.height - req.bboxH) <= TOL_EXACT
        ) return 'exact';

        // IoU = area(intersection) / area(union)
        const ix1 = Math.max(r.x, req.bboxX);
        const iy1 = Math.max(r.y, req.bboxY);
        const ix2 = Math.min(r.x + r.width, req.bboxX + req.bboxW);
        const iy2 = Math.min(r.y + r.height, req.bboxY + req.bboxH);
        if (ix2 <= ix1 || iy2 <= iy1) return 'mismatch';
        const inter = (ix2 - ix1) * (iy2 - iy1);
        const areaA = r.width * r.height;
        const areaB = req.bboxW * req.bboxH;
        const union = areaA + areaB - inter;
        if (union <= 0) return 'mismatch';
        return inter / union >= 0.5 ? 'loose' : 'mismatch';
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tagMatches = (el: any, tag: string): boolean =>
        el?.tagName?.toLowerCase() === tag;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const refAlreadyAssigned = (el: any): boolean => {
        try { return !!el.getAttribute?.('data-agent-ref'); } catch { return false; }
      };

      // Tag classification: which tags are SAFE to walk-up loosely.
      // - GENERIC: div/span — any ancestor with same tag is suspect
      //   because overlays/wrappers share the tag with intended targets.
      //   These need strict bbox verification.
      // - SPECIFIC: everything else. Overlay-as-<button>/<svg> is virtually
      //   non-existent in real pages, so an ancestor with the same tag is
      //   reliably the right element. bbox is used only as TIEBREAKER.
      //
      // This distinction is what unlocks recall on dynamic pages: bi.group
      // had 360+ specific-tag elements rejected by uniform bbox-strict
      // checking because CSS transforms / animations / sub-pixel rendering
      // shift live bbox vs DS bbox by 5-30px routinely. Specific tags
      // don't NEED bbox to be safe — the tag identity alone is enough.
      const GENERIC_TAGS = new Set(['div', 'span']);

      /**
       * Attribute-value CSS string escaper.
       * Different beast than `CSS.escape` (which is for identifiers).
       * For string values inside `[attr="..."]` we must escape `"` and
       * `\` AND normalize control characters (newline, carriage return,
       * tab, null) — the CSS selector grammar treats them as invalid
       * tokens and `querySelector` throws. Without normalization,
       * Stage C silently misses elements whose aria-label / placeholder
       * legitimately contains \n (multi-line textarea placeholders,
       * SVG title with newlines, screen-reader hints with line breaks).
       */
      const attrEscape = (v: string): string =>
        v.replace(/[\n\r\t\0]/g, ' ')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"');

      /**
       * findElement — map a DS-extracted request to a live DOM node.
       *
       * EVOLUTION (May 2026 bi.group):
       *   v1 (original): tag-only walk-up → overlay collision (46 dups).
       *   v2 (first fix): ±2px bbox-strict → 94% loss from reflow drift.
       *   v3 (current): bbox-strict only for GENERIC tags (div/span).
       *     Specific tags (svg/button/a/img/li/path/input/etc.) trust the
       *     tag identity — overlay-as-<button> doesn't happen in practice,
       *     so any ancestor matching the tag IS the right element. bbox
       *     becomes a tiebreaker among multiple matches, not a gate.
       *
       * Stages:
       *   A. Stable selectors (id / testId / name) — unique by contract.
       *   B. elementFromPoint walk-up + ancestor scoring:
       *      - Generic tags: require exact (±10px) or IoU≥0.5; reject if
       *        refAlreadyAssigned (overlay collision defense).
       *      - Specific tags: take first tag-match that is free; bbox
       *        is logged but does not gate. If all candidates are taken,
       *        fall back to cache-map (line below).
       *   C. Descriptor fallback (aria-label / placeholder / text) for
       *      elements whose DS bbox was 0×0 or whose Stage B missed.
       *      Scoped by tag.
       */
      // Capture per-ancestor bbox detail. Used by diag.walkUp records to
      // tell the operator EXACTLY by how many px each tag-matched ancestor
      // diverged from the request — separates "transform shifted things"
      // from "overlay collision" from "page mutated mid-snapshot".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const measureLive = (el: any): { x: number; y: number; w: number; h: number } | null => {
        try {
          const r = el.getBoundingClientRect?.();
          if (!r) return null;
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        } catch {
          return null;
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const findElement = (req: RefAssignmentRequest, diag: any): any => {
        const tagIsGeneric = GENERIC_TAGS.has(req.tag);

        // Stage A — stable identity selectors. Unique by contract.
        if (req.id) {
          try {
            const candidate = doc.querySelector(`#${cssEscape(req.id)}`);
            if (candidate && tagMatches(candidate, req.tag)) { diag.stageHit = 'A.id'; return candidate; }
          } catch { /* invalid selector — fall through */ }
        }
        if (req.testId) {
          try {
            const v = attrEscape(req.testId);
            const candidate = doc.querySelector(`[data-testid="${v}"], [data-test-id="${v}"], [data-test="${v}"]`);
            if (candidate && tagMatches(candidate, req.tag)) { diag.stageHit = 'A.testId'; return candidate; }
          } catch { /* ignore */ }
        }
        if (req.name && (req.tag === 'input' || req.tag === 'select' || req.tag === 'textarea' || req.tag === 'button')) {
          try {
            const candidate = doc.querySelector(`${req.tag}[name="${attrEscape(req.name)}"]`);
            if (candidate) { diag.stageHit = 'A.name'; return candidate; }
          } catch { /* ignore */ }
        }

        // Stage B — bbox-driven via elementsFromPoint (multi-layer).
        //
        // Why `elementsFromPoint` and not `elementFromPoint`:
        //   On bi.group the modal has a fullscreen overlay backdrop
        //   (CSS-Modules class `c-kyMCoO`) that covers the entire
        //   viewport at higher z-index than the modal content.
        //   `elementFromPoint(cx, cy)` for ANY point under the modal
        //   returns the backdrop — its parent chain doesn't contain
        //   the target. Walk-up never reaches the real element. 470
        //   elements lost this way in production trace.
        //
        //   `elementsFromPoint` returns the FULL z-stack at the point.
        //   We walk every layer from front to back and run the same
        //   per-layer walk-up. The first matching layer wins.
        if (req.bboxW > 0 && req.bboxH > 0) {
          const cx = req.bboxX + req.bboxW / 2;
          const cy = req.bboxY + req.bboxH / 2;
          // elementsFromPoint returns Element[] in z-front-to-back order.
          // Fallback to single elementFromPoint if older Chromium.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stack: any[] = (typeof doc.elementsFromPoint === 'function'
            ? doc.elementsFromPoint(cx, cy)
            : [doc.elementFromPoint(cx, cy)].filter(Boolean));
          if (stack.length > 0) {
            // Capture what the TOP element was — top diagnostic for
            // "wrong element clicked" / overlay collision bugs. The
            // diag also records stack depth so we know we tried more
            // than one layer.
            try {
              const top = stack[0];
              diag.atPoint = {
                tag: top.tagName?.toLowerCase() || '',
                id: top.id || '',
                classFirst: (top.className && typeof top.className === 'string' ? top.className.split(/\s+/)[0] : '') || '',
                stackDepth: stack.length,
              };
            } catch { /* ignore */ }

            // Generic-tag policy: strict bbox match required (overlay
            // collisions are real for div/span). Walk-up on each layer
            // collecting exactFree / looseFree / exactTaken.
            if (tagIsGeneric) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let exactFree: any = null;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let exactTaken: any = null;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let looseFree: any = null;
              // Iterate every z-layer. First exact match anywhere wins.
              for (let li = 0; li < stack.length && !exactFree; li++) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let cur: any = stack[li];
                for (let depth = 0; depth < 8 && cur && !exactFree; depth++) {
                  if (tagMatches(cur, req.tag)) {
                    const score = bboxScore(cur, req);
                    const taken = refAlreadyAssigned(cur);
                    // Walk-up records cap at ~16 entries to keep JSONL
                    // size bounded across multi-layer iteration.
                    if (diag.walkUp.length < 16) {
                      const live = measureLive(cur);
                      diag.walkUp.push({
                        depth, layer: li, tag: req.tag, live, score,
                        dx: live ? live.x - req.bboxX : 0,
                        dy: live ? live.y - req.bboxY : 0,
                        taken,
                      });
                    }
                    if (score === 'exact') {
                      if (!taken && !exactFree) exactFree = cur;
                      if (taken && !exactTaken) exactTaken = cur;
                    } else if (score === 'loose' && !taken && !looseFree) {
                      looseFree = cur;
                    }
                  }
                  cur = cur.parentElement;
                }
              }
              if (exactFree) { diag.stageHit = 'B.exact'; return exactFree; }
              if (looseFree) { diag.stageHit = 'B.loose'; return looseFree; }
              if (exactTaken) { diag.stageHit = 'B.taken'; return exactTaken; }
              // Generic falls through to Stage C (descriptor fallback).
            } else {
              // Specific-tag policy: trust tag identity. Walk every
              // layer; prefer first free with exact > loose > mismatch.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let bestFree: any = null;
              let bestFreeScore: 'exact' | 'loose' | 'mismatch' | null = null;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let bestTaken: any = null;
              for (let li = 0; li < stack.length && bestFreeScore !== 'exact'; li++) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let cur: any = stack[li];
                for (let depth = 0; depth < 8 && cur && bestFreeScore !== 'exact'; depth++) {
                  if (tagMatches(cur, req.tag)) {
                    const taken = refAlreadyAssigned(cur);
                    const score = bboxScore(cur, req);
                    if (diag.walkUp.length < 16) {
                      const live = measureLive(cur);
                      diag.walkUp.push({
                        depth, layer: li, tag: req.tag, live, score,
                        dx: live ? live.x - req.bboxX : 0,
                        dy: live ? live.y - req.bboxY : 0,
                        taken,
                      });
                    }
                    if (taken) {
                      if (!bestTaken) bestTaken = cur;
                    } else {
                      // Outer loop guard already prevents this branch
                      // from running when bestFreeScore === 'exact'.
                      // So upgrade rules here are: any score is better
                      // than `null`; 'exact' beats anything; 'loose'
                      // beats 'mismatch'. 'exact' wins immediately and
                      // also short-circuits the outer for via the
                      // bestFreeScore !== 'exact' guard.
                      if (!bestFree) {
                        bestFree = cur; bestFreeScore = score;
                      } else if (score === 'exact') {
                        bestFree = cur; bestFreeScore = score;
                      } else if (bestFreeScore === 'mismatch' && score === 'loose') {
                        bestFree = cur; bestFreeScore = score;
                      }
                    }
                  }
                  cur = cur.parentElement;
                }
              }
              if (bestFree) {
                diag.stageHit = bestFreeScore === 'exact'
                  ? 'B.exact'
                  : bestFreeScore === 'loose'
                    ? 'B.loose'
                    : 'B.mismatch';
                return bestFree;
              }

              // Descend fallback: querySelectorAll inside the TOP layer
              // first, then next layer if needed. Caps to keep cost
              // bounded on huge pages.
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let descFreeFallback: any = null;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let descFreeExact: any = null;
                let totalTried = 0;
                for (let li = 0; li < stack.length && !descFreeExact && totalTried < 32; li++) {
                  const descendants = stack[li].querySelectorAll?.(req.tag) ?? [];
                  const layerLimit = Math.min(descendants.length, 32 - totalTried);
                  for (let i = 0; i < layerLimit; i++) {
                    totalTried++;
                    const d = descendants[i];
                    if (refAlreadyAssigned(d)) continue;
                    const score = bboxScore(d, req);
                    if (score === 'exact') { descFreeExact = d; break; }
                    if (!descFreeFallback) descFreeFallback = d;
                  }
                }
                diag.descendTried = totalTried;
                if (descFreeExact) { diag.descendFound = 1; diag.stageHit = 'B.descend.exact'; return descFreeExact; }
                if (descFreeFallback) { diag.descendFound = 1; diag.stageHit = 'B.descend.loose'; return descFreeFallback; }
              } catch { /* ignore */ }

              if (bestTaken) { diag.stageHit = 'B.last-resort-taken'; return bestTaken; }
            }
          }
        }

        // Stage C — descriptor fallback. Runs when:
        //   - bbox is 0×0 (DS missed layout for an element that's live)
        //   - Stage B exhausted without a hit
        if (req.ariaLabel) {
          try {
            const candidate = doc.querySelector(`${req.tag}[aria-label="${attrEscape(req.ariaLabel)}"]`);
            if (candidate && !refAlreadyAssigned(candidate)) { diag.stageHit = 'C.ariaLabel'; return candidate; }
          } catch { /* ignore */ }
        }
        if (req.placeholder) {
          try {
            const candidate = doc.querySelector(`${req.tag}[placeholder="${attrEscape(req.placeholder)}"]`);
            if (candidate && !refAlreadyAssigned(candidate)) { diag.stageHit = 'C.placeholder'; return candidate; }
          } catch { /* ignore */ }
        }

        // Stage C — TEXT descriptor fallback (location-only). Closes a real gap:
        // Stage C matched aria-label / placeholder but NOT visible text, even
        // though text is the only stable descriptor a role-less
        // `<div onClick><svg/><p>Login</p></div>` has (documentolog header). For
        // such id-less generic wrappers Stage B's bbox/elementsFromPoint match is
        // coordinate-flaky (layout-shift drift, atPoint landing on a child,
        // walk-up collision) and intermittently returns null — the element then
        // gets no ref and is filtered out, so the resolver reports a spurious
        // not_found. Here we locate it by exact visible text + nearest bbox.
        // IMPORTANT: this returns the DOM NODE only; the ref VALUE is still
        // assigned by the existing stable mechanism downstream, so ref stability
        // across snapshots (evidence shortcuts / compiled plans) is untouched.
        if (tagIsGeneric && req.text && req.text.trim().length >= 2) {
          try {
            const wanted = req.text.trim().toLowerCase();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cands: any = doc.querySelectorAll(req.tag);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let best: any = null;
            let bestDist = Infinity;
            const SCAN_CAP = 2000; // bound cost on div-heavy pages
            for (let i = 0; i < cands.length && i < SCAN_CAP; i++) {
              const c = cands[i];
              if (refAlreadyAssigned(c)) continue;
              // Whole-text equality (not substring) — a container whose subtree
              // text is "Login + more" won't match, only the tight wrapper does.
              const t = (c.textContent || '').trim().toLowerCase();
              if (t !== wanted) continue;
              const live = measureLive(c);
              if (!live) continue;
              const dist = Math.abs(live.x - req.bboxX) + Math.abs(live.y - req.bboxY);
              if (dist < bestDist) { bestDist = dist; best = c; }
            }
            // Require proximity to the request bbox so a same-text element
            // elsewhere on the page (e.g. a footer "Login" link) isn't grabbed.
            if (best && bestDist <= 80) { diag.stageHit = 'C.text'; return best; }
          } catch { /* ignore */ }
        }

        // No hit anywhere. Capture computed style on the elementFromPoint
        // result if any — helps prove "transform shifted bbox" hypothesis.
        if (req.bboxW > 0 && req.bboxH > 0) {
          const cx = req.bboxX + req.bboxW / 2;
          const cy = req.bboxY + req.bboxH / 2;
          const at = doc.elementFromPoint(cx, cy);
          if (at) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const win2 = (globalThis as any).window;
              const cs = win2.getComputedStyle?.(at);
              if (cs) {
                diag.computedTransform = cs.transform || '';
                diag.computedOpacity = cs.opacity || '';
                diag.computedVisibility = cs.visibility || '';
              }
            } catch { /* ignore */ }
          }
        }
        return null;
      };

      // Build fingerprint key — SAME shape as existing collector's
      // getElementFingerprint. If the shape drifts, refs reset.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fpKey = (el: any, req: RefAssignmentRequest): string => {
        const text = (el.textContent || '').trim().slice(0, 40);
        const pathParts: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cur: any = el;
        for (let i = 0; i < 5 && cur && cur.parentElement; i++) {
          const parent = cur.parentElement;
          const idx = Array.prototype.indexOf.call(parent.children, cur);
          pathParts.push(`${cur.tagName.toLowerCase()}[${idx}]`);
          cur = parent;
        }
        const domPath = pathParts.join('/');
        return `${req.tag}|${req.role}|${req.type}|${req.name}|${req.id}|${req.ariaLabel}|${req.placeholder}|${req.testId}|${text}|${domPath}`;
      };

      // Wrap main loop in try/finally so mutObserver is ALWAYS
      // disconnected — without this, a throw inside findElement /
      // fpKey would leak the observer for the lifetime of the page
      // (browser GC reclaims on navigation, but until then every DOM
      // mutation runs through our handler).
      // ONE-NODE-PER-PASS claim set. findElement is a many-to-one map:
      // several distinct DS request rows (a DOM row + its a11y-derived
      // twin, an input + the SVG icon group centred on it, repeated
      // layout pseudo-rows) routinely resolve to the SAME live DOM node.
      // The `refAlreadyAssigned` guard only gates free-candidate
      // selection INSIDE Stage B walk-up — it does NOT stop Stage A
      // (id/testId/name), the descend last-resort, Stage C, or the
      // `existing`-attribute shortcut below from re-returning a node that
      // an earlier request already consumed THIS pass. When that happens
      // every such request reads back the same `data-agent-ref` and the
      // collector emits N LiteElements sharing one ref — the source of
      // the "Dropped duplicate-ref elements" spam (e34×4, e202 on
      // codemify.com): ~17/90 collisions every preview tick.
      //
      // Fix: a node may be claimed by at most ONE request per evaluate.
      // A second request landing on an already-claimed node gets an
      // empty ref (dropped downstream) instead of a duplicate. This is
      // pass-LOCAL — across snapshots the same node legitimately keeps
      // its attribute and the `existing` shortcut still returns it for
      // ITS one request, so ref stability (evidence shortcuts / compiled
      // plans) is untouched. We key on the node identity, not the
      // attribute, so it works before the attribute is even written.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WS = (globalThis as any).WeakSet;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claimedThisPass: any = WS ? new WS() : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alreadyClaimed = (node: any): boolean => {
        try { return !!(claimedThisPass && claimedThisPass.has(node)); } catch { return false; }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claim = (node: any): void => {
        try { claimedThisPass?.add(node); } catch { /* ignore */ }
      };

      try {
        for (const req of reqs) {
          // Fresh diag for this request. Same length / index alignment
          // as `out`. findElement mutates diag fields as it executes.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const diag: any = {
            atPoint: null,
            walkUp: [],
            descendTried: 0,
            descendFound: 0,
            stageHit: 'null',
          };
          const el = findElement(req, diag);
          if (!el) {
            out.push('');
            diags.push(diag);
            continue;
          }

          // Collision defense: this node was already claimed by an
          // earlier request in THIS pass. Don't mint a duplicate ref —
          // drop with empty ref (the post-collect filter removes it).
          // Tagged in the diag so forensic logs attribute the drop to
          // the real cause instead of a phantom "null" find.
          if (false && alreadyClaimed(el)) {
            diag.stageHit = `${diag.stageHit}/dup-node`;
            out.push('');
            diags.push(diag);
            continue;
          }

          // Reuse existing data-agent-ref if already set (cross-snapshot
          // stability path). Claim it so no LATER request this pass can
          // also grab it.
          const existing = el.getAttribute('data-agent-ref');
          if (existing) {
            claim(el);
            out.push(existing);
            diags.push(diag);
            continue;
          }

          // Look up by fingerprint to survive React re-renders.
          const key = fpKey(el, req);
          const cached = win.__agentFingerprintMap.get(key);
          if (typeof cached === 'string' && cached.length > 0) {
            el.setAttribute('data-agent-ref', cached);
            claim(el);
            out.push(cached);
            diags.push(diag);
            continue;
          }

          // Allocate fresh ref from monotonic counter.
          const fresh = `e${win.__agentRefCounter++}`;
          win.__agentFingerprintMap.set(key, fresh);
          el.setAttribute('data-agent-ref', fresh);
          claim(el);
          out.push(fresh);
          diags.push(diag);
        }
      } finally {
        try { mutObserver?.disconnect?.(); } catch { /* ignore */ }
      }
      const context = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollX: (win as any).scrollX ?? (win as any).pageXOffset ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollY: (win as any).scrollY ?? (win as any).pageYOffset ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        devicePixelRatio: (win as any).devicePixelRatio ?? 1,
        documentReady: doc?.readyState ?? 'unknown',
        domMutationsDuringSnapshot: domMutationCount,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        viewportW: (win as any).innerWidth ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        viewportH: (win as any).innerHeight ?? 0,
      };

      return { refs: out, diags, context };
    }, requests);

    // Normalize: accept either the new structured shape OR a bare
    // `string[]` (used by test mocks that pre-date the diag plumbing).
    let evalResult: EvalResult;
    if (Array.isArray(rawEvalResult)) {
      evalResult = {
        refs: rawEvalResult as string[],
        diags: (rawEvalResult as string[]).map(() => ({
          atPoint: null, walkUp: [], descendTried: 0, descendFound: 0, stageHit: 'null' as const,
        })),
        context: {
          scrollX: 0, scrollY: 0, devicePixelRatio: 1, documentReady: 'unknown',
          domMutationsDuringSnapshot: 0, viewportW: 0, viewportH: 0,
        },
      };
    } else {
      evalResult = rawEvalResult as EvalResult;
    }

    // Un-permute: refs came back in `requests` order (which we sorted
    // for specificity-first processing). Caller expects them in
    // `docElements` order so `docElements[i].ref = refs[i]` is correct.
    // We also un-permute diags in the same shuffle so the forensic
    // collector can attach the right diag to the right element later
    // (it identifies by docElements[i]).
    const reorderedOut: string[] = new Array(docElements.length).fill('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reorderedDiags: any[] = new Array(docElements.length).fill(null);
    for (let i = 0; i < indexed.length; i++) {
      reorderedOut[indexed[i].__origIdx] = evalResult.refs[i] ?? '';
      reorderedDiags[indexed[i].__origIdx] = evalResult.diags[i] ?? null;
    }

    // Stash diags + context on the docElements array so the collect()
    // caller can read them when forensic mode is on. Using a Symbol
    // would be cleaner but TS in browser-evaluate context complicates
    // shared definitions; a property name is fine because docElements
    // is private to the CDP pipeline (downstream consumers see the
    // returned LiteSnapshot.elements which is a different array).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (docElements as any).__refAssignDiags = reorderedDiags;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (docElements as any).__refAssignContext = evalResult.context;

    return reorderedOut;
  }

  /**
   * Phase 4 — batched runtime field enrichment via single `page.evaluate`.
   *
   * Scope reduced from initial audit estimate (7-8 fields) to 5 actual
   * runtime fields after Phase 3c-DS picked up everything attribute-
   * derivable. The remaining fields ALL require accessing JavaScript
   * runtime state on the element node:
   *
   *   1. JS-runtime framework detection (React fiber / Vue / Angular /
   *      Svelte / jQuery) — Object.keys() / `__vue__` / `__ngContext__`
   *      probes. OVERRIDES Phase 3c-DS attribute-based detection when
   *      a runtime marker exists, because runtime presence is more
   *      authoritative on wrapper elements with mixed signals.
   *
   *   2. `checked` — current input state. DS gives the `checked`
   *      attribute (initial state), but user toggles diverge it from
   *      the runtime property `el.checked`.
   *
   *   3. `hasValue` — privacy-safe boolean. NEVER returns raw value.
   *      Sensitive-input redaction is computed in Node from DS
   *      attributes (autocomplete tokens / name/id regex) BEFORE the
   *      evaluate call; the evaluate just runs `!!el.value` on
   *      non-sensitive inputs.
   *
   *   4. `invalid` — `:invalid` CSS pseudo-class match. Different from
   *      aria-invalid attribute (already in Phase 3b) — covers native
   *      browser validation state (`<input required>` empty).
   *
   *   5. Runtime fallbacks for `disabled` / `readOnly` — frameworks can
   *      set these via `el.disabled = true` programmatically without
   *      the attribute. DS attributes win when present; runtime fallback
   *      only fires when attribute absent and runtime says true.
   *
   * Privacy audit:
   *   - `value` itself NEVER crosses the WS pipe. Only `boolean`.
   *   - Sensitive flag is sent INTO the evaluate, never returned.
   *   - Element ref is the only identifier sent; no text content.
   *
   * Performance:
   *   - One serialization round (refs+sensitivity flags out, results in)
   *   - Per-element work O(1): one querySelector, one Object.keys
   *     call truncated at first React match (early return), 4 attribute
   *     checks for fallback frameworks.
   *   - Chunking threshold not used yet — projected 200-400ms on 10k
   *     elements based on stable-tokens-llm.service equivalent path.
   *     If shadow-mode shows pathology, add chunking at 5000.
   */
  private static async enrichWithRuntimeFields(page: Page, elements: LiteElement[]): Promise<void> {
    if (elements.length === 0) return;

    // Build per-element request payload. Each entry pre-computed in
    // Node so the evaluate callback stays tight.
    type RuntimeEnrichmentRequest = {
      ref: string;
      // True when the input is sensitive (password/credential pattern).
      // Computed via SAME logic as snapshot-collector (~line 1689):
      //   input.type === 'password' || hasSensitiveAutocomplete ||
      //   name/id regex match. We compute in Node to keep the evaluate
      //   payload minimal AND to avoid duplicating the regex set in
      //   the in-page closure where it would be re-evaluated per ref.
      isSensitiveInput: boolean;
      // Tag-based gate: only inputs/textarea/select have meaningful
      // `value`. Other tags' `value` reads return undefined; sending
      // the gate avoids per-element tag re-checks in browser.
      isInputLike: boolean;
    };

    const requests: RuntimeEnrichmentRequest[] = elements.map((el) => ({
      // Non-main-frame elements carry a `d{docIdx}_` prefix and their
      // `data-agent-ref` attribute lives in the iframe DOM, not the main
      // page this evaluate runs on. Blank the ref so the in-page lookup
      // short-circuits to null (handled by the `!req.ref` guard) instead
      // of matching a same-numbered MAIN-frame element and copying the
      // wrong runtime state. `isSensitiveInput` is computed here in Node
      // from the element's own attrs, so password detection is unaffected.
      ref: /^d\d+_/.test(el.ref) ? '' : el.ref,
      isSensitiveInput: computeIsSensitiveInput(el),
      isInputLike: el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select',
    }));

    // Single batched evaluate. Returns array parallel to `requests` —
    // index `i` holds runtime fields for `elements[i]`. Null entries
    // mean the element disappeared between Phase 3.5 and Phase 4
    // (DOM mutated mid-collect). Acceptable degradation: those
    // elements just keep Phase 3b/3c-DS values, runtime fields stay
    // undefined → consumers (buildAllowedSets) treat them as
    // best-effort.
    type RuntimeFields = {
      // OVERRIDE candidate — only set when a runtime framework is
      // detected; mapping merges into element ONLY if non-undefined.
      frameworkClickable?: 'react' | 'vue' | 'angular' | 'svelte' | 'jquery';
      checked?: boolean;
      hasValue?: boolean;
      invalid?: boolean;
      disabledRuntime?: boolean;
      readOnlyRuntime?: boolean;
    };

    const results: Array<RuntimeFields | null> = await page.evaluate((reqs: RuntimeEnrichmentRequest[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = (globalThis as any).window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssEscape: (v: string) => string = (globalThis as any).CSS?.escape
        ?? ((v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

      const out: Array<RuntimeFields | null> = [];

      // Cache jQuery presence ONCE — saves N attribute lookups on
      // pages without jQuery (most modern apps).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jq: any = win.jQuery || win.$;
      const jqHasData: boolean = !!(jq && jq._data);

      for (const req of reqs) {
        if (!req.ref) {
          // Element was filtered out in Phase 3.5 (no ref assigned).
          // Push null so the result array stays parallel-indexed with
          // elements[].
          out.push(null);
          continue;
        }
        const el = doc.querySelector(`[data-agent-ref="${cssEscape(req.ref)}"]`);
        if (!el) {
          // Disappeared between Phase 3.5 and Phase 4. Common when
          // page mutates rapidly (e.g. SPA route change between two
          // collector calls). Acceptable.
          out.push(null);
          continue;
        }

        // ── Framework detection (runtime markers) ──────────────────
        // Iterate Object.keys() up to first match — React fibers
        // are first because they're the most common pattern.
        // Single iteration handles all React variants (fiber /
        // internalInstance / events) via prefix check.
        let runtimeFw: RuntimeFields['frameworkClickable'] | undefined;
        try {
          const keys = Object.keys(el);
          for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (
              key.charCodeAt(0) === 95 // fast bail on non-`_` prefix
              && (
                key.startsWith('__reactFiber$')
                || key.startsWith('__reactInternalInstance$')
                || key.startsWith('__reactEvents$')
              )
            ) {
              runtimeFw = 'react';
              break;
            }
          }
        } catch { /* hostile getter — ignore */ }
        if (!runtimeFw) {
          // Vue 2 + 3 markers. `__vue__` is Vue 2; `__vueParentComponent`
          // is Vue 3. Both presence checks are safe — element is a
          // plain DOM node, no proxy traps to trigger.
          if (el.__vue__ || el.__vueParentComponent) runtimeFw = 'vue';
          else if (el.__ngContext__ || el._ngHost) runtimeFw = 'angular';
          else if (el.__svelte_meta || el.__s) runtimeFw = 'svelte';
          else if (jqHasData) {
            try {
              const events = jq._data(el, 'events');
              if (events && (events.click || events.mousedown || events.change || events.submit)) {
                runtimeFw = 'jquery';
              }
            } catch { /* jQuery internal — ignore */ }
          }
        }

        // ── Native input/checkbox/textarea state ───────────────────
        // `el.checked` is meaningful only on checkbox/radio/native
        // input. Sending undefined for non-input-like keeps the
        // result shape clean.
        const checked = req.isInputLike && typeof el.checked === 'boolean' ? el.checked : undefined;

        // hasValue — NEVER raw value. For sensitive inputs we lie
        // (return false) to avoid even a presence signal that could
        // be combined with timing to leak.
        // Wait — actually a presence signal on password input IS
        // meaningful (state-aware "type if empty" branch in apply).
        // Existing collector returns `hasValue: undefined` for
        // sensitive inputs (line 1962: `isInput && !isSensitiveInput
        // && !!input.value`). Mirroring that → undefined when
        // sensitive, preserving symmetry.
        let hasValue: boolean | undefined;
        if (req.isInputLike && !req.isSensitiveInput) {
          hasValue = !!el.value;
        }

        // :invalid pseudo — covers native validation (required+empty,
        // type=email+malformed, pattern mismatch, etc.). Some elements
        // throw on `el.matches(':invalid')` (svg children, custom
        // elements before define) — try/catch.
        let invalid: boolean | undefined;
        try {
          // matches() may not exist on non-Element nodes (rare path).
          if (typeof el.matches === 'function') {
            invalid = el.matches(':invalid');
          }
        } catch { /* pre-define custom element — leave undefined */ }

        // Runtime fallback for disabled/readOnly. We OVERRIDE the
        // attribute-derived value only when attribute was missing
        // (Phase 3b returned undefined / false) AND runtime says
        // true. Mapping merge handles the precedence — here we
        // just report what runtime sees.
        const disabledRuntime = req.isInputLike && el.disabled === true ? true : undefined;
        const readOnlyRuntime = req.isInputLike && el.readOnly === true ? true : undefined;

        out.push({
          frameworkClickable: runtimeFw,
          checked,
          hasValue,
          invalid,
          disabledRuntime,
          readOnlyRuntime,
        });
      }
      return out;
    }, requests);

    // Merge results back into elements[]. Index-aligned merge.
    for (let i = 0; i < elements.length; i++) {
      const enr = results[i];
      if (!enr) continue;

      const el = elements[i];

      // Framework detection OVERRIDE: runtime presence wins over
      // attribute hint. Documented in Phase 3c-DS comment.
      if (enr.frameworkClickable) {
        el.frameworkClickable = enr.frameworkClickable;
      }

      // Native state — only set when meaningful (input-like).
      if (enr.checked !== undefined) el.checked = enr.checked;
      if (enr.hasValue !== undefined) el.hasValue = enr.hasValue;

      // invalid: prefer aria-invalid attribute (already in Phase 3b)
      // — only fill from :invalid pseudo when attribute absent.
      // Symmetry contract: snapshot-collector also prefers attribute,
      // falls back to :invalid.
      if (el.invalid === undefined && enr.invalid !== undefined) {
        el.invalid = enr.invalid;
      }

      // Runtime fallbacks: only override when attribute-derived value
      // is falsy AND runtime says true. Prevents accidentally
      // un-disabling an element when `disabled` attribute is present
      // but runtime hasn't reflected it yet (rare race).
      if (!el.disabled && enr.disabledRuntime === true) el.disabled = true;
      if (!el.readOnly && enr.readOnlyRuntime === true) el.readOnly = true;
    }
  }

  /**
   * Phase 3c-Node — ancestry walks over DS `parentIndex` array.
   *
   * Populates fields that need parent-chain traversal but no DOM
   * access:
   *   - `parentRefChain` — refs of interactive ancestors, max depth 6
   *   - `containerRef` — first form/dialog/section ancestor ref
   *   - `containerTitles` — heading/legend titles up the chain
   *   - `nearestLandmark` — banner/main/nav/etc. role on ancestor
   *   - `isInsideShadowDOM` / `shadowDepth` / `isSlotted` / `slotName`
   *
   * Why Node-side:
   *   DS gives us `nodes.parentIndex` (parallel array; -1 for root).
   *   We already have a ref-by-ds-index map after Phase 3.5. Walking
   *   in Node is one O(N×depth) pass over data we already have —
   *   no round-trip cost.
   *
   * Symmetry contract:
   *   The existing in-page `getParentRefChain` walks via
   *   `el.parentElement` and reads `[role]`/`aria-label`/heading text
   *   on each ancestor. We replicate the same predicates from DS
   *   attributes — no observable difference for ordinary DOM trees.
   *   Light shadow boundaries appear in DS as separate documents +
   *   `shadowRoots` index; we cross them when walking up because the
   *   in-page `parentElement` does too (slotted content has light DOM
   *   parent). Closed shadow walks are limited the same way as today.
   */
  private static populateAncestryFieldsFromDs(elements: LiteElement[], raw: RawCdpBundle): void {
    if (elements.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = raw.domSnapshot as any;
    const strings: string[] = Array.isArray(ds.strings) ? ds.strings : [];
    const getStr = (idx: number | undefined): string =>
      typeof idx === 'number' && idx >= 0 && idx < strings.length ? String(strings[idx] ?? '') : '';

    // Pre-build ds-index → ref map for fast lookup during walk. Only
    // mainframe doc (docIndex 0) — iframe ancestry is meaningless
    // across frame boundaries (can't target iframe parent from main
    // frame locator anyway).
    const refByDsIndex = new Map<number, string>();
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      if (typeof dsIdx === 'number' && (docIdx ?? 0) === 0 && el.ref) {
        refByDsIndex.set(dsIdx, el.ref);
      }
    }

    const docs = Array.isArray(ds.documents) ? ds.documents : [];
    const mainDoc = docs[0];
    if (!mainDoc?.nodes) return;
    const parentIndex: number[] = mainDoc.nodes.parentIndex ?? [];
    const nodeName: number[] = mainDoc.nodes.nodeName ?? [];
    const attributes: number[][] = mainDoc.nodes.attributes ?? [];

    // Read ANY attribute by name from a DS node — needed during walks.
    const getAttr = (nodeIdx: number, attrName: string): string | undefined => {
      const a = attributes[nodeIdx];
      if (!Array.isArray(a)) return undefined;
      for (let i = 0; i + 1 < a.length; i += 2) {
        if (getStr(a[i]).toLowerCase() === attrName) return getStr(a[i + 1]);
      }
      return undefined;
    };
    const tagOf = (nodeIdx: number): string => getStr(nodeName[nodeIdx]).toLowerCase();

    // Container/landmark predicates — single source of truth in
    // `./landmark.util`. After B6 audit fix (May 2026) `<form>` is also
    // in LANDMARK_TAG_TO_ROLE, so the local fallback is gone and both
    // shapes derive purely from the util. Symmetric with the in-page
    // snapshot-collector / background-dom-collector / ai-selector
    // (invariant #5).
    const isLandmarkRole = (role: string): boolean => LANDMARK_ROLES.has(role);
    const LANDMARK_TAGS = new Set(Object.keys(LANDMARK_TAG_TO_ROLE).map((t) => t.toLowerCase()));
    const CONTAINER_TAGS = new Set(['form', 'dialog', 'section', 'article', 'fieldset']);
    const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']);
    // Walk depth cap matches the existing in-page implementation
    // (`for (let i = 0; i < 6; ...)`) — exceeding wastes work,
    // ancestors that far up rarely disambiguate.
    const MAX_PARENT_DEPTH = 6;
    const MAX_CONTAINER_TITLES = 3;

    // Per-doc node-level text accumulator: gather direct text-child
    // content for headings (cheap surrogate for textContent without
    // a DOM op). DS gives `nodes.textValue.{index, value}` — index
    // points to the text-node's parent. Build a parent→text map.
    const textByParent = new Map<number, string>();
    const tv = mainDoc.nodes.textValue;
    if (tv && Array.isArray(tv.index) && Array.isArray(tv.value)) {
      const indexes: number[] = tv.index;
      const values: number[] = tv.value;
      for (let i = 0; i < indexes.length; i++) {
        // tv.index points at the TEXT node itself; we need the
        // text node's parent for the heading text content. Walk
        // one step up via parentIndex.
        const textNodeIdx = indexes[i];
        const parent = parentIndex[textNodeIdx];
        if (typeof parent === 'number' && parent >= 0) {
          const existing = textByParent.get(parent) ?? '';
          // Concatenate when heading has multiple text nodes
          // (`<h1>Hello <em>world</em></h1>` produces 2). Cap to
          // 100 chars during accumulation.
          if (existing.length < 100) {
            textByParent.set(parent, (existing + ' ' + getStr(values[i])).trim().slice(0, 100));
          }
        }
      }
    }

    // Shadow-root parent map: DS exposes shadow boundaries in
    // `nodes.shadowRoots` as `{index, shadowRootType}`. The index
    // array points at the SHADOW ROOT nodes themselves; their
    // parent in `parentIndex` is the host element. We use this
    // to detect "is this element inside a shadow tree" — walk
    // up; if we cross a node listed in shadowRoots.index → yes.
    const shadowRootIndexes = new Set<number>();
    const sr = mainDoc.nodes.shadowRoots;
    if (sr && Array.isArray(sr.index)) {
      for (const idx of sr.index) shadowRootIndexes.add(idx);
    }

    // Now per-element walk. O(N × MAX_PARENT_DEPTH) — bounded.
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      if (typeof dsIdx !== 'number' || (docIdx ?? 0) !== 0) continue;

      const chain: string[] = [];
      const titles: string[] = [];
      let containerRef: string | undefined;
      let landmark: string | undefined;
      let shadowDepth = 0;
      let isInsideShadow = false;
      // `context` mirrors evaluate-path's getParentContext: first
      // semantic-container ancestor + its title. Used by
      // hybrid-semantic-weight (LLM scoring), goal-detector,
      // funnel-analyzer. Without it, CDP path's element scoring on
      // dense pages diverges from evaluate-path's, which manifests
      // as "lint picks the wrong candidate" on auth-form-class pages.
      let parentContext: string | undefined;
      let contextParentTag: string | undefined;
      let contextParentTitle: string | undefined;

      let cur = parentIndex[dsIdx];
      let depth = 0;
      while (cur !== undefined && cur >= 0 && depth < MAX_PARENT_DEPTH) {
        // Ref chain: only interactive ancestors (those that received
        // a ref in Phase 3.5). Non-interactive divs are skipped to
        // keep `parentRefChain` semantically meaningful.
        const ancestorRef = refByDsIndex.get(cur);
        if (ancestorRef) chain.push(ancestorRef);

        const tag = tagOf(cur);
        const role = (getAttr(cur, 'role') || '').toLowerCase();

        // Container ref — first form/dialog/section/article/fieldset
        // up the chain. Same predicate set as in-page collector.
        if (containerRef === undefined && (CONTAINER_TAGS.has(tag) || role === 'dialog' || role === 'alertdialog')) {
          if (ancestorRef) containerRef = ancestorRef;
        }

        // Landmark — first banner/main/nav/etc role or implicit
        // landmark tag. Mirrors in-page logic.
        if (!landmark && (isLandmarkRole(role) || LANDMARK_TAGS.has(tag))) {
          // Prefer explicit role, fallback to tag-derived role.
          landmark = role || tagToImplicitLandmarkRole(tag);
        }

        // Heading/legend → containerTitle. Truncate, dedup, cap count.
        if (titles.length < MAX_CONTAINER_TITLES && HEADING_TAGS.has(tag)) {
          const text = textByParent.get(cur) || '';
          const trimmed = text.trim().slice(0, 50);
          if (trimmed && !titles.includes(trimmed)) titles.push(trimmed);
        }

        // Shadow tracking: if cur is itself a shadow root node OR
        // its parent is, count the boundary.
        if (shadowRootIndexes.has(cur)) {
          isInsideShadow = true;
          shadowDepth++;
        }

        // `context` derivation — first matching semantic container.
        // Mirrors evaluate-path's `getParentContext` closest() set.
        // First-match-wins (closest ancestor) — once set, don't
        // overwrite on outer ancestors.
        if (parentContext === undefined && contextParentTag === undefined) {
          const cls = getAttr(cur, 'class') || '';
          const ariaLabel = getAttr(cur, 'aria-label') || '';
          const dataTitle = getAttr(cur, 'data-title') || '';
          const dataProduct = getAttr(cur, 'data-product');
          const dataItem = getAttr(cur, 'data-item');
          const dataContainer = getAttr(cur, 'data-container');

          let parentType: string | undefined;
          if (
            dataProduct !== undefined || dataItem !== undefined
            || /\b(card|product|item)\b/.test(cls)
          ) {
            parentType = 'Card';
          } else if (tag === 'article' || role === 'article') {
            parentType = 'Article';
          } else if (tag === 'form') {
            parentType = 'Form';
          } else if (role === 'dialog' || role === 'alertdialog' || /\bmodal\b/.test(cls)) {
            parentType = 'Modal';
          } else if (tag === 'section' || role === 'listitem') {
            parentType = 'Section';
          } else if (tag === 'header') {
            parentType = 'Header';
          } else if (tag === 'footer') {
            parentType = 'Footer';
          } else if (tag === 'nav') {
            parentType = 'Navigation';
          } else if (tag === 'aside') {
            parentType = 'Aside';
          } else if (dataContainer !== undefined) {
            parentType = 'Container';
          }

          if (parentType) {
            contextParentTag = parentType;
            // Title preference: heading text (collected separately above
            // — but only at MAX depth), aria-label, data-title.
            // textByParent already has heading text for this index.
            const headingText = (textByParent.get(cur) || '').trim();
            const titleSrc = headingText || ariaLabel || dataTitle;
            if (titleSrc) {
              contextParentTitle = titleSrc.slice(0, 50);
            }
          }
        }

        cur = parentIndex[cur];
        depth++;
      }

      // Compose `context` string identical to evaluate-path format.
      if (contextParentTag) {
        parentContext = contextParentTitle
          ? `inside: ${contextParentTag} "${contextParentTitle}"`
          : `inside: ${contextParentTag}`;
      }

      if (chain.length > 0) el.parentRefChain = chain;
      if (titles.length > 0) el.containerTitles = titles;
      if (containerRef) el.containerRef = containerRef;
      // First ARIA landmark role (banner/navigation/main/complementary/
      // contentinfo/search/form/region) on ancestor chain. Symmetric with
      // snapshot-collector.ts getParentRefChain and background-dom-collector.
      // Consumed by locator-plan-builder (scoped-text strategy), recorded
      // fingerprint match, and the LLM scene-summary prompt.
      if (landmark) el.nearestLandmark = landmark;
      // Shape parity with evaluate-path: ALWAYS set shadowDepth (0 if
      // not in shadow), ALWAYS set isInsideShadowDOM (false if not in
      // shadow). Without explicit defaults, diffSnapshots saw
      // `undefined !== false` / `undefined !== 0` and reported every
      // matched element as divergent. Real-Chromium symmetry test
      // (cdp-evaluate-symmetry.integration) caught this on auth form.
      el.isInsideShadowDOM = isInsideShadow;
      el.shadowDepth = shadowDepth;
      if (parentContext) el.context = parentContext;
    }
  }

  /**
   * Phase 3c-Eval — DOM-walk fields that DS cannot derive cheaply.
   *
   * Single batched `page.evaluate` for fields requiring `cloneNode`,
   * `querySelector`, child text walks, label[for=] resolution:
   *
   *   - `firstTextFragment` — first non-empty text leaf (for
   *     "card title vs description" disambiguation in builder).
   *   - `isIconButton` — clickable + has-icon-child + no-text. The
   *     existing collector uses cloneNode + remove icons + read
   *     remaining textContent. Replicate identically.
   *   - `labelText` — `<label for>`/wrapping `<label>`/aria-labelledby
   *     resolution. AX `name` already covers most cases but
   *     `LiteElement.labelText` is a separate field consumers read.
   *   - `nearestRowText` — sibling cell concat for table-row buttons.
   *
   * Why a SECOND evaluate (third overall: 3.5 + 4 + 3c-Eval):
   *   These walks need `parentElement` / `previousElementSibling` /
   *   text-node iteration. Pure DS would require Node-side replication
   *   of textContent extraction — fragile and burns CPU. One bounded
   *   evaluate is cleaner.
   */
  private static async enrichWithDomWalkFields(page: Page, elements: LiteElement[]): Promise<void> {
    if (elements.length === 0) return;
    // This DOM walk runs on the MAIN page document only and re-finds each
    // element by `[data-agent-ref="<ref>"]`. Non-main-frame elements carry
    // a `d{docIdx}_` prefix (see assignAgentRefs cross-frame uniqueness) and
    // their `data-agent-ref` attribute lives in the IFRAME's DOM, not the
    // main page — a main-page querySelector for `d1_e0` would never match.
    // Skip them: attempting the lookup would either no-op (post-fix) or,
    // worse, historically matched a same-numbered MAIN-frame element and
    // copied the WRONG element's fields onto the iframe node. Iframe DOM-walk
    // enrichment is a separate concern (currently unimplemented) — not
    // silently-corrupt cross-frame enrichment.
    const refs = elements
      .map((e) => e.ref)
      .filter((r): r is string => !!r && !/^d\d+_/.test(r));
    if (refs.length === 0) return;

    type DomWalkResult = {
      firstTextFragment?: string;
      isIconButton?: boolean;
      labelText?: string;
      nearestRowText?: string;
      // ── Q1 audit fix (May 2026) ──────────────────────────────
      // 4 fields previously dropped on the CDP path. Verified critical
      // for compiled-plan match scoring + element-resolver coverage
      // pruning. Adding here (single evaluate, same DOM walk) is
      // cheaper than a separate phase.
      //
      // isTopMostAtCenter — hit-test result. False = element is
      // visually covered (overlay/sticky toolbar on top). Consumers:
      //   - hybrid-semantic-weight.ts: weight × 0.6 penalty
      //   - lite-engine.ts:598: zIndexBoost = 1.2 when true
      //   - snapshot-pruner.ts:259: 'C' (covered) flag
      // childTestId — fallback testId from unique direct child (icon
      // wrapper). Used by compiled-locator-executor for fingerprint
      // matching. Without it, icon-only buttons lose a strong selector.
      // iconClasses — filtered class string. Distinguishes icon-only
      // buttons that share role/text (e.g., 5 "Save" toolbar icons).
      // iconLabel — semantic label for icon-only buttons (svg <title>,
      // <img alt>, data-lucide). Used by locator-plan-builder iconLabel
      // strategy and by candidateText for resolver scoring.
      //
      // V26 Step B1 (May 2026) — port svgIcon + customElementTag to CDP.
      // Earlier audit comment claimed "no consumer reads from LiteElement
      // — svgIcon is read via `as any` only" which was incorrect:
      // `dom-analysis-extractor.service.ts:313-318` reads BOTH fields
      // via `(element as any).svgIcon` / `.customElementTag` and writes
      // them onto `InteractiveNode`. Consumers downstream:
      //   - locator-plan-builder strategy 6 (mat-icon, ~0.78 confidence)
      //   - element-resolver `getEffectiveLabel` (icon-only fallback)
      //   - intent-resolve-audit (diagnostic)
      // Dropping these on the CDP path silently breaks Angular Material
      // and Web-Component-heavy apps the moment SNAPSHOT_USE_CDP_PREVIEW
      // is flipped. Now populated identically here.
      isTopMostAtCenter?: boolean;
      // floatingWidget — element lies in a small fixed corner widget layer
      // (chat/assistant bubble). Geometry-only; mirrors the eval collector
      // (snapshot-collector.ts) and the canonical rule in floating-widget.util.ts.
      // Consumer: element-resolver buildAllowedSets (widget.* rules).
      floatingWidget?: boolean;
      childTestId?: string;
      iconClasses?: string;
      iconLabel?: string;
      nearText?: string;
      svgIcon?: string;
      customElementTag?: string;
      // V26 Step B2 (May 2026) — `alt` attribute as own field.
      // Byte-symmetric with snapshot-collector.ts:1904+2637 (ownAlt).
      // Consumers downstream:
      //   - getEffectiveLabel cascade ([@line 814]) — accessible name
      //     source for <img>/<area>/<input type=image>
      //   - locator-plan-builder strategies that emit `[alt="…"]` CSS
      //   - candidate-pruner-llm uses it in candidate text
      //   - identity rescue when descriptor-poor
      // The CDP path already reads `alt` inside `computeChildTestId`
      // (descriptor-poor gate) but throws the value away. We surface it
      // here so dom-analysis-extractor's `(element as any).alt` pass-
      // through (line 322) finds something on the CDP side too.
      alt?: string;
      // V26 Step B3 (May 2026) — Vue/BEM cluster fields.
      // Byte-symmetric with recording-capture.service.ts:1394-1456
      // (cssClass) and :1461-1468 (vueScopeId). Consumers downstream:
      //   - locator-plan-builder strategy 22 `[data-v-XXXXX]` (Vue
      //     scoped, ~0.76 confidence)
      //   - locator-plan-builder BEM-style CSS strategies built from
      //     cssClass tokens
      //   - element-resolver fingerprint hints (`cssClass="..."` line)
      //   - candidate-pruner-llm picks them up via InteractiveNode
      // Recorder writes them in PROBE_AT_POINT_FN (browser context, no
      // imports allowed — see MUST MATCH comment there). We port the
      // identical filter set here so identity match against recorded
      // fingerprint agrees on which classes are "stable".
      cssClass?: string;
      vueScopeId?: string;
    };

    const results: Array<DomWalkResult | null> = await page.evaluate((refs: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssEscape: (v: string) => string = (globalThis as any).CSS?.escape
        ?? ((v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

      // Page-level gate for Angular Material `<mat-icon svgicon>`. Computed
      // ONCE per snapshot — on plain HTML / React / Vue pages every node
      // would otherwise pay an extra closest('mat-icon') + querySelector()
      // walk. Mirrors `__frameworkGates.hasMaterial` in snapshot-collector
      // (which gates the same algorithm at V26 #B).
      const hasMaterial = !!doc.querySelector('mat-icon');

      const out: Array<DomWalkResult | null> = [];

      // firstTextFragment extractor — copy of the in-page algorithm
      // from snapshot-collector ~line 2329. MUST match byte-for-byte
      // to keep recorder probe ↔ collector ↔ CDP path symmetric.
      const TEXT_NODE = 3;
      const ELEMENT_NODE = 1;
      const DECORATIVE: Record<string, 1> = {
        img: 1, svg: 1, i: 1, picture: 1, use: 1, path: 1, br: 1, hr: 1,
      };
      // Byte-for-byte port of snapshot-collector.ts:2329
      // (extractFirstTextFragment). Iterative DFS with visited<30 cap;
      // do NOT use recursive call (deep DOMs blow the stack and burn
      // unbounded CPU). MAX_LEN = 80, decorative-leaf set matches
      // collector exactly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extractFirstFragment = (node: any): string | undefined => {
        try {
          const MAX_LEN = 80;
          // 1) Direct text-node child first.
          for (let ci = 0; ci < node.childNodes.length; ci++) {
            const ch = node.childNodes[ci];
            if (ch.nodeType === TEXT_NODE) {
              const t = (ch.nodeValue || '').replace(/\s+/g, ' ').trim();
              if (t.length >= 2 && t.length <= MAX_LEN) return t;
            }
          }
          // 2) Iterative DFS — visited < 30 cap matches collector.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stack: any[] = [];
          for (let ci = node.childNodes.length - 1; ci >= 0; ci--) {
            const ch = node.childNodes[ci];
            if (ch.nodeType === ELEMENT_NODE) stack.push(ch);
          }
          let visited = 0;
          while (stack.length > 0 && visited < 30) {
            visited++;
            const cur = stack.pop();
            const tagLc = (cur.tagName || '').toLowerCase();
            if (tagLc && DECORATIVE[tagLc]) continue;
            // Direct text under this child? Take it.
            for (let cci = 0; cci < cur.childNodes.length; cci++) {
              const cch = cur.childNodes[cci];
              if (cch.nodeType === TEXT_NODE) {
                const t = (cch.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (t.length >= 2 && t.length <= MAX_LEN) return t;
              }
            }
            // No direct text — push element-children for DFS.
            for (let cci = cur.childNodes.length - 1; cci >= 0; cci--) {
              const cch = cur.childNodes[cci];
              if (cch.nodeType === ELEMENT_NODE) stack.push(cch);
            }
          }
        } catch { /* best-effort */ }
        return undefined;
      };

      // isIconButton — same algorithm as in-page (~line 2092).
      const ICON_SELECTOR = 'svg, img, i[class*="icon"], i[class^="fa"], i[class*=" fa"], i.material-icons, i.material-symbols-outlined, span.icon, [data-icon]';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIsIconButton = (el: any): boolean => {
        try {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const tabIdx = el.getAttribute('tabindex');
          const isClickable = tag === 'button' || tag === 'a'
            || role === 'button' || role === 'link' || role === 'menuitem'
            || el.hasAttribute('onclick')
            || (tabIdx !== null && parseInt(tabIdx, 10) >= 0);
          if (!isClickable) return false;
          const hasIconChild = el.querySelector(ICON_SELECTOR) !== null;
          if (!hasIconChild) return false;
          // cloneNode + remove icons + read remaining text — same trick.
          const clone = el.cloneNode(true);
          clone.querySelectorAll(ICON_SELECTOR).forEach((icon: { remove: () => void }) => icon.remove());
          const remainingText = (clone.textContent || '').replace(/\s+/g, '').trim();
          return remainingText.length === 0;
        } catch { return false; }
      };

      // labelText resolution: <label for>, wrapping <label>,
      // aria-labelledby. Skip raw textContent — that's `name`
      // (already in AX from Phase 3b).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getLabelText = (el: any): string | undefined => {
        try {
          // aria-labelledby — space-separated ids, concat their text.
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const parts: string[] = [];
            for (const id of labelledBy.split(/\s+/)) {
              if (!id) continue;
              const ref = doc.getElementById(id);
              if (ref) parts.push((ref.textContent || '').trim());
            }
            const joined = parts.join(' ').slice(0, 100);
            if (joined.length > 0) return joined;
          }
          // <label for=id>
          const id = el.id || el.getAttribute('id');
          if (id) {
            const lbl = doc.querySelector(`label[for="${cssEscape(id)}"]`);
            if (lbl) {
              const t = (lbl.textContent || '').trim().slice(0, 100);
              if (t) return t;
            }
          }
          // Wrapping <label>. Collector uses `el.closest('label')` (no
          // depth limit). Mirror that exactly — depth-limited walk
          // missed wrapping labels on Bootstrap/Material deep DOMs.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const wrappingLabel: any = el.closest && el.closest('label');
          if (wrappingLabel) {
            const clone = wrappingLabel.cloneNode(true);
            clone.querySelectorAll('input, textarea, select').forEach((c: { remove: () => void }) => c.remove());
            const t = (clone.textContent || '').trim();
            if (t) return t.slice(0, 100);
          }
          // 4. Implicit label via form-group / field container.
          // Mirrors snapshot-collector.ts:707 (the 4th strategy).
          // Without this, Bootstrap/Ant/Material inputs lose labelText.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const formGroup: any = el.closest && el.closest('.form-group, .form-field, .field, .input-group, .form-control, [data-field]');
          if (formGroup) {
            const labelEl = formGroup.querySelector('label, .label, [class*="label"]');
            if (labelEl && !labelEl.contains(el)) {
              const text = (labelEl.textContent || '').trim();
              if (text) return text.slice(0, 100);
            }
          }
        } catch { /* DOM race — fall through */ }
        return undefined;
      };

      // nearestRowText — byte-for-byte port of snapshot-collector.ts:1858.
      // CRITICAL invariants (audit findings):
      //   - selector list MUST include `li.list-row, li.list-item`
      //   - cells via `td, th, [role=cell], [role=gridcell]` first; only
      //     fall back to `rowAnc.children` when no semantic cells found
      //   - skip cells that CONTAIN el (not just remove by ref)
      //   - separator is U+241F (Information Separator One), NOT ' | ' —
      //     downstream consumers split on '␟'; mismatch = wrong
      //     fingerprint match in fingerprint scoring
      //   - per-cell text NFC-normalized (cross-OS recording symmetry)
      //   - per-cell length 2..80 BEFORE push (drops noisy 1-char or
      //     enormous cells)
      //   - max 4 cells pushed; max 8 cells iterated; .slice(0, 200)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const INVISIBLE_RE_NRT = /[​-‏‪-‮⁠-⁩﻿]/g;
      const normLiveText = (s: string | undefined | null): string | undefined => {
        if (s === undefined || s === null) return undefined;
        if (s.length === 0) return '';
        let out = s;
        try { out = out.normalize('NFC'); } catch { /* best-effort */ }
        return out.replace(INVISIBLE_RE_NRT, '').replace(/\s+/g, ' ').trim();
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getNearestRowText = (el: any): string | undefined => {
        try {
          const rowAnc = el.closest && el.closest('tr, [role="row"], li[role="option"], li.list-row, li.list-item');
          if (!rowAnc || rowAnc === el) return undefined;
          const cellNodes = rowAnc.querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cellList: any[] = cellNodes.length > 0
            ? Array.prototype.slice.call(cellNodes, 0, 8)
            : Array.prototype.slice.call(rowAnc.children, 0, 8);
          const cellTexts: string[] = [];
          for (let ci = 0; ci < cellList.length && cellTexts.length < 4; ci++) {
            const cellEl = cellList[ci];
            // Skip cells that CONTAIN our element (collector's invariant).
            if (cellEl.contains && cellEl.contains(el)) continue;
            const raw = cellEl.innerText != null ? cellEl.innerText : cellEl.textContent;
            const t = normLiveText(raw) || '';
            if (t.length >= 2 && t.length <= 80) cellTexts.push(t);
          }
          // U+241F separator — symmetric with probe + heal extractors.
          if (cellTexts.length > 0) return cellTexts.join('␟').slice(0, 200);
          return undefined;
        } catch { return undefined; }
      };

      // ── getReadableElementText — copied byte-for-byte from
      // snapshot-collector.ts:2296. innerText preserves visual
      // whitespace between block-level children (textContent glues).
      // Used by getNearText below; do NOT diverge.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getReadableElementText = (node: any): string => {
        try {
          const raw = (typeof node.innerText === 'string' && node.innerText.trim().length > 0)
            ? node.innerText
            : (node.textContent || '');
          return raw.replace(/\s+/g, ' ').trim();
        } catch {
          return (node.textContent || '').replace(/\s+/g, ' ').trim();
        }
      };

      // ── nearText — byte-for-byte copy of snapshot-collector.ts:2622.
      // Walks ≤4 ancestors looking for tr/li/article/section or
      // [role=row|listitem|article] or .card/.item/.row; subtracts
      // own text from container text. CRITICAL: uses .replace() (FIRST
      // occurrence), NOT split.join() — symmetry with collector.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getNearText = (el: any): string | undefined => {
        try {
          const ownText = (getReadableElementText(el) || '').slice(0, 30);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let container: any = el.parentElement;
          for (let depth = 0; depth < 4 && container; depth++) {
            const tag = container.tagName?.toLowerCase();
            const role = container.getAttribute('role') || '';
            if (tag === 'tr' || tag === 'li' || tag === 'article' || tag === 'section'
                || role === 'row' || role === 'listitem' || role === 'article'
                || container.classList.contains('card')
                || container.classList.contains('item')
                || container.classList.contains('row')) {
              break;
            }
            container = container.parentElement;
          }
          if (!container) return undefined;
          const containerText = getReadableElementText(container).slice(0, 120);
          if (!containerText || containerText === ownText) return undefined;
          // .replace() — FIRST occurrence only. Collector does this too;
          // split.join() (replaces ALL) would diverge on rows where
          // ownText appears multiple times in row's other cells.
          const context = containerText.replace(ownText, '').replace(/\s+/g, ' ').trim();
          return context.length > 3 ? context.slice(0, 80) : undefined;
        } catch { return undefined; }
      };

      // ── isTopMostAtCenter — hit-test at element's center ─────
      // Byte-identical with snapshot-collector + background-dom-collector.
      // Returns true when the element (or its descendant) is at the
      // top of the stacking order at its visual center. Used by
      // resolver/pruner to demote covered elements.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIsTopMostAtCenter = (el: any): boolean | undefined => {
        try {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = (globalThis as any).window;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          // Skip if center is off-viewport — hit-test would return null
          // and we'd report false positives. Off-viewport != covered.
          if (cx < 0 || cy < 0 || cx > w.innerWidth || cy > w.innerHeight) {
            return undefined;
          }
          const top = doc.elementFromPoint(cx, cy);
          if (!top) return undefined;
          return top === el || el.contains(top);
        } catch { return undefined; }
      };

      // ── floatingWidget — small fixed corner widget layer ────────
      // Geometry-only (chat/assistant bubble, support launcher). Inline
      // copy of `isFloatingCornerWidget` in floating-widget.util.ts and the
      // eval collector (snapshot-collector.ts) — KEEP IN SYNC (constants:
      // FLOATING_WIDGET_EDGE_MARGIN_PX=24, FLOATING_WIDGET_MAX_COVERAGE=0.30).
      // Walk to the nearest position:fixed ancestor (or self) and test THAT
      // container, so a widget's child buttons inherit the flag. Never flags
      // modal contents (role=dialog/alertdialog/aria-modal ancestor).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeFloatingWidget = (el: any): boolean => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = (globalThis as any).window;
          const vw = w.innerWidth; const vh = w.innerHeight;
          if (!(vw > 0) || !(vh > 0)) return false;
          let fixedAncestor: any = null;
          let walk: any = el;
          for (let depth = 0; walk && depth < 12; depth++) {
            const cs = w.getComputedStyle(walk);
            const role = (walk.getAttribute && walk.getAttribute('role')) || '';
            if (role === 'dialog' || role === 'alertdialog' || walk.getAttribute?.('aria-modal') === 'true') return false;
            if (cs.position === 'fixed') { fixedAncestor = walk; break; }
            walk = walk.parentElement;
          }
          if (!fixedAncestor) return false;
          const fr = fixedAncestor.getBoundingClientRect();
          if (!(fr.width > 0) || !(fr.height > 0)) return false;
          const coverage = (fr.width * fr.height) / (vw * vh);
          if (coverage >= 0.30) return false;
          const m = 24;
          const hugsH = fr.left <= m || fr.left + fr.width >= vw - m;
          const hugsV = fr.top <= m || fr.top + fr.height >= vh - m;
          return hugsH && hugsV;
        } catch { return false; }
      };

      // ── childTestId — fallback testId from unique direct child ──
      // Byte-identical with snapshot-collector ~line 1763. Lifts a
      // testid from a single icon child (svg/i/img/span) when the
      // element itself is "descriptor-poor" (no own text/label/title/
      // alt/testid). Used by compiled-locator-executor: matches fingerprint
      // when the parent is too generic but the child is uniquely tagged.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeChildTestId = (el: any): string | undefined => {
        try {
          const ownLabelLikeText = (el.innerText || el.textContent || '').trim();
          const ownAriaLabel = el.getAttribute('aria-label');
          const ownTitle = el.getAttribute('title');
          const ownAlt = el.getAttribute('alt');
          const ownTestIdAttr = el.getAttribute('data-testid')
            || el.getAttribute('data-test')
            || el.getAttribute('data-cy')
            || el.getAttribute('data-qa-test-id');
          const elIsDescriptorPoor = !ownLabelLikeText && !ownAriaLabel && !ownTitle && !ownAlt && !ownTestIdAttr;
          if (!elIsDescriptorPoor) return undefined;
          const directKids = el.children || [];
          const childCands: string[] = [];
          for (let dki = 0; dki < directKids.length && childCands.length < 3; dki++) {
            const dk = directKids[dki];
            const dkTag = (dk.tagName || '').toLowerCase();
            if (dkTag === 'svg' || dkTag === 'i' || dkTag === 'img' || dkTag === 'span') {
              const dkTestId = dk.getAttribute('data-testid')
                || dk.getAttribute('data-test')
                || dk.getAttribute('data-cy')
                || dk.getAttribute('data-qa-test-id')
                || '';
              if (dkTestId) childCands.push(dkTestId);
              if (!dkTestId && dkTag === 'span' && dk.children && dk.children.length === 1) {
                const dkc = dk.children[0];
                const dkcTag = (dkc.tagName || '').toLowerCase();
                if (dkcTag === 'svg' || dkcTag === 'i' || dkcTag === 'img') {
                  const dkcTestId = dkc.getAttribute('data-testid')
                    || dkc.getAttribute('data-test')
                    || dkc.getAttribute('data-cy')
                    || dkc.getAttribute('data-qa-test-id')
                    || '';
                  if (dkcTestId) childCands.push(dkcTestId);
                }
              }
            }
          }
          // Symmetric with evaluate-path: only return when EXACTLY ONE
          // candidate (more = ambiguous, drop the field).
          return childCands.length === 1 ? childCands[0] : undefined;
        } catch { return undefined; }
      };

      // ── iconLabel — semantic label fallback for icon-only buttons ──
      // Byte-identical port of snapshot-collector ~line 2119. Tries
      // (in order): <img alt>, <svg><title>, <svg><desc>, <svg><use>
      // href, data-lucide/feather/icon/iconify-name. Only fires when
      // element has no aria-label/title (i.e., truly descriptor-poor).
      // Used by locator-plan-builder strategy 6 (iconLabel CSS attr
      // selector) and by candidateText for LLM resolver scoring.
      // computeIconLabel — byte-for-byte port of snapshot-collector.ts:2117
      // (the iconChildLabel waterfall). MUST stay symmetric across all
      // 9 fallback tiers — diverging here causes locator-plan-builder
      // strategy 6 to produce different selectors on CDP path vs eval
      // path → wrong-element clicks on icon-only buttons.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIconLabel = (el: any): string | undefined => {
        try {
          const ariaLabel = el.getAttribute('aria-label');
          const titleAttr = el.getAttribute('title');
          if (ariaLabel || titleAttr) return undefined;
          let iconChildLabel: string | undefined;
          // 1) <img alt>
          const img = el.querySelector('img[alt]');
          if (img) {
            const alt = (img.getAttribute('alt') || '').trim();
            if (alt.length > 0 && alt.length <= 100) iconChildLabel = alt;
          }
          // 2-4) <svg> <title> / <desc> / <use href>
          if (!iconChildLabel) {
            const svg = el.querySelector('svg');
            if (svg) {
              const svgTitle = svg.querySelector('title');
              if (svgTitle) {
                const t = (svgTitle.textContent || '').trim();
                if (t.length > 0 && t.length <= 100) iconChildLabel = t;
              }
              if (!iconChildLabel) {
                const svgDesc = svg.querySelector('desc');
                if (svgDesc) {
                  const t = (svgDesc.textContent || '').trim();
                  if (t.length > 0 && t.length <= 100) iconChildLabel = t;
                }
              }
              if (!iconChildLabel) {
                const useEl = svg.querySelector('use');
                if (useEl) {
                  const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '';
                  const iconRef = href.replace(/^#/, '').replace(/^icon[-_]/, '').replace(/[-_]/g, ' ').trim();
                  if (iconRef.length > 0 && iconRef.length <= 50) iconChildLabel = iconRef;
                }
              }
            }
          }
          // 5) data-lucide / data-feather / data-icon / data-iconify-name
          // CRITICAL: split(':').pop() strips Iconify set prefix
          // ('mdi:folder' -> 'folder'), THEN replace separators.
          // Plain replace(/[-_:]/g) loses the set name as a token.
          if (!iconChildLabel) {
            const iconHolder = el.querySelector('[data-lucide], [data-feather], [data-icon], [data-iconify-name]')
              || (el.matches && el.matches('[data-lucide], [data-feather], [data-icon], [data-iconify-name]') ? el : null);
            if (iconHolder) {
              const raw = (
                iconHolder.getAttribute('data-lucide')
                || iconHolder.getAttribute('data-feather')
                || iconHolder.getAttribute('data-icon')
                || iconHolder.getAttribute('data-iconify-name')
                || ''
              ).trim();
              const normalized = raw.split(':').pop()!.replace(/^icon[-_]/, '').replace(/[-_]/g, ' ').trim();
              if (normalized.length > 0 && normalized.length <= 50) iconChildLabel = normalized;
            }
          }
          // 6) V15: prefixed icon classes (lucide-X, mdi-X, fa-X, etc.)
          if (!iconChildLabel) {
            const svgOrI = el.querySelector('svg, i');
            const classStr = (svgOrI && svgOrI.getAttribute('class')) || el.getAttribute('class') || '';
            if (classStr) {
              const prefixed = classStr.match(/\b(?:lucide|heroicon[s]?|tabler|mdi|bi|ri|ti|bx|ph|fa|fas|far|fal|fad|fab|icon)[-_:]([a-z0-9]+(?:[-_][a-z0-9]+)*)/i);
              if (prefixed && prefixed[1]) {
                const name = prefixed[1].replace(/[-_]/g, ' ').trim();
                if (name.length > 0 && name.length <= 50) iconChildLabel = name;
              }
              // 7) Suffix `-icon` / prefix `icon-` class
              if (!iconChildLabel) {
                const suffixed = classStr.match(/\b([a-z]+)[-_]icon\b|\bicon[-_]([a-z]+)\b/i);
                const name = ((suffixed && (suffixed[1] || suffixed[2])) || '').toLowerCase().trim();
                if (name.length > 0 && name.length <= 50 && name !== 'icon') iconChildLabel = name;
              }
              // 8) V23: namespaced classes (`prefix_MidSegment_hash`)
              if (!iconChildLabel) {
                const namespaced = classStr.match(/\b([a-z]{2,})_([A-Za-z][A-Za-z0-9_]{2,40})_[a-z0-9]{5,}\b/);
                const namespacePrefix = namespaced && namespaced[1];
                const midSegment = namespaced && namespaced[2];
                const hasCamelOrSnake = midSegment ? (/[A-Z]/.test(midSegment) || /_/.test(midSegment)) : false;
                const genericPrefixRx = /^(jss|sc|css|emotion|makeStyles|styled)$/i;
                if (midSegment && namespacePrefix && !genericPrefixRx.test(namespacePrefix) && hasCamelOrSnake) {
                  const layoutSkipRx = /^(root|wrapper|container|content|label|box|inner|outer|main|body|header|footer|sidebar|panel|section)$/i;
                  if (!layoutSkipRx.test(midSegment)) {
                    const name = midSegment
                      .replace(/([a-z])([A-Z])/g, '$1 $2')
                      .replace(/_/g, ' ')
                      .toLowerCase()
                      .trim();
                    if (name.length >= 3 && name.length <= 50) iconChildLabel = name;
                  }
                }
              }
            }
          }
          // 9) Last-resort: <img src> filename (slug-shaped only).
          if (!iconChildLabel) {
            try {
              const imgEl = (el.tagName.toLowerCase() === 'img'
                ? el
                : el.querySelector('img[src]'));
              if (imgEl) {
                const src = (imgEl.getAttribute('src') || '').trim();
                if (src && src.indexOf('data:') !== 0) {
                  const cleanPath = src.split('?')[0].split('#')[0];
                  const file = (cleanPath.split('/').pop() || '').toLowerCase();
                  const m = file.match(/^([a-z][a-z0-9_-]{1,29})\.(?:svg|png|jpe?g|webp|gif|ico)$/);
                  if (m && m[1]) {
                    const stem = m[1];
                    const digitCount = (stem.match(/\d/g) || []).length;
                    const looksHashed = digitCount >= 4 || /^[a-f0-9]{8,}$/.test(stem);
                    if (!looksHashed) {
                      iconChildLabel = stem.replace(/[-_]/g, ' ').trim();
                    }
                  }
                }
              }
            } catch { /* best-effort */ }
          }
          return iconChildLabel;
        } catch { return undefined; }
      };

      // ── iconClasses — filtered icon-related class names ──
      // Byte-identical with snapshot-collector ~line 2588. Pulls
      // icon-library-prefixed classes from the element AND its
      // direct icon child (i, svg, span[class*=icon|fa-]) plus
      // data-* runtime icon attrs (Lucide/Feather/Iconify). Used
      // to disambiguate icon-only buttons that share role/text.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIconClasses = (el: any): string | undefined => {
        try {
          const classStr = el.getAttribute('class') || '';
          const iconChild = el.querySelector('i, svg, span[class*="icon"], span[class*="fa-"]');
          const childClassStr = iconChild?.getAttribute('class') || '';
          const dataIconAttrs = [
            iconChild?.getAttribute('data-lucide'),
            iconChild?.getAttribute('data-feather'),
            iconChild?.getAttribute('data-icon'),
            iconChild?.getAttribute('data-iconify-name'),
            el.getAttribute('data-lucide'),
            el.getAttribute('data-feather'),
            el.getAttribute('data-icon'),
            el.getAttribute('data-iconify-name'),
          ].filter(Boolean).join(' ');
          const allClasses = `${classStr} ${childClassStr} ${dataIconAttrs}`.trim();
          if (!allClasses) return undefined;
          const iconMatches = allClasses.split(/\s+/).filter((c: string) =>
            /^(fa-|fa[srltdb]-|material-icons|mdi-|bi-|icon-|lucide-|heroicon|ri-|ti-|bx-|ph-|tabler-)/i.test(c)
            || /icon/i.test(c)
            || /[a-z]+-icon$/i.test(c)
            || /^[a-z]+:[a-z-]+$/i.test(c),
          );
          return iconMatches.length > 0 ? iconMatches.join(' ') : undefined;
        } catch { return undefined; }
      };

      // ── svgIcon — Angular Material `<mat-icon svgicon>` registry name.
      // Byte-symmetric with snapshot-collector.ts:2117-2141.
      // Order of lookup (V23): self → ancestor → descendant. Covers:
      //   • the <mat-icon> itself is clickable target
      //   • icon-only Material button: <button>…<mat-icon svgicon="x"/>
      //   • wrapper components: <app-excel-btn><mat-icon svgicon="x"/>
      // Gate via page-level `hasMaterial` (computed once above) so plain
      // HTML / React / Vue pages skip both DOM walks entirely.
      // Value capped at 60 chars (defensive — real values are short
      // identifiers like "chevron-left-outline").
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeSvgIcon = (el: any): string | undefined => {
        if (!hasMaterial) return undefined;
        try {
          const matIconHost = el.tagName && el.tagName.toLowerCase() === 'mat-icon'
            ? el
            : (el.closest ? el.closest('mat-icon') : null)
            || (el.querySelector ? el.querySelector('mat-icon') : null);
          if (!matIconHost) return undefined;
          const raw = matIconHost.getAttribute('svgicon')
            || matIconHost.getAttribute('data-mat-icon-name')
            || '';
          if (raw && raw.length > 0 && raw.length <= 60) return raw;
          return undefined;
        } catch { return undefined; }
      };

      // ── customElementTag — closest semantic custom-element ancestor.
      // Byte-symmetric with snapshot-collector.ts:2151-2173.
      // 6-level ancestor walk; tag MUST contain '-' (custom-element
      // signature), length 5-60, NOT in the exclude list. Skipped tags:
      //   • generated component salts (app-cNN/ng-cNN/etc.)
      //   • Angular structural tags (router-outlet, ng-component)
      //   • Material primitives we DON'T want as the wrapper anchor
      //     (mat-icon/menu/select/form-field) — those have their own
      //     dedicated signals (svgIcon, ariaHasPopup, role) and would
      //     misanchor identity if used as wrapper.
      // Returns lowercase tag (recorder symmetric).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeCustomElementTag = (el: any): string | undefined => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let walk: any = el;
          for (let i = 0; i < 6 && walk && walk !== doc.body; i++) {
            const t = (walk.tagName || '').toLowerCase();
            if (t.indexOf('-') >= 0
              && t.length >= 5
              && t.length <= 60
              && !/^(?:app|ng|ion|sl|stencil)-c\d+$/.test(t)
              && t !== 'router-outlet'
              && t !== 'ng-component'
              && t !== 'mat-icon'
              && t !== 'mat-menu'
              && t !== 'mat-select'
              && t !== 'mat-form-field'
              && walk !== el
            ) {
              return t;
            }
            walk = walk.parentElement;
          }
        } catch { /* best-effort */ }
        return undefined;
      };

      // ── cssClass — first 3 stable class tokens, ALL filters mirrored
      // byte-for-byte from recording-capture.service.ts:1394-1456.
      // Token kept iff it passes EVERY filter:
      //   - 1-50 chars
      //   - NOT Tailwind/UnoCSS utility prefix
      //   - NOT data-v-XXXXXXX scoped marker (own field)
      //   - NOT css-XXXXXX / sc-XXXXXX (Emotion / styled-components)
      //   - NOT Angular runtime markers (ng-star-inserted, ng-tns-cN-M,
      //     ng-form-state classes)
      //   - NOT BEM state suffix (block--active, tab--selected, …)
      //   - NOT bare standalone state class (active, selected, …)
      //   - NOT 5-8 char mixed-case token IF the element also has any
      //     css-in-js sibling (likely styled-components display name)
      // Result is up to 3 tokens joined by space. Must MUST MATCH the
      // recorder's filter set exactly — any drift breaks identity match
      // (recorded class="A B C" vs live class="A B C" disagree on
      // which 3 tokens survive → fingerprint cssClass mismatch).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeCssClass = (el: any): string | undefined => {
        try {
          // For SVG `target.className` is SVGAnimatedString, not string —
          // use getAttribute for cross-tag safety (mirrors recorder).
          const rawClass: string = el.getAttribute('class') || '';
          if (!rawClass) return undefined;

          // Flag css-in-js presence on THIS element. When true we apply
          // an extra-strict filter on bare camelCase tokens (recorder
          // V22 Pkg3 behaviour). Avoid catching legitimate camelCase ids
          // like "userName" on plain HTML.
          const hasCssInJs = /(?:^| )(?:css-[a-z0-9]{6,}|sc-[a-zA-Z0-9]{6,})(?: |$)/i.test(rawClass);

          const tokens: string[] = rawClass.split(/\s+/).filter((t: string) => {
            if (!t || t.length > 50) return false;
            // Utility / state prefix families (Tailwind, UnoCSS).
            if (/^(?:[wh]-|p[xytrbl]?-|m[xytrbl]?-|gap-|flex|grid|block|inline|hidden|absolute|relative|fixed|text-|bg-|border|rounded|shadow|opacity|cursor-|select-|items-|justify-|self-|space-|overflow-|min-|max-|top-|left-|right-|bottom-|z-|font-|leading-|tracking-|whitespace-|truncate|line-clamp|transition|duration-|ease-|animate-|hover:|focus:|active:|disabled:|group-)/.test(t)) return false;
            // Vue scoped marker — captured separately as vueScopeId.
            if (/^data-v-[a-f0-9]{8}$/.test(t)) return false;
            // css-in-js scoped classes.
            if (/^css-[a-z0-9]{6,}$/i.test(t)) return false;
            if (/^sc-[a-zA-Z0-9]{6,}$/.test(t)) return false;
            // Angular runtime / form-state markers.
            if (t === 'ng-star-inserted') return false;
            if (/^ng-tns-c\d+-\d+$/.test(t)) return false;
            if (/^ng-(?:un)?touched$|^ng-pristine$|^ng-dirty$|^ng-valid$|^ng-invalid$|^ng-pending$|^ng-submitted$/.test(t)) return false;
            // BEM state suffix.
            if (/--(?:active|selected|current|checked|open|opened|expanded|focused|hover|hovered|loading|busy|highlighted|chosen|disabled|first|last|initial|terminal|empty|filled|valid|invalid|dirty|touched|pristine|untouched|pending|error|success|warning)$/.test(t)) return false;
            // Standalone state class (Bootstrap / legacy pattern).
            if (/^(?:active|selected|current|checked|open|opened|expanded|focused|hovered|loading|busy|highlighted|chosen|disabled|enabled|valid|invalid|dirty|touched|pristine|untouched|pending|error|success|warning|empty|filled|readonly|required|focused|hidden|visible|collapsed|expanded)$/.test(t)) return false;
            // Bare camelCase 5-8 chars + css-in-js present → likely a
            // styled-components display-name hash.
            if (hasCssInJs && /^[a-z][a-zA-Z]{4,7}$/.test(t) && /[A-Z]/.test(t)) return false;
            return true;
          });

          if (tokens.length === 0) return undefined;
          return tokens.slice(0, 3).join(' ');
        } catch { return undefined; }
      };

      // ── vueScopeId — first `data-v-*` attribute name (the hash itself
      // is the attribute NAME, value is empty). All children of a Vue
      // single-file component share it, so it narrows beyond text and
      // survives className refactors. Byte-symmetric with
      // recording-capture.service.ts:1461-1468.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeVueScopeId = (el: any): string | undefined => {
        try {
          const attrs = el.attributes;
          if (!attrs) return undefined;
          for (let i = 0; i < attrs.length; i++) {
            const name: string = attrs[i].name;
            if (name && name.indexOf('data-v-') === 0) {
              return name;
            }
          }
        } catch { /* best-effort */ }
        return undefined;
      };

      for (const ref of refs) {
        const el = doc.querySelector(`[data-agent-ref="${cssEscape(ref)}"]`);
        if (!el) {
          out.push(null);
          continue;
        }
        const isIconBtn = computeIsIconButton(el);
        const result: DomWalkResult = {
          firstTextFragment: extractFirstFragment(el),
          isIconButton: isIconBtn,
          labelText: getLabelText(el),
          nearestRowText: getNearestRowText(el),
          isTopMostAtCenter: computeIsTopMostAtCenter(el),
          floatingWidget: computeFloatingWidget(el),
          childTestId: computeChildTestId(el),
          iconClasses: computeIconClasses(el),
          // Collector gates iconLabel on isIconButton — mirror that
          // gate here. Without it, regular labelled `<a>` with nested
          // `<svg><title>` would get a spurious iconLabel on CDP path.
          iconLabel: isIconBtn ? computeIconLabel(el) : undefined,
          nearText: getNearText(el),
          // V26 Step B1: svgIcon + customElementTag (Angular cluster).
          // No gate beyond what each helper applies internally — svgIcon
          // checks `hasMaterial`, customElementTag walks 6 levels with
          // hyphen-tag predicate.
          svgIcon: computeSvgIcon(el),
          customElementTag: computeCustomElementTag(el),
          // V26 Step B2: own `alt` attribute. Single getAttribute call,
          // no helper — byte-symmetric with snapshot-collector.ts:2637
          // (`alt: ownAlt || undefined`, no .trim()). Preserving the
          // raw value matters: a deliberate `<img alt=" ">` indicates
          // "decorative + spacer" per WAI-ARIA, distinct from undefined.
          alt: el.getAttribute('alt') || undefined,
          // V26 Step B3: Vue/BEM cluster. Both port verbatim recorder
          // filters — see helper definitions above for MUST-MATCH lines.
          cssClass: computeCssClass(el),
          vueScopeId: computeVueScopeId(el),
        };
        out.push(result);
      }
      return out;
    }, refs);

    // Merge results back. Build ref→element map ONCE — refs may not
    // be in the same order if Phase 3.5 dropped some elements.
    const elByRef = new Map<string, LiteElement>();
    for (const el of elements) {
      if (el.ref) elByRef.set(el.ref, el);
    }
    for (let i = 0; i < refs.length; i++) {
      const result = results[i];
      if (!result) continue;
      const el = elByRef.get(refs[i]);
      if (!el) continue;
      if (result.firstTextFragment) {
        // Skip when fragment === name to keep consumer logic simple
        // (LiteElement convention: fragment is meaningful only when
        // distinct from name).
        if (result.firstTextFragment !== el.name) {
          el.firstTextFragment = result.firstTextFragment;
        }
      }
      if (result.isIconButton) el.isIconButton = true;
      if (result.labelText) el.labelText = result.labelText;
      if (result.nearestRowText) el.nearestRowText = result.nearestRowText;
      // Q1 audit — only assign when defined to preserve "absent vs
      // false" distinction. `isTopMostAtCenter === undefined` (e.g.,
      // off-viewport) is meaningful: consumers treat undefined as
      // "didn't measure", false as "definitely covered". Don't conflate.
      if (typeof result.isTopMostAtCenter === 'boolean') {
        el.isTopMostAtCenter = result.isTopMostAtCenter;
      }
      if (result.floatingWidget) el.floatingWidget = true;
      if (result.childTestId) el.childTestId = result.childTestId;
      if (result.iconClasses) el.iconClasses = result.iconClasses;
      if (result.iconLabel) el.iconLabel = result.iconLabel;
      if (result.nearText) el.nearText = result.nearText;
      // V26 Step B1 — Angular cluster fields, consumed downstream by
      // dom-analysis-extractor.service.ts:313-318 → InteractiveNode →
      // locator-plan-builder strategies (mat-icon, custom-wrapper) and
      // by element-resolver `getEffectiveLabel`.
      // customElementTag is typed on LiteElement (line 163). svgIcon is
      // not yet typed — kept as `as any` for parity with snapshot-collector
      // emit (also untyped there). Adding the strict type to LiteElement
      // is tracked as a separate cleanup PR.
      if (result.customElementTag) el.customElementTag = result.customElementTag;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (result.svgIcon) (el as any).svgIcon = result.svgIcon;
      // V26 Step B2 — alt attribute. Not yet typed on LiteElement (the
      // snapshot-collector emit at line 2637 also writes it untyped),
      // so the `as any` cast mirrors that path until both gain strict
      // typing in a separate cleanup PR.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (result.alt) (el as any).alt = result.alt;
      // V26 Step B3 — cssClass + vueScopeId. Same untyped-on-LiteElement
      // story as svgIcon/alt above. dom-analysis-extractor reads them
      // via `(element as any)` at lines 325-329 and surfaces them
      // typed on InteractiveNode for the resolver / plan-builder.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (result.cssClass) (el as any).cssClass = result.cssClass;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (result.vueScopeId) (el as any).vueScopeId = result.vueScopeId;
    }
  }

  /**
   * Phase 5 — modal / active-overlay detection. Sets per-element
   * `isInsideActiveModal` and returns the active modal's ref if any.
   *
   * TODO Task 2.5: port the existing 4-rule heuristic from
   * snapshot-collector.ts (`detectActiveModal`):
   *   Rule 1: native `<dialog open>` (DS attribute presence)
   *   Rule 2: role=dialog / role=alertdialog / aria-modal=true
   *   Rule 3: positional fallback (z-index ≥ 1000 +
   *           ≥30% viewport coverage + cursor:pointer + class regex)
   *   Rule 4: detected via class-name patterns (Radix dialog,
   *           Headless UI dialog, etc.)
   *
   * After detection: walk every element's parent chain via
   * `parentRefChain` (already populated in mapping). If any ancestor
   * is the active modal, set `isInsideActiveModal = true`.
   *
   * Why Node-side and not in evaluate: the 4-rule heuristic walks
   * computed styles and bbox already in `raw`. Doing it in evaluate
   * would mean a second DOM walk after we already paid for the CDP
   * snapshot. Keep evaluate strictly for runtime-only fields.
   */
  private static detectModalsInPlace(elements: LiteElement[], raw: RawCdpBundle): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = raw.domSnapshot as any;
    const docs = Array.isArray(ds.documents) ? ds.documents : [];
    if (docs.length === 0) return undefined;

    // Conscious scope: implement Layer 1 (iron-clad ARIA / native
    // dialog signals) only. The existing collector also has Layer 2
    // (positional fallback with sidebar/header/footer exclusion +
    // viewport math). Layer 2 is ~80 lines of geometric heuristics
    // depending on the bbox high-water-mark and several edge-case
    // class regexes; porting it byte-for-byte without DOM access
    // turns into a re-implementation that's hard to keep symmetric.
    //
    // Decision: ship Layer 1 in CDP path. Shadow mode will report
    // divergence when Layer 2 catches a modal CDP missed; we
    // analyse the gap and decide based on real frequency whether
    // to port Layer 2, accept degradation, or fall back to evaluate
    // for pages where iron-clad signals are absent.
    //
    // Iron-clad signals (Layer 1):
    //   - role="dialog" / role="alertdialog"
    //   - aria-modal="true"
    //   - native <dialog> with `open` attribute
    //
    // Picking ONE modal among matches: highest computedZIndex wins
    // (same tiebreaker as in-page collector).

    let bestRef: string | undefined;
    let bestZ = -Infinity;

    // Build ds-index → element map for fast lookup. We need this
    // because the elements[] is filtered to interactive set; modal
    // CONTAINERS often aren't interactive themselves but appear as
    // separate DS nodes. So we walk DS directly here, not elements[].
    const elementByDsIdx = new Map<number, LiteElement>();
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      if (typeof dsIdx === 'number' && (docIdx ?? 0) === 0) {
        elementByDsIdx.set(dsIdx, el);
      }
    }

    const mainDoc = docs[0];
    const strings: string[] = Array.isArray(ds.strings) ? ds.strings : [];
    const getStr = (idx: number | undefined): string =>
      typeof idx === 'number' && idx >= 0 && idx < strings.length ? String(strings[idx] ?? '') : '';
    const nodes = mainDoc.nodes;
    const layout = mainDoc.layout ?? {};
    const layoutNodeIndex: number[] = layout.nodeIndex ?? [];
    const layoutByNodeIdx = new Map<number, number>();
    for (let i = 0; i < layoutNodeIndex.length; i++) {
      layoutByNodeIdx.set(layoutNodeIndex[i], i);
    }

    const nodeCount = nodes.nodeName?.length ?? 0;
    for (let i = 0; i < nodeCount; i++) {
      const tag = getStr(nodes.nodeName?.[i]).toLowerCase();
      if (!tag) continue;

      const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
      const role = (attrs.get('role') || '').toLowerCase();
      const ariaModal = attrs.get('aria-modal') === 'true';
      const isNativeDialog = tag === 'dialog' && attrs.has('open');

      const isModal = isNativeDialog || ariaModal || role === 'dialog' || role === 'alertdialog';
      if (!isModal) continue;

      // Visibility gate via computed styles. If element is hidden,
      // don't treat it as the active modal even if it has the role.
      const layoutIdx = layoutByNodeIdx.get(i);
      const styles = layoutIdx !== undefined ? decodeStylesForLayoutIdx(layout, layoutIdx, getStr) : undefined;
      if (styles) {
        if (styles.display === 'none' || styles.visibility === 'hidden') continue;
        if (parseFloat(styles.opacity || '1') < 0.1) continue;
      }

      // Tiebreaker: highest z-index wins (matches in-page Layer 1
      // logic at line ~198). Native <dialog> with showModal() goes
      // into the top layer, browser handles z-index implicitly —
      // give them +Infinity so they always win.
      let z = 0;
      if (isNativeDialog) z = Number.POSITIVE_INFINITY;
      else if (styles?.zIndex && styles.zIndex !== 'auto') {
        const parsed = parseInt(styles.zIndex, 10);
        if (!isNaN(parsed)) z = parsed;
      }
      if (z <= bestZ) continue;

      // Modal node may or may not be interactive (in elements[]).
      // If it has a ref already (from Phase 3.5 because it passed
      // interactive filter), use that. Otherwise the modal container
      // doesn't have a ref — we leave activeModalRef as the
      // ds-index-derived placeholder. In practice modal containers
      // tend to be non-interactive divs without refs, so we fall
      // back to scanning interactive descendants when ref is absent.
      const directRef = elementByDsIdx.get(i)?.ref;
      if (directRef) {
        bestRef = directRef;
        bestZ = z;
      } else {
        // No direct ref — check if any descendant element is in our
        // interactive set; use the first match's ancestor chain to
        // confirm modal-ness. This is a degraded path; ideally we'd
        // assign the modal a ref via a separate evaluate, but that
        // costs another round-trip just for the modal container.
        // Defer to evaluate fallback if shadow mode shows this case
        // matters in practice.
        // For now: skip this modal in CDP path output. The
        // per-element `isInsideActiveModal` flag below uses ds
        // ancestry instead of needing a single bestRef.
        // (z still tracked above; bestRef stays undefined.)
      }
    }

    // Per-element walk: mark `isInsideActiveModal=true` for any
    // element whose DS ancestor chain crosses ANY iron-clad modal
    // node (not just bestRef — we want to flag elements inside the
    // currently-shown modal even if its container doesn't have a
    // LiteElement entry). This matches the in-page collector's
    // isInsideActiveModal field semantics (line ~2487).
    const modalDsIndexes = new Set<number>();
    for (let i = 0; i < nodeCount; i++) {
      const tag = getStr(nodes.nodeName?.[i]).toLowerCase();
      const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
      const role = (attrs.get('role') || '').toLowerCase();
      const ariaModal = attrs.get('aria-modal') === 'true';
      const isNativeDialog = tag === 'dialog' && attrs.has('open');
      if (isNativeDialog || ariaModal || role === 'dialog' || role === 'alertdialog') {
        modalDsIndexes.add(i);
      }
    }

    if (modalDsIndexes.size === 0) return bestRef;

    const parentIndex: number[] = nodes.parentIndex ?? [];
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      if (typeof dsIdx !== 'number') continue;
      let cur = parentIndex[dsIdx];
      // Walk up to depth 12 — modal nesting depth practical cap;
      // matches in-page DOM walk-up semantics.
      let depth = 0;
      while (cur !== undefined && cur >= 0 && depth < 12) {
        if (modalDsIndexes.has(cur)) {
          el.isInsideActiveModal = true;
          break;
        }
        cur = parentIndex[cur];
        depth++;
      }
    }

    return bestRef;
  }

  /**
   * Phase 5b — overlay state enrichment (transientState + obstacleFacts +
   * Layer 2 modal positional fallback) in ONE batched evaluate.
   *
   * Why one combined evaluate (not three):
   *   All three artefacts walk the same set of positioned elements and
   *   read the same getComputedStyle. Three separate evaluates means
   *   three round-trips and three style recalcs. Bundling shaves 100-300ms
   *   on dense pages and keeps the contract simple — one phase, one result.
   *
   * Symmetry contract with snapshot-collector.ts:
   *   - transientState: 6-level cascade is byte-identical (progressbar,
   *     aria-busy, aria-live + loading text, skeleton, spinner+animation,
   *     loading-text walk).
   *   - obstacleFacts: same selectors (POSITIONAL_CANDIDATES_SELECTOR +
   *     IRON_CLAD_MODAL_SELECTORS), same filters (position, opacity,
   *     z-index, coverage ≥ 3%), same hintType signals (W3C ARIA spec
   *     only — modal/sticky_header/sticky_footer; everything else is
   *     'unknown' for Observer LLM to classify), same top-15 cap by
   *     z-index descending.
   *   - layer2ModalRef: same logic — pick highest-z obstacle whose
   *     coverage ≥ 30% and that contains interactive children. ONLY
   *     applied when Layer 1 (iron-clad) didn't already pick a modal.
   *
   * Refs:
   *   Element refs are reused — `data-agent-ref` was already assigned
   *   in Phase 3.5. Each artefact's `ref` field is the existing ref
   *   string; for elements outside the interactive set we don't synthesise
   *   new refs (matches evaluate-path behaviour for transientState
   *   targets that are NOT interactive — recorder lookup tolerates this
   *   because transient state is consumed by ObserverAgent, not by
   *   element resolver).
   *
   * Failure mode: if the evaluate throws (page closed mid-collect, etc.),
   * we swallow and return empty values. The snapshot stays usable — the
   * downstream Observer/Pruner just won't see loading/overlay state for
   * this tick. Same forgiving behaviour as `enrichWithDomWalkFields`.
   */
  private static async enrichWithOverlayState(
    page: Page,
    activeModalRefAlreadyDetected: string | undefined,
  ): Promise<{
    transientState?: TransientStateInfo;
    obstacleFacts?: ObstacleFact[];
    layer2ModalRef?: string;
    /**
     * Layer 1 ref RESCUE — when Phase 5 detected an iron-clad modal in
     * DS but couldn't return a `bestRef` because the modal container
     * isn't in the interactive elements[] set (typical for `<dialog>`
     * which has no role/tabindex/onclick by default). Phase 5b's evaluate
     * is already walking the DOM, so it cheaply assigns `data-agent-ref`
     * to the modal node itself and returns it here. Phase 6 then promotes
     * this into `LiteSnapshot.activeModalRef`. Without this rescue, real
     * Chromium pages with `<dialog open>` left activeModalRef undefined
     * → ObserverAgent / Pruner couldn't tell which modal was active.
     * Caught by integration test on real browser.
     */
    layer1ModalRef?: string;
  }> {
    type Result = {
      transientState?: TransientStateInfo;
      obstacleFacts?: ObstacleFact[];
      layer2ModalRef?: string;
      layer1ModalRef?: string;
    };

    // Resilience: hard wall-clock cap on the entire Phase 5b evaluate.
    // If the page's JS event loop is jammed (infinite redirect loop in
    // a third-party SDK, runaway useEffect, blocked main thread), the
    // evaluate would otherwise wait the full Playwright default timeout
    // (~30s) before failing. We cap it at 5s — long enough for legit
    // dense-page detection, short enough that snapshot-collect stays
    // bounded even under a misbehaving page. Defaults applied on
    // timeout (snapshot still returned; just no overlay context this
    // tick).
    const PHASE_5B_HARD_TIMEOUT_MS = 5000;

    // Watchdog budgets passed INTO the evaluate. The browser code uses
    // these as soft deadlines — if a level takes longer than its slice,
    // the cascade short-circuits to {isTransient:false}. Defence in
    // depth: even if Promise.race fails to fire (e.g., evaluate already
    // serialising the result), the inner watchdog stops runaway DOM
    // walks. Numbers chosen so that under healthy conditions all 6
    // levels finish well under budget on an 11k-DOM page.
    const PHASE_5B_INNER_BUDGET_MS = 4000; // < hard timeout so race winner is the inner timeout
    const LEVEL_6_TEXT_NODE_CAP = 500;     // text-node walk hard cap
    const LEVEL_6_PATTERN_NODE_CAP = 100;  // per-pattern attempts within Level 6

    const overlayPromise = page.evaluate(
      ({
        positionalSelector,
        ironCladSelectors,
        closeButtonSelector,
        interactiveSelector,
        alreadyHaveModal,
        innerBudgetMs,
        textNodeCap,
        patternNodeCap,
      }: {
        positionalSelector: string;
        ironCladSelectors: string;
        closeButtonSelector: string;
        interactiveSelector: string;
        alreadyHaveModal: boolean;
        innerBudgetMs: number;
        textNodeCap: number;
        patternNodeCap: number;
      }): Result => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = (globalThis as any).window;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        if (!doc || !win) return {};

        // Inner wall-clock budget. Sampled at every cascade boundary
        // so a runaway level can never exceed `innerBudgetMs` without
        // bailing. `performance.now()` is monotonic and unaffected by
        // page time changes; falls back to Date.now() if unavailable
        // (rare; some sandboxed iframes).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nowFn: () => number = (win as any).performance?.now
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? () => (win as any).performance.now()
          : () => Date.now();
        const startedAt = nowFn();
        const overBudget = (): boolean => nowFn() - startedAt > innerBudgetMs;

        // Reuse the existing recorder/snapshot-collector counter so
        // refs interleave deterministically. Init at 0 to match the
        // evaluate-path (snapshot-collector starts at 0); if the
        // counter is already a number we trust whatever value Phase
        // 3.5 / recorder set. Initialising at 1 (previous version)
        // could collide with `e0` assignments in fresh sessions.
        if (typeof win.__agentRefCounter !== 'number') {
          win.__agentRefCounter = 0;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ensureRef = (el: any): string => {
          let ref = el.getAttribute('data-agent-ref');
          if (!ref) {
            ref = `e${win.__agentRefCounter++}`;
            el.setAttribute('data-agent-ref', ref);
          }
          return ref;
        };

          // ─────────────────────────────────────────────────────────
          // 1. Transient state detection (6-level cascade)
          // Byte-identical port of snapshot-collector.ts
          // detectTransientState (lines 363-461) PLUS:
          //   - fast-path early exit when no candidate selector matches
          //   - inner watchdog (overBudget) at every cascade boundary
          //   - Level 6 uses textContent (no layout flush) + node cap
          // ─────────────────────────────────────────────────────────
          const detectTransientState = (): TransientStateInfo => {
            const loadingPatterns = [
              'loading', 'загрузка', 'please wait', 'подождите',
              'spinner', 'processing', 'обработка', 'loading...',
              'загружается', 'пожалуйста, подождите',
            ];

            // Fast-path: combined cheap probe. If NONE of the candidate
            // selectors match anywhere on the page, Levels 1-5 cannot
            // fire — and we skip Level 6 (the expensive text walk) when
            // a quick body.textContent scan also has no loading text.
            // Saves ~50-200ms on the typical "calm page" tick.
            const FAST_PATH_SELECTOR =
              '[role="progressbar"]:not([aria-hidden="true"]),'
              + '[aria-busy="true"],'
              + '[aria-live],'
              + '.skeleton,.skeleton-loader,[data-skeleton],.placeholder-glow,'
              + '.spinner,.loader,.loading,[class*="spinner"],[class*="loader"],[data-loading]';
            let hasCandidate = false;
            try {
              hasCandidate = !!doc.querySelector(FAST_PATH_SELECTOR);
            } catch {
              // querySelector on mid-navigation document can throw —
              // assume worst case and proceed.
              hasCandidate = true;
            }
            if (!hasCandidate) {
              // Level 6 also needs to check for bare "Loading…" text
              // even when no class hints exist — but only if a quick
              // textContent peek hints at one of the patterns. textContent
              // is layout-free (vs innerText), so this check costs O(text
              // length) without forcing a reflow.
              const bodyText = (doc.body?.textContent || '').toLowerCase();
              const anyPattern = loadingPatterns.some((p) => bodyText.includes(p));
              if (!anyPattern) {
                return { isTransient: false };
              }
              // Else: fall through to Level 6 only.
            }

            // Level 1: role=progressbar (W3C ARIA spec)
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const progressbar = doc.querySelector('[role="progressbar"]:not([aria-hidden="true"])');
              if (progressbar) {
                const style = win.getComputedStyle(progressbar);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return { isTransient: true, type: 'progressbar', ref: ensureRef(progressbar) };
                }
              }
            }

            // Level 2: aria-busy=true (W3C ARIA spec)
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const busyElement = doc.querySelector('[aria-busy="true"]');
              if (busyElement) {
                const style = win.getComputedStyle(busyElement);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return { isTransient: true, type: 'aria-busy', ref: ensureRef(busyElement) };
                }
              }
            }

            // Level 3: aria-live region with loading text (W3C ARIA spec
            // + multilingual patterns).
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const liveRegions = doc.querySelectorAll('[aria-live]');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const region of Array.from(liveRegions) as any[]) {
                if (overBudget()) return { isTransient: false };
                const text = (region.textContent || '').toLowerCase();
                if (loadingPatterns.some((p) => text.includes(p))) {
                  return {
                    isTransient: true,
                    type: 'aria-live',
                    ref: ensureRef(region),
                    text: text.slice(0, 50),
                  };
                }
              }
            }

            // Level 4: skeleton loaders (industry convention).
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const skeleton = doc.querySelector(
                '.skeleton, .skeleton-loader, [data-skeleton], .placeholder-glow',
              );
              if (skeleton) {
                const style = win.getComputedStyle(skeleton);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return { isTransient: true, type: 'skeleton', ref: ensureRef(skeleton) };
                }
              }
            }

            // Level 5: spinner classes + animation. The animation gate
            // prevents false positives on inert ".loader" containers
            // that hold a non-spinning placeholder.
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const spinnerSelectors =
                '.spinner, .loader, .loading, [class*="spinner"], [class*="loader"], [data-loading]';
              const spinners = doc.querySelectorAll(spinnerSelectors);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const spinner of Array.from(spinners) as any[]) {
                if (overBudget()) return { isTransient: false };
                const style = win.getComputedStyle(spinner);
                if (
                  style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && parseFloat(style.opacity) > 0.3
                ) {
                  const animationName = style.animationName;
                  const animationDuration = parseFloat(style.animationDuration);
                  if (animationName && animationName !== 'none' && animationDuration > 0) {
                    return { isTransient: true, type: 'spinner', ref: ensureRef(spinner) };
                  }
                }
              }
            }

            // Level 6: bare "Loading..." text walk. Last-ditch — no
            // ARIA/class hints, just visible text.
            //
            // Resilience contract:
            //   - textContent (NOT innerText): no layout flush.
            //     5× faster on dense pages, includes hidden text but
            //     we re-validate per parent below.
            //   - Hard cap on total text-node visits across all
            //     patterns (`textNodeCap`, default 500). Prevents
            //     runaway TreeWalker on pages with thousands of text
            //     nodes.
            //   - Per-pattern cap (`patternNodeCap`, default 100) so
            //     a single pattern can't monopolise the budget.
            //   - overBudget() check on every iteration.
            if (overBudget()) return { isTransient: false };
            if (!doc.body) return { isTransient: false };

            const bodyTextSearch = (doc.body.textContent || '').toLowerCase();
            let totalVisited = 0;
            for (const pattern of loadingPatterns) {
              if (overBudget()) break;
              if (totalVisited >= textNodeCap) break;
              if (!bodyTextSearch.includes(pattern)) continue;

              const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, null);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let node: any;
              let visitedThisPattern = 0;
              while ((node = walker.nextNode())) {
                totalVisited++;
                visitedThisPattern++;
                if (visitedThisPattern > patternNodeCap) break;
                if (totalVisited > textNodeCap) break;
                if (overBudget()) break;
                if (node.textContent?.toLowerCase().includes(pattern)) {
                  const parent = node.parentElement;
                  if (parent) {
                    const style = win.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                      return {
                        isTransient: true,
                        type: 'loading-text',
                        ref: ensureRef(parent),
                        text: pattern,
                      };
                    }
                  }
                  break;
                }
              }
            }

            return { isTransient: false };
          };

          // ─────────────────────────────────────────────────────────
          // 2. Obstacle facts collection (positioned overlay inventory)
          // Byte-identical port of snapshot-collector.ts
          // collectObstacleFacts (lines 470-565).
          // ─────────────────────────────────────────────────────────
          const collectObstacleFacts = (): ObstacleFact[] => {
            const vpW = win.innerWidth;
            const vpH = win.innerHeight;
            const viewportArea = vpW * vpH;
            if (viewportArea === 0) return [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const positionalCandidates = Array.from(
              doc.querySelectorAll(positionalSelector),
            ) as any[];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ironCladMatches = Array.from(
              doc.querySelectorAll(ironCladSelectors),
            ) as any[];

            // Dedup — iron-clad goes first so its order wins for any
            // overlap (deterministic for tests).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const seen = new WeakSet<any>();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const candidates: any[] = [];
            for (const el of [...ironCladMatches, ...positionalCandidates]) {
              if (seen.has(el)) continue;
              seen.add(el);
              candidates.push(el);
            }

            const facts: ObstacleFact[] = [];
            for (const el of candidates) {
              // Watchdog: bail out of obstacleFacts collection if the
              // overall budget is exhausted. Returning whatever we have
              // so far is preferable to a runaway walk on pages with
              // thousands of positioned children. Sort + slice(15) below
              // still works on a partial array.
              if (overBudget()) break;
              const style = win.getComputedStyle(el);
              const position = style.position;
              if (position !== 'fixed' && position !== 'absolute' && position !== 'sticky') continue;
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              if (parseFloat(style.opacity) < 0.1) continue;

              const zIndex = parseInt(style.zIndex, 10);
              if (isNaN(zIndex)) continue;
              if (position !== 'sticky' && zIndex < 1) continue;

              const rect = el.getBoundingClientRect();
              const area = rect.width * rect.height;
              const coverage = area / viewportArea;
              if (coverage < 0.03) continue;

              const tag = el.tagName.toLowerCase();
              const className = (el.getAttribute('class') || '').slice(0, 200);
              const textPreview = (el.textContent || '').trim().slice(0, 200);
              const idAttr = (el.getAttribute('id') || '').slice(0, 100);
              const role = (el.getAttribute('role') || '').replace(/["']/g, '').trim() || undefined;
              const ariaModal =
                (el.getAttribute('aria-modal') || '').replace(/["']/g, '').trim() === 'true' || undefined;
              const hasCloseButton = el.querySelector(closeButtonSelector) !== null;
              const hasInteractiveChildren = el.querySelector(interactiveSelector) !== null;
              const ref = ensureRef(el);

              // hintType: ONLY W3C spec signals + geometry. Class-name
              // classification is delegated to ObserverAgent (LLM Layer 2).
              let hintType: ObstacleFact['hintType'] = 'unknown';
              if (role === 'dialog' || role === 'alertdialog' || ariaModal) {
                hintType = 'modal';
              } else if (
                (position === 'sticky' || position === 'fixed')
                && rect.top <= 5
                && rect.height < 120
              ) {
                hintType = 'sticky_header';
              } else if (
                (position === 'sticky' || position === 'fixed')
                && rect.bottom >= vpH - 5
                && rect.height < 120
              ) {
                hintType = 'sticky_footer';
              }

              facts.push({
                ref,
                tag,
                position: position as ObstacleFact['position'],
                zIndex,
                coverage: Math.round(coverage * 1000) / 1000,
                className,
                textPreview,
                id: idAttr || undefined,
                hasCloseButton,
                hasInteractiveChildren,
                role,
                ariaModal,
                rect: {
                  top: Math.round(rect.top),
                  left: Math.round(rect.left),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
                hintType,
              });
            }

            facts.sort((a, b) => b.zIndex - a.zIndex);
            return facts.slice(0, 15);
          };

          // ─────────────────────────────────────────────────────────
          // 3. Layer 2 modal positional fallback. Only runs when Layer 1
          // (iron-clad ARIA) didn't already pick a modal — otherwise
          // we'd needlessly second-guess a deterministic signal.
          //
          // Rule: among collected obstacleFacts, pick the highest-z
          // candidate that:
          //   - covers ≥ 30% of viewport, AND
          //   - has interactive children (so it's actionable, not a
          //     decorative banner), AND
          //   - hintType !== 'sticky_header' / 'sticky_footer' (geometry
          //     already disqualified the sticky bars).
          //
          // This is deliberately narrower than evaluate-path Layer 2 to
          // avoid false positives on cookie banners. Shadow logs in
          // production told us false-positive cookie banners were the
          // top divergence source; constraining to ≥30% coverage AND
          // interactive removes that class entirely.
          // ─────────────────────────────────────────────────────────
          const obstacleFacts = collectObstacleFacts();
          let layer2ModalRef: string | undefined;
          if (!alreadyHaveModal) {
            for (const f of obstacleFacts) {
              if (f.coverage < 0.3) continue;
              if (!f.hasInteractiveChildren) continue;
              if (f.hintType === 'sticky_header' || f.hintType === 'sticky_footer') continue;
              layer2ModalRef = f.ref;
              break;
            }
          }

          // ─────────────────────────────────────────────────────────
          // 4. Layer 1 ref RESCUE. Phase 5 (Node-side) sets bestRef
          // ONLY if the modal container is in the interactive elements
          // set. <dialog>, <div role=dialog>, etc., usually aren't —
          // they have no role on tags like <dialog> nor onclick handlers,
          // so the interactive filter skips them. Result before this
          // rescue: real-Chromium pages with <dialog open> had
          // activeModalRef = undefined.
          //
          // Rescue: we're already inside an evaluate, so cheaply find
          // the topmost iron-clad modal element, ensure it has
          // data-agent-ref (synthesise one if missing), and return it.
          // Phase 6 promotes this when activeModalRef is still undefined.
          // ─────────────────────────────────────────────────────────
          let layer1ModalRef: string | undefined;
          if (!alreadyHaveModal) {
            try {
              const ironCladNodes = doc.querySelectorAll(ironCladSelectors);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const visible: any[] = [];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const el of Array.from(ironCladNodes) as any[]) {
                if (overBudget()) break;
                const style = win.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (parseFloat(style.opacity) < 0.1) continue;
                visible.push(el);
              }
              // Tiebreaker: highest z-index wins (matches Phase 5
              // Node-side ranking). Native <dialog open> has implicit
              // top-layer z, so we treat it as +Infinity.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let best: any = null;
              let bestZ = -Infinity;
              for (const el of visible) {
                const tag = el.tagName?.toLowerCase();
                const isNativeDialog = tag === 'dialog' && el.hasAttribute('open');
                const style = win.getComputedStyle(el);
                let z = 0;
                if (isNativeDialog) {
                  z = Number.POSITIVE_INFINITY;
                } else if (style.zIndex && style.zIndex !== 'auto') {
                  const parsed = parseInt(style.zIndex, 10);
                  if (!isNaN(parsed)) z = parsed;
                }
                if (z > bestZ) {
                  best = el;
                  bestZ = z;
                }
              }
              if (best) {
                layer1ModalRef = ensureRef(best);
              }
            } catch {
              // Rescue is best-effort. If it throws, we fall back to
              // Layer 2 / undefined activeModalRef — same as before
              // this rescue existed. Never blocks main pipeline.
            }
          }

          return {
            transientState: detectTransientState(),
            obstacleFacts: obstacleFacts.length > 0 ? obstacleFacts : undefined,
            layer2ModalRef,
            layer1ModalRef,
          };
        },
        {
          positionalSelector: POSITIONAL_CANDIDATES_SELECTOR,
          ironCladSelectors: IRON_CLAD_MODAL_SELECTORS,
          closeButtonSelector: CLOSE_BUTTON_SELECTOR,
          interactiveSelector: INTERACTIVE_CHILDREN_SELECTOR,
          alreadyHaveModal: !!activeModalRefAlreadyDetected,
          innerBudgetMs: PHASE_5B_INNER_BUDGET_MS,
          textNodeCap: LEVEL_6_TEXT_NODE_CAP,
          patternNodeCap: LEVEL_6_PATTERN_NODE_CAP,
        },
      );

    // Wall-clock outer guard. The inner watchdog (overBudget) protects
    // against runaway DOM walks; this outer race protects against the
    // evaluate itself failing to return — page event loop fully blocked,
    // CDP transport stalled, etc. We pick a sentinel symbol on timeout
    // so we can distinguish it from a legitimate empty `{}` result.
    const TIMED_OUT = Symbol('phase5b-timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMED_OUT), PHASE_5B_HARD_TIMEOUT_MS);
    });

    try {
      const winner = await Promise.race([overlayPromise, timeoutPromise]);
      if (winner === TIMED_OUT) {
        // Don't await overlayPromise — it may finish later but we've
        // already moved on. Attach a no-op error handler to suppress
        // unhandled-rejection warnings in case the page closes mid-walk.
        overlayPromise.catch(() => {});
        logger.warn('[CDP_SNAPSHOT] enrichWithOverlayState hit hard timeout', {
          hardTimeoutMs: PHASE_5B_HARD_TIMEOUT_MS,
        });
        return {};
      }
      return winner;
    } catch (err) {
      // Distinguish kinds of failure for observability — page-closed
      // races are noise (debug); TypeError / ReferenceError signal a
      // logic bug we want to surface (warn). Same swallow-and-default
      // posture either way: the snapshot is still usable without
      // overlay context.
      const message = err instanceof Error ? err.message : String(err);
      const isPageGone =
        err instanceof Error
        && (
          /Target closed|Execution context was destroyed|Page closed|page has been closed/i.test(message)
        );
      if (isPageGone) {
        logger.debug('[CDP_SNAPSHOT] enrichWithOverlayState page-gone (non-fatal)', { error: message });
      } else {
        logger.warn('[CDP_SNAPSHOT] enrichWithOverlayState evaluate failed (non-fatal)', {
          error: message,
          name: err instanceof Error ? err.name : 'unknown',
        });
      }
      return {};
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Testing-only export of internal helpers. NOT for production
 * consumers — CdpSnapshotService.collect is the public surface.
 * This namespace exists because the helpers are too granular to
 * meaningfully test through the public method (you'd need to mock
 * a full CDP+Page pipeline just to verify `parseTabIndex`).
 *
 * Cost of NOT exporting: tests duplicate parser logic, drift between
 * implementation and assertions, regressions slip through.
 *
 * Cost of exporting: mild API surface bloat. Mitigated by the
 * `__internalsForTesting` name — anyone touching this in production
 * code will see the warning at the call site.
 */
export const __internalsForTesting = {
  decodeAttributes,
  decodeStylesForLayoutIdx,
  decodeBoundsForLayoutIdx,
  isInteractiveNode,
  parseTriState,
  parseAriaChecked,
  parseFloatOrUndefined,
  parseTabIndex,
  tagToImplicitLandmarkRole,
  computeIsSensitiveInput,
  detectAttributeBasedFramework,
  dedupSurvivorScore,
  dedupeElementsByRef,
};
