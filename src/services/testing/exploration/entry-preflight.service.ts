/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENTRY PREFLIGHT — is this URL worth spending an exploration on?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY: before this existed, EVERY entry failure collapsed into the same
 * outcome — `status:'completed'`, 0 test cases, **10 credits charged**, and a
 * chat reply saying "Explored <url> autonomously". A typo'd domain, a dead
 * host, a Cloudflare challenge and a genuinely empty site were
 * indistinguishable. The only discriminator was a `logger.error` line in the
 * server log; nothing reached the DB, the WS payload or the user.
 *
 * The probe runs BEFORE the job is enqueued (and therefore before the credit
 * gate), so an unreachable URL costs the user nothing and returns an honest,
 * actionable message instead of a false success.
 *
 * SSRF: `normalizeEntryUrl` blocks literal private/loopback hosts, but
 * `isBlockedSsrfHostname` deliberately does NOT resolve DNS (see its docblock),
 * so `evil.example.com → 10.0.0.5` would slip past a string check. This service
 * resolves the hostname and re-checks every returned address — the
 * resolve-then-check that comment asks for. It is the reason the probe, not just
 * the parser, is the security boundary.
 *
 * Best-effort by contract: a probe that cannot reach a verdict returns
 * `reachable` (fail-OPEN) so a flaky network never blocks a legitimate
 * exploration. Fail-closed here would turn our own outage into "your site is
 * down". The one exception is an SSRF verdict, which is always fatal.
 */

import axios from 'axios';
import { logger } from '@/utils/core/logger';
import { checkSsrfHost } from '@/utils/validation/ssrf-host-guard';

/**
 * Why an entry URL is or isn't explorable. Ordered roughly by who must act:
 * the user (`dns_failure`…`ssrf_blocked`) vs the site (`bot_challenge`,
 * `auth_required`).
 */
export type EntryPreflightVerdict =
  | 'reachable'
  | 'dns_failure'
  | 'connection_refused'
  | 'tls_error'
  | 'timeout'
  | 'http_error'
  | 'bot_challenge'
  | 'auth_required'
  | 'ssrf_blocked';

export interface EntryPreflightResult {
  verdict: EntryPreflightVerdict;
  /** True only for `reachable` — the single flag callers need to gate on. */
  ok: boolean;
  /** User-facing, actionable, no stack traces. Safe to show in chat / HTTP 400. */
  message: string;
  /** Final URL after redirects, when we got that far. */
  finalUrl?: string;
  /** HTTP status of the probe response, when there was one. */
  status?: number;
  /** True when the entry URL redirected to a DIFFERENT origin. */
  redirectedOffOrigin?: boolean;
}

/** Total wall-clock for the probe. Kept short — this runs in a request path. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Redirect hops we follow, each one re-validated.
 *
 * We follow redirects MANUALLY (`maxRedirects: 0`) because axios's own
 * redirect-following is an SSRF bypass: the DNS resolve-then-check below
 * validates only the ORIGINAL hostname, so a public host that 302s to
 * `http://169.254.169.254/latest/meta-data` would be fetched and its body
 * returned. Verified empirically before this guard existed. Every hop must go
 * back through `assertHostAllowed`.
 */
const MAX_REDIRECT_HOPS = 5;

/** Body markers that identify an interstitial rather than the real app. */
const BOT_CHALLENGE_MARKERS = [
  'just a moment',
  'checking your browser',
  'cf-browser-verification',
  'cf_chl_opt',
  'attention required',
  '__cf_chl',
  'ddos-guard',
  'please enable javascript and cookies',
];

/** Only these statuses are read as "the site is gating us", not "it's broken". */
const AUTH_STATUSES = new Set([401, 403]);

/**
 * Probe an already-normalized entry URL.
 *
 * @param entryUrl Output of `normalizeEntryUrl` — assumed syntactically valid.
 */
export async function preflightEntryUrl(entryUrl: string): Promise<EntryPreflightResult> {
  let hostname: string;
  try {
    hostname = new URL(entryUrl).hostname;
  } catch {
    // Caller should have normalized first; treat as unreachable rather than throw.
    return {
      verdict: 'dns_failure',
      ok: false,
      message: `"${entryUrl}" is not a valid URL.`,
    };
  }

  // ── SSRF: resolve-then-check (the gap isBlockedSsrfHostname documents) ──
  const gate = await assertHostAllowed(hostname);
  if (gate) return gate;

  // ── HTTP probe, following redirects MANUALLY so every hop is re-validated ──
  // GET, not HEAD: many sites return 405/404 for HEAD, and we need a body
  // snippet to recognise a bot interstitial. `maxContentLength` keeps it cheap.
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  let currentUrl = entryUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          verdict: 'timeout',
          ok: false,
          message: `"${hostname}" did not respond within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s. If it is a cold-start environment, try again in a moment.`,
        };
      }

      const response = await axios.get(currentUrl, {
        timeout: remainingMs,
        // 0 = do not auto-follow. See MAX_REDIRECT_HOPS — axios's own following
        // would skip the per-hop SSRF re-check and leak a private-IP response.
        maxRedirects: 0,
        validateStatus: () => true,
        maxContentLength: 512 * 1024,
        responseType: 'text',
        headers: {
          // Identify as a real browser: a default axios UA is itself a trigger for
          // some WAFs, which would make us report bot_challenge on a healthy site.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      // Redirect? Validate the next hop's host before touching it.
      const location = response.headers?.location;
      if (response.status >= 300 && response.status < 400 && typeof location === 'string' && location) {
        if (hop === MAX_REDIRECT_HOPS) {
          return {
            verdict: 'http_error',
            ok: false,
            status: response.status,
            finalUrl: currentUrl,
            message: 'This URL redirects too many times.',
          };
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl); // resolves relative Location
        } catch {
          return {
            verdict: 'http_error',
            ok: false,
            status: response.status,
            finalUrl: currentUrl,
            message: 'This URL redirects to an address we could not parse.',
          };
        }

        if (!['http:', 'https:'].includes(nextUrl.protocol)) {
          return {
            verdict: 'ssrf_blocked',
            ok: false,
            message: 'This URL redirects to a non-web address and cannot be explored.',
          };
        }

        const hopGate = await assertHostAllowed(nextUrl.hostname);
        if (hopGate) {
          logger.warn('[ENTRY_PREFLIGHT] Redirect target blocked', {
            from: currentUrl,
            to: nextUrl.toString(),
            verdict: hopGate.verdict,
          });
          // A redirect INTO a blocked host is an SSRF attempt, not a typo —
          // report it as blocked even when the hop failed DNS.
          return { ...hopGate, verdict: 'ssrf_blocked' };
        }

        currentUrl = nextUrl.toString();
        continue;
      }

      return classifyProbeResponse(entryUrl, currentUrl, response);
    }

    // Loop always returns; keeps TS exhaustive.
    return { verdict: 'reachable', ok: true, message: 'Probe inconclusive; continuing.' };
  } catch (err: any) {
    return classifyProbeError(err, hostname);
  }
}

