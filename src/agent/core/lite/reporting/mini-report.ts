/**
 * Mini Report Formatter
 * Generates console-friendly test reports with ASCII art
 */

import type { TestCaseResult } from '../test-case/types';
import { ReportGenerator } from './report-generator';

/**
 * Generate mini console report
 *
 * @param result - Test case result
 * @returns Formatted ASCII report string
 */
export async function generateMiniReport(result: TestCaseResult): Promise<string> {
  const generator = new ReportGenerator();
  const report = await generator.generate(result);
  const r = report;
  {
    const { summary, steps } = r;

    // Build ASCII report
    const lines: string[] = [];

    // Header
    lines.push('╔═══════════════════════════════════════════════════════════════╗');
    lines.push('║              TEST EXECUTION REPORT                            ║');
    lines.push('╠═══════════════════════════════════════════════════════════════╣');

    // Test info
    const testName = summary.testName.padEnd(55).slice(0, 55);
    const status = summary.status.toUpperCase().padEnd(53);
    const duration = (summary.duration / 1000).toFixed(2) + 's';
    const durationPadding = ' '.repeat(Math.max(0, 50 - duration.length));

    lines.push(`║ Test: ${testName} ║`);
    lines.push(`║ Status: ${status} ║`);
    lines.push(`║ Duration: ${duration}${durationPadding} ║`);
    lines.push('╠═══════════════════════════════════════════════════════════════╣');

    // Summary stats
    const statsLine = `Steps: ${summary.totalSteps} | Passed: ${summary.passedSteps} | Failed: ${summary.failedSteps} | Pass Rate: ${summary.passRate.toFixed(1)}%`;
    const statsPadding = ' '.repeat(Math.max(0, 63 - statsLine.length));
    lines.push(`║ ${statsLine}${statsPadding}║`);
    lines.push('╠═══════════════════════════════════════════════════════════════╣');

    // Steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const icon = step.status === 'passed' ? '✅' : step.status === 'failed' ? '❌' : '⊘';
      const desc = step.description.padEnd(57).slice(0, 57);

      lines.push(`║ ${i + 1}. ${icon} ${desc} ║`);

      // Step details
      const stepDuration = (step.duration / 1000).toFixed(2) + 's';
      const iterations = step.iterations;
      const detailsLine = `Duration: ${stepDuration} | Iterations: ${iterations}`;
      const detailsPadding = ' '.repeat(Math.max(0, 60 - detailsLine.length));
      lines.push(`║    ${detailsLine}${detailsPadding}║`);

      // AI steps
      if (step.aiSteps && step.aiSteps.length > 0) {
        for (const aiStep of step.aiSteps.slice(0, 3)) {
          // Max 3 AI steps
          const aiLine = `→ ${aiStep.padEnd(57).slice(0, 57)}`;
          lines.push(`║    ${aiLine} ║`);
        }

        if (step.aiSteps.length > 3) {
          const more = `... ${step.aiSteps.length - 3} more steps`;
          const morePadding = ' '.repeat(Math.max(0, 60 - more.length));
          lines.push(`║    ${more}${morePadding}║`);
        }
      }

      // Separator between steps
      if (i < steps.length - 1) {
        lines.push('╟───────────────────────────────────────────────────────────────╢');
      }
    }

    // Footer
    lines.push('╚═══════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  }
}

/**
 * Synchronous version of generateMiniReport for immediate rendering
 * (Without async report generation - uses only TestCaseResult data)
 *
 * @param result - Test case result
 * @returns Formatted ASCII report string
 */
export function generateMiniReportSync(result: TestCaseResult): string {
  const lines: string[] = [];

  // Calculate summary
  const totalSteps = result.steps.length;
  const passedSteps = result.steps.filter((s) => s.status === 'passed').length;
  const failedSteps = result.steps.filter((s) => s.status === 'failed').length;
  const passRate = totalSteps > 0 ? (passedSteps / totalSteps) * 100 : 0;

  // Header
  lines.push('╔═══════════════════════════════════════════════════════════════╗');
  lines.push('║              TEST EXECUTION REPORT                            ║');
  lines.push('╠═══════════════════════════════════════════════════════════════╣');

  // Test info
  const testName = result.testCase.name.padEnd(55).slice(0, 55);
  const status = result.status.toUpperCase().padEnd(53);
  const duration = (result.duration / 1000).toFixed(2) + 's';
  const durationPadding = ' '.repeat(Math.max(0, 50 - duration.length));

  lines.push(`║ Test: ${testName} ║`);
  lines.push(`║ Status: ${status} ║`);
  lines.push(`║ Duration: ${duration}${durationPadding} ║`);
  lines.push('╠═══════════════════════════════════════════════════════════════╣');

  // Summary stats
  const statsLine = `Steps: ${totalSteps} | Passed: ${passedSteps} | Failed: ${failedSteps} | Pass Rate: ${passRate.toFixed(1)}%`;
  const statsPadding = ' '.repeat(Math.max(0, 63 - statsLine.length));
  lines.push(`║ ${statsLine}${statsPadding}║`);
  lines.push('╠═══════════════════════════════════════════════════════════════╣');

  // Steps
  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i];
    const icon = step.status === 'passed' ? '✅' : step.status === 'failed' ? '❌' : '⊘';
    const desc = step.step.description.padEnd(57).slice(0, 57);

    lines.push(`║ ${i + 1}. ${icon} ${desc} ║`);

    // Step details
    const stepDuration = (step.duration / 1000).toFixed(2) + 's';
    const iterations = step.iterations;
    const detailsLine = `Duration: ${stepDuration} | Iterations: ${iterations}`;
    const detailsPadding = ' '.repeat(Math.max(0, 60 - detailsLine.length));
    lines.push(`║    ${detailsLine}${detailsPadding}║`);

    // AI steps
    if (step.aiSteps && step.aiSteps.length > 0) {
      for (const aiStep of step.aiSteps.slice(0, 3)) {
        // Max 3 AI steps per test step
        const aiLine = `→ ${aiStep.padEnd(57).slice(0, 57)}`;
        lines.push(`║    ${aiLine} ║`);
      }

      if (step.aiSteps.length > 3) {
        const more = `... ${step.aiSteps.length - 3} more steps`;
        const morePadding = ' '.repeat(Math.max(0, 60 - more.length));
        lines.push(`║    ${more}${morePadding}║`);
      }
    }

    // Separator between steps
    if (i < result.steps.length - 1) {
      lines.push('╟───────────────────────────────────────────────────────────────╢');
    }
  }

  // Footer
  lines.push('╚═══════════════════════════════════════════════════════════════╝');

  return lines.join('\n');
}
