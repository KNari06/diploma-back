import { env } from '@/config/environment/env';

/**
 * When true, the regression orchestrator drops the dependency LEVEL BARRIER and
 * dispatches all (non-cyclic) tests together, bounded only by worker concurrency.
 * Default OFF. Inlining of dependency steps (preconditions) and cycle detection
 * are unaffected. See src/services/testing/regression/level-dispatch.util.ts.
 */
export function isRegressionLevelBarrierDisabled(): boolean {
  return env.REGRESSION_DISABLE_LEVEL_BARRIER === true;
}
