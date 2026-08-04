/**
 * Thrown when the survey could never load the ENTRY url.
 *
 * WHY a dedicated error instead of returning an empty tree (the old behaviour):
 * an empty tree is indistinguishable from "we reached the site and it genuinely
 * has no testable flows". The engine turned both into
 * `status:'completed', reason:'no_entry_points'`, and the job then charged
 * `EXPLORATION_DISCOVERY_CREDITS` on that success path — so a typo'd or dead URL
 * cost 10 credits and told the user their site had no flows.
 *
 * Throwing routes the run into the job's existing catch, which calls
 * `failRun` with a real `error_message`, emits `status:'failed'`, and rethrows
 * BEFORE the credit deduction. No new billing logic needed — the honest path
 * already existed, this just stops masking the failure as success.
 */
export class EntryUnreachableError extends Error {
  readonly entryUrl: string;
  /** Why we could not load it — mirrors EntryPreflightVerdict vocabulary. */
  readonly reason: 'navigation_failed' | 'rate_limited' | 'site_degraded';

  constructor(
    entryUrl: string,
    reason: 'navigation_failed' | 'rate_limited' | 'site_degraded',
    detail?: string,
  ) {
    super(
      `Could not load the entry URL ${entryUrl}` +
        (reason === 'rate_limited'
          ? ' — the site rate-limited us.'
          : reason === 'site_degraded'
            // acquireSlot() returns false only when the RateLimiter marked the
            // target DEGRADED, which happens after repeated rate-limit responses
            // FROM the site. So this is a target-site condition, not our own
            // throttle — but say what was actually observed, not "unreachable".
            ? ' — the site rate-limited us repeatedly and was marked degraded.'
            : '.') +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'EntryUnreachableError';
    this.entryUrl = entryUrl;
    this.reason = reason;
  }
}
