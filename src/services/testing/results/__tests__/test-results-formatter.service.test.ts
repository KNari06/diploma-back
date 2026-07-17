import { TestResultsFormatterService } from '../test-results-formatter.service';

const { formatTestResults } = TestResultsFormatterService;
// Input-validation early return (bad test/results args).
const FALLBACK = '✅ Test completed. Results are available in your dashboard.';
// Catch-path fallback — neutral wording so a formatter throw on a FAILED run
// doesn't read as a pass (see source comment).
const ERROR_FALLBACK = 'Test finished. Results are available in your dashboard.';

/** A completed/failed browser result row. */
const result = (over: Record<string, any> = {}) => ({ status: 'completed', browser: 'chromium', ...over });

/** A failed step with a per-step runtimeMeta.failedReason (replay/heal shape). */
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
      expect(formatTestResults(evil, [])).toBe(ERROR_FALLBACK);
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

  // Lite/intelligent runs fail at the run level (step/time budget), so their
  // executed_steps carry no per-step runtimeMeta.failedReason. The completed
  // steps must still surface so partial progress isn't invisible.
  describe('lite partial-progress summary (from executed_steps)', () => {
    // A lite completed step: success true, no runtimeMeta.failedReason.
    const liteStep = (over: Record<string, any> = {}) => ({
      type: 'step_completed',
      data: { success: true, step: 1, stepDescription: 'Clicked search', ...over },
    });

    it('shows completed lite steps when the run failed with no per-step reason', () => {
      const out = formatTestResults(
        { executed_steps: [liteStep({ step: 1, stepDescription: 'Opened home' }), liteStep({ step: 2, stepDescription: 'Typed query' })] },
        [result({ status: 'failed' })],
      );
      expect(out).toContain('**Steps completed before stopping (2):**');
      expect(out).toContain('✅ Opened home');
      expect(out).toContain('✅ Typed query');
    });

    it('caps the completed list at five and notes the remainder', () => {
      const steps = Array.from({ length: 8 }, (_, i) => liteStep({ step: i, stepDescription: `Action ${i}` }));
      const out = formatTestResults({ executed_steps: steps }, [result({ status: 'failed' })]);
      expect(out).toContain('**Steps completed before stopping (8):**');
      expect(out).toContain('... and 3 more completed step(s)');
    });

    it('prefers the per-step failed block over the lite block when a reason exists', () => {
      // A run with a real per-step failedReason must NOT fall into the lite path.
      const out = formatTestResults(
        { executed_steps: [failedStep({}, { failedReason: 'element_not_found' })] },
        [result({ status: 'failed' })],
      );
      expect(out).toContain('**Failed steps:**');
      expect(out).not.toContain('**Steps completed before stopping');
    });

    it('omits the lite block when no browser failed', () => {
      const out = formatTestResults({ executed_steps: [liteStep()] }, [result()]);
      expect(out).not.toContain('**Steps completed before stopping');
    });

    it('omits the lite block when there are no completed steps', () => {
      // A failed step (success:false) is not "completed"; a progress event isn't
      // a step_completed. Neither should count toward the completed block.
      const out = formatTestResults(
        { executed_steps: [liteStep({ success: false }), { type: 'progress', data: {} }] },
        [result({ status: 'failed' })],
      );
      expect(out).not.toContain('**Steps completed before stopping');
    });
  });
});
