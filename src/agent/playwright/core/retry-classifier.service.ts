/**
 * Retry Classifier — LLM gate that decides whether a failed test should be retried.
 *
 * Philosophy: retry only for genuine infra-transient failures (browser crash, CDP
 * disconnect, network hiccup, OOM). Do NOT retry product bugs or test issues —
 * they should surface to QA immediately, not be masked by a successful retry.
 *
 * Flow: test fails → test-retry.ts passes error + context → this service calls
 * a fast LLM (gpt-5.4-mini) with a tight 3s timeout → returns a decision.
 * On any error (timeout, LLM down, parse failure) we DEFAULT TO NOT RETRY to
 * preserve "fail honestly" behaviour.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';

/** How the classifier categorises a failure. */
export type RetryCategory =
  | 'infra_transient' // browser disconnect, CDP error, socket reset, OOM → retry
  | 'product_bug' // element missing, assertion failed, wrong text → no retry
  | 'test_issue' // bad selector, unrealistic timeout, flawed step → no retry
  | 'unknown'; // couldn't tell → no retry (safe default)

export interface RetryDecision {
  shouldRetry: boolean;
  category: RetryCategory;
  reasoning: string;
  /** Milliseconds spent in classifier (for telemetry). */
  elapsedMs: number;
  /** True if we used a safe default because the LLM call failed. */
  fallbackUsed?: boolean;
}

export interface RetryClassificationContext {
  /** Primary error message from the failed attempt. */
  errorMessage: string;
  /** Which step failed (description from the step editor), if known. */
  failedStepDescription?: string;
  /** Backend-reported failure reason (e.g. 'element_not_found', 'timeout'). */
  failedReason?: string;
  /** How the element resolution went (compiled | resolver | self_heal). */
  resolutionSource?: string;
  /** Last few network error lines, truncated. Useful for detecting infra issues. */
  recentNetworkErrors?: string[];
  /** Last few console error lines, truncated. */
  recentConsoleErrors?: string[];
  /** URL the test was on when it failed (helps the LLM ground its reasoning). */
  pageUrl?: string;
}

/** Hard ceiling on how long the classifier may block the retry loop. */
const CLASSIFIER_TIMEOUT_MS = 3_000;

const SYSTEM_PROMPT = `You classify failed UI test runs to decide whether to retry them.

Return ONE category:

- "infra_transient": the failure is clearly caused by infrastructure we don't
  control — browser crashed, CDP/WebSocket disconnected, socket reset, worker
  ran out of memory, test harness timed out during setup, network connection
  reset mid-request (ECONNRESET, EPIPE, CDP lost). These deserve a retry.

- "product_bug": the product under test has a real defect — an element we
  expected is missing or not interactable, an assertion failed because the UI
  shows the wrong thing, API returned wrong data, auth redirected away, a
  critical button is disabled. Do NOT retry — QA needs to see this.

- "test_issue": the test itself is wrong — bad selector, impossible locator,
  unrealistic timeout, step description ambiguous for the current page. Do
  NOT retry — fixing the test is required.

- "unknown": you genuinely can't tell. Do NOT retry.

Be conservative: when in doubt, return "unknown" or "test_issue", NOT
"infra_transient". False retries mask real bugs and waste engineer time.

Return JSON only:
{"category": "<one_of_the_four>", "reasoning": "<short one-sentence why>"}`;

function buildUserPrompt(ctx: RetryClassificationContext): string {
  const parts: string[] = [];
  parts.push(`Error message: ${truncate(ctx.errorMessage, 500)}`);
  if (ctx.failedStepDescription) {
    parts.push(`Failed step: ${truncate(ctx.failedStepDescription, 200)}`);
  }
  if (ctx.failedReason) {
    parts.push(`Backend failedReason: ${ctx.failedReason}`);
  }
  if (ctx.resolutionSource) {
    parts.push(`Resolution source: ${ctx.resolutionSource}`);
  }
  if (ctx.pageUrl) {
    parts.push(`Page URL: ${ctx.pageUrl}`);
  }
  if (ctx.recentNetworkErrors && ctx.recentNetworkErrors.length > 0) {
    const lines = ctx.recentNetworkErrors.slice(-5).map(s => truncate(s, 200));
    parts.push(`Recent network errors:\n${lines.join('\n')}`);
  }
  if (ctx.recentConsoleErrors && ctx.recentConsoleErrors.length > 0) {
    const lines = ctx.recentConsoleErrors.slice(-5).map(s => truncate(s, 200));
    parts.push(`Recent console errors:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function isValidCategory(v: unknown): v is RetryCategory {
  return v === 'infra_transient' || v === 'product_bug' || v === 'test_issue' || v === 'unknown';
}

/**
 * Ask the LLM whether a failed test looks like a retryable infra issue.
 * Safe under all failure modes: on timeout/parse-error/network-error we return
 * `shouldRetry: false` so real bugs are never hidden by a silent retry.
 */
export async function classifyRetry(
  ctx: RetryClassificationContext,
): Promise<RetryDecision> {
  const start = Date.now();

  // Fast path: nothing meaningful to classify.
  if (!ctx.errorMessage || ctx.errorMessage.trim().length === 0) {
    return {
      shouldRetry: false,
      category: 'unknown',
      reasoning: 'No error message supplied',
      elapsedMs: Date.now() - start,
      fallbackUsed: true,
    };
  }

  // We wrap the LLM call in our own timeout race because the Gemini routing
  // path in getChatCompletionWithMessages takes `timeout` as a number, not an
  // AbortSignal — and we need a hard guarantee the retry loop isn't blocked.
  const llmCall = getChatCompletionWithMessages(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(ctx) },
    ],
    {
      model: AI_TASK_MODELS.retryClassification,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      // Pass timeout to the Gemini path (openai.service.ts forwards it).
      ...({ timeout: CLASSIFIER_TIMEOUT_MS } as { timeout: number }),
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('CLASSIFIER_TIMEOUT')), CLASSIFIER_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([llmCall, timeoutPromise]);

    const raw = response?.content;
    if (!raw) {
      return safeFallback(start, 'Empty LLM response');
    }

    let parsed: { category?: unknown; reasoning?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return safeFallback(start, 'LLM returned non-JSON');
    }

    const category = parsed.category;
    if (!isValidCategory(category)) {
      return safeFallback(start, `Invalid category from LLM: ${String(category)}`);
    }

    const reasoning =
      typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
        ? parsed.reasoning.trim()
        : 'No reasoning supplied';

    return {
      shouldRetry: category === 'infra_transient',
      category,
      reasoning,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    const message = errMsg(err);
    return safeFallback(
      start,
      message === 'CLASSIFIER_TIMEOUT'
        ? `Classifier timed out after ${CLASSIFIER_TIMEOUT_MS}ms`
        : `Classifier error: ${message}`,
    );
  }
}

function safeFallback(start: number, reason: string): RetryDecision {
  logger.warn('[RETRY_CLASSIFIER] Falling back to NO-retry', { reason });
  return {
    shouldRetry: false,
    category: 'unknown',
    reasoning: reason,
    elapsedMs: Date.now() - start,
    fallbackUsed: true,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
