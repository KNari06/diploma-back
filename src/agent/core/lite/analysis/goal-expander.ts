/**
 * GoalExpander (Manus Style)
 *
 * Expands user goal into structured keywords for precise element targeting.
 * Called once at test start, and refined on significant state changes.
 *
 * Features:
 * - expand(): Initial AI call to parse goal into action/object/negative keywords
 * - refine(): Dynamic update when funnel phase or URL changes significantly
 * - getFallback(): Graceful degradation when AI is unavailable
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { LiteElement } from '../lite-types';
import type { FunnelPhase } from './funnel-analyzer';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ExpandedGoal {
  /** Original goal string from user */
  original: string;
  /** Action verbs: buy, login, confirm, register */
  actionTokens: string[];
  /** Object nouns: shoes, account, code, form */
  objectTokens: string[];
  /** Combined set for O(1) lookup */
  allKeywords: Set<string>;
  /** Dead-end keywords to avoid: reviews, about, help, terms */
  negativeKeywords: Set<string>;
  /** Detected language: en, ru, etc. */
  language: string;
  /** Phase tracking: initial or refined */
  phase: 'initial' | 'refined';
  /** Iteration when goal was refined (if refined) */
  refinedAt?: number;
}

interface AIExpandResponse {
  actionTokens: string[];
  objectTokens: string[];
  synonyms: string[];
  negativeKeywords: string[];
  language: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// GOAL EXPANDER
// ═══════════════════════════════════════════════════════════════════════════

export class GoalExpander {
  private static readonly AI_TIMEOUT_MS = 3000;

  /**
   * Expand user goal into structured keywords.
   * Called once at test start.
   *
   * @param goal Raw goal string from user
   * @returns Structured ExpandedGoal
   */
  static async expand(goal: string): Promise<ExpandedGoal> {
    logger.info('[GOAL_EXPANDER] Expanding user goal...', { goal: goal.slice(0, 50) });

    try {
      const response = await Promise.race([
        this.callExpandAI(goal),
        this.timeout(this.AI_TIMEOUT_MS),
      ]);

      if (!response) {
        logger.warn('[GOAL_EXPANDER] AI timeout, using fallback');
        return this.getFallback(goal);
      }

      return this.parseExpandResponse(goal, response);
    } catch (error) {
      logger.error('[GOAL_EXPANDER] Failed to expand goal', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getFallback(goal);
    }
  }

  /**
   * Refine goal keywords for current step/phase.
   * Called when URL changes significantly or funnel phase changes.
   *
   * @param originalGoal Original goal string
   * @param currentExpanded Current expanded goal
   * @param newUrl New page URL
   * @param newElements Elements on new page
   * @param funnelPhase Current funnel phase
   * @param iteration Current iteration number
   * @returns Updated ExpandedGoal
   */
  static async refine(
    originalGoal: string,
    currentExpanded: ExpandedGoal,
    newUrl: string,
    newElements: LiteElement[],
    funnelPhase: FunnelPhase,
    iteration: number
  ): Promise<ExpandedGoal> {
    logger.info('[GOAL_EXPANDER] Refining goal for new phase...', {
      phase: funnelPhase,
      url: newUrl.slice(0, 50),
    });

    try {
      const response = await Promise.race([
        this.callRefineAI(originalGoal, currentExpanded, newUrl, newElements, funnelPhase),
        this.timeout(this.AI_TIMEOUT_MS),
      ]);

      if (!response) {
        logger.warn('[GOAL_EXPANDER] Refine AI timeout, keeping current');
        return currentExpanded;
      }

      // Merge with current keywords (don't lose context)
      const refined = this.parseExpandResponse(originalGoal, response);

      // Combine keywords from both current and refined
      const mergedKeywords = new Set([
        ...currentExpanded.allKeywords,
        ...refined.allKeywords,
      ]);

      // Combine negative keywords
      const mergedNegative = new Set([
        ...currentExpanded.negativeKeywords,
        ...refined.negativeKeywords,
      ]);

      return {
        ...refined,
        allKeywords: mergedKeywords,
        negativeKeywords: mergedNegative,
        phase: 'refined',
        refinedAt: iteration,
      };
    } catch (error) {
      logger.error('[GOAL_EXPANDER] Failed to refine goal', {
        error: error instanceof Error ? error.message : String(error),
      });
      return currentExpanded;
    }
  }

  /**
   * Call AI for initial goal expansion
   */
  private static async callExpandAI(goal: string): Promise<AIExpandResponse | null> {
    const systemPrompt = `You are a Semantic Expansion Engine for an autonomous web agent.
Your task is to take a user goal and expand it into keywords that might appear on buttons, links, or forms.
Include both the original language and English equivalents.
Also identify negative keywords that indicate wrong paths (dead-ends, irrelevant sections).
Return ONLY a JSON object.`;

    const userPrompt = `Goal: "${goal}"

Return JSON:
{
  "actionTokens": ["verb1", "verb2"],
  "objectTokens": ["noun1", "noun2"],
  "synonyms": ["synonym1", "english_equivalent1"],
  "negativeKeywords": ["deadend1", "deadend2"],
  "language": "ru|en|..."
}

Rules:
- actionTokens: verbs like buy, login, register, confirm, submit
- objectTokens: nouns like cart, account, form, product, code
- synonyms: alternative words in both languages
- negativeKeywords: words that lead away from goal (about, terms, reviews, help, FAQ)
- language: detected primary language of the goal`;

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_TASK_MODELS.goalDetection,
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: 400,
        }
      );

