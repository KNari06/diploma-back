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
    // Surface the terminal reason as a top-level `error` on failure so every
    // downstream consumer (WS `test:failed` payload, failure notifications,
    // report) gets the real reason instead of a hardcoded "Test execution
    // failed". `summary` is the engine reason, e.g. "Step limit reached
    // (20 iterations)" / "Time limit exceeded (5 minutes)".
    error: status === 'failed' ? intelligentResult.summary : undefined,
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
    // V16 billing parity: propagate the per-step credits-exhausted flag from
    // the lite path so the job persists it / the report banners it, exactly
    // like the replay path's `creditsExhausted`.
    creditsExhausted: intelligentResult.creditsExhausted || false,
  };
}
