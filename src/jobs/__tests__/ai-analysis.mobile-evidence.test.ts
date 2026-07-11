import { describe, it, expect } from '@jest/globals';
import { AIAnalysisJobHandler } from '@/jobs/ai-analysis.job';

// extractMobileEvidence / convertToTestResult are pure private statics — access
// via `as any` to assert the mobile-evidence folding without standing up a job.
const svc = AIAnalysisJobHandler as any;

describe('AIAnalysisJobHandler mobile evidence folding', () => {
  it('is a no-op for a web result (no metadata.platform === mobile)', () => {
    const out = svc.extractMobileEvidence({ metadata: { platform: 'web' } });
    expect(out).toEqual({ errors: [], logs: [], networkLogs: [] });
  });

  it('folds per-step logcat, console, network, alert and classification into channels', () => {
    const dbResult = {
      metadata: {
        platform: 'mobile',
        steps: [
          {
            stepId: 's1',
            errorClassification: { type: 'app_crash', summary: 'NPE in LoginActivity', confidence: 1 },
            evidence: {
              logErrors: ['FATAL EXCEPTION: main java.lang.NullPointerException'],
              consoleErrors: [{ type: 'exception', message: 'undefined is not a function', source: 'app.js', line: 42 }],
              networkErrors: [{ url: 'https://api/x', method: 'POST', status: 500, statusText: 'Server Error' }],
              systemAlert: { text: 'Something went wrong', isError: true },
            },
          },
        ],
      },
    };
    const out = svc.extractMobileEvidence(dbResult);

    expect(out.errors.some((e: string) => e.includes('[app_crash]') && e.includes('NPE'))).toBe(true);
    expect(out.errors.some((e: string) => e.includes('undefined is not a function'))).toBe(true);
    expect(out.errors.some((e: string) => e.includes('Something went wrong'))).toBe(true);
    expect(out.logs.some((l: string) => l.includes('NullPointerException'))).toBe(true);
    expect(out.networkLogs).toHaveLength(1);
    expect(out.networkLogs[0]).toMatchObject({ url: 'https://api/x', status: 500 });
  });

  it('skips an "unknown" classification and a non-error alert', () => {
    const out = svc.extractMobileEvidence({
      metadata: {
        platform: 'mobile',
        steps: [{
          stepId: 's1',
          errorClassification: { type: 'unknown', summary: 'n/a', confidence: 0 },
          evidence: { systemAlert: { text: 'Saved', isError: false } },
        }],
      },
    });
    expect(out.errors).toEqual([]);
  });

  it('convertToTestResult appends mobile evidence onto the flat channels', () => {
    const dbResult = {
      id: 'r1', test_id: 't1', browser: 'mobile-android', status: 'failed',
      errors: ['pre-existing web-shaped error'],
      logs: [], network_logs: [],
      metadata: {
        platform: 'mobile',
        steps: [{ stepId: 's1', errorClassification: { type: 'anr', summary: 'ANR in main', confidence: 1 }, evidence: { logErrors: ['ANR line'] } }],
      },
      created_at: new Date().toISOString(),
    };
    const converted = svc.convertToTestResult(dbResult);
    expect(converted.errors).toContain('pre-existing web-shaped error');
    expect(converted.errors.some((e: string) => e.includes('[anr]'))).toBe(true);
    expect(converted.logs.some((l: string) => l.includes('ANR line'))).toBe(true);
  });

  it('never throws on a malformed metadata shape (best-effort)', () => {
    expect(() => svc.extractMobileEvidence({ metadata: { platform: 'mobile', steps: 'not-an-array' } })).not.toThrow();
    expect(() => svc.extractMobileEvidence(null)).not.toThrow();
    expect(svc.extractMobileEvidence(null)).toEqual({ errors: [], logs: [], networkLogs: [] });
  });
});
