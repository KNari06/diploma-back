/**
 * ThirdPartyBlocker
 * Uses page.route() to abort requests to known analytics/tracking/third-party domains.
 *
 * WHY: Playwright's built-in waitForNavigation() and waitForLoadState('networkidle')
 * count ALL in-flight requests, including third-party analytics, chat widgets, etc.
 * A single slow Intercom or Google Analytics request can cause a 30s navigation timeout
 * even though the client's actual site loaded in 2s.
 *
 * By aborting these requests at the route level, Playwright never sees them as pending,
 * so networkidle fires as soon as the real site content is loaded.
 *
 * Domain list is shared with NetworkTracker.ANALYTICS_DOMAINS for consistency.
 */

import { logger } from '@/utils/core/logger';
import type { Page, Route } from 'playwright';

/**
 * Comprehensive list of third-party domains to block.
 * These are analytics, tracking, marketing, session replay, customer messaging,
 * and other services that don't affect the client's core site functionality.
 *
 * Exported so NetworkTracker and other modules can reuse the same list.
 */
export const THIRD_PARTY_DOMAINS: readonly string[] = [
  // ── Core analytics ──
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'googleadservices.com',
  'googlesyndication.com',
  'doubleclick.net',
  'googleads.g.doubleclick.net',
  'google.com/pagead',
  'tagmanager.google.com',

  // ── Error tracking & monitoring ──
  'sentry.io',
  'sentry-cdn.com',
  'bugsnag.com',
  'rollbar.com',
  'airbrake.io',
  'raygun.io',
  'trackjs.com',

  // ── Product analytics ──
  'mixpanel.com',
  'amplitude.com',
  'heap.io',
  'heapanalytics.com',
  'segment.com',
  'segment.io',
  'cdn.segment.com',
  'posthog.com',
  'posthog.net',
  'kissmetrics.com',
  'kissmetrics.io',
  'mp.weixin.qq.com',

  // ── Session replay & heatmaps ──
  'hotjar.com',
  'hotjar.io',
  'static.hotjar.com',
  'fullstory.com',
  'fullstoryapp.com',
  'rs.fullstory.com',
  'logrocket.com',
  'logrocket.io',
  'cdn.logrocket.io',
  'mouseflow.com',
  'inspectlet.com',
  'crazyegg.com',
  'clarity.microsoft.com',
  'clarity.ms',
  'smartlook.com',
  'smartlook.cloud',

  // ── Marketing & advertising pixels ──
  'facebook.com',
  'facebook.net',
  'fbcdn.net',
  'connect.facebook.net',
  'linkedin.com',
  'licdn.com',
  'snap.licdn.com',
  'twitter.com',
  'twimg.com',
  'platform.twitter.com',
  't.co',
  'pinterest.com',
  'pinterestads.com',
  'ct.pinterest.com',
  'snapchat.com',
  'sc-static.net',
  'tr.snapchat.com',
  'tiktok.com',
  'tiktokcdn.com',
  'analytics.tiktok.com',
  'vk.com',
  'vk-cdn.net',
  'top-fwz1.mail.ru',
  'mc.yandex.ru',

  // ── Customer messaging & chat widgets ──
  'intercom.io',
  'intercomcdn.com',
  'widget.intercom.io',
  'api-iam.intercom.io',
  'js.intercomcdn.com',
  'drift.com',
  'drift-api.com',
  'js.driftt.com',
  'zendesk.com',
  'zdassets.com',
  'static.zdassets.com',
  'ekr.zdassets.com',
  'livechatinc.com',
  'livechat.com',
  'cdn.livechatinc.com',
  'olark.com',
  'tawk.to',
  'embed.tawk.to',
  'crisp.chat',
  'client.crisp.chat',
  'freshdesk.com',
  'freshchat.com',
  'widget.freshworks.com',
  'helpscout.net',
  'beacon-v2.helpscout.net',

  // ── Marketing automation ──
  'hubspot.com',
  'hs-scripts.com',
  'hsappstatic.net',
  'hs-banner.com',
  'hsadspixel.net',
  'hsforms.com',
  'js.hs-analytics.net',
  'marketo.com',
  'marketo.net',
  'mktoresp.com',
  'pardot.com',
  'pardot.net',
  'pi.pardot.com',
  'mailchimp.com',
  'chimpstatic.com',
  'list-manage.com',

  // ── A/B testing & optimization ──
  'optimizely.com',
  'optimizelyapis.com',
  'cdn.optimizely.com',
  'vwo.com',
  'wingify.com',
  'dev.visualwebsiteoptimizer.com',
  'convert.com',
  'convertapi.com',
  'unbounce.com',
  'unbouncepages.com',
  'launchdarkly.com',
  'app.launchdarkly.com',
  'split.io',

  // ── APM & monitoring ──
  'datadoghq.com',
  'datadoghq.net',
  'browser-intake-datadoghq.com',
  'newrelic.com',
  'nr-data.net',
  'js-agent.newrelic.com',
  'bam.nr-data.net',
  'dynatrace.com',
  'dynatrace-managed.com',
  'appdynamics.com',
  'rum-static.pingdom.net',
  'rum-collector-2.pingdom.net',
  'speedcurve.com',

  // ── Other analytics ──
  'adobe.com',
  'omniture.com',
  '2o7.net',
  'demdex.net',
  'adobedtm.com',
  'assets.adobedtm.com',
  'cloudflareinsights.com',
  'static.cloudflareinsights.com',
  // Vercel Analytics — most common same-origin tracker on the modern
  // React/Next.js web. Both the CDN (va.vercel-scripts.com) and the
  // ingestion endpoint (vitals.vercel-insights.com) need blocking;
  // additionally /_vercel/insights/* on the SAME origin is handled by
  // the path-based filter in network-tracker.ts.
  'vercel-insights.com',
  'vitals.vercel-insights.com',
  'va.vercel-scripts.com',
  'vercel-analytics.com',
  'yandex.ru',
  'yandex.net',
  'metrica.yandex.ru',
  'mc.yandex.com',
  'baidu.com',
  'hm.baidu.com',
  'matomo.org',
  'piwik.pro',
  'plausible.io',
  'fathomanalytics.com',
  'usefathom.com',
  'simpleanalytics.com',
  'clicky.com',
  'in.getclicky.com',
  'statcounter.com',
  'gosquared.com',
  'chartbeat.com',
  'static.chartbeat.com',
  'parsely.com',
  'cdn.parsely.com',
  'quantserve.com',
  'pixel.quantserve.com',
  'scorecardresearch.com',
  'sb.scorecardresearch.com',

  // ── Lead generation & enrichment ──
  'clearbit.com',
  'clearbitstatic.com',
  'x.clearbitjs.com',
  '6sense.com',
  'demandbase.com',
  'leadfeeder.com',
  'bat.bing.com',

  // ── Consent management ──
  'cookiebot.com',
  'consent.cookiebot.com',
  'consentmanager.net',
  'onetrust.com',
  'cdn.cookielaw.org',
  'trustarc.com',
  'consent.trustarc.com',

  // ── Push notifications ──
  'onesignal.com',
  'cdn.onesignal.com',
  'pushwoosh.com',
  'pushcrew.com',
  'webpushr.com',
] as const;

