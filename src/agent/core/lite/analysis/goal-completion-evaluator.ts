/**
 * GoalCompletionEvaluator
 * AI-based post-action evaluator that asks gpt-4o-mini whether the user goal
 * has been achieved by comparing BEFORE vs AFTER page state.
 *
 * Deterministic heuristics (URL transition, success keywords, form disappearance)
 * are collected and passed as context to the AI, but the final decision is
 * always made by the model — this covers "quiet" success states that
 * rule-based logic would miss.
 *
 * Triggered only after significant state changes (state_changed, urlChanged,
 * Major Progress) to keep cost low.
 */

import { logger } from '@/utils/core/logger';
import type { GoalCompletionResult, LiteSnapshot, StateDiff } from '../lite-types';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';

const EVALUATOR_TIMEOUT_MS = 8000;
const EVALUATOR_MODEL = 'gpt-4o-mini';
const EVALUATOR_MAX_TOKENS = 350;

export class GoalCompletionEvaluator {
  private testId: string;

  constructor(testId?: string) {
    this.testId = testId || 'unknown';
  }

  /**
   * Ask AI whether the goal has been achieved based on before/after comparison.
   * Returns isDone, confidence, reason and a transition summary for prompt injection.
   */
  async evaluate(
    snapshotBefore: LiteSnapshot,
    snapshotAfter: LiteSnapshot,
    diff: StateDiff,
    goal: string
  ): Promise<GoalCompletionResult> {
    const heuristicHints = this.collectHeuristicHints(snapshotBefore, snapshotAfter, diff, goal);
    const transitionSummary = this.buildTransitionSummary(snapshotBefore, snapshotAfter, diff, heuristicHints);

    try {
      const beforeSummary = this.buildSnapshotSummary(snapshotBefore, 20);
      const afterSummary = this.buildSnapshotSummary(snapshotAfter, 20);

      const prompt = `You are a Goal Completion Judge. Determine if the user's goal has been achieved by comparing page state BEFORE and AFTER the last action.

GOAL: ${goal}

BEFORE ACTION:
- URL: ${snapshotBefore.url}
- Title: ${snapshotBefore.title || '(none)'}
- Key elements: ${beforeSummary}

AFTER ACTION:
- URL: ${snapshotAfter.url}
- Title: ${snapshotAfter.title || '(none)'}
- Key elements: ${afterSummary}

STATE CHANGES:
- URL changed: ${diff.urlChanged ? 'yes' : 'no'}
- Elements added: ${diff.addedElements.length}
- Elements removed: ${diff.removedRefs.length}
- Title changed: ${snapshotBefore.title !== snapshotAfter.title ? `"${snapshotBefore.title}" -> "${snapshotAfter.title}"` : 'no'}
${heuristicHints.length > 0 ? `\nDETECTED SIGNALS:\n${heuristicHints.map(h => `- ${h}`).join('\n')}` : ''}

Respond JSON:
{
  "isDone": true|false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation"
}

Rules:
- isDone=true ONLY if goal is FULLY achieved (not an intermediate step)
- For login/register: success = landed on authenticated page (dashboard, profile, home, admin panel) with NO login form visible
- For login/register: intermediate = verification, 2FA, reset password, complete profile — NOT done
- For checkout: success = order confirmed/thank-you page
- For search: success = search results visible
- If page shows errors (invalid, failed, denied) = NOT done
- Be STRICT: when unsure, isDone=false`;

      const result = await LitePromptBuilder.askJson<{
        isDone?: boolean;
        confidence?: number;
        reason?: string;
      }>(prompt, {
        model: EVALUATOR_MODEL,
        temperature: 0.05,
        maxTokens: EVALUATOR_MAX_TOKENS,
        timeoutMs: EVALUATOR_TIMEOUT_MS,
      });

      if (!result) {
        logger.warn('[GOAL_COMPLETION] AI evaluation timed out or failed', { testId: this.testId });
        return { isDone: false, confidence: 0, reason: 'AI evaluation timed out', transitionSummary };
      }

      const isDone = result.isDone ?? false;
      const confidence = Math.max(0, Math.min(1, result.confidence ?? 0));
      const reason = result.reason || 'No reason provided';

      logger.info('[GOAL_COMPLETION] AI evaluation result', {
        testId: this.testId,
        isDone,
        confidence: confidence.toFixed(2),
        reason: reason.slice(0, 80),
        heuristicHints: heuristicHints.length,
      });

      return { isDone, confidence, reason, transitionSummary };
    } catch (error) {
      if (error instanceof Error && error.message.includes('cancelled')) {
        throw error;
      }
      logger.warn('[GOAL_COMPLETION] AI evaluation error, defaulting to not done', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { isDone: false, confidence: 0, reason: 'Evaluation error', transitionSummary };
    }
  }

  /**
   * Collect deterministic heuristic hints as additional context for the AI.
   * These are NOT used for decision-making; they help the model focus.
   */
  private collectHeuristicHints(
    before: LiteSnapshot,
    after: LiteSnapshot,
    diff: StateDiff,
    goal: string
  ): string[] {
    const hints: string[] = [];
    const goalLower = goal.toLowerCase();
    const afterUrl = (after.url || '').toLowerCase();
    const beforeUrl = (before.url || '').toLowerCase();
    const afterText = this.extractVisibleText(after);
    const beforeText = this.extractVisibleText(before);

    const isAuth = /login|sign\s*in|auth|register|sign\s*up|вход|войти|авторизац|регистрац/i.test(goalLower);

    if (diff.urlChanged) {
      hints.push(`URL transitioned: ${before.url} -> ${after.url}`);
    }

    if (isAuth) {
      const wasOnAuthPage = this.containsAny(beforeUrl, ['login', 'signin', 'auth', 'register', 'signup']);
      const nowOnAuthPage = this.containsAny(afterUrl, ['login', 'signin', 'auth', 'register', 'signup']);
      if (wasOnAuthPage && !nowOnAuthPage) {
        hints.push('Left auth page (URL no longer contains login/auth patterns)');
      }
      if (this.containsAny(afterUrl, ['reset', 'forgot', 'verify', '2fa', 'otp', 'code', 'onboarding'])) {
        hints.push('Landed on intermediate auth page (reset/verify/2fa) — likely NOT done');
      }
      if (this.hasAuthForm(before) && !this.hasAuthForm(after)) {
        hints.push('Login/register form disappeared after action');
      }
      if (this.hasAuthenticatedUi(afterText) && !this.hasAuthenticatedUi(beforeText)) {
        hints.push('Authenticated UI appeared (logout/profile/user menu)');
      }
    }

    if (before.title !== after.title) {
      hints.push(`Page title changed: "${before.title}" -> "${after.title}"`);
    }

    if (this.hasSuccessIndicators(afterText) && !this.hasSuccessIndicators(beforeText)) {
      hints.push('Success keywords appeared in page content (welcome, dashboard, confirmed, etc.)');
    }

    if (this.containsAny(afterText, ['error', 'invalid', 'failed', 'denied', 'ошибка', 'неверн'])) {
      hints.push('Error indicators detected on current page');
    }

    return hints;
  }

  /**
   * Build compact snapshot summary (top N elements) for the AI prompt.
   */
  private buildSnapshotSummary(snapshot: LiteSnapshot, maxElements: number): string {
    const elements = snapshot.elements
      .filter(el => el.visible)
      .slice(0, maxElements)
      .map(el => {
        const type = el.type ? `[${el.type}]` : '';
        const name = el.name || el.placeholder || el.ariaLabel || '';
        return `${el.tag}${type}: ${name}`.trim();
      })
      .filter(s => s.length > 3);

    return elements.length > 0 ? elements.join(', ') : '(no visible elements)';
  }

  /**
   * Build transition summary for prompt injection and tracing.
   */
  private buildTransitionSummary(
    before: LiteSnapshot,
    after: LiteSnapshot,
    diff: StateDiff,
    hints: string[]
  ): string {
    const urlPart = diff.urlChanged
      ? `URL: ${before.url} -> ${after.url}`
      : `URL unchanged: ${after.url}`;
    const titlePart = before.title !== after.title
      ? `Title: "${before.title}" -> "${after.title}"`
      : `Title unchanged: "${after.title}"`;
    const hintsPart = hints.length > 0 ? hints.join('; ') : 'no strong signals';
    return `${urlPart}; ${titlePart}; ${hintsPart}`;
  }

  /**
   * Extract lowercased visible text from snapshot.
   */
  private extractVisibleText(snapshot: LiteSnapshot): string {
    const parts = [
      snapshot.title || '',
      ...snapshot.elements
        .filter(el => el.visible)
        .map(el => `${el.name || ''} ${el.ariaLabel || ''} ${el.placeholder || ''}`),
    ];
    return parts.join(' ').toLowerCase();
  }

  /**
   * Detect whether snapshot contains a typical auth form (password + identity field).
   */
  private hasAuthForm(snapshot: LiteSnapshot): boolean {
    const hasPassword = snapshot.elements.some(
      el => el.visible && el.tag === 'input' && el.type === 'password'
    );
    const hasIdentity = snapshot.elements.some(el => {
      if (!el.visible || el.tag !== 'input') return false;
      const text = `${el.name || ''} ${el.placeholder || ''} ${el.type || ''}`.toLowerCase();
      return this.containsAny(text, ['email', 'username', 'login', 'телефон', 'phone']);
    });
    return hasPassword && hasIdentity;
  }

  private hasSuccessIndicators(text: string): boolean {
    return this.containsAny(text, [
      'welcome', 'dashboard', 'success', 'successfully', 'logged in',
      'profile', 'my account', 'admin', 'cabinet',
      'кабинет', 'добро пожаловать', 'успешно', 'подтверждено', 'confirmed', 'thank you',
    ]);
  }

  private hasAuthenticatedUi(text: string): boolean {
    return this.containsAny(text, [
      'logout', 'sign out', 'log out', 'profile', 'my account',
      'account settings', 'кабинет', 'профиль', 'выйти',
    ]);
  }

  private containsAny(text: string, keywords: string[]): boolean {
    return keywords.some(kw => text.includes(kw));
  }
}
