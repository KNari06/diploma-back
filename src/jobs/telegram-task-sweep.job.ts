/**
 * QAIT Tasker morning sweep.
 *
 * Once a day at TELEGRAM_TASK_BATCH_HOUR (local Asia/Almaty) — before the manager
 * reposts the daily digest — re-read each chat's recent messages against its open
 * tasks, resolve statuses, expire abandoned tasks, prune old messages, then post
 * a status check asking owners about anything still unknown. All work delegates
 * to TelegramTaskService.sweepAllChats.
 *
 * Pattern mirrors ExpiringPlansJob: a frequent interval whose tick() no-ops
 * unless the local clock is in the target hour (so it fires once per day,
 * timezone-correct, regardless of the host's clock). Must be registered in all
 * three scheduler paths (index.ts / leader.ts / job-daily.ts) or it won't run in
 * prod. Feature-gated by TELEGRAM_TASKS_ENABLED.
 */
import { env } from '@/config/environment/env';
import { sweepAllChats } from '@/services/telegram-tasks/telegram-task.service';
import { logger } from '@/utils/core/logger';

const TZ = 'Asia/Almaty';
// Check four times an hour so we reliably catch the target hour without a
// once-a-minute loop; the day-guard prevents a double-run within the hour.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function localHour(): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date()),
  );
}
function localDay(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export class TelegramTaskSweepJob {
  private static intervalId: NodeJS.Timeout | null = null;
  private static inFlight = false;
  private static lastRunDay = '';

  static start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (!env.TELEGRAM_TASKS_ENABLED) {
      logger.info('[TELEGRAM_TASK_SWEEP] Disabled (TELEGRAM_TASKS_ENABLED=false) — not starting');
      return;
    }
    if (this.intervalId) {
      logger.warn('[TELEGRAM_TASK_SWEEP] Already running');
      return;
    }
    logger.info('[TELEGRAM_TASK_SWEEP] Starting', { intervalMs, batchHour: env.TELEGRAM_TASK_BATCH_HOUR, tz: TZ });
    this.intervalId = setInterval(() => {
      this.maybeTick().catch((error) => {
        logger.error('[TELEGRAM_TASK_SWEEP] Tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[TELEGRAM_TASK_SWEEP] Stopped');
    }
  }

  /** Run only when the local clock is in the target hour and we haven't run today. */
  private static async maybeTick(): Promise<void> {
    if (localHour() !== env.TELEGRAM_TASK_BATCH_HOUR) return;
    const today = localDay();
    if (today === this.lastRunDay) return;
    this.lastRunDay = today;
    await this.tick();
  }

  /** Single sweep pass. Safe to invoke manually (e.g. from an admin route / test). */
  static async tick(): Promise<{ chats: number; expired: number; pruned: number; skipped: boolean }> {
    if (this.inFlight) {
      logger.warn('[TELEGRAM_TASK_SWEEP] Previous sweep still running, skipping');
      return { chats: 0, expired: 0, pruned: 0, skipped: true };
    }
    this.inFlight = true;
    try {
      const result = await sweepAllChats();
      logger.info('[TELEGRAM_TASK_SWEEP] Sweep complete', result);
      return { ...result, skipped: false };
    } finally {
      this.inFlight = false;
    }
  }
}
