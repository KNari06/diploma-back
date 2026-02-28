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

import type { ExplorationConfig, EntryPoint, NavigationAction } from './types';
import { ExplorationTree } from './exploration-tree';
import { BudgetTracker } from './budget-tracker';
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
      await this.page.goto(this.config.entryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (error) {
      logger.error('[SURVEY] Failed to navigate to entry URL', {
        url: this.config.entryUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.tree;
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
          await this.page.goto(item.url, {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
          });
        } catch (error) {
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

      // Wait a moment for page to stabilize
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } catch {
        // Ignore timeout
      }

      // Collect snapshot
      let snapshot;
      try {
        snapshot = await SnapshotCollector.collect(this.page);
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
      }
    }
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
  ): Promise<ReturnType<typeof parsePageClassificationResponse>> {
    const prompt = buildPageClassificationPrompt({
      formattedSnapshot,
      url,
      title,
      scopeHint: this.config.scopeHint,
      hasCredentials: !!this.config.credentials,
      depth,
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

      return parsePageClassificationResponse(response.content);
    } catch (error) {
      logger.warn('[SURVEY] AI classification failed, using empty result', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: return page type based on URL heuristics
      return {
        pageType: this.inferPageTypeFromUrl(url),
        entryPoints: [],
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
    // Find element in snapshot
    const element = snapshot.elements?.find((el: any) => el.ref === ref);
    if (!element) return null;

    // Try to get href from the page via evaluate
    try {
      const href = await this.page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (elRef: string) => {
          const el = (globalThis as any).document?.querySelector(`[data-ref="${elRef}"]`);
          if (el && el.href) return el.href as string;

          const links = (globalThis as any).document?.querySelectorAll('a[href]') || [];
          for (const link of links) {
            if (link.getAttribute?.('data-ref') === elRef) {
              return link.href as string;
            }
          }
          return null;
        },
        ref,
      );

      if (href) return href;
    } catch {
      // Evaluation failed
    }

    // Try constructing from element name
    if (element.name) {
      try {
        const baseUrl = new URL(this.page.url());
        const slug = element.name.toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .replace(/\s+/g, '-');
        return `${baseUrl.origin}/${slug}`;
      } catch {
        // URL construction failed
      }
    }

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
    if (path === '/' || path === '') return 'home';
    return 'other';
  }
}