/**
 * Builds a regex pattern that matches any URL containing one of the blocked domains.
 * Cached for performance.
 */
let _domainRegex: RegExp | null = null;
function getDomainRegex(): RegExp {
  if (!_domainRegex) {
    // Escape dots and build alternation: (google-analytics\.com|sentry\.io|...)
    const escaped = THIRD_PARTY_DOMAINS.map(d => d.replace(/\./g, '\\.'));
    _domainRegex = new RegExp(`(${escaped.join('|')})`, 'i');
  }
  return _domainRegex;
}

/**
 * Check if a URL belongs to a third-party domain.
 * Uses hostname extraction for accuracy (avoids false positives in path).
 */
export function isThirdPartyUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return THIRD_PARTY_DOMAINS.some(domain => hostname.endsWith(domain));
  } catch {
    // Fallback to regex for malformed URLs
    return getDomainRegex().test(url);
  }
}

/**
 * Stats for blocked requests (useful for logging/debugging)
 */
export interface BlockerStats {
  totalBlocked: number;
  blockedByDomain: Map<string, number>;
}

/**
 * Registers page.route() handlers that abort requests to third-party domains.
 *
 * This MUST be called after page creation and BEFORE navigation.
 * Aborted requests are never counted by Playwright's networkidle detection,
 * which means waitForNavigation() and waitForLoadState('networkidle') will
 * complete as soon as the actual site content is loaded.
 *
 * @param page - Playwright Page object
 * @param options - Configuration options
 * @returns Cleanup function + stats accessor
 */
