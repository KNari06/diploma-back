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
import { AI_MODELS } from '@/config/ai/ai-models.config';

import type { ExplorationBlackboard, SentinelInput, SentinelAssessment } from './agent-types';
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

/** Timeout for Sentinel AI call */
const SENTINEL_TIMEOUT_MS = 20_000;

export class ExplorationSentinel {
  constructor(private readonly bb: ExplorationBlackboard) {}

  /**
   * Evaluate coverage and decide whether to continue exploring.
   */
  async evaluate(): Promise<SentinelAssessment> {
    const input = this.buildInput();
    const prompt = buildSentinelPrompt(input);

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
            model: AI_MODELS.smart,
            temperature: 0.1,
            max_tokens: 1500,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Sentinel AI timeout')), SENTINEL_TIMEOUT_MS),
        ),
      ]);

      this.bb.rateLimiter.recordSuccess('openai');

      const result = parseSentinelResponse(response.content);

      if (!result) {
        logger.warn('[SENTINEL] Failed to parse response');
        return this.fallbackAssessment();
      }

      logger.info('[SENTINEL] Coverage evaluated', {
        coverageScore: result.coverageScore,
        gaps: result.gaps.length,
        continueExploring: result.continueExploring,
        riskAreas: result.riskAreas.length,
        latencyMs: Date.now() - aiStartTime,
      });

      return result;
    } catch (error) {
      logger.warn('[SENTINEL] AI call failed, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallbackAssessment();
    }
  }

  private buildInput(): SentinelInput {
    const completedFlows = buildFlowSummaries(this.bb.completedFlows);
    const skippedEntryPoints = this.bb.queue?.remaining() ?? [];

    return {
      pagesDiscovered: this.bb.tree?.getNodeCount() ?? 0,
      pageInsights: getPageInsightsArray(this.bb),
      completedFlows,
      blockedFlows: buildBlockedFlowSummaries(this.bb.completedFlows),
      skippedFlows: skippedEntryPoints.map((ep) => ({
        name: ep.name,
        category: ep.category,
        reason: 'Budget exhausted',
      })),
      categoriesCovered: getCategoriesCovered(this.bb),
      totalStepsExecuted: this.bb.completedFlows.reduce((sum, f) => sum + f.stepsCount, 0),
      errorsFound: this.bb.completedFlows.reduce((sum, f) => sum + f.errors.length, 0),
      budget: buildBudgetSummary(this.bb.budget),
      scopeHint: this.bb.scopeHint,
    };
  }

  private fallbackAssessment(): SentinelAssessment {
    const completed = this.bb.completedFlows.length;
    const total = this.bb.tree?.getAllEntryPoints()?.length || 0;
    const score = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      coverageScore: score,
      gaps: [],
      continueExploring: false,
      qualitySummary: `Explored ${completed} of ${total} discovered flows (${score}% coverage). AI assessment unavailable.`,
      recommendations: [],
      riskAreas: [],
    };
  }
}