/**
 * SSRF gate for a single hostname, in this service's result shape.
 *
 * Thin adapter over the shared [checkSsrfHost](../../../utils/validation/ssrf-host-guard.ts)
 * — the resolve-then-check logic lives there because Phase 0's evidence collector
 * needs the identical guard, and two copies of an SSRF check is how one of them
 * silently falls behind.
 *
 * Returns a blocking result, or `null` when the host is allowed. Applied to the
 * ENTRY host AND every redirect hop.
 */
async function assertHostAllowed(hostname: string): Promise<EntryPreflightResult | null> {
  const check = await checkSsrfHost(hostname, 'ENTRY_PREFLIGHT');
  if (check.verdict === 'allowed') return null;

  return {
    verdict: check.verdict === 'blocked' ? 'ssrf_blocked' : 'dns_failure',
    ok: false,
    message: check.message ?? 'This host cannot be explored.',
  };
}

/** Classify a final (non-redirect) probe response. */
function classifyProbeResponse(
  entryUrl: string,
  finalUrl: string,
  response: { status: number; data?: unknown },
): EntryPreflightResult {
  {
    const status = response.status;
    const redirectedOffOrigin = safeOriginDiffers(entryUrl, finalUrl);
    const body = typeof response.data === 'string' ? response.data.slice(0, 4000).toLowerCase() : '';

    const looksLikeChallenge = BOT_CHALLENGE_MARKERS.some((m) => body.includes(m));
    if (looksLikeChallenge || status === 503 && body.includes('cloudflare')) {
      return {
        verdict: 'bot_challenge',
        ok: false,
        status,
        finalUrl,
        redirectedOffOrigin,
        message:
          'This site is behind bot protection (e.g. Cloudflare), so automated exploration is blocked. Try a staging URL or allowlist our traffic.',
      };
    }

    if (AUTH_STATUSES.has(status)) {
      return {
        verdict: 'auth_required',
        ok: false,
        status,
        finalUrl,
        redirectedOffOrigin,
        message: `The site returned ${status} — it requires authentication. Provide login credentials to explore it.`,
      };
    }

    if (status >= 500) {
      return {
        verdict: 'http_error',
        ok: false,
        status,
        finalUrl,
        redirectedOffOrigin,
        message: `The site returned a server error (${status}). It may be down — try again later.`,
      };
    }

    if (status >= 400) {
      return {
        verdict: 'http_error',
        ok: false,
        status,
        finalUrl,
        redirectedOffOrigin,
        message: `The site returned ${status} for this URL. Check the address, or point us at the app's home page.`,
      };
    }

    return {
      verdict: 'reachable',
      ok: true,
      status,
      finalUrl,
      redirectedOffOrigin,
      message: 'Reachable.',
    };
  }
}

/** Map a transport-level probe failure to a verdict. */
function classifyProbeError(err: any, hostname: string): EntryPreflightResult {
  {
    const code = err?.code || '';

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err?.message || '')) {
      return {
        verdict: 'timeout',
        ok: false,
        message: `"${hostname}" did not respond within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s. If it is a cold-start environment, try again in a moment.`,
      };
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
      return {
        verdict: 'connection_refused',
        ok: false,
        message: `"${hostname}" refused the connection. Check the port and that the app is running.`,
      };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return {
        verdict: 'dns_failure',
        ok: false,
        message: `Could not find "${hostname}". Check the address for typos.`,
      };
    }
    if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'EPROTO' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      return {
        verdict: 'tls_error',
        ok: false,
        message: `"${hostname}" has an invalid HTTPS certificate. Try the http:// address if this is a test environment.`,
      };
    }

    // Unknown transport failure → fail OPEN. Our probe is not authoritative
    // enough to deny a paid action on an error we cannot classify; the real
    // browser in Phase 1 gets the final say (and now fails honestly if it
    // cannot reach the entry URL either).
    logger.warn('[ENTRY_PREFLIGHT] Unclassified probe error, allowing exploration', {
      hostname,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return { verdict: 'reachable', ok: true, message: 'Probe inconclusive; continuing.' };
  }
}

/** True when two URLs have different origins. Never throws. */
function safeOriginDiffers(a: string, b: string): boolean {
  try {
    return new URL(a).origin !== new URL(b).origin;
  } catch {
    return false;
  }
}
