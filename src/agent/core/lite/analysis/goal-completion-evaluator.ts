/**
 * GoalCompletionEvaluator
 * AI-based post-action evaluator that asks the AI whether the user goal
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
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';

const EVALUATOR_TIMEOUT_MS = 8000;
const EVALUATOR_MODEL = AI_TASK_MODELS.goalDetection;
// 400 (was 350) — accounts for new STATE CHANGES block + NOTATION HINTS
// + ELEMENT FIELD CHANGES section that surface Radix data-state flips.
// Output schema unchanged (isDone/confidence/reason); only prompt
// length grew, but reason field has more context to draw from now.
const EVALUATOR_MAX_TOKENS = 400;

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

      // Compact diff of changed element fields (cap 10) — exposes
      // Radix/shadcn data-state flips (closed→open, inactive→active)
      // and aria toggles to the LLM judge. Without this block,
      // silent widget transitions (Tab activation without DOM
      // mount/unmount) are invisible to goal completion check.
      const changedFieldsSnippet = diff.changedElements
        .slice(0, 10)
        .map((c) => `  - ${c.field}: ${String(c.before ?? '_')} -> ${String(c.after ?? '_')}`)
        .join('\n');

      // Stage 2: progressSentiment / meaningfulChange / significantChange
      // are now truthful in the deweighted path AND set to safe defaults
      // ('No Effect', false, false) in the legacy path on enrichment
      // failure. Pass them through verbatim — model is instructed below
      // to treat 'Major Progress' / true flags as STRONG positive
      // signals (but not sufficient: full goal completion still required).
      const sentimentLine = `- Progress sentiment: ${diff.progressSentiment} (meaningful=${diff.meaningfulChange}, significant=${diff.significantChange})`;

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
${sentimentLine}
${diff.changedElements.length > 0 ? `\nELEMENT FIELD CHANGES (top 10 of ${diff.changedElements.length}):\n${changedFieldsSnippet}` : ''}
${heuristicHints.length > 0 ? `\nDETECTED SIGNALS:\n${heuristicHints.map(h => `- ${h}`).join('\n')}` : ''}

NOTATION HINTS for "Key elements" listings:
- [STATE=open] / [STATE=active] / [STATE=on] — Radix/shadcn widget is OPEN (dropdown, dialog, popover, tab, toggle)
- [STATE=closed] / [STATE=inactive] / [STATE=off] — widget is CLOSED
- [EXPANDED] / [COLLAPSED] / [CHECKED] / [SELECTED] — ARIA equivalents
- [INSIDE_MODAL] — element is inside an active modal/dialog overlay
- [INVALID] / [DISABLED] — input cannot be used / failed validation

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
- For "open dialog/menu/dropdown" goals: success = a [STATE=open] / [STATE=active] marker appeared on the trigger, OR a new [INSIDE_MODAL] block exists, OR a data-state field changed closed->open / inactive->active in ELEMENT FIELD CHANGES
- For "close" goals: success = the corresponding [STATE=open] disappeared / data-state went open->closed
- Progress sentiment is a HINT, not a verdict: 'Major Progress' supports isDone=true only if other criteria also match
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

    // Stage 1+2: Radix/shadcn data-state transitions. Detected from
    // diff.changedElements where field='dataState'. Surfaces as:
    //   - "Dialog/menu opened" — closed→open or inactive→active
    //   - "Dialog/menu closed" — open→closed or active→inactive
    // Helps judge confirm goals like "open settings", "close drawer",
    // "switch to tab X" without relying solely on element-add/remove
    // signals (Radix Tabs do NOT mount/unmount on activation).
    const dataStateOpens = diff.changedElements.filter((c) => {
      if (c.field !== 'dataState') return false;
      const before = String(c.before ?? '').toLowerCase();
      const after = String(c.after ?? '').toLowerCase();
      return (before === 'closed' && after === 'open')
        || (before === 'inactive' && after === 'active')
        || (before === 'off' && after === 'on')
        || (before === 'unchecked' && after === 'checked');
    });
    if (dataStateOpens.length > 0) {
      hints.push(`${dataStateOpens.length} widget(s) opened/activated (Radix data-state flip)`);
    }

    const dataStateCloses = diff.changedElements.filter((c) => {
      if (c.field !== 'dataState') return false;
      const before = String(c.before ?? '').toLowerCase();
      const after = String(c.after ?? '').toLowerCase();
      return (before === 'open' && after === 'closed')
        || (before === 'active' && after === 'inactive');
    });
    if (dataStateCloses.length > 0) {
      hints.push(`${dataStateCloses.length} widget(s) closed/deactivated (Radix data-state flip)`);
    }

    // ARIA-modal appearance — even without data-state, a freshly-mounted
    // role=dialog or aria-modal=true element is a strong "opened" signal.
    const newDialogs = diff.addedElements.filter((el) => {
      const role = (el.role || '').toLowerCase();
      return el.tag === 'dialog' || role === 'dialog' || role === 'alertdialog';
    });
    if (newDialogs.length > 0) {
      const names = newDialogs.map((d) => d.name || d.ariaLabel || '(unnamed)').slice(0, 3);
      hints.push(`Dialog(s) appeared: ${names.join(', ')}`);
    }

    // Menu / listbox / combobox additions — Radix Portal-rendered menus,
    // Headless UI Select option lists. Same "widget opened" semantic as
    // dialog but triggered by different role values.
    const newMenus = diff.addedElements.filter((el) => {
      const role = (el.role || '').toLowerCase();
      return role === 'menu' || role === 'listbox' || role === 'combobox';
    });
    if (newMenus.length > 0) {
      hints.push(`Menu/listbox/combobox appeared (${newMenus.length})`);
    }

    return hints;
  }

  /**
   * Build compact snapshot summary (top N elements) for the AI prompt.
   *
   * Includes state markers so the LLM judge can recognise Radix/shadcn
   * widget state without reading raw `data-state` values:
   *   - [STATE=...] for data-state when not redundant with aria-*
   *   - [EXPANDED] / [COLLAPSED] / [CHECKED] / [SELECTED] for aria-*
   *   - [INSIDE_MODAL] for elements inside the active overlay
   *   - [INVALID] / [DISABLED] for form state
   *
   * Markers stay terse (square brackets, no spaces) to keep the
   * summary line under ~80 chars per element.
   */
  private buildSnapshotSummary(snapshot: LiteSnapshot, maxElements: number): string {
    const elements = snapshot.elements
      .filter(el => el.visible)
      .slice(0, maxElements)
      .map(el => {
        const type = el.type ? `[${el.type}]` : '';
        const name = el.name || el.placeholder || el.ariaLabel || '';
        const markers: string[] = [];

        // ARIA state markers (priority over data-state when value matches).
        if (el.ariaExpanded === true) markers.push('[EXPANDED]');
        else if (el.ariaExpanded === false) markers.push('[COLLAPSED]');
        if (el.ariaChecked === true || el.checked === true) markers.push('[CHECKED]');
        if (el.ariaSelected === true) markers.push('[SELECTED]');
        if (el.ariaPressed === true) markers.push('[PRESSED]');

        // Stage 1: Radix/shadcn data-state. Skip when redundant with
        // aria-* markers above (avoid duplicate hints that confuse the
        // judge). Same dedup rules as snapshot-collector.format().
        const ds = (el as { dataState?: string }).dataState;
        if (ds) {
          const isDup = (
            (ds === 'open' && el.ariaExpanded === true)
            || (ds === 'closed' && el.ariaExpanded === false)
            || (ds === 'checked' && (el.ariaChecked === true || el.checked === true))
            || (ds === 'unchecked' && (el.ariaChecked === false || el.checked === false))
            || (ds === 'on' && el.ariaPressed === true)
            || (ds === 'off' && el.ariaPressed === false)
            || (ds === 'active' && el.ariaSelected === true)
            || (ds === 'inactive' && el.ariaSelected === false)
          );
          if (!isDup) markers.push(`[STATE=${ds}]`);
        }

        if (el.isInsideActiveModal) markers.push('[INSIDE_MODAL]');
        if (el.invalid === true) markers.push('[INVALID]');
        if (el.disabled === true) markers.push('[DISABLED]');

        const markerStr = markers.length > 0 ? ` ${markers.join('')}` : '';
        return `${el.tag}${type}: ${name}${markerStr}`.trim();
      })
      .filter(s => s.length > 3);

    return elements.length > 0 ? elements.join(', ') : '(no visible elements)';
  }

  /**
   * Build transition summary for prompt injection (next iteration's
   * Core Brain reads `lastTransitionSummary`) and tracing.
   *
   * Includes `progressSentiment` so the next iteration's brain knows
   * what the previous step's outcome was without re-deriving it.
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
    const sentimentPart = `Progress: ${diff.progressSentiment}`;
    const hintsPart = hints.length > 0 ? hints.join('; ') : 'no strong signals';
    return `${urlPart}; ${titlePart}; ${sentimentPart}; ${hintsPart}`;
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
