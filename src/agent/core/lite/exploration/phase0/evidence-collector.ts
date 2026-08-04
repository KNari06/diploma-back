/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PHASE 0 — EVIDENCE COLLECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Gathers the cheap, high-signal facts a product brief can be inferred FROM,
 * before any LLM is involved. Everything here is plain HTTP: no browser, no
 * Playwright, no page rendering — that keeps Phase 0 affordable enough to justify
 * on top of an exploration run.
 *
 * WHY THESE TARGETS (each earns its request):
 *   - `robots.txt`     → out-of-scope paths, crawl-delay, a sitemap pointer, and
 *                        `Disallow: /` which is the strongest internal-admin tell.
 *   - `sitemap.xml`    → the single highest-signal artifact: its path segments ARE
 *                        the product's entity list. Histogrammed, never pasted.
 *   - `/`              → identity, JSON-LD, script hosts, language, CTAs.
 *   - `/pricing`       → conversion model, persona-named tiers, self-signup.
 *   - `/about`         → purpose, regulated-industry signals.
 *   - `/docs`          → domain vocabulary. **Also the most likely place to leak a
 *                        demo credential**, hence the redaction pass.
 *   - `/login`,`/signup` → auth surfaces, multiple roles, bot protection.
 *
 * A 404 is a SIGNAL, not an error: no `/pricing` plus a "Book a demo" CTA reads as
 * sales-led SaaS. So failures are recorded, never thrown.
 *
 * SAFETY:
 *   - Every URL's host passes the shared SSRF guard, and redirects are followed
 *     MANUALLY with each hop re-checked — axios's own following would validate
 *     only the first hop.
 *   - Every captured string is credential-redacted before it can reach an LLM
 *     (lite CLAUDE.md invariant #3).
 *   - Hard wall-clock cap; a slow site degrades the brief instead of the run.
 */

import axios from 'axios';
import { logger } from '@/utils/core/logger';
import { checkSsrfHost } from '@/utils/validation/ssrf-host-guard';
import { redactCredentialValues, type RedactableCredentials } from '@/utils/interpolation/redact-secrets';

/** Total wall-clock for ALL fetches. Phase 0 must not eat the exploration budget. */
const TOTAL_BUDGET_MS = 30_000;

/** Per-request timeout. Short: every target is a static-ish document. */
const PER_REQUEST_TIMEOUT_MS = 8_000;

/** Redirect hops per target, each re-validated. */
const MAX_REDIRECT_HOPS = 3;

/** Response bytes to keep per document. Enough for head + hero + nav. */
const MAX_BODY_CHARS = 60_000;

/**
 * Total body characters retained across ALL documents.
 *
 * ENFORCED, not advisory: 8 targets × `MAX_BODY_CHARS` would be ~480k, which would
 * blow the analyst's prompt an order of magnitude past its budget. The allowance is
 * spent in `TARGET_PATHS` order, so `/` and `sitemap.xml` — the highest-signal
 * documents — get their share before `/docs` can consume it.
 */
export const MAX_EVIDENCE_CHARS = 40_000;

/** Sitemap URLs to read before histogramming. */
const MAX_SITEMAP_URLS = 500;

/** Nested sitemap index files to follow. */
const MAX_SITEMAP_INDEX_FOLLOWS = 2;

/** Distinct path segments reported from the sitemap histogram. */
const MAX_PATH_SEGMENTS = 40;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** One fetched document. `ok:false` still carries signal (a 404 is information). */
export interface EvidenceDocument {
  /** Path as requested, e.g. '/pricing'. Stable key for the analyst prompt. */
  path: string;
  ok: boolean;
  status?: number;
  /** Redacted, truncated body. Empty when the fetch failed. */
  body: string;
  /** Final URL after redirects, when it differs from the request. */
  finalUrl?: string;
  /** Why it failed, when it did — 'not_found' | 'blocked' | 'timeout' | 'error'. */
  failure?: 'not_found' | 'blocked' | 'timeout' | 'error';
}

export interface ProductEvidence {
  originUrl: string;
  /** Paths actually fetched successfully — becomes `brief.evidenceSources`. */
  sources: string[];
  documents: EvidenceDocument[];
  /** `robots.txt` Disallow entries (paths only). */
  disallowedPaths: string[];
  /** True when robots.txt disallows everything — a strong internal-tool signal. */
  robotsDisallowsAll: boolean;
  /** Path-segment histogram from the sitemap: segment → count. THE entity signal. */
  pathSegments: Array<{ segment: string; count: number }>;
  /** Total sitemap URLs seen (before histogramming). */
  sitemapUrlCount: number;
  /** Third-party script/iframe hosts from the landing page (payment/captcha tells). */
  thirdPartyHosts: string[];
  /** `<html lang>` / `hreflang` / `og:locale` values found. */
  localeHints: string[];
  /** Wall-clock spent, so a caller can see when the budget bit. */
  durationMs: number;
  /** True when the budget ran out before every target was attempted. */
  budgetExhausted: boolean;
}

/** Paths fetched, in priority order — earlier ones matter more if time runs short. */
const TARGET_PATHS = [
  '/',
  '/robots.txt',
  '/sitemap.xml',
  '/pricing',
  '/about',
  '/docs',
  '/login',
  '/signup',
] as const;

interface FetchOutcome {
  status?: number;
  body: string;
  finalUrl?: string;
  failure?: EvidenceDocument['failure'];
}

/**
 * Fetch one URL, following redirects manually so every hop is SSRF-checked.
 * Never throws — a failure is an outcome, not an exception.
 */
async function fetchOnce(url: string, deadline: number): Promise<FetchOutcome> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const remaining = Math.min(PER_REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0) return { body: '', failure: 'timeout' };

    let hostname: string;
    try {
      hostname = new URL(current).hostname;
    } catch {
      return { body: '', failure: 'error' };
    }

    // Re-check EVERY hop: the guard on hop 0 says nothing about hop 1.
    const gate = await checkSsrfHost(hostname, 'PHASE0_EVIDENCE');
    if (gate.verdict !== 'allowed') {
      return { body: '', failure: gate.verdict === 'blocked' ? 'blocked' : 'error' };
    }

    try {
      const response = await axios.get(current, {
        timeout: remaining,
        maxRedirects: 0,
        validateStatus: () => true,
        maxContentLength: 2 * 1024 * 1024,
        responseType: 'text',
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
      });

      const location = response.headers?.location;
      if (response.status >= 300 && response.status < 400 && typeof location === 'string' && location) {
        if (hop === MAX_REDIRECT_HOPS) return { status: response.status, body: '', failure: 'error' };
        try {
          const next = new URL(location, current);
          if (!['http:', 'https:'].includes(next.protocol)) {
            return { status: response.status, body: '', failure: 'blocked' };
          }
          current = next.toString();
          continue;
        } catch {
          return { status: response.status, body: '', failure: 'error' };
        }
      }

      const body = typeof response.data === 'string' ? response.data.slice(0, MAX_BODY_CHARS) : '';
      return {
        status: response.status,
        body,
        finalUrl: current !== url ? current : undefined,
        failure: response.status === 404 ? 'not_found' : response.status >= 400 ? 'error' : undefined,
      };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT'
        || /timeout/i.test((err as Error)?.message || '');
      return { body: '', failure: timedOut ? 'timeout' : 'error' };
    }
  }

  return { body: '', failure: 'error' };
}

