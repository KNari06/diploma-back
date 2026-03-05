/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SURVEY AGENT — Phase 1: BFS page discovery
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Performs breadth-first traversal of the web application:
 *   1. Navigate to entry URL
 *   2. Collect DOM snapshot + screenshot
 *   3. Call AI (GPT-4o vision) to classify page and discover entry points
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

import type { LiteSnapshot, LiteElement } from '../lite-types';
import type { ExplorationConfig, EntryPoint, NavigationAction, TestFlowCategory, FlowPriority } from './types';
import { ExplorationTree } from './exploration-tree';
import { BudgetTracker } from './budget-tracker';
import { RateLimiter } from './rate-limiter';
import {
  buildPageClassificationPrompt,
  parsePageClassificationResponse,
} from './prompts';

/** Max navigation links to follow per page */
const MAX_NAV_LINKS_PER_PAGE = 8;

/** Timeout for page navigation (ms) */
const NAV_TIMEOUT_MS = 15_000;

/** Timeout for AI classification call (ms) */
const AI_TIMEOUT_MS = 20_000;

/** Max fallback entry points when AI returns 0 */
const MAX_FALLBACK_ENTRY_POINTS = 8;

/** Max SPA route clicks per page during BFS */
const MAX_SPA_CLICKS_PER_PAGE = 5;

/** Common login URL patterns */
const LOGIN_URL_PATTERNS = [
  /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth/i,
  /\/log-in/i, /\/sso/i,
];

export class SurveyAgent {
  private tree: ExplorationTree;
  private entryPointCounter: number = 0;

