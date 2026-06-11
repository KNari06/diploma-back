import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

/**
 * Feature flags for per-step screenshot capture (web + mobile regression replay).
 *
 * Why: video/trace only record on infra-retry attempts (see test-executor.ts
 * `disableVideo`), so passing and flaky-bug runs have NO visual evidence. A
 * lightweight per-step screenshot fills that gap on every attempt — including
 * attempt 0 where flaky failures surface.
 *
 * ON by default. Pair with the artifact-retention job so stored screenshots
 * don't grow unbounded.
 */
export const ScreenshotCaptureFeature = {
  /** Capture a screenshot after every step? */
  isEnabled(): boolean {
    return env.SCREENSHOT_EACH_STEP_ENABLED;
  },

  /** Encoding format — 'webp' (smaller, via sharp) or 'jpeg' (Playwright-native). */
  getFormat(): 'webp' | 'jpeg' {
    return env.SCREENSHOT_FORMAT;
  },

  /** Quality 1-100, clamped to a safe range. */
  getQuality(): number {
    const q = Number.isFinite(env.SCREENSHOT_QUALITY) ? env.SCREENSHOT_QUALITY : 75;
    return Math.max(1, Math.min(100, Math.round(q)));
  },

  /** Retention window (days). Screenshots older than this are pruned. */
  getRetentionDays(): number {
    const d = Number.isFinite(env.SCREENSHOT_RETENTION_DAYS) ? env.SCREENSHOT_RETENTION_DAYS : 30;
    return Math.max(1, Math.round(d));
  },

  logStatus(): void {
    logger.info('[FEATURE] Per-step screenshot capture status', {
      enabled: this.isEnabled(),
      format: this.getFormat(),
      quality: this.getQuality(),
      retentionDays: this.getRetentionDays(),
    });
  },
};