/** Extract `Disallow:` paths from robots.txt, ignoring per-agent grouping. */
function parseRobots(body: string): { disallowed: string[]; disallowsAll: boolean } {
  const disallowed: string[] = [];
  let disallowsAll = false;

  for (const rawLine of body.split(/\r?\n/).slice(0, 500)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^disallow\s*:\s*(\S*)/i);
    if (!match) continue;
    const path = match[1];
    if (path === '/') disallowsAll = true;
    if (path && path !== '/') disallowed.push(path.slice(0, 120));
  }

  return { disallowed: [...new Set(disallowed)].slice(0, 30), disallowsAll };
}

/**
 * Histogram sitemap path segments.
 *
 * The raw URL list is worthless to an LLM (hundreds of near-identical article
 * paths) but its SHAPE is the entity list: `/products/…` ×400 says "products" is a
 * core entity far more reliably than any prose on the landing page. Numeric and
 * uuid-ish segments are dropped — they are ids, not entities.
 */
function histogramPathSegments(urls: string[]): Array<{ segment: string; count: number }> {
  const counts = new Map<string, number>();

  for (const url of urls) {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    for (const segment of pathname.split('/')) {
      const s = segment.trim().toLowerCase();
      if (!s || s.length > 40) continue;
      // Drop ids: pure numbers, uuids, long hex, date fragments.
      if (/^\d+$/.test(s)) continue;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(s)) continue;
      if (/^[0-9a-f]{16,}$/.test(s)) continue;
      if (/\.(html?|php|aspx?)$/.test(s)) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([segment, count]) => ({ segment, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_PATH_SEGMENTS);
}

/** Pull `<loc>` values out of a sitemap or sitemap index. */
function parseSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && locs.length < MAX_SITEMAP_URLS) {
    locs.push(m[1]);
  }
  return locs;
}

const isSitemapIndex = (xml: string): boolean => /<sitemapindex/i.test(xml);

/** Third-party hosts from script/iframe/link tags — payment + captcha tells. */
function extractThirdPartyHosts(html: string, originHost: string): string[] {
  const hosts = new Set<string>();
  const re = /(?:src|href)\s*=\s*["'](https?:\/\/[^"'\s]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && hosts.size < 60) {
    try {
      const host = new URL(m[1]).hostname;
      if (host && host !== originHost) hosts.add(host);
    } catch {
      // ignore malformed
    }
  }
  return [...hosts].slice(0, 30);
}

