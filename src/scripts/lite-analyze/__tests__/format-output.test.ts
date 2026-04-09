/**
 * Tests for format-output — verify the plain-text (ansi=false) output is
 * deterministic, contains expected fields, and handles edge cases.
 *
 * ANSI mode is not asserted directly — we trust the color function is a
 * simple wrapper and focus on the layout / content.
 */

import { formatTable } from '../format-output';
import type { ParsedTrace } from '../parse-trace';

/** Minimal ParsedTrace factory for formatter tests. */
function makeTrace(overrides: Partial<ParsedTrace> = {}): ParsedTrace {
  return {
    testId: 'test-abc-123',
    filePath: '/tmp/test.jsonl',
    startedAt: '2026-04-08T12:00:00.000Z',
    endedAt: '2026-04-08T12:00:05.000Z',
    totalDurationMs: 5000,
    eventCount: 10,
    malformedLines: 0,
    enginePathsObserved: ['legacy'],
    executionPath: 'legacy_only',
    success: true,
    reason: 'Goal achieved',
    steps: [],
    summary: {
      stepCount: 0,
      iterationCount: 0,
      timingByPhase: {},
      quality: {
        successfulActions: 0,
        noEffectActions: 0,
        errorActions: 0,
        criticWarnings: 0,
        safetyBlocks: 0,
        supervisorRecoveryRounds: 0,
        staleRefRetries: 0,
        monolithicFallbacks: 0,
      },
      cost: {
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        models: [],
      },
    },
    ...overrides,
  };
}

describe('formatTable — header', () => {
  it('includes testId in header', () => {
    const out = formatTable(makeTrace(), { ansi: false });
    expect(out).toContain('test-abc-123');
  });

  it('shows SUCCESS for success=true', () => {
    const out = formatTable(makeTrace({ success: true }), { ansi: false });
    expect(out).toContain('SUCCESS');
    expect(out).not.toContain('FAILED');
  });

  it('shows FAILED for success=false', () => {
    const out = formatTable(makeTrace({ success: false }), { ansi: false });
    expect(out).toContain('FAILED');
  });

  it('shows execution path', () => {
    const out = formatTable(makeTrace({ executionPath: 'hybrid_success' }), { ansi: false });
    expect(out).toContain('hybrid_success');
  });

  it('warns when malformed lines are present', () => {
    const out = formatTable(makeTrace({ malformedLines: 7 }), { ansi: false });
    expect(out).toContain('7 malformed lines');
  });
});

describe('formatTable — empty steps', () => {
  it('prints a "(no steps parsed)" message when there are no steps', () => {
    const out = formatTable(makeTrace(), { ansi: false });
    expect(out).toContain('(no steps parsed');
  });
});

describe('formatTable — per-step rendering', () => {
  it('renders a single success step with phase timings', () => {
    const trace = makeTrace({
      steps: [
        {
          index: 1,
          iteration: 0,
          engine: 'legacy',
          description: 'fill(e3)',
          action: { type: 'fill', ref: 'e3', value: 'user@test.com' },
          durationMs: 2100,
          timeline: [],
          phases: {
            observerMs: 200,
            strategistMs: 400,
            actorMs: 150,
            criticMs: 100,
            playwrightMs: 1250,
          },
          quality: {
            outcome: 'success',
            criticWarnings: 0,
            safetyBlocked: false,
            supervisorRecovery: false,
            staleRefDetected: false,
            monolithicFallback: false,
            stuckFlagged: false,
            wasRetry: false,
            notes: [],
          },
          llm: {
            calls: 4,
            inputTokens: 3000,
            outputTokens: 400,
            totalTokens: 3400,
            estimatedCostUsd: 0.012,
            models: ['gpt-4o-mini'],
          },
        },
      ],
      summary: {
        stepCount: 1,
        iterationCount: 1,
        timingByPhase: {
          observerMs: 200,
          strategistMs: 400,
          actorMs: 150,
          criticMs: 100,
          playwrightMs: 1250,
        },
        quality: {
          successfulActions: 1,
          noEffectActions: 0,
          errorActions: 0,
          criticWarnings: 0,
          safetyBlocks: 0,
          supervisorRecoveryRounds: 0,
          staleRefRetries: 0,
          monolithicFallbacks: 0,
        },
        cost: {
          llmCalls: 4,
          inputTokens: 3000,
          outputTokens: 400,
          totalTokens: 3400,
          estimatedCostUsd: 0.012,
          models: ['gpt-4o-mini'],
        },
      },
    });
    const out = formatTable(trace, { ansi: false });
    expect(out).toContain('Step 1');
    expect(out).toContain('fill(e3)');
    expect(out).toContain('success');
    expect(out).toContain('observer');
    expect(out).toContain('strategist');
    expect(out).toContain('playwright');
    expect(out).toContain('gpt-4o-mini');
  });

  it('shows notes for warnings, blocks, and fallbacks', () => {
    const trace = makeTrace({
      steps: [
        {
          index: 1,
          iteration: 0,
          engine: 'pipeline_v2',
          description: 'click(e5)',
          action: { type: 'click', ref: 'e5' },
          durationMs: 100,
          timeline: [],
          phases: {},
          quality: {
            outcome: 'error',
            criticVerdict: 'reject',
            criticWarnings: 2,
            safetyBlocked: true,
            supervisorRecovery: true,
            staleRefDetected: false,
            monolithicFallback: true,
            stuckFlagged: false,
            wasRetry: false,
            notes: ['custom note'],
          },
          llm: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: [] },
        },
      ],
    });
    const out = formatTable(trace, { ansi: false });
    expect(out).toContain('safety blocked');
    expect(out).toContain('supervisor recovery');
    expect(out).toContain('monolithic fallback');
    expect(out).toContain('critic warnings');
    expect(out).toContain('custom note');
  });

  it('masks sensitive values', () => {
    const trace = makeTrace({
      steps: [
        {
          index: 1,
          iteration: 0,
          engine: 'pipeline_v2',
          description: 'fill(e4)',
          action: { type: 'fill', ref: 'e4', value: '[SENSITIVE]' },
          durationMs: 100,
          timeline: [],
          phases: {},
          quality: {
            outcome: 'success',
            criticWarnings: 0,
            safetyBlocked: false,
            supervisorRecovery: false,
            staleRefDetected: false,
            monolithicFallback: false,
            stuckFlagged: false,
            wasRetry: false,
            notes: [],
          },
          llm: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: [] },
        },
      ],
    });
    const out = formatTable(trace, { ansi: false });
    expect(out).toContain('[sensitive]');
    expect(out).not.toContain('[SENSITIVE]');
  });
});

