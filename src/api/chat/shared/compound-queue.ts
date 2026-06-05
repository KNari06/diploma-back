/**
 * Compound Request Queue (Phase 3 — sequential-turns splitter)
 *
 * A compound message ("test A and B, then save as a plan") is decomposed by the
 * classifier into `analysis.subRequests`. Handlers respond via res.json() once
 * per HTTP request, so steps run one-per-turn. We persist the remaining steps
 * in Redis and drive one step per subsequent turn.
 *
 * ── Model: ADVANCE-AFTER-SUCCESS ──────────────────────────────────────────
 * The current step is PEEKED (not removed) and routed. Only after the step's
 * handler reports success do we pop it (`completeStep`). If the step instead
 * asked a clarification or a confirm-preview, the queue is left untouched so the
 * SAME step is retried next turn with the user's answer. This fixes the original
 * "advance-before-execute" bug where a clarifying answer drove the wrong step.
 *
 * ── Escape ────────────────────────────────────────────────────────────────
 * An explicit cancel phrase ("stop"/"cancel"/"отмена") abandons the whole queue.
 *
 * ── Scope safety ──────────────────────────────────────────────────────────
 * Keyed strictly by chatSessionId (never a userId fallback) so a pending flow
 * cannot leak across a user's other sessions. Global chat only.
 *
 * NOTE: output-threading between steps (passing step-1's created id into step-3)
 * is intentionally NOT implemented — handlers write to res and expose no result
 * channel. The dependent step's own text is re-parsed instead. See the design
 * doc; revisit if a result channel is added to IntentHandler.
 */

import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

const PENDING_COMPOUND_PREFIX = 'pending_compound:';
// Short TTL: a continuation is expected within a normal back-and-forth. Kept
// tight so a stale queue can't hijack an unrelated message much later.
const PENDING_TTL_SECONDS = 180;

export interface CompoundStep {
  text: string;
  order: number;
  dependsOnPrevious: boolean;
}

interface PendingCompound {
  /** Steps still to run, in order. steps[0] is the CURRENT step (peeked, not popped). */
  steps: CompoundStep[];
  /** 1-based index of the current step (for "step N of M" messaging). */
  currentIndex: number;
  total: number;
}

/**
 * Explicit abandon phrases (EN + RU). Uses a unicode-aware boundary
 * `(?![\p{L}\p{N}])` instead of `\b` — JS `\b` is ASCII-only, so `\bхватит\b`
 * never matches Cyrillic (same trap fixed in confirmation-classifier.ts).
 */
const CANCEL_RE = /^(stop|cancel|abort|nevermind|never mind|forget it|отмена|отмени|стоп|хватит|забудь)(?![\p{L}\p{N}])/iu;

function keyFor(chatSessionId: string): string {
  return `${PENDING_COMPOUND_PREFIX}${chatSessionId}`;
}

/**
 * Normalize the classifier's raw subRequests into ordered CompoundStep[].
 * Pure — sorts by `order`, drops empties. Returns [] when not a real compound
 * (≥2 distinct steps required).
 */
export function toCompoundSteps(analysis: any): CompoundStep[] {
  if (!analysis || analysis.isCompound !== true || !Array.isArray(analysis.subRequests)) {
    return [];
  }
  const steps: CompoundStep[] = analysis.subRequests
    .filter((s: any) => s && typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s: any, i: number) => ({
      text: String(s.text).trim(),
      order: Number.isFinite(s.order) ? Number(s.order) : i + 1,
      dependsOnPrevious: s.dependsOnPrevious === true,
    }))
    .sort((a: CompoundStep, b: CompoundStep) => a.order - b.order);

  return steps.length >= 2 ? steps : [];
}

/** True when the message is an explicit request to abandon the queue. Pure. */
export function isCompoundCancel(message: string): boolean {
  return CANCEL_RE.test(message.trim());
}

export interface CompoundStepView {
  /** The step text to parse + route this turn. */
  text: string;
  index: number;
  total: number;
  /** Steps remaining AFTER this one. */
  remaining: number;
}

/**
 * Begin a freshly-detected compound: persist ALL steps (the first is the
 * current step, peeked) and return the first step to run now. Returns null when
 * not a real compound. Requires a chatSessionId (global path always has one).
 */
export async function beginCompound(
  chatSessionId: string,
  steps: CompoundStep[],
): Promise<CompoundStepView | null> {
  if (!chatSessionId || steps.length < 2) return null;
  await write(chatSessionId, { steps, currentIndex: 1, total: steps.length });
  return { text: steps[0].text, index: 1, total: steps.length, remaining: steps.length - 1 };
}

/**
 * Peek the CURRENT step of a pending compound without consuming it. Returns
 * null if there is no pending compound. The caller routes this step, then calls
 * completeStep() only if it succeeded.
 */
export async function peekCurrentStep(chatSessionId: string): Promise<CompoundStepView | null> {
  if (!chatSessionId) return null;
  const pending = await read(chatSessionId);
  if (!pending || pending.steps.length === 0) return null;
  return {
    text: pending.steps[0].text,
    index: pending.currentIndex,
    total: pending.total,
    remaining: pending.steps.length - 1,
  };
}

/**
 * Mark the current step done: pop it and advance. Clears the queue when the
 * last step completes. Call ONLY after the step's handler reported success
 * (not a clarification / confirm-preview). Returns the next step to announce,
 * or null when the compound is finished.
 */
export async function completeStep(chatSessionId: string): Promise<CompoundStepView | null> {
  if (!chatSessionId) return null;
  const pending = await read(chatSessionId);
  if (!pending) return null;

  const rest = pending.steps.slice(1);
  if (rest.length === 0) {
    await clearPendingCompound(chatSessionId);
    return null;
  }
  await write(chatSessionId, {
    steps: rest,
    currentIndex: pending.currentIndex + 1,
    total: pending.total,
  });
  return {
    text: rest[0].text,
    index: pending.currentIndex + 1,
    total: pending.total,
    remaining: rest.length - 1,
  };
}

/** Clear the pending compound (completion, abandon, cancel, or error). */
export async function clearPendingCompound(chatSessionId: string | undefined): Promise<void> {
  if (!chatSessionId) return;
  try {
    await redisConnection.del(keyFor(chatSessionId));
  } catch {
    /* best-effort */
  }
}

// ── internal Redis I/O (best-effort; a failure disables continuation) ──────

async function write(chatSessionId: string, pending: PendingCompound): Promise<void> {
  try {
    await redisConnection.set(keyFor(chatSessionId), JSON.stringify(pending), 'EX', PENDING_TTL_SECONDS);
  } catch (err) {
    logger.warn('[COMPOUND_QUEUE] write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function read(chatSessionId: string): Promise<PendingCompound | null> {
  try {
    const raw = await redisConnection.get(keyFor(chatSessionId));
    return raw ? (JSON.parse(raw) as PendingCompound) : null;
  } catch {
    return null;
  }
}
