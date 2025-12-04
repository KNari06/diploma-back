/**
 * ContextualActionGenerator
 * Generates actions dynamically based on page context
 * Understands logical dependencies and creates realistic test scenarios
 */

import {
    buildActionGenerationPrompt,
    buildNextStepPrompt,
} from '@/ai/prompts/index';
import { env } from '@/config/env';
import { AICostManager, AIModel } from '@/services/ai-cost-manager.service';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { Page } from 'playwright';
import { z } from 'zod';
import {
    DynamicAction,
    NextStepDecision,
    PageContext,
    TestState,
} from './types/intelligent-testing.types';

// ✅ FIX: Add timeout to prevent hanging requests
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 60000, // 60 seconds timeout for OpenAI API calls
  maxRetries: 2,  // Retry failed requests up to 2 times
});

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
  progress: z.number().min(0).max(100).optional(),
  goalAchieved: z.boolean().optional(),
  nextTarget: z.string().nullable().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// CACHE FOR RECENT GENERATIONS (1-5 min TTL)
// ═══════════════════════════════════════════════════════════════════════════

interface CachedGeneration {
  actions: DynamicAction[];
  reasoning: string;
  confidence: number;
  timestamp: number;
}

const generationCache = new Map<string, CachedGeneration>();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

function getCacheKey(context: PageContext, goal: string): string {
  // Simple hash based on URL + pageType + goal
  const str = `${context.url}|${context.pageType}|${goal}`;
  return Buffer.from(str).toString('base64').substring(0, 32);
}

function getCachedGeneration(context: PageContext, goal: string): CachedGeneration | null {
  const key = getCacheKey(context, goal);
  const cached = generationCache.get(key);

  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > CACHE_TTL_MS) {
    generationCache.delete(key);
    return null;
  }

  return cached;
}

