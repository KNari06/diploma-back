/**
 * LitePromptBuilder
 * Builds AI prompts with JSON-only responses (no code)
 * SECURITY: AI returns structured commands, not arbitrary code
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { AIDecision, StuckCheck } from '../lite-types';

export class LitePromptBuilder {
  /**
   * Build prompt for AI decision
   * Includes stuck warning when agent is stuck
   *
   * @param params - Prompt parameters
   * @returns Complete prompt string
   */
  static build(params: {
    goal: string;
    snapshot: string;
    history: string;
    stuckCheck: StuckCheck;
    lastOutcome?: string;
  }): string {
    // Build stuck warning if agent is stuck
    const stuckWarning = params.stuckCheck.stuck
      ? `
⚠️ WARNING: YOU ARE STUCK!
Reason: ${params.stuckCheck.reason}
Suggestion: ${params.stuckCheck.suggestion}
DO NOT repeat the same action. Try something DIFFERENT.
`
      : '';

    // Build last outcome section
    const lastOutcomeSection = params.lastOutcome
      ? `\nLAST ACTION RESULT:\n${params.lastOutcome}\n`
      : '';

    // Build complete prompt with JSON-only response format
    return `You are a browser automation agent testing a web application.

GOAL: ${params.goal}

CURRENT PAGE:
${params.snapshot}
${stuckWarning}${lastOutcomeSection}
HISTORY:
${params.history}

AVAILABLE ACTIONS (choose ONE):
- click: { "action": "click", "ref": "e5" }
- fill: { "action": "fill", "ref": "e2", "value": "text to type" }
- press: { "action": "press", "key": "Enter" }
- goto: { "action": "goto", "url": "https://..." }
- scroll: { "action": "scroll", "direction": "down" }
- select: { "action": "select", "ref": "e3", "value": "option" }
- hover: { "action": "hover", "ref": "e4" }
- wait: { "action": "wait" }

IMPORTANT RULES:
1. Use data-agent-ref values (e.g., "e5") to target elements
2. Look at parent context to understand element location
3. If an action fails repeatedly, try a different approach
4. Check for error messages or validation warnings
5. If you see a modal/popup, interact with it first
6. If the snapshot is empty or loading (< 3 elements), use the "wait" action

RESPONSE FORMAT (JSON ONLY):
{
  "thought": "Brief reasoning (1 sentence)",
  "command": { "action": "click", "ref": "e5" }
}

Special responses:
- If goal is achieved: { "done": true, "thought": "Goal completed because..." }
- If blocked (login required, captcha, verification code needed):
  Option 1: { "blocked": "Reason why blocked", "thought": "..." }
  Option 2: { "blockedInfo": { "reason": "CAPTCHA detected", "canUserHelp": true }, "thought": "..." }

Return ONLY a valid JSON object. No markdown blocks, no preamble, no extra text.
Analyze state changes after each action. Success = state changed.`;
  }

  /**
   * Ask AI for decision
   * Uses GPT-4o-mini with JSON response format
   *
   * @param prompt - Complete prompt string
   * @returns AI decision
   */
  static async askAI(prompt: string): Promise<AIDecision> {
    try {
      logger.debug('[LITE_PROMPT] Sending prompt to AI', {
        promptLength: prompt.length,
      });

      const response = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: 'gpt-4o-mini',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          max_tokens: 500,
        }
      );

      const content = response.content;

      if (!content) {
        throw new Error('Empty response from AI');
      }

      // Parse JSON response
      const parsed = JSON.parse(content);

      // Determine action type for logging
      const isBlocked = parsed.blocked || parsed.blockedInfo;
      const actionType = parsed.command?.action || (parsed.done ? 'done' : isBlocked ? 'blocked' : 'unknown');

      logger.debug('[LITE_PROMPT] Received AI decision', {
        thought: parsed.thought?.slice(0, 50),
        action: actionType,
        hasBlockedInfo: !!parsed.blockedInfo,
      });

      // Validate response structure
      if (!parsed.thought) {
        throw new Error('Missing thought in AI response');
      }

      if (parsed.done) {
        return {
          thought: parsed.thought,
          command: { action: 'wait' }, // Placeholder command
          done: true,
        };
      }

      // Handle blocked state - support both old (string) and new (object) formats
      // Priority: blockedInfo (new format) > blocked (legacy string format)
      if (parsed.blockedInfo) {
        return {
          thought: parsed.thought,
          command: { action: 'wait' }, // Placeholder command
          blockedInfo: {
            reason: parsed.blockedInfo.reason || 'Unknown reason',
            canUserHelp: parsed.blockedInfo.canUserHelp || false,
          },
        };
      }

      if (parsed.blocked) {
        return {
          thought: parsed.thought,
          command: { action: 'wait' }, // Placeholder command
          blocked: parsed.blocked,
        };
      }

      if (!parsed.command || !parsed.command.action) {
        throw new Error('Missing command in AI response');
      }

      return parsed as AIDecision;
    } catch (error) {
      logger.error('[LITE_PROMPT] Failed to get AI decision', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return safe fallback decision
      return {
        thought: 'Error getting AI decision, waiting',
        command: { action: 'wait' },
        blocked: `AI error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Build simplified prompt for testing
   * Useful for debugging
   *
   * @param goal - Test goal
   * @param snapshot - Page snapshot
   * @returns Simplified prompt
   */
  static buildSimple(goal: string, snapshot: string): string {
    return `Goal: ${goal}

Page:
${snapshot}

What should the agent do next? Respond with JSON:
{ "thought": "...", "command": { "action": "...", ... } }`;
  }
}
