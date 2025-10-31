import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { buildIntentPrompt } from '@/ai/prompts/intentParserPrompt';
import { IntentResult } from '@/types';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Parse user's natural language message into structured intent
 * @param message - User's message
 * @returns Parsed intent result or null if parsing failed
 */
export async function parseUserIntent(message: string): Promise<IntentResult | null> {
  try {
    const prompt = buildIntentPrompt(message);
    const model = env.OPENAI_MODEL || 'gpt-4o-mini';

    // JSON mode supported by: gpt-4-turbo, gpt-4o, gpt-4o-mini, o1, o3
    const supportsJsonMode = model.includes('gpt-4') || model.includes('gpt-3.5') || model.includes('o1') || model.includes('o3');

    const requestParams: any = {
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты помощник для парсинга намерений пользователя. Всегда возвращай только валидный JSON без дополнительного текста.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0, // Deterministic parsing
    };

    // Add JSON mode if supported
    if (supportsJsonMode) {
      requestParams.response_format = { type: 'json_object' };
    }

    const response = await openai.chat.completions.create(requestParams);

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      logger.warn('Empty intent parsing response');
      return null;
    }

    // Try to parse JSON (handle cases where response format is not enforced)
    let parsed: IntentResult;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1]);
      } else {
        throw parseError;
      }
    }

    // Validate required fields
    if (!parsed.intent) {
      logger.warn('Invalid intent result: missing intent', { parsed });
      return null;
    }

    // Store original message for reference
    if (!parsed.rawText) {
      parsed.rawText = message;
    }

    // Normalize common values (optional, helps with consistency)
    const knownIntents = ['check_element', 'fill_form', 'login_flow', 'assert_ui', 'navigate', 'general_chat'];
    if (!knownIntents.includes(parsed.intent)) {
      logger.info('Custom intent detected', { intent: parsed.intent });
    }

    logger.info('Intent parsed successfully', { intent: parsed.intent, messageLength: message.length });

    return parsed;
  } catch (error) {
    logger.error('Intent parsing failed', { error, message });
    return null;
  }
}
