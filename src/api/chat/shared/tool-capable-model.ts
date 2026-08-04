/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TOOL-CAPABLE MODEL SELECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Our shared OpenAI wrapper does not reliably forward tool / response_format
 * params through the Gemini path, so any call site about to make a function
 * call must not use a Gemini-configured tier.
 *
 * This existed as THREE byte-identical private copies (`mobile_agent/pipeline`,
 * `mobile_agent/planner`, `mobile_action/handler`), each hardcoding its own
 * fallback model id. Three copies of one rule drift — and being private, the
 * branch could not be unit-tested at all, so a fallback returning `undefined`
 * would have passed every suite.
 */

import { AI_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';

/**
 * The configured `fast` model, or the `smart` tier when `fast` is a Gemini model.
 *
 * Returns the SMART TIER rather than a hardcoded id: the requirement is only
 * "an OpenAI model that supports tool calling", so it should track configuration
 * instead of pinning a separate model that then rots (the previous
 * `'gpt-4.1-mini'` literal outlived the tier it was copied from).
 *
 * @param logTag Caller tag for the warning, e.g. `MOBILE_PLANNER`.
 */
export function chooseToolCapableModel(logTag: string): string {
  const configured = AI_MODELS.fast;
  if (typeof configured === 'string' && configured.startsWith('gemini-')) {
    // Last-resort literal: only reached if `smart` is itself missing or Gemini.
    // Returning an empty/undefined model id would reach the OpenAI client as the
    // model and fail the call with an opaque 400, so this path must always yield
    // SOME tool-capable OpenAI model. It is also priced in AI_PRICING, so the
    // fallback request is not mis-costed.
    const smart = AI_MODELS.smart;
    const fallback =
      typeof smart === 'string' && smart && !smart.startsWith('gemini-') ? smart : 'gpt-4.1-mini';
    logger.warn(
      `[${logTag}] Configured fast model is Gemini; tool calling is unsupported ` +
        'through the shared wrapper. Falling back to a tool-capable OpenAI model.',
      { configured, fallback },
    );
    return fallback;
  }
  return configured;
}
