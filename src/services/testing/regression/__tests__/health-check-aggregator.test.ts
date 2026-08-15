import { HealthCheckAggregatorService } from '../health-check-aggregator.service';
import type { HealthCheckFinding, ExecutionHealthChecks } from '@/types/testing.types';

describe('HealthCheckAggregatorService', () => {
  // ── aggregateFromTestResult ───────────────────────────────────────────────

  describe('aggregateFromTestResult', () => {
    it('returns 5 pass findings and a checkedAt timestamp for null input', () => {
      const result = HealthCheckAggregatorService.aggregateFromTestResult(null);
      expect(result.findings).toHaveLength(0);
      expect(result.checkedAt).toBeTruthy();
    });

    it('returns 5 findings with distinct categories for a populated result', () => {
      const result = HealthCheckAggregatorService.aggregateFromTestResult({
        logs: [],
        network_logs: [],
        errors: [],
        quality_checks: null,
        error_message: null,
      });
      const cats = result.findings.map((f) => f.category);
      expect(cats).toContain('console_errors');
      expect(cats).toContain('network_errors');
      expect(cats).toContain('js_exceptions');
      expect(cats).toContain('broken_images');
      expect(cats).toContain('page_responsive');
    });

    it('skips web-only checks for mobile (no JS exceptions / broken images / page-responsive)', () => {
      const result = HealthCheckAggregatorService.aggregateFromTestResult(
        // `errors` holds a step/app failure — for web this would become a
        // "JS exception"; for mobile it must NOT.
        { logs: [], network_logs: [], errors: [{ message: 'tap: finder found nothing' }] },
        { isMobile: true },
      );
      const cats = result.findings.map((f) => f.category);
      expect(cats).toEqual(['console_errors', 'network_errors']);
      expect(cats).not.toContain('js_exceptions');
    });

    it('marks both mobile checks not_available instead of falsely passing them', () => {
      // Regression guard: mobile runs used to render a green "2 Passed:
      // Console Errors · Network Errors" even though the runner captures
      // neither signal for native apps.
      const result = HealthCheckAggregatorService.aggregateFromTestResult(
        { logs: [], network_logs: [], errors: [] },
        { isMobile: true },
      );
      expect(result.findings.map((f) => f.severity)).toEqual([
        'not_available',
        'not_available',
      ]);
      for (const f of result.findings) {
        expect(f.unavailableReason).toBeTruthy();
      }
    });

    it('still grades mobile network entries when a WebView run captured some', () => {
      // CDP attaches on an Android WebView context switch, so real entries do
      // occur — those must be graded, not written off as unavailable.
      const result = HealthCheckAggregatorService.aggregateFromTestResult(
        { logs: [], network_logs: [{ url: '/api', status: 503 }], errors: [] },
        { isMobile: true },
      );
      const net = result.findings.find((f) => f.category === 'network_errors')!;
      expect(net.severity).toBe('fail');
    });
  });

  // ── checkConsoleLogs (via aggregateFromTestResult) ────────────────────────

  describe('console_errors finding', () => {
    function check(logs: any) {
      return HealthCheckAggregatorService.aggregateFromTestResult({ logs })
        .findings.find((f) => f.category === 'console_errors')!;
    }

    it('reports not_available rather than pass when logs is null', () => {
      expect(check(null).severity).toBe('not_available');
    });

    it('reports not_available rather than pass when logs is not an array', () => {
      expect(check('some string').severity).toBe('not_available');
    });

    it('pass when there are no [error] entries', () => {
      expect(check(['[info] loaded', '[warn] slow']).severity).toBe('pass');
    });

    it('warning for 1–4 console errors', () => {
      const logs = ['[error] oops', '[error] again', '[info] ok'];
      const f = check(logs);
      expect(f.severity).toBe('warning');
      expect(f.message).toMatch(/2 console errors/);
    });

    it('fail for 5 or more console errors', () => {
      const logs = Array.from({ length: 5 }, (_, i) => `[error] e${i}`);
      expect(check(logs).severity).toBe('fail');
    });

    it('details entries are truncated to 200 chars', () => {
      const longMsg = '[error] ' + 'x'.repeat(300);
      const f = check([longMsg]);
      const detailText = f.details?.[0]?.text ?? '';
      expect(detailText.length).toBeLessThanOrEqual(200);
    });

    it('includes at most 10 detail entries even with many errors', () => {
      const logs = Array.from({ length: 15 }, (_, i) => `[error] e${i}`);
      const f = check(logs);
      expect(f.details!.length).toBeLessThanOrEqual(10);
    });
  });

  // ── checkNetworkLogs ─────────────────────────────────────────────────────

  describe('network_errors finding', () => {
    function check(network_logs: any) {
      return HealthCheckAggregatorService.aggregateFromTestResult({ network_logs })
        .findings.find((f) => f.category === 'network_errors')!;
    }

    it('reports not_available rather than pass when network_logs is null', () => {
      expect(check(null).severity).toBe('not_available');
    });

    it('pass when there are no 4xx/5xx responses', () => {
      expect(check([{ url: '/ok', status: 200 }]).severity).toBe('pass');
    });

    it('warning for 4xx only errors', () => {
      const f = check([{ url: '/missing', status: 404 }]);
      expect(f.severity).toBe('warning');
      expect(f.message).toMatch(/4xx only/);
    });

    it('fail when any 5xx is present', () => {
      const f = check([{ url: '/fail', status: 500 }]);
      expect(f.severity).toBe('fail');
      expect(f.message).toMatch(/5xx/);
    });

    it('fail when mixed 4xx and 5xx', () => {
      const f = check([
        { url: '/a', status: 404 },
        { url: '/b', status: 503 },
      ]);
      expect(f.severity).toBe('fail');
    });
  });

  // ── checkJsExceptions ────────────────────────────────────────────────────

  describe('js_exceptions finding', () => {
    function check(errors: any) {
      return HealthCheckAggregatorService.aggregateFromTestResult({ errors })
        .findings.find((f) => f.category === 'js_exceptions')!;
    }

    it('pass when errors is null', () => {
      expect(check(null).severity).toBe('pass');
    });

    it('pass when errors is an empty array', () => {
      expect(check([]).severity).toBe('pass');
    });

    it('fail with count when there are JS exceptions', () => {
      const f = check(['TypeError: x is not a function', 'ReferenceError: y']);
      expect(f.severity).toBe('fail');
      expect(f.message).toMatch(/2 unhandled JS exceptions/);
    });

    it('includes at most 5 detail entries', () => {
      const errors = Array.from({ length: 8 }, (_, i) => `Error ${i}`);
      expect(check(errors).details!.length).toBeLessThanOrEqual(5);
    });

    it('handles error objects with message property', () => {
      const f = check([{ message: 'boom' }]);
      expect(f.details![0].text).toBe('boom');
    });
  });

  // ── checkBrokenImages ────────────────────────────────────────────────────

  describe('broken_images finding', () => {
    function check(quality_checks: any) {
      return HealthCheckAggregatorService.aggregateFromTestResult({ quality_checks })
        .findings.find((f) => f.category === 'broken_images')!;
    }

    it('pass when quality_checks is null', () => {
      expect(check(null).severity).toBe('pass');
    });

    it('pass when brokenResources array is empty', () => {
      expect(check({ brokenResources: [] }).severity).toBe('pass');
    });

    it('warning when there are broken resources', () => {
      const f = check({ brokenResources: ['/img/logo.png', '/img/banner.png'] });
      expect(f.severity).toBe('warning');
      expect(f.message).toMatch(/2 broken resources/);
    });

    it('handles string resource entries', () => {
      const f = check({ brokenResources: ['http://example.com/img.png'] });
      expect(f.details![0].url).toBe('http://example.com/img.png');
    });

    it('handles object resource entries', () => {
      const f = check({ brokenResources: [{ url: 'http://example.com/img.png' }] });
      expect(f.details![0].url).toBe('http://example.com/img.png');
    });
  });

  // ── checkPageResponsive ──────────────────────────────────────────────────

  describe('page_responsive finding', () => {
    function check(error_message: any) {
      return HealthCheckAggregatorService.aggregateFromTestResult({ error_message })
        .findings.find((f) => f.category === 'page_responsive')!;
    }

    it('pass when there is no error_message', () => {
      expect(check(null).severity).toBe('pass');
    });

    it('pass when error_message does not mention timeout', () => {
      expect(check('Element not found').severity).toBe('pass');
    });

    it('fail when error_message contains "timeout"', () => {
      expect(check('Navigation timeout after 30s').severity).toBe('fail');
    });

    it('fail when error_message contains "timed out" (spaced)', () => {
      expect(check('Request timed out').severity).toBe('fail');
    });
  });

  // ── buildHealthSummary ────────────────────────────────────────────────────

  describe('buildHealthSummary', () => {
    it('returns all-zero summary for empty input', () => {
      const s = HealthCheckAggregatorService.buildHealthSummary([]);
      expect(s).toEqual({ totalChecks: 0, passed: 0, warnings: 0, failures: 0, notAvailable: 0, findings: [] });
    });

    it('skips undefined items in the input array', () => {
      const s = HealthCheckAggregatorService.buildHealthSummary([undefined, undefined]);
      expect(s.totalChecks).toBe(0);
    });

    it('lets a real observation win the merge over not_available', () => {
      // not_available ranks BELOW pass: if any execution actually observed the
      // signal, that observation is what the user should see.
      const s = HealthCheckAggregatorService.buildHealthSummary([
        {
          findings: [{ category: 'console_errors', severity: 'not_available', message: 'n/a' }],
          checkedAt: 'x',
        },
        {
          findings: [{ category: 'console_errors', severity: 'pass', message: 'ok' }],
          checkedAt: 'x',
        },
      ]);
      expect(s.findings).toHaveLength(1);
      expect(s.findings[0].severity).toBe('pass');
      expect(s.passed).toBe(1);
      expect(s.notAvailable).toBe(0);
    });

    it('counts not_available separately from passed', () => {
      const s = HealthCheckAggregatorService.buildHealthSummary([
        {
          findings: [
            { category: 'console_errors', severity: 'not_available', message: 'n/a' },
            { category: 'network_errors', severity: 'not_available', message: 'n/a' },
          ],
          checkedAt: 'x',
        },
      ]);
      expect(s.notAvailable).toBe(2);
      expect(s.passed).toBe(0);
      expect(s.totalChecks).toBe(2);
    });

    it('counts pass / warning / fail correctly', () => {
      const checks: ExecutionHealthChecks[] = [
        {
          findings: [
            { category: 'console_errors', severity: 'pass', message: 'ok' },
            { category: 'network_errors', severity: 'warning', message: 'warn' },
            { category: 'js_exceptions', severity: 'fail', message: 'fail' },
          ],
          checkedAt: new Date().toISOString(),
        },
      ];
      const s = HealthCheckAggregatorService.buildHealthSummary(checks);
      expect(s.passed).toBe(1);
      expect(s.warnings).toBe(1);
      expect(s.failures).toBe(1);
    });

    it('keeps worst severity when the same category appears across executions', () => {
      const exec1: ExecutionHealthChecks = {
        findings: [{ category: 'console_errors', severity: 'warning', message: '1 error' }],
        checkedAt: '',
      };
      const exec2: ExecutionHealthChecks = {
        findings: [{ category: 'console_errors', severity: 'fail', message: '10 errors' }],
        checkedAt: '',
      };
      const s = HealthCheckAggregatorService.buildHealthSummary([exec1, exec2]);
      const finding = s.findings.find((f) => f.category === 'console_errors')!;
      expect(finding.severity).toBe('fail');
    });

    it('merges detail arrays when severity is equal across executions', () => {
      const makeExec = (details: string[]): ExecutionHealthChecks => ({
        findings: [{
          category: 'console_errors',
          severity: 'warning',
          message: 'x',
          details: details.map((t) => ({ text: t })),
        }],
        checkedAt: '',
      });
      const s = HealthCheckAggregatorService.buildHealthSummary([makeExec(['a']), makeExec(['b'])]);
      const finding = s.findings.find((f) => f.category === 'console_errors')!;
      expect(finding.details?.map((d) => d.text)).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('each category appears at most once in the merged output', () => {
      const exec = (sev: 'pass' | 'warning' | 'fail'): ExecutionHealthChecks => ({
        findings: [{ category: 'network_errors', severity: sev, message: '' }],
        checkedAt: '',
      });
      const s = HealthCheckAggregatorService.buildHealthSummary([exec('pass'), exec('warning'), exec('fail')]);
      const byCategory = s.findings.filter((f) => f.category === 'network_errors');
      expect(byCategory).toHaveLength(1);
    });
  });
});
