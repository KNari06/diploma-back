import { AIService } from '@/services/ai/analysis/test-results.service';
import type { TestResult } from '@/types';
import type { AISummary } from '@/types';

// scrubHallucinatedBugs is a pure private method — access via `as any`
// (the repo's established pattern for testing internal pure logic).
const svc = new AIService() as any;

const mkResult = (over: Partial<TestResult> = {}): TestResult =>
  ({
    id: 'r1', testId: 't1', browser: 'chromium' as any, status: 'completed',
    logs: [], networkLogs: [], errors: [], createdAt: new Date(), ...over,
  }) as TestResult;

const mkAnalysis = (bugs: Array<{ title: string }>): AISummary =>
  ({
    summary: 's', bugs: bugs as any, recommendations: ['keep me'],
    severity: 'high', confidence: 80, generatedAt: new Date(),
  }) as AISummary;

describe('AIService.scrubHallucinatedBugs', () => {
  it('drops bugs on a clean pass (completed, no errors, no HTTP failures)', () => {
    const out = svc.scrubHallucinatedBugs(mkResult(), mkAnalysis([{ title: 'invented a11y bug' }]));
    expect(out.bugs).toEqual([]);
    expect(out.severity).toBe('low');
    expect(out.recommendations).toEqual(['keep me']); // recommendations survive
  });

  it('KEEPS bugs when the test FAILED (real bug source even with empty console)', () => {
    const out = svc.scrubHallucinatedBugs(mkResult({ status: 'failed' }), mkAnalysis([{ title: 'assertion failed' }]));
    expect(out.bugs).toHaveLength(1);
    expect(out.severity).toBe('high');
  });

  it('KEEPS bugs on a timeout run', () => {
    const out = svc.scrubHallucinatedBugs(mkResult({ status: 'timeout' }), mkAnalysis([{ title: 'x' }]));
    expect(out.bugs).toHaveLength(1);
  });

  it('KEEPS bugs when there are real console errors, even if status=completed', () => {
    const out = svc.scrubHallucinatedBugs(
      mkResult({ errors: [{ type: 'console', message: 'TypeError' } as any] }),
      mkAnalysis([{ title: 'real console bug' }]),
    );
    expect(out.bugs).toHaveLength(1);
  });

  it('KEEPS bugs when a network response is 4xx/5xx, even if status=completed', () => {
    const out = svc.scrubHallucinatedBugs(
      mkResult({ networkLogs: [{ url: '/api/x', method: 'GET', status: 500 } as any] }),
      mkAnalysis([{ title: '500 bug' }]),
    );
    expect(out.bugs).toHaveLength(1);
  });

  it('does NOT scrub a 2xx-only network run with no errors → but it was clean, so drops', () => {
    const out = svc.scrubHallucinatedBugs(
      mkResult({ networkLogs: [{ url: '/api/x', method: 'GET', status: 200 } as any] }),
      mkAnalysis([{ title: 'invented' }]),
    );
    expect(out.bugs).toEqual([]);
  });

  it('is a no-op when there were no bugs to begin with', () => {
    const analysis = mkAnalysis([]);
    const out = svc.scrubHallucinatedBugs(mkResult(), analysis);
    expect(out).toBe(analysis); // returns the same object untouched
  });
});
