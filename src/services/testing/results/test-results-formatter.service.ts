import { logger } from '@/utils/core/logger';

/**
 * Service to format test results for chat display
 */
export class TestResultsFormatterService {
  /**
   * Format UI test results into human-readable message
   */
  static formatTestResults(test: any, results: any[]): string {
    try {
      // ✅ FIX #10: Validate inputs
      if (!test || !results || !Array.isArray(results)) {
        logger.warn('[TEST_RESULTS_FORMATTER] Invalid input data', {
          hasTest: !!test,
          hasResults: !!results,
          isArray: Array.isArray(results),
        });
        return '✅ Test completed. Results are available in your dashboard.';
      }

      // ✅ FIX #20: Use dedicated intelligent_mode column instead of options.intelligentMode
      const testType = test.intelligent_mode ? 'Intelligent' : 'Standard';
      const completedResults = results.filter((r) => r && r.status === 'completed');
      const failedResults = results.filter((r) => r && r.status === 'failed');

      // Header reflects the actual outcome — "Completed" was shown even on
      // full failure, which read as a pass. Use a neutral/failed word when
      // no browser completed.
      const allFailed = completedResults.length === 0 && failedResults.length > 0;
      const headerVerb = allFailed ? 'Finished' : 'Completed';
      const header = `🧪 **${testType} Test ${headerVerb}**\n\n`;
      const url = `**URL:** ${test.url || 'N/A'}\n`; // ✅ FIX #11: Handle missing URL
      const duration = test.completed_at && test.created_at
        ? `**Duration:** ${Math.round((new Date(test.completed_at).getTime() - new Date(test.created_at).getTime()) / 1000)}s\n`
        : '';

      const summary = `**Results:** ${completedResults.length}/${results.length} browsers completed\n`;

      let details = '\n**Details:**\n';
      for (const result of results) {
        if (!result) continue; // ✅ FIX #12: Skip null/undefined results

        const icon = result.status === 'completed' ? '✅' : '❌';
        const browser = result.browser || 'Unknown'; // ✅ FIX #13: Handle missing browser
        details += `${icon} ${browser}: ${result.status || 'unknown'}\n`;

        // Surface WHY it stopped. The lite/intelligent engine writes its
        // terminal reason ("Step limit reached (20 iterations)", "Time limit
        // exceeded (5 minutes)", "Blocked: …") into `logs` and nowhere else,
        // so without this the user sees a bare "failed" with no explanation
        // and can't tell a budget-limit from a real bug.
        if (result.status !== 'completed') {
          const reason = TestResultsFormatterService.extractFailureReason(result);
          if (reason) {
            details += `   ${reason}\n`;
          }
        }

        // ✅ FIX #14: Safely check errors
        if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
          details += `   Errors: ${result.errors.length}\n`;
        }
      }

      // V11: Append step-level failure summary from executed_steps (stored on test, not test_results)
      if (test.executed_steps && Array.isArray(test.executed_steps) && failedResults.length > 0) {
        const failedSteps = test.executed_steps.filter(
          (s: any) => s?.type === 'step_completed' && s?.data?.success === false && s?.data?.runtimeMeta?.failedReason
        );
        if (failedSteps.length > 0) {
          const REASON_LABELS: Record<string, string> = {
            element_not_found: 'Element missing',
            unexpected_validation_error: 'Validation error',
            silent_backend_failure: 'Server error',
            assertion_failed: 'Assertion failed',
            timeout: 'Timeout',
            heal_blocked: 'Low confidence',
          };
          details += '\n**Failed steps:**\n';
          for (const fs of failedSteps.slice(0, 3)) {
            const meta = fs.data.runtimeMeta;
            const reason = REASON_LABELS[meta.failedReason] || meta.failedReason;
            const stepDesc = fs.data.stepDescription || `Step ${fs.data.step}`;
            details += `⚡ ${stepDesc}: ${reason}\n`;
            if (meta.failureExplanation) {
              details += `   ${meta.failureExplanation.slice(0, 150)}\n`;
            }
          }
          if (failedSteps.length > 3) {
            details += `... and ${failedSteps.length - 3} more failed step(s)\n`;
          }
        } else {
          // Lite/intelligent partial-progress block. Lite `executed_steps` carry
          // no per-step `runtimeMeta.failedReason` — the failure is run-level
          // (hit the step/time limit), not tied to one step. Without this the
          // "Failed steps" block above finds nothing and a run that completed
          // e.g. 12 of 20 actions before stopping shows zero of them. Surface
          // the completed steps so the user sees what DID happen before it
          // stopped (the terminal reason is already shown per-browser above via
          // extractFailureReason).
          TestResultsFormatterService.appendCompletedStepsBlock(test.executed_steps, (line) => { details += line; });
        }
      }

      const footer = failedResults.length > 0
        ? `\n⚠️ ${failedResults.length} browser(s) failed. Check detailed results for more info.`
        : '\n✅ All tests passed successfully!';

      return header + url + duration + summary + details + footer;
    } catch (error) {
      logger.error('[TEST_RESULTS_FORMATTER] Failed to format results', { error });
      // Neutral fallback — don't claim ✅ success, this path also runs when a
      // test failed and the formatter threw.
      return 'Test finished. Results are available in your dashboard.';
    }
  }

  /**
   * Pull a human-readable terminal reason out of a failed result's `logs`.
   * The intelligent/lite engine stores its stop reason as
   * `"Intelligent test: <reason>"` (see test-result-formatter.ts). Returns a
   * user-facing one-liner, or '' when nothing useful is present.
   */
  private static extractFailureReason(result: any): string {
    const logs = result?.logs;
    if (!Array.isArray(logs) || logs.length === 0) return '';

    const RAW_PREFIX = /^intelligent test:\s*/i;
    for (const entry of logs) {
      if (typeof entry !== 'string') continue;
      const cleaned = entry.replace(RAW_PREFIX, '').trim();
      if (!cleaned) continue;

      // Translate the engine's internal phrasing into plainer copy so a
      // budget-limit reads differently from a genuine failure.
      if (/^step limit reached/i.test(cleaned)) {
        return 'Reason: hit the step limit before finishing the goal — the flow may need to be broken into smaller tests.';
      }
      if (/^time limit exceeded/i.test(cleaned)) {
        return 'Reason: ran out of time before finishing the goal — the page may be slow or the flow too long.';
      }
      if (/^blocked/i.test(cleaned)) {
        return `Reason: ${cleaned}`;
      }
      // Generic engine reason — surface as-is (already human-readable).
      return `Reason: ${cleaned}`;
    }
    return '';
  }

  /**
   * Append a "steps completed before stopping" block for lite/intelligent runs
   * that failed at the run level (step/time budget) rather than at a specific
   * step. Renders the completed `step_completed` events so partial progress is
   * visible. `emit` receives each line to append. No-op when there are no
   * completed steps.
   */
  private static appendCompletedStepsBlock(
    executedSteps: any[],
    emit: (line: string) => void
  ): void {
    const completedSteps = executedSteps.filter(
      (s: any) => s?.type === 'step_completed' && s?.data?.success !== false
    );
    if (completedSteps.length === 0) return;

    emit(`\n**Steps completed before stopping (${completedSteps.length}):**\n`);
    for (const cs of completedSteps.slice(0, 5)) {
      const stepDesc = cs.data?.stepDescription || `Step ${cs.data?.step ?? '?'}`;
      emit(`✅ ${String(stepDesc).slice(0, 150)}\n`);
    }
    if (completedSteps.length > 5) {
      emit(`... and ${completedSteps.length - 5} more completed step(s)\n`);
    }
  }
}
