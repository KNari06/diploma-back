/**
 * URL Safety — guards for autonomous agent navigation and credential
 * fill operations.
 *
 * Two distinct concerns are addressed here, sharing infrastructure:
 *
 * 1. **Navigation safety (`isNavigationSafe`)** — used by ActionExecutor
 *    when the LLM emits a `goto` AICommand. An LLM steered by injected
 *    page content (prompt injection in DOM text the agent reads) can be
 *    coaxed into emitting `goto` to attacker domains. Without a guard,
 *    the agent navigates the runner browser there. Combined with #2
 *    below (no credential origin pinning) this becomes a credential
 *    exfil chain.
 *
 *    Tiers:
 *      Tier 0 (BLOCK): non-http(s) protocols, RFC1918/loopback/metadata
 *                      IPs, raw IP literals.
 *      Tier 1 (ALLOW): same-eTLD+1 as the test's starting URL — apps
 *                      legitimately navigate within their own domain
 *                      family (app.example.com ↔ api.example.com).
 *      Tier 2 (ALLOW): well-known OAuth identity providers (Google /
 *                      GitHub / Microsoft / Apple / Facebook). Many
 *                      "login with X" goals require this.
 *      Tier 3 (BLOCK): everything else, with a clear reason.
 *
 * 2. **Credential origin pinning (`isCredentialOriginAllowed`)** —
 *    used by `overrideCredentialFillValue` in lite-engine.ts to refuse
 *    real credential injection on origins that don't match the test's
 *    starting origin family. Strictly the same-eTLD+1 rule from Tier 1
 *    above; OAuth providers are EXCLUDED here (we never type the user's
 *    Google password into accounts.google.com — only a placeholder).
 *
 * No external dependencies. eTLD+1 extraction uses last-two-segments
 * heuristic — imperfect for `.co.uk` style ccTLDs but good-enough for
 * the majority case. Calling code logs the decision so an audit trail
 * exists for any borderline rejection.
 */

import { logger } from '@/utils/core/logger';

/**
 * Protocols allowed for navigation. Anything else (file:, chrome:,
 * javascript:, data:, blob:, ftp:, ws:) is blocked outright.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Loopback / private-network / cloud-metadata hostnames and IP ranges
 * that must never be hit from a runner browser. Combines:
 *   - Loopback (RFC 5735)
 *   - Link-local (RFC 3927) — includes AWS/GCP metadata 169.254.169.254
 *   - RFC 1918 private ranges
 *   - IPv6 loopback / link-local
 *   - Common DNS aliases that resolve to those (localhost, .localhost)
 *
 * Matches by hostname pattern. IP literals checked separately by regex
 * to catch non-canonical forms (e.g. `0177.0.0.1`).
 */
const LOOPBACK_HOSTS = new Set(['localhost']);
const PRIVATE_HOSTNAME_RX = /(?:^|\.)(?:localhost|local|internal)$/i;
const IPV4_RX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Allowlist of OAuth identity providers. These domains are routinely
 * required for "login with X" flows, so blocking them would break a
 * common class of tests. Only the identity-provider eTLD+1; subdomains
 * are accepted (accounts.google.com, oauth.id.microsoft.com, etc).
 *
 * Critical: this list is for NAVIGATION ONLY. Credential fill on these
 * origins still requires the user's matching credential — we never
 * cross-paste the test target's password into a Google login.
 */