export async function setupThirdPartyBlocker(
  page: Page,
  options?: {
    /** Additional domains to block (on top of the default list) */
    extraDomains?: string[];
    /** Log each blocked request (default: false, noisy) */
    verbose?: boolean;
    /** Whether to actually abort (default: true). Set false for dry-run/logging only. */
    abort?: boolean;
  }
): Promise<{
  /** Call to unregister all route handlers */
  cleanup: () => Promise<void>;
  /** Get current blocking stats */
  getStats: () => BlockerStats;
}> {
  const verbose = options?.verbose ?? false;
  const shouldAbort = options?.abort ?? true;

  // Build the combined domain set
  const allDomains = new Set<string>(THIRD_PARTY_DOMAINS);
  if (options?.extraDomains) {
    for (const d of options.extraDomains) {
      allDomains.add(d);
    }
  }

  // Stats tracking
  const stats: BlockerStats = {
    totalBlocked: 0,
    blockedByDomain: new Map(),
  };

  // Route handler: check if URL belongs to a blocked domain, abort if so.
  // Using a single catch-all route pattern is more efficient than registering
  // one route per domain.
  const routeHandler = async (route: Route) => {
    const url = route.request().url();

    let matchedDomain: string | null = null;
    try {
      const hostname = new URL(url).hostname;
      for (const domain of allDomains) {
        if (hostname.endsWith(domain)) {
          matchedDomain = domain;
          break;
        }
      }
    } catch {
      // Fallback for malformed URLs
      for (const domain of allDomains) {
        if (url.includes(domain)) {
          matchedDomain = domain;
          break;
        }
      }
    }

    if (matchedDomain) {
      stats.totalBlocked++;
      const count = stats.blockedByDomain.get(matchedDomain) || 0;
      stats.blockedByDomain.set(matchedDomain, count + 1);

      if (verbose) {
        logger.debug('[THIRD_PARTY_BLOCKER] Blocked request', {
          url: url.substring(0, 200),
          domain: matchedDomain,
          resourceType: route.request().resourceType(),
        });
      }

      if (shouldAbort) {
        try {
          await route.abort('blockedbyclient');
        } catch {
          // Route may already be handled — ignore
        }
        return;
      }
    }

    // Not a blocked domain — continue normally
    try {
      await route.continue();
    } catch {
      // Route may already be handled — ignore
    }
  };

  // Register the catch-all route handler
  await page.route('**/*', routeHandler);

  logger.info('[THIRD_PARTY_BLOCKER] Enabled', {
    totalDomains: allDomains.size,
    extraDomains: options?.extraDomains?.length ?? 0,
  });

  return {
    cleanup: async () => {
      try {
        await page.unroute('**/*', routeHandler);
        logger.info('[THIRD_PARTY_BLOCKER] Disabled', {
          totalBlocked: stats.totalBlocked,
          topDomains: Array.from(stats.blockedByDomain.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([domain, count]) => `${domain}:${count}`),
        });
      } catch {
        // Page may already be closed
      }
    },
    getStats: () => ({ ...stats, blockedByDomain: new Map(stats.blockedByDomain) }),
  };
}
