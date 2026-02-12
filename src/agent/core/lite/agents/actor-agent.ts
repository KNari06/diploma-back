/**
 * Actor Agent — "Which element exactly?"
 * Takes the Strategist's strategy and picks the exact element + action.
 * Temperature: 0.0 (fully deterministic)
 * ~4k input tokens, ~150 output tokens
 *
 * Deterministic path: Skip AI when form analysis gives clear ref
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';
import type { ActorInput, ActorOutput, FormAnalysis } from './types';

export class ActorAgent {
  /**
   * Pick the exact element and action based on the strategy
   * Returns null if cannot determine action
   */
  static async act(input: ActorInput): Promise<ActorOutput | null> {
    // Deterministic path: try to resolve without AI
    const deterministic = ActorAgent.tryDeterministicPath(input);
    if (deterministic) {
      logger.debug('[ACTOR] Deterministic path resolved', {
        action: deterministic.command.action,
        ref: deterministic.command.ref,
      });
      return deterministic;
    }

    // AI path
    const prompt = ActorAgent.buildPrompt(input);

    const result = await LitePromptBuilder.askJson<ActorOutput>(prompt, {
      model: LITE_ENGINE_FLAGS.coreBrainModel as 'gpt-4o' | 'gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 200,
      timeoutMs: LITE_ENGINE_FLAGS.multiAgentActorTimeoutMs,
    });

    if (!result || !result.command || !result.command.action) {
      logger.warn('[ACTOR] Failed to produce action');
      return null;
    }

    logger.debug('[ACTOR] AI action resolved', {
      action: result.command.action,
      ref: result.command.ref,
      reasoning: result.reasoning?.slice(0, 50),
    });

    return result;
  }

  /**
   * Try to resolve the action without AI
   * Works when strategy clearly maps to a form field or submit button
   */
  private static tryDeterministicPath(input: ActorInput): ActorOutput | null {
    if (!input.formAnalysis) return null;

    const strategyLower = input.strategy.toLowerCase();

    // Strategy says "submit the form" or "click submit/login/register" → use submit button
    // Note: bare words like "continue" excluded to avoid matching "continue scrolling"
    if (/\bsubmit\b(?!\s+(?:the |a |this )?(?:same|different|new))|(click|press|tap).*(submit|login|sign.?in|register|send|save|continue)/.test(strategyLower)) {
      if (input.formAnalysis.submitButtonRef) {
        return {
          command: { action: 'click', ref: input.formAnalysis.submitButtonRef },
          reasoning: `Deterministic: submit button "${input.formAnalysis.submitButtonText}" identified`,
        };
      }
    }

    // Strategy says "fill <fieldType>" → find matching field
    const fillMatch = strategyLower.match(/fill\s+(the\s+)?(\w+)/);
    if (fillMatch) {
      const targetType = fillMatch[2];
      const matchingField = ActorAgent.findMatchingField(input.formAnalysis, targetType);
      if (matchingField) {
        const isSensitive = /password|email|phone|username/i.test(matchingField.type);
        return {
          command: {
            action: 'fill',
            ref: matchingField.ref,
            value: 'placeholder',
            isSensitive: input.hasCredentials && isSensitive,
          },
          reasoning: `Deterministic: matched "${targetType}" to field "${matchingField.label}" (${matchingField.ref})`,
        };
      }
    }

    return null;
  }

  /**
   * Find a form field matching a type keyword
   */
  private static findMatchingField(form: FormAnalysis, targetType: string): { ref: string; type: string; label: string } | null {
    const target = targetType.toLowerCase();

    for (const field of form.fields) {
      const fieldType = field.type.toLowerCase();
      const fieldLabel = field.label.toLowerCase();

      // Direct type match
      if (fieldType === target || fieldLabel.includes(target)) {
        return field;
      }

      // Semantic matches
      if (target === 'email' && (fieldType === 'email' || fieldLabel.includes('email') || fieldLabel.includes('mail'))) {
        return field;
      }
      if (target === 'password' && (fieldType === 'password' || fieldLabel.includes('password'))) {
        return field;
      }
      if (target === 'username' && (fieldLabel.includes('username') || fieldLabel.includes('user'))) {
        return field;
      }
      if (target === 'phone' && (fieldType === 'tel' || fieldLabel.includes('phone') || fieldLabel.includes('tel'))) {
        return field;
      }
    }

    return null;
  }

  private static buildPrompt(input: ActorInput): string {
    const credentialHint = input.hasCredentials
      ? '\nCredentials are provided by the system. Use "isSensitive": true for credential fields. Use any placeholder value.\n'
      : '';

    return `You are an Action Agent. Pick the EXACT element to interact with.

GOAL: ${input.goal}

STRATEGY: ${input.strategy}
${credentialHint}
AVAILABLE ELEMENTS:
${input.relevantElements}

Respond with JSON:
{
  "command": { "action": "click", "ref": "e5" },
  "reasoning": "Clicking the Submit button to complete login"
}

Available actions:
- click: { "action": "click", "ref": "e5" }
- fill: { "action": "fill", "ref": "e2", "value": "text", "isSensitive": false }
- press: { "action": "press", "key": "Enter" }
- goto: { "action": "goto", "url": "https://..." }
- scroll: { "action": "scroll", "direction": "down", "amount": 600 }
- scroll_to: { "action": "scroll", "targetRef": "e10" }
- select: { "action": "select", "ref": "e3", "value": "option" }
- hover: { "action": "hover", "ref": "e4" }
- wait: { "action": "wait" }

Rules:
- Pick the SINGLE best element for the strategy
- Use exact ref values from the elements list
- For credential fields, set "isSensitive": true
- Return ONLY valid JSON`;
  }
}
