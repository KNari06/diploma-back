/**
 * Multi-Agent Orchestrator (Manus Architecture)
 * Coordinates Observer → Strategist → Actor → Critic pipeline.
 * Falls back gracefully — if any agent fails, returns { success: false }
 * so the caller can use the existing monolithic prompt.
 *
 * Manus enhancements:
 * - Branching & Backtracking: Tries alternatives when primary strategy fails Actor
 * - Critic (Phase 4): Red Teaming + Security Policy + Reasoning Consistency
 * - Expectation Loop: Stores expectedOutcome for next iteration validation
 * - Reasoning History: Tracks strategy thoughts for consistency checking
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { ActorAgent } from './actor-agent';
import { CriticAgent } from './critic-agent';
import { ObserverCache } from './observer-cache';
import { ObserverAgent } from './observer-agent';
import { StrategistAgent } from './strategist-agent';
import type { MultiAgentInput, MultiAgentResult, MultiAgentRunMetrics, ObserverOutput } from './types';

export class MultiAgentOrchestrator {
  private observerCache: ObserverCache;
  /** Manus-style: Store last expectedOutcome for next iteration's expectation validation */
  private lastExpectedOutcome: string | undefined;
  /** Manus-style: Store last verificationCriteria for concrete success checking */
  private lastVerificationCriteria: string | undefined;
  /** Manus-style: Rolling reasoning history for consistency checks (bounded) */
  private reasoningHistory: string[] = [];

  /** Run-level metrics accumulated across all iterations */
  private metrics = {
    totalIterations: 0,
    multiAgentSuccessCount: 0,
    monolithicFallbackCount: 0,
    totalObserverMs: 0,
    totalStrategistMs: 0,
    totalActorMs: 0,
    totalCriticMs: 0,
    totalPipelineMs: 0,
    observerCacheHits: 0,
    observerCacheMisses: 0,
    actorDeterministicCount: 0,
    criticApproveCount: 0,
    criticRejectCount: 0,
    criticOverrideCount: 0,
    criticSkippedCount: 0,
    alternativeUsedCount: 0,
    policyViolationCount: 0,
  };

  constructor() {
    this.observerCache = new ObserverCache();
  }

  /** Get last expected outcome for expectation validation loop */
  getLastExpectedOutcome(): string | undefined {
    return this.lastExpectedOutcome;
  }

  /** Get last verification criteria */
  getLastVerificationCriteria(): string | undefined {
    return this.lastVerificationCriteria;
  }

  /**
   * Execute the full Observer → Strategist → Actor → Critic pipeline
   * Manus-style: Tries alternatives (branching) before falling back to monolithic
   * Returns { success: false } if all branches fail (caller should fall through to monolithic)
   */
  async execute(input: MultiAgentInput): Promise<MultiAgentResult> {
    this.metrics.totalIterations++;

    const totalStart = Date.now();
    let observerMs = 0;
    let strategistMs = 0;
    let actorMs = 0;
    let criticMs = 0;
    let observerCacheHit = false;
    let actorDeterministic = false;
    let criticVerdict: 'approve' | 'reject' | 'override' | 'skipped' = 'skipped';

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // Phase 1: Observer — "What do I see?"
      // ═══════════════════════════════════════════════════════════════════════
      const observerStart = Date.now();
      let observation: ObserverOutput | null = null;

      // Check cache first
      if (LITE_ENGINE_FLAGS.multiAgentObserverCacheEnabled) {
        observation = this.observerCache.get(input.url, input.contentHash);
        if (observation) {
          observerCacheHit = true;
        }
      }

      if (!observation) {
        observation = await ObserverAgent.observe({
          snapshot: input.snapshot,
          stateDrift: input.stateDrift,
          visionHints: input.visionHints,
          url: input.url,
          title: input.title,
          // Manus-style enhancements
          previousSnapshot: input.previousSnapshot,
          networkActivity: input.networkActivity,
          lastExpectation: input.lastExpectation,
          lastAction: input.lastAction,
        });

        if (!observation) {
          logger.warn('[MULTI_AGENT] Observer failed, falling back to monolithic');
          this.metrics.monolithicFallbackCount++;
          return { success: false };
        }

        // Cache the result
        if (LITE_ENGINE_FLAGS.multiAgentObserverCacheEnabled) {
          this.observerCache.set(input.url, input.contentHash, observation);
        }
      }
      observerMs = Date.now() - observerStart;

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2: Strategist — "What should I do?"
      // ═══════════════════════════════════════════════════════════════════════
      const strategistStart = Date.now();
      const strategy = await StrategistAgent.strategize({
        observation,
        goal: input.goal,
        history: input.history,
        taskPlanSummary: input.taskPlanSummary,
        guidance: input.guidance,
        progressScore: input.progressScore,
        failedActions: input.failedActions,
        auditedDrift: input.auditedDrift,
        iteration: input.iteration,
        isStuck: input.isStuck,
        lastOutcome: input.lastOutcome,
      });

      if (!strategy) {
        logger.warn('[MULTI_AGENT] Strategist failed, falling back to monolithic');
        this.metrics.monolithicFallbackCount++;
        return { success: false };
      }
      strategistMs = Date.now() - strategistStart;

      // Store expectedOutcome for next iteration's expectation validation
      this.lastExpectedOutcome = strategy.expectedOutcome;
      this.lastVerificationCriteria = strategy.verificationCriteria;

      // Track reasoning history for consistency checks (bounded ring buffer)
      this.reasoningHistory.push(strategy.thought);
      const maxHistory = LITE_ENGINE_FLAGS.criticReasoningHistorySize;
      if (this.reasoningHistory.length > maxHistory) {
        this.reasoningHistory = this.reasoningHistory.slice(-maxHistory);
      }

      // Handle done/blocked from Strategist
      if (strategy.done) {
        this.metrics.multiAgentSuccessCount++;
        this.metrics.totalObserverMs += observerMs;
        this.metrics.totalStrategistMs += strategistMs;
        this.metrics.totalPipelineMs += Date.now() - totalStart;
        if (observerCacheHit) this.metrics.observerCacheHits++;
        else this.metrics.observerCacheMisses++;
        this.metrics.criticSkippedCount++;
        return {
          success: true,
          decision: {
            thought: strategy.thought,
            command: { action: 'wait' },
            done: true,
            analysis: {
              pageState: observation.pageType,
              availableActions: observation.availableActions,
              obstacles: observation.obstacles,
            },
          },
          debug: {
            observerCacheHit,
            actorDeterministic: false,
            observerMs,
            strategistMs,
            actorMs: 0,
            criticMs: 0,
            totalMs: Date.now() - totalStart,
            criticVerdict: 'skipped',
          },
        };
      }

      if (strategy.blockedInfo) {
        this.metrics.multiAgentSuccessCount++;
        this.metrics.totalObserverMs += observerMs;
        this.metrics.totalStrategistMs += strategistMs;
        this.metrics.totalPipelineMs += Date.now() - totalStart;
        if (observerCacheHit) this.metrics.observerCacheHits++;
        else this.metrics.observerCacheMisses++;
        this.metrics.criticSkippedCount++;
        return {
          success: true,
          decision: {
            thought: strategy.thought,
            command: { action: 'wait' },
            blockedInfo: strategy.blockedInfo,
            analysis: {
              pageState: observation.pageType,
              availableActions: observation.availableActions,
              obstacles: observation.obstacles,
            },
          },
          debug: {
            observerCacheHit,
            actorDeterministic: false,
            observerMs,
            strategistMs,
            actorMs: 0,
            criticMs: 0,
            totalMs: Date.now() - totalStart,
            criticVerdict: 'skipped',
          },
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 3: Actor — "Which element exactly?"
      // Manus-style Branching: Try primary strategy, then alternatives
      // ═══════════════════════════════════════════════════════════════════════
      const actorStart = Date.now();

      // Build hypothesis tree: primary strategy + alternatives
      const hypotheses = [strategy.strategy, ...strategy.alternatives];
      let action = null;
      let usedHypothesisIndex = 0;

      for (let h = 0; h < hypotheses.length; h++) {
        const hypothesis = hypotheses[h];
        action = await ActorAgent.act({
          strategy: hypothesis,
          relevantElements: input.snapshotElements,
          formAnalysis: observation.formAnalysis,
          goal: input.goal,
          hasCredentials: input.hasCredentials,
        });

        if (action) {
          usedHypothesisIndex = h;
          if (h > 0) {
            logger.info('[MULTI_AGENT] Primary strategy failed Actor, used alternative', {
              alternativeIndex: h,
              strategy: hypothesis.slice(0, 60),
            });
          }
          break;
        }

        logger.debug('[MULTI_AGENT] Hypothesis failed Actor', {
          hypothesisIndex: h,
          strategy: hypothesis.slice(0, 60),
        });
      }

      if (!action) {
        logger.warn('[MULTI_AGENT] All hypotheses failed Actor, falling back to monolithic');
        this.metrics.monolithicFallbackCount++;
        return { success: false };
      }
      actorMs = Date.now() - actorStart;

      // Check if actor used deterministic path (very fast = likely deterministic)
      actorDeterministic = actorMs < 50;

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 4: Critic — "Should we really do this?" (Manus Red Teaming)
      // Independent audit: does NOT see Strategist's reasoning
      // ═══════════════════════════════════════════════════════════════════════
      let policyViolationCount = 0;

      if (LITE_ENGINE_FLAGS.enableCriticAgent) {
        const criticStart = Date.now();

        const verdict = await CriticAgent.critique({
          proposedCommand: action.command,
          actorReasoning: action.reasoning,
          goal: input.goal,
          availableElements: input.snapshotElements,
          observation,
          currentUrl: input.url,
          hasCredentials: input.hasCredentials,
          formAnalysis: observation.formAnalysis,
          reasoningHistory: this.reasoningHistory.slice(0, -1), // Exclude current (already in strategistThought)
          iteration: input.iteration,
          strategistThought: strategy.thought,
        });

        criticMs = Date.now() - criticStart;

        if (verdict) {
          criticVerdict = verdict.verdict;
          policyViolationCount = verdict.policyViolations.length;

          if (verdict.verdict === 'reject') {
            logger.warn('[MULTI_AGENT] Critic rejected action', {
              risk: verdict.riskAssessment.slice(0, 80),
              failureRisk: verdict.failureRisk.slice(0, 80),
              policyViolations: policyViolationCount,
              inconsistencies: verdict.reasoningInconsistencies.length,
            });

            // Try next alternative hypothesis if available
            // Re-run deterministic security checks on fallback (skip AI to avoid latency)
            let fallbackAction = null;
            for (let h = usedHypothesisIndex + 1; h < hypotheses.length; h++) {
              const candidate = await ActorAgent.act({
                strategy: hypotheses[h],
                relevantElements: input.snapshotElements,
                formAnalysis: observation.formAnalysis,
                goal: input.goal,
                hasCredentials: input.hasCredentials,
              });
              if (candidate) {
                // Quick deterministic safety check on the fallback (no AI call)
                const fallbackSafe = CriticAgent.quickSafetyCheck({
                  proposedCommand: candidate.command,
                  actorReasoning: candidate.reasoning,
                  goal: input.goal,
                  availableElements: input.snapshotElements,
                  observation,
                  currentUrl: input.url,
                  hasCredentials: input.hasCredentials,
                  formAnalysis: observation.formAnalysis,
                  iteration: input.iteration,
                  strategistThought: strategy.thought,
                });
                if (fallbackSafe) {
                  usedHypothesisIndex = h;
                  action = candidate;
                  fallbackAction = candidate;
                  logger.info('[MULTI_AGENT] Critic rejection → used alternative', {
                    alternativeIndex: h,
                  });
                  criticVerdict = 'approve';
                  break;
                } else {
                  logger.debug('[MULTI_AGENT] Alternative also failed safety check', { h });
                }
              }
            }

            if (!fallbackAction) {
              logger.warn('[MULTI_AGENT] Critic rejected and no safe alternatives, falling back to monolithic');
              this.metrics.monolithicFallbackCount++;
              this.metrics.criticRejectCount++;
              this.metrics.policyViolationCount += policyViolationCount;
              return { success: false };
            }
          } else if (verdict.verdict === 'override' && verdict.suggestedAction) {
            logger.info('[MULTI_AGENT] Critic override suggestion', {
              suggestion: verdict.suggestedAction.slice(0, 80),
            });
            // Log the override suggestion but don't act on it — Critic AI suggestions
            // are advisory. The Actor's deterministic/AI-chosen element is more reliable
            // than the Critic's text-based suggestion which can't be parsed to a command.
            // Override is used for logging/tracing only.
          }

          // Log inconsistencies for debugging
          if (verdict.reasoningInconsistencies.length > 0) {
            logger.warn('[MULTI_AGENT] Reasoning inconsistencies detected', {
              count: verdict.reasoningInconsistencies.length,
              first: verdict.reasoningInconsistencies[0].description,
            });
          }
        }
      }

      const totalMs = Date.now() - totalStart;
      const finalStrategy = hypotheses[usedHypothesisIndex];

      // Accumulate run-level metrics
      this.metrics.multiAgentSuccessCount++;
      this.metrics.totalObserverMs += observerMs;
      this.metrics.totalStrategistMs += strategistMs;
      this.metrics.totalActorMs += actorMs;
      this.metrics.totalCriticMs += criticMs;
      this.metrics.totalPipelineMs += totalMs;
      if (observerCacheHit) this.metrics.observerCacheHits++;
      else this.metrics.observerCacheMisses++;
      if (actorDeterministic) this.metrics.actorDeterministicCount++;
      if (usedHypothesisIndex > 0) this.metrics.alternativeUsedCount++;
      this.metrics.policyViolationCount += policyViolationCount;

      // Critic verdict counts
      switch (criticVerdict) {
        case 'approve': this.metrics.criticApproveCount++; break;
        case 'reject': this.metrics.criticRejectCount++; break;
        case 'override': this.metrics.criticOverrideCount++; break;
        case 'skipped': this.metrics.criticSkippedCount++; break;
      }

      logger.info('[MULTI_AGENT] Pipeline complete', {
        observerCacheHit,
        actorDeterministic,
        criticVerdict,
        observerMs,
        strategistMs,
        actorMs,
        criticMs,
        totalMs,
        strategy: finalStrategy.slice(0, 50),
        action: action.command.action,
        ref: action.command.ref,
        usedAlternative: usedHypothesisIndex > 0,
      });

      return {
        success: true,
        decision: {
          thought: `[Strategy: ${finalStrategy}] ${strategy.thought}`,
          command: action.command,
          analysis: {
            pageState: observation.pageType,
            availableActions: observation.availableActions,
            obstacles: observation.obstacles,
          },
        },
        expectedOutcome: strategy.expectedOutcome,
        verificationCriteria: strategy.verificationCriteria,
        debug: {
          observerCacheHit,
          actorDeterministic,
          observerMs,
          strategistMs,
          actorMs,
          criticMs,
          totalMs,
          usedAlternative: usedHypothesisIndex > 0,
          alternativeIndex: usedHypothesisIndex > 0 ? usedHypothesisIndex : undefined,
          criticVerdict,
          policyViolations: policyViolationCount > 0 ? policyViolationCount : undefined,
        },
      };
    } catch (error) {
      logger.error('[MULTI_AGENT] Pipeline error, falling back to monolithic', {
        error: error instanceof Error ? error.message : String(error),
        elapsed: Date.now() - totalStart,
      });
      this.metrics.monolithicFallbackCount++;
      return { success: false };
    }
  }

  /** Get accumulated run-level metrics with computed averages */
  getRunMetrics(): MultiAgentRunMetrics {
    const m = this.metrics;
    const totalCacheAttempts = m.observerCacheHits + m.observerCacheMisses;
    return {
      ...m,
      avgPipelineMs: m.multiAgentSuccessCount > 0
        ? Math.round(m.totalPipelineMs / m.multiAgentSuccessCount)
        : 0,
      observerCacheHitRate: totalCacheAttempts > 0
        ? Math.round((m.observerCacheHits / totalCacheAttempts) * 100) / 100
        : 0,
      multiAgentSuccessRate: m.totalIterations > 0
        ? Math.round((m.multiAgentSuccessCount / m.totalIterations) * 100) / 100
        : 0,
    };
  }

  /**
   * Invalidate observer cache on state change
   * Called after state_changed outcome, URL change, or modal dismiss
   */
  invalidateCache(url: string): void {
    this.observerCache.invalidateForUrl(url);
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.observerCache.clear();
  }
}
