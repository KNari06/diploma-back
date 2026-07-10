/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/config/features/visual-anomaly-sweep', () => ({
  VisualAnomalySweepFeature: {
    getSampleStrategy: jest.fn().mockReturnValue('final_and_failure'),
    getMaxScreenshotsPerTestCase: jest.fn().mockReturnValue(2),
    getMinRecurrenceThreshold: jest.fn().mockReturnValue(2),
    getRecurrenceWindowDays: jest.fn().mockReturnValue(30),
    getModel: jest.fn().mockReturnValue('gemini-2.5-flash'),
  },
}));

jest.mock('../db/visual-anomaly.db', () => ({
  getFindingByPatternKey: jest.fn(),
  insertFinding: jest.fn().mockResolvedValue({ error: null }),
  updateFinding: jest.fn().mockResolvedValue({ error: null }),
  getExecutedStepsForTest: jest.fn(),
}));

jest.mock('@/services/ai/core/gemini.service', () => ({
  generateTextWithGeminiVision: jest.fn(),
}));

import { sampleScreenshots, upsertObservation, runSweep, classifySweepDispatch } from '../visual-anomaly-check.service';
import { VisualAnomalySweepFeature } from '@/config/features/visual-anomaly-sweep';
import { getFindingByPatternKey, insertFinding, updateFinding, getExecutedStepsForTest } from '../db/visual-anomaly.db';
import { generateTextWithGeminiVision } from '@/services/ai/core/gemini.service';
import { logger } from '@/utils/core/logger';

const mockLoggerInfo = logger.info as jest.Mock;

const mockGetStrategy = VisualAnomalySweepFeature.getSampleStrategy as jest.Mock;
const mockGetMax = VisualAnomalySweepFeature.getMaxScreenshotsPerTestCase as jest.Mock;
const mockGetThreshold = VisualAnomalySweepFeature.getMinRecurrenceThreshold as jest.Mock;
const mockGetFinding = getFindingByPatternKey as jest.Mock;
const mockInsertFinding = insertFinding as jest.Mock;
const mockUpdateFinding = updateFinding as jest.Mock;
const mockGetExecutedSteps = getExecutedStepsForTest as jest.Mock;
const mockGenerateVision = generateTextWithGeminiVision as jest.Mock;

function step(overrides: Record<string, any> = {}) {
  return { type: 'step_completed', data: { success: true, runtimeMeta: { stepScreenshotUrl: 'https://x/shot.png' }, ...overrides.data }, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStrategy.mockReturnValue('final_and_failure');
  mockGetMax.mockReturnValue(2);
  mockGetThreshold.mockReturnValue(2);
});

describe('sampleScreenshots', () => {
  it('returns the final screenshot when all steps passed', () => {
    const steps = [
      step({ data: { success: true, runtimeMeta: { stepScreenshotUrl: 'https://x/1.png' } } }),
      step({ data: { success: true, runtimeMeta: { stepScreenshotUrl: 'https://x/2.png' } } }),
    ];
    const result = sampleScreenshots(steps);
    expect(result).toEqual([{ url: 'https://x/2.png', role: 'final' }]);
  });

  it('includes both the final shot and a distinct failure shot', () => {
    const steps = [
      step({ data: { success: false, runtimeMeta: { stepScreenshotUrl: 'https://x/fail.png' } } }),
      step({ data: { success: true, runtimeMeta: { stepScreenshotUrl: 'https://x/final.png' } } }),
    ];
    const result = sampleScreenshots(steps);
    expect(result).toEqual(expect.arrayContaining([
      { url: 'https://x/final.png', role: 'final' },
      { url: 'https://x/fail.png', role: 'failure' },
    ]));
    expect(result).toHaveLength(2);
  });

  it('does not duplicate a URL that is both the last step and a failure', () => {
    const steps = [
      step({ data: { success: false, runtimeMeta: { stepScreenshotUrl: 'https://x/only.png' } } }),
    ];
    const result = sampleScreenshots(steps);
    expect(result).toEqual([{ url: 'https://x/only.png', role: 'final' }]);
  });

  it('ignores base64 data URIs (never already-persisted URLs)', () => {
    const steps = [step({ data: { success: true, runtimeMeta: { stepScreenshotUrl: 'data:image/png;base64,abc' } } })];
    expect(sampleScreenshots(steps)).toEqual([]);
  });

  it('respects the configured max screenshots per test case', () => {
    mockGetMax.mockReturnValue(1);
    mockGetStrategy.mockReturnValue('all_failures');
    const steps = [
      step({ data: { success: false, runtimeMeta: { stepScreenshotUrl: 'https://x/1.png' } } }),
      step({ data: { success: false, runtimeMeta: { stepScreenshotUrl: 'https://x/2.png' } } }),
      step({ data: { success: true, runtimeMeta: { stepScreenshotUrl: 'https://x/3.png' } } }),
    ];
    expect(sampleScreenshots(steps)).toHaveLength(1);
  });

  it('returns [] when there are no completed steps', () => {
    expect(sampleScreenshots([])).toEqual([]);
  });
});

