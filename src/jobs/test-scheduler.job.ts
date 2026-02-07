/**
 * Test Scheduler Job
 *
 * Runs periodically to check for due test schedules and execute them.
 * Supports scheduling for:
 * - Modules
 * - Suites
 * - Regression Plans
 */

import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { logger } from '@/utils/core/logger';
import { NotificationService } from '@/services/notifications/notification.service';

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
    // Do not keep the process alive solely because of the scheduler timer
    this.intervalId.unref?.();
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
    targetType: 'module' | 'suite' | 'plan';
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

        case 'suite':
          await RegressionRunService.runSuite({
            suiteId: targetId,
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
      
      // Check if it's an insufficient credits error
      if (errorMessage.includes('Insufficient credits')) {
        logger.warn('[TEST_SCHEDULER] Insufficient credits for scheduled run', {
          userId,
          targetType,
          targetId,
          error: errorMessage,
        });

        // Create in-app notification
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
              // claimDueSchedule() already moves next_run_at forward, so this fires at most once per schedule execution.
              // Use a stable key to avoid duplicates from retries/log replays.
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
      }
      
      // Re-throw to let the caller handle it
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
