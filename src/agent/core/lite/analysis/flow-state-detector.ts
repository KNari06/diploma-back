/**
 * FlowStateDetector
 * Detects current step in multi-step flows (login, register, checkout)
 * Helps AI understand context and make correct next decisions
 */

import { logger } from '@/utils/core/logger';
import type { FlowState, FlowStep, LiteElement } from '../lite-types';

/**
 * Detect current flow state based on URL, page content, and previous state
 */
export class FlowStateDetector {
  private testId: string;
  private goal: string;

  constructor(testId: string, goal: string) {
    this.testId = testId;
    this.goal = goal.toLowerCase();
  }

  /**
   * Detect current flow state
   *
   * @param url - Current page URL
   * @param elements - Page elements
   * @param previousState - Previous flow state (for tracking transitions)
   * @returns Detected flow state or null
   */
  detect(
    url: string,
    elements: LiteElement[],
    previousState?: FlowState
  ): FlowState | null {
    // Determine flow type from goal
    const flowType = this.detectFlowType();
    if (flowType === 'unknown') {
      return null; // Not a tracked flow
    }

    // Detect current step
    const currentStep = this.detectStep(url, elements);

    // Build flow state
    const state: FlowState = {
      flowType,
      currentStep,
      previousStep: previousState?.currentStep,
      timestamp: Date.now(),
      confidence: this.calculateConfidence(currentStep, url, elements),
    };

    // Log state transitions
    if (previousState && previousState.currentStep !== currentStep) {
      logger.info('[FLOW_STATE] Step transition detected', {
        testId: this.testId,
        flowType,
        from: previousState.currentStep,
        to: currentStep,
        url: url.slice(0, 100),
      });
    }

    return state;
  }

  /**
   * Detect flow type from goal
   */
  private detectFlowType(): 'login' | 'register' | 'checkout' | 'unknown' {
    if (/login|sign\s*in|log\s*in|auth|вход|войти/i.test(this.goal)) {
      return 'login';
    }
    if (/register|sign\s*up|create\s+account|зарегистр|регистрац/i.test(this.goal)) {
      return 'register';
    }
    if (/checkout|payment|pay|order|purchase/i.test(this.goal)) {
      return 'checkout';
    }
    return 'unknown';
  }

  /**
   * Detect current step based on URL and page content
   */
  private detectStep(
    url: string,
    elements: LiteElement[]
  ): FlowStep {
    const urlLower = url.toLowerCase();

    // Step 1: Check for success state
    if (this.isSuccessState(urlLower, elements)) {
      return 'success';
    }

    // Step 2: Check for error state
    if (this.isErrorState(urlLower, elements)) {
      return 'error';
    }

    // Step 3: Check for intermediate verification steps
    if (urlLower.includes('verify') || urlLower.includes('confirm')) {
      if (this.hasKeywords(elements, ['email', 'почт'])) {
        return 'verify_email';
      }
      if (this.hasKeywords(elements, ['phone', 'sms', 'телефон'])) {
        return 'verify_phone';
      }
      if (this.hasKeywords(elements, ['2fa', 'mfa', 'otp', 'code', 'authenticator'])) {
        return 'verify_2fa';
      }
      return 'verify_email'; // Default to email verification
    }

    // Step 4: Check for password reset
    if (urlLower.includes('reset') || urlLower.includes('forgot') || urlLower.includes('recover')) {
      return 'reset_password';
    }

    // Step 5: Check for profile completion
    if (urlLower.includes('complete') || urlLower.includes('onboarding') || urlLower.includes('setup')) {
      return 'complete_profile';
    }

    // Step 6: Check for 2FA verification (in content)
    if (this.hasKeywords(elements, ['2fa', 'two-factor', 'authenticator', 'verification code', 'enter code'])) {
      return 'verify_2fa';
    }

    // Step 7: Check for auth form visible
    const hasPasswordField = elements.some(el => el.type === 'password' && el.visible);
    const hasEmailField = elements.some(
      el => (el.type === 'email' || el.htmlName?.toLowerCase().includes('email')) && el.visible
    );

    if (hasPasswordField && hasEmailField) {
      return 'form_visible';
    }

    // Step 8: Check if on auth page but form not yet visible
    const onAuthPage = ['login', 'signin', 'sign-in', 'register', 'signup', 'auth'].some(
      pattern => urlLower.includes(pattern)
    );
    if (onAuthPage) {
      return 'initial';
    }

    // Step 9: Check for redirect in progress (URL changed, no form, not success)
    if (!hasPasswordField && !hasEmailField && !onAuthPage) {
      return 'redirecting';
    }

    // Default: initial state
    return 'initial';
  }

