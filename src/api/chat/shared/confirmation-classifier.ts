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
import {
  AFFIRMATIVE,
  CANCEL,
  REJECTION,
  toBoundaryRegex,
  type MultiLangList,
} from '@/config/testing/intent-keywords';

export type ConfirmationIntent = 'confirm' | 'decline' | 'other';

// Decline = explicit rejection ("no") OR a cancel/abort ("stop", "отмена").
// Merge both families per-language so the boundary regex covers all of them.
const DECLINE_WORDS: MultiLangList = {
  en: [...REJECTION.en, ...CANCEL.en],
  ru: [...REJECTION.ru, ...CANCEL.ru],
  kk: [...REJECTION.kk, ...CANCEL.kk],
};

// Built once. Both use the central registry (en/ru/kk) + a unicode-aware
// boundary `(?![\p{L}\p{N}])` — JS `\b` is ASCII-only and never matches
// Cyrillic, so `\bда\b` / `\bиә\b` would silently fail.
const CONFIRM_PATTERN = toBoundaryRegex(AFFIRMATIVE);
const DECLINE_PATTERN = toBoundaryRegex(DECLINE_WORDS);

/**
 * Regex fallback — only used when the AI classification call fails. Pure.
 * Matches a whole-word affirmative/negative at the START of the reply.
 */
export function classifyConfirmationByRegex(message: string): ConfirmationIntent {
  const trimmed = message.trim();
  if (CONFIRM_PATTERN.test(trimmed)) return 'confirm';
  if (DECLINE_PATTERN.test(trimmed)) return 'decline';
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
    'You classify a user reply in a yes/no confirmation dialog.\n' +
    `The user was asked whether they want to ${subject}.\n\n` +
    'Classify as exactly one of: "confirm", "decline", or "other".\n' +
    '- "confirm" = ANY clear go-ahead, including casual/indirect phrasing. ' +
    'Examples: "yes", "ok", "sure", "go", "go ahead", "start", "let\'s start", ' +
    '"let\'s go", "let\'s do it", "proceed", "begin", "run it", "да", "давай", ' +
    '"поехали", "запускай", "иә", "жарайды".\n' +
    '- "decline" = a clear no / stop. Examples: "no", "cancel", "stop", "nevermind", ' +
    '"нет", "отмена", "жоқ".\n' +
    '- "other" = ONLY when it is genuinely neither (a question, a new unrelated ' +
    'request, or truly ambiguous). When in doubt between confirm and other, prefer "confirm" ' +
    'if the user clearly wants to go ahead.\n' +
    'Support any language (English, Russian, Kazakh, etc.).\n\n' +
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
