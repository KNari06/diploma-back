/**
 * ContextualActionGenerator
 * Generates actions dynamically based on page context
 * Understands logical dependencies and creates realistic test scenarios
 */

import {
  buildActionGenerationPrompt,
  buildNextStepPrompt,
} from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { AICostManager, AIModel } from '@/services/ai/cost/ai-cost-manager.service';
import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import { z } from 'zod';
import { StateTracker } from '../safety/state-tracker';
import {
  DynamicAction,
  NextStepDecision,
  PageContext,
  TestHint,
  TestState,
} from '../types/intelligent-testing.types';
import { getSharedOpenAIClient } from '@/services/ai/core/openai.service';

const openai = getSharedOpenAIClient();

// ═══════════════════════════════════════════════════════════════════════════
// ZOD SCHEMAS FOR VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

const ActionSchema = z.object({
  action: z.string(),
  selector: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
  description: z.string(),
  expectedResult: z.string().optional(),
  timeout: z.number().optional(),
  optional: z.boolean().optional(),
  retry: z.number().optional(),
});

const ActionGenerationResponseSchema = z.object({
  reasoning: z.string(),
  actions: z.array(ActionSchema),
  nextExpectedPage: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

const NextStepResponseSchema = z.object({
  decision: z.enum(['continue', 'stop', 'wait_for_user', 'retry', 'skip']),
  reason: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  progress: z.number().min(0).max(100).optional(),
  goalAchieved: z.boolean().optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  blockingSignals: z.array(z.enum(['captcha', '2fa', 'auth_required', 'rate_limit', 'modal_overlay', 'validation_errors', 'broken_page', 'none'])).optional(),
  retryStrategy: z.enum(['wait', 'reload', 'navigate_back', 'choose_alternative_target', 'reduce_scope']).nullable().optional(),
  nextTarget: z.object({
    type: z.enum(['page', 'element', 'flow']).optional(),
    description: z.string().optional(),
    successCriteria: z.string().optional(),
    avoid: z.array(z.string()).optional(),
  }).nullable().optional(),
});

// Cache for action generations is currently disabled.

// ═══════════════════════════════════════════════════════════════════════════
// ACTION GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

export class ContextualActionGenerator {
  /**
   * Generates test actions based on current page context using AI
   *
   * Analyzes the page structure, available elements, and test history to generate
   * appropriate actions that move the test towards its goal. Uses OpenAI to
   * understand context and create realistic test scenarios.
   *
   * @param context - Current page context including DOM and vision analysis
   * @param state - Current test state with history and goal
   * @param page - Optional Playwright page instance for HTML extraction
   * @param costManager - Optional cost manager for budget control
   * @param hints - Optional test hints from plan (user's requested steps)
   * @returns Generated actions with reasoning and confidence score
   */
  static async generateActions(
    context: PageContext,
    state: TestState,
    page?: Page,
    costManager?: AICostManager,
    hints?: TestHint[]
  ): Promise<{
    actions: DynamicAction[];
    reasoning: string;
    confidence: number;
  }> {
    const startTime = Date.now();

    // Check budget before proceeding
    if (costManager && !costManager.canContinue()) {
      logger.warn('[ACTION_GENERATOR] Budget exceeded, stopping action generation', {
        stats: costManager.getStats(),
      });
      return {
        actions: [],
        reasoning: 'Budget exceeded - stopping test to prevent cost overrun',
        confidence: 0,
      };
    }

    logger.info('[ACTION_GENERATOR] Generating actions', {
      pageType: context.pageType,
      url: context.url,
      goal: state.goal,
    });

    // Cache is temporarily disabled
    // const cached = getCachedGeneration(context, state.goal);
    // if (cached && cached.actions.length > 0) {
    //   // Validate cached actions before using them
    //   // Check if elements referenced in cached actions still exist on the page
    //   const isValidCache = await this.validateCachedActions(cached.actions, context, page);
    //
    //   if (isValidCache) {
    //     logger.info('[ACTION_GENERATOR] Using cached actions', {
    //       age: Date.now() - cached.timestamp,
    //       count: cached.actions.length,
    //     });
    //     return {
    //       actions: cached.actions,
    //       reasoning: `[CACHED] ${cached.reasoning}`,
    //       confidence: cached.confidence,
    //     };
    //   } else {
    //     // Invalidate cache if actions are invalid
    //     logger.warn('[ACTION_GENERATOR] Cached actions invalid, invalidating cache', {
    //       reason: 'Elements referenced in cached actions do not exist on current page',
    //       cachedActionsCount: cached.actions.length,
    //     });
    //     const key = getCacheKey(context, state.goal);
    //     generationCache.delete(key);
    //   }
    // }

    // Cache invalidation on failures (disabled)
    // const recentFailures = state.completedActions
    //   .slice(-5)
    //   .filter(a => !a.success && a.action.selector);
    //
    // if (recentFailures.length > 0 && cached) {
    //   logger.warn('[ACTION_GENERATOR] Recent failures detected, invalidating cache', {
    //     failuresCount: recentFailures.length,
    //     failedSelectors: recentFailures.map(f => f.action.selector).filter(Boolean),
    //   });
    //   const key = getCacheKey(context, state.goal);
    //   generationCache.delete(key);
    // }

    // Early exit: Check for empty/invalid pages before generating actions
    const isEmptyPage = this.isPageEmpty(context);
    if (isEmptyPage) {
      logger.warn('[ACTION_GENERATOR] Empty page detected, skipping action generation', {
        url: context.url,
        elementsCount: context.vision.elements.length,
        domElementsCount: {
          forms: context.dom.forms?.length || 0,
          buttons: context.dom.buttons?.length || 0,
          links: context.dom.links?.length || 0,
          inputs: context.dom.inputs?.length || 0,
        },
      });

      return {
        actions: [],
        reasoning: isEmptyPage.reason,
        confidence: 0.1,
      };
    }

    try {
      // Build history summary
      const historySummary = this.buildHistorySummary(state);

      // Build available elements summary
      const elementsSummary = this.buildElementsSummary(context);

      // Build DOM summary
      const domSummary = this.buildDOMSummary(context.dom);

      // Extract and sanitize HTML to mask PII before sending to LLM
      const actualHTML = page ? await this.getPageHTML(page) : '';
      const sanitizedHTML = this.maskPII(actualHTML);

      // Log context information for debugging
      logger.info('[ACTION_GENERATOR] Context sent to AI', {
        pageType: context.pageType,
        url: context.url,
        goal: state.goal.substring(0, 100) + '...',
        availableElements: {
          visionElementsCount: context.vision.elements.length,
          visionElements: context.vision.elements.map(el => ({
            type: el.type,
            text: el.text?.substring(0, 30),
            selector: el.selector,
            priority: el.priority,
          })),
        },
        domElements: {
          buttonsCount: context.dom.buttons?.length || 0,
          buttons: (context.dom.buttons || []).map(btn => ({
            text: btn.text?.substring(0, 30),
            selector: btn.selector,
          })),
          inputsCount: context.dom.inputs?.length || 0,
          inputs: (context.dom.inputs || []).map(input => ({
            type: input.type,
            name: input.name,
            selector: input.selector,
          })),
          linksCount: context.dom.links?.length || 0,
          formsCount: context.dom.forms?.length || 0,
        },
        historySummary: historySummary.substring(0, 200),
        domSummary: domSummary.substring(0, 500),
        hasHTML: !!sanitizedHTML,
      });

      const prompt = buildActionGenerationPrompt({
        pageType: context.pageType,
        goal: state.goal,
        pageDescription: context.vision.description,
        availableElements: elementsSummary,
        history: historySummary,
        domSummary,
        actualHTML: sanitizedHTML,
        hints,
      });

      // Calculate dynamic token budget based on prompt length
      const promptLength = prompt.length;
      const estimatedPromptTokens = Math.ceil(promptLength / 4); // rough estimate
      const maxTokensBudget = Math.min(1500, 4000 - estimatedPromptTokens); // leave room for response

      logger.debug('[ACTION_GENERATOR] Token budget', {
        promptLength,
        estimatedPromptTokens,
        maxTokensBudget,
      });

      // Get recommended model based on budget constraints
      const preferredModel = AI_TASK_MODELS.actionGeneration as AIModel;
      const model = costManager ? costManager.getRecommendedModel(preferredModel) : preferredModel;

      logger.debug('[ACTION_GENERATOR] Using model', { model, preferredModel });

      const response = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert QA automation engineer generating test actions. ALWAYS return valid JSON matching the schema.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_completion_tokens: maxTokensBudget,
        temperature: 0.4, // Some creativity, but not too much
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Action Generator');
      }

      // Record AI cost for budget tracking
      if (costManager) {
        const inputTokens = response.usage?.prompt_tokens || estimatedPromptTokens;
        const outputTokens = response.usage?.completion_tokens || 0;

        const costResult = costManager.recordOperation({
          operation: 'action_generation',
          model,
          inputTokens,
          outputTokens,
        });

        if (!costResult.allowed) {
          logger.warn('[ACTION_GENERATOR] Operation would exceed budget', {
            cost: costResult.cost,
            warning: costResult.warning,
          });
        } else if (costResult.warning) {
          logger.warn('[ACTION_GENERATOR] Budget warning', {
            warning: costResult.warning,
          });
        }
      }

      // Parse JSON response with fallback extraction strategies
      const parsed = this.parseRobustJSON(content, ActionGenerationResponseSchema);

      // Validate and sanitize actions before returning
      const actions = this.sanitizeActions(parsed.actions || []);

      const duration = Date.now() - startTime;

      // Log generation metrics
      logger.info('[ACTION_GENERATOR] Actions generated', {
        count: actions.length,
        confidence: parsed.confidence || 0,
        duration: `${duration}ms`,
        tokensUsed: response.usage?.total_tokens || 0,
        model: response.model,
      });

      // Log detailed action information for debugging
      logger.info('[ACTION_GENERATOR] Generated actions details', {
        actions: actions.map(a => ({
          action: a.action,
          selector: a.selector,
          value: a.value,
          description: a.description,
          expectedResult: a.expectedResult,
          optional: a.optional,
          timeout: a.timeout,
        })),
        reasoning: parsed.reasoning,
      });

      const result = {
        actions,
        reasoning: parsed.reasoning || 'No reasoning provided',
        confidence: parsed.confidence || 0.5,
      };

      // Cache is temporarily disabled
      // if (actions.length > 0) {
      //   setCachedGeneration(context, state.goal, {
      //     ...result,
      //     timestamp: Date.now(),
      //   });
      // }

      return result;
    } catch (error) {
      logger.error('[ACTION_GENERATOR] Action generation failed', {
        error: error instanceof Error ? error.message : String(error),
        url: context.url,
        pageType: context.pageType,
      });

      // Check if page is empty
      const isEmptyPage = this.isPageEmpty(context);
      if (isEmptyPage) {
        return {
          actions: [],
          reasoning: isEmptyPage.reason,
          confidence: 0.1,
        };
      }

      // Return empty actions with explicit error message
      // Let the main loop handle the decision (stop test or retry)
      return {
        actions: [],
        reasoning: `AI action generation failed: ${error instanceof Error ? error.message : 'Unknown error'}. Cannot proceed without AI-generated actions.`,
        confidence: 0,
      };
    }
  }

  /**
   * Validates cached actions by checking if their selectors still exist on the page
   *
   * When actions are cached, this method verifies that the DOM elements referenced
   * by the cached actions still exist. If page is available, performs actual DOM
   * checks. Otherwise, validates against DOM summary.
   *
   * @param cachedActions - Actions retrieved from cache
   * @param context - Current page context for validation
   * @param page - Optional Playwright page for actual DOM checks
   * @returns true if all actions are valid, false otherwise
   */
  private static async validateCachedActions(
    cachedActions: DynamicAction[],
    context: PageContext,
    page?: Page
  ): Promise<boolean> {
    if (!page) {
      // If no page provided, validate against DOM summary
      return this.validateCachedActionsAgainstDOM(cachedActions, context);
    }

    // Validate against actual DOM
    try {
      const { getLocator, normalizeSelector } = await import('../utils/selectors/selector-utils');

      for (const action of cachedActions) {
        if (!action.selector) continue;

        try {
          const normalizedSelector = normalizeSelector(action.selector);
          const locator = getLocator(page, normalizedSelector);
          const count = await locator.count();

          if (count === 0) {
            logger.debug('[ACTION_GENERATOR] Cached action selector not found', {
              action: action.description,
              selector: action.selector,
            });
            return false;
          }
        } catch (error) {
          logger.debug('[ACTION_GENERATOR] Error validating cached action selector', {
            action: action.description,
            selector: action.selector,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.warn('[ACTION_GENERATOR] Failed to validate cached actions', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Validates cached actions against DOM summary when page instance is not available
   *
   * Performs a lightweight validation by checking if selectors from cached actions
   * exist in the DOM summary. This is less accurate than actual DOM checks but
   * useful when page instance is not available.
   *
   * @param cachedActions - Actions retrieved from cache
   * @param context - Current page context with DOM summary
   * @returns true if actions seem valid, false otherwise
   */
  private static validateCachedActionsAgainstDOM(
    cachedActions: DynamicAction[],
    context: PageContext
  ): boolean {
    const dom = context.dom;
    const availableSelectors = new Set<string>();

    // Collect available selectors from DOM
    (dom.buttons || []).forEach(btn => {
      if (btn.selector) availableSelectors.add(btn.selector);
    });
    (dom.inputs || []).forEach(input => {
      if (input.selector) availableSelectors.add(input.selector);
    });
    (dom.links || []).forEach(link => {
      if (link.selector) availableSelectors.add(link.selector);
    });

    // Check if cached action selectors exist
    for (const action of cachedActions) {
      if (!action.selector) continue;

      // Simple check: if selector is not in available selectors, it might be invalid
      // But this is not 100% accurate, so we'll be lenient
      const normalizedSelector = action.selector.toLowerCase();
      const hasMatch = Array.from(availableSelectors).some(sel =>
        sel.toLowerCase().includes(normalizedSelector) ||
        normalizedSelector.includes(sel.toLowerCase())
      );

      if (!hasMatch && action.action !== 'goto' && action.action !== 'wait') {
        logger.debug('[ACTION_GENERATOR] Cached action selector not found in DOM summary', {
          action: action.description,
          selector: action.selector,
        });
        // Don't fail immediately - might be a dynamic selector
      }
    }

    return true; // Be lenient when page is not available
  }

  /**
   * Checks if page is empty or invalid (e.g., about:blank or no interactive elements)
   *
   * Determines whether the page has any interactive elements that can be tested.
   * Returns null if page is valid, or an object with reason if page is empty.
   *
   * @param context - Current page context to check
   * @returns Object with isEmpty flag and reason if page is empty, null if valid
   */
  private static isPageEmpty(context: PageContext): { isEmpty: boolean; reason: string } | null {
    // Check for about:blank
    if (context.url === 'about:blank' || context.url.startsWith('about:')) {
      return {
        isEmpty: true,
        reason: 'Page is about:blank (empty browser page). No actions can be performed on this page.',
      };
    }

    // Check for completely empty page (no vision elements and no DOM elements)
    const hasVisionElements = context.vision.elements && context.vision.elements.length > 0;
    const hasDomElements =
      (context.dom.forms && context.dom.forms.length > 0) ||
      (context.dom.buttons && context.dom.buttons.length > 0) ||
      (context.dom.links && context.dom.links.length > 0) ||
      (context.dom.inputs && context.dom.inputs.length > 0);

    if (!hasVisionElements && !hasDomElements) {
      return {
        isEmpty: true,
        reason: 'Page has no interactive elements (forms, buttons, links, inputs). No actions can be performed.',
      };
    }

    return null; // Page is valid
  }

  /**
   * Decides the next step in the test execution based on current state
   *
   * Uses AI to analyze the test progress, visited pages, errors, and current
   * page context to determine whether to continue, stop, wait, retry, or skip.
   * Uses cheaper model (gemini-2.5-flash-lite) for cost efficiency.
   *
   * @param state - Current test state with history and progress
   * @param context - Current page context
   * @param costManager - Optional cost manager for budget control
   * @returns Decision object with action, reason, and confidence
   */
  static async decideNextStep(
    state: TestState,
    context: PageContext,
    costManager?: AICostManager
  ): Promise<NextStepDecision> {
    logger.info('[ACTION_GENERATOR] Deciding next step', {
      pageType: context.pageType,
      pagesVisited: state.pagesAnalyzed,
      goal: state.goal,
    });

    // Check budget before proceeding
    if (costManager && !costManager.canContinue()) {
      logger.warn('[ACTION_GENERATOR] Budget exceeded, stopping test', {
        stats: costManager.getStats(),
      });
      return {
        action: 'stop',
        reason: 'Budget exceeded - stopping test to prevent cost overrun',
        confidence: 1.0,
      };
    }

    // ✅ NEW: Check for cycles before AI call
    const cycleDetection = StateTracker.detectCycle(state, context.url);
    if (cycleDetection.cycleDetected) {
      logger.warn('[ACTION_GENERATOR] Cycle detected, skipping to break loop', {
        url: context.url,
        visitCount: cycleDetection.visitCount,
        suggestion: cycleDetection.suggestion,
      });
      return {
        action: 'skip',
        reason: cycleDetection.suggestion,
        confidence: 1.0,
      };
    }

    // ✅ NEW: Check timeout before proceeding
    const elapsed = Date.now() - state.startTime;
    if (elapsed >= state.maxDuration) {
      logger.warn('[ACTION_GENERATOR] Max duration reached', {
        elapsed: `${Math.round(elapsed / 1000)}s`,
        maxDuration: `${Math.round(state.maxDuration / 1000)}s`,
      });
      return {
        action: 'stop',
        reason: 'Max duration reached',
        confidence: 1.0,
      };
    }

    // ✅ NEW: Check if all recent actions failed
    const recentActions = state.completedActions.slice(-5);
    const allRecentFailed = recentActions.length >= 3 &&
                            recentActions.every(a => !a.success);
    if (allRecentFailed) {
      logger.warn('[ACTION_GENERATOR] All recent actions failed, trying different approach', {
        failedCount: recentActions.length,
      });
      // Don't stop immediately, but let AI decide with this context
    }

    try {
      // ✅ IMPROVED: Limit errors and pages to prevent token overflow
      const maxErrors = 10;
      const maxPages = 20;
      const historySummary = this.buildHistorySummary(state);
      const visitedPages = state.visitedPages.slice(-maxPages).map(v => `${v.pageType} (${v.url})`);
      const errors = state.errors.slice(-maxErrors).map(e => e.message);

      const prompt = buildNextStepPrompt({
        goal: state.goal,
        history: historySummary,
        currentPage: context.pageType,
        visitedPages,
        errors,
      });

      // Use cheaper model for next step decision to reduce costs
      const preferredModel = AI_TASK_MODELS.actionGenerationFast as AIModel;
      const model = costManager ? costManager.getRecommendedModel(preferredModel) : preferredModel;

      const response = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert QA engineer deciding next testing steps. ALWAYS return valid JSON matching the schema.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_completion_tokens: 800,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Next Step Decision');
      }

      // Record AI cost for budget tracking
      if (costManager) {
        const inputTokens = response.usage?.prompt_tokens || Math.ceil(prompt.length / 4);
        const outputTokens = response.usage?.completion_tokens || 0;

        costManager.recordOperation({
          operation: 'next_step_decision',
          model,
          inputTokens,
          outputTokens,
        });
      }

      // Parse JSON response with fallback extraction
      const parsed = this.parseRobustJSON(content, NextStepResponseSchema);

      // ✅ NEW: Check if goal is achieved before processing decision
      if (parsed.goalAchieved === true) {
        logger.info('[ACTION_GENERATOR] Goal achieved, stopping test', {
          confidence: parsed.confidence ?? 1.0,
        });
        return {
          action: 'stop',
          reason: 'Goal achieved',
          confidence: parsed.confidence ?? 1.0,
        };
      }

      // ✅ NEW: Handle blocking signals (captcha, 2fa, etc.)
      const blockingSignals = parsed.blockingSignals || [];
      if (blockingSignals.length > 0 &&
          (blockingSignals.includes('captcha') ||
           blockingSignals.includes('2fa') ||
           blockingSignals.includes('auth_required'))) {
        logger.warn('[ACTION_GENERATOR] Blocking signal detected', {
          signals: blockingSignals,
        });
        return {
          action: 'wait_for_user',
          reason: `Blocked by: ${blockingSignals.join(', ')}`,
          confidence: parsed.confidence ?? 0.9,
        };
      }

      // ✅ NEW: Handle high risk level
      if (parsed.riskLevel === 'high') {
        logger.warn('[ACTION_GENERATOR] High risk detected', {
          reason: parsed.reason,
          riskLevel: parsed.riskLevel,
        });
        return {
          action: 'wait_for_user',
          reason: `High risk action: ${parsed.reason}`,
          confidence: parsed.confidence ?? 0.9,
        };
      }

      // ✅ IMPROVED: Use all fields from AI response
      const decision: NextStepDecision = {
        action: parsed.decision || 'stop',
        reason: parsed.reason || 'No reason provided',
        confidence: parsed.confidence ?? 0.8, // ✅ Use AI confidence instead of hardcoded
        expectedPage: parsed.nextTarget?.type === 'page'
          ? parsed.nextTarget.description as any
          : undefined,
        // Store additional metadata for handleDecision
        metadata: {
          progress: parsed.progress,
          riskLevel: parsed.riskLevel,
          blockingSignals: parsed.blockingSignals,
          retryStrategy: parsed.retryStrategy,
          nextTarget: parsed.nextTarget,
        },
      };

      logger.info('[ACTION_GENERATOR] Next step decided', {
        action: decision.action,
        reason: decision.reason,
        confidence: decision.confidence,
        progress: parsed.progress,
        riskLevel: parsed.riskLevel,
        blockingSignals: parsed.blockingSignals,
      });

      return decision;
    } catch (error) {
      logger.error('[ACTION_GENERATOR] Next step decision failed', { error });

      // Safe fallback: stop if too many pages or errors
      if (state.pagesAnalyzed >= state.maxPages || state.errors.length > 5) {
        return {
          action: 'stop',
          reason: 'Reached limits (pages or errors)',
          confidence: 1.0,
        };
      }

      return {
        action: 'continue',
        reason: 'Decision failed, continuing with caution',
        confidence: 0.3,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS - SUMMARIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Builds a summary of test history for AI context
   *
   * Creates a human-readable summary of pages visited, actions taken,
   * and recent activity to help AI understand test progress.
   *
   * @param state - Current test state with history
   * @returns Formatted history summary string
   */
  private static buildHistorySummary(state: TestState): string {
    if (state.visitedPages.length === 0) {
      return 'Just started testing.';
    }

    const summary: string[] = [];

    // Page flow
    const pageFlow = state.visitedPages.map(v => v.pageType).join(' → ');
    summary.push(`Page Flow: ${pageFlow}`);

    // Actions taken
    const totalActions = state.completedActions.length;
    const successfulActions = state.completedActions.filter(a => a.success).length;
    summary.push(`Actions: ${successfulActions}/${totalActions} successful`);

    // Recent actions
    const recentActions = state.completedActions.slice(-3);
    if (recentActions.length > 0) {
      summary.push('\nRecent Actions:');
      recentActions.forEach(action => {
        summary.push(
          `- ${action.action.description} ${action.success ? '✓' : '✗'}`
        );
      });
    }

    return summary.join('\n');
  }

  /**
   * Builds a summary of available interactive elements from vision analysis
   *
   * Groups elements by priority (critical, high, others) and includes
   * selectors, text, and purpose for each element to help AI generate
   * appropriate actions.
   *
   * @param context - Page context with vision analysis
   * @returns Formatted elements summary string
   */
  private static buildElementsSummary(context: PageContext): string {
    const elements = context.vision.elements;

    if (elements.length === 0) {
      return 'No interactive elements detected.';
    }

    // Group by priority
    const critical = elements.filter(el => el.priority === 'critical');
    const high = elements.filter(el => el.priority === 'high');
    const others = elements.filter(
      el => el.priority !== 'critical' && el.priority !== 'high'
    );

    const summary: string[] = [];

    // Include selectors from DOM analysis for direct use
    if (critical.length > 0) {
      summary.push('Critical Elements:');
      critical.forEach(el => {
        // Include selector so AI can use it directly
        summary.push(`- ${el.type}: ${el.purpose} | Text: "${el.text || 'no text'}" | Selector: "${el.selector}"`);
      });
    }

    if (high.length > 0) {
      summary.push('\nHigh Priority:');
      high.forEach(el => {
        summary.push(`- ${el.type}: ${el.purpose} | Text: "${el.text || 'no text'}" | Selector: "${el.selector}"`);
      });
    }

    if (others.length > 0) {
      summary.push(`\nOther Elements (${others.length}):`);
      others.slice(0, 10).forEach(el => { // Limit to 10 to avoid token overflow
        summary.push(`- ${el.type}: ${el.purpose} | Text: "${el.text || 'no text'}" | Selector: "${el.selector}"`);
      });
      if (others.length > 10) {
        summary.push(`  ... and ${others.length - 10} more elements`);
      }
    }

    return summary.join('\n');
  }

  /**
   * Builds a summary of DOM structure for AI context
   *
   * Creates a detailed summary of forms, buttons, inputs, links, checkboxes,
   * radio buttons, and other interactive elements with their selectors.
   * Includes modals and their close button selectors.
   *
   * @param dom - DOM analysis result with all interactive elements
   * @returns Formatted DOM summary string
   */
  private static buildDOMSummary(dom: PageContext['dom']): string {
    const summary: string[] = [];

    // Include selectors from DOM for direct use by AI
    if (dom.forms.length > 0) {
      summary.push(`Forms: ${dom.forms.length}`);
      dom.forms.forEach((form, idx) => {
        summary.push(`  Form ${idx + 1}: ${form.fields.length} fields`);
        form.fields.slice(0, 5).forEach(field => {
          summary.push(`    - ${field.name || 'unnamed'}: ${field.type} | Selector: "${field.selector}"`);
        });
        if (form.fields.length > 5) {
          summary.push(`    ... and ${form.fields.length - 5} more fields`);
        }
      });
    }

    if (dom.buttons.length > 0) {
      summary.push(`\nButtons (${dom.buttons.length}):`);
      dom.buttons.slice(0, 10).forEach(btn => {
        summary.push(`  - "${btn.text}" | Selector: "${btn.selector}"`);
      });
      if (dom.buttons.length > 10) {
        summary.push(`  ... and ${dom.buttons.length - 10} more buttons`);
      }
    }

    if (dom.inputs.length > 0) {
      summary.push(`\nInputs (${dom.inputs.length}):`);
      dom.inputs.slice(0, 10).forEach(input => {
        const label = input.name || input.placeholder || input.type;
        summary.push(`  - ${label} (${input.type}) | Selector: "${input.selector}"`);
      });
      if (dom.inputs.length > 10) {
        summary.push(`  ... and ${dom.inputs.length - 10} more inputs`);
      }
    }

    if (dom.links.length > 0) {
      summary.push(`\nLinks (${dom.links.length}):`);
      dom.links.slice(0, 10).forEach(link => {
        summary.push(`  - "${link.text}" → ${link.href} | Selector: "${link.selector}"`);
      });
      if (dom.links.length > 10) {
        summary.push(`  ... and ${dom.links.length - 10} more links`);
      }
    }

    // Include checkboxes and radio buttons
    if (dom.checkboxes && dom.checkboxes.length > 0) {
      summary.push(`\nCheckboxes (${dom.checkboxes.length}):`);
      dom.checkboxes.slice(0, 10).forEach(cb => {
        const label = cb.label || cb.name || 'unnamed';
        summary.push(`  - "${label}" ${cb.checked ? '(checked)' : ''} | Selector: "${cb.selector}"`);
      });
      if (dom.checkboxes.length > 10) {
        summary.push(`  ... and ${dom.checkboxes.length - 10} more checkboxes`);
      }
    }

    if (dom.radios && dom.radios.length > 0) {
      summary.push(`\nRadio buttons (${dom.radios.length}):`);
      dom.radios.slice(0, 10).forEach(radio => {
        const label = radio.label || radio.name || 'unnamed';
        summary.push(`  - "${label}" ${radio.checked ? '(selected)' : ''} | Selector: "${radio.selector}"`);
      });
      if (dom.radios.length > 10) {
        summary.push(`  ... and ${dom.radios.length - 10} more radio buttons`);
      }
    }

    // Include other interactive elements
    if (dom.interactiveElements && dom.interactiveElements.length > 0) {
      summary.push(`\nOther interactive elements (${dom.interactiveElements.length}):`);
      dom.interactiveElements.slice(0, 10).forEach(el => {
        const text = el.text || el.role || el.tag;
        summary.push(`  - <${el.tag}> "${text}" (${el.reason}) | Selector: "${el.selector}"`);
      });
      if (dom.interactiveElements.length > 10) {
        summary.push(`  ... and ${dom.interactiveElements.length - 10} more interactive elements`);
      }
    }

    if (dom.modals && dom.modals.length > 0) {
      summary.push(`\n⚠️ Modals detected:`);
      dom.modals.forEach((modal, idx) => {
        if (modal.closeSelector) {
          summary.push(`  Modal ${idx + 1} (${modal.type}): Close button selector: "${modal.closeSelector}"`);
        } else {
          summary.push(`  Modal ${idx + 1} (${modal.type}): ⚠️ No close button selector found - DO NOT generate close action`);
        }
      });
    }

    return summary.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS - HTML EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extracts simplified HTML from page with only interactive elements
   *
   * Limits extraction to forms, buttons, inputs, selects, textareas, and links
   * to avoid token overflow. Each element is truncated to 500 chars, and total
   * output is limited to 3000 chars.
   *
   * @param page - Playwright page instance
   * @returns Simplified HTML string with interactive elements only
   */
  private static async getPageHTML(page: Page): Promise<string> {
    try {
      // Get simplified HTML - only body with interactive elements
      const html = await page.evaluate(() => {
        // @ts-ignore - browser context
        const relevant = document.querySelectorAll('form, button, input, select, textarea, a[href]');
        const relevantHTML: string[] = [];

        // @ts-ignore - browser context
        relevant.forEach((el: any) => {
          const outerHTML = el.outerHTML;
          // Limit each element to 500 chars
          relevantHTML.push(outerHTML.length > 500 ? outerHTML.substring(0, 500) + '...' : outerHTML);
        });

        // Limit total to 3000 chars
        const result = relevantHTML.join('\n');
        return result.length > 3000 ? result.substring(0, 3000) + '\n... (truncated)' : result;
      });

      return html || '';
    } catch (error) {
      logger.warn('[ACTION_GENERATOR] Failed to extract HTML', {
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS - SANITIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sanitizes and validates actions generated by AI
   *
   * Validates action types, required fields (selectors, URLs, values),
   * and selector formats. Drops invalid actions and fixes common issues
   * like mixed selector formats. Only allows actions that can be reliably executed.
   *
   * @param actions - Raw actions from AI response
   * @returns Array of validated and sanitized actions
   */
  private static sanitizeActions(actions: any[]): DynamicAction[] {
    const sanitized: DynamicAction[] = [];

    for (const action of actions) {
      // Validate required fields
      if (!action.action || !action.description) {
        logger.warn('[ACTION_GENERATOR] Invalid action, skipping', { action });
        continue;
      }

      // Validate action type - only allow actions we can reliably execute
      const validActions = [
        // Navigation
        'goto', 'goBack', 'goForward', 'reload',
        // Interactions
        'click', 'dblclick', 'fill', 'type', 'select', 'selectOption',
        'check', 'uncheck', 'hover', 'focus', 'blur', 'press',
        // Drag & Drop / Mobile
        'dragAndDrop', 'tap', 'swipe',
        // Wait & Scroll
        'wait', 'waitForSelector', 'waitForNavigation', 'scroll', 'scrollIntoView',
        // Data
        'screenshot',
      ];
      if (!validActions.includes(action.action)) {
        logger.warn('[ACTION_GENERATOR] Invalid action type, skipping', {
          action: action.action,
          validActions: validActions.slice(0, 10).join(', ') + '...',
        });
        continue;
      }

      // Enforce required fields per action type (drop invalid actions early)
      const requiresSelector = new Set<string>([
        'click',
        'dblclick',
        'fill',
        'type',
        'select',
        'selectOption',
        'check',
        'uncheck',
        'hover',
        'focus',
        'blur',
        'dragAndDrop',
        'tap',
        'swipe',
        'waitForSelector',
        'scrollIntoView',
      ]);

      const requiresUrl = new Set<string>(['goto']);

      const requiresValue = new Set<string>([
        'fill',
        'type',
        'select',
        'selectOption',
        'press', // selector optional, key required
        'dragAndDrop', // target selector required
      ]);

      if (requiresSelector.has(action.action)) {
        if (!action.selector || !String(action.selector).trim()) {
          logger.warn('[ACTION_GENERATOR] Action requires selector but missing, dropping', {
            action: action.action,
            description: action.description,
          });
          continue;
        }
      }

      if (requiresUrl.has(action.action)) {
        if (!action.url || !String(action.url).trim()) {
          logger.warn('[ACTION_GENERATOR] Action requires url but missing, dropping', {
            action: action.action,
            description: action.description,
          });
          continue;
        }
      }

      if (requiresValue.has(action.action)) {
        if (action.value === undefined || action.value === null || String(action.value).trim() === '') {
          logger.warn('[ACTION_GENERATOR] Action requires value but missing, dropping', {
            action: action.action,
            description: action.description,
          });
          continue;
        }
      }

      // Validate selector format to catch AI mistakes early
      if (action.selector) {
        const { validateSelectorFormat } = require('./utils/selector-utils');
        const originalSelector = String(action.selector);
        let selectorToValidate = originalSelector;

        let validation = validateSelectorFormat(selectorToValidate);
        if (!validation.isValid && validation.format === 'mixed') {
          // Try to extract Playwright part from mixed selector
          const playwrightMatch = selectorToValidate.match(/(role|text|label)\s*=\s*(.+)$/);
          if (playwrightMatch) {
            selectorToValidate = `${playwrightMatch[1]}=${playwrightMatch[2].trim()}`;
            validation = validateSelectorFormat(selectorToValidate);

            logger.warn('[ACTION_GENERATOR] Mixed selector fixed by extracting Playwright part', {
              original: originalSelector,
              extracted: selectorToValidate,
            });
          }
        }

        if (!validation.isValid) {
          logger.warn('[ACTION_GENERATOR] Invalid selector format, dropping action', {
            action: action.action,
            selector: originalSelector,
            issue: validation.issue,
            format: validation.format,
            description: action.description,
          });
          continue;
        }

        // Persist any extracted/fixed selector
        action.selector = selectorToValidate;
      }

      // Build sanitized action
      const sanitizedAction: DynamicAction = {
        action: action.action,
        selector: action.selector,
        value: action.value,
        url: action.url,
        description: action.description,
        expectedResult: action.expectedResult,
        timeout: action.timeout || 10000,
        optional: action.optional || false,
        retry: action.retry || 3,
      };

      sanitized.push(sanitizedAction);
    }

    return sanitized;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS - JSON PARSING, PII MASKING, VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Finds a balanced JSON object or array in a string by tracking bracket depth
   *
   * Handles nested structures correctly by counting opening and closing brackets.
   * Returns the substring from the first opening bracket to the matching closing bracket.
   *
   * @param str - String to search in
   * @param startChar - Starting character: '{' for objects or '[' for arrays
   * @returns Extracted JSON string or null if not found
   */
  private static findBalancedJSON(str: string, startChar: '{' | '['): string | null {
    const endChar = startChar === '{' ? '}' : ']';
    let depth = 0;
    const startIdx = str.indexOf(startChar);
    if (startIdx === -1) return null;

    for (let i = startIdx; i < str.length; i++) {
      if (str[i] === startChar) depth++;
      if (str[i] === endChar) {
        depth--;
        if (depth === 0) {
          return str.substring(startIdx, i + 1);
        }
      }
    }
    return null;
  }

  /**
   * Parses JSON from LLM response with multiple fallback strategies
   *
   * Handles cases where LLM returns:
   * - Pure JSON
   * - JSON wrapped in markdown code blocks
   * - Text with JSON embedded
   * - JSON with trailing commas or comments
   *
   * Tries direct parse first, then extracts from markdown blocks, then searches
   * for JSON in content. Cleans up common issues before parsing.
   *
   * @param content - Raw LLM response content
   * @param schema - Zod schema for validation after parsing
   * @returns Parsed and validated JSON object
   * @throws Error if all parsing attempts fail
   */
  private static parseRobustJSON<T>(content: string, schema: z.ZodSchema<T>): T {
    // Try direct parse first
    try {
      const parsed = JSON.parse(content);
      const validated = schema.parse(parsed);
      return validated;
    } catch (directError) {
      logger.warn('[ACTION_GENERATOR] Direct JSON parse failed, trying extraction', {
        error: directError instanceof Error ? directError.message : String(directError),
      });
    }

    // Try to extract JSON from markdown code blocks (both object and array)
    const markdownBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownBlockMatch) {
      const blockContent = markdownBlockMatch[1].trim();
      const jsonObject = this.findBalancedJSON(blockContent, '{');
      const jsonArray = this.findBalancedJSON(blockContent, '[');
      const jsonInBlock = jsonObject || jsonArray;

      if (jsonInBlock) {
        try {
          // Try to fix common issues: trailing commas, comments
          const cleaned = jsonInBlock
            .replace(/,\s*([}\]])/g, '$1') // Remove trailing commas
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
            .replace(/\/\/.*$/gm, ''); // Remove line comments

          const parsed = JSON.parse(cleaned);
          const validated = schema.parse(parsed);
          logger.info('[ACTION_GENERATOR] Successfully extracted JSON from markdown block');
          return validated;
        } catch (blockError) {
          logger.warn('[ACTION_GENERATOR] Markdown block extraction failed', {
            error: blockError instanceof Error ? blockError.message : String(blockError),
          });
        }
      }
    }

    // Try to find first { ... } or [ ... ] in content
    // Use balanced bracket matching for nested structures
    const jsonObject = this.findBalancedJSON(content, '{');
    const jsonArray = this.findBalancedJSON(content, '[');
    const jsonMatch = jsonObject || jsonArray;

    if (jsonMatch) {
      try {
        // Try to fix common issues
        const cleaned = jsonMatch
          .replace(/,\s*([}\]])/g, '$1') // Remove trailing commas
          .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
          .replace(/\/\/.*$/gm, ''); // Remove line comments

        const parsed = JSON.parse(cleaned);
        const validated = schema.parse(parsed);
        logger.info('[ACTION_GENERATOR] Successfully extracted JSON from content');
        return validated;
      } catch (matchError) {
        logger.warn('[ACTION_GENERATOR] Content extraction failed', {
          error: matchError instanceof Error ? matchError.message : String(matchError),
        });
      }
    }

    // All attempts failed
    throw new Error(`Failed to parse JSON from LLM response. Content preview: ${content.substring(0, 200)}...`);
  }

  /**
   * Masks personally identifiable information (PII) in HTML before sending to LLM
   *
   * Replaces sensitive data with placeholders to protect user privacy:
   * - Email addresses → [EMAIL]
   * - Phone numbers → [PHONE]
   * - API keys (sk_, pk_, api_, etc.) → [API_KEY]
   * - JWT tokens → [JWT]
   * - Long tokens (>40 chars) → [TOKEN]
   * - Credit card numbers → [CARD]
   * - IP addresses → [IP]
   * - Social Security Numbers → [SSN]
   *
   * @param html - HTML string to sanitize
   * @returns HTML string with PII masked
   */
  private static maskPII(html: string): string {
    if (!html) return '';

    let masked = html;

    // Mask emails: test@example.com → [EMAIL]
    masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

    // Mask phone numbers: more precise pattern to avoid false positives
    // Matches: +1234567890, (123) 456-7890, 123-456-7890, etc.
    masked = masked.replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]');

    // Mask API keys (common patterns: sk_, pk_, api_)
    masked = masked.replace(/\b(sk|pk|api|key|token|secret)_[a-zA-Z0-9]{20,}\b/gi, '[API_KEY]');

    // Mask JWT tokens (header.payload.signature)
    masked = masked.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[JWT]');

    // Mask tokens/keys (long alphanumeric strings > 40 chars)
    // Higher threshold to avoid false positives on normal IDs/classes
    masked = masked.replace(/\b[a-zA-Z0-9_-]{40,}\b/g, '[TOKEN]');

    // Mask credit card numbers (basic pattern)
    masked = masked.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]');

    // Mask IP addresses (IPv4)
    masked = masked.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]');

    // Mask SSN (US Social Security Numbers: XXX-XX-XXXX)
    masked = masked.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');

    return masked;
  }
}
