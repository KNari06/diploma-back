import { TestResultsFormatterService } from '../test-results-formatter.service';

const { formatTestResults } = TestResultsFormatterService;
const FALLBACK = '✅ Test completed. Results are available in your dashboard.';

/** A completed/failed browser result row. */
const result = (over: Record<string, any> = {}) => ({ status: 'completed', browser: 'chromium', ...over });

describe('TestResultsFormatterService.formatTestResults', () => {
  describe('input validation', () => {
    it('returns the dashboard fallback when test is missing', () => {
      expect(formatTestResults(null, [])).toBe(FALLBACK);
    });

    it('returns the fallback when results is not an array', () => {
      expect(formatTestResults({ url: 'x' }, 'nope' as any)).toBe(FALLBACK);
    });

    it('returns the fallback when an unexpected error is thrown', () => {
      const evil: any = {};
      Object.defineProperty(evil, 'intelligent_mode', {
        get() {
          throw new Error('boom');
        },
      });
      expect(formatTestResults(evil, [])).toBe(FALLBACK);
    });
  });

  describe('header and summary', () => {
    it('labels a standard test', () => {
      const out = formatTestResults({ url: 'https://x.test' }, [result()]);
      expect(out).toContain('Standard Test Completed');
    });

    it('labels an intelligent test', () => {
      const out = formatTestResults({ url: 'https://x.test', intelligent_mode: true }, [result()]);
      expect(out).toContain('Intelligent Test Completed');
    });

    it('shows the URL, or N/A when missing', () => {
      expect(formatTestResults({ url: 'https://x.test' }, [result()])).toContain('**URL:** https://x.test');
      expect(formatTestResults({}, [result()])).toContain('**URL:** N/A');
    });

    it('counts completed browsers against the total', () => {
      const out = formatTestResults({}, [result(), result({ status: 'failed' })]);
      expect(out).toContain('**Results:** 1/2 browsers completed');
    });
  });

  describe('duration', () => {
    it('renders the elapsed seconds when both timestamps exist', () => {
      const out = formatTestResults(
        { created_at: '2026-06-22T00:00:00.000Z', completed_at: '2026-06-22T00:00:05.000Z' },
        [result()],
      );
      expect(out).toContain('**Duration:** 5s');
    });

    it('omits duration when a timestamp is missing', () => {
      const out = formatTestResults({ created_at: '2026-06-22T00:00:00.000Z' }, [result()]);
      expect(out).not.toContain('**Duration:**');
    });
  });

  describe('per-browser details', () => {
    it('uses a check for completed and a cross for failed', () => {
      const out = formatTestResults({}, [result({ browser: 'chromium' }), result({ browser: 'firefox', status: 'failed' })]);
      expect(out).toContain('✅ chromium: completed');
      expect(out).toContain('❌ firefox: failed');
    });

    it('falls back to Unknown browser and unknown status', () => {
      const out = formatTestResults({}, [{ status: 'completed' }, { browser: 'webkit' }]);
      expect(out).toContain('✅ Unknown: completed');
      expect(out).toContain('webkit: unknown');
    });

    it('skips null result rows', () => {
      const out = formatTestResults({}, [null, result({ browser: 'chromium' })]);
      expect(out).toContain('chromium: completed');
    });

    it('reports an error count when a result has errors', () => {
      const out = formatTestResults({}, [result({ status: 'failed', errors: ['a', 'b'] })]);
      expect(out).toContain('Errors: 2');
    });
  });

  describe('footer', () => {
    it('warns when any browser failed', () => {
      const out = formatTestResults({}, [result({ status: 'failed' })]);
      expect(out).toContain('⚠️ 1 browser(s) failed');
    });

    it('celebrates when all passed', () => {
      const out = formatTestResults({}, [result()]);
      expect(out).toContain('✅ All tests passed successfully!');
    });
  });

  describe('failed step summary (from executed_steps)', () => {
    const failedStep = (over: Record<string, any> = {}, metaOver: Record<string, any> = {}) => ({
      type: 'step_completed',
      data: {
        success: false,
        step: 1,
        stepDescription: 'Click login',
        runtimeMeta: { failedReason: 'timeout', ...metaOver },
        ...over,
      },
    });

    it('maps known failure reasons to friendly labels', () => {
      const out = formatTestResults(
        { executed_steps: [failedStep({}, { failedReason: 'element_not_found' })] },
        [result({ status: 'failed' })],
      );
      expect(out).toContain('**Failed steps:**');
      expect(out).toContain('⚡ Click login: Element missing');
    });

    it('passes through an unknown failure reason verbatim', () => {
      const out = formatTestResults(
        { executed_steps: [failedStep({}, { failedReason: 'cosmic_ray' })] },
        [result({ status: 'failed' })],
      );
      expect(out).toContain('cosmic_ray');
    });

    it('falls back to "Step N" when no stepDescription is present', () => {
      const out = formatTestResults(
        { executed_steps: [failedStep({ stepDescription: undefined, step: 7 })] },
        [result({ status: 'failed' })],
      );
      expect(out).toContain('⚡ Step 7:');
    });

    it('truncates a long failure explanation to 150 chars', () => {
      const explanation = 'X'.repeat(200);
      const out = formatTestResults(
        { executed_steps: [failedStep({}, { failureExplanation: explanation })] },
        [result({ status: 'failed' })],
      );
      expect(out).toContain('X'.repeat(150));
      expect(out).not.toContain('X'.repeat(151));
    });

    it('caps the list at three steps and notes the remainder', () => {
      const steps = Array.from({ length: 5 }, (_, i) => failedStep({ step: i, stepDescription: `Step desc ${i}` }));
      const out = formatTestResults({ executed_steps: steps }, [result({ status: 'failed' })]);
      expect(out).toContain('... and 2 more failed step(s)');
    });

    it('omits the failed-step section when no browser failed', () => {
      const out = formatTestResults({ executed_steps: [failedStep()] }, [result()]);
      expect(out).not.toContain('**Failed steps:**');
    });
  });
});
