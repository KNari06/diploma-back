/**
 * ═══════════════════════════════════════════════════════════════════════════
 * System Health Monitor
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Periodically pings critical infrastructure (currently just Supabase) and
 * tracks an in-process health flag. When the flag flips:
 *   - down → broadcast `system:maintenance` { active: true }  to all WS clients
 *   - up   → broadcast `system:maintenance` { active: false } to all WS clients
 *
 * The frontend subscribes to `system:maintenance` and shows a global "Идут
 * технические работы" banner while `active === true`. New clients that connect
 * AFTER the outage already started can fetch the current state via
 * `GET /api/v1/system/status`, which is wired to `getStatus()` below.
 *
 * Why a singleton instead of an HTTP probe per request: every request that
 * touches Supabase already pays the latency cost when Supabase is down (5-30s
 * of Cloudflare 5xx). Polling once a minute is dramatically cheaper and gives
 * us a chance to react instantly via WS push the first time something breaks,
 * instead of waiting for the user to trigger a request.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger, formatError } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { webSocketService } from '@/websocket/core/websocket.service';

export type SystemHealthStatus = 'up' | 'down' | 'unknown';

export interface SystemHealthSnapshot {
  status: SystemHealthStatus;
  /** ISO timestamp when the current status was first observed */
  since: string;
  /** ISO timestamp of the most recent probe (regardless of result) */
  lastCheckedAt: string;
  /** Last error message when status is 'down', undefined when 'up' */
  lastError?: string;
  /** Machine-readable cause when status is 'down' */
  reason?: string;
}

const POLL_INTERVAL_MS = 60_000;            // 1 minute when healthy
const POLL_INTERVAL_DOWN_MS = 15_000;       // 15s when degraded — recover faster
/**
 * Hard cap on a single probe. 5s was too tight — shared Supabase pools
 * occasionally take 6–9s on a cold first call after idle, producing
 * spurious maintenance-mode flips that clear on the next poll. 10s
 * leaves headroom for those cold spikes without hiding real outages.
 * Paired with PROBE_RETRY_DELAY_MS below: a failed probe retries once
 * before the monitor concludes 'down'.
 */
const PROBE_TIMEOUT_MS = 10_000;
/** Single retry gap — enough for the upstream pool to warm up. */
const PROBE_RETRY_DELAY_MS = 1_500;

class SystemHealthMonitorImpl {
  private snapshot: SystemHealthSnapshot = {
    status: 'unknown',
    since: new Date().toISOString(),
    lastCheckedAt: new Date(0).toISOString(),
  };

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private started = false;

  /**
   * Start the periodic probe loop. Idempotent — calling start() twice is safe.
   * Should be invoked once during server bootstrap, AFTER the WebSocket server
   * is initialised so the very first transition broadcast can reach clients.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    logger.info('[SYSTEM_HEALTH] Monitor started', {
      pollIntervalMs: POLL_INTERVAL_MS,
      pollIntervalDownMs: POLL_INTERVAL_DOWN_MS,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
    });

    // Run first probe immediately so initial status reflects reality fast,
    // not after a full polling interval. The probe's own .finally() will
    // schedule the next tick — this guarantees the next interval is computed
    // AFTER we know the result of the first probe (otherwise a probe that
    // returns 'down' would still be re-polled at the slow 60s cadence
    // because scheduleNext was called before snapshot.status flipped).
    void this.probeOnce().finally(() => this.scheduleNext());
  }

  stop(): void {
    // Idempotent — calling stop() before start() (e.g. shutdown during very
    // early bootstrap) is a silent no-op so we don't emit a misleading log line.
    if (!this.started && !this.timer) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
    logger.info('[SYSTEM_HEALTH] Monitor stopped');
  }

  /**
   * Returns the latest snapshot. Used by GET /api/v1/system/status so a freshly
   * loaded frontend can render the banner immediately without waiting for the
   * first WebSocket broadcast.
   */
  getStatus(): SystemHealthSnapshot {
    return { ...this.snapshot };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);

