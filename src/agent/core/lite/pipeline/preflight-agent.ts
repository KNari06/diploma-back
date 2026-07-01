/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PREFLIGHT CHECK AGENT — pre-action gate (runs BETWEEN Planner and Executor)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Reviewer is REACTIVE: it judges an action AFTER it ran, so a wasteful or
 * wrong action still burns a round before being caught. PreflightCheck is
 * PROACTIVE: it inspects the Planner's plan BEFORE the Executor runs it and can
 * short-circuit a doomed round.
 *
 * Two layers, cheap → expensive:
 *   1. FACT (0 tokens): a plan step targeting a ref that does NOT exist on the
 *      current page is a Planner hallucination — deterministic, no LLM needed.
 *   2. SEMANTIC (LLM): does the plan repeat a dead end / move away from the goal
 *      / press on against an unreachable state? This is judgment, where the LLM
 *      earns its cost. Reuses the Reviewer's model + call pattern.
 *
 * Best-effort by contract: any failure (LLM timeout, parse error, thrown) returns
 * 'go' so the gate NEVER blocks a flow it couldn't evaluate (CLAUDE.md #11).
 * Exploration-only — wired in TestPipeline behind EXPLORATION_PREFLIGHT_ENABLED.
 */

import { logger } from '@/utils/core/logger';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildParsedSnapshot } from '../agents/parsed-snapshot';
import type { LiteTraceWriter } from '../trace/lite-trace-writer';
import { TestBlackboard } from './blackboard';
import type { PreflightResult } from './types';
import { buildPreflightPrompt } from './preflight-prompts';

/** LLM decoding knobs — mirror the Reviewer (fast tier, low temp, concise). */
const PREFLIGHT_CONFIG = {
  temperature: 0.1,
  maxTokens: 250,
  timeoutMs: 6_000,
} as const;

