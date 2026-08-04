/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRODUCT ANALYST — Phase 0
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs ONCE, before Phase 1 Survey: collect evidence → one LLM pass → a
 * `ProductBrief` that Cartographer, Strategist, the per-flow Planner and Sentinel
 * all read.
 *
 * WHY IT EXISTS: exploration's agents had no product understanding. The only
 * channel was `scopeHint` — one optional string that never even reached the
 * per-flow Planner — so every discovered flow came out `priority:'medium'`, test
 * names were mechanical, and Sentinel scored coverage against *discovered entry
 * points* rather than business need.
 *
 * ── HARD CONTRACT: NEVER FAIL THE RUN ──
 * Phase 0 is an enhancement. Every failure path returns `undefined`, and the
 * caller then explores exactly as it does today. Mirrors the folder's
 * telemetry/best-effort discipline (CLAUDE.md hard invariant #11).
 *
 * ── PRESET-GATED ──
 * `full` only. `quick` is 2 min TOTAL and is the self-serve onboarding path, where
 * a phase that spends 30s before Phase 1 starts is worse than no phase at all.
 * The gate lives in `isQuickPreset` — one source, never an inline string compare.
 */

import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';

import { EXPLORATION_AGENT_LLM } from '../agents/agent-llm-config';
import { isQuickPreset, type ExplorationConfig } from '../types';
import type { ExplorationTraceService } from '../exploration-trace.service';
import { collectProductEvidence } from './evidence-collector';
import {
  PRODUCT_ANALYST_SYSTEM_PROMPT,
  buildProductAnalystPrompt,
  parseProductAnalystResponse,
} from './product-analyst-prompts';
import { normalizeProductBrief, briefHasSignal } from './product-brief.util';
import { planBriefQuestions, applyBriefAnswers } from './brief-questions';
import {
  briefOriginKey,
  fingerprintEvidence,
  decideBriefReuse,
  stripReusedPermissions,
  PRODUCT_BRIEF_VERSION,
} from './brief-reuse';
import {
  fetchProductBrief,
  upsertProductBrief,
  recordProductBriefReuse,
} from '@/services/testing/exploration/db/product-brief.db';
import { ClarificationService, CLARIFICATION_SKIP_SENTINEL } from '@/agent/utils/context/clarification.service';
import type { ProductBrief } from './product-brief.types';

const LLM = EXPLORATION_AGENT_LLM.productAnalyst;

/** Why Phase 0 produced no brief. Surfaced so a skip is never silent. */
export type Phase0SkipReason =
  | 'quick_preset'
  | 'no_evidence'
  | 'ai_failed'
  | 'unparseable'
  | 'no_signal';

export interface Phase0Result {
  brief?: ProductBrief;
  skipReason?: Phase0SkipReason;
  durationMs: number;
  /**
   * Origin this brief was REUSED from, when it came out of the store rather
   * than an LLM call. Present only on a cache hit — makes "did Phase 0 actually
   * think this run?" answerable from the result instead of the logs, and keeps
   * a reused brief from being mistaken for a freshly derived one.
   */
  reusedFrom?: string;
}

/**
 * Per-question wait. Short on purpose: this blocks the exploration before Phase 1,
 * so an absent user must cost tens of seconds, not minutes. Skipping keeps the
 * derived value, which is already usable.
 */
const QUESTION_TIMEOUT_MS = 45_000;

/**
 * Ask the ≤3 questions the evidence structurally cannot answer, and fold the
 * answers back in.
 *
 * Best-effort by contract — every failure returns the brief unchanged:
 *   - nowhere to deliver (no chatSessionId AND no userId) → ask nothing
 *   - the user ignores it → timeout, keep the derived value
 *   - anything throws → keep the derived value
 *
 * Sequential rather than batched: the existing clarification channel is
 * one-question-at-a-time, and reusing it unchanged is worth more than a nicer
 * modal that needs a new protocol on both ends.
 */
async function askBriefQuestions(
  brief: ProductBrief,
  config: ExplorationConfig,
  trace?: ExplorationTraceService,
): Promise<{ brief: ProductBrief; answers: BriefAnswer[] }> {
  // No delivery route → asking would block for the full timeout and reach nobody.
  if (!config.chatSessionId && !config.userId) return { brief, answers: [] };

  const questions = planBriefQuestions(brief);
  if (questions.length === 0) {
    // The target outcome when the evidence was strong. Not a failure.
    logger.info('[PHASE0] No questions needed — evidence was sufficient', {
      explorationId: config.explorationId,
    });
    return { brief, answers: [] };
  }

  const answers: BriefAnswer[] = [];

  for (const q of questions) {
    try {
      const answer = await ClarificationService.requestClarificationViaRedis({
        explorationId: config.explorationId,
        chatSessionId: config.chatSessionId,
        userId: config.userId,
        question: q.question,
        type: 'product_brief',
        options: q.options,
        timeout: QUESTION_TIMEOUT_MS,
      });
      // The skip sentinel means "don't ask me" — treat it as unanswered, and
      // stop asking: a user who skipped one is unlikely to want the next two.
      const skipped = answer === null || answer === CLARIFICATION_SKIP_SENTINEL;
      answers.push({ key: q.key, answer: skipped ? null : answer });
      if (skipped) break;
    } catch (error) {
      logger.debug('[PHASE0] Question failed; keeping the derived value', {
        key: q.key,
        error: error instanceof Error ? error.message : String(error),
      });
      answers.push({ key: q.key, answer: null });
      break;
    }
  }

  const answeredCount = answers.filter((a) => a.answer).length;
  trace?.writeWarning?.('phase0_questions', {
    phase: 'phase0',
    asked: answers.length,
    answered: answeredCount,
    keys: answers.map((a) => a.key),
  });

  // Answers are returned ALONGSIDE the merged brief, not just folded in: they
  // are persisted separately so they survive a re-derive (a homepage rewrite
  // invalidates what the analyst inferred, not what the user told us about
  // their own environment).
  return { brief: applyBriefAnswers(brief, answers), answers };
}


/** One answer the user gave to a brief question. */
export type BriefAnswer = { key: string; answer: string | null };

/**
 * Fold answers from an EARLIER run into a freshly derived brief.
 *
 * Reuses `applyBriefAnswers` rather than mapping keys a second time — a second
 * mapping is a second thing to drift, and that function already owns the
 * key→field rules (including that naming a critical flow is not permission to
 * complete it).
 *
 * Skipped answers (`answer: null`) are dropped rather than replayed: a skip
 * means "not now", not "never ask me again", and replaying it would write a
 * misleading `askLog` entry for a question this run never asked.
 */
function applyStoredAnswers(brief: ProductBrief, stored: BriefAnswer[]): ProductBrief {
  const answered = stored.filter((a) => typeof a.answer === 'string' && a.answer.trim());
  if (!answered.length) return brief;

  const merged = applyBriefAnswers(brief, answered);
  // `applyBriefAnswers` appends to askLog, but these were not asked THIS run —
  // recording them would overstate how many questions the user faced.
  return { ...merged, askLog: brief.askLog };
}

/**
 * Union of prior and fresh answers, fresh winning on a repeated key.
 *
 * A key answered on an earlier run must survive a run where it was not asked,
 * or the stored set would shrink to whatever the latest run happened to ask.
 */
function mergeAnswers(prior: BriefAnswer[], fresh: BriefAnswer[]): BriefAnswer[] {
  const byKey = new Map<string, BriefAnswer>();
  for (const a of prior) byKey.set(a.key, a);
  // A fresh SKIP must not erase a real answer given earlier.
  for (const a of fresh) {
    if (a.answer === null && byKey.get(a.key)?.answer) continue;
    byKey.set(a.key, a);
  }
  return [...byKey.values()];
}

/**
 * Load a stored brief and decide whether it still describes this product.
 *
 * Best-effort in every direction: a DB failure, an unparseable URL, or a
 * changed fingerprint all fall through to a normal derive. The cache is an
 * optimisation — it must never be the reason a run has no brief.
 */
async function tryReuseStoredBrief(
  config: ExplorationConfig,
  currentFingerprint: string | null,
  trace?: ExplorationTraceService,
): Promise<{ brief?: ProductBrief; origin: string; priorAnswers: BriefAnswer[] } | null> {
  const origin = briefOriginKey(config.entryUrl);
  if (!origin || !config.projectId) return null;

  try {
    const stored = await fetchProductBrief({ projectId: config.projectId, origin });
    const decision = decideBriefReuse({ stored, currentFingerprint });

    trace?.writeWarning?.('phase0_reuse_decision', {
      phase: 'phase0',
      origin,
      reuse: decision.reuse,
      reason: decision.reason,
    });

    // On a MISS we still return the stored answers: the brief must be
    // re-derived, but what the user told us about their environment still holds.
    if (!stored) return { origin, priorAnswers: [] };
    if (!decision.reuse) return { origin, priorAnswers: stored.userAnswers ?? [] };

    // Re-normalize on read: the row was written by an earlier process, and the
    // normalizer is the single validation boundary (invariant #25). Skipping it
    // would let a hand-edited row bypass the fail-closed payment rules.
    //
    // Permissions are stripped BEFORE normalizing, because the normalizer
    // honours `source:'user'` — which is exactly what a stored grant looks
    // like. A payment permission belongs to the person who gave it, for the run
    // they gave it on; inheriting it would let a project-mate complete real
    // payments they never authorised.
    const safe = stripReusedPermissions(stored.brief);
    const brief = normalizeProductBrief(safe, origin);
    if (!briefHasSignal(brief)) return null;

    // Reuse accounting is pure analytics — never let it fail the run.
    void recordProductBriefReuse(stored.id, stored.reuseCount + 1, config.explorationId)
      .catch(() => { /* best-effort */ });

    return { brief, origin, priorAnswers: stored.userAnswers ?? [] };
  } catch (error) {
    logger.debug('[PHASE0] Brief reuse lookup failed; deriving fresh', {
      explorationId: config.explorationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Persist the derived brief so the next run on this origin can reuse it.
 *
 * Fire-and-forget by contract: the brief is already in hand and the run
 * continues regardless. A cache write must never delay or fail exploration.
 */
async function storeBriefForReuse(
  config: ExplorationConfig,
  brief: ProductBrief,
  userAnswers: BriefAnswer[],
  evidenceFingerprint: string | null,
): Promise<void> {
  const origin = briefOriginKey(config.entryUrl);
  // No fingerprint = nothing to compare against later, so the row could never
  // be reused — do not write one.
  if (!origin || !config.projectId || !evidenceFingerprint) return;

  try {
    await upsertProductBrief({
      projectId: config.projectId,
      origin,
      briefVersion: PRODUCT_BRIEF_VERSION,
      evidenceFingerprint,
      brief,
      userAnswers,
      lastExplorationId: config.explorationId,
    });
  } catch (error) {
    logger.debug('[PHASE0] Failed to store brief for reuse', {
      explorationId: config.explorationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build the product brief for this run, or explain why there isn't one.
 *
 * Never throws.
 */
export async function runProductAnalyst(
  config: ExplorationConfig,
  trace?: ExplorationTraceService,
): Promise<Phase0Result> {
  const startedAt = Date.now();
  const done = (r: Omit<Phase0Result, 'durationMs'>): Phase0Result => ({
    ...r,
    durationMs: Date.now() - startedAt,
  });

  // Preset gate first — cheapest possible exit, before any network or LLM cost.
  if (isQuickPreset(config.preset)) {
    logger.info('[PHASE0] Skipped — quick preset', { explorationId: config.explorationId });
    return done({ skipReason: 'quick_preset' });
  }

  try {
    const evidence = await collectProductEvidence(config.entryUrl, config.credentials);

    // Nothing fetched at all → an LLM call would be inventing from an empty page.
    if (evidence.sources.length === 0) {
      logger.warn('[PHASE0] No evidence collected; skipping analysis', {
        explorationId: config.explorationId,
        durationMs: evidence.durationMs,
      });
      trace?.writeWarning?.('phase0_no_evidence', {
        phase: 'phase0',
        originUrl: config.entryUrl,
        evidenceDurationMs: evidence.durationMs,
      });
      return done({ skipReason: 'no_evidence' });
    }

    // ── Reuse gate ────────────────────────────────────────────────────────
    // Placed AFTER collection (the fingerprint is derived from the evidence)
    // and BEFORE the LLM call, which is the expensive part being saved. On prod
    // 69% of runs target an already-explored URL, so this is the common path,
    // not an optimisation for a rare case.
    const currentFingerprint = fingerprintEvidence(evidence);
    const reuse = await tryReuseStoredBrief(config, currentFingerprint, trace);
    if (reuse?.brief) {
      logger.info('[PHASE0] Reused stored brief — evidence unchanged', {
        explorationId: config.explorationId,
        origin: reuse.origin,
      });
      return done({ brief: reuse.brief, reusedFrom: reuse.origin });
    }
    // Cache miss: derive fresh, but carry the user's prior answers forward.
    const priorAnswers = reuse?.priorAnswers ?? [];

    const prompt = buildProductAnalystPrompt(evidence, config.scopeHint);

    let content: string;
    try {
      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: PRODUCT_ANALYST_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          {
            model: LLM.model,
            temperature: LLM.temperature,
            max_tokens: LLM.maxTokens,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Product analyst AI timeout')), LLM.timeoutMs),
        ),
      ]);
      content = response.content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[PHASE0] AI call failed; exploring without a brief', {
        explorationId: config.explorationId,
        error: message,
      });
      trace?.writeWarning?.('phase0_ai_failed', { phase: 'phase0', error: message });
      return done({ skipReason: 'ai_failed' });
    }

    const raw = parseProductAnalystResponse(content);
    if (!raw) {
      logger.warn('[PHASE0] Unparseable analyst response; exploring without a brief', {
        explorationId: config.explorationId,
      });
      trace?.writeWarning?.('phase0_unparseable', { phase: 'phase0' });
      return done({ skipReason: 'unparseable' });
    }

    // The normalizer is the SINGLE validation boundary (whitelist, fail-closed
    // safety, evidence-or-downgrade). Credentials are passed for the
    // belt-and-braces redaction pass — the analyst reads /docs pages.
    const brief = normalizeProductBrief(
      { ...(raw as Record<string, unknown>), evidenceSources: evidence.sources },
      config.entryUrl,
      config.credentials,
    );

    // An all-unknown brief is a valid object but carries nothing; threading it into
    // four prompts would cost tokens for no signal.
    if (!briefHasSignal(brief)) {
      logger.info('[PHASE0] Brief carried no usable signal; exploring without it', {
        explorationId: config.explorationId,
      });
      trace?.writeWarning?.('phase0_no_signal', { phase: 'phase0' });
      return done({ skipReason: 'no_signal' });
    }

    // Re-apply what this user already told us about THIS product, BEFORE asking
    // anything. The two have different lifetimes: a homepage rewrite invalidates
    // what the analyst inferred, but not "my staging host is at this origin".
    // Applied before `askBriefQuestions` on purpose — `planBriefQuestions` skips
    // any field whose source is 'user', so a previously answered question is not
    // asked a second time. Without this, the ask budget would silently be
    // per-run again, which is the whole thing this feature set out to fix.
    const briefWithPriorAnswers = applyStoredAnswers(brief, priorAnswers);

    // Ask at most 3 questions for what the evidence structurally cannot answer.
    // Best-effort: an unanswered or undeliverable question leaves the brief as
    // derived, which is still useful — Phase 0 must never stall a run.
    const { brief: withAnswers, answers: freshAnswers } = await askBriefQuestions(
      briefWithPriorAnswers,
      config,
      trace,
    );

    // Persist the union: a newly answered key wins over the stored one, and a
    // key answered on an earlier run survives a run where it was not asked.
    const userAnswers = mergeAnswers(priorAnswers, freshAnswers);

    logger.info('[PHASE0] Product brief built', {
      explorationId: config.explorationId,
      productType: withAnswers.productType.value,
      criticalFlows: withAnswers.criticalFlows.value.length,
      entities: withAnswers.entities.value.length,
      overallConfidence: withAnswers.overallConfidence,
      openQuestions: withAnswers.openQuestions.length,
      questionsAsked: withAnswers.askLog?.length ?? 0,
      questionsAnswered: withAnswers.askLog?.filter((a) => a.answered).length ?? 0,
      evidenceSources: evidence.sources.length,
      durationMs: Date.now() - startedAt,
    });

    // Cache for the next run on this origin. Not awaited-for-correctness: the
    // brief is already built and the run proceeds either way.
    await storeBriefForReuse(config, withAnswers, userAnswers, currentFingerprint);

    return done({ brief: withAnswers });
  } catch (error) {
    // Belt and braces: an enhancement must never be able to fail the run.
    logger.warn('[PHASE0] Unexpected failure; exploring without a brief', {
      explorationId: config.explorationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return done({ skipReason: 'ai_failed' });
  }
}
