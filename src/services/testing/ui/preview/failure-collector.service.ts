/**
 * Failure Collector Service (Etap 1D.2)
 *
 * Builds a `StepFailureEvidence` bundle when an apply exhausts the full
 * resolver waterfall (compiled plan failed AND lint/LLM/vision failed).
 *
 * Trigger condition: invoked ONLY from the final-failure return path in
 * `preview-step-apply.service.ts` — never per-attempt, never on transient
 * errors that the apply loop will retry. This keeps DB writes proportional
 * to user-visible failures, not internal noise.
 *
 * Storage policy:
 *   - Single bundle per step (not a history array). Last failure wins.
 *     Chronic flaky steps would otherwise bloat the JSONB row past the
 *     16 KB-ish soft limit Postgres uses for inline TOAST.
 *   - `attempts[]` capped at 10 most recent (oldest dropped before save).
 *   - Page screenshot is stored as a REFERENCE, not base64 — actual upload
 *     is delegated to the existing trace-upload pipeline; the bundle only
 *     remembers the path. (Phase 1D.2 ships without screenshot — see
 *     `screenshotRef: undefined` below; wire-up is a follow-up.)
 *
 * What this module does NOT do:
 *   - Persist to DB (that's `intent-test-case.service.ts.updateStep*`)
 *   - Emit WS events (that's the apply handler)
 *   - Trigger heals or retries (orthogonal — this is a record, not an
 *     action)
 */

import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';
import type {
  IntentStep,
  StepFailureEvidence,
} from './preview.types';

/** Cap on per-attempt entries kept in the bundle. */
const MAX_ATTEMPTS_KEPT = 10;
/** Cap on lastError length to keep the bundle compact. */
const MAX_ERROR_LEN = 200;
/** Cap on per-attempt error length. */
const MAX_ATTEMPT_ERROR_LEN = 200;
/** Cap on locator-value length stored per attempt. */
const MAX_VALUE_LEN = 200;

export interface CollectFailureEvidenceParams {
  step: IntentStep;
  page: Page;
  /** Total apply-loop iterations before giving up. */
  totalAttempts: number;
  /**
   * V26 Batch A: top-level failure category. Surfaces directly into
   * `bundle.originatingStrategy` so the dashboard / "stuck steps" widget
   * can group failures without parsing `attempts[]`.
   */
  originatingStrategy?: StepFailureEvidence['originatingStrategy'];
  /** Final error string from the resolver waterfall. */
  lastError?: string;
  /**
   * Per-attempt log accumulated during the apply. Order: oldest → newest.
   * Collector caps at MAX_ATTEMPTS_KEPT keeping the **most recent** so
   * the user sees the actually-tried strategies, not the early fallthroughs.
   */
  attempts: Array<{
    strategy: string;
    tier?: string;
    matched: boolean;
    failureKind: string;
    value?: string;
    durationMs?: number;
    error?: string;
  }>;
  /**
   * Pre-counted from the snapshot the resolver used. Optional — passed
   * through into pageContext for the UI.
   */
  interactiveNodeCount?: number;
}

/**
 * Build a `StepFailureEvidence` bundle from the apply context.
 *
 * Pure function (modulo `page.title()` async lookup, which falls through
 * silently to undefined on errors). Does not write to DB, does not emit
 * — caller does both.
 *
 * Truncation:
 *   - lastError → MAX_ERROR_LEN
 *   - attempt.value → MAX_VALUE_LEN
 *   - attempt.error → MAX_ATTEMPT_ERROR_LEN
 *   - attempts → tail-MAX_ATTEMPTS_KEPT
 */
export async function collectFailureEvidence(
  params: CollectFailureEvidenceParams,
): Promise<StepFailureEvidence> {
  const { step, page, totalAttempts, lastError, attempts, interactiveNodeCount, originatingStrategy } = params;

  // Trim attempts to the most recent N — the early ones are usually
  // throwaways (compiled fast-path miss) and the user cares about the
  // last few that actually exhausted the resolver.
  const keptAttempts = attempts
    .slice(-MAX_ATTEMPTS_KEPT)
    .map((a) => ({
      strategy: a.strategy,
      tier: a.tier,
      matched: a.matched,
      failureKind: a.failureKind,
      value: a.value ? a.value.slice(0, MAX_VALUE_LEN) : undefined,
      durationMs: a.durationMs,
      error: a.error ? a.error.slice(0, MAX_ATTEMPT_ERROR_LEN) : undefined,
    }));

  // Page context — best-effort. Each lookup individually try/catch'd
  // because the page may be navigating, closing, or in a state where
  // sync calls throw. None of these failures should block the bundle.
  let pageUrl = '';
  try {
    pageUrl = page.url();
  } catch {
    pageUrl = '';
  }

  let pageTitle: string | undefined;
  try {
    pageTitle = await page.title();
  } catch {
    pageTitle = undefined;
  }

  const recordedFingerprintPresent = !!step.recordedFingerprint
    && Object.keys(step.recordedFingerprint).length > 0;

  const bundle: StepFailureEvidence = {
    capturedAt: new Date().toISOString(),
    pageUrl,
    originatingStrategy,
    lastError: lastError ? lastError.slice(0, MAX_ERROR_LEN) : undefined,
    totalAttempts,
    attempts: keptAttempts,
    // screenshotRef intentionally undefined — wiring to artifact upload
    // is a follow-up (the existing trace-upload pipeline lives in
    // editor-trace-upload.ts and is wired per-session, not per-step).
    screenshotRef: undefined,
    pageContext: {
      pageTitle,
      interactiveNodeCount,
      recordedFingerprintPresent,
    },
  };

  logger.info('[FAILURE_COLLECTOR] Bundle built', {
    stepId: step.id,
    pageUrl: pageUrl.slice(0, 100),
    totalAttempts,
    attemptsKept: keptAttempts.length,
    attemptsDropped: Math.max(0, attempts.length - MAX_ATTEMPTS_KEPT),
    hasFingerprint: recordedFingerprintPresent,
    interactiveNodeCount,
  });

  return bundle;
}
