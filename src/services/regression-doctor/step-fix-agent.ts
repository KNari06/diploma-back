/**
 * Regression Doctor — step-fix agent.
 *
 * One LLM call per failing step. Sees the authored step, its neighbours, the
 * runtime error, and the screenshot taken at the moment of failure; returns a
 * verdict (is the TEST wrong, or the APP?) and, only for `test_fix`, a patch
 * narrow enough to apply without re-reviewing the whole scenario.
 *
 * This replaces the pattern-only prompt in `drift-agent.ts`, which was handed a
 * hash, some KB excerpts and a list of row ids — never the failure itself.
 *
 * Fail-safe: any LLM or parse error yields an `unclear` verdict with no patch.
 * The job persists it, the panel shows a diagnosis-only card, and nothing in
 * the run pipeline breaks because an analysis call timed out.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import type { KBChunk } from '@/services/kb/kb.service';
import { logger } from '@/utils/core/logger';
import { collectScreenshots, type InlinedScreenshot } from './screenshot-inline';
import { SYSTEM_PROMPT, buildUserPrompt } from './step-fix-prompt';
import {
  MIN_ASSERTION_PATCH_CONFIDENCE,
  MIN_PATCH_CONFIDENCE,
  type FailedStepEvidence,
  type StepFixVerdict,
  type StepPatch,
} from './types';

const MAX_TOKENS = 900;
const TEMPERATURE = 0.2;

export interface AnalyzeStepInput {
  evidence: FailedStepEvidence;
  kbChunks: KBChunk[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provider was unreachable, rate-limited, or broken — this says nothing
 * about the failing step.
 *
 * Thrown rather than folded into an `unclear` verdict so the caller can retry
 * the run instead of writing an outage into the report as a conclusion.
 */
export class TransientAnalysisError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TransientAnalysisError';
  }
}

export async function analyzeFailedStep(input: AnalyzeStepInput): Promise<StepFixVerdict> {
  const userText = buildUserPrompt(input);
  const screenshots = await collectScreenshots(input.evidence);

  try {
    return await callModel(userText, screenshots);
  } catch (err) {
    if (isTransient(err)) throw asTransient(err);

    // Retry once without images before giving up — the text evidence alone
    // (failedReason + failureExplanation) still supports a verdict, just a
    // weaker one. Images are inlined rather than linked, so this path is now
    // rare; it remains for oversized payloads and provider-side vision errors.
    if (screenshots.length > 0) {
      logger.warn('[STEP_FIX_AGENT] Call failed with screenshots — retrying text-only', {
        testCaseId: input.evidence.testCaseId,
        stepId: input.evidence.stepId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        return await callModel(userText, []);
      } catch (retryErr) {
        if (isTransient(retryErr)) throw asTransient(retryErr);
        return unclearFallback(input.evidence, retryErr);
      }
    }
    return unclearFallback(input.evidence, err);
  }
}

/**
 * Is this the provider being unavailable rather than the model being unable to
 * answer?
 *
 * The distinction decides whether the run is retried or an outage is written
 * into the report as "Not sure". Rate limits, 5xx, and aborted/network calls
 * are infrastructure; a malformed completion is not.
 */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number } | null)?.status
    ?? (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) return true;

  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'AbortError' || name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return true;
  }

  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return /timeout|timed out|econnreset|econnrefused|socket hang up|rate limit/.test(message);
}

