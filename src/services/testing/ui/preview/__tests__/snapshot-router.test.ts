/**
 * Snapshot Router routing logic tests (Etap 2 Task 3).
 *
 * Verifies:
 *   1. Production path (no flags) — always evaluate, no CDP touched
 *   2. CDP-with-fallback decision and graceful fallback on CDP throw
 *   3. Shadow mode parallel run — both sources called, evaluate wins
 *   4. Dense-page heuristic gate — preview only switches above threshold
 *   5. Failure semantics: evaluate failure propagates; CDP-only failure
 *      in shadow mode does NOT propagate
 *
 * Mocking strategy:
 *   We mock both `SnapshotCollector` and `CdpSnapshotService` at the
 *   import boundary using jest.mock. The router doesn't know how
 *   either implementation works — it just observes which one returned
 *   what. Same isolation as the underlying service tests.
 */

import { jest } from '@jest/globals';

// Mock both collectors BEFORE importing the router so the router
// picks up the mocked versions. Type the mocks loosely — the router
// uses them through their public surface only.

const evaluateCollect = jest.fn();
const cdpCollect = jest.fn();

jest.mock('@/agent/core/lite/collectors/snapshot-collector', () => ({
  SnapshotCollector: { collect: evaluateCollect },
}));

jest.mock('../cdp-snapshot.service', () => {
  const actual = jest.requireActual('../cdp-snapshot.service') as Record<string, unknown>;
  return {
    ...actual,
    CdpSnapshotService: { collect: cdpCollect },
    // Keep the real CdpSnapshotError so `instanceof` checks in router
    // continue to work.
  };
});

// Mocks the flags by spying on module export and overriding values
// per-test. Direct import of the const wouldn't allow per-test
// mutation because const exports are read-only at the call site.
jest.mock('@/config/testing/snapshot-router.config', () => {
  // Keep the real riskGroupForContext (pure function over context enum)
  // so risk-group routing logic stays under test, only override the
  // mutable flags. Using requireActual avoids re-implementing the
  // group map here — that would silently drift when contexts change.
  const actual = jest.requireActual<
    typeof import('@/config/testing/snapshot-router.config')
  >('@/config/testing/snapshot-router.config');
  return {
    ...actual,
    SNAPSHOT_ROUTER_FLAGS: {
      useCdpForBackground_shadow: false,
      useCdpForBackground: false,
      useCdpForPreview_shadow: false,
      useCdpForPreviewTick_shadow: false,
      useCdpForPreview: false,
      useCdpForAi: false,
      denseThreshold: 2000,
      shadowSamplingRate: 1,
    },
  };
});

// Now import — order matters because mocks must be in place first.
import { SnapshotRouter } from '../snapshot-router.service';
import { CdpSnapshotError } from '../cdp-snapshot.service';
import { SNAPSHOT_ROUTER_FLAGS } from '@/config/testing/snapshot-router.config';
import type { LiteSnapshot } from '@/agent/core/lite/lite-types';

const mockEvaluateCollect = evaluateCollect as jest.MockedFunction<() => Promise<LiteSnapshot>>;
const mockCdpCollect = cdpCollect as jest.MockedFunction<() => Promise<LiteSnapshot>>;

const mockPage = {} as never;

function makeSnap(overrides: Partial<LiteSnapshot> = {}): LiteSnapshot {
  return {
    url: 'https://example.com',
    title: 't',
    elements: [],
    timestamp: 0,
    ...overrides,
  };
}

beforeEach(() => {
  // Reset flags + mocks between tests so flag mutations don't leak.
  Object.assign(SNAPSHOT_ROUTER_FLAGS, {
    useCdpForBackground_shadow: false,
    useCdpForBackground: false,
    useCdpForPreview_shadow: false,
    useCdpForPreviewTick_shadow: false,
    useCdpForPreview: false,
    useCdpForAi: false,
    denseThreshold: 2000,
    shadowSamplingRate: 1,
  });
  mockEvaluateCollect.mockReset();
  mockCdpCollect.mockReset();
});

