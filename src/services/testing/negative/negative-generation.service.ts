import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { NegativeToggleResolverService } from '@/services/testing/plans/negative-toggle-resolver.service';
import { NegativeTestGeneratorService } from './negative-test-generator.service';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { getProjectForAccess } from '@/services/testing/regression/db/regression.db';
import { logger } from '@/utils/core/logger';
import * as negativeDb from './db/negative.db';

/**
 * Project-level access: owner OR any workspace member. Mirrors the gate in
 * RegressionRunService so per-negative routes (not plan-scoped) don't leak
 * across a workspace. Returns true when the user may act on the project.
 */
async function hasProjectAccess(
  projectId: string | null,
  userId: string,
): Promise<boolean> {
  if (!projectId) return false;
  const project = await getProjectForAccess(projectId);
  if (!project) return false;
  if (project.user_id === userId) return true;
  if (project.workspace_id) {
    const role = await WorkspaceAccessService.getRole(userId, project.workspace_id);
    if (role != null) return true;
  }
  return false;
}

/** Average mutations the generator produces per enabled source (estimate input). */
const AVG_NEGATIVES_PER_SOURCE = 4;
/** Fallback per-UI-test wall-clock when there is no execution history. */
const FALLBACK_TEST_MS = 45_000;

/** Per-source mutex so regenerate can't race the background generation job. */
const sourceMutexes = new Map<string, Promise<void>>();
function withSourceMutex<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sourceMutexes.get(sourceId) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  sourceMutexes.set(sourceId, next);
  return prev.then(fn).finally(() => {
    release();
    if (sourceMutexes.get(sourceId) === next) sourceMutexes.delete(sourceId);
  });
}

/**
 * Orchestration for the negative-testing feature (plan-scoped).
 * Owns the business logic the controller used to inline: ownership checks,
 * toggle resolution, generation dispatch, listing, status, estimate, and
 * per-negative control. Routes call these methods and only shape the response.
 */
export class NegativeGenerationService {
  /** Verify plan ownership. Returns true when the user may act on the plan. */
  private static async assertPlanAccess(planId: string, userId: string): Promise<boolean> {
    const plan = await RegressionPlanService.getById(planId, userId);
    return !!plan;
  }

  /**
   * Toggle negative testing on a plan item (true / false / null=inherit).
   * Returns the updated item, 'plan_not_found', or 'item_not_found'.
   */
  static async toggleItem(
    planId: string,
    itemId: string,
    userId: string,
    enabled: boolean | null,
  ): Promise<
    | { status: 'ok'; item: any }
    | { status: 'plan_not_found' }
    | { status: 'item_not_found' }
  > {
    if (!(await this.assertPlanAccess(planId, userId))) {
      return { status: 'plan_not_found' };
    }

    const item = await negativeDb.updatePlanItemNegativeToggle(planId, itemId, enabled);
    if (!item) return { status: 'item_not_found' };

    return { status: 'ok', item };
  }

  /**
   * Resolve which test cases have negatives enabled and dispatch the generation
   * job. Returns the job id + count, or count=0 when nothing is enabled.
   */
  static async dispatchGeneration(
    planId: string,
    userId: string,
  ): Promise<
    | { status: 'plan_not_found' }
    | { status: 'ok'; jobId: string | null; testCaseCount: number; message?: string }
  > {
    if (!(await this.assertPlanAccess(planId, userId))) {
      return { status: 'plan_not_found' };
    }

    const enabledTestCaseIds = await NegativeToggleResolverService.getEnabledTestCaseIds(planId);

    if (enabledTestCaseIds.length === 0) {
      return {
        status: 'ok',
        jobId: null,
        testCaseCount: 0,
        message: 'No test cases have negative testing enabled',
      };
    }

    const { QueueManager } = await import('@/config/infrastructure/queues');
    const job = await QueueManager.addNegativeGenerationJob({
      planId,
      userId,
      testCaseIds: enabledTestCaseIds,
    });

    return { status: 'ok', jobId: job.id ?? null, testCaseCount: enabledTestCaseIds.length };
  }

  /** List negative test cases for every (positive) source in the plan. */
  static async listNegatives(
    planId: string,
    userId: string,
  ): Promise<{ status: 'plan_not_found' } | { status: 'ok'; negatives: any[] }> {
    if (!(await this.assertPlanAccess(planId, userId))) {
      return { status: 'plan_not_found' };
    }

    const expanded = await RegressionPlanService.expandPlan(planId);
    const sourceIds = expanded.filter((tc) => !tc.isNegative).map((tc) => tc.testCaseId);

    const negatives = await negativeDb.listNegativesBySources(sourceIds);
    return { status: 'ok', negatives };
  }