function setCachedGeneration(context: PageContext, goal: string, result: CachedGeneration): void {
  const key = getCacheKey(context, goal);
  generationCache.set(key, { ...result, timestamp: Date.now() });

  // Cleanup old entries (keep max 50)
  if (generationCache.size > 50) {
    const oldestKey = Array.from(generationCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
    generationCache.delete(oldestKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

export class ContextualActionGenerator {
  /**
   * Generate actions based on current page context
   * @param context - Current page context
   * @param state - Current test state
   * @param page - Optional page for getting HTML
   * @param costManager - Cost manager for budget control
   * @param hints - Test hints from plan (user's requested steps)
   * @returns Array of dynamic actions to execute
   */
  static async generateActions(
    context: PageContext,
    state: TestState,
    page?: Page,
    costManager?: AICostManager,
    hints?: Array<{ description: string; action?: string; target?: string; value?: string; priority?: string }>  // ✅ NEW: Test hints from plan
  ): Promise<{
    actions: DynamicAction[];
    reasoning: string;
    confidence: number;
  }> {
    const startTime = Date.now();

    // ✅ FIX 9: Check budget before proceeding
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

    // ✅ FIX 6: Check cache first (debounce rapid navigations)
    // IMPORTANT: Never reuse cached result if it contained 0 actions
    // We want the model to have another chance to propose actions instead of "sticking" to empty plan.
    const cached = getCachedGeneration(context, state.goal);
    if (cached && cached.actions.length > 0) {
      logger.info('[ACTION_GENERATOR] Using cached actions', {
        age: Date.now() - cached.timestamp,
        count: cached.actions.length,
      });
      return {
        actions: cached.actions,
        reasoning: `[CACHED] ${cached.reasoning}`,
        confidence: cached.confidence,
      };
    }

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

      // ✅ FIX 5: Mask PII before sending to LLM
      const actualHTML = page ? await this.getPageHTML(page) : '';
      const sanitizedHTML = this.maskPII(actualHTML);

      const prompt = buildActionGenerationPrompt({
        pageType: context.pageType,
        goal: state.goal,
        pageDescription: context.vision.description,
        availableElements: elementsSummary,
        history: historySummary,
        domSummary,
        actualHTML: sanitizedHTML,
        hints, // ✅ NEW: Pass hints to prompt for AI guidance
      });

      // ✅ FIX 2: Dynamic token budget based on prompt length
      const promptLength = prompt.length;
      const estimatedPromptTokens = Math.ceil(promptLength / 4); // rough estimate
      const maxTokensBudget = Math.min(1500, 4000 - estimatedPromptTokens); // leave room for response

      logger.debug('[ACTION_GENERATOR] Token budget', {
        promptLength,
        estimatedPromptTokens,
        maxTokensBudget,
      });

      // ✅ FIX 9: Get recommended model based on budget
      const preferredModel: AIModel = 'gpt-4o';
      const model = costManager ? costManager.getRecommendedModel(preferredModel) : preferredModel;

      logger.debug('[ACTION_GENERATOR] Using model', { model, preferredModel });

      const response = await openai.chat.completions.create({
        model, // ✅ FIX 9: Use adaptive model selection
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
        max_tokens: maxTokensBudget,
        temperature: 0.4, // Some creativity, but not too much
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Action Generator');
      }

      // ✅ FIX 9: Record AI cost
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

      // ✅ FIX 1: Robust JSON parsing with fallback
      const parsed = this.parseRobustJSON(content, ActionGenerationResponseSchema);

      // Validate and sanitize actions
      const actions = this.sanitizeActions(parsed.actions || []);

      const duration = Date.now() - startTime;

      // ✅ FIX 8: Log metrics
      logger.info('[ACTION_GENERATOR] Actions generated', {
        count: actions.length,
        confidence: parsed.confidence || 0,
        duration: `${duration}ms`,
        tokensUsed: response.usage?.total_tokens || 0,
        model: response.model,
      });

      const result = {
        actions,
        reasoning: parsed.reasoning || 'No reasoning provided',
        confidence: parsed.confidence || 0.5,
      };

      // ✅ FIX 6: Cache result (timestamp will be added by setCachedGeneration)
      // IMPORTANT: Cache only non-empty action sets, so "empty" decisions can be retried.
      if (actions.length > 0) {
        setCachedGeneration(context, state.goal, {
          ...result,
          timestamp: Date.now(),
        });
      }

      return result;
    } catch (error) {
      logger.error('[ACTION_GENERATOR] Action generation failed', { error });

      // Check if page is empty before generating fallback actions
      const isEmptyPage = this.isPageEmpty(context);
      if (isEmptyPage) {
        return {
          actions: [],
          reasoning: isEmptyPage.reason,
          confidence: 0.1,
        };
      }

      // Return safe fallback actions
      return {
        actions: this.generateFallbackActions(context),
        reasoning: 'Action generation failed, using fallback actions',
        confidence: 0.3,
      };
    }
  }

  /**
   * Check if page is empty or invalid (about:blank, no elements)
   * @param context - Current page context
   * @returns Object with isEmpty flag and reason, or null if page is valid
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
   * Decide next step based on current state
   * @param state - Current test state
   * @param context - Current page context
   * @returns Decision on what to do next
   */
  static async decideNextStep(
    state: TestState,
    context: PageContext,
    costManager?: AICostManager  // ✅ FIX 9: Cost manager for budget control
  ): Promise<NextStepDecision> {
    logger.info('[ACTION_GENERATOR] Deciding next step', {
      pageType: context.pageType,
      pagesVisited: state.pagesAnalyzed,
      goal: state.goal,
    });

    // ✅ FIX 9: Check budget before proceeding
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

    try {
      const historySummary = this.buildHistorySummary(state);
      const visitedPages = state.visitedPages.map(v => `${v.pageType} (${v.url})`);
      const errors = state.errors.map(e => e.message);

      const prompt = buildNextStepPrompt({
        goal: state.goal,
        history: historySummary,
        currentPage: context.pageType,
        visitedPages,
        errors,
      });

      // ✅ FIX 9: Get recommended model (always use mini for next step - it's cheaper)
      const preferredModel: AIModel = 'gpt-4o-mini';
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
        max_tokens: 800,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Next Step Decision');
      }

      // ✅ FIX 9: Record AI cost
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

      // ✅ FIX 1: Robust JSON parsing
      const parsed = this.parseRobustJSON(content, NextStepResponseSchema);

      const decision: NextStepDecision = {
        action: parsed.decision || 'stop',
        reason: parsed.reason || 'No reason provided',
        confidence: 0.8,
      };

      logger.info('[ACTION_GENERATOR] Next step decided', {
        action: decision.action,
        reason: decision.reason,
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

    // ✅ CRITICAL FIX: Include REAL selectors from DOM analysis
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

  private static buildDOMSummary(dom: PageContext['dom']): string {
    const summary: string[] = [];

    // ✅ CRITICAL FIX: Include REAL selectors from DOM
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

    // ✅ NEW: Include checkboxes and radios
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

    // ✅ NEW: Include other interactive elements
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
   * Get actual HTML from page (limited to avoid token overflow)
   * Returns simplified HTML with only interactive elements
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
   * Sanitize and validate actions from AI
   */
  private static sanitizeActions(actions: any[]): DynamicAction[] {
    const sanitized: DynamicAction[] = [];

    for (const action of actions) {
      // Validate required fields
      if (!action.action || !action.description) {
        logger.warn('[ACTION_GENERATOR] Invalid action, skipping', { action });
        continue;
      }

      // ✅ CRITICAL FIX: Validate action type - include ALL supported actions (30+)
      const validActions = [
        // Navigation
        'goto', 'goBack', 'goForward', 'reload',
        // Interactions
        'click', 'dblclick', 'fill', 'type', 'select', 'selectOption',
        'check', 'uncheck', 'hover', 'focus', 'blur', 'press',
        // Drag & Drop / Mobile
        'dragAndDrop', 'tap', 'swipe',
        // Wait & Scroll
        'wait', 'waitForSelector', 'waitForTimeout', 'waitForLoadState',
        'waitForNavigation', 'scroll', 'scrollIntoView',
        // Assertions
        'assertVisible', 'assertHidden', 'assertEnabled', 'assertDisabled',
        'assertText', 'assertValue', 'assertUrl', 'assertCount',
        // Data & Scripts
        'extract', 'evaluate', 'script', 'screenshot',
      ];
      if (!validActions.includes(action.action)) {
        logger.warn('[ACTION_GENERATOR] Invalid action type, skipping', {
          action: action.action,
          validActions: validActions.slice(0, 10).join(', ') + '...',
        });
        continue;
      }

      // Build sanitized action
      const sanitizedAction: DynamicAction = {
        action: action.action,
        selector: action.selector,
        value: action.value,
        url: action.url,
        description: action.description,
        expectedResult: action.expectedResult,
         timeout: action.timeout || 10000, // ✅ FIX: Increased default timeout from 5s to 10s
        optional: action.optional || false,
        retry: action.retry || 3,
      };

      sanitized.push(sanitizedAction);
    }

    return sanitized;
  }

  /**
   * Generate safe fallback actions when AI fails
   */
  private static generateFallbackActions(context: PageContext): DynamicAction[] {
    const actions: DynamicAction[] = [];

    // 1) Close modals if present (safest first step)
    if (context.dom.modals && context.dom.modals.length > 0) {
      context.dom.modals.forEach(modal => {
        if (modal.closeSelector) {
          actions.push({
            action: 'click',
            selector: modal.closeSelector,
            description: `Close ${modal.type}`,
            optional: true,
            timeout: 3000,
            retry: 1,
          });
        }
      });
    }

    // 2) Heuristic actions based on DOM if page has interactive elements
    // Even when AI planning fails, try a few obvious safe interactions.
    if (actions.length === 0) {
      const buttons = context.dom.buttons || [];
      const inputs = context.dom.inputs || [];

      // Click up to 3 top buttons
      buttons.slice(0, 3).forEach(btn => {
        if (!btn.selector) return;
        actions.push({
          action: 'click',
          selector: btn.selector,
          description: `Click button "${btn.text || 'button'}" (fallback)`,
          optional: true,
          timeout: 5000,
          retry: 1,
        });
      });

      // Fill the first input if available
      if (inputs.length > 0 && inputs[0].selector) {
        const input = inputs[0];
        const label = input.name || input.placeholder || input.type || 'input';
        const value = this.generateTestData(input.type || 'text', label);

        actions.push({
          action: 'fill',
          selector: input.selector,
          value,
          description: `Fill "${label}" with test data (fallback)`,
          optional: true,
          timeout: 5000,
          retry: 1,
        });
      }
    }

    // 3) If вообще ничего нет – хотя бы подождать
    if (actions.length === 0) {
      actions.push({
        action: 'wait',
        description: 'Wait for page to stabilize',
        timeout: 2000,
        optional: false,
        retry: 1,
      });
    }

    return actions;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REALISTIC TEST DATA GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate realistic test data for forms
   */
  static generateTestData(fieldType: string, fieldName: string): string {
    const timestamp = Date.now();

    switch (fieldType.toLowerCase()) {
      case 'email':
        return `test.user.${timestamp}@testmail.com`;

      case 'password':
        return 'TestPassword123!';

      case 'text':
        if (fieldName.toLowerCase().includes('name')) {
          return 'John Doe';
        }
        if (fieldName.toLowerCase().includes('phone')) {
          return '+1234567890';
        }
        if (fieldName.toLowerCase().includes('address')) {
          return '123 Test Street';
        }
        if (fieldName.toLowerCase().includes('city')) {
          return 'New York';
        }
        if (fieldName.toLowerCase().includes('zip')) {
          return '10001';
        }
        return 'Test Value';

      case 'number':
        return '1';

      case 'tel':
      case 'phone':
        return '+1234567890';

      case 'url':
        return 'https://example.com';

      case 'date':
        return new Date().toISOString().split('T')[0];

      default:
        return 'Test Input';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS - JSON PARSING, PII MASKING, VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ✅ FIX 1: Robust JSON parsing with fallback extraction
   * Handles cases where LLM returns text + JSON or invalid JSON
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

    // Try to extract JSON from markdown code blocks or text
    const jsonBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        const validated = schema.parse(parsed);
        logger.info('[ACTION_GENERATOR] Successfully extracted JSON from markdown block');
        return validated;
      } catch (blockError) {
        logger.warn('[ACTION_GENERATOR] Markdown block extraction failed', {
          error: blockError instanceof Error ? blockError.message : String(blockError),
        });
      }
    }

    // Try to find first { ... } in content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
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
   * ✅ FIX 5: Mask PII (emails, phone numbers, tokens) before sending to LLM
   */
  private static maskPII(html: string): string {
    if (!html) return '';

    let masked = html;

    // Mask emails: test@example.com → [EMAIL]
    masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

    // Mask phone numbers: +1234567890, (123) 456-7890, etc.
    masked = masked.replace(/[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}/g, '[PHONE]');

    // Mask tokens/keys (long alphanumeric strings > 20 chars)
    masked = masked.replace(/[a-zA-Z0-9_-]{32,}/g, '[TOKEN]');

    // Mask credit card numbers (basic pattern)
    masked = masked.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]');

    return masked;
  }
}