describe('upsertObservation — the truthfulness gate', () => {
  const baseParams = {
    projectId: 'proj-1',
    testCaseId: 'tc-1',
    userId: 'user-1',
    runId: 'run-A',
    role: 'final' as const,
    category: 'placeholder_text' as const,
    description: 'Lorem ipsum on the checkout page',
    confidence: 0.9,
    screenshotUrl: 'https://x/shot.png',
  };

  it('inserts a fresh finding at status "below_threshold" on first observation (threshold=2)', async () => {
    mockGetFinding.mockResolvedValue(null);
    await upsertObservation(baseParams);
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      recurrence_count: 1,
      status: 'below_threshold',
      affected_run_ids: ['run-A'],
    }));
  });

  it('surfaces on the FIRST observation when threshold=1 — the real-world default as of 2026-07-10', async () => {
    mockGetThreshold.mockReturnValue(1);
    mockGetFinding.mockResolvedValue(null);
    await upsertObservation(baseParams);
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      recurrence_count: 1,
      status: 'surfaced',
      affected_run_ids: ['run-A'],
    }));
  });

  it('flips to "surfaced" only once a SECOND independent run observes the same fingerprint', async () => {
    mockGetFinding.mockResolvedValue({
      id: 'finding-1',
      affected_run_ids: ['run-A'],
      recurrence_count: 1,
      status: 'below_threshold',
      last_seen_at: new Date().toISOString(),
    });
    await upsertObservation({ ...baseParams, runId: 'run-B' });
    expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({
      recurrence_count: 2,
      status: 'surfaced',
      affected_run_ids: ['run-A', 'run-B'],
    }));
  });

  it('does not double-count a retry observation from the SAME run', async () => {
    mockGetFinding.mockResolvedValue({
      id: 'finding-1',
      affected_run_ids: ['run-A'],
      recurrence_count: 1,
      status: 'below_threshold',
      last_seen_at: new Date().toISOString(),
    });
    await upsertObservation({ ...baseParams, runId: 'run-A' });
    expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({
      recurrence_count: 1,
      status: 'below_threshold',
      affected_run_ids: ['run-A'],
    }));
  });

  it('never reverts an already-surfaced finding back to below_threshold', async () => {
    mockGetFinding.mockResolvedValue({
      id: 'finding-1',
      affected_run_ids: ['run-A', 'run-B'],
      recurrence_count: 2,
      status: 'surfaced',
      last_seen_at: new Date().toISOString(),
    });
    await upsertObservation({ ...baseParams, runId: 'run-A' }); // same run re-observes, count unchanged
    expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({ status: 'surfaced' }));
  });

  it('never resurfaces a dismissed finding even after clearing the threshold again', async () => {
    mockGetFinding.mockResolvedValue({
      id: 'finding-1',
      affected_run_ids: ['run-A', 'run-B'],
      recurrence_count: 2,
      status: 'dismissed',
      last_seen_at: new Date().toISOString(),
    });
    await upsertObservation({ ...baseParams, runId: 'run-C' });
    expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({ status: 'dismissed' }));
  });

  it('resets affected_run_ids when the prior observation is outside the recurrence window (stale)', async () => {
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago, window=30
    mockGetFinding.mockResolvedValue({
      id: 'finding-1',
      affected_run_ids: ['run-A'],
      recurrence_count: 1,
      status: 'below_threshold',
      last_seen_at: staleDate,
    });
    await upsertObservation({ ...baseParams, runId: 'run-Z' });
    expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({
      affected_run_ids: ['run-Z'],
      recurrence_count: 1,
    }));
  });
});

