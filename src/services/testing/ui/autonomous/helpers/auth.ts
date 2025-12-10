import { detectLoginPage } from '@/services/ai/ai-helpers.service';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';

/**
 * Perform authentication before exploring protected pages
 * ✅ ENHANCED: Added timeout, success verification, and better error handling
 */
export async function performAuthentication(
  page: Page,
  targetUrl: string,
  credentials: { email?: string; username?: string; password: string }
): Promise<void> {
  // Wrap entire auth flow in timeout (30 seconds max)
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

  // Track if fields were filled
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

  // Check if username was filled
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

  // Check if password was filled
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

  // Wait for navigation with better handling
  try {
    await page.waitForNavigation({ timeout: 5000 });
    logger.info('Navigation detected after login');
  } catch {
    // No navigation - maybe same-page auth (SPA)
    logger.debug('No navigation after login, checking for error messages');
  }

  // Verify authentication success
  const currentUrl = page.url();
  const hasPasswordField = await page.locator('input[type="password"]').count();

  // If still on login page (has password field) - auth likely failed
  if (hasPasswordField > 0 && currentUrl.includes('login')) {
    logger.warn('Still on login page after authentication, login may have failed');
  } else {
    logger.info('Authentication appears successful', { currentUrl });
  }
}