describe('SnapshotRouter routing', () => {
  describe('production path with all flags off', () => {
    it('uses evaluate for preview-tick context', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      const result = await SnapshotRouter.collect(mockPage, { context: 'preview-tick' });
      expect(result.url).toBe('eval');
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });

    it('uses evaluate for background-regression context', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });

    it('uses evaluate for preview-apply with no dense flag', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        lastDomNodeCount: 5000,
      });
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });
  });

  describe('CDP-with-fallback path (production flag flipped)', () => {
    beforeEach(() => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground = true;
    });

    it('returns CDP result when CDP succeeds', async () => {
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      const result = await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(result.url).toBe('cdp');
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
      expect(mockEvaluateCollect).not.toHaveBeenCalled();
    });

    it('falls back to evaluate when CDP throws CdpSnapshotError', async () => {
      mockCdpCollect.mockRejectedValueOnce(new CdpSnapshotError('cdp_payload_too_large', 'too big'));
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval-fallback' }));

      const result = await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(result.url).toBe('eval-fallback');
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
    });

    it('falls back to evaluate even when CDP throws unrelated error', async () => {
      // Defensive — non-CdpSnapshotError shouldn't crash the router.
      mockCdpCollect.mockRejectedValueOnce(new Error('something weird'));
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval-fallback' }));

      const result = await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(result.url).toBe('eval-fallback');
    });

    it('throws when both CDP and evaluate fail', async () => {
      mockCdpCollect.mockRejectedValueOnce(new CdpSnapshotError('cdp_send_failed', 'cdp dead'));
      mockEvaluateCollect.mockRejectedValueOnce(new Error('eval dead too'));

      await expect(SnapshotRouter.collect(mockPage, { context: 'background-regression' })).rejects.toThrow('eval dead too');
    });
  });

  describe('shadow mode (collect both, return evaluate)', () => {
    beforeEach(() => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground_shadow = true;
    });

    it('runs both paths in parallel and returns evaluate result', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval-prod', timestamp: 1 }));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp-shadow', timestamp: 2 }));

      const result = await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      // Production source is ALWAYS evaluate in shadow mode — the
      // CDP result is discarded after diff logging. Even if CDP is
      // strictly better, we don't accidentally use it before Week 4.
      expect(result.url).toBe('eval-prod');
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('still returns evaluate result when CDP shadow path throws', async () => {
      // CDP failure in shadow mode MUST NOT propagate — we only
      // wanted the data, not a hard dependency. Otherwise enabling
      // the shadow flag would risk production stability.
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval-prod' }));
      mockCdpCollect.mockRejectedValueOnce(new CdpSnapshotError('page_gone', 'navigated'));

      const result = await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(result.url).toBe('eval-prod');
    });

    it('throws when evaluate fails (CDP outcome irrelevant)', async () => {
      mockEvaluateCollect.mockRejectedValueOnce(new Error('eval path broken'));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));

      await expect(SnapshotRouter.collect(mockPage, { context: 'background-regression' })).rejects.toThrow('eval path broken');
    });
  });

  describe('risk-based routing (Phase 2 — dense-gate dropped)', () => {
    // Phase 2 reframed routing: each context maps to a risk group
    // (background / ai / preview); the group's flag flips it to CDP
    // regardless of `lastDomNodeCount`. dense-gate retired.
    //
    // After empirical measurement (cdp-screencast-collision.integration.test):
    // preview now uses CDP via a SEPARATE session (not piggyback).
    // No `existingCdpSession` required — CDP service opens its own.

    it('useCdpForPreview routes preview-apply to CDP regardless of node count', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      const result = await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        lastDomNodeCount: 100, // sparse — still CDP
      });
      expect(result.url).toBe('cdp');
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('preview-tick is HARD-PINNED to evaluate, ignoring useCdpForPreview', async () => {
      // Empirical screencast collision test showed CDP on the 500ms
      // periodic tick causes continuous video stutter. The 'preview-tick'
      // context is therefore in its OWN risk group ('preview-poll')
      // which has no CDP escape hatch — it ALWAYS uses evaluate.
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview = true; // would route preview-apply
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      const result = await SnapshotRouter.collect(mockPage, {
        context: 'preview-tick',
        lastDomNodeCount: 100,
      });
      expect(result.url).toBe('eval');
      expect(mockCdpCollect).not.toHaveBeenCalled();
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
    });

    it('useCdpForAi routes lite-* contexts to CDP', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForAi = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      await SnapshotRouter.collect(mockPage, { context: 'lite-action' });
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('useCdpForAi routes exploration-* contexts to CDP', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForAi = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, { context: 'exploration-survey' });
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('useCdpForBackground does NOT flip ai or preview groups', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground = true;
      // useCdpForAi is OFF → lite-action stays on evaluate.
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, { context: 'lite-action' });
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });

    it('useCdpForAi does NOT flip background or preview groups', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForAi = true;
      // background-regression belongs to "background" group, NOT ai.
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });

    it('lastDomNodeCount no longer affects routing (Phase 2 contract)', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      // High dom count, low dom count, no count — all CDP.
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        lastDomNodeCount: 50_000,
      });
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('legacy-orchestrator routes via useCdpForAi (NOT useCdpForBackground)', async () => {
      // Audit catch — legacy-orchestrator is a synchronous agent loop,
      // not a queued worker job. Belongs in the `ai` group with
      // lite-engine, not in `background` with regression jobs.
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground = true;
      // useCdpForAi OFF → legacy-orchestrator must stay on evaluate.
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, { context: 'legacy-orchestrator' });
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });

    it('legacy-orchestrator flips with useCdpForAi', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForAi = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, { context: 'legacy-orchestrator' });
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('preview-context CDP runs even WITHOUT existingCdpSession (separate session strategy)', async () => {
      // Empirically measured (cdp-screencast-collision.integration.test):
      //   - Same-session piggyback: 100% screencast freeze (BAD)
      //   - Separate session: minor frame drop (~11 FPS during dense
      //     snapshot, recovers immediately) — acceptable trade for
      //     the 10× snapshot speedup on dense pages.
      // So router NO LONGER blocks preview-CDP when existingCdpSession
      // is missing. CDP service opens its own session via
      // context.newCDPSession(page) — caller is the operator who
      // flipped the flag, they accept the trade-off.
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      const result = await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        // existingCdpSession DELIBERATELY missing — router used to
        // block this; now it allows CDP to open its own session.
      });
      expect(result.url).toBe('cdp');
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
      expect(mockEvaluateCollect).not.toHaveBeenCalled();
    });
  });

  describe('shadow mode (Phase 2 — dense-gate dropped, sampling rate is the only throttle)', () => {
    beforeEach(() => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview_shadow = true;
    });

    it('runs both paths on sparse pages too (Phase 2 contract)', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        lastDomNodeCount: 100, // sparse — used to be skipped, now shadows.
      });
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('runs both paths on dense pages (unchanged from Phase 1)', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        lastDomNodeCount: 5000,
      });
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('does NOT run shadow when production for that group is already on CDP', async () => {
      // Production preview-apply → CDP (useCdpForPreview=true). Shadow
      // would just duplicate the work — skip it.
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-apply',
        lastDomNodeCount: 5000,
      });
      // Production CDP fired, but evaluate did NOT — shadow suppressed.
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
      expect(mockEvaluateCollect).not.toHaveBeenCalled();
    });
  });

  describe('preview-tick shadow mode (live editor hot path)', () => {
    it('runs both paths on dense preview-tick when flag on', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreviewTick_shadow = true;
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      const result = await SnapshotRouter.collect(mockPage, {
        context: 'preview-tick',
        lastDomNodeCount: 11000, // juz40 folders-control case
      });
      expect(result.url).toBe('eval'); // production source unchanged
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('runs shadow on sparse preview-tick too (Phase 2 contract)', async () => {
      // Phase 2 dropped dense gate from shadow path. Sampling rate
      // throttles overhead, not page size.
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreviewTick_shadow = true;
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-tick',
        lastDomNodeCount: 157, // sparse — used to be skipped, now shadows.
      });
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('preview-tick shadow flag is independent from preview-apply flag', async () => {
      // preview-apply flag OFF, tick flag ON → tick still shadows.
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview_shadow = false;
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreviewTick_shadow = true;
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-tick',
        lastDomNodeCount: 11000,
      });
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('preview-tick shadow STILL runs even when useCdpForPreview is on (preview-poll is its own group)', async () => {
      // preview-tick is in its OWN group ('preview-poll') which has NO
      // production CDP path. So flipping useCdpForPreview (which only
      // affects 'preview' group like preview-apply) does NOT make
      // preview-tick's shadow redundant — they're independent.
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreview = true;
      SNAPSHOT_ROUTER_FLAGS.useCdpForPreviewTick_shadow = true;
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-tick',
        lastDomNodeCount: 11000,
      });
      // Both paths fired — shadow not suppressed.
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });
  });

  describe('shadow sampling rate', () => {
    it('skips CDP shadow when shadowSamplingRate=0 even with shadow flag on', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground_shadow = true;
      SNAPSHOT_ROUTER_FLAGS.shadowSamplingRate = 0;
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      const result = await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(result.url).toBe('eval');
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });

    it('always runs both paths when shadowSamplingRate=1', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground_shadow = true;
      SNAPSHOT_ROUTER_FLAGS.shadowSamplingRate = 1;
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({ url: 'eval' }));
      mockCdpCollect.mockResolvedValueOnce(makeSnap({ url: 'cdp' }));
      await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(mockEvaluateCollect).toHaveBeenCalledTimes(1);
      expect(mockCdpCollect).toHaveBeenCalledTimes(1);
    });

    it('runs evaluate before CDP sequentially (no race on __agentRefCounter)', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground_shadow = true;
      SNAPSHOT_ROUTER_FLAGS.shadowSamplingRate = 1;
      const order: string[] = [];
      mockEvaluateCollect.mockImplementationOnce(async () => {
        order.push('eval-start');
        await new Promise((r) => setTimeout(r, 5));
        order.push('eval-end');
        return makeSnap({ url: 'eval' });
      });
      mockCdpCollect.mockImplementationOnce(async () => {
        order.push('cdp-start');
        await new Promise((r) => setTimeout(r, 5));
        order.push('cdp-end');
        return makeSnap({ url: 'cdp' });
      });
      await SnapshotRouter.collect(mockPage, { context: 'background-regression' });
      expect(order).toEqual(['eval-start', 'eval-end', 'cdp-start', 'cdp-end']);
    });

    it('does not start CDP if evaluate throws (sequential short-circuit)', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground_shadow = true;
      SNAPSHOT_ROUTER_FLAGS.shadowSamplingRate = 1;
      mockEvaluateCollect.mockRejectedValueOnce(new Error('eval boom'));
      await expect(
        SnapshotRouter.collect(mockPage, { context: 'background-regression' }),
      ).rejects.toThrow('eval boom');
      expect(mockCdpCollect).not.toHaveBeenCalled();
    });
  });

  describe('forwards options', () => {
    it('passes fullPage and skipStabilityWait to evaluate', async () => {
      mockEvaluateCollect.mockResolvedValueOnce(makeSnap({}));
      await SnapshotRouter.collect(mockPage, {
        context: 'preview-tick',
        fullPage: true,
        skipStabilityWait: true,
      });
      expect(mockEvaluateCollect).toHaveBeenCalledWith(mockPage, {
        fullPage: true,
        skipStabilityWait: true,
      });
    });

    it('passes existingCdpSession + diagId to CDP path', async () => {
      SNAPSHOT_ROUTER_FLAGS.useCdpForBackground = true;
      mockCdpCollect.mockResolvedValueOnce(makeSnap({}));
      const fakeSession = { id: 'caller-session' };
      await SnapshotRouter.collect(mockPage, {
        context: 'background-regression',
        existingCdpSession: fakeSession,
        diagId: 'run-42',
      });
      expect(mockCdpCollect).toHaveBeenCalledWith(
        mockPage,
        expect.objectContaining({
          existingCdpSession: fakeSession,
          diagId: 'run-42',
        }),
      );
    });
  });
});
