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
const mockLoggerWarn = logger.warn as jest.Mock;

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

  describe('same-run collision (post-review fix) — the fingerprint can collide across different screenshots/categories within ONE sweep, not just across runs', () => {
    it('does NOT overwrite description/confidence when the new observation is a SAME-RUN collision with LOWER confidence than the existing one', async () => {
      mockGetFinding.mockResolvedValue({
        id: 'finding-1',
        affected_run_ids: ['run-A'], // already touched by run-A earlier in THIS same sweep
        recurrence_count: 1,
        status: 'below_threshold',
        confidence: 0.9,
        description: 'First (higher-confidence) finding this run.',
        last_seen_at: new Date().toISOString(),
      });
      await upsertObservation({ ...baseParams, runId: 'run-A', confidence: 0.5, description: 'Second (lower-confidence) finding this run.' });
      const patch = mockUpdateFinding.mock.calls[0][1];
      expect(patch).not.toHaveProperty('description');
      expect(patch).not.toHaveProperty('confidence');
      expect(patch).not.toHaveProperty('example_screenshot_url');
      // recurrence bookkeeping still updates regardless of which finding "wins"
      expect(patch).toEqual(expect.objectContaining({ recurrence_count: 1, affected_run_ids: ['run-A'] }));
    });

    it('DOES overwrite description/confidence when the new same-run observation has HIGHER-OR-EQUAL confidence', async () => {
      mockGetFinding.mockResolvedValue({
        id: 'finding-1',
        affected_run_ids: ['run-A'],
        recurrence_count: 1,
        status: 'below_threshold',
        confidence: 0.5,
        description: 'First (lower-confidence) finding this run.',
        last_seen_at: new Date().toISOString(),
      });
      await upsertObservation({ ...baseParams, runId: 'run-A', confidence: 0.9, description: 'Second (higher-confidence) finding this run.' });
      expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({
        description: 'Second (higher-confidence) finding this run.',
        confidence: 0.9,
      }));
    });

    it('is NOT triggered by genuine cross-run recurrence — always refreshes to the latest description/confidence when this run has not touched the row yet, preserving the original freshness behavior', async () => {
      mockGetFinding.mockResolvedValue({
        id: 'finding-1',
        affected_run_ids: ['run-A'], // run-B (below) has not touched this row yet
        recurrence_count: 1,
        status: 'below_threshold',
        confidence: 0.9,
        description: 'Older finding from run-A.',
        last_seen_at: new Date().toISOString(),
      });
      await upsertObservation({ ...baseParams, runId: 'run-B', confidence: 0.3, description: 'Newer, lower-confidence finding from run-B.' });
      expect(mockUpdateFinding).toHaveBeenCalledWith('finding-1', expect.objectContaining({
        description: 'Newer, lower-confidence finding from run-B.',
        confidence: 0.3,
      }));
    });

    it('logs the same-run collision outcome instead of silently overwriting', async () => {
      mockGetFinding.mockResolvedValue({
        id: 'finding-1',
        affected_run_ids: ['run-A'],
        recurrence_count: 1,
        status: 'below_threshold',
        confidence: 0.9,
        description: 'First finding.',
        last_seen_at: new Date().toISOString(),
      });
      await upsertObservation({ ...baseParams, runId: 'run-A', confidence: 0.5, description: 'Second finding.' });
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        '[VISUAL_ANOMALY] Same-fingerprint collision within one run',
        expect.objectContaining({ keptDescription: 'First finding.', droppedDescription: 'Second finding.' }),
      );
    });
  });
});