const OAUTH_PROVIDER_ETLDS = new Set([
  'google.com',
  'googleapis.com',
  'github.com',
  'githubusercontent.com', // GitHub OAuth redirect via raw.githubusercontent in some flows
  'microsoft.com',
  'microsoftonline.com',
  'live.com',
  'apple.com',
  'icloud.com',
  'facebook.com',
  'fb.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'okta.com',
  'auth0.com',
  'clerk.com',           // Clerk auth (used by many shadcn-stack apps)
  'clerk.dev',
  // Clerk tenant URLs are `<tenant>.clerk.accounts.dev`. The last-two-
  // segments heuristic reduces these to `accounts.dev` — adding the
  // bare suffix here matches all Clerk tenants. Trade-off: ANY domain
  // ending in `.accounts.dev` becomes OAuth-allowlisted, but that
  // suffix is currently controlled exclusively by Clerk so impact is
  // bounded. Re-evaluate if we move to a public-suffix-list parser.
  'accounts.dev',
  'supabase.co',         // Supabase Auth (project subdomains *.supabase.co)
  'supabase.io',
]);

/** Result of a URL safety check. */
export interface UrlSafetyResult {
  /** Whether navigation/fill should proceed. */
  allowed: boolean;
  /** Tier label for logging — explains WHY it was allowed/blocked. */
  tier: 'block-protocol' | 'block-private-ip' | 'block-cross-origin' | 'allow-same-site' | 'allow-oauth' | 'block-malformed';
  /** Human-readable reason for trace logs. */
  reason: string;
  /** Parsed origin if extractable, for downstream logging. */
  hostname?: string;
}

/**
 * Extract the registrable domain (eTLD+1) using the last-two-segments
 * heuristic. Examples:
 *   foo.example.com → example.com
 *   sub.bar.example.co.uk → example.co.uk (WRONG — last-two gives co.uk)
 *
 * Caveat: ccTLDs with a public-suffix structure (.co.uk, .com.au) are
 * NOT correctly handled — last-two gives the public suffix instead of
 * the registrable domain. For our use case (matching whether two URLs
 * belong to the same SITE), this is acceptable because:
 *   - Same site: example.co.uk and admin.example.co.uk both reduce to
 *     `co.uk` under last-two — EQUAL, so correctly treated as same site.
 *   - Different site: example.co.uk and attacker.co.uk both reduce to
 *     `co.uk` — INCORRECTLY treated as same site, allowing navigation.
 *
 * The second case is a real but bounded risk. Mitigation: bind the
 * starting URL's full hostname for stricter checks if the host happens
 * to look like a public suffix host. That's overengineering for now;
 * we accept the ccTLD blind spot and log it loudly.
 */
function extractEtldPlusOne(hostname: string): string {
  if (!hostname) return '';
  const lower = hostname.toLowerCase();
  // IPv4 literal — return as-is, no eTLD concept.
  if (IPV4_RX.test(lower)) return lower;
  // IPv6 in brackets — strip and return.
  if (lower.startsWith('[') && lower.endsWith(']')) return lower;
  const parts = lower.split('.');
  if (parts.length <= 2) return lower;
  return parts.slice(-2).join('.');
}

/**
 * Detect private / loopback / metadata IPv4. Catches:
 *   - 127.0.0.0/8
 *   - 10.0.0.0/8
 *   - 172.16.0.0/12
 *   - 192.168.0.0/16
 *   - 169.254.0.0/16 (link-local incl AWS/GCP metadata)
 *   - 0.0.0.0
 */
