import { formatTestResult } from '../test-result-formatter';

const base = (over: any = {}): any => ({
  success: true,
  cancelled: false,
  summary: 'ran ok',
  screenshots: [],
  errors: [],
  pagesVisited: 3,
  actionsTaken: 7,
  duration: 1200,
  cost: 0.02,
  ...over,
});

describe('formatTestResult — status precedence', () => {
  it('cancelled wins over success', () => {
    const r = formatTestResult(base({ success: true, cancelled: true }), {});
    expect(r.status).toBe('cancelled');
    expect(r.success).toBe(false);
  });

  it('maps a successful, non-cancelled result to completed', () => {
    const r = formatTestResult(base({ success: true }), {});
    expect(r.status).toBe('completed');
    expect(r.success).toBe(true);
  });

  it('maps an unsuccessful result to failed', () => {
    const r = formatTestResult(base({ success: false }), {});
    expect(r.status).toBe('failed');
    expect(r.success).toBe(false);
  });
});

describe('formatTestResult — fields', () => {
  it('takes the first screenshot when present', () => {
    expect(formatTestResult(base({ screenshots: [{ screenshot: 'IMG' }] }), {}).screenshot).toBe('IMG');
    expect(formatTestResult(base({ screenshots: [] }), {}).screenshot).toBeUndefined();
  });

  it('maps errors into the standard shape with a timestamp', () => {
    const r = formatTestResult(base({ errors: [{ message: 'boom', page: '/x' }] }), {});
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ type: 'other', message: 'boom' });
    expect(r.errors[0].timestamp).toBeInstanceOf(Date);
  });

  it('extracts the performance metrics', () => {
    const r = formatTestResult(base(), {});
    expect(r.performance).toEqual({ pagesVisited: 3, actionsTaken: 7, duration: 1200, cost: 0.02 });
  });

  it('passes artifact URLs/paths through', () => {
    const r = formatTestResult(base(), { videoUrl: 'v', tracePath: '/t' });
    expect(r).toMatchObject({ videoUrl: 'v', tracePath: '/t' });
    expect(r.logs).toEqual(['Intelligent test: ran ok']);
  });
});
