import { logger } from '@/utils/logger';

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

      const testType = test.options?.intelligentMode ? 'Intelligent' : 'Standard';
      const completedResults = results.filter((r) => r && r.status === 'completed');
      const failedResults = results.filter((r) => r && r.status === 'failed');

      const header = `🧪 **${testType} Test Completed**\n\n`;
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

        // ✅ FIX #14: Safely check errors
        if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
          details += `   Errors: ${result.errors.length}\n`;
        }
      }

      const footer = failedResults.length > 0
        ? `\n⚠️ ${failedResults.length} browser(s) failed. Check detailed results for more info.`
        : '\n✅ All tests passed successfully!';

      return header + url + duration + summary + details + footer;
    } catch (error) {
      logger.error('[TEST_RESULTS_FORMATTER] Failed to format results', { error });
      return '✅ Test completed. Results are available in your dashboard.';
    }
  }
}
