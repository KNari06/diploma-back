import { buildPageNavigationPrompt, buildPageNavigationSystemPrompt } from '@/ai/prompts';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
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
    const availableLinks = await page.evaluate(() => {
      const links: Array<{ text: string; href: string; selector: string }> = [];

      // Get all anchor tags
      // @ts-expect-error - browser context
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      anchors.forEach((el: any, idx: number) => {
        const text = (el.textContent || '').trim();
        const href = el.getAttribute('href') || '';
        if (text && href && href !== '#') {
          links.push({
            text: text.substring(0, 50), // Limit text length
            href,
            selector: `a[href="${href}"]:nth-of-type(${idx + 1})`,
          });
        }
      });

      // Get all buttons
      // @ts-expect-error - browser context
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach((el: any, idx: number) => {
        const text = (el.textContent || '').trim();
        if (text) {
          links.push({
            text: text.substring(0, 50),
            href: '', // Buttons don't have href
            selector: `button:nth-of-type(${idx + 1})`,
          });
        }
      });

      // Deduplicate by text (keep first occurrence)
      const seen = new Set<string>();
      const uniqueLinks = links.filter(link => {
        if (seen.has(link.text)) return false;
        seen.add(link.text);
        return true;
      });

      // Limit to 50 links to balance between coverage and token usage
      return uniqueLinks.slice(0, 50);
    });

    logger.info('[NAVIGATION] Extracted links', {
      count: availableLinks.length,
      sample: availableLinks.slice(0, 5).map(l => l.text),
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
          model: 'gpt-4o-mini',
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
        await page.click(parsed.targetSelector, { timeout: 10000 });

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
 * Returns { originalUrl, finalUrl } or throws NavigationRequiresClarificationError
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
    if (navigationResult.reason === 'no_links_found' || navigationResult.reason === 'max_attempts_reached') {
      const errorMsg = navigationResult.reason === 'no_links_found'
        ? `Could not find navigation links for "${userMessage}" on ${url}`
        : `Could not navigate to target page after 3 attempts for "${userMessage}"`;

      logger.warn('[EXPLORATION] Navigation requires user clarification', {
        url,
        userMessage: userMessage.substring(0, 100),
        reason: navigationResult.reason,
        attempts: navigationResult.attempts,
      });

      // Cleanup before throwing error
      try {
        await page.close();
        await context.close();
      } catch (cleanupError) {
        logger.warn('[EXPLORATION] Cleanup failed before throwing navigation error', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      throw new NavigationRequiresClarificationError(
        errorMsg,
        url,
        userMessage,
        navigationResult.reason
      );
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
    // Re-throw NavigationRequiresClarificationError
    if (navError instanceof NavigationRequiresClarificationError) {
      throw navError;
    }

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
