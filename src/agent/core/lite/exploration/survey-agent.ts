/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SURVEY AGENT — Phase 1: BFS page discovery
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Performs breadth-first traversal of the web application:
 *   1. Navigate to entry URL
 *   2. Collect DOM snapshot + screenshot
 *   3. Call AI (vision model) to classify page and discover entry points
 *   4. Navigate to each main navigation link (BFS)
 *   5. Build ExplorationTree with all discovered flows
 *
 * Two-pass survey:
 *   Pass 1: Public pages (no auth)
 *   Pass 2: Auth-gated pages (if credentials provided + login successful)
 *
 * Safe interactions only: clicks on nav links, NO form submissions.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { SnapshotCollector } from '../collectors/snapshot-collector';
import { SnapshotRouter } from '@/services/testing/ui/preview/snapshot-router.service';
import { VisualStability } from '../collectors/visual-stability';

import type { LiteSnapshot, LiteElement } from '../lite-types';
import type { ExplorationConfig, EntryPoint, NavigationAction, TestFlowCategory, FlowPriority } from './types';
import { ExplorationTree } from './exploration-tree';
import { BudgetTracker } from './budget-tracker';
import { RateLimiter } from './rate-limiter';
import { parsePageClassificationResponse } from './prompts';
import { OverlayDismisser, type OverlayCleanupResult } from './overlay-dismisser';
import type { ExplorationTraceService } from './exploration-trace.service';
import { Cartographer } from './agents/cartographer';
import type { CartographerInput, CartographerOutput } from './agents/agent-types';

/** Max hidden navigation links to follow per page (Cartographer-discovered links have no limit) */
const MAX_NAV_LINKS_PER_PAGE = 15;

/** Timeout for page navigation (ms) */
const NAV_TIMEOUT_MS = 30_000;

/** Max fallback entry points when AI returns 0 (raised from 8 for form-heavy pages) */
const MAX_FALLBACK_ENTRY_POINTS = 20;

/** Max SPA route clicks per page during BFS (raised from 5 for tab-heavy SPAs) */
const MAX_SPA_CLICKS_PER_PAGE = 10;

/** Common login URL patterns */
const LOGIN_URL_PATTERNS = [
  /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth/i,
  /\/log-in/i, /\/sso/i,
];

export class SurveyAgent {
  private tree: ExplorationTree;
  private entryPointCounter: number = 0;
  private readonly cartographer: Cartographer;
  /** Track page types seen for Cartographer exploration context */
  private pageTypesSeen: string[] = [];

