/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LOOP DETECTION HOOK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In-memory tracker that detects repeated and oscillating tool calls
 * within a single pipeline execution. Prevents LLM from wasting credits
 * and time by calling the same tool with identical arguments.
 *
 * Patterns detected:
 * 1. Exact repeat — same tool + same args called N times
 * 2. Oscillation — A→B→A→B→A→B pattern
 *
 * Lifecycle: Created per-pipeline, NOT persisted across requests.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';

// ── Types ────────────────────────────────────────────────────────────────

export interface LoopDetectionConfig {
  /** Warn after N identical calls (default: 2) */
  exactRepeatWarn: number;
  /** Block after N identical calls (default: 3) */
  exactRepeatBlock: number;
  /** Window size for oscillation detection (default: 6) */
  oscillationWindow: number;
}

export const DEFAULT_LOOP_DETECTION_CONFIG: LoopDetectionConfig = {
  exactRepeatWarn: 2,
  exactRepeatBlock: 3,
  oscillationWindow: 6,
};

export type LoopCheckResult =
  | { severity: 'ok' }
  | { severity: 'warn'; message: string }
  | { severity: 'block'; message: string };

interface TrackedCall {
  toolName: string;
  argsHash: string;
}

// ── ToolCallTracker ──────────────────────────────────────────────────────

/**
 * Tracks tool calls within a pipeline execution and detects loops.
 *
 * Usage:
 *   const tracker = new ToolCallTracker(config);
 *   const check = tracker.check(toolName, args);
 *   if (check.severity === 'block') { ... return error to LLM ... }
 *   // ... execute tool ...
 *   tracker.record(toolName, args);
 */
export class ToolCallTracker {
  private calls: TrackedCall[] = [];
  private readonly config: LoopDetectionConfig;

  constructor(config?: Partial<LoopDetectionConfig>) {
    this.config = { ...DEFAULT_LOOP_DETECTION_CONFIG, ...config };
  }

  /**
   * Hash tool arguments for comparison.
   * Truncated to 200 chars — enough to distinguish different calls,
   * cheap enough to not add latency.
   */
  private hashArgs(args: Record<string, any>): string {
    try {
      return JSON.stringify(args).substring(0, 200);
    } catch {
      return '{}';
    }
  }

  /**
   * Check if calling this tool would constitute a loop.
   * Call BEFORE execution — if 'block', don't execute.
   */
  check(toolName: string, args: Record<string, any>): LoopCheckResult {
    const argsHash = this.hashArgs(args);

    // ── Pattern 1: Exact repeat ────────────────────────────────────────
    const exactCount = this.calls.filter(
      c => c.toolName === toolName && c.argsHash === argsHash
    ).length;

    if (exactCount >= this.config.exactRepeatBlock) {
      logger.warn('[LOOP_DETECTION] Blocking repeated tool call', {
        toolName,
        repeatCount: exactCount + 1,
        threshold: this.config.exactRepeatBlock,
      });
      return {
        severity: 'block',
        message: `Blocked: ${toolName} called ${exactCount + 1} times with identical arguments. The result won't change — try a different approach or different parameters.`,
      };
    }

    if (exactCount >= this.config.exactRepeatWarn) {
      logger.info('[LOOP_DETECTION] Warning: repeated tool call', {
        toolName,
        repeatCount: exactCount + 1,
        threshold: this.config.exactRepeatWarn,
      });
      return {
        severity: 'warn',
        message: `Warning: You already called ${toolName} with these exact arguments (${exactCount} time${exactCount > 1 ? 's' : ''}). The result is the same. Consider a different approach.`,
      };
    }

    // ── Pattern 2: Oscillation (A→B→A→B→A→B) ──────────────────────────
    const window = this.config.oscillationWindow;
    if (this.calls.length >= window - 1) {
      // Include the current call as the latest
      const recentCalls = [...this.calls.slice(-(window - 1)), { toolName, argsHash }];

      if (recentCalls.length >= window) {
        const lastN = recentCalls.slice(-window);
        // Check if odd positions match and even positions match (A→B→A→B→A→B)
        const oddSame = lastN
          .filter((_, i) => i % 2 === 0)
          .every(c => c.toolName === lastN[0].toolName);
        const evenSame = lastN
          .filter((_, i) => i % 2 === 1)
          .every(c => c.toolName === lastN[1].toolName);

        if (oddSame && evenSame && lastN[0].toolName !== lastN[1].toolName) {
          logger.warn('[LOOP_DETECTION] Blocking oscillation pattern', {
            toolA: lastN[0].toolName,
            toolB: lastN[1].toolName,
            windowSize: window,
          });
          return {
            severity: 'block',
            message: `Blocked: Detected oscillation between ${lastN[0].toolName} and ${lastN[1].toolName}. Break the cycle — try a different approach.`,
          };
        }
      }
    }

    return { severity: 'ok' };
  }

  /**
   * Record a tool call. Call AFTER successful execution.
   */
  record(toolName: string, args: Record<string, any>): void {
    this.calls.push({
      toolName,
      argsHash: this.hashArgs(args),
    });
  }

  /** Get number of recorded calls (for diagnostics). */
  get callCount(): number {
    return this.calls.length;
  }
}
