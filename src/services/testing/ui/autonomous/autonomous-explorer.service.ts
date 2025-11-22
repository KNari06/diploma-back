import { browserPool } from '@/agent';
import { detectLoginPage } from '@/services/ai/ai-helpers.service';
import { analyzeScreenshotWithVision } from '@/services/ai/vision-analyzer.service';
import { analyzeDOMStructure } from '@/services/testing/ui/autonomous/dom-analyzer.service';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import sharp from 'sharp';

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
 * ✅ ENHANCED: Fixed memory leaks, timeouts, and error handling
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
  sessionId?: string; // ✅ NEW: For real-time WebSocket updates
}): Promise<ExplorationResult> {
  const { url, scope, credentials, needsAuth, sessionId } = options;

  logger.info('Starting autonomous product exploration', {
    url,
    scope,
    needsAuth,
    hasSessionId: !!sessionId,
  });

  // ✅ Helper to emit real-time progress via WebSocket
  const emitExplorationProgress = (message: string) => {
    if (sessionId) {
      try {
        const { webSocketService } = require('@/websocket/websocket.service');
        const stepPayload = {
          sessionId,
          step: 'analyzing' as any,
          message,
          progress: 40, // Fixed progress during exploration
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitChatProcessingStep(sessionId, stepPayload);
      } catch (wsError) {
        logger.warn('[EXPLORATION] Failed to emit WebSocket event', {
          error: wsError instanceof Error ? wsError.message : String(wsError),
        });
      }
    }
  };

  let page: Page | null = null;
  let context: any = null; // ✅ Track context for cleanup

  try {
    // 1. Launch browser
    emitExplorationProgress('🌐 Connecting to browser...');
    const browser = await browserPool.getBrowser('chrome');
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    page = await context.newPage();

    // Assert page is not null for TypeScript
    if (!page) {
      throw new Error('Failed to create page');
    }

    // 2. Handle authentication if needed
    if (needsAuth && credentials) {
      logger.info('Performing authentication before exploration');
      emitExplorationProgress('🔐 Performing authentication...');
      await performAuthentication(page, url, credentials);
    }

    // 3. Navigate to target URL
    logger.info('Navigating to target URL', { url });
    emitExplorationProgress(`📄 Opening page ${url}...`);

    // ✅ FIX: Use 'domcontentloaded' instead of 'networkidle' (more reliable for SPAs)
    await page.goto(url, {
      waitUntil: 'domcontentloaded', // Faster + more reliable than networkidle
      timeout: 30000,
    });

    // ✅ FIX: Smart wait - wait for network to be idle OR max 3 seconds
    try {
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 3000 }),
        page.waitForTimeout(3000),
      ]);
    } catch {
      // If networkidle times out, continue anyway (SPA may not reach networkidle)
      logger.debug('Network not idle after 3s, continuing...');
    }

    // 4. Capture full page screenshot
    logger.info('Capturing screenshot');
    emitExplorationProgress('📸 Taking page screenshot...');

    // ✅ FIX: Limit screenshot height to prevent huge images (max 10,000px)
    const viewportHeight = await page.evaluate(() => {
      // @ts-expect-error - browser context
      return window.innerHeight;
    });
    const fullHeight = await page.evaluate(() => {
      // @ts-expect-error - browser context
      return document.body.scrollHeight;
    });
    const maxHeight = Math.min(fullHeight, 10000); // Cap at 10k pixels

    // ✅ FIX: Capture at high quality first, then resize for GPT-4o Vision
    const screenshot = await page.screenshot({
      fullPage: fullHeight <= 10000, // Only full page if reasonable size
      clip: fullHeight > 10000 ? {
        x: 0,
        y: 0,
        width: 1920,
        height: 10000,
      } : undefined,
      type: 'png',
    });

    // ✅ FIX: Resize screenshot to fit GPT-4o Vision optimal size (1024x1024 max)
    // Using sharp for high-quality resize without distortion
    const metadata = await sharp(screenshot).metadata();
    const originalWidth = metadata.width || 1920;
    const originalHeight = metadata.height || fullHeight;

    logger.debug('Original screenshot dimensions', {
      width: originalWidth,
      height: originalHeight,
    });

    // Calculate resize dimensions maintaining aspect ratio
    // Target: max 1024 on longest side (GPT-4o Vision optimal)
    const MAX_DIMENSION = 1024;
    let resizeWidth = originalWidth;
    let resizeHeight = originalHeight;

    if (originalWidth > MAX_DIMENSION || originalHeight > MAX_DIMENSION) {
      const aspectRatio = originalWidth / originalHeight;

      if (originalWidth > originalHeight) {
        // Landscape - limit width to 1024
        resizeWidth = MAX_DIMENSION;
        resizeHeight = Math.round(MAX_DIMENSION / aspectRatio);
      } else {
        // Portrait - limit height to 1024
        resizeHeight = MAX_DIMENSION;
        resizeWidth = Math.round(MAX_DIMENSION * aspectRatio);
      }

      logger.info('Resizing screenshot for GPT-4o Vision', {
        original: `${originalWidth}x${originalHeight}`,
        resized: `${resizeWidth}x${resizeHeight}`,
        aspectRatio: aspectRatio.toFixed(2),
      });
    }

    // Resize with high-quality settings
    const resizedScreenshot = await sharp(screenshot)
      .resize(resizeWidth, resizeHeight, {
        fit: 'inside', // Maintain aspect ratio, fit inside dimensions
        withoutEnlargement: true, // Don't upscale if smaller
        kernel: 'lanczos3', // High-quality resampling (best for downscaling)
      })
      .png({
        quality: 90, // High quality PNG
        compressionLevel: 6, // Balanced compression (0-9)
      })
      .toBuffer();

    const screenshotBase64 = resizedScreenshot.toString('base64');

    // Check final screenshot size
    const screenshotSizeMB = Buffer.byteLength(screenshotBase64, 'base64') / (1024 * 1024);
    logger.info('Screenshot processed for GPT-4o Vision', {
      finalSize: `${resizeWidth}x${resizeHeight}`,
      sizeMB: screenshotSizeMB.toFixed(2),
      originalDimensions: `${originalWidth}x${originalHeight}`,
    });

    // 5. Get page info
    // ✅ FIX: Add try-catch for page.evaluate
    let pageInfo;
    try {
      pageInfo = await page.evaluate(() => {
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
    } catch (evalError) {
      logger.warn('Failed to evaluate page info, using defaults', {
        error: evalError instanceof Error ? evalError.message : String(evalError),
      });
      pageInfo = {
        title: 'Unknown',
        url,
        hasAuth: false,
      };
    }

    // 6. Analyze with GPT-4o Vision (parallel)
    logger.info('Analyzing screenshot with GPT-4o Vision');
    emitExplorationProgress('🤖 Analyzing screenshot with GPT-4o Vision...');
    const visualAnalysisPromise = analyzeScreenshotWithVision(screenshotBase64, {
      scope,
      url,
    });

    // 7. Analyze DOM structure (parallel)
    logger.info('Analyzing DOM structure');
    emitExplorationProgress('🔍 Analyzing DOM structure...');
    const domAnalysisPromise = analyzeDOMStructure(page);

    // ✅ FIX: Add timeout for parallel analysis (30 seconds max)
    const ANALYSIS_TIMEOUT = 30000;

    let visualResult, domResult;
    try {
      [visualResult, domResult] = await Promise.race([
        Promise.allSettled([visualAnalysisPromise, domAnalysisPromise]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Analysis timeout after 30s')), ANALYSIS_TIMEOUT)
        ),
      ]);
    } catch (timeoutError) {
      logger.error('Analysis timed out, using fallback data', {
        error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError),
      });

      // Create rejected results for both
      visualResult = { status: 'rejected' as const, reason: 'Timeout' };
      domResult = { status: 'rejected' as const, reason: 'Timeout' };
    }

    // Create fallback objects with correct structure if analysis failed
    const visualAnalysis = visualResult.status === 'fulfilled'
      ? visualResult.value
      : {
          elements: [],
          layout: 'unknown',
          suggestions: [],
        };

    const domAnalysis = domResult.status === 'fulfilled'
      ? domResult.value
      : {
          forms: [],
          buttons: [],
          links: [],
          inputs: [],
        };

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

    // ✅ FIX: Proper cleanup - close page and context
    try {
      if (page) await page.close();
      if (context) await context.close();
    } catch (cleanupError) {
      logger.warn('Failed to cleanup page/context', {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

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

    // ✅ FIX: Cleanup both page AND context on error
    try {
      if (page) await page.close();
      if (context) await context.close();
    } catch (cleanupError) {
      logger.warn('Failed to cleanup after error', {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    throw error;
  }
}

/**
 * Perform authentication before exploring protected pages
 * ✅ ENHANCED: Added timeout, success verification, and better error handling
 */
async function performAuthentication(
  page: Page,
  targetUrl: string,
  credentials: { email?: string; username?: string; password: string }
): Promise<void> {
  // ✅ FIX: Wrap entire auth flow in timeout (30 seconds max)
  const AUTH_TIMEOUT = 30000;

  try {
    await Promise.race([
      performAuthenticationInternal(page, targetUrl, credentials),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Authentication timeout after 30s')), AUTH_TIMEOUT)
      ),
    ]);
  } catch (error) {
    logger.warn('Authentication failed or timed out, continuing without auth', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Internal authentication logic (wrapped by timeout)
 */
async function performAuthenticationInternal(
  page: Page,
  targetUrl: string,
  credentials: { email?: string; username?: string; password: string }
): Promise<void> {
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

  // ✅ FIX: Track if fields were filled
  let usernameFilled = false;
  let passwordFilled = false;

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
        usernameFilled = true;
        break;
      }
    } catch {
      continue;
    }
  }

  // ✅ FIX: Check if username was filled
  if (!usernameFilled) {
    logger.warn('Could not find username/email field, aborting authentication');
    return;
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
        passwordFilled = true;
        break;
      }
    } catch {
      continue;
    }
  }

  // ✅ FIX: Check if password was filled
  if (!passwordFilled) {
    logger.warn('Could not find password field, aborting authentication');
    return;
  }

  // Click submit button
  let submitClicked = false;
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
        submitClicked = true;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!submitClicked) {
    logger.warn('Could not find submit button, aborting authentication');
    return;
  }

  // ✅ FIX: Wait for navigation with better handling
  try {
    await page.waitForNavigation({ timeout: 5000 });
    logger.info('Navigation detected after login');
  } catch {
    // No navigation - maybe same-page auth (SPA)
    logger.debug('No navigation after login, checking for error messages');
  }

  // ✅ FIX: Verify authentication success
  const currentUrl = page.url();
  const hasPasswordField = await page.locator('input[type="password"]').count();

  // If still on login page (has password field) - auth likely failed
  if (hasPasswordField > 0 && currentUrl.includes('login')) {
    logger.warn('Still on login page after authentication, login may have failed');
  } else {
    logger.info('Authentication appears successful', { currentUrl });
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
  // ✅ FIX: Cache toLowerCase result
  const scopeLower = scope.toLowerCase();

  if (scopeLower.includes('регистрац') || scopeLower.includes('register')) {
    recommendations.push('Test password strength validation');
    recommendations.push('Test email format validation');
    recommendations.push('Test redirect after successful registration');
  }

  if (scopeLower.includes('логин') || scopeLower.includes('login')) {
    recommendations.push('Test login with invalid credentials');
    recommendations.push('Test "Forgot password" link');
  }

  return recommendations.slice(0, 8); // Max 8 recommendations
}