export class PreflightCheckAgent {
  /**
   * Inspect the current plan on the blackboard and decide go / revise / block.
   * Static (like Planner/Reviewer) — holds no per-run state; the round counter
   * that prevents a revise loop lives in TestPipeline.
   */
  static async inspect(
    blackboard: TestBlackboard,
    traceWriter?: LiteTraceWriter,
  ): Promise<PreflightResult> {
    const round = blackboard.getRounds().length;

    // ── Layer 1: FACT — deterministic, no LLM ───────────────────────────────
    // (a) Hallucinated ref: plan cites a ref not on the page → guaranteed miss.
    // (b) Repeat of a known-failed ref: the plan re-targets an element that
    //     already failed in a prior round (external-link block, fill-into-
    //     checkbox, not-visible…). Re-running it wastes another round — the log
    //     showed the Planner re-clicking the SAME dead ref across rounds.
    // Both are objective, so decide here without paying for the LLM.
    const factVerdict =
      PreflightCheckAgent.checkPlanRefs(blackboard) ??
      PreflightCheckAgent.checkRepeatedFailures(blackboard);
    if (factVerdict) {
      PreflightCheckAgent.trace(traceWriter, round, factVerdict, 'fact');
      return factVerdict;
    }

    // ── Layer 2: SEMANTIC — LLM judgment ────────────────────────────────────
    try {
      const prompt = buildPreflightPrompt(blackboard);

      const aiPromise = getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: AI_TASK_MODELS.chatReviewer,
          temperature: PREFLIGHT_CONFIG.temperature,
          max_tokens: PREFLIGHT_CONFIG.maxTokens,
          response_format: { type: 'json_object' },
        },
      );
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), PREFLIGHT_CONFIG.timeoutMs),
      );

      const result = await Promise.race([aiPromise, timeoutPromise]);
      if (!result?.content) {
        // Timeout / empty → fail OPEN (never block on a look we couldn't take).
        return PreflightCheckAgent.pass('Preflight LLM unavailable — proceeding');
      }

      const parsed = PreflightCheckAgent.parse(result.content);
      const verdict: PreflightResult = {
        verdict: parsed.verdict === 'revise' || parsed.verdict === 'block' ? parsed.verdict : 'go',
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'Preflight check passed',
        guidance: typeof parsed.guidance === 'string' ? parsed.guidance : undefined,
      };
      PreflightCheckAgent.trace(traceWriter, round, verdict, 'llm');
      return verdict;
    } catch (error) {
      logger.warn('[PREFLIGHT] Semantic check failed — proceeding (fail-open)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return PreflightCheckAgent.pass('Preflight check errored — proceeding');
    }
  }

  /**
   * FACT layer: every plan step that targets an element ref must reference a ref
   * that actually exists on the current snapshot. A hallucinated ref → 'revise'
   * (not 'block'): the page is fine, the Planner just needs to re-ground against
   * real refs. Fails OPEN when there's no snapshot to check against.
   */
  private static checkPlanRefs(blackboard: TestBlackboard): PreflightResult | null {
    const snapshot = blackboard.getCurrentPageSnapshot();
    if (!snapshot) return null; // nothing to validate against → let it run

    const plan = blackboard.getPlan();
    const targetRefs = (plan?.steps ?? [])
      .map((s) => s.targetRef)
      .filter((r): r is string => typeof r === 'string' && r.length > 0);
    if (targetRefs.length === 0) return null; // description-only plan → nothing to check

    const parsed = buildParsedSnapshot(snapshot);
    const missing = targetRefs.filter((ref) => !parsed.hasRef(ref));
    if (missing.length === 0) return null;

    return {
      verdict: 'revise',
      reason: `Plan targets ${missing.length} element ref(s) not on the page: ${missing.join(', ')}`,
      guidance: `Re-observe the page and target only refs that exist in CURRENT PAGE STATE. Do not reuse stale refs (${missing.join(', ')}).`,
    };
  }

  /**
   * FACT layer: reject a plan that re-targets a ref which ALREADY failed. The
   * log showed the Planner re-clicking the same dead ref round after round
   * (external-link blocks, fill-into-checkbox, not-visible), each retry burning
   * a full round. A ref is treated as a known dead end when it either:
   *   - failed with a DETERMINISTIC error that will recur (external link avoided,
   *     fill into a non-fillable element) — one failure is enough, OR
   *   - failed REPEATEDLY (≥ FAILURE_REPEAT_THRESHOLD rounds) with any error —
   *     covers transient-looking timeouts that turn out to be structural.
   * Fails OPEN (returns null) when the plan has no targetRefs or no history.
   */
  private static checkRepeatedFailures(blackboard: TestBlackboard): PreflightResult | null {
    const plan = blackboard.getPlan();
    const planRefs = new Set(
      (plan?.steps ?? [])
        .map((s) => s.targetRef)
        .filter((r): r is string => typeof r === 'string' && r.length > 0),
    );
    if (planRefs.size === 0) return null;

    // Tally per-ref failures across all prior rounds. A ref that also SUCCEEDED
    // later is cleared — the page may have changed and it's live again.
    const failCounts = new Map<string, number>();
    const deterministicDead = new Set<string>();
    const succeededRefs = new Set<string>();
    for (const round of blackboard.getRounds()) {
      for (const cmd of round.commands) {
        const ref = typeof cmd.command.args?.ref === 'string' ? cmd.command.args.ref : undefined;
        if (!ref) continue;
        if (cmd.result.success) {
          succeededRefs.add(ref);
          continue;
        }
        failCounts.set(ref, (failCounts.get(ref) ?? 0) + 1);
        if (PreflightCheckAgent.isDeterministicFailure(cmd.result.error)) {
          deterministicDead.add(ref);
        }
      }
    }

    const deadRefs = [...planRefs].filter(
      (ref) =>
        !succeededRefs.has(ref) &&
        (deterministicDead.has(ref) ||
          (failCounts.get(ref) ?? 0) >= PreflightCheckAgent.FAILURE_REPEAT_THRESHOLD),
    );
    if (deadRefs.length === 0) return null;

    return {
      verdict: 'revise',
      reason: `Plan re-targets ref(s) that already failed and won't succeed on retry: ${deadRefs.join(', ')}`,
      guidance: `Do NOT reuse ${deadRefs.join(', ')} — they failed before (blocked/not-fillable/not-visible). Choose a DIFFERENT element or path toward the goal.`,
    };
  }

  /**
   * A failure whose CAUSE is structural, so retrying the same ref will fail the
   * same way — one occurrence is enough to treat the ref as dead. Kept to error
   * SUBSTRINGS the executor itself emits (see action-executor / command-executor),
   * not a broad guess: external-link guard, and fill/interaction into an element
   * that is inherently non-interactable.
   */
  private static isDeterministicFailure(error: string | undefined): boolean {
    if (!error) return false;
    const e = error.toLowerCase();
    return (
      e.includes('external_link_avoided') ||
      e.includes('cannot fill') ||
      e.includes('not an input') ||
      e.includes('element is not visible') ||
      e.includes('not editable')
    );
  }

  /** Rounds a ref must fail (with a non-deterministic error) before it's dead. */
  private static readonly FAILURE_REPEAT_THRESHOLD = 2;

  private static pass(reason: string): PreflightResult {
    return { verdict: 'go', reason };
  }

  /** Parse the LLM JSON body. Guarded — response_format is json_object, so a
   *  bare JSON.parse suffices; any oddity falls through to fail-open at the caller. */
  private static parse(content: string): { verdict?: string; reason?: string; guidance?: string } {
    try {
      return JSON.parse(content.trim().replace(/```json\s*/g, '').replace(/```\s*/g, ''));
    } catch {
      return {}; // → normalized to 'go' by the caller
    }
  }

  private static trace(
    traceWriter: LiteTraceWriter | undefined,
    round: number,
    verdict: PreflightResult,
    layer: 'fact' | 'llm',
  ): void {
    try {
      traceWriter?.write({
        iteration: round,
        stage: 'pipeline',
        eventType: 'preflight_check',
        spanId: traceWriter.generateSpanId(),
        payload: { round, layer, verdict: verdict.verdict, reason: verdict.reason },
      });
    } catch {
      // Trace failures never affect the gate.
    }
  }
}
