/**
 * Reclaim mobile build blobs that no database row references.
 *
 * WHY THIS EXISTS. A CI publish is two calls: `upload-url` mints a signed URL
 * and a unique timestamped path, then the client PUTs the binary and calls
 * `finalize` to record it. A pipeline that dies between the PUT and the
 * finalize leaves a blob of up to 500 MB that NOTHING collects — `cleanupOrphan`
 * only runs from inside finalize, and `pruneOldBuilds` only reclaims storage for
 * rows it prunes. With no row, the object is invisible to every query, so it
 * cannot even be counted, let alone deleted.
 *
 * WHY A SWEEP AND NOT A COUNTER. The first attempt at this was a pair of Redis
 * counters (issued vs finalized) that logged a warning when they diverged. That
 * was the wrong shape: it reported a NUMBER nobody read, from a tally that could
 * drift out of step with reality (and did — the two keys expired independently),
 * and it named no action. The objects and `mobile_app_builds` are the ground
 * truth. Comparing them directly needs no extra state, cannot drift, finds
 * orphans that already existed before this job shipped, and ends in the blob
 * actually being deleted rather than in someone being told a number.
 *
 * SAFETY. Deleting a live build breaks every test on that project with an
 * install failure, so the reference check is deliberately over-broad — a blob
 * survives if ANY of these point at it:
 *   - a `mobile_app_builds.storage_path`
 *   - `projects.settings.mobileApp.storagePath`            (legacy slot)
 *   - `projects.settings.mobileApps[platform].storagePath` (per-platform slot)
 *   - `projects.settings.mobileAppVariants[platform][].latest.storagePath`
 * plus a minimum age, so an upload mid-flight is never a candidate.
 *
 * Deletion is OFF by default (`MOBILE_ORPHAN_SWEEP_DELETE`). Until it is turned
 * on the job reports exactly what it would reclaim, which is the number worth
 * looking at before letting anything delete from production storage.
 */

import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { getBlobStoreForWrite } from '@/services/storage/blob';
import { logger } from '@/utils/core/logger';

/** Sweep daily — orphans are not urgent, only unbounded. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * A blob younger than this is never a candidate. Must comfortably exceed the
 * finalize mutex TTL (10 min) plus however long a slow client takes to PUT
 * 500 MB, or the sweep could delete an upload that is still on its way to
 * being finalized.
 */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** `.in()` batch size when checking paths against the builds table. */
const LOOKUP_BATCH = 200;
/** Root prefix holding every project's builds. */
const ROOT_PREFIX = 'mobile-apps/';

export interface OrphanSweepResult {
  scanned: number;
  orphaned: number;
  orphanedBytes: number;
  deleted: number;
  skipped: boolean;
}

export class MobileOrphanSweepJob {
  private static intervalId: NodeJS.Timeout | null = null;
  private static inFlight = false;

