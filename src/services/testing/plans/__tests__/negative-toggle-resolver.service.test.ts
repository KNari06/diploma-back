/**
 * Unit tests for NegativeToggleResolverService — toggle inheritance + expansion.
 * DB stubbed at the negative `db/` boundary; RegressionPlanService.expandPlan stubbed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/negative/db/negative.db', () => ({
  getPlanItemsForToggle: jest.fn(),
  getFreshNegativesBySources: jest.fn(),
}));

const mockExpandPlan = jest.fn();
jest.mock('../regression-plan.service', () => ({
  RegressionPlanService: { expandPlan: (...a: any[]) => mockExpandPlan(...a) },
}));

import { NegativeToggleResolverService } from '../negative-toggle-resolver.service';
import * as negativeDb from '@/services/testing/negative/db/negative.db';

const item = (over: any) => ({
  item_type: 'test_case',
  test_case_id: null,
  flow_id: null,
  module_id: null,
  negative_testing_enabled: null,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('resolveForTestCase inheritance (test_case → flow → module)', () => {
  it('returns false (disabled) when all items inherit (null)', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tc1' }),
      item({ item_type: 'flow', flow_id: 'f1' }),
      item({ item_type: 'module', module_id: 'm1' }),
    ]);
    expect(await NegativeToggleResolverService.resolveForTestCase('p', 'tc1', 'f1', 'm1')).toBe(false);
  });

  it('test_case-level explicit value wins over flow/module', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tc1', negative_testing_enabled: false }),
      item({ item_type: 'flow', flow_id: 'f1', negative_testing_enabled: true }),
      item({ item_type: 'module', module_id: 'm1', negative_testing_enabled: true }),
    ]);
    expect(await NegativeToggleResolverService.resolveForTestCase('p', 'tc1', 'f1', 'm1')).toBe(false);
  });

  it('falls through to flow when test_case inherits', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tc1', negative_testing_enabled: null }),
      item({ item_type: 'flow', flow_id: 'f1', negative_testing_enabled: true }),
    ]);
    expect(await NegativeToggleResolverService.resolveForTestCase('p', 'tc1', 'f1', 'm1')).toBe(true);
  });

  it('falls through to module when test_case and flow inherit', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'module', module_id: 'm1', negative_testing_enabled: true }),
    ]);
    expect(await NegativeToggleResolverService.resolveForTestCase('p', 'tc1', 'f1', 'm1')).toBe(true);
  });

  it('returns false when the plan has no items', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([]);
    expect(await NegativeToggleResolverService.resolveForTestCase('p', 'tc1')).toBe(false);
  });
});

describe('expandNegatives', () => {
  it('skips non-ui (mobile/api) parents and maps fresh negatives to ExpandedTestCase', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tc1', negative_testing_enabled: true }),
      item({ item_type: 'test_case', test_case_id: 'tcM', negative_testing_enabled: true }),
    ]);
    (negativeDb.getFreshNegativesBySources as jest.Mock).mockResolvedValue([
      { id: 'neg1', name: '[NEG] tc1', flow_id: 'f1', source_intent_test_case_id: 'tc1', negative_meta: { mutationType: 'xss' } },
    ]);

    const positives: any[] = [
      { testCaseId: 'tc1', testType: 'ui', flowId: 'f1', moduleId: 'm1', name: 'tc1' },
      { testCaseId: 'tcM', testType: 'mobile', flowId: 'f1', moduleId: 'm1', name: 'mobile case' },
    ];

    const result = await NegativeToggleResolverService.expandNegatives('p', positives);

    // mobile parent excluded from the enabled-source query
    expect((negativeDb.getFreshNegativesBySources as jest.Mock).mock.calls[0][0]).toEqual(['tc1']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ testCaseId: 'neg1', isNegative: true, testType: 'ui', sourceTestCaseId: 'tc1' });
  });

  it('returns [] when no positive is enabled', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tc1', negative_testing_enabled: false }),
    ]);
    const result = await NegativeToggleResolverService.expandNegatives('p', [
      { testCaseId: 'tc1', testType: 'ui', name: 'tc1' } as any,
    ]);
    expect(result).toEqual([]);
    expect(negativeDb.getFreshNegativesBySources).not.toHaveBeenCalled();
  });

  it('copies the parent platform onto the negative so it routes to the mobile runner', async () => {
    // A real mobile test case is testType:'ui' (platform distinguishes web vs
    // mobile), so it is NOT skipped by the testType gate — it gets negatives.
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tcMob', negative_testing_enabled: true }),
    ]);
    (negativeDb.getFreshNegativesBySources as jest.Mock).mockResolvedValue([
      { id: 'negMob', name: '[NEG] mobile', flow_id: 'fM', source_intent_test_case_id: 'tcMob', negative_meta: {} },
    ]);

    const result = await NegativeToggleResolverService.expandNegatives('p', [
      { testCaseId: 'tcMob', testType: 'ui', platform: 'mobile_android', flowId: 'fM', moduleId: 'mM', name: 'mobile login' } as any,
    ]);

    expect(result).toHaveLength(1);
    // Without this, the negative has no platform → dispatched as web → fails.
    expect(result[0].platform).toBe('mobile_android');
  });
});

describe('getEnabledTestCaseIds', () => {
  it('returns only enabled, ui, non-negative test cases', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([
      item({ item_type: 'test_case', test_case_id: 'tc1', negative_testing_enabled: true }),
    ]);
    mockExpandPlan.mockResolvedValue([
      { testCaseId: 'tc1', testType: 'ui', flowId: 'f1', moduleId: 'm1', isNegative: false },
      { testCaseId: 'tc1neg', testType: 'ui', isNegative: true }, // negative — skip
      { testCaseId: 'tcApi', testType: 'api', isNegative: false }, // non-ui — skip
    ]);

    const ids = await NegativeToggleResolverService.getEnabledTestCaseIds('p');
    expect(ids).toEqual(['tc1']);
  });

  it('returns [] when the plan has no items', async () => {
    (negativeDb.getPlanItemsForToggle as jest.Mock).mockResolvedValue([]);
    const ids = await NegativeToggleResolverService.getEnabledTestCaseIds('p');
    expect(ids).toEqual([]);
    expect(mockExpandPlan).not.toHaveBeenCalled();
  });
});
