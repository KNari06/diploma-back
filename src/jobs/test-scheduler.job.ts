/**
 * Test Scheduler Job
 *
 * Runs periodically to check for due test schedules and execute them.
 * Supports scheduling for:
 * - Modules
 * - Regression Plans
 */

import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { logger } from '@/utils/core/logger';
import { NotificationService } from '@/services/notifications/notification.service';
import { testRunQueue } from '@/config/infrastructure/queues';
import { env } from '@/config/environment/env';

/**
 * Redis key holding the scheduler's last-tick wall-clock (ms).
 * Anything more than ~120s stale means the scheduler process is dead /
 * frozen / unscheduled. Read this from a /health endpoint or admin panel
 * to detect "schedules show 'in 13h' but never fire" situations.
 */
const SCHEDULER_HEARTBEAT_KEY = `${env.QUEUE_PREFIX}scheduler:last_tick`;
const SCHEDULER_HEARTBEAT_TTL_SEC = 300; // 5 minutes — TTL is just GC, not signal

async function writeHeartbeat(): Promise<void> {
  try {
    const redis = await testRunQueue.client;
    await redis.set(SCHEDULER_HEARTBEAT_KEY, String(Date.now()), 'EX', SCHEDULER_HEARTBEAT_TTL_SEC);
  } catch (err) {
    // Heartbeat is observability — never fail the scheduler on its
    // own pulse. Surface but swallow.
    logger.debug('[TEST_SCHEDULER] Heartbeat write failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read the scheduler heartbeat. Returns milliseconds since last tick
 * (Infinity if never written / Redis down). Used by the admin/health
 * endpoint to decide whether to alert.
 */
export async function getSchedulerHeartbeatAgeMs(): Promise<number> {
  try {
    const redis = await testRunQueue.client;
    const value = await redis.get(SCHEDULER_HEARTBEAT_KEY);
    if (!value) return Infinity;
    const ts = parseInt(value, 10);
    if (!Number.isFinite(ts)) return Infinity;
    return Date.now() - ts;
  } catch {
    return Infinity;
  }
}

/**
 * Test Scheduler Job Handler
 * Processes scheduled test runs
 */
export class TestSchedulerJobHandler {
  private static isRunning = false;
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Start the scheduler
   * Runs every minute to check for due schedules
   */
  static start(intervalMs: number = 60000): void {
    if (this.intervalId) {
      logger.warn('[TEST_SCHEDULER] Scheduler already running');
      return;
    }

    logger.info('[TEST_SCHEDULER] Starting scheduler', { intervalMs });

    // Run immediately on start
    this.processSchedules().catch((error) => {
      logger.error('[TEST_SCHEDULER] Initial run failed', { error });
    });

    // Then run at interval
    this.intervalId = setInterval(() => {
      this.processSchedules().catch((error) => {
        logger.error('[TEST_SCHEDULER] Scheduled run failed', { error });
      });
    }, intervalMs);
    // NOTE: Do NOT call .unref() — the scheduler process MUST stay alive.
    // The interval is the sole reason the event loop keeps running.
  }

  /**
   * Stop the scheduler
   */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[TEST_SCHEDULER] Scheduler stopped');
    }
  }

  /**
   * Process all due schedules
   */
  static async processSchedules(): Promise<void> {
    // Prevent concurrent runs
    if (this.isRunning) {
      logger.debug('[TEST_SCHEDULER] Skip - already processing');
      return;
    }

    this.isRunning = true;

    // Update heartbeat FIRST, before any DB call. Even if Supabase is
    // briefly unavailable and getDueSchedules throws, we still want the
    // health endpoint to see "scheduler is alive, just blocked on DB".
    await writeHeartbeat();

    try {
      const dueSchedules = await ScheduleService.getDueSchedules();

      if (dueSchedules.length === 0) {
        logger.debug('[TEST_SCHEDULER] No due schedules');
        return;
      }

      logger.info('[TEST_SCHEDULER] Processing due schedules', {
        count: dueSchedules.length,
      });

      for (const schedule of dueSchedules) {
        try {
          // Atomically claim schedule (prevents duplicate execution across instances)
          const claimed = await ScheduleService.claimDueSchedule(schedule.scheduleId);
          if (!claimed) {
            logger.debug('[TEST_SCHEDULER] Skip - schedule already claimed', {
              scheduleId: schedule.scheduleId,
            });
            continue;
          }

          await this.executeSchedule(schedule);

          logger.info('[TEST_SCHEDULER] Schedule executed', {
            scheduleId: schedule.scheduleId,
            targetType: schedule.targetType,
            targetId: schedule.targetId,
          });
        } catch (error) {
          logger.error('[TEST_SCHEDULER] Failed to execute schedule', {
            error,
            scheduleId: schedule.scheduleId,
          });
          // Continue with next schedule even if one fails
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Execute a single schedule
   */
  private static async executeSchedule(schedule: {
    scheduleId: string;
    projectId: string;
    userId: string;
    targetType: 'module' | 'plan';
    targetId: string;
    parameters: Record<string, any>;
  }): Promise<void> {
    const { targetType, targetId, userId, parameters } = schedule;

    try {
      switch (targetType) {
        case 'module':
          await RegressionRunService.runModule({
            moduleId: targetId,
            userId,
            trigger: 'scheduled',
            parameters,
          });
          break;

        case 'plan':
          await RegressionRunService.runPlan({
            planId: targetId,
            userId,
            trigger: 'scheduled',
            parameters,
          });
          break;

        default:
          logger.warn('[TEST_SCHEDULER] Unknown target type', { targetType });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // ── Branch 1: Insufficient credits ──────────────────────────────
      // Distinct notification so the FE / dashboard can show a
      // "top up credits" CTA rather than a generic "schedule failed".
      if (errorMessage.includes('Insufficient credits')) {
        logger.warn('[TEST_SCHEDULER] Insufficient credits for scheduled run', {
          userId,
          targetType,
          targetId,
          error: errorMessage,
        });

        try {
          await NotificationService.createNotification({
            userId,
            type: 'personal',
            category: 'billing',
            title: 'Insufficient credits for scheduled run',
            message: `Your scheduled ${targetType} could not run due to insufficient credits. Please add credits to continue.`,
            metadata: {
              scheduleId: schedule.scheduleId,
              targetType,
              targetId,
              projectId: schedule.projectId,
              error: errorMessage,
              dedupeKey: `schedule:${schedule.scheduleId}:insufficient`,
            },
          });

          logger.info('[TEST_SCHEDULER] Created insufficient credits notification', {
            userId,
            scheduleId: schedule.scheduleId,
          });
        } catch (notifError) {
          logger.error('[TEST_SCHEDULER] Failed to create insufficient credits notification', {
            error: notifError instanceof Error ? notifError.message : String(notifError),
            userId,
          });
        }

        throw error;
      }

      // ── Branch 2: Target deleted / not found ─────────────────────────
      // The schedule's plan or module was deleted but the row in
      // test_schedules still references it. Keep firing this forever
      // would spam logs. Deactivate the schedule and tell the user.
      const looksLikeNotFound =
        errorMessage.toLowerCase().includes('not found')
        || errorMessage.toLowerCase().includes('does not exist');
      if (looksLikeNotFound) {
        logger.warn('[TEST_SCHEDULER] Scheduled target no longer exists — deactivating schedule', {
          userId,
          scheduleId: schedule.scheduleId,
          targetType,
          targetId,
          error: errorMessage,
        });

        try {
          await ScheduleService.deactivate(schedule.scheduleId, userId);
        } catch (deactivateError) {
          logger.error('[TEST_SCHEDULER] Failed to deactivate orphan schedule', {
            error: deactivateError instanceof Error ? deactivateError.message : String(deactivateError),
            scheduleId: schedule.scheduleId,
          });
        }

        try {
          await NotificationService.createNotification({
            userId,
            type: 'personal',
            category: 'system',
            title: 'Scheduled run disabled — target was deleted',
            message: `The ${targetType} this schedule was pointing at no longer exists. The schedule has been disabled.`,
            metadata: {
              scheduleId: schedule.scheduleId,
              targetType,
              targetId,
              projectId: schedule.projectId,
              error: errorMessage,
              dedupeKey: `schedule:${schedule.scheduleId}:orphan`,
            },
          });
        } catch (notifError) {
          logger.error('[TEST_SCHEDULER] Failed to create orphan-target notification', {
            error: notifError instanceof Error ? notifError.message : String(notifError),
            userId,
          });
        }

        throw error;
      }

      // ── Branch 3: All other failures ─────────────────────────────────
      // Network blip, DB error, runner crash. Schedule's next_run_at
      // was already advanced by claimDueSchedule(), so the user misses
      // exactly one occurrence. Tell them so they aren't surprised.
      logger.error('[TEST_SCHEDULER] Scheduled run failed', {
        userId,
        scheduleId: schedule.scheduleId,
        targetType,
        targetId,
        error: errorMessage,
      });

      try {
        await NotificationService.createNotification({
          userId,
          type: 'personal',
          category: 'system',
          title: 'Scheduled run failed',
          message: `Your scheduled ${targetType} couldn't start: ${errorMessage.slice(0, 200)}. The next scheduled run will try again.`,
          metadata: {
            scheduleId: schedule.scheduleId,
            targetType,
            targetId,
            projectId: schedule.projectId,
            error: errorMessage,
            // No dedupeKey across runs — every distinct failure occurrence
            // is worth surfacing. NotificationService doesn't currently
            // act on dedupeKey anyway (it's metadata, not a unique index).
          },
        });
      } catch (notifError) {
        logger.error('[TEST_SCHEDULER] Failed to create generic failure notification', {
          error: notifError instanceof Error ? notifError.message : String(notifError),
          userId,
        });
      }

      // Re-throw to let the caller (processSchedules loop) record it
      // and continue with the next schedule.
      throw error;
    }
  }

  /**
   * Process a single schedule (for BullMQ job processing)
   * Can be used if you want to use BullMQ instead of setInterval
   */
  static async processSingleSchedule(scheduleId: string): Promise<void> {
    try {
      // Get schedule details
      const dueSchedules = await ScheduleService.getDueSchedules();
      const schedule = dueSchedules.find((s) => s.scheduleId === scheduleId);

      if (!schedule) {
        logger.warn('[TEST_SCHEDULER] Schedule not found or not due', { scheduleId });
        return;
      }

      const claimed = await ScheduleService.claimDueSchedule(scheduleId);
      if (!claimed) {
        logger.warn('[TEST_SCHEDULER] Schedule already claimed or not due', { scheduleId });
        return;
      }

      await this.executeSchedule(schedule);

      logger.info('[TEST_SCHEDULER] Schedule processed via job', { scheduleId });
    } catch (error) {
      logger.error('[TEST_SCHEDULER] Failed to process schedule job', {
        error,
        scheduleId,
      });
      throw error;
    }
  }
}
