/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENTRY URL — normalize + validate the URL a user hands to exploration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY this exists next to `sanitizeUrl` rather than inside it:
 *
 * `sanitizeUrl` ([validation.ts](validation.ts)) is used by preview, flows and
 * step-apply, and its unit tests assert it THROWS on a scheme-less string
 * (`'not-a-url'`). Teaching it to prepend `https://` would silently change
 * behaviour for those callers — a step whose `value` is the literal word
 * `checkout` would start navigating to `https://checkout`. So the
 * scheme-prepending is scoped to the exploration entry point, which is the only
 * place a human pastes a bare domain by hand.
 *
 * The two paths this unifies previously disagreed:
 *   - REST  → `sanitizeUrl` only: rejected `app.acme.com` (the most natural
 *     thing a user types) with "A valid http(s) url is required".
 *   - Chat  → `normalizeUrl` ([api/chat/shared/utils.ts](../../api/chat/shared/utils.ts))
 *     only: prepends a scheme, but applies NEITHER the http/https allowlist NOR
 *     `isBlockedSsrfHostname`. That was an SSRF hole — `normalizeUrl`'s own
 *     comment defers private IPs to "a higher level if needed", and for
 *     exploration no such level existed.
 *
 * `normalizeEntryUrl` is that single level: prepend scheme (http for localhost,
 * https otherwise — mirroring the chat helper so behaviour is unchanged for
 * inputs it already accepted), then run the SAME protocol + SSRF checks
 * `sanitizeUrl` runs.
 */

import { ValidationError } from '@/types';
import { isBlockedSsrfHostname } from './validation';

/**
 * Exact loopback hostnames that legitimately speak http:// in local dev.
 *
 * Matched against the PARSED hostname, never a raw-string prefix — `startsWith`
 * would treat `localhost.attacker.com` as loopback and downgrade it to cleartext.
 * `0.0.0.0` / `::1` are here for scheme selection only; they are still rejected
 * by the SSRF blocklist outside development.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost');
}

/**
 * Normalize a user-supplied entry URL, then validate it.
 *
 * Accepts a bare domain (`app.acme.com` → `https://app.acme.com/`). Applies the
 * same protocol allowlist and SSRF blocklist as `sanitizeUrl`, so this is safe
 * to use as the single validation point for every exploration producer.
 *
 * @throws ValidationError — empty, unparseable, non-http(s), or SSRF-blocked host.
 */
export function normalizeEntryUrl(raw: unknown): string {
  if (!raw || typeof raw !== 'string') {
    throw new ValidationError('URL must be a non-empty string');
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('URL cannot be empty');
  }

  // Prepend a scheme only when there is none. A string that already carries
  // `://` is passed through untouched so a bad scheme still surfaces as a
  // protocol error below rather than becoming `https://htp://x`.
  //
  // Default to https, then downgrade to http ONLY for a genuine loopback HOST.
  // Deciding from the raw string (`trimmed.startsWith('localhost')`) would match
  // `localhost.attacker.com` and silently serve an attacker-chosen host over
  // cleartext, so the decision is made on the PARSED hostname.
  const hasScheme = trimmed.includes('://');
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (!hasScheme && isLoopbackHost(parsed.hostname)) {
      parsed = new URL(`http://${trimmed}`);
    }
  } catch {
    throw new ValidationError('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError('Only HTTP and HTTPS protocols are allowed');
  }

  // Same carve-out as `sanitizeUrl`: local dev explores localhost apps, but the
  // block is enforced in production AND test (the unit tests assert it).
  if (process.env.NODE_ENV !== 'development' && isBlockedSsrfHostname(parsed.hostname)) {
    throw new ValidationError('This host is not allowed');
  }

  return parsed.toString();
}
