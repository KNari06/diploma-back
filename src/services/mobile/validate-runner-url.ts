/**
 * Phase B-SEC — SSRF guard for the runner URL.
 *
 * Today: `MobileRunnerClient.baseUrl` comes from `env.MOBILE_RUNNER_URL`,
 * which is operator-controlled. SSRF is not a live threat — but it
 * WILL become one as soon as we introduce per-session runner routing
 * (e.g. frontend warmup already returns `runnerSocketUrl` from runner
 * pool selection; the moment any runner-side code reads URL from the
 * request body, this matters).
 *
 * Defense in depth NOW, before the per-session refactor:
 *   - Whitelist by hostname through env `MOBILE_RUNNER_ALLOWED_HOSTS`
 *     (CSV, default empty = legacy: only env.MOBILE_RUNNER_URL accepted).
 *   - Reject anything that isn't http(s).
 *   - Reject internal-network addresses (RFC1918, RFC4193, loopback,
 *     link-local) unless explicitly whitelisted by the operator.
 *
 * The function is pure. The runner client calls it once at construct
 * time today; future per-session callers can call it per-request.
 */

/**
 * Reasons we reject. Returned in the result so the caller can log a
 * specific failure (operator misconfig vs. attacker probing differ).
 */
export type RunnerUrlRejectReason =
  | 'invalid_url'
  | 'scheme_not_http'
  | 'host_not_allowed'
  | 'internal_address';

export type RunnerUrlValidation =
  | { ok: true; normalised: string }
  | { ok: false; reason: RunnerUrlRejectReason; detail: string };

/**
 * Parse the allowed-hosts env list. Empty → empty set (legacy mode,
 * caller falls back to "only the configured MOBILE_RUNNER_URL host").
 */
export function parseAllowedHosts(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Loopback / private / link-local IPv4. We don't try to be exhaustive
 * on IPv6 because the runner is never reached via raw IPv6 in our
 * deployments — if that changes, extend this. Loopback IPv6 (`::1`)
 * is included as a safety net.
 */
const INTERNAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '::',
]);

function isInternalAddress(hostname: string): boolean {
  // URL.hostname returns IPv6 addresses wrapped in square brackets
  // (`[::1]`), but the bare form (`::1`) is more natural to write in
  // the set above. Strip the brackets before checking either way so
  // both forms work.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (INTERNAL_HOSTNAMES.has(h)) return true;
  // 10.0.0.0/8 — RFC1918 class A
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // 172.16.0.0/12 — RFC1918 class B (172.16.x.x – 172.31.x.x)
  const m172 = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // 192.168.0.0/16 — RFC1918 class C
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // 169.254.0.0/16 — RFC3927 link-local (incl. AWS/GCP metadata service)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // RFC4193 IPv6 unique-local (fc00::/7)
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  return false;
}

/**
 * Validate a runner URL candidate. Pure — no I/O, no DNS.
 *
 * Decision matrix:
 *   - Not a valid URL → invalid_url
 *   - Scheme not http/https → scheme_not_http
 *   - allowedHosts non-empty AND hostname not in it → host_not_allowed
 *   - Internal address (RFC1918/etc) AND host not in allowedHosts →
 *     internal_address (the explicit allowlist overrides — operator
 *     CAN choose to reach 10.0.0.x if they really mean it).
 *   - Otherwise → ok with `normalised` (URL.toString() form).
 */
export function validateRunnerUrl(
  candidate: string,
  allowedHosts: Set<string>,
): RunnerUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid_url', detail: candidate };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_http', detail: parsed.protocol };
  }

  const host = parsed.hostname.toLowerCase();

  // The explicit allowlist is the operator's stamp of approval. If a
  // hostname is on it, we accept even internal addresses (some deploys
  // genuinely point at 10.x.x.x inside a VPC). Empty allowlist means
  // legacy mode and we skip the whitelist check entirely.
  if (allowedHosts.size > 0 && !allowedHosts.has(host)) {
    return { ok: false, reason: 'host_not_allowed', detail: host };
  }

  // Internal-address check fires ONLY when host is NOT in the
  // allowlist (the operator didn't explicitly bless it). With an
  // empty allowlist we still block internal addresses — that's the
  // legacy "don't accidentally hit metadata service" guard.
  if (!allowedHosts.has(host) && isInternalAddress(host)) {
    return { ok: false, reason: 'internal_address', detail: host };
  }

  return { ok: true, normalised: parsed.toString() };
}