  /** Current generation-job status for the plan (running/idle). */
  static async getStatus(
    planId: string,
    userId: string,
  ): Promise<
    | { status: 'plan_not_found' }
    | { status: 'ok'; data: { status: 'running'; jobId: string | undefined; progress: number } | { status: 'idle' } }
  > {
    if (!(await this.assertPlanAccess(planId, userId))) {
      return { status: 'plan_not_found' };
    }

    const { negativeGenerationQueue } = await import('@/config/infrastructure/queues');
    const activeJobs = await negativeGenerationQueue.getJobs(['active', 'waiting']);
    const planJob = activeJobs.find((j) => j.data.planId === planId);

    if (planJob) {
      const progress = await planJob.progress;
      return {
        status: 'ok',
        data: {
          status: 'running',
          jobId: planJob.id,
          progress: typeof progress === 'number' ? progress : 0,
        },
      };
    }

    return { status: 'ok', data: { status: 'idle' } };
  }

  /**
   * Pre-run estimate of the extra cost negatives add: how many enabled UI test
   * cases lack fresh negatives, the projected negative count, and an honest
   * minute estimate from those parents' historical run time (fallback when no
   * history). Cheap — no generation, no browser.
   */
  static async estimate(
    planId: string,
    userId: string,
  ): Promise<
    | { status: 'plan_not_found' }
    | { status: 'ok'; data: { pendingSources: number; estimatedNegatives: number; estimatedMinutes: number } }
  > {
    if (!(await this.assertPlanAccess(planId, userId))) {
      return { status: 'plan_not_found' };
    }

    const enabledSourceIds = await NegativeToggleResolverService.getEnabledTestCaseIds(planId);

    // Sources that don't yet have fresh negatives are what a generate run covers.
    // Batched (single query) — avoids an N+1 count per source on large plans.
    const withFresh = await negativeDb.getSourcesWithFreshNegatives(enabledSourceIds);
    const pendingSourceIds = enabledSourceIds.filter((id) => !withFresh.has(id));

    const estimatedNegatives = pendingSourceIds.length * AVG_NEGATIVES_PER_SOURCE;
    const avgMs = (await negativeDb.getAvgDurationMsForTestCases(enabledSourceIds)) ?? FALLBACK_TEST_MS;
    const estimatedMinutes = Math.max(1, Math.round((estimatedNegatives * avgMs) / 60_000));

    return {
      status: 'ok',
      data: { pendingSources: pendingSourceIds.length, estimatedNegatives, estimatedMinutes },
    };
  }

  /** Delete one generated negative. Authorizes by the negative's own owner. */
  static async deleteNegative(
    negativeId: string,
    userId: string,
  ): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'forbidden' }> {
    const owner = await negativeDb.getNegativeOwnership(negativeId);
    if (!owner) return { status: 'not_found' };
    if (!(await hasProjectAccess(owner.projectId, userId))) return { status: 'forbidden' };

    const ok = await negativeDb.deleteNegativeById(negativeId);
    return ok ? { status: 'ok' } : { status: 'not_found' };
  }

  /** Enable/disable one negative without deleting it. */
  static async setNegativeEnabled(
    negativeId: string,
    userId: string,
    enabled: boolean,
  ): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'forbidden' }> {
    const owner = await negativeDb.getNegativeOwnership(negativeId);
    if (!owner) return { status: 'not_found' };
    if (!(await hasProjectAccess(owner.projectId, userId))) return { status: 'forbidden' };

    const ok = await negativeDb.setNegativeEnabled(negativeId, enabled);
    return ok ? { status: 'ok' } : { status: 'not_found' };
  }

  /**
   * Check-then-generate for one source under the per-source mutex. Skips when
   * fresh negatives already exist. Shared by the background job so the job and
   * regenerate serialize against each other (no duplicate generation race).
   * Returns the created ids, or null when skipped.
   */
  static async generateForSourceGuarded(
    sourceTestCaseId: string,
    userId: string,
  ): Promise<{ skipped: true } | { skipped: false; createdIds: string[] }> {
    return withSourceMutex(sourceTestCaseId, async () => {
      const existing = await NegativeTestGeneratorService.getNegativeCount(sourceTestCaseId);
      if (existing > 0) return { skipped: true as const };
      const createdIds = await NegativeTestGeneratorService.generateForTestCase(sourceTestCaseId, userId);
      return { skipped: false as const, createdIds };
    });
  }

  /**
   * Regenerate negatives for one source: delete existing, generate fresh.
   * Guarded by a per-source mutex so it can't interleave with the background
   * generation job (which check-then-generates and would otherwise duplicate).
   */
  static async regenerate(
    sourceTestCaseId: string,
    userId: string,
  ): Promise<
    | { status: 'ok'; createdIds: string[] }
    | { status: 'not_found' }
    | { status: 'forbidden' }
    | { status: 'error'; message: string }
  > {
    const owner = await negativeDb.getTestCaseOwner(sourceTestCaseId);
    if (!owner) return { status: 'not_found' };
    if (!(await hasProjectAccess(owner.projectId, userId))) return { status: 'forbidden' };

    return withSourceMutex(sourceTestCaseId, async () => {
      try {
        await NegativeTestGeneratorService.deleteExistingNegatives(sourceTestCaseId);
        const createdIds = await NegativeTestGeneratorService.generateForTestCase(sourceTestCaseId, userId);
        return { status: 'ok' as const, createdIds };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[NEGATIVE_GEN] Regenerate failed', { sourceTestCaseId, message });
        return { status: 'error' as const, message };
      }
    });
  }
}
