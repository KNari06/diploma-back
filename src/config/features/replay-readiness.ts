import { env } from '@/config/environment/env';

/**
 * Feature flag for the replay readiness recollect (background/regression).
 *
 * Default OFF. When ON, a sparse fresh DOM snapshot taken right before LLM
 * element resolution triggers one `waitForPageInteractive` gate + recollect so
 * the resolver no longer picks a stray element on a mid-redirect page. See
 * src/agent/execution/replay-readiness.ts for the decision logic.
 */
export function isReplayReadinessRecollectEnabled(): boolean {
  return env.REPLAY_READINESS_RECOLLECT_ENABLED === true;
}
