/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SENTINEL AGENT — Coverage Evaluation & Gap Analysis
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NEW agent — replaces "stop when budget runs out" with intelligent
 * coverage assessment.
 *
 * Called:
 *   1. After Phase 2 completes (mandatory) — final assessment
 *   2. After each batch of flows if budget allows (optional)
 *
 * Responsibilities:
 *   - Evaluate exploration completeness (coverage score 0-100)
 *   - Identify coverage gaps
 *   - Decide whether to continue exploring
 *   - Produce user-facing quality summary
 *   - Flag risk areas with errors
 */

import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';

import type { ExplorationBlackboard, SentinelInput, SentinelAssessment } from './agent-types';
import { EXPLORATION_AGENT_LLM } from './agent-llm-config';
import { formatBriefForSentinel } from '../phase0/brief-format';
import {
  buildFlowSummaries,
  buildBlockedFlowSummaries,
  buildBudgetSummary,
  getPageInsightsArray,
  getCategoriesCovered,
} from './blackboard';
import {
  SENTINEL_SYSTEM_PROMPT,
  buildSentinelPrompt,
  parseSentinelResponse,
} from './sentinel-prompts';

/** Centralized LLM tuning for this agent (model / temp / tokens / timeout). */
const LLM = EXPLORATION_AGENT_LLM.sentinel;

/**
 * Below this many discovered entry points, the fallback ratio is not evidence of
 * coverage — it is evidence that discovery failed. See `fallbackAssessment`.
 */
const FALLBACK_MIN_ENTRY_POINTS_FOR_FULL_SCORE = 5;

/** Score ceiling applied when discovery was too thin to trust the ratio. */
const FALLBACK_THIN_DISCOVERY_SCORE_CAP = 40;

export class ExplorationSentinel {
  constructor(private readonly bb: ExplorationBlackboard) {}