  constructor(
    private readonly page: Page,
    private readonly config: ExplorationConfig,
    private readonly budget: BudgetTracker,
    private readonly rateLimiter: RateLimiter,
    private readonly trace?: ExplorationTraceService,
  ) {
    this.tree = new ExplorationTree();
    this.cartographer = new Cartographer(rateLimiter, trace);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get full URL including hash fragment.
   * Playwright's page.url() strips hash — we need window.location.href
   * for hash-routed SPAs (e.g. /#/dashboard, /#/settings).
   */
  private async getFullUrl(): Promise<string> {
    try {
      return await this.page.evaluate(() => (globalThis as any).window.location.href);
    } catch {
      return this.page.url(); // Fallback
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRODUCT CONTEXT COLLECTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Collect high-level product context from the DOM to help Cartographer
   * understand the type of application and discover navigation paths.
   */
  private async collectProductContext(): Promise<string> {
    try {
      const context = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const parts: string[] = [];

        // Document title
        const title = doc.title?.trim();
        if (title) parts.push(`Title: ${title}`);

        // Meta description
        const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim();
        if (metaDesc) parts.push(`Description: ${metaDesc.substring(0, 200)}`);

        // All H1 headings
        const h1s = Array.from(doc.querySelectorAll('h1')).map((h: any) => h.textContent?.trim()).filter((t: any) => t && t.length > 0 && t.length < 100);
        if (h1s.length > 0) parts.push(`H1 headings: ${h1s.slice(0, 5).join(', ')}`);

        // Nav/header links
        const navLinks: string[] = [];
        const navEls = doc.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]');
        navEls.forEach((a: any) => {
          const text = (a.textContent || '').trim();
          const href = a.href || '';
          if (text && text.length > 0 && text.length < 50 && href && !href.startsWith('javascript:') && !href.startsWith('#')) {
            navLinks.push(`${text} (${href})`);
          }
        });
        if (navLinks.length > 0) parts.push(`Navigation links: ${[...new Set(navLinks)].slice(0, 20).join(', ')}`);

        // Prominent buttons (Sign Up, Login, Contact, etc.)
        const prominentButtons: string[] = [];
        const buttons = doc.querySelectorAll('button, [role="button"], a.btn, a.button, .cta');
        buttons.forEach((btn: any) => {
          const text = (btn.textContent || '').trim();
          if (text && text.length > 1 && text.length < 40 && /sign\s*up|log\s*in|register|contact|get\s*started|try|demo|free\s*trial|subscribe|learn\s*more/i.test(text)) {
            prominentButtons.push(text);
          }
        });
        if (prominentButtons.length > 0) parts.push(`Prominent CTAs: ${[...new Set(prominentButtons)].slice(0, 10).join(', ')}`);

        // URL patterns inference
        const path = (globalThis as any).window.location.pathname;
        const origin = (globalThis as any).window.location.origin;
        parts.push(`URL path: ${path}`);
        parts.push(`Origin: ${origin}`);

        return parts.join('\n');
      });
      return context || '';
    } catch (error) {
      logger.debug('[SURVEY] Failed to collect product context', {
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN SURVEY LOOP
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Run the full BFS survey.
   * Returns the completed ExplorationTree with all discovered entry points.
   */
  async survey(): Promise<ExplorationTree> {
    logger.info('[SURVEY] Starting page survey', {
      entryUrl: this.config.entryUrl,
      maxPages: this.config.budget.maxSurveyPages,
    });

    // Navigate to entry URL
    try {
      const canNavigate = await this.rateLimiter.acquireSlot('navigation');
      if (!canNavigate) {
        logger.error('[SURVEY] Target site degraded, cannot navigate to entry URL', {
          url: this.config.entryUrl,
        });
        return this.tree;
      }
      await this.page.goto(this.config.entryUrl, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
      });
      this.rateLimiter.recordSuccess('target_site');
    } catch (error) {
      if (RateLimiter.isRateLimitError(error as Error)) {
        const result = await this.rateLimiter.recordFailure('target_site', error as Error);
        if (result.shouldRetry) {
          try {
            await this.page.goto(this.config.entryUrl, {
              waitUntil: 'load',
              timeout: NAV_TIMEOUT_MS,
            });
            this.rateLimiter.recordSuccess('target_site');
          } catch {
            logger.error('[SURVEY] Failed to navigate to entry URL after retry', {
              url: this.config.entryUrl,
            });
            return this.tree;
          }
        } else {
          logger.error('[SURVEY] Entry URL rate limited, skipping', {
            url: this.config.entryUrl,
            degraded: result.isDegraded,
          });
          return this.tree;
        }
      } else {
        logger.error('[SURVEY] Failed to navigate to entry URL', {
          url: this.config.entryUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return this.tree;
      }
    }

    // Check if we got redirected to a login page
    const isLoginPage = this.isLoginUrl(this.page.url());
    if (isLoginPage && this.config.credentials) {
      logger.info('[SURVEY] Redirected to login page, will handle auth');
      // Survey the login page itself first (it has auth entry points)
    }

    // Pass 1: Survey from current page (BFS)
    await this.bfsSurvey(0, false);

    // Pass 2: If we have credentials and haven't logged in yet,
    // login and survey auth-gated pages
    if (this.config.credentials && !isLoginPage) {
      // Check if there are auth-required entry points
      const authEntryPoints = this.tree.getAllEntryPoints()
        .filter((ep) => ep.category === 'authentication' && ep.priority === 'critical');

      if (authEntryPoints.length > 0) {
        logger.info('[SURVEY] Auth entry points found, Pass 2 will be handled during flow exploration');
      }
    }

    logger.info('[SURVEY] Survey complete', {
      pagesVisited: this.tree.getNodeCount(),
      entryPointsFound: this.tree.getAllEntryPoints().length,
    });

    return this.tree;
  }

  /**
   * Targeted survey: visit specific URLs requested by Strategist.
   * Reuses existing tree for dedup — only visits unvisited URLs.
   */
  async surveyTargets(urls: string[], existingTree: ExplorationTree): Promise<ExplorationTree> {
    this.tree = existingTree;

    for (const url of urls) {
      if (this.tree.isVisited(url) || !this.budget.canSurveyMorePages()) {
        logger.info('[SURVEY] Skipping target (already visited or budget)', { url });
        continue;
      }

      try {
        await this.page.goto(url, {
          waitUntil: 'load',
          timeout: NAV_TIMEOUT_MS,
        });

        // Process this page like bfsSurvey does for a single page
        await this.bfsSurvey(0, false);
      } catch (err) {
        logger.warn('[SURVEY] Targeted survey failed for URL', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.tree;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BFS TRAVERSAL
  // ═══════════════════════════════════════════════════════════════════════

  private async bfsSurvey(startDepth: number, isAuthZone: boolean): Promise<void> {
    // BFS queue: [url, depth, parentNodeId]
    const queue: Array<{
      url: string;
      depth: number;
      parentNodeId: string | null;
      navAction: NavigationAction | null;
    }> = [{
      url: this.page.url(),
      depth: startDepth,
      parentNodeId: null,
      navAction: null,
    }];

    // Track URLs already in queue to prevent duplicate enqueue before they are visited
    const enqueuedUrls: Set<string> = new Set([this.page.url()]);

    while (queue.length > 0 && this.budget.canSurveyMorePages()) {
      const item = queue.shift()!;

      // Skip if already visited
      if (this.tree.isVisited(item.url)) {
        this.trace?.writePageDedupSkipped({ url: item.url, reason: 'same_url' });
        continue;
      }

      this.trace?.writePageNavigate({ url: item.url, depth: item.depth, fromUrl: item.parentNodeId ? this.page.url() : undefined });

      // Navigate to the page (unless we're already there)
      if (this.page.url() !== item.url) {
        try {
          const canNavigate = await this.rateLimiter.acquireSlot('navigation');
          if (!canNavigate) {
            logger.warn('[SURVEY] Target site degraded, skipping page', { url: item.url });
            await this.budget.recordPageSurvey();
            continue;
          }
          await this.page.goto(item.url, {
            waitUntil: 'load',
            timeout: NAV_TIMEOUT_MS,
          });
          this.rateLimiter.recordSuccess('target_site');
        } catch (error) {
          if (RateLimiter.isRateLimitError(error as Error)) {
            const result = await this.rateLimiter.recordFailure('target_site', error as Error);
            if (result.shouldRetry) {
              try {
                await this.page.goto(item.url, {
                  waitUntil: 'load',
                  timeout: NAV_TIMEOUT_MS,
                });
                this.rateLimiter.recordSuccess('target_site');
              } catch (retryError) {
                logger.warn('[SURVEY] Failed to navigate after retry', {
                  url: item.url,
                  error: retryError instanceof Error ? retryError.message : String(retryError),
                });
                await this.budget.recordPageSurvey();
                continue;
              }
            } else {
              logger.warn('[SURVEY] Navigation rate limited, skipping page', {
                url: item.url,
                degraded: result.isDegraded,
              });
              await this.budget.recordPageSurvey();
              continue;
            }
          } else {
            logger.warn('[SURVEY] Failed to navigate', {
              url: item.url,
              error: error instanceof Error ? error.message : String(error),
            });

            // Add error node
            this.tree.addNode({
              url: item.url,
              title: 'Navigation Error',
              pageType: 'error',
              snapshot: { url: item.url, title: '', elements: [], timestamp: Date.now() },
              entryPoints: [],
              depth: item.depth,
              requiresAuth: false,
              error: error instanceof Error ? error.message : String(error),
            });

            await this.budget.recordPageSurvey();
            continue;
          }
        }
      }

      // Wait for network + DOM + loading state before snapshot
      try {
        await VisualStability.waitForPageReady(this.page, { timeout: 5000 });
      } catch {
        // Non-fatal
      }

      // Dismiss overlays (cookie consent, promo modals, etc.) BEFORE snapshot
      let overlayCleanupResult: OverlayCleanupResult | null = null;
      try {
        overlayCleanupResult = await OverlayDismisser.dismissOverlays(this.page, {
          maxPasses: 3,
          maxTimeMs: 8000,
          mode: 'survey',
        });
        if (overlayCleanupResult.overlaysDetected > 0) {
          this.trace?.writeOverlayDetected({
            url: item.url,
            mode: 'survey',
            obstacles: overlayCleanupResult.attempts.map(a => ({ ref: a.ref, type: a.obstacleType, zIndex: 0 })),
            count: overlayCleanupResult.overlaysDetected,
          });
          this.trace?.writeOverlayDismissed({
            url: item.url,
            attempts: overlayCleanupResult.attempts,
            durationMs: overlayCleanupResult.durationMs,
          });
          if (overlayCleanupResult.overlaySummary) {
            this.trace?.writeOverlaySummary({ url: item.url, summary: overlayCleanupResult.overlaySummary });
          }
          logger.info('[SURVEY] Overlay cleanup completed', {
            url: item.url,
            detected: overlayCleanupResult.overlaysDetected,
            dismissed: overlayCleanupResult.attempts.filter(a => a.dismissed).length,
            durationMs: overlayCleanupResult.durationMs,
          });
        }
      } catch (error) {
        logger.warn('[SURVEY] Overlay cleanup failed (non-fatal)', {
          url: item.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Collect snapshot (with scroll to trigger lazy-loaded content)
      // If overlay dismisser returned a clean snapshot, use it as base to avoid double collection
      let snapshot;
      try {
        snapshot = await this.collectFullSnapshot();

        // SPA fallback: if snapshot is empty, wait for React/Vue/Angular hydration and retry
        if (snapshot.elements.length === 0) {
          logger.info('[SURVEY] Empty snapshot — waiting for SPA hydration', { url: item.url });
          await this.page.waitForTimeout(2000);
          await VisualStability.waitForStable(this.page, { checkInterval: 200, maxAttempts: 5 });
          snapshot = await this.collectFullSnapshot();
          logger.info('[SURVEY] SPA retry snapshot', {
            url: item.url,
            elementCount: snapshot.elements.length,
          });
        }
      } catch (error) {
        logger.warn('[SURVEY] Failed to collect snapshot', {
          url: item.url,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.budget.recordPageSurvey();
        continue;
      }

      // Check for same-template page (pagination/lists)
      if (item.parentNodeId && this.tree.registerAndCheckSameTemplate(item.parentNodeId, snapshot)) {
        this.trace?.writePageDedupSkipped({ url: item.url, reason: 'same_template' });
        logger.debug('[SURVEY] Skipping same-template page', { url: item.url });
        continue;
      }

      // Check for SPA content dedup
      if (this.tree.isContentVisited(snapshot)) {
        this.trace?.writePageDedupSkipped({ url: item.url, reason: 'same_content' });
        logger.debug('[SURVEY] Skipping duplicate content page', { url: item.url });
        continue;
      }

      // Format snapshot for AI
      const formattedSnapshot = SnapshotCollector.format(snapshot);

      this.trace?.writePageSnapshot({
        url: item.url,
        elementCount: snapshot.elements.length,
        interactiveCount: snapshot.elements.filter(e =>
          ['textbox', 'button', 'link', 'checkbox', 'combobox', 'radio', 'menuitem', 'tab', 'switch', 'slider', 'spinbutton'].includes(e.role) ||
          ['input', 'textarea', 'select', 'a', 'button'].includes(e.tag),
        ).length,
        hasScreenshot: false, // updated below
      });

      // Take screenshot for vision (fullPage for better context, with size fallback)
      let screenshotBase64: string | undefined;
      try {
        let screenshotBuffer = await this.page.screenshot({ type: 'png', fullPage: true });
        // If fullPage screenshot is >2MB, fall back to viewport-only
        if (screenshotBuffer.length > 2 * 1024 * 1024) {
          logger.debug('[SURVEY] Full-page screenshot too large, falling back to viewport', {
            url: item.url,
            sizeBytes: screenshotBuffer.length,
          });
          screenshotBuffer = await this.page.screenshot({ type: 'png', fullPage: false });
        }
        screenshotBase64 = screenshotBuffer.toString('base64');
      } catch (error) {
        logger.warn('[SURVEY] Failed to take screenshot', {
          url: item.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Collect page health signals (console errors + failed network requests)
      let pageHealth: string | undefined;
      try {
        const health = await this.page.evaluate(`
          (() => {
            const parts = [];
            // Check for visible error elements on page
            const errorEls = document.querySelectorAll(
              '[role="alert"], .error, .alert-danger, [class*="error-message"]'
            );
            const errorTexts = [];
            errorEls.forEach(el => {
              const text = el.innerText && el.innerText.trim();
              if (text && text.length > 0 && text.length < 150) errorTexts.push(text);
            });
            if (errorTexts.length > 0) {
              parts.push('Visible errors: ' + [...new Set(errorTexts)].slice(0, 3).map(t => '"' + t + '"').join(', '));
            }
            // Check document readyState
            if (document.readyState !== 'complete') {
              parts.push('Page still loading (readyState: ' + document.readyState + ')');
            }
            return parts.length > 0 ? parts.join('. ') : null;
          })()
        `) as string | null;
        if (health) pageHealth = health;
      } catch {
        // Non-critical
      }

      // AI classification via Cartographer agent
      const classification = await this.classifyWithCartographer(
        formattedSnapshot,
        screenshotBase64,
        this.page.url(),
        await this.page.title(),
        item.depth,
        snapshot,
        overlayCleanupResult?.overlaySummary ?? undefined,
      );

      // Log discovered entry points & nav links
      if (classification.entryPoints.length > 0) {
        this.trace?.writeEntryPointsDiscovered({
          url: this.page.url(),
          entryPoints: classification.entryPoints.map(ep => ({
            name: ep.name, category: ep.category, priority: ep.priority,
          })),
          count: classification.entryPoints.length,
        });
      }
      if (classification.navigationLinks.length > 0) {
        this.trace?.writeNavLinksDiscovered({
          url: this.page.url(),
          links: classification.navigationLinks.map(l => ({
            ref: l.ref, label: l.label,
          })),
          count: classification.navigationLinks.length,
        });
      }

      // Create entry points with unique IDs
      const entryPoints: EntryPoint[] = classification.entryPoints.map((ep) => ({
        ...ep,
        id: `ep-${this.entryPointCounter++}`,
        sourceNodeId: '', // Will be set after node creation
        sourcePageUrl: this.page.url(),
        requiresAuth: ep.requiresAuth || isAuthZone,
      }));

      // Add node to tree
      const nodeId = this.tree.addNode({
        url: this.page.url(),
        title: await this.page.title(),
        pageType: classification.pageType,
        snapshot,
        entryPoints,
        depth: item.depth,
        requiresAuth: isAuthZone || this.isLoginUrl(this.page.url()),
      });

      if (nodeId) {
        // Update sourceNodeId on entry points
        for (const ep of entryPoints) {
          ep.sourceNodeId = nodeId;
        }

        // Add edge from parent
        if (item.parentNodeId && item.navAction) {
          this.tree.addEdge(item.parentNodeId, nodeId, item.navAction);
        }

        await this.budget.recordPageSurvey();

        // Emit page_discovered event for real-time frontend update
        this.config.onProgress?.({
          explorationId: this.config.explorationId,
          phase: 'survey',
          event: 'page_discovered',
          data: {
            pageId: nodeId,
            url: this.page.url(),
            title: await this.page.title(),
            pageType: classification.pageType,
            entryPointsFound: entryPoints.length,
            depth: item.depth,
            parentPageId: item.parentNodeId,
            isAuthGated: isAuthZone || false,
            isLoginPage: this.isLoginUrl(this.page.url()),
            complexity: 'medium',
          },
          progressPercent: 0,
          timestamp: Date.now(),
        });

        // Enqueue navigation links (BFS children) — no hardcoded cap, AI decides relevance
        const navLinks = classification.navigationLinks;
        for (const link of navLinks) {
          // Resolve link URL from element ref
          const linkUrl = await this.resolveLinkUrl(link.ref, snapshot);
          if (linkUrl && this.isSameOrigin(linkUrl)) {
            // Register ALL discovered nav links so Strategist can see unvisited ones
            this.tree.registerNavLink(linkUrl, link.label, this.page.url());

            if (!this.tree.isVisited(linkUrl) && !enqueuedUrls.has(linkUrl)) {
              enqueuedUrls.add(linkUrl);
              queue.push({
                url: linkUrl,
                depth: item.depth + 1,
                parentNodeId: nodeId,
                navAction: {
                  type: 'click_link',
                  ref: link.ref,
                  label: link.label,
                  targetUrl: linkUrl,
                },
              });
            }
          }
        }

        // Hidden content discovery (exploration-only)
        const hiddenDomLinks = await this.harvestHiddenLinks();
        const hiddenNavLinks = await this.discoverHiddenNavigation(snapshot);

        if (hiddenDomLinks.length > 0) {
          this.trace?.writeHiddenNavDiscovered({
            url: this.page.url(), source: 'dom_harvest', linksFound: hiddenDomLinks.length,
          });
        }
        if (hiddenNavLinks.length > 0) {
          this.trace?.writeHiddenNavDiscovered({
            url: this.page.url(), source: 'menu_click', linksFound: hiddenNavLinks.length,
          });
        }

        const allHiddenLinks = [...hiddenDomLinks, ...hiddenNavLinks].slice(0, MAX_NAV_LINKS_PER_PAGE);
        for (const link of allHiddenLinks) {
          if (!this.tree.isVisited(link.url) && !enqueuedUrls.has(link.url) && this.isSameOrigin(link.url)) {
            enqueuedUrls.add(link.url);
            queue.push({
              url: link.url,
              depth: item.depth + 1,
              parentNodeId: nodeId,
              navAction: { type: 'click_link', label: link.label, targetUrl: link.url },
            });
          }
        }

        // SPA navigation: click elements that may trigger client-side route changes
        await this.discoverSpaRoutes(snapshot, queue, item, nodeId, enqueuedUrls);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCROLL-AWARE SNAPSHOT COLLECTION (lazy-loaded content detection)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Collect snapshot with progressive scrolling to trigger lazy-loaded content.
   * Scrolls down in viewport-sized chunks, collects new elements at each position,
   * and merges unique elements into a single snapshot.
   */
  private async collectFullSnapshot(): Promise<LiteSnapshot> {
    // First snapshot at current scroll position
    const initialSnapshot = await SnapshotRouter.collect(this.page, { context: 'exploration-survey', fullPage: true });

    // Check if page is scrollable
    let scrollHeight: number;
    let viewportHeight: number;
    try {
      scrollHeight = await this.page.evaluate(() => (globalThis as any).document.documentElement.scrollHeight);
      viewportHeight = await this.page.evaluate(() => (globalThis as any).window.innerHeight);
    } catch {
      return initialSnapshot;
    }

    // Not scrollable or very short → return initial snapshot
    if (scrollHeight <= viewportHeight * 1.5) return initialSnapshot;

    // Progressive scroll: up to 3 scroll steps
    const MAX_SCROLLS = 3;
    const allElements = new Map<string, LiteElement>(); // ref → element (dedup)

    for (const el of initialSnapshot.elements) {
      allElements.set(el.ref, el);
    }

    let prevElementCount = allElements.size;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      // Scroll down
      try {
        await this.page.evaluate(() => {
          const w = (globalThis as any).window;
          w.scrollBy(0, w.innerHeight * 0.8);
        });
        await VisualStability.waitForStable(this.page, { checkInterval: 150, maxAttempts: 5 }); // Smart wait for lazy-loaded content
      } catch {
        break;
      }

      // Check if URL changed (scroll triggered navigation)
      if (this.page.url() !== initialSnapshot.url) {
        try {
          await this.page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
        } catch { /* ignore */ }
        break;
      }

      // Collect new elements
      try {
        const scrollSnapshot = await SnapshotRouter.collect(this.page, { context: 'exploration-survey', fullPage: true });
        for (const el of scrollSnapshot.elements) {
          if (!allElements.has(el.ref)) {
            allElements.set(el.ref, el);
          }
        }

        // Check for scroll-triggered overlays (exit-intent, newsletter popups)
        try {
          const scrollObstacles = scrollSnapshot.obstacleFacts ?? [];
          const hasBlockingOverlay = scrollObstacles.some(f =>
            f.coverage > 0.2 || f.hintType === 'modal' || f.hintType === 'cookie_consent',
          );
          if (hasBlockingOverlay) {
            logger.debug('[SURVEY] Scroll-triggered overlay detected, dismissing', {
              obstacleCount: scrollObstacles.length,
            });
            await OverlayDismisser.dismissOverlays(this.page, {
              maxPasses: 1,
              maxTimeMs: 2000,
              mode: 'survey',
            });
            // Re-collect after dismissal to get clean elements
            const cleanScrollSnapshot = await SnapshotRouter.collect(this.page, { context: 'exploration-survey', fullPage: true });
            for (const el of cleanScrollSnapshot.elements) {
              if (!allElements.has(el.ref)) {
                allElements.set(el.ref, el);
              }
            }
          }
        } catch {
          // Non-fatal: continue scrolling even if overlay handling fails
        }
      } catch {
        break;
      }

      // No new elements → stop scrolling
      if (allElements.size === prevElementCount) break;
      prevElementCount = allElements.size;
    }

    // Click "Load More" / "Show More" buttons to reveal additional content (max 2 clicks)
    const LOAD_MORE_MAX_CLICKS = 2;
    for (let lmClick = 0; lmClick < LOAD_MORE_MAX_CLICKS; lmClick++) {
      try {
        // Find a visible "Load More" button in the DOM
        const loadMoreRef = await this.page.evaluate(() => {
          const doc = (globalThis as any).document;
          const win = (globalThis as any).window;
          const candidates = doc.querySelectorAll('button, a, [role="button"]');
          for (const el of candidates) {
            const text = ((el as any).textContent || '').trim();
            if (
              /^(load\s*more|show\s*more|see\s*more|view\s*all|view\s*more|загрузить\s*ещ[её]|показать\s*ещ[её]|көбірек)$/i.test(text) &&
              text.length < 30
            ) {
              const style = win.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                return (el as any).getAttribute('data-agent-ref') || null;
              }
            }
          }
          return null;
        });

        if (!loadMoreRef) break;

        logger.debug('[SURVEY] Clicking "Load More" button', { ref: loadMoreRef, click: lmClick + 1 });
        await this.page.locator(`[data-agent-ref="${loadMoreRef}"]`).click({ timeout: 2000 });
        await VisualStability.waitForPageReady(this.page, { timeout: 3000 }); // Network + DOM + loading

        // Navigation guard: if URL changed (including hash), go back and stop
        if (await this.getFullUrl() !== initialSnapshot.url) {
          await this.page.goBack({ timeout: 5000 }).catch(() => {});
          await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 3 });
          break;
        }

        // Collect new elements after Load More
        const lmSnapshot = await SnapshotRouter.collect(this.page, { context: 'exploration-survey', fullPage: true });
        let addedNew = false;
        for (const el of lmSnapshot.elements) {
          if (!allElements.has(el.ref)) {
            allElements.set(el.ref, el);
            addedNew = true;
          }
        }
        if (!addedNew) break; // No new content → stop

        // Dismiss overlays that may have appeared after loading more content
        try {
          const lmObstacles = lmSnapshot.obstacleFacts ?? [];
          if (lmObstacles.some(f => f.coverage > 0.2 || f.hintType === 'modal')) {
            await OverlayDismisser.dismissOverlays(this.page, {
              maxPasses: 1,
              maxTimeMs: 2000,
              mode: 'survey',
            });
          }
        } catch {
          // Non-fatal
        }
      } catch {
        // Non-fatal: stop Load More attempts on any error
        break;
      }
    }

    // Scroll back to top
    try {
      await this.page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
      await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 3 });
    } catch { /* ignore */ }

    // Return merged snapshot
    return {
      ...initialSnapshot,
      elements: Array.from(allElements.values()),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CARTOGRAPHER AGENT — AI-driven page classification (v2)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify a page using the Cartographer agent.
   * Falls back to heuristic buildFallbackEntryPoints() if Cartographer returns empty.
   */
  private async classifyWithCartographer(
    formattedSnapshot: string,
    screenshotBase64: string | undefined,
    url: string,
    title: string,
    depth: number,
    snapshot?: LiteSnapshot,
    overlaySummary?: string,
  ): Promise<ReturnType<typeof parsePageClassificationResponse>> {
    // Build Cartographer input with exploration context
    const categoriesSeen = [...new Set(this.pageTypesSeen)];
    const recentPageTypes = this.pageTypesSeen.slice(-3);

    // Collect product context from DOM for richer AI understanding
    const productContext = await this.collectProductContext();

    const cartographerInput: CartographerInput = {
      url,
      title,
      snapshot: snapshot || ({} as LiteSnapshot),
      screenshot: screenshotBase64,
      scopeHint: this.config.scopeHint,
      hasCredentials: !!this.config.credentials,
      depth,
      explorationContext: {
        pagesVisited: this.tree.getNodeCount(),
        categoriesSeen,
        entryPointsSoFar: this.tree.getAllEntryPoints().length,
        recentPageTypes,
      },
      overlaysDismissed: overlaySummary ? [overlaySummary] : undefined,
      productContext: productContext || undefined,
    };

    const result = await this.cartographer.analyze(cartographerInput, formattedSnapshot);

    // Track page type for future context
    this.pageTypesSeen.push(result.pageType);

    // Store auth detection in tree metadata
    if (result.authDetection.isLoginPage && result.authDetection.loginUrl) {
      // Auth detection available for Strategist via blackboard
      logger.info('[SURVEY] Cartographer detected login page', {
        url,
        loginFormRef: result.authDetection.loginFormRef,
      });
    }

    // If Cartographer returned entry points, use them
    if (result.entryPoints.length > 0 || result.navigationLinks.length > 0) {
      return {
        pageType: result.pageType,
        entryPoints: result.entryPoints.map((ep) => ({
          name: ep.name,
          goal: ep.goal,
          category: ep.category,
          priority: ep.priority,
          requiresAuth: ep.requiresAuth,
          estimatedComplexity: ep.estimatedComplexity,
          relatedElements: ep.relatedElements,
          dependsOn: ep.dependsOn,
        })),
        navigationLinks: result.navigationLinks.map((nl) => ({
          ref: nl.ref,
          label: nl.label,
          estimatedPageType: nl.estimatedPageType,
        })),
      };
    }

    // Fallback: Cartographer returned empty → use heuristic detection
    if (snapshot) {
      const fallbackEntryPoints = this.buildFallbackEntryPoints(snapshot, url);

      // DOM fallback for navigation when Cartographer returns no nav links
      let fallbackNavLinks: Array<{ ref: string; label: string; estimatedPageType: string }> = [];
      try {
        const domNavLinks = await this.page.$$eval(
          'nav a[href], header a[href], [role="navigation"] a[href], footer a[href]',
          (links: any[]) => links.map(a => ({
            href: a.href,
            text: (a.textContent || '').trim().substring(0, 50),
            ref: a.getAttribute('data-agent-ref') || '',
          })).filter(l => l.href && l.text && !l.href.startsWith('javascript:') && !l.href.startsWith('#') && l.ref),
        );
        // Register discovered nav link URLs in the tree so Strategist knows about them
        for (const l of domNavLinks) {
          if (l.href && this.isSameOrigin(l.href)) {
            this.tree.registerNavLink(l.href, l.text, url);
          }
        }
        fallbackNavLinks = domNavLinks.slice(0, MAX_NAV_LINKS_PER_PAGE).map(l => ({
          ref: l.ref,
          label: l.text,
          estimatedPageType: 'other',
        }));
        if (fallbackNavLinks.length > 0) {
          logger.info('[SURVEY] DOM fallback navigation links found', {
            url,
            count: fallbackNavLinks.length,
          });
        }
      } catch {
        // Non-fatal: DOM nav fallback is best-effort
      }

      if (fallbackEntryPoints.length > 0 || fallbackNavLinks.length > 0) {
        this.trace?.writePageClassificationFallback({
          url,
          reason: 'cartographer_returned_empty',
          entryPointCount: fallbackEntryPoints.length,
        });
        return {
          pageType: result.pageType || this.inferPageTypeFromUrl(url),
          entryPoints: fallbackEntryPoints,
          navigationLinks: fallbackNavLinks,
        };
      }
    }

    return {
      pageType: result.pageType || 'unknown',
      entryPoints: [],
      navigationLinks: [],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve the URL that a link element points to.
   */
  private async resolveLinkUrl(ref: string, snapshot: any): Promise<string | null> {
    const element = snapshot.elements?.find((el: any) => el.ref === ref);
    if (!element) return null;

    // 1. Direct href from snapshot (for <a> elements)
    if (element.href) return element.href;

    // 2. Evaluate via data-agent-ref (for SPA router links)
    try {
      const href = await this.page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (elRef: string) => {
          const el = (globalThis as any).document?.querySelector(`[data-agent-ref="${elRef}"]`);
          if (!el) return null;
          if (el.href) return el.href as string;
          const anchor = el.closest?.('a');
          return anchor?.href || null;
        },
        ref,
      );
      if (href) return href;
    } catch { /* ignore */ }

    return null;
  }

  /**
   * Check if a URL is same-origin as the entry URL.
   */
  private isSameOrigin(url: string): boolean {
    try {
      const entryOrigin = new URL(this.config.entryUrl).origin;
      const testOrigin = new URL(url).origin;
      return entryOrigin === testOrigin;
    } catch {
      return false;
    }
  }

  /**
   * Check if a URL looks like a login page.
   */
  private isLoginUrl(url: string): boolean {
    return LOGIN_URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  /**
   * Infer page type from URL patterns (fallback when AI fails).
   */
  private inferPageTypeFromUrl(url: string): string {
    const path = new URL(url).pathname.toLowerCase();
    if (LOGIN_URL_PATTERNS.some((p) => p.test(path))) return 'login';
    if (/register|signup|sign-up/i.test(path)) return 'registration';
    if (/dashboard/i.test(path)) return 'dashboard';
    if (/product|item|catalog/i.test(path)) return 'product_list';
    if (/cart|basket/i.test(path)) return 'cart';
    if (/checkout|payment/i.test(path)) return 'checkout';
    if (/setting|preference/i.test(path)) return 'settings';
    if (/profile|account/i.test(path)) return 'profile';
    if (/search/i.test(path)) return 'search';
    if (/contact/i.test(path)) return 'contact';
    if (/about/i.test(path)) return 'about';
    if (/admin/i.test(path)) return 'admin';
    if (/api|docs|documentation/i.test(path)) return 'documentation';
    if (/faq|help|support/i.test(path)) return 'support';
    if (/blog|article|post|news/i.test(path)) return 'blog';
    if (/pricing|plan/i.test(path)) return 'pricing';
    if (path === '/' || path === '') return 'home';
    return 'other';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPA NAVIGATION DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Detect SPA route elements: framework-bound click handlers that look like
   * navigation but have no href (React Router <Link>, Vue <router-link>, etc.).
   */
  private findSpaRouteElements(snapshot: LiteSnapshot): LiteElement[] {
    return snapshot.elements.filter(el =>
      el.visible &&
      !el.disabled &&
      // Framework-bound click handlers or explicit onclick
      (el.frameworkClickable || el.hasOnclick) &&
      // Looks like navigation (link-like role or nav context)
      (el.role === 'link' || el.role === 'tab' || el.role === 'menuitem' ||
       (el.tag === 'a' && !el.href)) && // <a> without href = SPA link
      // Not a form submit
      !/submit/i.test(el.type || '') &&
      // Not already followed via URL-based BFS
      !el.href
    ).slice(0, MAX_SPA_CLICKS_PER_PAGE);
  }

  /**
   * Click SPA route elements to discover content changes without URL changes.
   * Adds newly discovered pages (by content hash) to the BFS queue.
   */
  private async discoverSpaRoutes(
    snapshot: LiteSnapshot,
    queue: Array<{ url: string; depth: number; parentNodeId: string | null; navAction: NavigationAction | null }>,
    item: { url: string; depth: number },
    nodeId: string,
    enqueuedUrls?: Set<string>,
  ): Promise<void> {
    const spaElements = this.findSpaRouteElements(snapshot);
    if (spaElements.length === 0) return;

    logger.debug('[SURVEY] Checking SPA route elements', {
      url: item.url,
      count: spaElements.length,
    });

    for (const el of spaElements) {
      if (!this.budget.canSurveyMorePages()) break;

      const canProceed = await this.rateLimiter.acquireSlot('navigation');
      if (!canProceed) break;

      const urlBefore = await this.getFullUrl(); // Use full URL to detect hash changes
      const contentHashBefore = this.tree.computeContentHashPublic(snapshot);

      try {
        await this.page.locator(`[data-agent-ref="${el.ref}"]`).click({ timeout: 3000 });
        await VisualStability.waitForPageReady(this.page, { timeout: 3000 }); // Network + DOM + loading

        const urlAfter = await this.getFullUrl(); // Use full URL to detect hash changes

        // Case 1: URL changed (including hash changes like #/route) → queue for BFS, go back
        if (urlAfter !== urlBefore) {
          this.rateLimiter.recordSuccess('target_site');
          if (!this.tree.isVisited(urlAfter) && !enqueuedUrls?.has(urlAfter) && this.isSameOrigin(urlAfter)) {
            enqueuedUrls?.add(urlAfter);
            queue.push({
              url: urlAfter,
              depth: item.depth + 1,
              parentNodeId: nodeId,
              navAction: { type: 'click_button', ref: el.ref, label: el.name || 'SPA link' },
            });
          }
          await this.page.goBack({ timeout: 5000 }).catch(() => {});
          await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 4 });
          continue;
        }

        // Case 2: URL same but content changed → SPA route, treat as new page
        const newSnapshot = await SnapshotRouter.collect(this.page, { context: 'exploration-survey', fullPage: true });
        const contentHashAfter = this.tree.computeContentHashPublic(newSnapshot);

        if (contentHashAfter !== contentHashBefore && !this.tree.isContentHashVisited(contentHashAfter)) {
          this.rateLimiter.recordSuccess('target_site');
          logger.info('[SURVEY] SPA content change detected', {
            element: el.name || el.ref,
            url: urlBefore,
          });

          // Classify and add as virtual page
          const formattedSnapshot = SnapshotCollector.format(newSnapshot);
          let screenshotBase64: string | undefined;
          try {
            const buf = await this.page.screenshot({ type: 'png', fullPage: false });
            screenshotBase64 = buf.toString('base64');
          } catch { /* ignore */ }

          const classification = await this.classifyWithCartographer(
            formattedSnapshot,
            screenshotBase64,
            urlBefore,
            await this.page.title(),
            item.depth + 1,
            newSnapshot,
          );

          const entryPoints: EntryPoint[] = classification.entryPoints.map((ep) => ({
            ...ep,
            id: `ep-${this.entryPointCounter++}`,
            sourceNodeId: '',
            sourcePageUrl: urlBefore,
            requiresAuth: ep.requiresAuth,
          }));

          // Use a virtual URL to prevent dedup collision with the parent page
          const virtualUrl = `${urlBefore}#spa-${el.ref}`;
          const spaNodeId = this.tree.addNode({
            url: virtualUrl,
            title: await this.page.title(),
            pageType: classification.pageType,
            snapshot: newSnapshot,
            entryPoints,
            depth: item.depth + 1,
            requiresAuth: false,
          });

          if (spaNodeId) {
            for (const ep of entryPoints) {
              ep.sourceNodeId = spaNodeId;
            }
            this.tree.addEdge(nodeId, spaNodeId, {
              type: 'click_button',
              ref: el.ref,
              label: el.name || 'SPA route',
            });
            await this.budget.recordPageSurvey();
          }
        }

        // Navigate back (goBack or reload the original page)
        await this.page.goBack({ timeout: 5000 }).catch(() => {});
        await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 4 });
      } catch {
        await this.page.keyboard.press('Escape').catch(() => {});
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HIDDEN CONTENT DISCOVERY (exploration-only)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Read-only DOM query for links inside hidden containers (tabs, accordions, collapsed panels).
   * No clicks, no side effects — purely reads the DOM.
   */
  private async harvestHiddenLinks(): Promise<Array<{ url: string; label: string }>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const links = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const selectors = [
          '[role="tabpanel"][hidden] a[href]',
          '[role="tabpanel"][aria-hidden="true"] a[href]',
          '.tab-pane:not(.active) a[href]',
          'details:not([open]) a[href]',
          '.collapse:not(.show) a[href]',
          '.accordion-collapse:not(.show) a[href]',
          '[aria-hidden="true"] a[href]',
          '[style*="display: none"] a[href]',
          '[style*="display:none"] a[href]',
        ];

        const seen = new Set<string>();
        const results: Array<{ url: string; label: string }> = [];

        for (const sel of selectors) {
          const anchors = doc.querySelectorAll(sel);
          for (const a of anchors) {
            const href = a.href;
            if (!href || href.startsWith('javascript:') || href === '#' || href.endsWith('#')) continue;
            try {
              const normalized = new URL(href).href;
              if (seen.has(normalized)) continue;
              seen.add(normalized);
              results.push({
                url: normalized,
                label: (a.textContent || '').trim().slice(0, 80) || a.getAttribute('aria-label') || '',
              });
            } catch { /* invalid URL */ }
            if (results.length >= 50) return results;
          }
        }

        return results;
      });

      return links;
    } catch (error) {
      logger.warn('[SURVEY] harvestHiddenLinks failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Max toggle triggers to click for hidden navigation discovery */
  private static readonly MAX_HIDDEN_TRIGGERS = 5;
  /** Timeout per trigger interaction */
  private static readonly TRIGGER_INTERACTION_TIMEOUT_MS = 2000;

  /**
   * Click safe toggle elements (hamburger menus, dropdowns with aria-expanded)
   * to reveal hidden navigation links. Includes navigation guard and cleanup.
   */
  private async discoverHiddenNavigation(snapshot: LiteSnapshot): Promise<Array<{ url: string; label: string }>> {
    const triggers = snapshot.elements.filter(el =>
      (el.ariaExpanded === false || el.hasAriaHaspopup === true) &&
      !['input', 'select', 'textarea'].includes(el.tag) &&
      !/submit/i.test(el.type || '') &&
      !el.disabled,
    );

    const candidates = triggers.slice(0, SurveyAgent.MAX_HIDDEN_TRIGGERS);
    const results: Array<{ url: string; label: string }> = [];
    const seen = new Set<string>();
    const urlBefore = await this.getFullUrl(); // Full URL with hash for hash-routed SPAs

    for (const trigger of candidates) {
      try {
        const locator = this.page.locator(`[data-agent-ref="${trigger.ref}"]`);

        // Click the trigger
        await locator.click({ timeout: SurveyAgent.TRIGGER_INTERACTION_TIMEOUT_MS });
        await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 4 });

        // Navigation guard: if URL changed (including hash), go back and skip
        if (await this.getFullUrl() !== urlBefore) {
          await this.page.goBack({ timeout: 5000 }).catch(() => {});
          await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 3 });
          continue;
        }

        // Collect revealed links
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const revealedLinks = await this.page.evaluate((ref: string) => {
          const doc = (globalThis as any).document;
          const win = globalThis as any;
          const triggerEl = doc.querySelector(`[data-agent-ref="${ref}"]`);
          if (!triggerEl) return [];

          let container: any = null;

          // Try aria-controls
          const controlsId = triggerEl.getAttribute('aria-controls');
          if (controlsId) {
            container = doc.getElementById(controlsId);
          }

          // Fallback: next sibling element
          if (!container) {
            container = triggerEl.nextElementSibling;
          }

          // Fallback: parent nav
          if (!container) {
            container = triggerEl.closest('nav');
          }

          if (!container) return [];

          const anchors = container.querySelectorAll('a[href]');
          const links: Array<{ url: string; label: string }> = [];

          for (const a of anchors) {
            const href = a.href;
            if (!href || href.startsWith('javascript:') || href === '#' || href.endsWith('#')) continue;
            // Only include visible (revealed) links
            const style = win.getComputedStyle(a);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            try {
              links.push({
                url: new URL(href).href,
                label: (a.textContent || '').trim().slice(0, 80) || a.getAttribute('aria-label') || '',
              });
            } catch { /* invalid URL */ }
          }

          return links;
        }, trigger.ref);

        for (const link of revealedLinks) {
          if (!seen.has(link.url)) {
            seen.add(link.url);
            results.push(link);
          }
        }

        // Close: click again to toggle off, fallback to Escape
        try {
          await locator.click({ timeout: SurveyAgent.TRIGGER_INTERACTION_TIMEOUT_MS });
        } catch {
          await this.page.keyboard.press('Escape');
        }
        await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 3 });
      } catch (error) {
        logger.debug('[SURVEY] discoverHiddenNavigation trigger failed', {
          ref: trigger.ref,
          error: error instanceof Error ? error.message : String(error),
        });
        // Try Escape to clean up any partial state
        await this.page.keyboard.press('Escape').catch(() => {});
        await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 2 });
      }
    }

    // ── Pass 2: Heuristic hamburger detection (non-ARIA) ──────────────────
    // Only run if ARIA triggers yielded fewer than 2 links — avoids redundant
    // work on well-structured sites that already expose menus via aria-expanded.
    if (results.length < 2) {
      try {
        // Find hamburger-like buttons by class/aria-label/icon patterns (browser-side)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const heuristicTriggers: string[] = await this.page.evaluate(() => {
          const doc = (globalThis as any).document;
          const win = (globalThis as any).window;
          const refs: string[] = [];

          const allClickable = doc.querySelectorAll('button, [role="button"], a, div[tabindex], span[tabindex]');
          for (const el of allClickable) {
            const htmlEl = el as any;
            const style = win.getComputedStyle(htmlEl);

            // Must be visible
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            const className = (htmlEl.className && typeof htmlEl.className === 'string') ? htmlEl.className.toLowerCase() : '';
            const ariaLabel = (htmlEl.getAttribute('aria-label') || '').toLowerCase();
            const ariaExpanded = htmlEl.getAttribute('aria-expanded');

            // Skip elements already handled by ARIA pass
            if (ariaExpanded !== null) continue;
            // Skip form elements
            const tag = htmlEl.tagName.toLowerCase();
            if (['input', 'select', 'textarea'].includes(tag)) continue;

            let isHamburger = false;

            // Layer 1: CSS class detection
            if (/burger|hamburger|menu[-_]?toggle|nav[-_]?toggle|mobile[-_]?menu|menu[-_]?btn|menu[-_]?button|nav[-_]?btn|toggle[-_]?nav/.test(className)) {
              isHamburger = true;
            }

            // Layer 2: aria-label detection
            if (!isHamburger && /\b(menu|navigation|hamburger|toggle\s*menu|open\s*menu|main\s*menu)\b/.test(ariaLabel)) {
              isHamburger = true;
            }

            // Layer 3: Icon-only button heuristic (small button with SVG in header area)
            if (!isHamburger) {
              const text = ((htmlEl as any).textContent || '').trim();
              const hasSvg = htmlEl.querySelector('svg') !== null;
              const rect = htmlEl.getBoundingClientRect();
              if (hasSvg && text.length <= 2 && rect.width < 80 && rect.width > 20 && rect.top < 100) {
                isHamburger = true;
              }
            }

            if (isHamburger) {
              const ref = htmlEl.getAttribute('data-agent-ref');
              if (ref) refs.push(ref);
            }

            if (refs.length >= 3) break; // Max 3 heuristic triggers
          }

          return refs;
        });

        if (heuristicTriggers.length > 0) {
          logger.debug('[SURVEY] Found heuristic hamburger triggers', {
            count: heuristicTriggers.length,
          });
        }

        for (const triggerRef of heuristicTriggers) {
          try {
            const locator = this.page.locator(`[data-agent-ref="${triggerRef}"]`);

            // Click to open
            await locator.click({ timeout: SurveyAgent.TRIGGER_INTERACTION_TIMEOUT_MS });
            await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 4 });

            // Navigation guard (hash-aware)
            if (await this.getFullUrl() !== urlBefore) {
              await this.page.goBack({ timeout: 5000 }).catch(() => {});
              await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 3 });
              continue;
            }

            // Collect revealed links (4-strategy container cascade)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const revealedLinks = await this.page.evaluate((ref: string) => {
              const doc = (globalThis as any).document;
              const win = globalThis as any;
              const triggerEl = doc.querySelector(`[data-agent-ref="${ref}"]`);
              if (!triggerEl) return [];

              let container: any = null;

              // Strategy 1: aria-controls
              const controlsId = triggerEl.getAttribute('aria-controls');
              if (controlsId) {
                container = doc.getElementById(controlsId);
              }

              // Strategy 2: sibling element
              if (!container) {
                container = triggerEl.nextElementSibling;
              }

              // Strategy 3: parent nav
              if (!container) {
                container = triggerEl.closest('nav');
              }

              // Strategy 4: any nearby visible <nav> or [role="navigation"]
              if (!container) {
                const allNavs = doc.querySelectorAll('nav, [role="navigation"]');
                for (const nav of allNavs) {
                  const navStyle = win.getComputedStyle(nav);
                  if (
                    navStyle.display !== 'none' &&
                    navStyle.visibility !== 'hidden' &&
                    parseFloat(navStyle.opacity) > 0.5
                  ) {
                    container = nav;
                    break;
                  }
                }
              }

              if (!container) return [];

              const anchors = container.querySelectorAll('a[href]');
              const links: Array<{ url: string; label: string }> = [];

              for (const a of anchors) {
                const href = a.href;
                if (!href || href.startsWith('javascript:') || href === '#' || href.endsWith('#')) continue;
                const aStyle = win.getComputedStyle(a);
                if (aStyle.display === 'none' || aStyle.visibility === 'hidden') continue;

                try {
                  links.push({
                    url: new URL(href).href,
                    label: (a.textContent || '').trim().slice(0, 80) || a.getAttribute('aria-label') || '',
                  });
                } catch { /* invalid URL */ }
              }

              return links;
            }, triggerRef);

            for (const link of revealedLinks) {
              if (!seen.has(link.url)) {
                seen.add(link.url);
                results.push(link);
              }
            }

            // Close: click again to toggle off, fallback to Escape
            try {
              await locator.click({ timeout: SurveyAgent.TRIGGER_INTERACTION_TIMEOUT_MS });
            } catch {
              await this.page.keyboard.press('Escape');
            }
            await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 3 });
          } catch (error) {
            logger.debug('[SURVEY] Heuristic hamburger trigger failed', {
              ref: triggerRef,
              error: error instanceof Error ? error.message : String(error),
            });
            await this.page.keyboard.press('Escape').catch(() => {});
            await VisualStability.waitForStable(this.page, { checkInterval: 100, maxAttempts: 2 });
          }
        }
      } catch (error) {
        logger.debug('[SURVEY] Heuristic hamburger pass failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRUCTURED SUMMARY (for AI prompt optimization)
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // FALLBACK ENTRY POINTS (when AI returns 0)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build deterministic entry points from page structure when AI classification
   * returns 0 entry points. Uses heuristics based on forms, inputs, and buttons.
   * Limited to 5 entry points max.
   */
  private buildFallbackEntryPoints(
    snapshot: LiteSnapshot,
    url: string,
  ): Array<{
    name: string;
    goal: string;
    category: TestFlowCategory;
    priority: FlowPriority;
    requiresAuth: boolean;
    estimatedComplexity: 'simple' | 'medium' | 'complex';
    relatedElements: Array<{ ref: string; role: string; name: string; tag: string }>;
  }> {
    const entryPoints: Array<{
      name: string;
      goal: string;
      category: TestFlowCategory;
      priority: FlowPriority;
      requiresAuth: boolean;
      estimatedComplexity: 'simple' | 'medium' | 'complex';
      relatedElements: Array<{ ref: string; role: string; name: string; tag: string }>;
    }> = [];

    const elements = snapshot.elements;
    const inputs = elements.filter(el => ['input', 'textarea', 'select'].includes(el.tag));
    const buttons = elements.filter(el => el.tag === 'button' || el.role === 'button');

    // 1. Detect auth forms (has password field)
    const passwordInputs = inputs.filter(el => el.type === 'password');
    if (passwordInputs.length > 0) {
      const emailInputs = inputs.filter(el =>
        el.type === 'email' || el.autocomplete === 'email' || el.autocomplete === 'username' ||
        /email|username|login/i.test(el.name || el.placeholder || el.htmlName || ''),
      );
      const relatedEls = [...emailInputs, ...passwordInputs].map(el => ({
        ref: el.ref, role: el.role, name: el.name, tag: el.tag,
      }));
      entryPoints.push({
        name: 'User Login',
        goal: 'Login with valid email and password credentials',
        category: 'authentication',
        priority: 'critical',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: relatedEls,
      });
    }

    // 2. Detect search inputs
    const searchInputs = inputs.filter(el =>
      el.type === 'search' || /search/i.test(el.name || el.placeholder || el.htmlName || el.role || ''),
    );
    if (searchInputs.length > 0) {
      entryPoints.push({
        name: 'Site Search',
        goal: 'Search for content using the search functionality',
        category: 'search',
        priority: 'high',
        requiresAuth: false,
        estimatedComplexity: 'simple',
        relatedElements: searchInputs.slice(0, 3).map(el => ({
          ref: el.ref, role: el.role, name: el.name, tag: el.tag,
        })),
      });
    }

    // 3. Detect non-auth forms (inputs without password)
    if (passwordInputs.length === 0 && inputs.length >= 2) {
      const formInputs = inputs.filter(el => el.type !== 'hidden' && el.type !== 'search');
      if (formInputs.length > 0) {
        // Derive name from submit button or first input context
        const formSubmitBtn = buttons.find(b => /submit|send|save|create|add|register|sign\s*up/i.test(b.name || ''));
        const btnLabel = (formSubmitBtn?.name || '').trim();
        const fieldLabel = formInputs[0]?.name || formInputs[0]?.placeholder || '';
        const derivedFormName = btnLabel && !/submit/i.test(btnLabel)
          ? btnLabel
          : fieldLabel
            ? `${fieldLabel} Submission`
            : 'Form Submission';
        entryPoints.push({
          name: derivedFormName,
          goal: `Fill out and submit the form on the page (fields: ${formInputs.slice(0, 3).map(el => el.name || el.placeholder || el.type).filter(Boolean).join(', ') || 'required fields'})`,
          category: 'form_submission',
          priority: 'high',
          requiresAuth: false,
          estimatedComplexity: formInputs.length > 5 ? 'complex' : 'medium',
          relatedElements: formInputs.slice(0, 5).map(el => ({
            ref: el.ref, role: el.role, name: el.name, tag: el.tag,
          })),
        });
      }
    }

    // 4. Detect prominent CTA buttons (non-submit, meaningful text)
    const ctaPatterns = /sign up|register|get started|try|subscribe|contact|book|schedule|download|add to cart|buy|checkout|learn more|explore|apply|submit|create|new/i;
    const ctaButtons = buttons.filter(el =>
      el.name && ctaPatterns.test(el.name) && !el.disabled,
    );
    for (const cta of ctaButtons.slice(0, 2)) {
      if (entryPoints.length >= MAX_FALLBACK_ENTRY_POINTS) break;
      entryPoints.push({
        name: `${cta.name}`,
        goal: `Click the "${cta.name}" button and complete the resulting flow`,
        category: 'other',
        priority: 'medium',
        requiresAuth: false,
        estimatedComplexity: 'medium',
        relatedElements: [{ ref: cta.ref, role: cta.role, name: cta.name, tag: cta.tag }],
      });
    }

    // 5. Data tables (CRUD operations)
    if (entryPoints.length < MAX_FALLBACK_ENTRY_POINTS) {
      const tables = elements.filter(el => el.tag === 'table' || el.role === 'grid');
      if (tables.length > 0) {
        const tableActions = buttons.filter(el =>
          /edit|delete|remove|view|detail|update/i.test(el.name || ''),
        );
        if (tableActions.length > 0) {
          entryPoints.push({
            name: 'Data Table Operations',
            goal: 'Interact with the data table: view details, edit or delete entries',
            category: 'crud',
            priority: 'high',
            requiresAuth: false,
            estimatedComplexity: 'medium',
            relatedElements: [...tables, ...tableActions].slice(0, 5).map(el => ({
              ref: el.ref, role: el.role, name: el.name, tag: el.tag,
            })),
          });
        }
      }
    }

    // 6. File upload inputs
    if (entryPoints.length < MAX_FALLBACK_ENTRY_POINTS) {
      const fileInputs = inputs.filter(el => el.type === 'file');
      if (fileInputs.length > 0) {
        entryPoints.push({
          name: 'File Upload',
          goal: 'Upload a file using the file upload functionality',
          category: 'form_submission',
          priority: 'medium',
          requiresAuth: false,
          estimatedComplexity: 'medium',
          relatedElements: fileInputs.slice(0, 3).map(el => ({
            ref: el.ref, role: el.role, name: el.name, tag: el.tag,
          })),
        });
      }
    }

    // 7. Navigation menu items (important links in nav areas)
    if (entryPoints.length < MAX_FALLBACK_ENTRY_POINTS) {
      const navLinks = elements.filter(el =>
        el.tag === 'a' && el.href && el.visible &&
        (el.role === 'menuitem' || el.role === 'link') &&
        el.name && el.name.length > 1 && el.name.length < 50,
      );
      if (navLinks.length >= 3) {
        entryPoints.push({
          name: 'Navigation Flow',
          goal: 'Navigate through the main navigation menu and verify page loading',
          category: 'navigation',
          priority: 'medium',
          requiresAuth: false,
          estimatedComplexity: 'simple',
          relatedElements: navLinks.slice(0, 5).map(el => ({
            ref: el.ref, role: el.role, name: el.name, tag: el.tag,
          })),
        });
      }
    }

    return entryPoints.slice(0, MAX_FALLBACK_ENTRY_POINTS);
  }
}
