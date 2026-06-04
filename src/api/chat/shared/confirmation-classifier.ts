/**
 * Confirmation Classifier (shared)
 *
 * Classifies a user's reply in a yes/no confirmation dialog as
 * confirm / decline / other. Gemini → OpenAI → regex fallback chain, language-
 * agnostic. Extracted so both the exploration-confirmation and management-
 * confirmation flows use one implementation (DRY).
 */

import { AI_MODELS, AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';

export type ConfirmationIntent = 'confirm' | 'decline' | 'other';

/**
 * Regex fallback — only used when the AI classification call fails. Pure.
 *
 * NOTE: uses a unicode-aware boundary `(?![\p{L}\p{N}])` instead of `\b`. JS
 * `\b` is ASCII-only, so `\bда\b` never matches Cyrillic — the lookahead
 * "next char is not a letter/digit" works across scripts. Matches a whole-word
 * affirmative/negative at the START of the reply.
 */
export function classifyConfirmationByRegex(message: string): ConfirmationIntent {
  const boundary = '(?![\\p{L}\\p{N}])';
  const confirmPattern = new RegExp(
    `^(yes|yeah|yep|y|да|ок|ok|давай|конечно|sure|go|start|proceed|confirm|подтверждаю|запускай|поехали)${boundary}`,
    'iu',
  );
  const declinePattern = new RegExp(
    `^(no|nope|n|нет|не надо|не|cancel|отмена|stop|отменить)${boundary}`,
    'iu',
  );

  const trimmed = message.trim();
  if (confirmPattern.test(trimmed)) return 'confirm';
  if (declinePattern.test(trimmed)) return 'decline';
  return 'other';
}

/**
 * Classify a confirmation reply using AI, with a deterministic regex fallback.
 * `subject` describes what the user was asked to confirm (used only to phrase
 * the classifier prompt — e.g. "start an exploration", "apply a schedule change").
 */
export async function classifyConfirmation(
  message: string,
  subject: string,
): Promise<ConfirmationIntent> {
  const trimmed = message.trim();
  if (!trimmed) return 'other';

  const promptText =
    'You classify user messages in a yes/no confirmation dialog. ' +
    `The user was asked whether they want to ${subject}. ` +
    'Classify the response as exactly one of: "confirm", "decline", or "other". ' +
    'Support any language (English, Russian, etc.).\n\n' +
    `User message: "${trimmed}"\n\n` +
    'Return ONLY valid JSON: { "intent": "confirm" | "decline" | "other" }';

  let rawContent: string | null = null;
  try {
    const response = await generateTextWithGemini({
      prompt: promptText,
      model: AI_TASK_MODELS.confirmationClassification,
      temperature: 0,
      maxTokens: 30,
      timeout: 3000,
    });
    rawContent = response.content;
  } catch (primaryErr) {
    const FALLBACK = AI_MODELS.fast;
    const sameProvider =
      AI_TASK_MODELS.confirmationClassification.startsWith('gemini-') === FALLBACK.startsWith('gemini-');
    if (sameProvider) {
      logger.warn('[CONFIRM_CLASSIFIER] AI classification failed, using regex fallback', {
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });
      return classifyConfirmationByRegex(trimmed);
    }
    try {
      const response = await getChatCompletionWithMessages(
        [{ role: 'user', content: promptText }],
        { model: FALLBACK, temperature: 0, max_tokens: 30, response_format: { type: 'json_object' } },
      );
      rawContent = response.content;
    } catch (fallbackErr) {
      logger.warn('[CONFIRM_CLASSIFIER] Primary and fallback failed, using regex fallback', {
        error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      });
      return classifyConfirmationByRegex(trimmed);
    }
  }

  try {
    const raw = (rawContent || '').replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(raw);
    const intent = parsed?.intent;
    if (intent === 'confirm' || intent === 'decline' || intent === 'other') {
      return intent;
    }
    return 'other';
  } catch {
    return classifyConfirmationByRegex(trimmed);
  }
}