  /**
   * Check if current state is success
   */
  private isSuccessState(url: string, elements: LiteElement[]): boolean {
    // Success URL patterns
    const successUrlPatterns = [
      'dashboard', 'home', 'welcome', 'profile', 'account', 'app',
      'logged-in', 'success', 'complete', 'thank-you'
    ];

    const hasSuccessUrl = successUrlPatterns.some(pattern => url.includes(pattern));

    // Success content keywords
    const successKeywords = [
      'welcome', 'dashboard', 'logged in', 'successfully', 'success',
      'добро пожаловать', 'успешно', 'авторизован'
    ];

    const hasSuccessContent = this.hasKeywords(elements, successKeywords);

    // Check for logout button (indicates authenticated state)
    const hasLogoutButton = elements.some(el =>
      (el.tag === 'button' || el.tag === 'a') &&
      (el.name?.toLowerCase().includes('logout') || el.name?.toLowerCase().includes('выйти'))
    );

    // Success if:
    // - URL indicates success AND content matches
    // - OR logout button present (strong signal of authenticated state)
    return (hasSuccessUrl && hasSuccessContent) || hasLogoutButton;
  }

  /**
   * Check if current state is error
   */
  private isErrorState(url: string, elements: LiteElement[]): boolean {
    // Error URL patterns
    const errorUrlPatterns = ['error', 'invalid', 'denied', 'failed'];
    const hasErrorUrl = errorUrlPatterns.some(pattern => url.includes(pattern));

    // Error content keywords
    const errorKeywords = [
      'error', 'invalid', 'failed', 'denied', 'incorrect', 'wrong',
      'ошибка', 'неверн', 'некорректн'
    ];

    const hasErrorContent = this.hasKeywords(elements, errorKeywords);

    return hasErrorUrl || hasErrorContent;
  }

  /**
   * Check if page content contains any of the keywords
   */
  private hasKeywords(elements: LiteElement[], keywords: string[]): boolean {
    const allText = elements
      .map(el => (el.name || '').toLowerCase())
      .join(' ');

    return keywords.some(keyword => allText.includes(keyword.toLowerCase()));
  }

  /**
   * Calculate confidence in state detection
   *
   * @param step - Detected step
   * @param url - Current URL
   * @param elements - Page elements
   * @returns Confidence score (0-1)
   */
  private calculateConfidence(step: FlowStep, url: string, elements: LiteElement[]): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence based on signals
    switch (step) {
      case 'success':
        // High confidence if both URL and content indicate success
        if (url.includes('dashboard') || url.includes('welcome')) confidence += 0.3;
        if (this.hasKeywords(elements, ['welcome', 'dashboard', 'logout'])) confidence += 0.2;
        break;

      case 'verify_email':
      case 'verify_phone':
      case 'verify_2fa':
        // High confidence if URL and content both indicate verification
        if (url.includes('verify') || url.includes('confirm')) confidence += 0.3;
        if (this.hasKeywords(elements, ['code', 'verification', 'enter'])) confidence += 0.2;
        break;

      case 'form_visible': {
        // High confidence if password field present
        const hasPasswordField = elements.some(el => el.type === 'password');
        if (hasPasswordField) confidence += 0.4;
        break;
      }

      case 'error':
        // High confidence if both URL and content indicate error
        if (url.includes('error') || url.includes('invalid')) confidence += 0.3;
        if (this.hasKeywords(elements, ['error', 'invalid', 'failed'])) confidence += 0.2;
        break;
    }

    return Math.min(1.0, confidence);
  }

  /**
   * Get human-readable description of current step
   */
  static getStepDescription(step: FlowStep): string {
    const descriptions: Record<FlowStep, string> = {
      initial: 'Initial state - navigating to auth page',
      form_visible: 'Auth form is visible - ready to fill credentials',
      filling_credentials: 'Filling username/password fields',
      submitting: 'Submitting form - waiting for server response',
      redirecting: 'Redirect in progress - navigating to destination',
      verify_email: 'Email verification required - check inbox for code',
      verify_phone: 'Phone verification required - enter SMS code',
      verify_2fa: '2FA verification required - enter authenticator code',
      reset_password: 'Password reset flow - choose new password',
      complete_profile: 'Additional profile info required - complete registration',
      success: 'Flow completed successfully - goal reached',
      error: 'Error state - something went wrong',
    };

    return descriptions[step] || step;
  }
}