    const interval = this.snapshot.status === 'down' ? POLL_INTERVAL_DOWN_MS : POLL_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.probeOnce().finally(() => this.scheduleNext());
    }, interval);
  }

  /**
   * Quiet supabase probe — does NOT log on failure (unlike the public
   * `testSupabaseConnection` which writes to error.log on every call). This
   * matters because when supabase is down we probe every 15s; using the noisy
   * helper would dump a 5KB Cloudflare HTML page into the logs every probe,
   * polluting error.log with hundreds of KB per hour.
   *
   * Returns true on success, false on any error (network, supabase error
   * payload, timeout). The caller distinguishes outcomes via the boolean only.
   */
  private async quietSupabaseProbe(): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('tests')
        .select('id')
        .limit(1);
      return !error;
    } catch {
      return false;
    }
  }

  /**
   * Race `quietSupabaseProbe()` against `PROBE_TIMEOUT_MS`. Returns
   * `{ok, error?}` instead of throwing so the retry loop can inspect
   * both attempts. Clears the timeout handle on success to avoid
   * keeping the event loop alive.
   *
   * Note: Promise.race does NOT cancel the losing supabase request —
   * it finishes silently in the background. Acceptable because at
   * most one zombie request per attempt and probeOnce gates concurrent
   * probes via `inFlight`.
   */
  private async raceProbe(): Promise<{ ok: boolean; error?: unknown }> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const ok = await Promise.race<boolean>([
        this.quietSupabaseProbe(),
        new Promise<boolean>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('supabase probe timeout')),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return { ok };
    } catch (err) {
      return { ok: false, error: err };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }
  }

  /**
   * Run one probe with a hard timeout. Multiple parallel probes are coalesced
   * via the `inFlight` flag — if a probe is taking longer than the polling
   * interval, we skip the next tick instead of stacking requests.
   */
  private async probeOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    const checkedAt = new Date().toISOString();
    let healthy = false;
    let probeError: unknown;

    try {
      // First attempt.
      const first = await this.raceProbe();
      if (first.ok) {
        healthy = true;
      } else {
        // Single retry absorbs cold-pool spikes (first REST call after
        // Supabase shared-pool idle can take 6–9s → we'd flip to
        // maintenance mode, then recover next tick). A 1.5s pause lets
        // the pool warm up; if the second attempt also fails we treat
        // it as a genuine outage. At most 2 × PROBE_TIMEOUT_MS per
        // probeOnce, which is still way under the 60s poll interval.
        await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
        const second = await this.raceProbe();
        if (second.ok) {
          healthy = true;
        } else {
          probeError = second.error ?? first.error;
        }
      }
    } catch (err) {
      // Defensive — raceProbe resolves both branches, but guard anyway.
      probeError = err;
    } finally {
      this.inFlight = false;
    }

    const previousStatus = this.snapshot.status;
    const nextStatus: SystemHealthStatus = healthy ? 'up' : 'down';
    const changed = previousStatus !== nextStatus;

    if (changed) {
      this.snapshot = {
        status: nextStatus,
        since: checkedAt,
        lastCheckedAt: checkedAt,
        lastError: healthy ? undefined : (probeError instanceof Error ? probeError.message : 'unknown error'),
        reason: healthy ? undefined : 'supabase_down',
      };

      // Log + broadcast on every transition. Use formatError so a Cloudflare
      // HTML page from Supabase doesn't dump 5KB into the log.
      if (nextStatus === 'down') {
        logger.warn('[SYSTEM_HEALTH] Supabase unhealthy — entering maintenance mode', {
          previousStatus,
          probeError: probeError ? formatError(probeError) : { message: 'probe returned false' },
        });
      } else {
        logger.info('[SYSTEM_HEALTH] Supabase recovered — leaving maintenance mode', {
          previousStatus,
        });
      }

      this.broadcast(nextStatus);
    } else {
      // Same status — only update lastCheckedAt
      this.snapshot = {
        ...this.snapshot,
        lastCheckedAt: checkedAt,
      };
    }
  }

  private broadcast(status: SystemHealthStatus): void {
    try {
      if (status === 'down') {
        webSocketService.emitSystemMaintenance({
          active: true,
          message: 'Идут технические работы. База данных временно недоступна — мы уже разбираемся.',
          reason: this.snapshot.reason ?? 'supabase_down',
          since: this.snapshot.since,
          timestamp: new Date().toISOString(),
        });
      } else {
        webSocketService.emitSystemMaintenance({
          active: false,
          message: 'Сервис восстановлен',
          since: this.snapshot.since,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      // WebSocket may not be initialised yet during very early boot — just log.
      logger.debug('[SYSTEM_HEALTH] Failed to broadcast maintenance event', {
        error: formatError(err),
      });
    }
  }
}

export const SystemHealthMonitor = new SystemHealthMonitorImpl();
