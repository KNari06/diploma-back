import { IntelligentTestResult } from '../../types/intelligent-testing.types';

/**
 * Convert intelligent test result to standard format
 * ✅ FIX #7: Handle cancelled status properly
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
  // ✅ FIX #7: Determine status based on cancelled flag first, then success
  let status: 'completed' | 'failed' | 'cancelled';
  if (intelligentResult.cancelled) {
    status = 'cancelled';
  } else if (intelligentResult.success) {
    status = 'completed';
  } else {
    status = 'failed';
  }

  return {
    success: intelligentResult.success && !intelligentResult.cancelled,
    status,
    screenshot: intelligentResult.screenshots[0]?.screenshot,
    dom: '', // DOM will be in page visits
    logs: [`Intelligent test: ${intelligentResult.summary}`],
    networkLogs: [],
    errors: intelligentResult.errors.map((e: { message: string; page: string }) => ({
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