  static start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.intervalId) {
      logger.warn('[ORPHAN_SWEEP] Already running');
      return;
    }
    logger.info('[ORPHAN_SWEEP] Starting sweep loop', {
      intervalMs,
      deleteEnabled: env.MOBILE_ORPHAN_SWEEP_DELETE,
      minAgeHours: MIN_AGE_MS / 3600_000,
    });

    this.tick().catch((error) => {
      logger.error('[ORPHAN_SWEEP] Initial sweep failed', { error: message(error) });
    });

    this.intervalId = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('[ORPHAN_SWEEP] Interval sweep failed', { error: message(error) });
      });
    }, intervalMs);
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[ORPHAN_SWEEP] Stopped');
    }
  }

  /** Single pass. Safe to invoke manually. Never throws. */
  static async tick(): Promise<OrphanSweepResult> {
    const empty: OrphanSweepResult = {
      scanned: 0, orphaned: 0, orphanedBytes: 0, deleted: 0, skipped: true,
    };
    if (this.inFlight) {
      logger.warn('[ORPHAN_SWEEP] Previous sweep still running, skipping tick');
      return empty;
    }
    this.inFlight = true;
    const startedAt = Date.now();

    try {
      const store = getBlobStoreForWrite();
      if (!store.list) {
        // Supabase has no listing here; APK/IPA writes are Azure-only by policy,
        // so this only fires in a misconfigured environment.
        logger.warn('[ORPHAN_SWEEP] Storage provider cannot list objects — skipping', {
          provider: store.provider,
        });
        return empty;
      }

      const cutoff = startedAt - MIN_AGE_MS;
      const referenced = await this.loadSettingsReferences();

      let scanned = 0;
      let candidates: { storagePath: string; sizeBytes: number }[] = [];
      const orphans: { storagePath: string; sizeBytes: number }[] = [];

      for await (const blob of store.list(ROOT_PREFIX)) {
        scanned++;
        // No creation time reported → treat as too young to touch. Refusing to
        // guess is the only safe default when the age gate is what stands
        // between this job and a live upload.
        if (!blob.createdAt || blob.createdAt.getTime() > cutoff) continue;
        if (referenced.has(blob.storagePath)) continue;
        candidates.push({ storagePath: blob.storagePath, sizeBytes: blob.sizeBytes });

        if (candidates.length >= LOOKUP_BATCH) {
          orphans.push(...(await this.rejectRecordedBuilds(candidates)));
          candidates = [];
        }
      }
      if (candidates.length > 0) {
        orphans.push(...(await this.rejectRecordedBuilds(candidates)));
      }

      const orphanedBytes = orphans.reduce((sum, o) => sum + o.sizeBytes, 0);
      let deleted = 0;

      if (orphans.length > 0 && env.MOBILE_ORPHAN_SWEEP_DELETE) {
        await store.remove(orphans.map((o) => o.storagePath));
        deleted = orphans.length;
      }

      logger.info('[ORPHAN_SWEEP] Sweep complete', {
        scanned,
        orphaned: orphans.length,
        orphanedMB: Math.round(orphanedBytes / 1024 / 1024),
        deleted,
        deleteEnabled: env.MOBILE_ORPHAN_SWEEP_DELETE,
        durationMs: Date.now() - startedAt,
        // Enough to investigate without dumping thousands of paths into a log.
        sample: orphans.slice(0, 5).map((o) => o.storagePath),
      });

      return { scanned, orphaned: orphans.length, orphanedBytes, deleted, skipped: false };
    } catch (error) {
      logger.error('[ORPHAN_SWEEP] Sweep error', { error: message(error) });
      return { ...empty, skipped: false };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Every storagePath referenced from `projects.settings`. These are NOT in
   * `mobile_app_builds` in every case — the legacy slot in particular can point
   * at a build whose row was pruned — so they must be collected separately or
   * the sweep would delete the binary the editor warm-up resolves to.
   */
  private static async loadSettingsReferences(): Promise<Set<string>> {
    const referenced = new Set<string>();
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .not('settings->mobileApp', 'is', null);

    if (error) {
      // Fail CLOSED: without this set the sweep cannot tell a live build from an
      // orphan, so it must not proceed.
      throw new Error(`could not load settings references: ${error.message}`);
    }

    for (const row of data ?? []) {
      const s = (row as { settings?: Record<string, unknown> }).settings ?? {};
      addPath(referenced, (s.mobileApp as { storagePath?: string } | undefined)?.storagePath);

      for (const slot of Object.values((s.mobileApps ?? {}) as Record<string, { storagePath?: string }>)) {
        addPath(referenced, slot?.storagePath);
      }
      for (const lanes of Object.values(
        (s.mobileAppVariants ?? {}) as Record<string, { latest?: { storagePath?: string } }[]>,
      )) {
        for (const lane of lanes ?? []) addPath(referenced, lane?.latest?.storagePath);
      }
    }
    return referenced;
  }

  /** Drop any candidate that has a `mobile_app_builds` row. */
  private static async rejectRecordedBuilds(
    candidates: { storagePath: string; sizeBytes: number }[],
  ): Promise<{ storagePath: string; sizeBytes: number }[]> {
    const paths = candidates.map((c) => c.storagePath);
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .select('storage_path')
      .in('storage_path', paths);

    if (error) {
      // Fail CLOSED for this batch — an unreadable builds table must never be
      // read as "none of these are referenced".
      throw new Error(`could not check builds table: ${error.message}`);
    }

    const recorded = new Set((data ?? []).map((r) => (r as { storage_path: string }).storage_path));
    return candidates.filter((c) => !recorded.has(c.storagePath));
  }
}

function addPath(set: Set<string>, path: unknown): void {
  if (typeof path === 'string' && path.length > 0) set.add(path);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
