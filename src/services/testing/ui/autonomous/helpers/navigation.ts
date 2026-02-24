import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { buildPageNavigationPrompt, buildPageNavigationSystemPrompt } from '@/ai/prompts';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import { emitExplorationProgress } from './progress';

/**
 * Custom error for navigation failures that require user clarification
 */
export class NavigationRequiresClarificationError extends Error {
  constructor(
    message: string,
    public readonly currentUrl: string,
    public readonly attemptedGoal: string,
    public readonly reason: 'no_links_found' | 'max_attempts_reached'
  ) {
    super(message);
    this.name = 'NavigationRequiresClarificationError';
  }
}

/**
 * AI-powered navigation to find target page based on user's goal
 * Analyzes user message, extracts available links, uses AI to select best navigation path
 */
async function findTargetPage(
  page: Page,
  userMessage: string,
  maxAttempts: number = 3
): Promise<{ finalUrl: string; navigated: boolean; attempts: number; reason?: string }> {
  const startUrl = page.url();
  let currentAttempt = 0;
  let lastReason = '';

  logger.info('[NAVIGATION] Starting AI-guided navigation', {
    userMessage: userMessage.substring(0, 100),
    startUrl,
    maxAttempts,
  });

  for (let i = 0; i < maxAttempts; i++) {
    currentAttempt = i + 1;
    const currentUrl = page.url();

    logger.info(`[NAVIGATION] Attempt ${currentAttempt}/${maxAttempts}`, { currentUrl });

    // Quick DOM scan: extract all clickable links and buttons
    // FIX #1: Use stable ref-based selectors instead of nth-of-type
    // FIX #2: Add context from parent headings
    // FIX #3: Prioritize visible elements and group by sections
    // @ts-ignore - browser context
    const availableLinks = await page.evaluate(() => {
      const links: Array<{
        text: string;
        href: string;
        selector: string;
        context?: string; // FIX #3: Parent heading/section context
        isVisible: boolean; // FIX #2: Viewport visibility
        section?: string; // FIX #2: Section grouping (header/main/footer)
      }> = [];

      // Helper: Get closest parent heading (h1-h3) for context
      const getParentContext = (el: any): string | undefined => {
        // Walk up to find heading
        let current = el.parentElement;
        let depth = 0;
        while (current && depth < 5) {
          const heading = current.querySelector('h1, h2, h3');
          if (heading?.textContent?.trim()) {
            return heading.textContent.trim().substring(0, 40);
          }
          current = current.parentElement;
          depth++;
        }
        return undefined;
      };

      // Helper: Check if element is in viewport
      const isInViewport = (el: any): boolean => {
        const rect = el.getBoundingClientRect();
        // @ts-ignore
        const w = typeof window !== 'undefined' ? window : { innerHeight: 0, innerWidth: 0 };
        // @ts-ignore
        const d = typeof document !== 'undefined' ? document : { documentElement: { clientHeight: 0, clientWidth: 0 } };
        const viewportHeight = w.innerHeight || d.documentElement.clientHeight;
        const viewportWidth = w.innerWidth || d.documentElement.clientWidth;

        // Also exclude elements that are effectively invisible (opacity/visibility/display).
        // Note: bounding rect can still be inside viewport for hidden elements.
        try {
          // @ts-ignore - browser context
          const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
          const display = style?.display;
          const visibility = style?.visibility;
          const opacity = style?.opacity;

          if (display === 'none' || visibility === 'hidden' || opacity === '0') {
            return false;
          }

          // Common additional hidden flags
          const ariaHidden = el.getAttribute?.('aria-hidden');
          if (ariaHidden === 'true') {
            return false;
          }
        } catch {
          // If style computation fails, fall back to geometry-only visibility
        }

        // Consider partially visible elements as visible (more robust than full containment).
        // This avoids marking important header/nav elements as OFF-SCREEN when they are partially in view.
        const isPartiallyVisible =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < viewportHeight &&
          rect.left < viewportWidth;
        return (
          isPartiallyVisible &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      // Helper: Get section (header/main/footer)
      const getSection = (el: any): string => {
        const tag = el.closest('header, main, footer, nav')?.tagName.toLowerCase();
        return tag || 'main';
      };

      // FIX #1: Inject stable data-nav-id attribute
      let refCounter = 0;

      // Get all anchor tags
      // @ts-expect-error - browser context
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      anchors.forEach((el: any) => {
        const text = (el.textContent || '').trim();
        const href = el.getAttribute('href') || '';
        if (text && href && href !== '#') {
          const refId = `nav-${refCounter++}`;
          el.setAttribute('data-nav-id', refId);

          links.push({
            text: text.substring(0, 50),
            href,
            selector: `[data-nav-id="${refId}"]`, // FIX #1: Stable selector
            context: getParentContext(el), // FIX #3: Context
            isVisible: isInViewport(el),
            section: getSection(el),
          });
        }
      });

      // Get all buttons
      // @ts-expect-error - browser context
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach((el: any) => {
        const text = (el.textContent || '').trim();
        if (text) {
          const refId = `nav-${refCounter++}`;
          el.setAttribute('data-nav-id', refId);

          links.push({
            text: text.substring(0, 50),
            href: '',
            selector: `[data-nav-id="${refId}"]`,
            context: getParentContext(el),
            isVisible: isInViewport(el),
            section: getSection(el),
          });
        }
      });

      // Get role-based clickable elements (common for SPAs)
      // @ts-expect-error - browser context
      const roleClickables = Array.from(document.querySelectorAll('[role="button"], [role="link"]'));
      roleClickables.forEach((el: any) => {
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
        if (text) {
          const refId = `nav-${refCounter++}`;
          el.setAttribute('data-nav-id', refId);

          const role = (el.getAttribute('role') || '').toLowerCase();
          links.push({
            text: text.substring(0, 50),
            href: role === 'link' ? (el.getAttribute('href') || '') : '',
            selector: `[data-nav-id="${refId}"]`,
            context: getParentContext(el),
            isVisible: isInViewport(el),
            section: getSection(el),
          });
        }
      });

      // Get input submit/button elements
      // @ts-expect-error - browser context
      const inputButtons = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'));
      inputButtons.forEach((el: any) => {
        const text = (el.getAttribute('value') || el.getAttribute('aria-label') || '').trim();
        if (text) {
          const refId = `nav-${refCounter++}`;
          el.setAttribute('data-nav-id', refId);

          links.push({
            text: text.substring(0, 50),
            href: '',
            selector: `[data-nav-id="${refId}"]`,
            context: getParentContext(el),
            isVisible: isInViewport(el),
            section: getSection(el),
          });
        }
      });

      // Elements with explicit onclick handlers (fallback)
      // @ts-expect-error - browser context
      const onclickElements = Array.from(document.querySelectorAll('[onclick]'));
      onclickElements.forEach((el: any) => {
        const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (text) {
          const refId = `nav-${refCounter++}`;
          el.setAttribute('data-nav-id', refId);

          links.push({
            text: text.substring(0, 50),
            href: '',
            selector: `[data-nav-id="${refId}"]`,
            context: getParentContext(el),
            isVisible: isInViewport(el),
            section: getSection(el),
          });
        }
      });

      // FIX #2: Prioritize visible elements, then by section importance
      const sectionPriority: Record<string, number> = { header: 3, nav: 3, main: 2, footer: 1 };
      links.sort((a, b) => {
        // Visible first
        if (a.isVisible !== b.isVisible) return a.isVisible ? -1 : 1;
        // Then by section priority
        const aPrio = sectionPriority[a.section || 'main'] || 0;
        const bPrio = sectionPriority[b.section || 'main'] || 0;
        return bPrio - aPrio;
      });

      // FIX #2: Take top 80 (balance between coverage and tokens)
      // If there are 50+ links, this gives more breathing room for large sites
      const topLinks = links.slice(0, 80);

      // Deduplicate by text+context (not just text)
      const seen = new Set<string>();
      const uniqueLinks = topLinks.filter(link => {
        const key = `${link.text}::${link.context || 'no-context'}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return uniqueLinks;
    });

    logger.info('[NAVIGATION] Extracted links', {
      count: availableLinks.length,
      visibleCount: availableLinks.filter(l => l.isVisible).length,
      sections: [...new Set(availableLinks.map(l => l.section))].join(', '),
      sample: availableLinks.slice(0, 3).map(l => ({
        text: l.text.substring(0, 30),
        context: l.context?.substring(0, 20),
        visible: l.isVisible,
      })),
    });

    if (availableLinks.length === 0) {
      lastReason = 'no_links_found';
      logger.warn('[NAVIGATION] No links found on page, stopping navigation', {
        currentUrl,
        attempt: currentAttempt,
      });
      break;
    }

    // Use AI to analyze and select target link
    try {
      const prompt = buildPageNavigationPrompt({
        userMessage,
        availableLinks,
        currentUrl,
      });

      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: buildPageNavigationSystemPrompt(),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          model: AI_TASK_MODELS.navigationAnalysis,
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(response.content);

      logger.info('[NAVIGATION] AI decision', {
        shouldNavigate: parsed.shouldNavigate,
        targetText: parsed.targetText,
        reasoning: parsed.reasoning,
        confidence: parsed.confidence,
      });

      // If AI says no navigation needed, stop
      if (!parsed.shouldNavigate || !parsed.targetSelector) {
        lastReason = 'ai_no_navigation_needed';
        logger.info('[NAVIGATION] AI determined no navigation needed', {
          reasoning: parsed.reasoning,
        });
        break;
      }

      // Navigate to selected link
      const beforeUrl = page.url();

      try {
        // Last mile: ensure the target selector still exists.
        // On highly dynamic sites, injected data-nav-id can disappear after re-render.
        const selectedLinkMeta =
          availableLinks.find((l) => l.selector === parsed.targetSelector) ||
          availableLinks.find((l) => l.text === parsed.targetText);

        const ensureClickableSelector = async (): Promise<string | null> => {
          try {
            const handle = await page.$(parsed.targetSelector);
            if (handle) return parsed.targetSelector;
          } catch {
            // ignore, try fallback
          }

          // Fallback: re-find by text and re-inject a fresh data-nav-id for a stable selector.
          try {
            const rebuiltSelector = await page.evaluate((params: {
              targetText: string;
              expectedContext?: string;
              expectedSection?: string;
            }) => {
              const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const needle = normalize(params.targetText);
              const expectedContext = normalize(params.expectedContext || '');
              const expectedSection = normalize(params.expectedSection || '');
              if (!needle) return null;

              const doc = (globalThis as any).document as any;
              const win = (globalThis as any).window as any;
              const candidates = Array.from(
                doc?.querySelectorAll?.(
                  'a[href], button, [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick]'
                ) || []
              ) as any[];

              const getSection = (el: any): string => {
                const tag = el?.closest?.('header, nav, main, footer')?.tagName?.toLowerCase?.();
                return tag || 'main';
              };

              const getParentContext = (el: any): string => {
                let current = el?.parentElement;
                let depth = 0;
                while (current && depth < 6) {
                  const heading = current.querySelector?.('h1, h2, h3');
                  const text = heading?.textContent ? normalize(heading.textContent) : '';
                  if (text) return text;
                  current = current.parentElement;
                  depth++;
                }
                return '';
              };

              const isHidden = (el: any): boolean => {
                try {
                  const style = win?.getComputedStyle?.(el);
                  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
                  if (el.getAttribute?.('aria-hidden') === 'true') return true;
                } catch {
                  // ignore
                }
                return false;
              };

              const getText = (el: any): string => {
                return normalize(
                  el.textContent ||
                    el.getAttribute?.('aria-label') ||
                    el.getAttribute?.('title') ||
                    el.getAttribute?.('value') ||
                    ''
                );
              };

              // Prefer visible candidates whose text contains the needle (or vice-versa).
              const scored = candidates
                .map((el) => {
                  const text = getText(el);
                  const ctx = expectedContext ? getParentContext(el) : '';
                  const section = expectedSection ? normalize(getSection(el)) : '';
                  const match =
                    (text && (text.includes(needle) || needle.includes(text))) ? 1 : 0;
                  const visible = !isHidden(el) ? 1 : 0;
                  const contextMatch =
                    expectedContext && ctx
                      ? (ctx.includes(expectedContext) || expectedContext.includes(ctx) ? 1 : 0)
                      : 0;
                  const sectionMatch = expectedSection && section ? (section === expectedSection ? 1 : 0) : 0;
                  const score = match * 10 + visible + contextMatch * 5 + sectionMatch * 2;
                  return { el, text, ctx, section, score };
                })
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score);

              const best = scored[0]?.el;
              if (!best) return null;

              const refId = `nav-retry-${Date.now()}`;
              best.setAttribute('data-nav-id', refId);
              return `[data-nav-id="${refId}"]`;
            }, {
              targetText: parsed.targetText || '',
              expectedContext: selectedLinkMeta?.context,
              expectedSection: selectedLinkMeta?.section,
            });

            return rebuiltSelector || null;
          } catch {
            return null;
          }
        };

        const clickSelector = (await ensureClickableSelector()) || parsed.targetSelector;

        // If link opens in new tab, remove target="_blank" to keep navigation in the same page.
        // This prevents Playwright from staying on old page while navigation happens in a popup.
        try {
          await page.evaluate((selector: string) => {
            // Use globalThis to avoid TS DOM lib dependency in Node compilation context.
            const doc = (globalThis as any).document as any;
            const el = doc?.querySelector?.(selector) as any;
            if (!el) return;
            if (el.getAttribute?.('target') === '_blank') {
              el.removeAttribute('target');
            }
          }, parsed.targetSelector);
        } catch {
          // Non-critical - proceed with click
        }

        try {
          await page.click(clickSelector, { timeout: 10000 });
        } catch (clickErr) {
          // Final fallback: search by text and click first match (best-effort).
          if (parsed.targetText && typeof parsed.targetText === 'string' && parsed.targetText.trim().length > 0) {
            logger.warn('[NAVIGATION] Selector click failed, falling back to text match click', {
              selector: clickSelector,
              targetText: parsed.targetText,
              error: clickErr instanceof Error ? clickErr.message : String(clickErr),
            });

            await page.getByText(parsed.targetText, { exact: false }).first().click({ timeout: 10000 });
          } else {
            throw clickErr;
          }
        }

        await Promise.race([
          page.waitForLoadState('domcontentloaded', { timeout: 5000 }),
          page.waitForTimeout(3000),
        ]);

        const afterUrl = page.url();

        if (afterUrl !== beforeUrl) {
          logger.info('[NAVIGATION] Successfully navigated', {
            from: beforeUrl,
            to: afterUrl,
            attempt: currentAttempt,
          });
          continue;
        } else {
          logger.warn('[NAVIGATION] Click did not result in URL change (SPA or same page)', {
            targetText: parsed.targetText,
          });
        }
      } catch (clickError) {
        logger.warn('[NAVIGATION] Failed to click element', {
          selector: parsed.targetSelector,
          error: clickError instanceof Error ? clickError.message : String(clickError),
        });
      }
    } catch (aiError) {
      logger.error('[NAVIGATION] AI navigation failed', {
        error: aiError instanceof Error ? aiError.message : String(aiError),
        attempt: currentAttempt,
      });
      break;
    }
  }

  const finalUrl = page.url();
  const navigated = finalUrl !== startUrl;

  // Determine reason for stopping
  let stopReason = 'completed';
  if (!navigated) {
    if (lastReason) {
      stopReason = lastReason;
    } else if (currentAttempt >= maxAttempts) {
      stopReason = 'max_attempts_reached';
      lastReason = 'max_attempts_reached';
    } else {
      stopReason = 'unknown';
      logger.warn('[NAVIGATION] Unexpected stop condition', {
        currentAttempt,
        maxAttempts,
        navigated,
        lastReason,
      });
    }
  }

  logger.info('[NAVIGATION] Navigation completed', {
    startUrl,
    finalUrl,
    navigated,
    attempts: currentAttempt,
    maxAttempts,
    stopReason,
  });

  return { finalUrl, navigated, attempts: currentAttempt, reason: stopReason };
}

/**
 * Navigate to initial URL and wait for page load
 */
export async function navigateToInitialPage(
  page: Page,
  url: string,
  sessionId?: string
): Promise<void> {
  logger.info('Navigating to target URL', { url });
  emitExplorationProgress(sessionId, `📄 Opening page ${url}...`);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Smart wait for network idle (max 3 seconds for SPAs)
  try {
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 3000 }),
      page.waitForTimeout(3000),
    ]);
  } catch {
    logger.debug('Network not idle after 3s, continuing...');
  }
}

/**
 * Attempt AI-guided navigation to target page
 * Returns { originalUrl, finalUrl } - NEVER throws NavigationRequiresClarificationError.
 * If navigation fails, exploration continues on current page.
 * Actual navigation to target will be handled by AI agent during test execution.
 */
export async function attemptAIGuidedNavigation(
  page: Page,
  context: any,
  url: string,
  userMessage: string,
  sessionId?: string
): Promise<{ originalUrl: string | undefined; finalUrl: string }> {
  logger.info('[EXPLORATION] User message provided, attempting AI-guided navigation', {
    userMessage: userMessage.substring(0, 100),
  });

  emitExplorationProgress(sessionId, '🔍 Finding target page with AI...');

  try {
    const navigationResult = await findTargetPage(page, userMessage, 3);

    if (navigationResult.navigated) {
      logger.info('[EXPLORATION] Navigation successful', {
        originalUrl: url,
        finalUrl: navigationResult.finalUrl,
        attempts: navigationResult.attempts,
      });

      emitExplorationProgress(sessionId, `✅ Found target page: ${navigationResult.finalUrl}`);

      return {
        originalUrl: url,
        finalUrl: navigationResult.finalUrl,
      };
    }

    // Handle navigation failure cases
    if (navigationResult.reason === 'no_links_found') {
      // IMPORTANT: Not being able to extract navigation links is NOT a reason to stop.
      // Many sites use JS-driven buttons or non-semantic click targets; we should proceed on the current page.
      logger.warn('[EXPLORATION] No navigation links found; continuing on current page', {
        url,
        userMessage: userMessage.substring(0, 100),
        attempts: navigationResult.attempts,
      });
      emitExplorationProgress(sessionId, 'ℹ️ No obvious navigation links found. Continuing on the current page...');
      return { originalUrl: undefined, finalUrl: url };
    }

    if (navigationResult.reason === 'max_attempts_reached') {
      // IMPORTANT: max_attempts_reached is NOT a reason to ask for clarification.
      // The AI agent will find the path during TEST EXECUTION, not during exploration.
      // Exploration is just for analyzing the current page and generating a test plan.
      // The test plan will include "navigate to registration" as a step that AI executes.
      logger.warn('[EXPLORATION] Max navigation attempts reached; continuing on current page', {
        url,
        userMessage: userMessage.substring(0, 100),
        reason: navigationResult.reason,
        attempts: navigationResult.attempts,
        note: 'AI agent will handle navigation during test execution',
      });
      emitExplorationProgress(
        sessionId,
        'ℹ️ Could not find direct path to target. Will include navigation in test plan...'
      );
      return { originalUrl: undefined, finalUrl: url };
    }

    // AI determined navigation not needed
    logger.info('[EXPLORATION] Navigation not needed, analyzing original page', {
      url,
      reason: navigationResult.reason,
    });

    emitExplorationProgress(sessionId, `ℹ️ Analyzing current page (AI determined navigation not needed)`);

    return {
      originalUrl: undefined,
      finalUrl: url,
    };
  } catch (navError) {
    // Navigation errors are NOT critical - exploration continues on current page.
    // AI agent will handle navigation during test execution.
    logger.warn('[EXPLORATION] AI navigation failed, falling back to original page', {
      error: navError instanceof Error ? navError.message : String(navError),
      url,
    });

    return {
      originalUrl: undefined,
      finalUrl: url,
    };
  }
}