/** `<html lang>`, `hreflang`, `og:locale` — drives the language field. */
function extractLocaleHints(html: string): string[] {
  const hints = new Set<string>();
  const add = (v?: string) => {
    const s = v?.trim().slice(0, 12);
    if (s) hints.add(s);
  };

  add(html.match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i)?.[1]);
  add(html.match(/property\s*=\s*["']og:locale["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1]);

  const re = /hreflang\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && hints.size < 10) add(m[1]);

  return [...hints];
}

/**
 * Collect product evidence for `originUrl`.
 *
 * Never throws and never rejects: an empty-ish `ProductEvidence` is the degraded
 * outcome, because Phase 0 is an enhancement and must not be able to fail a run.
 */
export async function collectProductEvidence(
  originUrl: string,
  credentials?: RedactableCredentials,
): Promise<ProductEvidence> {
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;

  const empty: ProductEvidence = {
    originUrl,
    sources: [],
    documents: [],
    disallowedPaths: [],
    robotsDisallowsAll: false,
    pathSegments: [],
    sitemapUrlCount: 0,
    thirdPartyHosts: [],
    localeHints: [],
    durationMs: 0,
    budgetExhausted: false,
  };

  let origin: URL;
  try {
    origin = new URL(originUrl);
  } catch {
    return { ...empty, durationMs: Date.now() - startedAt };
  }

  const redact = (s: string): string => (credentials ? redactCredentialValues(s, credentials) : s);

  try {
    // All targets in parallel — they are independent, and the shared deadline
    // bounds the whole set regardless of how slow any one of them is.
    const settled = await Promise.all(
      TARGET_PATHS.map(async (path) => {
        const url = new URL(path, origin).toString();
        const outcome = await fetchOnce(url, deadline);
        return { path, outcome };
      }),
    );

    // Spend the total character allowance in TARGET_PATHS order, so the
    // highest-signal documents are never starved by a huge /docs page.
    let charsRemaining = MAX_EVIDENCE_CHARS;
    const documents: EvidenceDocument[] = settled.map(({ path, outcome }) => {
      // Redact BEFORE the body can reach a prompt or a trace. /docs pages print
      // demo credentials verbatim (lite CLAUDE.md invariant #3). Redact before
      // truncating, so a cut can never split a credential into an unmatched tail.
      const redacted = outcome.body ? redact(outcome.body) : '';
      const body = redacted.slice(0, Math.max(0, charsRemaining));
      charsRemaining -= body.length;
      return {
        path,
        ok: !outcome.failure,
        status: outcome.status,
        body,
        finalUrl: outcome.finalUrl,
        failure: outcome.failure,
      };
    });

    const byPath = new Map(documents.map((d) => [d.path, d]));
    const landing = byPath.get('/');
    const robotsDoc = byPath.get('/robots.txt');

    const robots = robotsDoc?.ok ? parseRobots(robotsDoc.body) : { disallowed: [], disallowsAll: false };

    // Sitemap: follow an index one level so a real URL list is reached.
    let sitemapUrls: string[] = [];
    const sitemapDoc = byPath.get('/sitemap.xml');
    if (sitemapDoc?.ok && sitemapDoc.body) {
      const locs = parseSitemapLocs(sitemapDoc.body);
      if (isSitemapIndex(sitemapDoc.body)) {
        for (const child of locs.slice(0, MAX_SITEMAP_INDEX_FOLLOWS)) {
          if (Date.now() >= deadline) break;
          const childDoc = await fetchOnce(child, deadline);
          if (!childDoc.failure && childDoc.body) {
            sitemapUrls.push(...parseSitemapLocs(childDoc.body));
          }
        }
      } else {
        sitemapUrls = locs;
      }
    }

    const originHost = origin.hostname;
    const landingHtml = landing?.ok ? landing.body : '';

    return {
      originUrl,
      sources: documents.filter((d) => d.ok).map((d) => d.path),
      documents,
      disallowedPaths: robots.disallowed,
      robotsDisallowsAll: robots.disallowsAll,
      pathSegments: histogramPathSegments(sitemapUrls),
      sitemapUrlCount: sitemapUrls.length,
      thirdPartyHosts: landingHtml ? extractThirdPartyHosts(landingHtml, originHost) : [],
      localeHints: landingHtml ? extractLocaleHints(landingHtml) : [],
      durationMs: Date.now() - startedAt,
      // Report the budget as exhausted only when it actually COST us something —
      // a target that timed out. `Date.now() >= deadline` alone would flag a run
      // that fetched everything successfully and merely finished at the boundary,
      // which would make the brief look degraded when it is not.
      budgetExhausted: documents.some((d) => d.failure === 'timeout'),
    };
  } catch (error) {
    // Belt and braces: Phase 0 is an enhancement, never a failure mode.
    logger.warn('[PHASE0_EVIDENCE] Collection failed; continuing without evidence', {
      originUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...empty, durationMs: Date.now() - startedAt };
  }
}
