/**
 * Intent Parser Service
 * Parses natural language intent into structured format
 * Hybrid approach: Use action.description first, generate from goal+context as fallback
 */

import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import type { ParsedIntent, DOMNode } from './types';

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 30000, // 30 seconds for intent parsing
  maxRetries: 2,
});

// ═══════════════════════════════════════════════════════════════════════════
// INTENT PARSER SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class IntentParserService {
  /**
   * Parse intent from action description or goal
   * Priority: action.description > generated from goal+context
   */
  static async parseIntent(params: {
    intent: string; // Raw intent (from action.description or user input)
    goal?: string; // Overall test goal (fallback context)
    pageContext?: {
      url: string;
      pageType?: string;
      nodes?: DOMNode[];
    };
  }): Promise<ParsedIntent> {
    const { intent, goal, pageContext } = params;

    logger.info('[INTENT_PARSER] Parsing intent', {
      intent: intent.substring(0, 100),
      hasGoal: !!goal,
      hasPageContext: !!pageContext,
    });

    try {
      // Fast path: Use rule-based parsing for common patterns
      const ruleBased = this.tryRuleBasedParsing(intent);
      if (ruleBased && ruleBased.confidence > 0.7) {
        logger.info('[INTENT_PARSER] Rule-based parsing succeeded', {
          confidence: ruleBased.confidence,
          action: ruleBased.action,
          targetType: ruleBased.target.type,
        });
        return ruleBased;
      }

      // Slow path: Use AI for complex intents
      logger.debug('[INTENT_PARSER] Rule-based failed, using AI', {
        ruleBasedConfidence: ruleBased?.confidence || 0,
      });
      return await this.parseWithAI(intent, goal, pageContext);
    } catch (error) {
      logger.error('[INTENT_PARSER] Failed to parse intent', { error, intent });

      // Return fallback parsed intent
      return {
        action: 'click',
        target: {
          type: 'element',
          description: intent,
        },
        confidence: 0.3,
      };
    }
  }

  /**
   * Rule-based intent parsing (fast path)
   * Handles common patterns without AI
   */
  private static tryRuleBasedParsing(intent: string): ParsedIntent | null {
    const intentLower = intent.toLowerCase().trim();

    // Pattern 1: "click login button", "click primary CTA"
    const clickPattern = /^(click|tap|press)\s+(.+?)(?:\s+button|\s+link)?$/i;
    const clickMatch = intentLower.match(clickPattern);
    if (clickMatch) {
      const description = clickMatch[2];
      return {
        action: 'click',
        target: {
          type: description.includes('link') ? 'link' : 'button',
          description,
          text: description.includes('text') ? description.replace(/.*text[:\s]+["']?([^"']+)["']?/i, '$1') : undefined,
        },
        confidence: 0.85,
      };
    }

    // Pattern 2: "fill email field", "type password", "enter username"
    const fillPattern = /^(fill|type|enter)\s+(.+?)(?:\s+field|\s+input)?$/i;
    const fillMatch = intentLower.match(fillPattern);
    if (fillMatch) {
      const description = fillMatch[2];
      let inputType = 'input';

      // Detect input type from description
      if (description.includes('email')) inputType = 'email';
      else if (description.includes('password')) inputType = 'password';
      else if (description.includes('search')) inputType = 'search';
      else if (description.includes('phone')) inputType = 'tel';

      return {
        action: 'fill',
        target: {
          type: 'input',
          description,
          attributes: { type: inputType },
        },
        confidence: 0.85,
      };
    }

    // Pattern 3: "select option from dropdown", "choose country"
    const selectPattern = /^(select|choose)\s+(.+?)(?:\s+from|\s+in)?/i;
    const selectMatch = intentLower.match(selectPattern);
    if (selectMatch) {
      return {
        action: 'select',
        target: {
          type: 'select',
          description: selectMatch[2],
        },
        confidence: 0.80,
      };
    }

    // Pattern 4: "check terms checkbox", "uncheck newsletter"
    const checkPattern = /^(check|uncheck|tick|untick)\s+(.+?)(?:\s+checkbox)?$/i;
    const checkMatch = intentLower.match(checkPattern);
    if (checkMatch) {
      return {
        action: 'check',
        target: {
          type: 'checkbox',
          description: checkMatch[2],
        },
        confidence: 0.85,
      };
    }

    // Pattern 5: "primary CTA", "main button", "submit button" (no action verb)
    const ctaPattern = /^(primary|main|submit|login|signup)\s+(button|cta|link)/i;
    const ctaMatch = intentLower.match(ctaPattern);
    if (ctaMatch) {
      return {
        action: 'click',
        target: {
          type: 'button',
          description: ctaMatch[0],
        },
        confidence: 0.75,
      };
    }

    // Pattern 6: Contextual description "under hero title", "in navigation"
    const contextPattern = /(.+?)\s+(under|in|inside|within|below|above)\s+(.+)/i;
    const contextMatch = intentLower.match(contextPattern);
    if (contextMatch) {
      return {
        action: 'click', // Default action
        target: {
          type: 'element',
          description: contextMatch[1].trim(),
        },
        context: {
          parent: contextMatch[3].trim(),
        },
        confidence: 0.70,
      };
    }

    // No pattern matched
    return null;
  }

  /**
   * AI-based intent parsing (slow path)
   * For complex or ambiguous intents
   */
  private static async parseWithAI(
    intent: string,
    goal?: string,
    pageContext?: {
      url: string;
      pageType?: string;
      nodes?: DOMNode[];
    }
  ): Promise<ParsedIntent> {
    const prompt = `You are an expert at understanding natural language test intents.

Parse this test intent into structured format:

INTENT: "${intent}"

${goal ? `OVERALL GOAL: "${goal}"` : ''}
${pageContext ? `PAGE CONTEXT:
- URL: ${pageContext.url}
- Type: ${pageContext.pageType || 'unknown'}
- Elements on page: ${pageContext.nodes?.length || 0}
` : ''}

Return JSON with this structure:
{
  "action": "click|fill|select|check|hover|extract",
  "target": {
    "type": "button|link|input|checkbox|select|element",
    "description": "what element to find",
    "text": "expected text content (if mentioned)",
    "role": "expected ARIA role (if known)",
    "attributes": {
      "type": "email|password|text|etc (for inputs)",
      "name": "attribute name (if mentioned)"
    }
  },
  "context": {
    "parent": "parent element description (if mentioned: 'under hero', 'in navigation')",
    "position": "first|last|number (if multiple matches expected)",
    "visibility": "visible|hidden (default: visible)"
  },
  "confidence": 0.0-1.0
}

Examples:

Intent: "click primary CTA under hero title"
→ {
  "action": "click",
  "target": {"type": "button", "description": "primary CTA"},
  "context": {"parent": "hero title"},
  "confidence": 0.9
}

Intent: "fill email field in login form"
→ {
  "action": "fill",
  "target": {"type": "input", "description": "email field", "attributes": {"type": "email"}},
  "context": {"parent": "login form"},
  "confidence": 0.95
}

Intent: "first login button"
→ {
  "action": "click",
  "target": {"type": "button", "description": "login button"},
  "context": {"position": "first"},
  "confidence": 0.85
}

Now parse the intent above. Return ONLY valid JSON.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Fast model for intent parsing
      messages: [
        {
          role: 'system',
          content: 'You are an expert test automation assistant. Parse natural language intents into structured format. Return only valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1, // Low temperature for consistency
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices[0].message.content || '{}');

    logger.info('[INTENT_PARSER] AI parsing completed', {
      action: parsed.action,
      targetType: parsed.target?.type,
      confidence: parsed.confidence,
    });

    return parsed as ParsedIntent;
  }

  /**
   * Normalize intent text (for caching)
   * Converts variations to canonical form
   */
  static normalizeIntent(intent: string): string {
    return intent
      .toLowerCase()
      .trim()
      // Remove extra whitespace
      .replace(/\s+/g, ' ')
      // Normalize quotes
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'")
      // Normalize action verbs
      .replace(/^(tap|press)\s+/, 'click ')
      .replace(/^(type|enter)\s+/, 'fill ')
      .replace(/^choose\s+/, 'select ');
  }
}
