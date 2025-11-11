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
      const testType = test.options?.intelligentMode ? 'Intelligent' : 'Standard';
      const completedResults = results.filter((r) => r.status === 'completed');
      const failedResults = results.filter((r) => r.status === 'failed');

      const header = `🧪 **${testType} Test Completed**\n\n`;
      const url = `**URL:** ${test.url}\n`;
      const duration = test.completed_at && test.created_at
        ? `**Duration:** ${Math.round((new Date(test.completed_at).getTime() - new Date(test.created_at).getTime()) / 1000)}s\n`
        : '';

      const summary = `**Results:** ${completedResults.length}/${results.length} browsers completed\n`;

      let details = '\n**Details:**\n';
      for (const result of results) {
        const icon = result.status === 'completed' ? '✅' : '❌';
        details += `${icon} ${result.browser}: ${result.status}\n`;

        if (result.errors && result.errors.length > 0) {
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