  /**
   * Evaluate coverage and decide whether to continue exploring.
   */
  async evaluate(): Promise<SentinelAssessment> {
    const input = this.buildInput();
    const prompt = buildSentinelPrompt(input);

    this.bb.trace?.writeSentinelPrompt({
      model: LLM.model,
      systemPrompt: SENTINEL_SYSTEM_PROMPT,
      userPrompt: prompt,
    });

    try {
      await this.bb.rateLimiter.acquireSlot('ai');

      const aiStartTime = Date.now();

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: SENTINEL_SYSTEM_PROMPT },
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
          setTimeout(() => reject(new Error('Sentinel AI timeout')), LLM.timeoutMs),
        ),
      ]);

      this.bb.rateLimiter.recordSuccess('openai');

      const result = parseSentinelResponse(response.content);
      const latencyMs = Date.now() - aiStartTime;

      this.bb.trace?.writeSentinelResponse({
        model: LLM.model,
        rawResponse: response.content,
        parsed: result ? {
          coverageScore: result.coverageScore,
          gaps: result.gaps.length,
          continueExploring: result.continueExploring,
          riskAreas: result.riskAreas.length,
        } : null,
        latencyMs,
      });

      if (!result) {
        logger.warn('[SENTINEL] Failed to parse response');
        this.bb.emitProgress?.({ explorationId: '', phase: 'evaluating', event: 'agent_warning', data: { agent: 'sentinel', message: 'Failed to parse AI response, using fallback' }, progressPercent: 0, timestamp: Date.now() });
        return this.fallbackAssessment();
      }

      logger.info('[SENTINEL] Coverage evaluated', {
        coverageScore: result.coverageScore,
        gaps: result.gaps.length,
        continueExploring: result.continueExploring,
        riskAreas: result.riskAreas.length,
        latencyMs,
      });

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[SENTINEL] AI call failed, using fallback', { error: errMsg });
      this.bb.trace?.writeSentinelFallback({ reason: errMsg, coverageScore: 0 });
      this.bb.emitProgress?.({ explorationId: '', phase: 'evaluating', event: 'agent_error', data: { agent: 'sentinel', message: `AI call failed: ${errMsg}`, severity: 'warning' }, progressPercent: 0, timestamp: Date.now() });
      return this.fallbackAssessment();
    }
  }

  private buildInput(): SentinelInput {
    // Split executed vs skipped: budget-skipped tasks live in completedFlows
    // (with status 'skipped') but were never run — they must be reported as
    // SKIPPED, not as tested, and excluded from step/error/coverage stats.
    const executedFlows = this.bb.completedFlows.filter((f) => f.status !== 'skipped');
    const skippedTaskFlows = this.bb.completedFlows.filter((f) => f.status === 'skipped');

    const completedFlows = buildFlowSummaries(executedFlows);
    const skippedEntryPoints = this.bb.queue?.remaining() ?? [];

    return {
      pagesDiscovered: this.bb.tree?.getNodeCount() ?? 0,
      pageInsights: getPageInsightsArray(this.bb),
      completedFlows,
      blockedFlows: buildBlockedFlowSummaries(executedFlows),
      skippedFlows: [
        // Tasks dequeued but skipped because budget ran out mid-run.
        ...skippedTaskFlows.map((f) => ({ name: f.name, category: f.category, reason: 'Budget exhausted' })),
        // Entry points still queued (never dequeued).
        ...skippedEntryPoints.filter((ep) => ep?.name && ep?.category).map((ep) => ({
          name: ep.name,
          category: ep.category,
          reason: 'Budget exhausted',
        })),
      ],
      categoriesCovered: getCategoriesCovered(this.bb),
      totalStepsExecuted: executedFlows.reduce((sum, f) => sum + f.stepsCount, 0),
      errorsFound: executedFlows.reduce((sum, f) => sum + f.errors.length, 0),
      budget: buildBudgetSummary(this.bb.budget),
      scopeHint: this.bb.scopeHint,
      productBrief: this.bb.productBrief
        ? formatBriefForSentinel(this.bb.productBrief)
        : undefined,
    };
  }

  private fallbackAssessment(): SentinelAssessment {
    // Only count flows that actually executed — skipped (budget-exhausted)
    // flows are not coverage and must not inflate the score.
    const completed = this.bb.completedFlows.filter((f) => f.status !== 'skipped').length;
    const total = this.bb.tree?.getAllEntryPoints()?.length || 0;
    // Clamp to [0, 100]: Scout-discovered branches can push completed past the
    // initial tree entry point count, which would otherwise yield >100%.
    const rawScore = total > 0 ? Math.round((completed / total) * 100) : 0;
    let score = Math.max(0, Math.min(100, rawScore));

    // The denominator is what we DISCOVERED, so this ratio inverts exactly when
    // discovery failed worst: if Cartographer returned 2 entry points instead of
    // 40 (LLM parse failure — which emits no progress event, so nothing else
    // flags it), exploring both scored 100 and a near-total discovery failure
    // surfaced as PERFECT coverage on the dashboard. Cap the score whenever the
    // evidence base is too thin to support a confident number: a ratio over a
    // handful of entry points is not coverage of an app.
    const thinDiscovery = total < FALLBACK_MIN_ENTRY_POINTS_FOR_FULL_SCORE;
    if (thinDiscovery) {
      score = Math.min(score, FALLBACK_THIN_DISCOVERY_SCORE_CAP);
    }
    const budgetExhausted = this.bb.budget?.isExhausted?.() ?? true;

    // Continue exploring if coverage is low AND budget allows AND there is
    // anything to continue exploring (entry points > 0). No tree = nothing to do.
    const shouldContinue = score < 75 && !budgetExhausted && total > 0;
    const uncoveredCategories = shouldContinue ? this.identifyUncoveredCategories() : [];

    return {
      coverageScore: score,
      continueExploring: shouldContinue,
      focusNext: uncoveredCategories.length > 0 ? uncoveredCategories : undefined,
      gaps: thinDiscovery && total > 0
        ? [
            `Only ${total} testable flow(s) were discovered — coverage cannot be assessed reliably`,
            ...uncoveredCategories.map((c) => `Category "${c}" not yet tested`),
          ]
        : uncoveredCategories.map((c) => `Category "${c}" not yet tested`),
      qualitySummary: total === 0
        ? 'No entry points discovered during survey. AI assessment unavailable.'
        : thinDiscovery
          // Say the ratio is untrustworthy rather than printing a confident
          // percentage over a 2-flow denominator.
          ? `Only ${total} testable flow(s) were discovered, so coverage cannot be assessed reliably — the survey may have failed to understand the pages. Explored ${completed} of them. AI assessment unavailable.`
          : `Explored ${completed} of ${total} discovered flows (${score}% coverage). AI assessment unavailable.`,
      recommendations: thinDiscovery && total > 0
        ? ['Very few flows were discovered — check that the entry URL reaches the app, and provide credentials if it is behind a login']
        : uncoveredCategories.length > 0
          ? [`Test uncovered categories: ${uncoveredCategories.join(', ')}`]
          : [],
      riskAreas: [],
    };
  }

  private identifyUncoveredCategories(): string[] {
    const exploredCategories = new Set(
      this.bb.completedFlows.filter((f) => f.status !== 'skipped').map((f) => f.category),
    );
    const allEntryPoints = this.bb.tree?.getAllEntryPoints() ?? [];
    const allCategories = new Set(allEntryPoints.map((ep) => ep.category));
    return [...allCategories].filter((c) => !exploredCategories.has(c));
  }
}
