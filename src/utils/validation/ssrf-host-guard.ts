/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SSRF HOST GUARD — resolve-then-check, shared by every outbound fetcher
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `isBlockedSsrfHostname` ([validation.ts](validation.ts)) is a STRING check — its
 * own docblock says it does not resolve DNS. So `evil.example.com → 10.0.0.5`
 * passes it. This module closes that gap by resolving the hostname and checking
 * every returned address.
 *
 * Extracted from `entry-preflight.service.ts`, where it lived privately, because a
 * second caller appeared (Phase 0 evidence collection, which fetches ~8 URLs
 * derived from the target site — a much wider surface than one probe). Two copies
 * of an SSRF guard is how one of them silently falls behind.
 */

import { lookup } from 'dns/promises';
import { logger } from '@/utils/core/logger';
import { isBlockedSsrfHostname } from './validation';

export type SsrfHostVerdict = 'allowed' | 'blocked' | 'dns_failure';

export interface SsrfHostCheck {
  verdict: SsrfHostVerdict;
  /** Safe to surface to a user; never contains resolved internal addresses. */
  message?: string;
}

const ALLOWED: SsrfHostCheck = { verdict: 'allowed' };

/**
 * Resolve `hostname` and reject it if it is — or resolves to — a non-routable
 * address.
 *
 * Fails OPEN on an inconclusive resolver error (anything other than NXDOMAIN /
 * EAI_AGAIN): a flaky resolver must not block a legitimate run, and the caller's
 * own HTTP attempt is the backstop. Fails CLOSED on an actual private address.
 *
 * Skipped entirely in local `development` so devs can explore localhost apps —
 * matching the carve-out in `normalizeEntryUrl` / `sanitizeUrl`.
 */
export async function checkSsrfHost(hostname: string, logTag: string): Promise<SsrfHostCheck> {
  if (process.env.NODE_ENV === 'development') return ALLOWED;

  // Literal private/loopback host — caught without touching DNS.
  if (isBlockedSsrfHostname(hostname)) {
    return { verdict: 'blocked', message: 'This host is not allowed.' };
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    const blocked = addresses.find((a) => isBlockedSsrfHostname(a.address));
    if (blocked) {
      logger.warn(`[${logTag}] Hostname resolves to a blocked address`, {
        hostname,
        address: blocked.address,
      });
      return {
        verdict: 'blocked',
        message: 'This host resolves to a private address and cannot be explored.',
      };
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    // NXDOMAIN / EAI_AGAIN → the host genuinely does not resolve. For the entry
    // URL this is the typo case, and it is the single most common reason a run
    // produced nothing and still charged.
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return {
        verdict: 'dns_failure',
        message: `Could not find "${hostname}". Check the address for typos.`,
      };
    }
    logger.debug(`[${logTag}] DNS lookup inconclusive, continuing`, {
      hostname,
      error: code || String(err),
    });
  }

  return ALLOWED;
}
