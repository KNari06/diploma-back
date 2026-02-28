/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RETRY UTILITIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Centralized retry logic for skill tool execution.
 * Used by tool-executor.ts to retry transient failures with exponential backoff.
 *
 * Design decisions:
 * - Conservative: unknown errors are NOT retried (fail-safe)
 * - Retryable: 429 (rate limit), 5xx (server), timeout, network errors
 * - Non-retryable: 400, 401, 403, 404, validation, auth errors
 * - Jitter: ±20% to avoid thundering herd
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { SkillRetryConfig } from './types';

// ── Default Config ──────────────────────────────────────────────────────

export const DEFAULT_RETRY_CONFIG: Required<SkillRetryConfig> = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffMultiplier: 2,
};

/**
 * Merge per-skill retry config with defaults.
 */
export function resolveRetryConfig(
  skillConfig?: SkillRetryConfig,
): Required<SkillRetryConfig> {
  return {
    maxRetries: skillConfig?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    initialDelayMs: skillConfig?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
    backoffMultiplier: skillConfig?.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier,
  };
}

// ── Retryability Classification ─────────────────────────────────────────

/** HTTP status codes that indicate retryable server/rate-limit errors */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** HTTP status codes that indicate non-retryable client errors */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 405, 409, 422]);

/** Error message patterns that indicate NON-retryable errors (checked first) */
const NON_RETRYABLE_PATTERNS = [
  /missing required/i,
  /validation/i,
  /not found/i,
  /unauthorized/i,
  /forbidden/i,
  /bad request/i,
  /invalid.*param/i,
  /unknown tool/i,
  /not connected/i,
  /requires confirmation/i,
  /workspace context required/i,
];

/** Error message patterns that indicate retryable errors */
const RETRYABLE_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /timeout/i,
  /timed? out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network/i,
  /internal server/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
];

/**
 * Determine if an error is retryable.
 *
 * Strategy:
 * 1. Check for explicit non-retryable status codes (400, 401, 403, 404) → NO
 * 2. Check for retryable status codes (429, 5xx) → YES
 * 3. Check error message against non-retryable patterns → NO
 * 4. Check error message against retryable patterns → YES
 * 5. Default: NOT retryable (conservative / fail-safe)
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message || '';

  // Extract HTTP status code from error message if present
  const statusMatch = message.match(/\b(4\d\d|5\d\d)\b/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (NON_RETRYABLE_STATUS_CODES.has(status)) return false;
    if (RETRYABLE_STATUS_CODES.has(status)) return true;
  }

  // Check non-retryable patterns first (more specific, higher priority)
  if (NON_RETRYABLE_PATTERNS.some(p => p.test(message))) return false;

  // Check retryable patterns
  if (RETRYABLE_PATTERNS.some(p => p.test(message))) return true;

  // Default: not retryable (conservative approach)
  return false;
}

// ── Delay Utilities ─────────────────────────────────────────────────────

/**
 * Calculate delay for a given retry attempt with exponential backoff.
 * Adds ±20% jitter to avoid thundering herd when concurrent calls all retry.
 *
 * Example with defaults (500ms, 2x):
 *   attempt 0 → ~500ms  (400-600)
 *   attempt 1 → ~1000ms (800-1200)
 *   attempt 2 → ~2000ms (1600-2400)
 */
export function calculateRetryDelay(
  attempt: number,
  config: Required<SkillRetryConfig>,
): number {
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  // Jitter: ±20%
  const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

/**
 * Sleep for a given number of milliseconds.
 * Respects abort signal — rejects immediately if aborted.
 * Cleans up timer and listener on completion.
 */
export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      return reject(new Error('Sleep cancelled — request aborted'));
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    timerId = setTimeout(() => {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (abortSignal) {
      onAbort = () => {
        if (timerId !== undefined) clearTimeout(timerId);
        reject(new Error('Sleep cancelled — request aborted'));
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
