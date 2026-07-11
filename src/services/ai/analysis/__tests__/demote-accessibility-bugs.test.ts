import { AIService } from '@/services/ai/analysis/test-results.service';
import type { AISummary } from '@/types';

// demoteAdvisoryAccessibilityBugs is a pure private method — access via
// `as any` (the repo's established pattern, see scrub-hallucinated-bugs.test.ts).
const svc = new AIService() as any;

const mkAnalysis = (
  bugs: Array<{ title: string; severity: string; category: string }>,
  overrides: Partial<AISummary> = {},
): AISummary =>
  ({
    summary: 's', bugs: bugs as any, recommendations: ['keep me'],
    severity: 'high', confidence: 80, generatedAt: new Date(),
    ...overrides,
  }) as AISummary;

describe('AIService.demoteAdvisoryAccessibilityBugs', () => {
  it('moves a low-severity accessibility bug to recommendations and resets severity to low', () => {
    const out = svc.demoteAdvisoryAccessibilityBugs(
      mkAnalysis([{ title: 'Missing <main> landmark region', severity: 'low', category: 'accessibility' }]),
    );
    expect(out.bugs).toEqual([]);
    expect(out.recommendations).toEqual(['keep me', 'Missing <main> landmark region']);
    expect(out.severity).toBe('low'); // was 'high' on the input — must not survive with bugs:[]
  });

  it('moves a medium-severity accessibility bug to recommendations and resets severity to low', () => {
    const out = svc.demoteAdvisoryAccessibilityBugs(
      mkAnalysis([{ title: 'Form inputs missing labels', severity: 'medium', category: 'accessibility' }]),
    );
    expect(out.bugs).toEqual([]);
    expect(out.recommendations).toContain('Form inputs missing labels');
    expect(out.severity).toBe('low');
  });

  it('clears a real_bug failureClassification when demotion empties bugs', () => {
    const out = svc.demoteAdvisoryAccessibilityBugs(
      mkAnalysis(
        [{ title: '2 buttons without accessible name', severity: 'low', category: 'accessibility' }],
        { failureClassification: 'real_bug', classificationEvidence: ['missing accessible names on 2 buttons'] },
      ),
    );
    expect(out.bugs).toEqual([]);
    expect(out.failureClassification).toBeNull();
    expect(out.classificationEvidence).toEqual([]);
  });

  it('does NOT clear a non-real_bug failureClassification when demotion empties bugs', () => {
    const out = svc.demoteAdvisoryAccessibilityBugs(
      mkAnalysis(
        [{ title: 'Missing <main> landmark region', severity: 'low', category: 'accessibility' }],
        { failureClassification: 'flaky', classificationEvidence: ['retried step, no persistent errors'] },
      ),
    );
    expect(out.bugs).toEqual([]);
    expect(out.failureClassification).toBe('flaky');
    expect(out.classificationEvidence).toEqual(['retried step, no persistent errors']);
  });

  it('KEEPS a critical accessibility bug — reserved for a real functional break', () => {
    const analysis = mkAnalysis([
      { title: 'Keyboard focus trap blocks checkout for screen reader users', severity: 'critical', category: 'accessibility' },
    ]);
    const out = svc.demoteAdvisoryAccessibilityBugs(analysis);
    expect(out).toBe(analysis); // no-op — returns the same object untouched
  });

  it('KEEPS a high-severity accessibility bug', () => {
    const analysis = mkAnalysis([
      { title: 'Screen reader cannot complete signup form', severity: 'high', category: 'accessibility' },
    ]);
    const out = svc.demoteAdvisoryAccessibilityBugs(analysis);
    expect(out).toBe(analysis);
  });

  it('does NOT touch non-accessibility bugs, even at low severity', () => {
    const analysis = mkAnalysis([{ title: 'Minor console warning', severity: 'low', category: 'functional' }]);
    const out = svc.demoteAdvisoryAccessibilityBugs(analysis);
    expect(out).toBe(analysis);
  });

  it('demotes accessibility bugs while leaving a real bug in the same run untouched', () => {
    const out = svc.demoteAdvisoryAccessibilityBugs(
      mkAnalysis([
        { title: 'Checkout submission fails with 500 error', severity: 'critical', category: 'functional' },
        { title: '2 buttons without accessible name', severity: 'low', category: 'accessibility' },
      ]),
    );
    expect(out.bugs).toHaveLength(1);
    expect(out.bugs[0].title).toBe('Checkout submission fails with 500 error');
    expect(out.recommendations).toContain('2 buttons without accessible name');
    expect(out.severity).toBe('high'); // bugs remain non-empty — severity is left as-is
  });

  it('is a no-op when there were no bugs to begin with', () => {
    const analysis = mkAnalysis([]);
    const out = svc.demoteAdvisoryAccessibilityBugs(analysis);
    expect(out).toBe(analysis);
  });
});
