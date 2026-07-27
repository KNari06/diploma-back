/**
 * Shared URL helpers for scoping analysis to a feature's URL.
 *
 * Two responsibilities that used to live in feature code and could silently
 * drift:
 *   - `extractFirstUrl` — pull the first URL-ish token out of free text
 *     (ticket description, chat message). Previously inlined in
 *     `jira.controller.ts`; keeps its original behaviour (bare-domain fallback
 *     is run through the chat `normalizeUrl`, which only adds a protocol).
 *   - `normalizeCoverageUrl` — the EXACT normalization `CoverageAnalysisService`
 *     uses to key its coverage map. Readiness scoping must use the identical
 *     logic or a URL match silently fails (see critical-patterns.md #10). A
 *     parity test pins the two together.
 */

import { normalizeUrl } from '@/api/chat/shared/utils';

/**
 * Normalize a URL for comparison: strip query, trailing slash, lowercase host.
 * MUST stay byte-for-byte identical to the logic `CoverageAnalysisService`
 * uses to build its coverage map, or scoped-gap matching breaks.
 */
export function normalizeCoverageUrl(rawUrl: string): string {
  try {
    const urlStr = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(urlStr);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return rawUrl.replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * First path segment of a URL (e.g. `/checkout/step2` → `checkout`), used to
 * treat sibling pages under the same feature as related. Empty string for a
 * root/unparseable URL.
 */
export function firstPathSegment(rawUrl: string): string {
  try {
    const urlStr = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(urlStr);
    return parsed.pathname.split('/').filter(Boolean)[0] ?? '';
  } catch {
    const path = rawUrl.replace(/^[a-z]+:\/\//i, '').replace(/\?.*$/, '');
    const afterHost = path.includes('/') ? path.slice(path.indexOf('/') + 1) : '';
    return afterHost.split('/').filter(Boolean)[0] ?? '';
  }
}

/**
 * Extract the first URL-ish token from free text. Prefers an absolute
 * http(s) URL; falls back to a bare domain (returned normalized). Returns null
 * if nothing looks like a URL. Trailing punctuation is trimmed.
 */
export function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const abs = text.match(/\bhttps?:\/\/[^\s)]+/i);
  if (abs?.[0]) return abs[0].replace(/[),.]+$/g, '');
  const domain = text.match(/\b([a-z0-9.-]+\.[a-z]{2,})(\/[^\s)]*)?/i);
  if (domain?.[0]) return normalizeUrl(domain[0].replace(/[),.]+$/g, ''));
  return null;
}