describe('runSweep — tolerates markdown-fenced Gemini responses', () => {
  const sweepParams = {
    testId: 'test-1',
    testCaseId: 'tc-1',
    runId: 'run-A',
    projectId: 'proj-1',
    userId: 'user-1',
  };

  beforeEach(() => {
    mockGetExecutedSteps.mockResolvedValue([
      step({ data: { success: true, runtimeMeta: { stepScreenshotUrl: 'https://x/final.png' } } }),
    ]);
    mockGetFinding.mockResolvedValue(null);
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    });
  });

  it('records a finding when Gemini wraps its JSON verdict in a ```json code fence — the real incident from 2026-07-10 worker logs, where a bare JSON.parse threw "Unexpected token \'`\'" and silently skipped the shot', async () => {
    mockGenerateVision.mockResolvedValue({
      content: '```json\n{"anomalyDetected":true,"category":"placeholder_text","description":"Lorem ipsum visible on checkout","confidence":0.92}\n```',
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'placeholder_text',
      description: 'Lorem ipsum visible on checkout',
      confidence: 0.92,
    }));
  });

  it('still skips the shot (no throw, no finding) when the response has no recoverable JSON at all', async () => {
    mockGenerateVision.mockResolvedValue({ content: 'I could not analyze this image.' });

    await expect(runSweep(sweepParams)).resolves.toBeUndefined();
    expect(mockInsertFinding).not.toHaveBeenCalled();
  });

  it('still skips the shot when the response is truncated mid-JSON — the real incident from 2026-07-10, where a 300-token budget got eaten by gemini-2.5-flash thinking tokens before any "anomalyDetected: true" verdict could finish', async () => {
    mockGenerateVision.mockResolvedValue({ content: '```json\n{\n  "anomalyDetected": true' });

    await expect(runSweep(sweepParams)).resolves.toBeUndefined();
    expect(mockInsertFinding).not.toHaveBeenCalled();
  });

  it('requests a generous maxTokens budget AND proportionally generous timeout from Gemini — regression guard for three incidents on 2026-07-10: a tight token budget silently drops positive detections mid-JSON; a tight timeout then killed the longer thinking-mode generation before it could finish; and even 2048 tokens itself proved insufficient for one real scene (finishReason=MAX_TOKENS), so the budget must stay generous AND the timeout must scale with it (observed ~170 tok/s generation rate)', async () => {
    mockGenerateVision.mockResolvedValue({
      content: '{"anomalyDetected":false,"category":null,"description":"","confidence":0}',
    });

    await runSweep(sweepParams);

    const usedParams = mockGenerateVision.mock.calls[0][0];
    expect(usedParams.maxTokens).toBeGreaterThanOrEqual(8192);
    expect(usedParams.timeout).toBeGreaterThanOrEqual(45000);
  });

  it('normalizes a category Gemini wraps in an array — the real incident from 2026-07-10, where `"category":["overlapping_cutoff_ui"]` failed the DB CHECK constraint (Postgres 23514) and silently dropped a real, confidence:1.0 finding', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        anomalyDetected: true,
        category: ['overlapping_cutoff_ui'],
        description: 'The AI Chat popup overlaps the floating action button and pagination dots.',
        confidence: 1,
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'overlapping_cutoff_ui',
    }));
  });

  it('falls back to "other" for a category value outside the known set — degrades gracefully instead of failing the same DB CHECK constraint on future Gemini schema drift', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        anomalyDetected: true,
        category: 'some_new_category_gemini_invented',
        description: 'Something looked off.',
        confidence: 0.8,
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'other',
    }));
  });

  it('logs "Observation recorded" with the NORMALIZED category, not the raw Gemini value — regression guard for a code-review finding: the log used to show `["overlapping_cutoff_ui"]` (the raw array) while the DB row correctly stored the unwrapped string, misleading anyone cross-referencing logs against persisted state', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        anomalyDetected: true,
        category: ['overlapping_cutoff_ui'],
        description: 'Popup overlaps other elements.',
        confidence: 1,
      }),
    });

    await runSweep(sweepParams);

    const recordedCall = mockLoggerInfo.mock.calls.find(([msg]) => msg === '[VISUAL_ANOMALY] Observation recorded');
    expect(recordedCall?.[1]).toEqual(expect.objectContaining({ category: 'overlapping_cutoff_ui' }));
  });

  it('coerces a string-wrapped anomalyDetected ("false") to a real boolean instead of treating a non-empty string as truthy', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        anomalyDetected: 'false',
        category: 'placeholder_text',
        description: 'n/a',
        confidence: 0,
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).not.toHaveBeenCalled();
  });

  it('coerces a string-wrapped confidence ("0.9") to a number before persisting', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        anomalyDetected: true,
        category: 'placeholder_text',
        description: 'Lorem ipsum visible.',
        confidence: '0.9',
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ confidence: 0.9 }));
  });
});

describe('classifySweepDispatch', () => {
  const fullContext = {
    testId: 'test-1',
    testCaseId: 'tc-1',
    runId: 'run-1',
    projectId: 'proj-1',
    userId: 'user-1',
  };

  it('returns "proceed" with all resolved fields when the context is fully populated', () => {
    expect(classifySweepDispatch(fullContext)).toEqual({
      action: 'proceed',
      testId: 'test-1',
      testCaseId: 'tc-1',
      runId: 'run-1',
      projectId: 'proj-1',
      userId: 'user-1',
    });
  });

  it('returns "skip" (permanent, no retry) when context is null — not a regression-run test result at all', () => {
    expect(classifySweepDispatch(null).action).toBe('skip');
  });

  it('returns "skip" when testCaseId is missing — an ad-hoc/chat-lite run, not a saved test case', () => {
    expect(classifySweepDispatch({ ...fullContext, testCaseId: null }).action).toBe('skip');
  });

  it('returns "skip" when projectId or userId is missing', () => {
    expect(classifySweepDispatch({ ...fullContext, projectId: null }).action).toBe('skip');
    expect(classifySweepDispatch({ ...fullContext, userId: null }).action).toBe('skip');
  });

  it('returns "retry" (transient, throw-to-retry) when only runId is missing — the regression-run link race this whole mechanism exists for', () => {
    expect(classifySweepDispatch({ ...fullContext, runId: null }).action).toBe('retry');
  });
});
