/**
 * Same-app / same-origin classification — the SINGLE source of truth for the
 * preview navigation trap (`external-nav-trap.ts`) and the new-tab opener
 * (`new-tab-opener.ts`). These paths MUST agree on what counts as "the same
 * app": a navigation the trap allows is also a click the opener keeps inline.
 *
 * `probeExternalAnchorAt` in `preview-session.service.ts` runs the same logic
 * inside a `page.evaluate` body (it cannot import a Node module) — keep that
 * inline copy in sync with `isSameApp` here.
 */

/** Origin of a URL, or null when unparseable. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Hostname of a URL, or '' when unparseable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const lastTwoLabels = (host: string): string => host.split('.').slice(-2).join('.');

/**
 * Brand label = the registrable second-level label (e.g. `documentolog` in
 * `account.documentolog.kz`). Used to match a brand across sibling ccTLDs.
 */
const brandLabel = (host: string): string => {
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? '') : (parts[0] ?? '');
};

/**
 * Coarse "same app" check. Returns true when any of:
 *   - identical hostname
 *   - one hostname is a subdomain of the other (www / m / dev / staging …)
 *   - the last two DNS labels match (same registrable domain, same TLD)
 *   - the brand label matches across DIFFERENT TLDs — e.g. SSO that spans a
 *     sibling ccTLD (`business.documentolog.com` ≡ `account.documentolog.kz`).
 *     Guarded by a distinctive label length (>= 4) so short public second-level
 *     labels (`co.uk`, `com.au`) don't over-match unrelated sites.
 *
 * Genuinely different brands (`kaspi.kz`, `stripe.com`) return false and stay
 * subject to the trap's revert / the opener's new-tab promotion.
 */
export function isSameApp(navUrl: string, baseUrl: string): boolean {
  const a = hostnameOf(navUrl);
  const b = hostnameOf(baseUrl);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith('.' + b) || b.endsWith('.' + a)) return true;
  if (lastTwoLabels(a) === lastTwoLabels(b)) return true;
  const ba = brandLabel(a);
  const bb = brandLabel(b);
  return ba.length >= 4 && ba === bb;
}