function asTransient(err: unknown): TransientAnalysisError {
  return new TransientAnalysisError(
    `Model provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
    err,
  );
}

async function callModel(
  userText: string,
  screenshots: InlinedScreenshot[],
): Promise<StepFixVerdict> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
  for (const shot of screenshots) {
    content.push({ type: 'text', text: shot.label });
    content.push({ type: 'image_url', image_url: { url: shot.dataUrl, detail: shot.detail } });
  }

  // Deliberately NOT the raw client from `getSharedOpenAIClient()`. Only this
  // wrapper reads `response.usage` and hands it to `AIUsageTracker`, so a call
  // made on the raw client is billed by the provider and recorded nowhere —
  // which is how every Doctor analysis ran without a single `ai_usage_log` row.
  // The tracker still needs an AI context around the call; the job supplies it.
  const response = await getChatCompletionWithMessages(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: content as never },
    ],
    {
      model: AI_TASK_MODELS.regressionStepFix,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    },
  );

  if (!response.content) throw new Error('Empty response from LLM');
  return parseVerdict(response.content);
}

function unclearFallback(evidence: FailedStepEvidence, err: unknown): StepFixVerdict {
  logger.warn('[STEP_FIX_AGENT] Analysis unavailable — recording unclear verdict', {
    testCaseId: evidence.testCaseId,
    stepId: evidence.stepId,
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    verdict: 'unclear',
    diagnosis:
      `Step ${evidence.stepIndex + 1} ("${evidence.step.description}") failed` +
      (evidence.failureExplanation ? `: ${evidence.failureExplanation}` : '.') +
      ' Automated analysis was unavailable for this step — review it manually.',
    confidence: 0,
    patch: null,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Parsing + validation
// ─────────────────────────────────────────────────────────────────────────────

function parseVerdict(raw: string): StepFixVerdict {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Models occasionally wrap JSON in markdown despite response_format.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in LLM response');
    parsed = JSON.parse(match[0]);
  }

  const verdict = normalizeVerdict(parsed.verdict);
  const diagnosis =
    typeof parsed.diagnosis === 'string' && parsed.diagnosis.trim()
      ? parsed.diagnosis.trim()
      : 'No diagnosis produced for this failure.';
  const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const confidence = Math.max(0, Math.min(1, Number(rawConfidence.toFixed(2))));

  return {
    verdict,
    diagnosis,
    confidence,
    patch: verdict === 'test_fix' ? validatePatch(parsed.patch, confidence) : null,
  };
}

function normalizeVerdict(raw: unknown): StepFixVerdict['verdict'] {
  return raw === 'test_fix' || raw === 'app_bug' ? raw : 'unclear';
}

/**
 * Drop anything we would not be willing to apply.
 *
 * Every rejection here degrades the finding to "diagnosis only" rather than
 * failing it — the user still learns what the agent thinks, they just don't get
 * a button. Half-specified patches are the dangerous case: a `update_element`
 * with no new description would blank the step's only locator.
 */
export function validatePatch(raw: unknown, confidence: number): StepPatch | null {
  if (confidence < MIN_PATCH_CONFIDENCE) return null;
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
  if (!reason) return null;

  switch (candidate.action) {
    case 'update_element': {
      const description =
        typeof candidate.description === 'string' ? candidate.description.trim() : '';
      if (!description) return null;
      return {
        action: 'update_element',
        reason,
        description,
        bindingHints: normalizeHints(candidate.bindingHints),
      };
    }

    case 'insert_wait': {
      const waitMs = typeof candidate.waitMs === 'number' ? Math.round(candidate.waitMs) : NaN;
      // Bounds, not just a type check: a 200ms wait fixes nothing and a 5-minute
      // one turns a failing test into a slow failing test.
      if (!Number.isFinite(waitMs) || waitMs < 1000 || waitMs > 15000) return null;
      return { action: 'insert_wait', reason, waitMs };
    }

    case 'update_assertion': {
      if (confidence < MIN_ASSERTION_PATCH_CONFIDENCE) return null;
      const assertionText =
        typeof candidate.assertionText === 'string' ? candidate.assertionText.trim() : '';
      if (!assertionText) return null;
      return { action: 'update_assertion', reason, assertionText };
    }

    default:
      return null;
  }
}

/**
 * Hints are three-state: a string sets it, `null` clears it, `undefined` leaves
 * it alone. Clearing has to survive validation — it is how the agent says
 * "resolve by description instead", which is the correct move when it knows the
 * old label is wrong but not what the new one is.
 */
function normalizeHints(raw: unknown): StepPatch['bindingHints'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const out: NonNullable<StepPatch['bindingHints']> = {};

  for (const key of ['label', 'placeholder', 'role'] as const) {
    const value = source[key];
    if (value === null) out[key] = null;
    else if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** @internal — exported for unit tests only. */
export const __testing = { parseVerdict, isTransient };
