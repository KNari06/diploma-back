/**
 * Per-step screenshot retention sweep.
 *
 * Per-step screenshots are captured for EVERY step (web + mobile) when
 * SCREENSHOT_EACH_STEP_ENABLED is on (default). They live under
 * `${userId}/step-screenshots/...` in the artifacts bucket — SEPARATE from
 * final/bug screenshots (`${userId}/screenshots/...`), which this job never
 * touches. Without pruning, per-step images grow without bound (runs × steps).
 *
 * This nightly sweep walks every user's `step-screenshots/` subtree and removes
 * objects older than SCREENSHOT_RETENTION_DAYS. Runs in the scheduler process
 * (single-instance, not horizontally scaled — same reasoning as the other
 * sweeps), so no distributed lock is needed. Best-effort: storage errors log
 * and continue, never throw fatally.
 */

import { env } from '@/config/environment/env';
import { ScreenshotCaptureFeature } from '@/config/features/screenshot-capture';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/** Sweep once every 24 hours — retention is measured in days. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Storage list page size. */
const PAGE = 1000;
/** Guard against pathological deep trees. step-screenshots/<testId>/[fail/]<file> = depth 3. */
const MAX_DEPTH = 6;
/** Subfolder under each user prefix that holds per-step screenshots. */
const STEP_PREFIX = 'step-screenshots';

export class ArtifactRetentionJob {
  private static intervalId: NodeJS.Timeout | null = null;
  private static inFlight = false;

  static start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.intervalId) {
      logger.warn('[ARTIFACT_RETENTION] Already running');
      return;
    }
    logger.info('[ARTIFACT_RETENTION] Starting sweep loop', {
      intervalMs,
      retentionDays: ScreenshotCaptureFeature.getRetentionDays(),
    });

    // Kick immediately so a fresh deploy doesn't wait 24h.
    this.tick().catch((error) => {
      logger.error('[ARTIFACT_RETENTION] Initial sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.intervalId = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('[ARTIFACT_RETENTION] Interval sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[ARTIFACT_RETENTION] Stopped');
    }
  }

  /** Single sweep pass. Safe to invoke manually (e.g. from an admin route). */
  static async tick(): Promise<{ removed: number; skipped: boolean }> {
    if (this.inFlight) {
      logger.warn('[ARTIFACT_RETENTION] Previous sweep still running, skipping tick');
      return { removed: 0, skipped: true };
    }
    this.inFlight = true;
    const startedAt = Date.now();
    const bucket = env.SUPABASE_BUCKET_NAME;
    const cutoffMs = startedAt - ScreenshotCaptureFeature.getRetentionDays() * 24 * 60 * 60 * 1000;

    try {
      // Enumerate top-level user prefixes, then prune each user's step-screenshots subtree.
      let removed = 0;
      const userPrefixes = await this.listFolders('');
      for (const userId of userPrefixes) {
        removed += await this.pruneOldFiles(bucket, `${userId}/${STEP_PREFIX}`, cutoffMs, 0);
      }
      logger.info('[ARTIFACT_RETENTION] Sweep complete', {
        removed,
        users: userPrefixes.length,
        retentionDays: ScreenshotCaptureFeature.getRetentionDays(),
        durationMs: Date.now() - startedAt,
      });
      return { removed, skipped: false };
    } catch (error) {
      logger.error('[ARTIFACT_RETENTION] Sweep error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { removed: 0, skipped: false };
    } finally {
      this.inFlight = false;
    }
  }

  /** List immediate "folder" names (entries with no file id) under a prefix. */
  private static async listFolders(prefix: string): Promise<string[]> {
    const folders: string[] = [];
    let offset = 0;
    while (true) {
      const { data: entries, error } = await supabaseAdmin.storage
        .from(env.SUPABASE_BUCKET_NAME)
        .list(prefix, { limit: PAGE, offset });
      if (error) {
        logger.debug('[ARTIFACT_RETENTION] list folders error', { prefix, error: error.message });
        break;
      }
      if (!entries || entries.length === 0) break;
      for (const e of entries) {
        // A "folder" has no file id in Supabase storage listings.
        if (!(e as { id?: string | null }).id) folders.push(e.name);
      }
      if (entries.length < PAGE) break;
      offset += PAGE;
    }
    return folders;
  }

  /**
   * Recursively remove files older than `cutoffMs` under `prefix`. Returns the
   * count removed. Tolerant: list/remove errors log and continue.
   */
  private static async pruneOldFiles(
    bucket: string,
    prefix: string,
    cutoffMs: number,
    depth: number,
  ): Promise<number> {
    if (depth > MAX_DEPTH) return 0;
    let removed = 0;
    let offset = 0;

    while (true) {
      const { data: entries, error } = await supabaseAdmin.storage
        .from(bucket)
        .list(prefix, { limit: PAGE, offset });
      if (error) {
        logger.debug('[ARTIFACT_RETENTION] list error', { prefix, error: error.message });
        return removed;
      }
      if (!entries || entries.length === 0) break;

      const expiredFiles: string[] = [];
      const subFolders: string[] = [];
      for (const e of entries) {
        const isFile = !!(e as { id?: string | null }).id;
        if (isFile) {
          // Prefer created_at; fall back to updated_at / last_accessed_at.
          const ts = this.entryTimestamp(e);
          if (ts !== null && ts < cutoffMs) {
            expiredFiles.push(`${prefix}/${e.name}`);
          }
        } else {
          subFolders.push(`${prefix}/${e.name}`);
        }
      }

      if (expiredFiles.length > 0) {
        const { error: removeErr } = await supabaseAdmin.storage.from(bucket).remove(expiredFiles);
        if (removeErr) {
          logger.debug('[ARTIFACT_RETENTION] remove error', { prefix, error: removeErr.message });
        } else {
          removed += expiredFiles.length;
        }
      }

      for (const sub of subFolders) {
        removed += await this.pruneOldFiles(bucket, sub, cutoffMs, depth + 1);
      }

      if (entries.length < PAGE) break;
      offset += PAGE;
    }
    return removed;
  }

  /** Extract a millisecond timestamp from a storage list entry, or null. */
  private static entryTimestamp(entry: unknown): number | null {
    const e = entry as { created_at?: string; updated_at?: string; last_accessed_at?: string };
    const raw = e.created_at || e.updated_at || e.last_accessed_at;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
}
