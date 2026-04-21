/**
 * Tests for drift-agent pure utilities (prompt + parser + validator).
 *
 * We don't mock OpenAI here — those paths are covered by integration
 * tests. This file exercises the deterministic helpers exported via
 * the `__testing` namespace so we can verify the parser's guard rails.
 */

import { __testing } from '../drift-agent';

describe('parseVerdict', () => {
  it('parses a well-formed verdict', () => {
    const raw = JSON.stringify({
      diagnosis: 'Login page added a captcha.',
      confidence: 0.85,
      proposedPatch: {
        action: 'insert_before',
        targetStepIndex: 3,
        insertStep: { type: 'click', description: 'Solve captcha' },
        reason: 'captcha appeared before login form',
      },
    });
    const v = __testing.parseVerdict(raw);
    expect(v.diagnosis).toBe('Login page added a captcha.');
    expect(v.confidence).toBe(0.85);
    expect(v.proposedPatch?.action).toBe('insert_before');
    expect(v.proposedPatch?.reason).toBe('captcha appeared before login form');
  });

  it('extracts JSON from markdown wrapper fallback', () => {
    const raw = '```json\n{"diagnosis":"x","confidence":0.9,"proposedPatch":null}\n```';
    const v = __testing.parseVerdict(raw);
    expect(v.diagnosis).toBe('x');
    expect(v.confidence).toBe(0.9);
    expect(v.proposedPatch).toBeNull();
  });

  it('clamps confidence to [0, 1]', () => {
    const high = __testing.parseVerdict(JSON.stringify({ diagnosis: 'x', confidence: 1.7, proposedPatch: null }));
    const low = __testing.parseVerdict(JSON.stringify({ diagnosis: 'x', confidence: -0.3, proposedPatch: null }));
    expect(high.confidence).toBe(1);
    expect(low.confidence).toBe(0);
  });

  it('drops patch when confidence < 0.6', () => {
    const raw = JSON.stringify({
      diagnosis: 'maybe drift',
      confidence: 0.45,
      proposedPatch: {
        action: 'insert_before',
        insertStep: { type: 'click', description: 'X' },
        reason: 'low confidence but patch present',
      },
    });
    const v = __testing.parseVerdict(raw);
    expect(v.proposedPatch).toBeNull();
  });

  it('supplies fallback diagnosis for empty string', () => {
    const raw = JSON.stringify({ diagnosis: '', confidence: 0.5, proposedPatch: null });
    const v = __testing.parseVerdict(raw);
    expect(v.diagnosis).toMatch(/Unable to determine/i);
  });

  it('rounds confidence to 2 decimals', () => {
    const raw = JSON.stringify({ diagnosis: 'x', confidence: 0.87654321, proposedPatch: null });
    const v = __testing.parseVerdict(raw);
    expect(v.confidence).toBe(0.88);
  });
});

describe('validatePatch', () => {
  const HIGH = 0.8;
  const LOW = 0.4;

  it('returns null for low confidence regardless of patch quality', () => {
    const patch = {
      action: 'insert_before',
      insertStep: { type: 'click', description: 'X' },
      reason: 'valid reason',
    };
    expect(__testing.validatePatch(patch, LOW)).toBeNull();
  });

  it('returns null for unknown action', () => {
    const bad = { action: 'magic_fix', reason: 'x' };
    expect(__testing.validatePatch(bad, HIGH)).toBeNull();
  });

  it('returns null for missing reason', () => {
    const bad = { action: 'insert_before', insertStep: { type: 'click', description: 'X' } };
    expect(__testing.validatePatch(bad, HIGH)).toBeNull();
  });

  it('returns null for insert_before without insertStep', () => {
    const bad = { action: 'insert_before', reason: 'missing step' };
    expect(__testing.validatePatch(bad, HIGH)).toBeNull();
  });

  it('returns null for replace_selector without newSelector', () => {
    const bad = { action: 'replace_selector', reason: 'missing selector' };
    expect(__testing.validatePatch(bad, HIGH)).toBeNull();
  });

  it('accepts delete_step without extra fields', () => {
    const patch = { action: 'delete_step', targetStepIndex: 5, reason: 'removed feature' };
    const v = __testing.validatePatch(patch, HIGH);
    expect(v).not.toBeNull();
    expect(v?.action).toBe('delete_step');
    expect(v?.targetStepIndex).toBe(5);
  });

  it('floors targetStepIndex to integer', () => {
    const patch = { action: 'delete_step', targetStepIndex: 3.8, reason: 'x' };
    expect(__testing.validatePatch(patch, HIGH)?.targetStepIndex).toBe(3);
  });

  it('rejects negative targetStepIndex', () => {
    const patch = { action: 'delete_step', targetStepIndex: -1, reason: 'x' };
    // Index absent → still returns a patch with no index. That's OK —
    // the UI treats missing index as "caller must pick".
    const v = __testing.validatePatch(patch, HIGH);
    expect(v?.targetStepIndex).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  it('contains the core grouping fields and sample count', () => {
    const prompt = __testing.buildPrompt({
      group: {
        patternKey: 'abc',
        urlPattern: '/tutors/:id',
        targetElementKey: 'button:X',
        errorShape: 'covered_by_overlay',
        failures: [
          { testResultId: 'r1', testId: 't1', testCaseId: 'c1', driftSignals: {} as any },
          { testResultId: 'r2', testId: 't2', testCaseId: 'c2', driftSignals: {} as any },
          { testResultId: 'r3', testId: 't3', testCaseId: 'c3', driftSignals: {} as any },
        ],
      },
      sampleFailures: [
        { testResultId: 'r1', testId: 't1', testCaseId: 'c1', driftSignals: {} as any },
        { testResultId: 'r2', testId: 't2', testCaseId: 'c2', driftSignals: {} as any },
      ],
      kbChunks: [],
      affectedTestCount: 5,
    });

    expect(prompt).toContain('/tutors/:id');
    expect(prompt).toContain('button:X');
    expect(prompt).toContain('covered_by_overlay');
    expect(prompt).toContain('failures_in_run:   3');
    expect(prompt).toContain('affected_tests:    5');
    expect(prompt).toContain('Sample 1');
    expect(prompt).toContain('(no relevant KB chunks found)');
  });

  it('renders KB chunks when present', () => {
    const prompt = __testing.buildPrompt({
      group: {
        patternKey: 'abc',
        urlPattern: '/x',
        targetElementKey: 'button:Y',
        errorShape: 'selector_not_found',
        failures: [],
      },
      sampleFailures: [],
      kbChunks: [
        {
          id: '1',
          content: 'Login page now shows a captcha.',
          file_name: 'release_notes.pdf',
          metadata: {},
          created_at: '',
        },
      ] as any,
      affectedTestCount: 0,
    });

    expect(prompt).toContain('release_notes.pdf');
    expect(prompt).toContain('Login page now shows a captcha.');
  });
});
