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
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { Page } from 'playwright';
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
// ACTION GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

export class ContextualActionGenerator {
  /**
   * Generate actions based on current page context
   * @param context - Current page context
   * @param state - Current test state
   * @returns Array of dynamic actions to execute
   */
  static async generateActions(
    context: PageContext,
    state: TestState,
    page?: Page  // ✅ NEW: Optional page for getting HTML
  ): Promise<{
    actions: DynamicAction[];
    reasoning: string;
    confidence: number;
  }> {
    const startTime = Date.now();

    logger.info('[ACTION_GENERATOR] Generating actions', {
      pageType: context.pageType,
      url: context.url,
      goal: state.goal,
    });

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

      // ✅ NEW: Get actual HTML from page (limited to avoid token overflow)
      const actualHTML = page ? await this.getPageHTML(page) : '';

      const prompt = buildActionGenerationPrompt({
        pageType: context.pageType,
        goal: state.goal,
        pageDescription: context.vision.description,
        availableElements: elementsSummary,
        history: historySummary,
        domSummary,
        actualHTML,
      });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o', // ✅ UPGRADED: Using GPT-4o for better Playwright code generation
        messages: [
          {
            role: 'system',
            content: 'You are an expert QA automation engineer generating test actions.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 1500,
        temperature: 0.4, // Some creativity, but not too much
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Action Generator');
      }

      const parsed = JSON.parse(content);

      // Validate and sanitize actions
      const actions = this.sanitizeActions(parsed.actions || []);

      const duration = Date.now() - startTime;
      logger.info('[ACTION_GENERATOR] Actions generated', {
        count: actions.length,
        confidence: parsed.confidence || 0,
        duration: `${duration}ms`,
      });

      return {
        actions,
        reasoning: parsed.reasoning || 'No reasoning provided',
        confidence: parsed.confidence || 0.5,
      };
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
    context: PageContext
  ): Promise<NextStepDecision> {
    logger.info('[ACTION_GENERATOR] Deciding next step', {
      pageType: context.pageType,
      pagesVisited: state.pagesAnalyzed,
      goal: state.goal,
    });

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

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert QA engineer deciding next testing steps.',
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

      const parsed = JSON.parse(content);

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

      // Validate action type
      const validActions = [
        'goto',
        'click',
        'fill',
        'type',
        'select',
        'check',
        'uncheck',
        'hover',
        'press',
        'wait',
        'waitForSelector',
        'waitForNavigation',
        'scroll',
        'assertVisible',
        'assertText',
        'assertValue',
        'assertUrl',
        'assertCount',
        'extract',
        'screenshot',
      ];
      if (!validActions.includes(action.action)) {
        logger.warn('[ACTION_GENERATOR] Invalid action type', { action: action.action });
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

    // Close modals if present
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

    // If no actions generated, wait
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
}
