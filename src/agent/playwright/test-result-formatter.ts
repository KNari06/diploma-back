import { IntelligentTestResult } from '../types/intelligent-testing.types';

/**
 * Convert intelligent test result to standard format
 */
export function formatTestResult(
  intelligentResult: IntelligentTestResult,
  artifacts: {
    videoUrl?: string;
    videoPath?: string;
    traceUrl?: string;
    tracePath?: string;
  }
) {
  return {
    success: intelligentResult.success,
    status: intelligentResult.success ? 'completed' : 'failed',
    screenshot: intelligentResult.screenshots[0]?.screenshot,
    dom: '', // DOM will be in page visits
    logs: [`Intelligent test: ${intelligentResult.summary}`],
    networkLogs: [],
    errors: intelligentResult.errors.map(e => ({
      type: 'other' as const,
      message: e.message,
      timestamp: new Date(),
    })),
    performance: {
      pagesVisited: intelligentResult.pagesVisited,
      actionsTaken: intelligentResult.actionsTaken,
      duration: intelligentResult.duration,
      cost: intelligentResult.cost,
    },
    videoUrl: artifacts.videoUrl,
    videoPath: artifacts.videoPath,
    traceUrl: artifacts.traceUrl,
    tracePath: artifacts.tracePath,
  };
}