      return JSON.parse(response.content) as AIExpandResponse;
    } catch (error) {
      logger.error('[GOAL_EXPANDER] AI call failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Call AI for goal refinement
   */
  private static async callRefineAI(
    originalGoal: string,
    currentExpanded: ExpandedGoal,
    newUrl: string,
    newElements: LiteElement[],
    funnelPhase: FunnelPhase
  ): Promise<AIExpandResponse | null> {
    // Extract step indicators from page elements
    const stepIndicators = newElements
      .filter(el => el.tag === 'h1' || el.tag === 'h2' || el.tag === 'label' || el.role === 'heading')
      .map(el => el.name)
      .filter(name => name && name.length > 2)
      .slice(0, 10);

    const systemPrompt = `You are refining keywords for THIS STEP of a multi-step goal.
The user's original goal remains the same, but we need keywords relevant to the CURRENT page.
Return ONLY a JSON object.`;

    const userPrompt = `Original goal: "${originalGoal}"
Current funnel phase: "${funnelPhase}"
New URL: "${newUrl}"
Current step indicators on page: ${JSON.stringify(stepIndicators)}

Current keywords: ${[...currentExpanded.allKeywords].slice(0, 10).join(', ')}

Update keywords for THIS STEP. Keep original intent but focus on current page context.
Return JSON:
{
  "actionTokens": ["verb1", "verb2"],
  "objectTokens": ["noun1", "noun2"],
  "synonyms": ["synonym1"],
  "negativeKeywords": ["deadend1"],
  "language": "${currentExpanded.language}"
}`;

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_TASK_MODELS.goalDetection,
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: 300,
        }
      );

      return JSON.parse(response.content) as AIExpandResponse;
    } catch (error) {
      logger.error('[GOAL_EXPANDER] Refine AI call failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Parse AI response into ExpandedGoal
   */
  private static parseExpandResponse(goal: string, data: AIExpandResponse): ExpandedGoal {
    // Combine all keywords into a Set for O(1) lookup
    const allKeywords = new Set<string>([
      ...(data.actionTokens || []),
      ...(data.objectTokens || []),
      ...(data.synonyms || []),
      ...this.tokenize(goal), // Include original goal words
    ].map(k => k.toLowerCase().trim()).filter(k => k.length > 1));

    const negativeKeywords = new Set<string>(
      (data.negativeKeywords || []).map(k => k.toLowerCase().trim()).filter(k => k.length > 1)
    );

    const result: ExpandedGoal = {
      original: goal,
      actionTokens: data.actionTokens || [],
      objectTokens: data.objectTokens || [],
      allKeywords,
      negativeKeywords,
      language: data.language || 'unknown',
      phase: 'initial',
    };

    logger.debug('[GOAL_EXPANDER] Parsed expansion', {
      keywordCount: allKeywords.size,
      negativeCount: negativeKeywords.size,
      language: result.language,
      sampleKeywords: [...allKeywords].slice(0, 5),
    });

    return result;
  }

  /**
   * Fallback when AI is unavailable. Public so callers can recover
   * when `expand()` itself throws synchronously before its internal
   * fallback path runs (rare but possible — e.g. injection of an
   * un-stringifiable goal arg). Without public access, the caller's
   * catch-block left `expandedGoal` as null, silently degrading
   * `isGoalRelevantElement` to always-false for the rest of the run.
   */
  static getFallback(goal: string): ExpandedGoal {
    const tokens = this.tokenize(goal);

    // Basic negative keywords (common dead-ends)
    const defaultNegative = new Set([
      'about', 'terms', 'privacy', 'help', 'faq', 'contact',
      'о нас', 'условия', 'политика', 'помощь', 'контакты',
    ]);

    return {
      original: goal,
      actionTokens: [],
      objectTokens: [],
      allKeywords: new Set(tokens.map(t => t.toLowerCase())),
      negativeKeywords: defaultNegative,
      language: 'unknown',
      phase: 'initial',
    };
  }

  /**
   * Simple tokenization
   */
  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      // Keep any Unicode letter/number (covers en/ru/kk) + whitespace + _;
      // `\w` is ASCII-only and `[а-яёА-ЯЁ]` drops Kazakh-specific letters.
      .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }

  /**
   * Timeout helper
   */
  private static timeout(ms: number): Promise<null> {
    return new Promise(resolve => setTimeout(() => resolve(null), ms));
  }
}