describe('formatTable — summary section', () => {
  it('lists phase timings in descending order', () => {
    const trace = makeTrace({
      totalDurationMs: 10_000,
      summary: {
        stepCount: 0,
        iterationCount: 0,
        timingByPhase: {
          observerMs: 500,
          playwrightMs: 5000,
          strategistMs: 1000,
        },
        quality: {
          successfulActions: 0,
          noEffectActions: 0,
          errorActions: 0,
          criticWarnings: 0,
          safetyBlocks: 0,
          supervisorRecoveryRounds: 0,
          staleRefRetries: 0,
          monolithicFallbacks: 0,
        },
        cost: {
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          models: [],
        },
      },
    });
    const out = formatTable(trace, { ansi: false });
    // playwright should appear before strategist in the list
    const playwrightIdx = out.indexOf('playwright');
    const strategistIdx = out.indexOf('strategist');
    const observerIdx = out.indexOf('observer');
    expect(playwrightIdx).toBeGreaterThan(-1);
    expect(strategistIdx).toBeGreaterThan(-1);
    expect(observerIdx).toBeGreaterThan(-1);
    expect(playwrightIdx).toBeLessThan(strategistIdx);
    expect(strategistIdx).toBeLessThan(observerIdx);
  });

  it('formats token counts compactly (k, M)', () => {
    const trace = makeTrace({
      summary: {
        stepCount: 0,
        iterationCount: 0,
        timingByPhase: {},
        quality: {
          successfulActions: 0,
          noEffectActions: 0,
          errorActions: 0,
          criticWarnings: 0,
          safetyBlocks: 0,
          supervisorRecoveryRounds: 0,
          staleRefRetries: 0,
          monolithicFallbacks: 0,
        },
        cost: {
          llmCalls: 20,
          inputTokens: 45_000,
          outputTokens: 2_500,
          totalTokens: 47_500,
          estimatedCostUsd: 0.175,
          models: ['gpt-4o-mini'],
        },
      },
    });
    const out = formatTable(trace, { ansi: false });
    expect(out).toContain('45.0k');
    expect(out).toContain('2.5k');
    expect(out).toContain('$0.175');
  });
});

describe('formatTable — ansi=false produces no escape codes', () => {
  it('plain text output has no ANSI escape sequences', () => {
    const trace = makeTrace({
      steps: [
        {
          index: 1,
          iteration: 0,
          engine: 'legacy',
          description: 'test',
          action: { type: 'click' },
          durationMs: 100,
          timeline: [],
          phases: { playwrightMs: 100 },
          quality: {
            outcome: 'success',
            criticWarnings: 0,
            safetyBlocked: false,
            supervisorRecovery: false,
            staleRefDetected: false,
            monolithicFallback: false,
            stuckFlagged: false,
            wasRetry: false,
            notes: [],
          },
          llm: { calls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0, models: [] },
        },
      ],
    });
    const out = formatTable(trace, { ansi: false });
    // ANSI escapes start with ESC (\x1b)
    expect(out).not.toMatch(/\x1b\[/);
  });
});
