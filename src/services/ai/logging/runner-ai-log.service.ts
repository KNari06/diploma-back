import { calculateGeminiCost, calculateOpenAICost } from '../tracking/ai-usage-tracker';

/**
 * Normalises one mobile-runner AI-log event before it reaches the buffer and
 * the cost ledger.
 *
 * WHY THIS EXISTS: the runner reports LLM calls it made itself (the backend
 * never sees them through openai.service/gemini.service), so this endpoint is
 * their only entry point. Two problems it fixes:
 *
 *  1. **The runner never sends cost.** `forwardAILog` accepts `costUSD` but its
 *     call sites do not pass it, so every runner-originated row landed with
 *     `cost_usd = null` — i.e. mobile reported $0 spend forever. Cost is now
 *     derived here from (provider, model, tokens).
 *  2. **Client-supplied cost cannot be trusted anyway.** Deriving it server-side
 *     also keeps ONE pricing table (`AI_PRICING`) instead of a second copy in
 *     another repo that would drift silently.
 *
 * Numeric fields are clamped: this endpoint authenticates with a single shared
 * runner key and takes its numbers from the request body, so a malformed or
 * hostile payload must not be able to write a negative or absurd cost into the
 * accounting ledger.
 */

/** Upper bound for a single LLM call's token count. Anything above is a bug. */
const MAX_TOKENS_PER_CALL = 5_000_000;

/** Finite, non-negative, integral, bounded — or null. */
export function sanitizeTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), MAX_TOKENS_PER_CALL);
}

/**
 * Cost for one runner LLM call, in USD, from the same pricing table the backend
 * uses for its own calls.
 *
 * Returns null when tokens are absent — null means "unknown", which is honest
 * and distinguishable in SQL. It must NOT be coerced to 0, or an unmeasured
 * call becomes indistinguishable from a free one, which is precisely the bug
 * that made mobile look costless.
 */
export function deriveRunnerCallCost(params: {
  provider: unknown;
  model: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
}): number | null {
  const { provider, model, tokensIn, tokensOut } = params;

  if (tokensIn === null && tokensOut === null) return null;
  if (typeof model !== 'string' || model.length === 0) return null;

  const input = tokensIn ?? 0;
  const output = tokensOut ?? 0;

  // The runner may report a provider we don't recognise; fall back on the model
  // name, which is what both cost functions key on anyway.
  const isGemini =
    provider === 'gemini' || (typeof provider !== 'string' && model.startsWith('gemini'));

  const cost = isGemini
    ? calculateGeminiCost(model, input, output)
    : calculateOpenAICost(model, input, output);

  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export interface NormalisedRunnerEvent {
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  provider: 'openai' | 'gemini' | null;
  model: string | null;
}

/**
 * Turn the raw request body's numeric/AI fields into ledger-safe values.
 * String fields (user_id, source, summary …) are validated by the controller.
 */
export function normaliseRunnerEvent(body: Record<string, unknown>): NormalisedRunnerEvent {
  const tokensIn = sanitizeTokenCount(body.tokens_in);
  const tokensOut = sanitizeTokenCount(body.tokens_out);
  const model = typeof body.model === 'string' && body.model ? body.model : null;
  const provider =
    body.provider === 'openai' || body.provider === 'gemini' ? body.provider : null;

  // Deliberately ignore any client-supplied `cost_usd`.
  const cost = deriveRunnerCallCost({
    provider,
    model,
    tokensIn,
    tokensOut,
  });

  const durationRaw = body.duration_ms;
  const duration =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw >= 0
      ? Math.floor(durationRaw)
      : null;

  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: cost,
    duration_ms: duration,
    provider,
    model,
  };
}
