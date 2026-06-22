import { logger } from '@/utils/core/logger';
import { NotFoundError, ValidationError } from '@/types';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import {
  fetchExplorationProject,
  fetchOwnedTestCaseIds,
} from '@/services/testing/exploration/db/exploration-run.db';

export interface RunDiscoveredResult {
  runId: string;
  planId: string;
  totalTests: number;
}

/**
 * Orchestrates the "run all discovered tests" one-click flow: takes the test
 * cases discovered by an exploration, wraps them in a throwaway regression
 * plan, and kicks off a run. Reuses the existing plan + run pipeline so the
 * user lands on the standard /runs/:runId report (live progress + video).
 */
export class ExplorationRunService {
  private static readonly MAX_TESTS_PER_RUN = 50;

  /**
   * @throws {NotFoundError}   exploration not found / not owned by user
   * @throws {ValidationError} no valid (owned) test cases supplied
   */
  static async runDiscovered(params: {
    explorationId: string;
    userId: string;
    testCaseIds: string[];
  }): Promise<RunDiscoveredResult> {
    const { explorationId, userId, testCaseIds } = params;

    if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) {
      throw new ValidationError('testCaseIds must be a non-empty array');
    }

    const projectId = await fetchExplorationProject(explorationId, userId);
    if (!projectId) {
      throw new NotFoundError('Exploration', explorationId);
    }

    // Ownership + project scoping: only run cases the user actually owns in
    // this project. Silently drops foreign/unknown ids rather than 403'ing
    // the whole batch (the FE sends ids it just rendered).
    const ownedIds = await fetchOwnedTestCaseIds(testCaseIds, projectId, userId);
    if (ownedIds.length === 0) {
      throw new ValidationError('No runnable test cases found for this exploration');
    }

    // Cap to keep the first-run fast and credit-safe; the rest stay saved as
    // draft test cases the user can run later.
    const idsToRun = ownedIds.slice(0, this.MAX_TESTS_PER_RUN);
    if (ownedIds.length > this.MAX_TESTS_PER_RUN) {
      logger.warn('[EXPLORATION_RUN] Capping discovered run', {
        explorationId,
        requested: ownedIds.length,
        cap: this.MAX_TESTS_PER_RUN,
      });
    }

    // Throwaway plan that holds the discovered cases. create() inserts the
    // items atomically (rolls back the plan if any item fails).
    const plan = await RegressionPlanService.create({
      projectId,
      userId,
      name: `Exploration ${explorationId}`,
      description: 'Auto-generated from exploration discovery',
      items: idsToRun.map((id) => ({
        itemType: 'test_case' as const,
        testCaseId: id,
        testCaseType: 'ui' as const,
      })),
    });

    const result = await RegressionRunService.runPlan({
      planId: plan.id,
      userId,
      trigger: 'manual',
    });

    logger.info('[EXPLORATION_RUN] Discovered tests run started', {
      explorationId,
      planId: plan.id,
      runId: result.runId,
      totalTests: result.totalTests,
    });

    return {
      runId: result.runId,
      planId: plan.id,
      totalTests: result.totalTests,
    };
  }
}
