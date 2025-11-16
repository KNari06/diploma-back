/**
 * ContextualActionGenerator
 * Generates actions dynamically based on page context
 * Understands logical dependencies and creates realistic test scenarios
 */

import { OpenAI } from 'openai';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import {
  PageContext,
  DynamicAction,
  TestState,
  NextStepDecision,
} from './types/intelligent-testing.types';
import {
  buildActionGenerationPrompt,
  buildNextStepPrompt,
} from '@/ai/prompts/index';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

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
    state: TestState
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

    try {
      // Build history summary
      const historySummary = this.buildHistorySummary(state);

      // Build available elements summary
      const elementsSummary = this.buildElementsSummary(context);

      // Build DOM summary
      const domSummary = this.buildDOMSummary(context.dom);

      const prompt = buildActionGenerationPrompt({
        pageType: context.pageType,
        goal: state.goal,
        pageDescription: context.vision.description,
        availableElements: elementsSummary,
        history: historySummary,
        domSummary,
      });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
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

      // Return safe fallback actions
      return {
        actions: this.generateFallbackActions(context),
        reasoning: 'Action generation failed, using fallback actions',
        confidence: 0.3,
      };
    }
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

    if (critical.length > 0) {
      summary.push('Critical Elements:');
      critical.forEach(el => {
        summary.push(`- ${el.type}: ${el.purpose} (${el.text || 'no text'})`);
      });
    }

    if (high.length > 0) {
      summary.push('\nHigh Priority:');
      high.forEach(el => {
        summary.push(`- ${el.type}: ${el.purpose} (${el.text || 'no text'})`);
      });
    }

    if (others.length > 0) {
      summary.push(`\nOther Elements: ${others.length} additional elements`);
    }

    return summary.join('\n');
  }

  private static buildDOMSummary(dom: PageContext['dom']): string {
    const summary: string[] = [];

    if (dom.forms.length > 0) {
      summary.push(`Forms: ${dom.forms.length}`);
      dom.forms.forEach((form, idx) => {
        summary.push(`  Form ${idx + 1}: ${form.fields.length} fields`);
      });
    }

    if (dom.buttons.length > 0) {
      summary.push(`Buttons: ${dom.buttons.length}`);
    }

    if (dom.inputs.length > 0) {
      summary.push(`Inputs: ${dom.inputs.length}`);
    }

    if (dom.links.length > 0) {
      summary.push(`Links: ${dom.links.length}`);
    }

    if (dom.modals && dom.modals.length > 0) {
      summary.push(`⚠️ Modals detected: ${dom.modals.map(m => m.type).join(', ')}`);
    }

    return summary.join('\n');
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
      const validActions = ['goto', 'click', 'fill', 'select', 'wait', 'scroll', 'press', 'hover'];
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
        timeout: action.timeout || 5000,
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