function isPrivateIPv4(hostname: string): boolean {
  const m = hostname.match(IPV4_RX);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Core navigation safety check. Returns a structured result so the
 * caller can log the decision and carry tier info into traces.
 */
export function isNavigationSafe(targetUrl: string, startingUrl: string): UrlSafetyResult {
  let target: URL;
  let starting: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { allowed: false, tier: 'block-malformed', reason: `unparseable URL: ${targetUrl.slice(0, 100)}` };
  }
  try {
    starting = new URL(startingUrl);
  } catch {
    // If starting URL is malformed, we can't compare — fail closed.
    return { allowed: false, tier: 'block-malformed', reason: `unparseable starting URL: ${startingUrl.slice(0, 100)}` };
  }

  // Tier 0a — protocol whitelist.
  if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
    return {
      allowed: false,
      tier: 'block-protocol',
      reason: `disallowed protocol ${target.protocol}`,
      hostname: target.hostname,
    };
  }

  // Tier 0b — private IP / loopback / metadata.
  const targetHost = target.hostname.toLowerCase();
  if (
    LOOPBACK_HOSTS.has(targetHost)
    || PRIVATE_HOSTNAME_RX.test(targetHost)
    || isPrivateIPv4(targetHost)
  ) {
    return {
      allowed: false,
      tier: 'block-private-ip',
      reason: `private/loopback hostname ${targetHost}`,
      hostname: targetHost,
    };
  }

  // Tier 1 — same eTLD+1 as starting URL.
  const targetEtld = extractEtldPlusOne(targetHost);
  const startingEtld = extractEtldPlusOne(starting.hostname);
  if (targetEtld && startingEtld && targetEtld === startingEtld) {
    return {
      allowed: true,
      tier: 'allow-same-site',
      reason: `same site as starting URL (${startingEtld})`,
      hostname: targetHost,
    };
  }

  // Tier 2 — well-known OAuth identity providers.
  if (OAUTH_PROVIDER_ETLDS.has(targetEtld)) {
    return {
      allowed: true,
      tier: 'allow-oauth',
      reason: `OAuth provider ${targetEtld}`,
      hostname: targetHost,
    };
  }

  // Tier 3 — block everything else.
  return {
    allowed: false,
    tier: 'block-cross-origin',
    reason: `cross-origin navigation to ${targetEtld || targetHost} (starting site: ${startingEtld})`,
    hostname: targetHost,
  };
}

/**
 * Stricter check for credential injection. Same as Tier 1 of
 * isNavigationSafe but DOES NOT allow OAuth providers — we never
 * inject the user's test-target credentials into Google's login form.
 *
 * Returns true ONLY when current page origin shares eTLD+1 with the
 * configured starting URL. False positives here just mean LLM gets
 * its placeholder value instead of the real credential — better than
 * leaking creds to an attacker page or to a nominally-legit OAuth
 * provider where the password almost certainly differs.
 */
export function isCredentialOriginAllowed(currentUrl: string, startingUrl: string): boolean {
  let current: URL;
  let starting: URL;
  try {
    current = new URL(currentUrl);
    starting = new URL(startingUrl);
  } catch {
    return false; // fail closed
  }
  if (!ALLOWED_PROTOCOLS.has(current.protocol)) return false;
  const a = extractEtldPlusOne(current.hostname);
  const b = extractEtldPlusOne(starting.hostname);
  return !!a && !!b && a === b;
}

/**
 * True when two URLs share the same registrable domain (eTLD+1) — i.e. belong
 * to the same SITE. `account.bi.group` and `bi.group` are same-site; an
 * `amplitude.com` analytics call is not. Used to attribute network errors to
 * the app under test (vs. third-party CDN/analytics noise). Reuses the same
 * eTLD+1 extraction as the navigation-safety rules (no duplicate heuristic).
 * Returns false on unparseable input (fail-closed).
 */
export function isSameSite(urlA: string, urlB: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(urlA);
    b = new URL(urlB);
  } catch {
    return false;
  }
  const da = extractEtldPlusOne(a.hostname);
  const db = extractEtldPlusOne(b.hostname);
  return !!da && !!db && da === db;
}

/**
 * Convenience wrapper: log decision at the right level and return the
 * boolean. Caller passes a context tag (e.g. 'goto' or 'fill').
 */
export function logUrlSafetyDecision(result: UrlSafetyResult, context: string, testId?: string): void {
  const payload = {
    testId,
    context,
    tier: result.tier,
    reason: result.reason,
    hostname: result.hostname,
  };
  if (result.allowed) {
    logger.debug('[URL_SAFETY] allowed', payload);
  } else {
    // Block decisions are warn-level — we want them visible in normal logs
    // because they may indicate prompt injection or buggy strategy.
    logger.warn('[URL_SAFETY] blocked', payload);
  }
}
