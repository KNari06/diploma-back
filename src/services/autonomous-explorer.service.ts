import { browserPool } from '@/agent';
import { detectLoginPage } from '@/services/ai-helpers.service';
import { analyzeDOMStructure } from '@/services/dom-analyzer.service';
import { analyzeScreenshotWithVision } from '@/services/vision-analyzer.service';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';

/**
 * Product exploration result
 */
export interface ExplorationResult {
  url: string;
  timestamp: string;
  screenshot: string; // base64
  visualAnalysis: {
    elements: Array<{
      type: string;
      purpose: string;
      location: string;
      required?: boolean;
    }>;
    layout: string;
    suggestions: string[];
  };
  domAnalysis: {
    forms: Array<{
      id?: string;
      action?: string;
      method?: string;
      fields: Array<{
        name: string;
        type: string;
        required: boolean;
        selector: string;
        placeholder?: string;
      }>;
    }>;
    buttons: Array<{
      text: string;
      selector: string;
      type: string;
    }>;
    links: Array<{
      text: string;
      href: string;
      selector: string;
    }>;
    inputs: Array<{
      type: string;
      name?: string;
      placeholder?: string;
      selector: string;
      required: boolean;
    }>;
  };
  pageInfo: {
    title: string;
    url: string;
    hasAuth: boolean;
  };
  recommendations: string[];
}

/**
 * Autonomously explore a product page
 */
export async function exploreProduct(options: {
  url: string;
  scope: string;
  credentials?: {
    email?: string;
    username?: string;
    password: string;
  };
  needsAuth?: boolean;
}): Promise<ExplorationResult> {
  const { url, scope, credentials, needsAuth } = options;

  logger.info('Starting autonomous product exploration', {
    url,
    scope,
    needsAuth,
  });

  let page: Page | null = null;

  try {
    // 1. Launch browser
    const browser = await browserPool.getBrowser('chrome');
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    page = await context.newPage();

    // 2. Handle authentication if needed
    if (needsAuth && credentials) {
      logger.info('Performing authentication before exploration');
      await performAuthentication(page, url, credentials);
    }

    // 3. Navigate to target URL
    logger.info('Navigating to target URL', { url });
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for page to settle
    await page.waitForTimeout(2000);

    // 4. Capture full page screenshot
    logger.info('Capturing screenshot');
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'png',
    });
    const screenshotBase64 = screenshot.toString('base64');

    // 5. Get page info
    const pageInfo = await page.evaluate(() => {
      // eslint-disable-next-line
      // @ts-expect-error - browser context
      const hasPasswordField = !!document.querySelector('[type="password"]');
      // @ts-expect-error
      const hasAuthCookie = document.cookie.includes('auth') || document.cookie.includes('session');

      return {
        // @ts-expect-error
        title: document.title,
        // @ts-expect-error
        url: window.location.href,
        hasAuth: hasPasswordField || hasAuthCookie,
      };
    });

    // 6. Analyze with GPT-4o Vision (parallel)
    logger.info('Analyzing screenshot with GPT-4o Vision');
    const visualAnalysisPromise = analyzeScreenshotWithVision(screenshotBase64, {
      scope,
      url,
    });

    // 7. Analyze DOM structure (parallel)
    logger.info('Analyzing DOM structure');
    const domAnalysisPromise = analyzeDOMStructure(page);

    // Wait for both analyses
    // Use Promise.allSettled to handle individual failures gracefully
    const [visualResult, domResult] = await Promise.allSettled([
      visualAnalysisPromise,
      domAnalysisPromise,
    ]);

    const visualAnalysis = visualResult.status === 'fulfilled'
      ? visualResult.value
      : { error: visualResult.reason instanceof Error ? visualResult.reason.message : String(visualResult.reason) };

    const domAnalysis = domResult.status === 'fulfilled'
      ? domResult.value
      : { error: domResult.reason instanceof Error ? domResult.reason.message : String(domResult.reason) };

    if (visualResult.status === 'rejected') {
      logger.warn('Visual analysis failed', { error: visualResult.reason });
    }
    if (domResult.status === 'rejected') {
      logger.warn('DOM analysis failed', { error: domResult.reason });
    }

    // 8. Generate recommendations
    const recommendations = generateTestRecommendations(
      visualAnalysis,
      domAnalysis,
      scope
    );

    // Close page and context
    await page.close();
    await context.close();

    const result: ExplorationResult = {
      url,
      timestamp: new Date().toISOString(),
      screenshot: `data:image/png;base64,${screenshotBase64}`,
      visualAnalysis,
      domAnalysis,
      pageInfo,
      recommendations,
    };

    logger.info('Product exploration completed successfully', {
      url,
      formsFound: domAnalysis.forms.length,
      buttonsFound: domAnalysis.buttons.length,
      recommendationsCount: recommendations.length,
    });

    return result;
  } catch (error) {
    logger.error('Product exploration failed', { error, url });

    if (page) {
      await page.close();
    }

    throw error;
  }
}

