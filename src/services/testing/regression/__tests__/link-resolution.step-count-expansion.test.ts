/**
 * LinkResolutionService.expandLinkedStepCounts — read-only, count-only
 * credit-estimate expansion for link_test_case steps (used by
 * RegressionRunService.checkCreditBalance). Verifies:
 *   1. a same-platform link expands to the linked case's own step count
 *      instead of counting as 1.
 *   2. a cross-platform link is left uncounted (flagged instead — it bills
 *      as its own, separate execution).
 *   3. exactly one batched getUiStepCountRows call per distinct linked id,
 *      never one per link (critical-patterns.md #11 — no N+1).
 *
 * Mocks at the db/ boundary, per testing.md.
 */

import { LinkResolutionService } from '../link-resolution.service';
import { RegressionTestQueryService } from '../db/regression-test-query.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

jest.mock('../db/regression-test-query.db', () => ({
  RegressionTestQueryService: {
    getUiStepCountRows: jest.fn(),
  },
}));

const mockGetUiStepCountRows = RegressionTestQueryService.getUiStepCountRows as jest.Mock;

const step = (id: string): IntentStep => ({ id, type: 'click', description: id });

const linkStep = (id: string, linkedTestCaseId: string, linkedPlatform: string): IntentStep => ({
  id,
  type: 'link_test_case',
  description: id,
  options: { linkTestCase: { linkedTestCaseId, linkedPlatform: linkedPlatform as any } },
});

