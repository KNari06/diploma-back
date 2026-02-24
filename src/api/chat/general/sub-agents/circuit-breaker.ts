import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from './config';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CIRCUIT BREAKER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Adapted from browser multi-agent orchestrator pattern.
 * Tracks sub-agent pipeline success/failure rate.
 * Opens circuit (disables pipeline) when failure rate exceeds threshold.
 *
 * States:
 * - closed: pipeline active, all requests go through
 * - open: pipeline disabled, all requests go to monolithic fallback
 * - half-open: trial mode, next request tests the pipeline
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

type CircuitState = 'closed' | 'open' | 'half-open';

class ChatCircuitBreaker {
  private state: CircuitState = 'closed';
  private recentResults: boolean[] = [];
  private requestCount = 0;

  /**
   * Check if the pipeline should be skipped (circuit is open).
   */
  shouldSkip(): boolean {
    if (this.state === 'closed') return false;

    if (this.state === 'open') {
      this.requestCount = (this.requestCount + 1) % 1000000; // prevent overflow
      // Allow a trial every N requests
      if (this.requestCount % SUB_AGENT_CONFIG.circuitBreakerRetryInterval === 0) {
        logger.info('[CIRCUIT_BREAKER] Half-open: allowing trial request', {
          requestCount: this.requestCount,
        });
        this.state = 'half-open';
        return false;
      }
      return true;
    }

    // half-open: allow trial
    return false;
  }

  /**
   * Record pipeline result and update state.
   */
  recordResult(success: boolean): void {
    this.recentResults.push(success);
    if (this.recentResults.length > SUB_AGENT_CONFIG.circuitBreakerWindowSize) {
      this.recentResults.shift();
    }

    // Half-open: immediate state transition based on trial result
    if (this.state === 'half-open') {
      this.state = success ? 'closed' : 'open';
      logger.info('[CIRCUIT_BREAKER] Trial result', {
        success,
        newState: this.state,
      });
      return;
    }

    // Closed: check if we should open
    if (this.recentResults.length >= SUB_AGENT_CONFIG.circuitBreakerWindowSize) {
      const failRate = this.recentResults.filter(r => !r).length / this.recentResults.length;
      if (failRate > SUB_AGENT_CONFIG.circuitBreakerFailThreshold) {
        this.state = 'open';
        logger.warn('[CIRCUIT_BREAKER] Circuit OPENED — pipeline disabled', {
          failRate: failRate.toFixed(2),
          threshold: SUB_AGENT_CONFIG.circuitBreakerFailThreshold,
          windowSize: this.recentResults.length,
        });
      }
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// Singleton instance (persists across requests within the process)
export const chatCircuitBreaker = new ChatCircuitBreaker();
