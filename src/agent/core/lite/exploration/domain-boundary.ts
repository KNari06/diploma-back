/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOMAIN BOUNDARY CHECK — keep exploration inside the app under test
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The exploration agent has a bad habit: if a page exposes a "Log in with
 * Google" link, clicking it navigates to accounts.google.com and the whole
 * flow wedges itself in an SSO dialog it cannot complete. The pipeline
 * then burns its entire per-flow timeout (3 minutes by default) before the
 * outer runner gives up.
 *
 * The navigate_to command already enforces a same-origin rule. Clicks did
 * not — that is the actual leak. This module exposes a single pure
 * function used from both paths so the policy lives in one place.
 *
 * Policy (intentionally permissive — we do NOT want to block legitimate
 * internal navigation):
 *
 *   1. Same-origin with the entry URL or the current page URL → allow.
 *   2. Relative / anchor / javascript: href → allow (let the click happen;
 *      those resolve in-document and can't take us off-domain).
 *   3. Hash-only change on the same path → allow (SPA routing).
 *   4. Everything else → deny, with a reason the caller can surface.
 *
 * We treat "entry URL origin" and "current URL origin" as both valid —
 * some apps legitimately redirect to a billing subdomain mid-flow. Only
 * when the target origin matches NEITHER do we call it external.
 */

export interface DomainBoundaryDecision {
  allowed: boolean;
  reason?: string;
  /** Parsed origin of the target, when the URL could be resolved. */
  targetOrigin?: string;
}

/**
 * Decide whether navigating to `targetUrl` from `currentUrl` (within a flow
 * that started at `entryUrl`) stays inside the app under test.
 *
 * `targetUrl` may be absolute, relative, an anchor, a `javascript:` link,
 * or empty. The helper resolves it against `currentUrl` the same way a
 * browser would, so `href="products"` on `/category` resolves to
 * `/category/products`.
 */
export function checkDomainBoundary(params: {
  targetUrl: string | null | undefined;
  entryUrl: string;
  currentUrl?: string;
}): DomainBoundaryDecision {
  const { targetUrl, entryUrl } = params;
  const currentUrl = params.currentUrl || entryUrl;

  // Empty / missing targets are treated as in-document actions (e.g. a
  // button with no href). Callers should permit these — the click itself
  // may be safe and we have nothing to compare against.
  if (!targetUrl) return { allowed: true };

  const trimmed = targetUrl.trim();
  if (trimmed.length === 0) return { allowed: true };

  // Non-HTTP schemes never take the page off the app origin in a way we
  // care about. javascript: runs in-document, mailto:/tel: open native
  // handlers, data: loads inline content. Allow and let the browser decide.
  if (/^(javascript|mailto|tel|data|blob):/i.test(trimmed)) {
    return { allowed: true };
  }

  // Anchor-only links keep us on the same document.
  if (trimmed.startsWith('#')) return { allowed: true };

  let entryOrigin: string;
  let currentOrigin: string;
  try {
    entryOrigin = new URL(entryUrl).origin;
    currentOrigin = new URL(currentUrl).origin;
  } catch {
    // If we cannot parse the anchors for the check, we cannot reason about
    // it safely — default-allow to avoid false positives during exploration.
    return { allowed: true };
  }

  let target: URL;
  try {
    target = new URL(trimmed, currentUrl);
  } catch {
    // Unparseable target — deny, since a click resolving to a bad URL is
    // almost certainly not useful to the flow.
    return {
      allowed: false,
      reason: `Unparseable target URL: ${trimmed}`,
    };
  }

  const targetOrigin = target.origin;

  if (targetOrigin === entryOrigin || targetOrigin === currentOrigin) {
    return { allowed: true, targetOrigin };
  }

  return {
    allowed: false,
    targetOrigin,
    reason: `External origin ${targetOrigin} blocked (app under test: ${entryOrigin})`,
  };
}
