/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCOUT AGENT — Branch Discovery After Flow Completion
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Replaces: detectBranchPoints() in flow-runner.ts
 * Called: after EACH completed flow in Phase 2
 *
 * Responsibilities:
 *   - Analyze the final page state after a flow completes
 *   - Discover NEW testable flows that became accessible
 *   - Identify new pages worth surveying
 *   - Produce insight for Strategist context
 *
 * Reuses from LiteEngine:
 *   - getChatCompletionWithMessages (AI call wrapper)
 *   - GoalDetector (flow completion verification)
 */

import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';

import { RateLimiter } from '../rate-limiter';
import type { ExplorationTraceService } from '../exploration-trace.service';
import type { ScoutInput, ScoutOutput, ScoutDiscovery } from './agent-types';
import {
  SCOUT_SYSTEM_PROMPT,
  buildScoutPrompt,
  parseScoutResponse,
} from './scout-prompts';

/** Timeout for Scout AI call */
const SCOUT_TIMEOUT_MS = 20_000;

export class Scout {
  constructor(
    private readonly rateLimiter: RateLimiter | undefined,
    private readonly trace?: ExplorationTraceService,
  ) {}

  /**
   * Discover new flows on the current page after a flow completes.
   *
   * @param input - Completed flow context + current page state
   * @returns ScoutOutput with new entry points, pages, and insight
   */
  async detect(input: ScoutInput): Promise<ScoutOutput> {
    const { completedFlow } = input;

    // Skip if AI is degraded or no budget left
    if (this.rateLimiter?.isDegraded('openai') || input.flowsRemaining <= 0) {
      logger.debug('[SCOUT] Skipping branch detection (degraded or no budget)', {
        flowName: completedFlow.name,
        degraded: this.rateLimiter?.isDegraded('openai') ?? false,
        flowsRemaining: input.flowsRemaining,
      });
      return { newEntryPoints: [], newPages: [], insight: 'Skipped (no budget or AI degraded)' };
    }

    const prompt = buildScoutPrompt(input);

    try {
      if (this.rateLimiter) await this.rateLimiter.acquireSlot('ai');

      this.trace?.writeBranchDetectionPrompt({
        entryPointId: completedFlow.name,
        model: AI_MODELS.fast,
        systemPrompt: SCOUT_SYSTEM_PROMPT,
        userPrompt: prompt,
      });

      const aiStartTime = Date.now();

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: SCOUT_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          {
            model: AI_MODELS.fast,
            temperature: 0.1,
            max_tokens: 1500,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Scout AI timeout')), SCOUT_TIMEOUT_MS),
        ),
      ]);

      this.rateLimiter?.recordSuccess('openai');

      const result = parseScoutResponse(response.content);

      this.trace?.writeBranchDetectionResponse({
        entryPointId: completedFlow.name,
        model: AI_MODELS.fast,
        rawResponse: response.content,
        parsedBranches: result.newEntryPoints.map((ep) => ({
          name: ep.name,
          category: ep.category,
          priority: ep.priority,
        })),
        latencyMs: Date.now() - aiStartTime,
      });

      if (result.newEntryPoints.length > 0 || result.newPages.length > 0) {
        logger.info('[SCOUT] New branches discovered', {
          afterFlow: completedFlow.name,
          newEntryPoints: result.newEntryPoints.length,
          newPages: result.newPages.length,
          insight: result.insight,
        });
      }

      return result;
    } catch (error) {
      // Handle rate limits
      if (this.rateLimiter && RateLimiter.isRateLimitError(error as Error)) {
        const rlResult = await this.rateLimiter.recordFailure('openai', error as Error);
        if (rlResult.shouldRetry) {
          return this.detect(input);
        }
      }

      logger.warn('[SCOUT] Branch detection failed', {
        afterFlow: completedFlow.name,
        error: error instanceof Error ? error.message : String(error),
      });

      return { newEntryPoints: [], newPages: [], insight: 'Branch detection failed' };
    }
  }

  /**
   * Create a ScoutDiscovery record for blackboard storage.
   */
  static toDiscovery(
    sourceFlowId: string,
    sourceFlowName: string,
    output: ScoutOutput,
  ): ScoutDiscovery {
    return {
      sourceFlowId,
      sourceFlowName,
      discoveredAt: Date.now(),
      newEntryPoints: output.newEntryPoints,
      newPages: output.newPages,
      insight: output.insight,
    };
  }
}