describe('LinkResolutionService.expandLinkedStepCounts', () => {
  beforeEach(() => {
    mockGetUiStepCountRows.mockReset();
    mockGetUiStepCountRows.mockResolvedValue([]);
  });

  it('does not query the DB and reports no cross-platform links when steps_json has no link_test_case step', async () => {
    const rows = [{ id: 'a', steps_json: [step('s1'), step('s2')] }];
    const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: 'web' }],
      rows,
    );

    expect(mockGetUiStepCountRows).not.toHaveBeenCalled();
    expect(expandedLengthById.get('a')).toBe(2);
    expect(hasCrossPlatformLinks).toBe(false);
  });

  it('expands a same-platform link to the linked case\'s own step count', async () => {
    mockGetUiStepCountRows.mockResolvedValue([{ id: 'linked-tc', steps_json: Array.from({ length: 100 }, (_, i) => step(`ls${i}`)) }]);

    const rows = [{ id: 'a', steps_json: [step('s1'), linkStep('link1', 'linked-tc', 'web')] }];
    const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: 'web' }],
      rows,
    );

    expect(mockGetUiStepCountRows).toHaveBeenCalledTimes(1);
    expect(mockGetUiStepCountRows).toHaveBeenCalledWith(['linked-tc']);
    // 1 own step + 100 expanded from the link (NOT 1 + 1)
    expect(expandedLengthById.get('a')).toBe(101);
    expect(hasCrossPlatformLinks).toBe(false);
  });

  it('leaves a cross-platform link counted as 1 and flags hasCrossPlatformLinks, without querying for it', async () => {
    const rows = [{ id: 'a', steps_json: [step('s1'), linkStep('link1', 'other-tc', 'mobile_android')] }];
    const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: 'web' }],
      rows,
    );

    expect(mockGetUiStepCountRows).not.toHaveBeenCalled();
    // 1 own step + 1 for the unexpanded cross-platform marker
    expect(expandedLengthById.get('a')).toBe(2);
    expect(hasCrossPlatformLinks).toBe(true);
  });

  it('batches one query for a linked test case shared by two parent cases (no N+1)', async () => {
    mockGetUiStepCountRows.mockResolvedValue([{ id: 'shared-tc', steps_json: [step('x'), step('y'), step('z')] }]);

    const rows = [
      { id: 'a', steps_json: [linkStep('link1', 'shared-tc', 'web')] },
      { id: 'b', steps_json: [linkStep('link2', 'shared-tc', 'web')] },
    ];
    const { expandedLengthById } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: 'web' }, { testCaseId: 'b', platform: 'web' }],
      rows,
    );

    expect(mockGetUiStepCountRows).toHaveBeenCalledTimes(1);
    expect(mockGetUiStepCountRows).toHaveBeenCalledWith(['shared-tc']);
    expect(expandedLengthById.get('a')).toBe(3);
    expect(expandedLengthById.get('b')).toBe(3);
  });

  it('falls back to counting a link as 1 when the linked test case no longer exists', async () => {
    mockGetUiStepCountRows.mockResolvedValue([]); // deleted — omitted, not errored

    const rows = [{ id: 'a', steps_json: [linkStep('link1', 'deleted-tc', 'web')] }];
    const { expandedLengthById } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: 'web' }],
      rows,
    );

    expect(expandedLengthById.get('a')).toBe(1);
  });

  it('mixes a same-platform expansion with a cross-platform flag on the same row', async () => {
    mockGetUiStepCountRows.mockResolvedValue([{ id: 'same-tc', steps_json: [step('x'), step('y')] }]);

    const rows = [{
      id: 'a',
      steps_json: [
        linkStep('link1', 'same-tc', 'web'),
        linkStep('link2', 'other-tc', 'mobile_android'),
      ],
    }];
    const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: 'web' }],
      rows,
    );

    // 2 expanded from the same-platform link + 1 for the cross-platform marker
    expect(expandedLengthById.get('a')).toBe(3);
    expect(hasCrossPlatformLinks).toBe(true);
  });

  it('treats a missing platform as web, matching computeUiStepCredits\' own default', async () => {
    const rows = [{ id: 'a', steps_json: [linkStep('link1', 'other-tc', 'web')] }];
    mockGetUiStepCountRows.mockResolvedValue([{ id: 'other-tc', steps_json: [step('x')] }]);

    const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
      [{ testCaseId: 'a', platform: undefined }],
      rows,
    );

    expect(hasCrossPlatformLinks).toBe(false);
    expect(expandedLengthById.get('a')).toBe(1);
  });

  // Regression: a chain nested 2+ levels deep used to be under-estimated —
  // only the FIRST level's link expanded, using the linked case's raw
  // steps_json.length (which counts a nested link_test_case step as 1
  // regardless of what it points to). Dispatch itself recurses to
  // MAX_LINKED_TEST_CASE_DEPTH, so the estimate silently missed hundreds of
  // real, billed steps for a multi-level chain.
  describe('recursive (multi-level) expansion', () => {
    it('expands a 3-level nested same-platform chain fully, not just one level', async () => {
      // a -> mid (1 own step + link) -> grandchild (50 own steps)
      mockGetUiStepCountRows.mockImplementation(async (ids: string[]) => {
        if (ids.includes('mid')) return [{ id: 'mid', platform: 'web', steps_json: [step('mid-own'), linkStep('link2', 'grandchild', 'web')] }];
        if (ids.includes('grandchild')) return [{ id: 'grandchild', platform: 'web', steps_json: Array.from({ length: 50 }, (_, i) => step(`g${i}`)) }];
        return [];
      });

      const rows = [{ id: 'a', steps_json: [step('a-own'), linkStep('link1', 'mid', 'web')] }];
      const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
        [{ testCaseId: 'a', platform: 'web' }],
        rows,
      );

      // a: 1 own + mid's effective length (1 own + grandchild's 50) = 1 + 51 = 52
      expect(expandedLengthById.get('a')).toBe(52);
      expect(hasCrossPlatformLinks).toBe(false);
      // one batched call per level, not per link
      expect(mockGetUiStepCountRows).toHaveBeenCalledTimes(2);
      expect(mockGetUiStepCountRows).toHaveBeenNthCalledWith(1, ['mid']);
      expect(mockGetUiStepCountRows).toHaveBeenNthCalledWith(2, ['grandchild']);
    });

    it('throws when a same-platform chain exceeds MAX_LINKED_TEST_CASE_DEPTH, matching the runtime resolver', async () => {
      // A chain of 7 same-platform links — deeper than MAX_LINKED_TEST_CASE_DEPTH (5).
      const chainLink = (from: number, to: number) => linkStep(`link${from}`, `n${to}`, 'web');
      mockGetUiStepCountRows.mockImplementation(async (ids: string[]) => {
        const id = ids[0];
        const n = Number(id.replace('n', ''));
        if (n >= 7) return [{ id, platform: 'web', steps_json: [step('leaf')] }];
        return [{ id, platform: 'web', steps_json: [chainLink(n, n + 1)] }];
      });

      const rows = [{ id: 'a', steps_json: [chainLink(0, 1)] }];
      await expect(
        LinkResolutionService.expandLinkedStepCounts([{ testCaseId: 'a', platform: 'web' }], rows),
      ).rejects.toThrow(/exceeds max depth/);
    });

    it('does not infinite-loop or double-count a same-platform link cycle (defense in depth)', async () => {
      // a -> b -> a (cycle). Save-time cycle detection should prevent this
      // existing in practice; this asserts the estimate degrades safely if
      // one somehow does.
      mockGetUiStepCountRows.mockImplementation(async (ids: string[]) => {
        if (ids.includes('b')) return [{ id: 'b', platform: 'web', steps_json: [step('b-own'), linkStep('back', 'a', 'web')] }];
        return [];
      });

      const rows = [{ id: 'a', steps_json: [step('a-own'), linkStep('link1', 'b', 'web')] }];
      const { expandedLengthById } = await LinkResolutionService.expandLinkedStepCounts(
        [{ testCaseId: 'a', platform: 'web' }],
        rows,
      );

      // a: 1 own + b's length. b: 1 own + (cycle back to a, mid-computation) counted as 1 = 2.
      // a total: 1 + 2 = 3. Must resolve to a finite number, not hang or throw a stack overflow.
      expect(expandedLengthById.get('a')).toBe(3);
    });

    it('uses the linked row\'s own platform column for a link discovered below the top level', async () => {
      // a (web) -> mid (web) -> grandchild is MOBILE — a link from mid to
      // grandchild on a different platform must be flagged, not expanded,
      // even though grandchild was reached two levels below the caller-
      // supplied uiCases (which only lists platform for top-level cases).
      mockGetUiStepCountRows.mockImplementation(async (ids: string[]) => {
        if (ids.includes('mid')) return [{ id: 'mid', platform: 'web', steps_json: [linkStep('link2', 'grandchild', 'mobile_android')] }];
        return [];
      });

      const rows = [{ id: 'a', steps_json: [linkStep('link1', 'mid', 'web')] }];
      const { expandedLengthById, hasCrossPlatformLinks } = await LinkResolutionService.expandLinkedStepCounts(
        [{ testCaseId: 'a', platform: 'web' }],
        rows,
      );

      // a: mid's length = 1 (unexpanded cross-platform marker inside mid)
      expect(expandedLengthById.get('a')).toBe(1);
      expect(hasCrossPlatformLinks).toBe(true);
      expect(mockGetUiStepCountRows).toHaveBeenCalledTimes(1);
    });
  });
});
