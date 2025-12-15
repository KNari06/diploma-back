/**
 * SafetyGuard
 * Validates actions for dangerous operations
 * Prevents destructive actions and enforces limits
 */

import { logger } from '@/utils/logger';
import {
  DynamicAction,
  PageContext,
  SafetyCheckResult,
  SafetyConfig,
  TestState,
} from './types/intelligent-testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT SAFETY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  level: 'normal',
  maxPages: 10,
  maxDuration: 5 * 60 * 1000, // 5 minutes
  maxCost: 0.5, // $0.50
  allowedDomains: [], // Empty = only base domain
  forbiddenActions: [
    'delete',
    'remove',
    'destroy',
    'cancel subscription',
    'unsubscribe',
    'pay',
    'purchase',
    'buy now',
    'confirm payment',
    'place order',
    'checkout',
    'submit payment',
  ],
  forbiddenUrls: [
    '/payment',
    '/billing',
    '/delete',
    '/remove',
    '/destroy',
    '/cancel',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY GUARD
// ═══════════════════════════════════════════════════════════════════════════

export class SafetyGuard {
  /**
   * Check if target URL is within allowed domains.
   * Uses hostname matching (exact or subdomain), not substring matching.
   */
  private static isAllowedDomain(targetUrl: string, allowedDomains: string[]): boolean {
    // Validate inputs
    if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
      return false;
    }
    if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
      return false;
    }

    try {
      const urlObj = new URL(targetUrl);
      let host = urlObj.hostname.toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);

      return allowedDomains.some((d) => {
        if (!d || typeof d !== 'string') return false;
        let domain = d.toLowerCase().trim();
        if (!domain) return false;
        if (domain.startsWith('www.')) domain = domain.slice(4);
        // exact match or subdomain match
        return host === domain || host.endsWith(`.${domain}`);
      });
    } catch {
      // If URL is malformed, be conservative
      return false;
    }
  }

  /**
   * Check if action is safe to execute
   * @param action - Action to validate
   * @param context - Current page context
   * @param config - Safety configuration
   * @returns Safety check result
   */
  static checkAction(
    action: DynamicAction,
    context: PageContext,
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG
  ): SafetyCheckResult {
    // Validate inputs
    if (!action || !context || !config) {
      logger.warn('[SAFETY_GUARD] Invalid inputs provided to checkAction', {
        hasAction: !!action,
        hasContext: !!context,
        hasConfig: !!config,
      });
      return {
        safe: false,
        reason: 'Invalid safety check inputs',
        suggestedAction: 'Skip this action',
      };
    }

    logger.debug('[SAFETY_GUARD] Checking action', {
      action: action.action,
      description: action.description,
    });

    // Check 1: Dangerous keywords in action description
    const dangerousKeywords = this.checkDangerousKeywords(
      action,
      config
    );
    if (!dangerousKeywords.safe) {
      return dangerousKeywords;
    }

    // Check 2: Payment/billing page
    const paymentCheck = this.checkPaymentPage(context, action, config);
    if (!paymentCheck.safe) {
      return paymentCheck;
    }

    // Check 3: CAPTCHA detection
    const captchaCheck = this.checkCaptcha(context);
    if (!captchaCheck.safe) {
      return captchaCheck;
    }

    // Check 4: URL validation
    const urlCheck = this.checkUrl(action, context, config);
    if (!urlCheck.safe) {
      return urlCheck;
    }

    // All checks passed
    return {
      safe: true,
    };
  }

  /**
   * Check if test state exceeds limits
   * @param state - Current test state
   * @param config - Safety configuration
   * @returns Safety check result
   */
  static checkLimits(
    state: TestState,
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG
  ): SafetyCheckResult {
    // Validate inputs
    if (!state || !config) {
      logger.warn('[SAFETY_GUARD] Invalid inputs provided to checkLimits', {
        hasState: !!state,
        hasConfig: !!config,
      });
      return {
        safe: false,
        reason: 'Invalid safety check inputs',
        suggestedAction: 'Stop testing',
      };
    }

    // Validate state properties
    const pagesAnalyzed = typeof state.pagesAnalyzed === 'number' && isFinite(state.pagesAnalyzed) ? state.pagesAnalyzed : 0;
    const startTime = typeof state.startTime === 'number' && isFinite(state.startTime) && state.startTime > 0 ? state.startTime : Date.now();
    const estimatedCost = typeof state.estimatedCost === 'number' && isFinite(state.estimatedCost) && state.estimatedCost >= 0 ? state.estimatedCost : 0;
    const errors = Array.isArray(state.errors) ? state.errors : [];
    const completedActions = Array.isArray(state.completedActions) ? state.completedActions : [];

    // Check page limit
    if (pagesAnalyzed >= config.maxPages) {
      logger.warn('[SAFETY_GUARD] Page limit exceeded', {
        analyzed: pagesAnalyzed,
        limit: config.maxPages,
      });

      return {
        safe: false,
        reason: `Page limit exceeded (${pagesAnalyzed}/${config.maxPages})`,
        suggestedAction: 'Stop testing and report results',
      };
    }

    // Check duration limit
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.maxDuration && elapsed > 0) {
      logger.warn('[SAFETY_GUARD] Duration limit exceeded', {
        elapsed: `${Math.round(elapsed / 1000)}s`,
        limit: `${Math.round(config.maxDuration / 1000)}s`,
      });

      return {
        safe: false,
        reason: `Duration limit exceeded (${Math.round(elapsed / 1000)}s)`,
        suggestedAction: 'Stop testing and report results',
      };
    }

    // Check cost limit
    if (estimatedCost >= config.maxCost) {
      logger.warn('[SAFETY_GUARD] Cost limit exceeded', {
        cost: `$${estimatedCost.toFixed(3)}`,
        limit: `$${config.maxCost}`,
      });

      return {
        safe: false,
        reason: `Cost limit exceeded ($${estimatedCost.toFixed(3)})`,
        suggestedAction: 'Stop testing to avoid additional costs',
      };
    }

    // Check error rate
    const totalActions = completedActions.length;
    const errorRate = totalActions > 0 ? errors.length / totalActions : 0;
    if (isFinite(errorRate) && errorRate > 0.5 && totalActions > 5) {
      logger.warn('[SAFETY_GUARD] High error rate', {
        errors: errors.length,
        actions: totalActions,
        rate: `${Math.round(errorRate * 100)}%`,
      });

      return {
        safe: false,
        reason: `High error rate (${Math.round(errorRate * 100)}%)`,
        suggestedAction: 'Stop testing, too many failures',
      };
    }

    // All limits OK
    return {
      safe: true,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INDIVIDUAL CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check for dangerous keywords in action
   */
  private static checkDangerousKeywords(
    action: DynamicAction,
    config: SafetyConfig
  ): SafetyCheckResult {
    // Validate inputs
    if (!action || !config) {
      return { safe: true }; // Fail-safe: allow if can't check
    }

    const description = action.description || '';
    const selector = action.selector || '';
    const value = action.value || '';
    const textToCheck = `${description} ${selector} ${value}`.toLowerCase();

    // Validate forbiddenActions array
    const forbiddenActions = Array.isArray(config.forbiddenActions) ? config.forbiddenActions : [];
    if (forbiddenActions.length === 0) {
      return { safe: true };
    }

    for (const forbidden of forbiddenActions) {
      if (!forbidden || typeof forbidden !== 'string') {
        continue; // Skip invalid entries
      }
      if (textToCheck.includes(forbidden.toLowerCase())) {
        logger.warn('[SAFETY_GUARD] Dangerous keyword detected', {
          keyword: forbidden,
          action: action.description,
        });

        return {
          safe: false,
          reason: `Action contains dangerous keyword: "${forbidden}"`,
          requiresApproval: true,
          suggestedAction: 'Skip this action or request manual approval',
        };
      }
    }

    return { safe: true };
  }

  /**
   * Check if current page is payment/billing
   */
  private static checkPaymentPage(
    context: PageContext,
    action: DynamicAction,
    config: SafetyConfig
  ): SafetyCheckResult {
    // Validate inputs
    if (!context || !action) {
      return { safe: true }; // Fail-safe: allow if can't check
    }

    // Check page type
    if (context.pageType === 'payment' || context.pageType === 'checkout') {
      logger.warn('[SAFETY_GUARD] Payment page detected', {
        pageType: context.pageType,
        url: context.url,
      });

      // Allow read-only actions
      if (action.action === 'wait' || action.action === 'scroll') {
        return { safe: true };
      }

      return {
        safe: false,
        reason: 'Payment/checkout page detected',
        requiresApproval: true,
        suggestedAction: 'Requires manual approval to proceed',
      };
    }

    // Check warnings
    const warnings = Array.isArray(context.warnings) ? context.warnings : [];
    if (warnings.some(w => w && typeof w === 'string' && w.toLowerCase().includes('payment'))) {
      logger.warn('[SAFETY_GUARD] Payment warning in context', {
        warnings: warnings,
      });

      return {
        safe: false,
        reason: 'Payment form detected on page',
        requiresApproval: true,
        suggestedAction: 'Requires manual approval',
      };
    }

    return { safe: true };
  }

  /**
   * Check for CAPTCHA
   */
  private static checkCaptcha(context: PageContext): SafetyCheckResult {
    // Validate inputs
    if (!context) {
      return { safe: true }; // Fail-safe: allow if can't check
    }

    const warnings = Array.isArray(context.warnings) ? context.warnings : [];
    const captchaWarnings = warnings.filter(w =>
      w && typeof w === 'string' && w.toLowerCase().includes('captcha')
    );

    if (captchaWarnings.length > 0) {
      logger.warn('[SAFETY_GUARD] CAPTCHA detected', {
        warnings: captchaWarnings,
      });

      return {
        safe: false,
        reason: 'CAPTCHA detected, requires manual intervention',
        requiresApproval: true,
        suggestedAction: 'Pause and notify user',
      };
    }

    return { safe: true };
  }

  /**
   * Check URL safety
   */
  private static checkUrl(
    action: DynamicAction,
    context: PageContext,
    config: SafetyConfig
  ): SafetyCheckResult {
    // Validate inputs
    if (!action || !context || !config) {
      return { safe: true }; // Fail-safe: allow if can't check
    }

    // Check current URL
    const currentUrl = (context.url || '').toLowerCase();
    if (!currentUrl) {
      return { safe: true }; // Can't check empty URL
    }

    const forbiddenUrls = Array.isArray(config.forbiddenUrls) ? config.forbiddenUrls : [];
    for (const forbidden of forbiddenUrls) {
      if (!forbidden || typeof forbidden !== 'string') {
        continue; // Skip invalid entries
      }
      if (currentUrl.includes(forbidden.toLowerCase())) {
        logger.warn('[SAFETY_GUARD] Forbidden URL pattern', {
          url: context.url,
          pattern: forbidden,
        });

        return {
          safe: false,
          reason: `URL matches forbidden pattern: "${forbidden}"`,
          suggestedAction: 'Avoid this page',
        };
      }
    }

    // Check target URL (for goto actions)
    if (action.action === 'goto' && action.url && typeof action.url === 'string' && action.url.trim()) {
      const targetUrl = action.url.toLowerCase();

      for (const forbidden of forbiddenUrls) {
        if (!forbidden || typeof forbidden !== 'string') {
          continue; // Skip invalid entries
        }
        if (targetUrl.includes(forbidden.toLowerCase())) {
          logger.warn('[SAFETY_GUARD] Attempting to navigate to forbidden URL', {
            targetUrl: action.url,
            pattern: forbidden,
          });

          return {
            safe: false,
            reason: `Target URL matches forbidden pattern: "${forbidden}"`,
            suggestedAction: 'Skip navigation',
          };
        }
      }

      // Check domain if allowedDomains is set
      const allowedDomains = Array.isArray(config.allowedDomains) ? config.allowedDomains : [];
      if (allowedDomains.length > 0) {
        const isAllowed = this.isAllowedDomain(action.url, allowedDomains);

        if (!isAllowed) {
          logger.warn('[SAFETY_GUARD] Domain not in allowed list', {
            targetUrl: action.url,
            allowedDomains: config.allowedDomains,
          });

          return {
            safe: false,
            reason: 'Target domain not in allowed list',
            requiresApproval: true,
            suggestedAction: 'Request approval for external navigation',
          };
        }
      }
    }

    return { safe: true };
  }

}