/**
 * Perform authentication before exploring protected pages
 */
async function performAuthentication(
  page: Page,
  targetUrl: string,
  credentials: { email?: string; username?: string; password: string }
): Promise<void> {
  try {
    // Try to find login page (hybrid: hardcode + AI)
    const baseUrl = new URL(targetUrl).origin;

    // First navigate to homepage for AI detection
    await page.goto(baseUrl, { timeout: 10000, waitUntil: 'domcontentloaded' });

    // Try AI-powered detection (includes hardcode fallback)
    const loginPage = await detectLoginPage(baseUrl, page);

    if (!loginPage) {
      logger.warn('Could not find login page, proceeding without auth');
      return;
    }

    logger.info('Found login page', { loginPage });

    // Fill credentials
    const emailOrUsername = credentials.email || credentials.username;

    // Try common selectors for email/username
    const usernameSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
      '#email',
      '#username',
    ];

    for (const selector of usernameSelectors) {
      try {
        const field = await page.locator(selector).first();
        if (await field.isVisible()) {
          await field.fill(emailOrUsername!);
          logger.info('Filled username/email field', { selector });
          break;
        }
      } catch {
        continue;
      }
    }

    // Fill password
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
    ];

    for (const selector of passwordSelectors) {
      try {
        const field = await page.locator(selector).first();
        if (await field.isVisible()) {
          await field.fill(credentials.password);
          logger.info('Filled password field', { selector });
          break;
        }
      } catch {
        continue;
      }
    }

    // Click submit button
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'input[type="submit"]',
    ];

    for (const selector of submitSelectors) {
      try {
        const button = await page.locator(selector).first();
        if (await button.isVisible()) {
          await button.click();
          logger.info('Clicked submit button', { selector });
          break;
        }
      } catch {
        continue;
      }
    }

    // Wait for navigation or error message
    await Promise.race([
      page.waitForNavigation({ timeout: 5000 }),
      page.waitForTimeout(3000),
    ]);

    logger.info('Authentication attempt completed');
  } catch (error) {
    logger.warn('Authentication failed, continuing without auth', { error });
  }
}

/**
 * Generate test recommendations based on exploration
 */
function generateTestRecommendations(
  visualAnalysis: any,
  domAnalysis: any,
  scope: string
): string[] {
  const recommendations: string[] = [];

  // Form-based recommendations
  if (domAnalysis.forms.length > 0) {
    recommendations.push('Test form validation (empty fields, invalid data)');
    recommendations.push('Test successful form submission');

    const requiredFields = domAnalysis.forms[0]?.fields.filter((f: any) => f.required);
    if (requiredFields && requiredFields.length > 0) {
      recommendations.push(`Test required fields: ${requiredFields.map((f: any) => f.name).join(', ')}`);
    }
  }

  // Button-based recommendations
  if (domAnalysis.buttons.length > 0) {
    const submitButtons = domAnalysis.buttons.filter((b: any) =>
      b.type === 'submit' || b.text.toLowerCase().includes('submit')
    );
    if (submitButtons.length > 0) {
      recommendations.push('Test button click and response');
    }
  }

  // Visual analysis recommendations
  if (visualAnalysis.suggestions) {
    recommendations.push(...visualAnalysis.suggestions.slice(0, 3));
  }

  // Scope-specific recommendations
  if (scope.toLowerCase().includes('регистрац') || scope.toLowerCase().includes('register')) {
    recommendations.push('Test password strength validation');
    recommendations.push('Test email format validation');
    recommendations.push('Test redirect after successful registration');
  }

  if (scope.toLowerCase().includes('логин') || scope.toLowerCase().includes('login')) {
    recommendations.push('Test login with invalid credentials');
    recommendations.push('Test "Forgot password" link');
  }

  return recommendations.slice(0, 8); // Max 8 recommendations
}
