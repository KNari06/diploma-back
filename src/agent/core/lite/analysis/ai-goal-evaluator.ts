/**
 * AIGoalEvaluator
 * AI-powered goal evaluation fallback for when heuristic detection is uncertain.
 * Uses gpt-4o-mini with strict JSON response format.
 *
 * Triggers:
 * 1. When AI says done=true but heuristic is uncertain
 * 2. When agent is stuck for 2+ consecutive iterations
 *
 * Returns structured GoalEval with evidence and optional nextSubgoal.
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { checkTestCancelled } from '../../../playwright/utils/test-cancellation-checker';
import type { GoalContext, GoalEval } from '../lite-types';

// Configuration
const AI_FALLBACK_TIMEOUT_MS = 12000; // 12 seconds (within 10-15s range)
const AI_FALLBACK_MODEL = 'gpt-4o-mini'; // Faster/cheaper, sufficient for yes/no + evidence
const MIN_CONFIDENCE_THRESHOLD = 0.5; // Below this, we don't trust the result

/**
 * AIGoalEvaluator class
 * Provides AI-powered goal evaluation when heuristic is uncertain
 */
export class AIGoalEvaluator {
  private testId: string;

  constructor(testId: string) {
    this.testId = testId;
  }

  /**
   * Evaluate goal state using AI
   * Called when heuristic is uncertain or stuck
   *
   * @param context - Full goal context
   * @param trigger - What triggered this evaluation ('done_validation' | 'stuck_recovery')
   * @returns GoalEval or null if timeout/cancelled/error
   */
  async evaluate(
    context: GoalContext,
    trigger: 'done_validation' | 'stuck_recovery'
  ): Promise<GoalEval | null> {
    try {
      // Check if test was cancelled before making AI call
      await checkTestCancelled(this.testId);

      logger.info('[AI_GOAL_EVALUATOR] Starting evaluation', {
        testId: this.testId,
        trigger,
        goal: context.goal.slice(0, 50),
        iteration: context.iteration,
        consecutiveStuckCount: context.consecutiveStuckCount,
      });

      // Build prompt based on trigger type
      const prompt = this.buildPrompt(context, trigger);

      // Race between AI call and timeout
      const result = await Promise.race([
        this.callAI(prompt),
        this.createTimeoutPromise(),
      ]);

      if (!result) {
        logger.warn('[AI_GOAL_EVALUATOR] Evaluation timed out', {
          testId: this.testId,
          trigger,
          timeoutMs: AI_FALLBACK_TIMEOUT_MS,
        });
        return null;
      }

      // Validate confidence threshold
      if (result.confidence < MIN_CONFIDENCE_THRESHOLD) {
        logger.info('[AI_GOAL_EVALUATOR] Low confidence result, treating as uncertain', {
          testId: this.testId,
          confidence: result.confidence,
          threshold: MIN_CONFIDENCE_THRESHOLD,
        });
        // Still return the result, but LiteEngine will decide whether to trust it
      }

      logger.info('[AI_GOAL_EVALUATOR] Evaluation complete', {
        testId: this.testId,
        trigger,
        goalReached: result.goalReached,
        confidence: result.confidence,
        hasNextSubgoal: !!result.nextSubgoal,
        evidenceCount: result.evidence.length,
      });

      return result;
    } catch (error) {
      // Check if cancelled
      if (error instanceof Error && error.message.includes('cancelled')) {
        logger.info('[AI_GOAL_EVALUATOR] Test cancelled, aborting evaluation', {
          testId: this.testId,
        });
        throw error; // Re-throw cancellation errors
      }

      logger.error('[AI_GOAL_EVALUATOR] Evaluation failed', {
        testId: this.testId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Build prompt for AI evaluation
   */
  private buildPrompt(context: GoalContext, trigger: 'done_validation' | 'stuck_recovery'): string {
    const contextSection = `
GOAL: ${context.goal}

CURRENT PAGE:
- URL: ${context.page.url}
- Title: ${context.page.title}

PAGE ELEMENTS (key elements only):
${context.snapshotSummary.slice(0, 30).join('\n') || 'No elements collected'}

RECENT HISTORY:
${context.history || 'No history yet'}

LAST ACTION RESULT:
${context.lastOutcome || 'No previous action'}

ERRORS (if any):
${context.recentErrors.slice(0, 3).map(e => `- [${e.type}] ${e.message}`).join('\n') || 'No errors'}
`.trim();

    if (trigger === 'done_validation') {
      return `You are evaluating whether a web testing goal has been achieved.

${contextSection}

The AI agent claims the goal is DONE. Your job is to VALIDATE this claim.

Analyze the page state carefully. Look for:
1. URL patterns that confirm the goal (e.g., /success, /thank-you, /dashboard)
2. Success messages or confirmations
3. Expected page elements that indicate completion
4. Form submission results
5. Any error messages that contradict success

RESPOND WITH JSON ONLY:
{
  "goalReached": true/false,
  "progressScore": 0.0-1.0,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation",
  "evidence": ["Specific evidence 1", "Specific evidence 2"]
}

Be STRICT - only confirm goalReached if there is clear evidence.`;
    } else {
      // stuck_recovery
      return `You are helping a stuck web testing agent.

${contextSection}

The agent has been STUCK for ${context.consecutiveStuckCount} iterations.
Current stuck reason: ${context.stuckCheck.reason || 'Unknown'}

Your job is to:
1. Assess current progress toward the goal (0-100%)
2. Identify what's blocking progress
3. Suggest a specific NEXT SUBGOAL to pursue

RESPOND WITH JSON ONLY:
{
  "goalReached": false,
  "progressScore": 0.0-1.0,
  "confidence": 0.0-1.0,
  "reason": "What's blocking progress",
  "evidence": ["Current state observation 1", "Blocking factor 2"],
  "nextSubgoal": "Specific action to try next (e.g., 'Look for and click the menu button', 'Scroll down to find the registration link')"
}

Focus on providing actionable nextSubgoal to help the agent recover.`;
    }
  }

  /**
   * Call AI with prompt
   */
  private async callAI(prompt: string): Promise<GoalEval | null> {
    try {
      const response = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: AI_FALLBACK_MODEL,
          temperature: 0.1, // Low temperature for consistent evaluation
          response_format: { type: 'json_object' },
          max_tokens: 400, // Compact response
        }
      );

      const content = response.content;

      if (!content) {
        logger.warn('[AI_GOAL_EVALUATOR] Empty response from AI');
        return null;
      }

      const parsed = JSON.parse(content);

      // Validate required fields
      if (typeof parsed.goalReached !== 'boolean') {
        throw new Error('Missing goalReached field');
      }

      return {
        goalReached: parsed.goalReached,
        progressScore: Number(parsed.progressScore) || 0,
        confidence: Number(parsed.confidence) || 0.5,
        reason: String(parsed.reason || 'No reason provided'),
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
        nextSubgoal: parsed.nextSubgoal ? String(parsed.nextSubgoal) : undefined,
      };
    } catch (error) {
      logger.error('[AI_GOAL_EVALUATOR] Failed to parse AI response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create timeout promise
   */
  private createTimeoutPromise(): Promise<null> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(null), AI_FALLBACK_TIMEOUT_MS);
    });
  }
}

/**
 * Build compact snapshot summary for AI context
 * Max 50 elements, only important ones (forms, CTAs, headings, inputs)
 *
 * @param elements - All page elements
 * @returns Array of compact element descriptions
 */
export function buildSnapshotSummary(
  elements: Array<{ tag: string; type?: string; name: string; role?: string }>
): string[] {
  const summary: string[] = [];
  const maxElements = 50;

  // Priority tags: forms, all input types, buttons, links, headings, dialogs, navigation
  const priorityTags = new Set([
    'form', 'input', 'textarea', 'select', 'button', 'a',
    'h1', 'h2', 'h3', 'h4',
    'dialog', 'details', 'summary', 'meter', 'output', 'nav',
  ]);

  // Priority ARIA roles: interactive widgets that may not use standard tags
  const priorityRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio',
    'switch', 'slider', 'spinbutton', 'combobox', 'listbox',
    'menuitem', 'tab', 'tabpanel', 'dialog', 'alertdialog',
    'progressbar', 'searchbox', 'option', 'menuitemcheckbox',
    'menuitemradio', 'treeitem',
  ]);

  for (const el of elements) {
    if (summary.length >= maxElements) break;

    const tagLower = el.tag?.toLowerCase() || '';
    const roleLower = el.role?.toLowerCase() || '';

    // Include if tag is priority OR role is priority
    if (!priorityTags.has(tagLower) && !priorityRoles.has(roleLower)) continue;

    // Skip empty names
    const name = el.name?.trim();
    if (!name) continue;

    // Format: "tag[type]:name" or "tag(role):name" for role-based elements
    const typeInfo = el.type ? `[${el.type}]` : '';
    const roleInfo = !el.type && roleLower && !priorityTags.has(tagLower) ? `(${roleLower})` : '';
    const entry = `${el.tag}${typeInfo}${roleInfo}:${name.slice(0, 50)}`;

    summary.push(entry);
  }

  return summary;
}
