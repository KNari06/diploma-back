import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

/**
 * Feature flags for the release-readiness LLM narrative — ADR-0012.
 *
 * The verdict itself (ready/ready_with_warnings/not_ready) is a free,
 * always-on pure function (`release-verdict.util.ts`) with no flag. This
 * gates only the optional narrative text layered on top of it.
 *
 * ON by default per explicit user decision 2026-07-07 — see
 * claude-plans/release-readiness-report-20260707.md §4.3.
 */
export const ReleaseNarrativeFeature = {
  isEnabled(): boolean {
    return env.RELEASE_NARRATIVE_ENABLED;
  },

  getModel(): string {
    return env.RELEASE_NARRATIVE_MODEL;
  },

  logStatus(): void {
    logger.info('[FEATURE] Release narrative status', {
      enabled: this.isEnabled(),
      model: this.getModel(),
    });
  },
};
