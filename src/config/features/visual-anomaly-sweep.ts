import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

/**
 * Feature flags for the sampled visual anomaly sweep — ADR-0012.
 *
 * ON by default per explicit user decision 2026-07-07 — see
 * claude-plans/release-readiness-report-20260707.md §4.3.
 */
export const VisualAnomalySweepFeature = {
  isEnabled(): boolean {
    return env.VISUAL_ANOMALY_SWEEP_ENABLED;
  },

  getSampleStrategy(): 'final_and_failure' | 'final_only' | 'all_failures' {
    return env.VISUAL_ANOMALY_SAMPLE_STRATEGY;
  },

  /** Clamped 1-5 — a hard ceiling so a runaway test case can't blow up cost. */
  getMaxScreenshotsPerTestCase(): number {
    const n = Number.isFinite(env.VISUAL_ANOMALY_MAX_SCREENSHOTS) ? env.VISUAL_ANOMALY_MAX_SCREENSHOTS : 2;
    return Math.max(1, Math.min(5, Math.round(n)));
  },

  getModel(): string {
    return env.VISUAL_ANOMALY_MODEL;
  },

  /**
   * Minimum independent-run recurrence before a finding surfaces to users.
   * Defaults to 1 (surface on first detection) per explicit user decision
   * 2026-07-10 — still fully configurable back up to a real cross-run gate.
   */
  getMinRecurrenceThreshold(): number {
    const n = Number.isFinite(env.VISUAL_ANOMALY_MIN_RECURRENCE) ? env.VISUAL_ANOMALY_MIN_RECURRENCE : 1;
    return Math.max(1, Math.round(n));
  },

  /** Rolling window (days) for recurrence counting — bounds unbounded lookback growth. */
  getRecurrenceWindowDays(): number {
    const n = Number.isFinite(env.VISUAL_ANOMALY_RECURRENCE_WINDOW_DAYS) ? env.VISUAL_ANOMALY_RECURRENCE_WINDOW_DAYS : 30;
    return Math.max(1, Math.round(n));
  },

  logStatus(): void {
    logger.info('[FEATURE] Visual anomaly sweep status', {
      enabled: this.isEnabled(),
      sampleStrategy: this.getSampleStrategy(),
      maxScreenshotsPerTestCase: this.getMaxScreenshotsPerTestCase(),
      model: this.getModel(),
      minRecurrenceThreshold: this.getMinRecurrenceThreshold(),
      recurrenceWindowDays: this.getRecurrenceWindowDays(),
    });
  },
};
