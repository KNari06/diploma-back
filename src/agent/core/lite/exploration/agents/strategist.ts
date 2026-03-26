/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STRATEGIST AGENT — Exploration Planning & Prioritization
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NEW agent — replaces static FlowQueue.fromEntryPoints() scoring formula.
 * Called: after Phase 1, after each batch of flows, on user directive.
 *
 * Responsibilities:
 *   - See the COMPLETE exploration state (tree, insights, results, discoveries)
 *   - Prioritize flows for maximum coverage with limited budget
 *   - Plan auth strategy (login before auth-gated flows)
 *   - Decide whether to continue surveying or start executing
 *   - Respond to user directives (focus, skip, stop)
 *
 * Reuses from LiteEngine:
 *   - StrategistOutput pattern (structured output + confidence + alternatives)
 *   - WorkingMemory pattern
 *   - getChatCompletionWithMessages (AI call wrapper)
 */

import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';

import type { ExplorationBlackboard, StrategistInput, StrategistOutput } from './agent-types';
import {
  buildTreeSummary,
  buildFlowSummaries,
  buildBlockedFlowSummaries,
  buildBudgetSummary,
  getPageInsightsArray,
} from './blackboard';
import {
  STRATEGIST_SYSTEM_PROMPT,
  buildStrategistPrompt,
  parseStrategistResponse,
} from './strategist-prompts';

/** Timeout for Strategist AI call */
const STRATEGIST_TIMEOUT_MS = 20_000;

export class ExplorationStrategist {
  constructor(private readonly bb: ExplorationBlackboard) {}

  /**
   * Create the initial exploration plan after Phase 1 survey.
   * Sees: full tree + all entry points + all page insights + budget.
   */
  async plan(): Promise<StrategistOutput> {
    const result = await this.callStrategist();
    return result || this.fallbackOutput();
  }

  /**
   * Re-evaluate strategy after a batch of flows completes.
   * Sees: all of above + completed flows + Scout discoveries.
   */
  async reEvaluate(): Promise<StrategistOutput | null> {
    return this.callStrategist();
  }

  /**
   * Handle a user directive from WebSocket.
   * Sees: all context + the user directive.
   */
  async handleDirective(directive: string): Promise<StrategistOutput> {
    const result = await this.callStrategist(directive);
    return result || this.fallbackOutput();
  }

  /**
   * Plan focused exploration based on Sentinel's gap analysis.
   */
  async planFocused(focusAreas?: string[]): Promise<StrategistOutput> {
    const directive = focusAreas
      ? `Focus on these areas identified as coverage gaps: ${focusAreas.join(', ')}`
      : undefined;
    const result = await this.callStrategist(directive);
    return result || this.fallbackOutput();
  }

  private async callStrategist(userDirective?: string): Promise<StrategistOutput | null> {
    const input = this.buildInput(userDirective);
    const prompt = buildStrategistPrompt(input);

    this.bb.trace?.writeStrategistPrompt({
      model: AI_MODELS.smart,
      systemPrompt: STRATEGIST_SYSTEM_PROMPT,
      userPrompt: prompt,
      userDirective,
    });

    try {
      await this.bb.rateLimiter.acquireSlot('ai');

      const aiStartTime = Date.now();

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: STRATEGIST_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          {
            model: AI_MODELS.smart,
            temperature: 0.2,
            max_tokens: 2500,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Strategist AI timeout')), STRATEGIST_TIMEOUT_MS),
        ),
      ]);

      this.bb.rateLimiter.recordSuccess('openai');

      const result = parseStrategistResponse(response.content);
      const latencyMs = Date.now() - aiStartTime;

      this.bb.trace?.writeStrategistResponse({
        model: AI_MODELS.smart,
        rawResponse: response.content,
        parsed: result ? {
          plannedFlows: result.plan.length,
          loginFirst: result.authPlan.loginFirst,
          continueSurvey: result.continueSurvey,
          skipFlows: result.skipFlows.length,
          focusAreas: result.focusAreas,
        } : null,
        latencyMs,
      });

      if (!result) {
        logger.warn('[STRATEGIST] Failed to parse response');
        this.bb.emitProgress?.({ explorationId: '', phase: 'strategizing', event: 'agent_warning', data: { agent: 'strategist', message: 'Failed to parse AI response, using fallback' }, progressPercent: 0, timestamp: Date.now() });
        return null;
      }

      logger.info('[STRATEGIST] Strategy created', {
        plannedFlows: result.plan.length,
        loginFirst: result.authPlan.loginFirst,
        continueSurvey: result.continueSurvey,
        skipFlows: result.skipFlows.length,
        focusAreas: result.focusAreas,
        latencyMs,
      });

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[STRATEGIST] AI call failed, using fallback', { error: errMsg });
      this.bb.trace?.writeStrategistFallback({ reason: errMsg, flowCount: 0 });
      this.bb.emitProgress?.({ explorationId: '', phase: 'strategizing', event: 'agent_error', data: { agent: 'strategist', message: `AI call failed: ${errMsg}`, severity: 'warning' }, progressPercent: 0, timestamp: Date.now() });
      return null;
    }
  }

  private buildInput(userDirective?: string): StrategistInput {
    return {
      tree: buildTreeSummary(this.bb.tree),
      allEntryPoints: this.bb.tree?.getAllEntryPoints() ?? [],
      pageInsights: getPageInsightsArray(this.bb),
      completedFlows: buildFlowSummaries(this.bb.completedFlows),
      blockedFlows: buildBlockedFlowSummaries(this.bb.completedFlows),
      recentDiscoveries: this.bb.discoveredBranches,
      coverageAssessment: this.bb.coverageAssessment,
      budget: buildBudgetSummary(this.bb.budget),
      hasCredentials: this.bb.hasCredentials,
      scopeHint: this.bb.scopeHint,
      userDirective,
    };
  }

  /**
   * Fallback output when AI fails — uses all entry points in default order.
   */
  private fallbackOutput(): StrategistOutput {
    const allEntryPoints = this.bb.tree?.getAllEntryPoints() ?? [];
    return {
      plan: allEntryPoints.map((ep, idx) => ({
        entryPointId: ep.id,
        name: ep.name,
        priority: idx + 1,
        reason: 'Fallback: default order',
      })),
      authPlan: {
        loginFirst: this.bb.hasCredentials,
        authGatedFlows: allEntryPoints.filter((ep) => ep.requiresAuth).map((ep) => ep.id),
      },
      continueSurvey: false,
      skipFlows: [],
      focusAreas: [],
      strategyReasoning: 'Fallback strategy — AI call failed, using default entry point order.',
    };
  }
}