describe('runSweep — multi-finding schema (ADR-0016)', () => {
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
      content: '```json\n{"findings":[{"category":"placeholder_text","description":"Lorem ipsum visible on checkout","confidence":0.92}]}\n```',
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

  it('still skips the shot when the response is truncated mid-JSON — the real incident from 2026-07-10, where a 300-token budget got eaten by gemini-2.5-flash thinking tokens before the findings list could finish', async () => {
    mockGenerateVision.mockResolvedValue({ content: '```json\n{\n  "findings": [{"category": "placeholder_text"' });

    await expect(runSweep(sweepParams)).resolves.toBeUndefined();
    expect(mockInsertFinding).not.toHaveBeenCalled();
  });

  it('requests a generous maxTokens budget AND proportionally generous timeout from Gemini — regression guard for three incidents on 2026-07-10: a tight token budget silently drops positive detections mid-JSON; a tight timeout then killed the longer thinking-mode generation before it could finish; and even 2048 tokens itself proved insufficient for one real scene (finishReason=MAX_TOKENS), so the budget must stay generous AND the timeout must scale with it (observed ~170 tok/s generation rate)', async () => {
    mockGenerateVision.mockResolvedValue({
      content: '{"findings":[]}',
    });

    await runSweep(sweepParams);

    const usedParams = mockGenerateVision.mock.calls[0][0];
    expect(usedParams.maxTokens).toBeGreaterThanOrEqual(8192);
    expect(usedParams.timeout).toBeGreaterThanOrEqual(45000);
  });

  it('does not insert anything when Gemini returns an empty findings list', async () => {
    mockGenerateVision.mockResolvedValue({ content: '{"findings":[]}' });

    await runSweep(sweepParams);

    expect(mockInsertFinding).not.toHaveBeenCalled();
  });

  it('persists ONE row per distinct finding when Gemini reports multiple real, differently-categorized defects on the same screenshot — the exact compound-bug scenario ADR-0016 exists to fix (confirmed live 2026-07-11 pilot: gemini-2.5-flash correctly enumerated both an injected broken image AND injected placeholder text on the same fixture)', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [
          { category: 'broken_image', description: 'Missing product image.', confidence: 1 },
          { category: 'placeholder_text', description: 'Lorem ipsum dolor sit amet.', confidence: 1 },
        ],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledTimes(2);
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ category: 'broken_image', description: 'Missing product image.' }));
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ category: 'placeholder_text', description: 'Lorem ipsum dolor sit amet.' }));
  });

  it('normalizes a category Gemini wraps in a single-element array — the real incident from 2026-07-10, where `"category":["overlapping_cutoff_ui"]` failed the DB CHECK constraint (Postgres 23514) and silently dropped a real, confidence:1.0 finding', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [{
          category: ['overlapping_cutoff_ui'],
          description: 'The AI Chat popup overlaps the floating action button and pagination dots.',
          confidence: 1,
        }],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'overlapping_cutoff_ui',
    }));
  });

  it('expands a MULTI-element category array on one finding into one row per category — confirmed live 2026-07-11 pilot: Gemini returned `"category":["placeholder_text","broken_image"]` on a single finding when it read a placeholder image area as satisfying both categories at once; dropping either would silently lose a real detection', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [{
          category: ['placeholder_text', 'broken_image'],
          description: 'The main product image area displays placeholder text instead of an actual image.',
          confidence: 1,
        }],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledTimes(2);
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ category: 'placeholder_text' }));
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ category: 'broken_image' }));
  });

  it('falls back to "other" for a category value outside the known set — degrades gracefully instead of failing the same DB CHECK constraint on future Gemini schema drift', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [{ category: 'some_new_category_gemini_invented', description: 'Something looked off.', confidence: 0.8 }],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({
      category: 'other',
    }));
  });

  it('collapses two findings that resolve to the SAME category within one screenshot, keeping the higher-confidence one — accepted ADR-0016 limitation: the fingerprint is (test_case_id, role, category), so two same-category findings from one shot cannot both persist', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [
          { category: 'broken_image', description: 'Lower confidence read.', confidence: 0.6 },
          { category: 'broken_image', description: 'Higher confidence read.', confidence: 0.95 },
        ],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledTimes(1);
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ description: 'Higher confidence read.', confidence: 0.95 }));
  });

  it('logs "Observation recorded" with the NORMALIZED category, not the raw Gemini value — regression guard for a code-review finding: the log used to show `["overlapping_cutoff_ui"]` (the raw array) while the DB row correctly stored the unwrapped string, misleading anyone cross-referencing logs against persisted state', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [{ category: ['overlapping_cutoff_ui'], description: 'Popup overlaps other elements.', confidence: 1 }],
      }),
    });

    await runSweep(sweepParams);

    const recordedCall = mockLoggerInfo.mock.calls.find(([msg]) => msg === '[VISUAL_ANOMALY] Observation recorded');
    expect(recordedCall?.[1]).toEqual(expect.objectContaining({ category: 'overlapping_cutoff_ui' }));
  });

  it('coerces a string-wrapped confidence ("0.9") to a number before persisting', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [{ category: 'placeholder_text', description: 'Lorem ipsum visible.', confidence: '0.9' }],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ confidence: 0.9 }));
  });

  it('logs the LLM verdict with the RAW, pre-dedup finding count and categories — not the post-collapse count, so the log genuinely reflects what Gemini returned (post-review fix: this log used to be computed AFTER dedupeByCategory)', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [
          { category: 'broken_image', description: 'A.', confidence: 0.6 },
          { category: 'broken_image', description: 'B.', confidence: 0.9 },
        ],
      }),
    });

    await runSweep(sweepParams);

    const verdictCall = mockLoggerInfo.mock.calls.find(([msg]) => msg === '[VISUAL_ANOMALY] LLM verdict');
    expect(verdictCall?.[1]).toEqual(expect.objectContaining({
      findingCount: 2,
      categories: ['broken_image', 'broken_image'],
    }));
    // ...even though only ONE row is actually persisted, since broken_image
    // (a known category) still collapses in dedupeByCategory.
    expect(mockInsertFinding).toHaveBeenCalledTimes(1);
  });

  it('persists BOTH findings when two DIFFERENT unmappable defects both fall back to "other" on one screenshot, instead of silently collapsing one (post-review fix)', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [
          { category: 'weird_defect_a', description: 'Weird thing A.', confidence: 0.7 },
          { category: 'weird_defect_b', description: 'Weird thing B.', confidence: 0.8 },
        ],
      }),
    });

    await runSweep(sweepParams);

    expect(mockInsertFinding).toHaveBeenCalledTimes(2);
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ category: 'other', description: 'Weird thing A.' }));
    expect(mockInsertFinding).toHaveBeenCalledWith(expect.objectContaining({ category: 'other', description: 'Weird thing B.' }));
  });

  it('isolates a per-finding persistence failure — one finding throwing does not prevent the other findings in the same shot from being attempted (post-review fix: previously an uncaught throw mid-loop would abort the rest of the shot)', async () => {
    mockGenerateVision.mockResolvedValue({
      content: JSON.stringify({
        findings: [
          { category: 'broken_image', description: 'A.', confidence: 0.9 },
          { category: 'placeholder_text', description: 'B.', confidence: 0.9 },
        ],
      }),
    });
    mockInsertFinding
      .mockRejectedValueOnce(new Error('transient DB failure'))
      .mockResolvedValueOnce({ error: null });

    await expect(runSweep(sweepParams)).resolves.toBeUndefined();

    expect(mockInsertFinding).toHaveBeenCalledTimes(2);
    const failureLog = mockLoggerWarn.mock.calls.find(([msg]) => msg === '[VISUAL_ANOMALY] Failed to persist one finding — continuing with the rest of this shot');
    expect(failureLog?.[1]).toEqual(expect.objectContaining({ category: 'broken_image' }));
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