  constructor(
    private readonly page: Page,
    private readonly config: ExplorationConfig,
    private readonly budget: BudgetTracker,
    private readonly rateLimiter: RateLimiter,
  ) {
    this.tree = new ExplorationTree();
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
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      this.rateLimiter.recordSuccess('target_site');
    } catch (error) {
      if (RateLimiter.isRateLimitError(error as Error)) {
        const result = await this.rateLimiter.recordFailure('target_site', error as Error);
        if (result.shouldRetry) {
          try {
            await this.page.goto(this.config.entryUrl, {
              waitUntil: 'domcontentloaded',
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

    while (queue.length > 0 && this.budget.canSurveyMorePages()) {
      const item = queue.shift()!;

      // Skip if already visited
      if (this.tree.isVisited(item.url)) continue;

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
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
          });
          this.rateLimiter.recordSuccess('target_site');
        } catch (error) {
          if (RateLimiter.isRateLimitError(error as Error)) {
            const result = await this.rateLimiter.recordFailure('target_site', error as Error);
            if (result.shouldRetry) {
              try {
                await this.page.goto(item.url, {
                  waitUntil: 'domcontentloaded',
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

      // Wait a moment for page to stabilize
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } catch {
        // Ignore timeout
      }

      // Collect snapshot (with scroll to trigger lazy-loaded content)
      let snapshot;
      try {
        snapshot = await this.collectFullSnapshot();
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
        logger.debug('[SURVEY] Skipping same-template page', { url: item.url });
        continue;
      }

      // Check for SPA content dedup
      if (this.tree.isContentVisited(snapshot)) {
        logger.debug('[SURVEY] Skipping duplicate content page', { url: item.url });
        continue;
      }

      // Format snapshot for AI
      const formattedSnapshot = SnapshotCollector.format(snapshot);

      // Take screenshot for vision
      let screenshotBase64: string | undefined;
      try {
        const screenshotBuffer = await this.page.screenshot({ type: 'png', fullPage: false });
        screenshotBase64 = screenshotBuffer.toString('base64');
      } catch (error) {
        logger.warn('[SURVEY] Failed to take screenshot', {
          url: item.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // AI classification
      const classification = await this.classifyPage(
        formattedSnapshot,
        screenshotBase64,
        this.page.url(),
        await this.page.title(),
        item.depth,
        snapshot,
      );

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

        // Enqueue navigation links (BFS children)
        const navLinks = classification.navigationLinks.slice(0, MAX_NAV_LINKS_PER_PAGE);
        for (const link of navLinks) {
          // Resolve link URL from element ref
          const linkUrl = await this.resolveLinkUrl(link.ref, snapshot);
          if (linkUrl && !this.tree.isVisited(linkUrl) && this.isSameOrigin(linkUrl)) {
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

        // Hidden content discovery (exploration-only)
        const hiddenDomLinks = await this.harvestHiddenLinks();
        const hiddenNavLinks = await this.discoverHiddenNavigation(snapshot);

        const allHiddenLinks = [...hiddenDomLinks, ...hiddenNavLinks].slice(0, MAX_NAV_LINKS_PER_PAGE);
        for (const link of allHiddenLinks) {
          if (!this.tree.isVisited(link.url) && this.isSameOrigin(link.url)) {
            queue.push({
              url: link.url,
              depth: item.depth + 1,
              parentNodeId: nodeId,
              navAction: { type: 'click_link', label: link.label, targetUrl: link.url },
            });
          }
        }

        // SPA navigation: click elements that may trigger client-side route changes
        await this.discoverSpaRoutes(snapshot, queue, item, nodeId);
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
    const initialSnapshot = await SnapshotCollector.collect(this.page, { fullPage: true });

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
        await this.page.waitForTimeout(800); // Wait for lazy load
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
        const scrollSnapshot = await SnapshotCollector.collect(this.page, { fullPage: true });
        for (const el of scrollSnapshot.elements) {
          if (!allElements.has(el.ref)) {
            allElements.set(el.ref, el);
          }
        }
      } catch {
        break;
      }

      // No new elements → stop scrolling
      if (allElements.size === prevElementCount) break;
      prevElementCount = allElements.size;
    }

    // Scroll back to top
    try {
      await this.page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
      await this.page.waitForTimeout(300);
    } catch { /* ignore */ }

    // Return merged snapshot
    return {
      ...initialSnapshot,
      elements: Array.from(allElements.values()),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AI CLASSIFICATION
  // ═══════════════════════════════════════════════════════════════════════

  private async classifyPage(
    formattedSnapshot: string,
    screenshotBase64: string | undefined,
    url: string,
    title: string,
    depth: number,
    snapshot?: LiteSnapshot,
  ): Promise<ReturnType<typeof parsePageClassificationResponse>> {
    // Early exit if AI is degraded — use heuristic fallback
    if (this.rateLimiter.isDegraded('openai')) {
      logger.info('[SURVEY] AI degraded, using heuristic fallback', { url });
      return {
        pageType: this.inferPageTypeFromUrl(url),
        entryPoints: snapshot ? this.buildFallbackEntryPoints(snapshot, url) : [],
        navigationLinks: [],
      };
    }

    const structureSummary = snapshot ? this.buildPageStructureSummary(snapshot) : undefined;

    const prompt = buildPageClassificationPrompt({
      formattedSnapshot,
      url,
      title,
      scopeHint: this.config.scopeHint,
      hasCredentials: !!this.config.credentials,
      depth,
      structureSummary,
    });

    try {
      // Build messages with optional vision
      const userContent: any[] = [{ type: 'text', text: prompt }];

      if (screenshotBase64) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${screenshotBase64}`,
            detail: 'low', // 'low' is sufficient for page-level classification
          },
        });
      }

      await this.rateLimiter.acquireSlot('ai');

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            {
              role: 'system',
              content: 'You are a QA test discovery agent. Analyze pages and identify all testable user flows. Respond with valid JSON only.',
            },
            {
              role: 'user',
              content: userContent,
            },
          ],
          {
            model: AI_MODELS.vision,
            temperature: 0.2,
            max_tokens: 2000,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI classification timeout')), AI_TIMEOUT_MS),
        ),
      ]);

      this.rateLimiter.recordSuccess('openai');
      const classification = parsePageClassificationResponse(response.content);

      // Fallback: if AI returned 0 entry points, use heuristic discovery
      if (classification.entryPoints.length === 0 && snapshot) {
        classification.entryPoints = this.buildFallbackEntryPoints(snapshot, url);
        if (classification.entryPoints.length > 0) {
          logger.info('[SURVEY] AI returned 0 entry points, using heuristic fallback', {
            url,
            fallbackCount: classification.entryPoints.length,
          });
        }
      }

      return classification;
    } catch (error) {
      // Handle rate-limit errors with backoff + retry
      if (RateLimiter.isRateLimitError(error as Error)) {
        const result = await this.rateLimiter.recordFailure('openai', error as Error);
        if (result.shouldRetry) {
          try {
            await this.rateLimiter.acquireSlot('ai');
            const retryContent: any[] = [{ type: 'text', text: prompt }];
            if (screenshotBase64) {
              retryContent.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'low' },
              });
            }
            const response = await Promise.race([
              getChatCompletionWithMessages(
                [
                  {
                    role: 'system',
                    content: 'You are a QA test discovery agent. Analyze pages and identify all testable user flows. Respond with valid JSON only.',
                  },
                  {
                    role: 'user',
                    content: retryContent,
                  },
                ],
                {
                  model: AI_MODELS.vision,
                  temperature: 0.2,
                  max_tokens: 2000,
                  response_format: { type: 'json_object' },
                },
              ),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('AI classification timeout')), AI_TIMEOUT_MS),
              ),
            ]);
            this.rateLimiter.recordSuccess('openai');
            return parsePageClassificationResponse(response.content);
          } catch {
            // Fall through to heuristic fallback
          }
        }
      }

      logger.warn('[SURVEY] AI classification failed, using heuristic fallback', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: return page type + heuristic entry points
      return {
        pageType: this.inferPageTypeFromUrl(url),
        entryPoints: snapshot ? this.buildFallbackEntryPoints(snapshot, url) : [],
        navigationLinks: [],
      };
    }
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

      const urlBefore = this.page.url();
      const contentHashBefore = this.tree.computeContentHashPublic(snapshot);

      try {
        await this.page.locator(`[data-agent-ref="${el.ref}"]`).click({ timeout: 3000 });
        await this.page.waitForTimeout(1000); // Wait for SPA transition

        const urlAfter = this.page.url();

        // Case 1: URL changed → standard BFS will handle, go back
        if (urlAfter !== urlBefore) {
          this.rateLimiter.recordSuccess('target_site');
          if (!this.tree.isVisited(urlAfter) && this.isSameOrigin(urlAfter)) {
            queue.push({
              url: urlAfter,
              depth: item.depth + 1,
              parentNodeId: nodeId,
              navAction: { type: 'click_button', ref: el.ref, label: el.name || 'SPA link' },
            });
          }
          await this.page.goBack({ timeout: 5000 }).catch(() => {});
          await this.page.waitForTimeout(500);
          continue;
        }

        // Case 2: URL same but content changed → SPA route, treat as new page
        const newSnapshot = await SnapshotCollector.collect(this.page, { fullPage: true });
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

          const classification = await this.classifyPage(
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
        await this.page.waitForTimeout(500);
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

    if (triggers.length === 0) return [];

    const candidates = triggers.slice(0, SurveyAgent.MAX_HIDDEN_TRIGGERS);
    const results: Array<{ url: string; label: string }> = [];
    const seen = new Set<string>();
    const urlBefore = this.page.url();

    for (const trigger of candidates) {
      try {
        const locator = this.page.locator(`[data-agent-ref="${trigger.ref}"]`);

        // Click the trigger
        await locator.click({ timeout: SurveyAgent.TRIGGER_INTERACTION_TIMEOUT_MS });
        await this.page.waitForTimeout(500);

        // Navigation guard: if URL changed, go back and skip
        if (this.page.url() !== urlBefore) {
          await this.page.goBack({ timeout: 5000 }).catch(() => {});
          await this.page.waitForTimeout(300);
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
        await this.page.waitForTimeout(300);
      } catch (error) {
        logger.debug('[SURVEY] discoverHiddenNavigation trigger failed', {
          ref: trigger.ref,
          error: error instanceof Error ? error.message : String(error),
        });
        // Try Escape to clean up any partial state
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(200);
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRUCTURED SUMMARY (for AI prompt optimization)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build a concise structured summary of page elements for AI classification.
   * Reduces token usage and improves discovery quality.
   */
  private buildPageStructureSummary(snapshot: LiteSnapshot): string {
    const elements = snapshot.elements;
    const links = elements.filter(el => el.tag === 'a' && el.href);
    const buttons = elements.filter(el => el.tag === 'button' || el.role === 'button');
    const inputs = elements.filter(el => ['input', 'textarea', 'select'].includes(el.tag));
    const forms = elements.filter(el => el.tag === 'form');

    const sections: string[] = [];

    if (links.length > 0) {
      sections.push(`LINKS (${links.length}):\n  ${links.slice(0, 25).map(l =>
        `[${l.ref}] "${l.name}" → ${l.href}`).join('\n  ')}`);
    }
    if (buttons.length > 0) {
      sections.push(`BUTTONS (${buttons.length}): ${buttons.slice(0, 15).map(b =>
        `[${b.ref}] "${b.name}"`).join(', ')}`);
    }
    if (inputs.length > 0) {
      sections.push(`INPUTS (${inputs.length}): ${inputs.slice(0, 15).map(i =>
        `[${i.ref}] ${i.tag}${i.type ? `[${i.type}]` : ''} "${i.name || i.placeholder || ''}"`).join(', ')}`);
    }
    if (forms.length > 0) {
      sections.push(`FORMS (${forms.length}): ${forms.slice(0, 5).map(f =>
        `[${f.ref}] "${f.name}"`).join(', ')}`);
    }

    return sections.join('\n');
  }

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
        entryPoints.push({
          name: 'Form Submission',
          goal: 'Fill out and submit the form on the page',
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
        name: `CTA: ${cta.name}`,
        goal: `Click "${cta.name}" and complete the resulting flow`,
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
