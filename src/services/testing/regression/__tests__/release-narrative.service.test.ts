/**
 * ReleaseNarrativeService — DB reads/writes stubbed at the `db/` boundary,
 * the LLM call and credit tracker stubbed at their module boundary. No
 * Supabase mocked directly, per the repo's mock-boundary rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/regression/db/regression-run.db', () => ({
  updateRunById: jest.fn().mockResolvedValue({ error: null }),
  getRunNarrativeFields: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));

jest.mock('@/services/core/credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductCreditsForTest: jest.fn().mockResolvedValue({ success: true, newBalance: 100 }) },
}));

jest.mock('@/config/features/release-narrative', () => ({
  ReleaseNarrativeFeature: { isEnabled: jest.fn().mockReturnValue(true), getModel: jest.fn().mockReturnValue('gemini-2.5-flash-lite') },
}));

import { ReleaseNarrativeService, RELEASE_NARRATIVE_CREDITS } from '../release-narrative.service';
import { RELEASE_VERDICT_RULESET_VERSION } from '../release-verdict.util';
import { updateRunById, getRunNarrativeFields } from '../db/regression-run.db';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { ReleaseNarrativeFeature } from '@/config/features/release-narrative';
import type { ReleaseVerdict, EnrichedBug, RunReportSummary } from '@/types/testing.types';

const mockUpdateRunById = updateRunById as jest.Mock;
const mockGetRunNarrativeFields = getRunNarrativeFields as jest.Mock;
const mockGetChatCompletion = getChatCompletionWithMessages as jest.Mock;
const mockDeductCredits = CreditCostTrackerService.deductCreditsForTest as jest.Mock;
const mockIsEnabled = ReleaseNarrativeFeature.isEnabled as jest.Mock;

function run(overrides: Record<string, any> = {}) {
  return { id: 'run-1', status: 'completed', user_id: 'user-1', release_narrative: null, ...overrides };
}

const verdict: ReleaseVerdict = { status: 'not_ready', rulesetVersion: 1, reasons: [{ code: 'CRITICAL_BUG', label: 'x', refType: 'bug', refId: 'bug-1' }] };
const bugs: EnrichedBug[] = [{
  id: 'bug-1', title: 'Login broken', severity: 'critical', category: 'functional',
  testCaseId: 'tc-1', testCaseName: 'Login', executionId: 'exec-1', steps: [], expected: '', actual: '', recommendation: '',
}];
const summary: RunReportSummary = {
  total: 5, passed: 4, failed: 1, skipped: 0, flaky: 0, totalBugs: 1, bySeverity: {}, byCategory: {},
  platformBreakdown: { web: { total: 5, passed: 4, failed: 1 }, mobile: { total: 0, passed: 0, failed: 0 }, api: { total: 0, passed: 0, failed: 0 } },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateRunById.mockResolvedValue({ error: null });
  mockGetRunNarrativeFields.mockResolvedValue(null);
  mockDeductCredits.mockResolvedValue({ success: true, newBalance: 100 });
  mockIsEnabled.mockReturnValue(true);
});

describe('ReleaseNarrativeService.getOrGenerate', () => {
  it('returns the cached narrative without calling the LLM when already generated', async () => {
    const cachedRun = run({
      release_narrative: { headline: 'Cached', prioritizedActions: [], summary: 'cached summary' },
      release_narrative_generated_at: '2026-07-01T00:00:00.000Z',
      release_verdict_at_completion: 'not_ready',
    });
    const result = await ReleaseNarrativeService.getOrGenerate(cachedRun, verdict, bugs, undefined, summary, 'user-1');
    expect(result.narrative?.headline).toBe('Cached');
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });

  it('returns null narrative for a non-terminal run', async () => {
    const result = await ReleaseNarrativeService.getOrGenerate(run({ status: 'running' }), verdict, bugs, undefined, summary, 'user-1');
    expect(result.narrative).toBeNull();
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });

  it('returns null narrative when the feature is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, 'user-1');
    expect(result.narrative).toBeNull();
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });

  it('returns null narrative when there is no run owner id', async () => {
    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, null);
    expect(result.narrative).toBeNull();
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });

  it('generates, persists, and charges credits on a cold cache', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({ headline: 'Not ready to ship', prioritizedActions: [{ bugId: 'bug-1', why: 'Blocks login' }], summary: 'One critical bug found.' }),
    });

    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, 'user-1');

    expect(result.narrative?.headline).toBe('Not ready to ship');
    expect(result.narrative?.prioritizedActions).toEqual([{ bugId: 'bug-1', why: 'Blocks login' }]);
    expect(result.verdictAtCompletion).toBe('not_ready');

    expect(mockUpdateRunById).toHaveBeenCalledWith('run-1', expect.objectContaining({
      release_verdict_at_completion: 'not_ready',
      release_verdict_ruleset_version: RELEASE_VERDICT_RULESET_VERSION,
    }));
    expect(mockDeductCredits).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      credits: RELEASE_NARRATIVE_CREDITS,
      testType: 'intelligent',
    }));
  });

  it('drops a hallucinated bugId not present in the whitelist sent to the model', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        headline: 'Not ready',
        prioritizedActions: [
          { bugId: 'bug-1', why: 'Real bug' },
          { bugId: 'bug-does-not-exist', why: 'Invented by the model' },
        ],
        summary: 'summary',
      }),
    });

    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, 'user-1');

    expect(result.narrative?.prioritizedActions).toEqual([{ bugId: 'bug-1', why: 'Real bug' }]);
  });

  it('returns null narrative (never throws) when the LLM call fails', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('LLM timeout'));
    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, 'user-1');
    expect(result.narrative).toBeNull();
  });

  it('still returns the narrative when credit deduction fails (non-fatal)', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({ headline: 'ok', prioritizedActions: [], summary: 'ok' }),
    });
    mockDeductCredits.mockRejectedValue(new Error('insufficient credits'));

    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, 'user-1');
    expect(result.narrative?.headline).toBe('ok');
  });

  it('re-checks the cache inside the mutex before generating (race with a concurrent fetch)', async () => {
    mockGetRunNarrativeFields.mockResolvedValue({
      release_narrative: { headline: 'Won the race', prioritizedActions: [], summary: 'x' },
      release_narrative_generated_at: '2026-07-01T00:00:00.000Z',
    });

    const result = await ReleaseNarrativeService.getOrGenerate(run(), verdict, bugs, undefined, summary, 'user-1');

    expect(result.narrative?.headline).toBe('Won the race');
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });
});
