/**
 * Multi-Agent Orchestrator (Manus Architecture — Cognitive Enhancement)
 * Coordinates Observer → Strategist → Actor → Critic pipeline.
 * Falls back gracefully — if any agent fails, returns { success: false }
 * so the caller can use the existing monolithic prompt.
 *
 * Manus enhancements:
 * - Branching & Backtracking: Tries alternatives when primary strategy fails Actor
 * - Critic (Phase 4): Red Teaming + Security Policy + Reasoning Consistency
 * - Expectation Loop: Stores expectedOutcome for next iteration validation
 * - Reasoning History: Tracks strategy thoughts for consistency checking
 *
 * Cognitive enhancements:
 * - Working Memory: Structured form progress, accomplishments, visited pages across iterations
 * - Structured Strategy: Typed action interface replaces free-form text between agents
 * - Adaptive Circuit Breaker: Auto-disable multi-agent on sustained failure rate
 * - Critic Override: Structured override commands are applied, not just logged
 * - Context Preservation: Accumulated knowledge passed to monolithic fallback
 * - Validated Alternatives: Pre-validate alternatives for semantic diversity before branching
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { ActorAgent } from './actor-agent';
import { CriticAgent } from './critic-agent';
import { ObserverCache } from './observer-cache';
import { ObserverAgent } from './observer-agent';
import { StrategistAgent } from './strategist-agent';
import type {
  AccumulatedContext,
  MultiAgentInput,
  MultiAgentResult,
  MultiAgentRunMetrics,
  ObserverOutput,
  StrategyAction,
  WorkingMemory,
} from './types';

export class MultiAgentOrchestrator {
  private observerCache: ObserverCache;
  /** Manus-style: Store last expectedOutcome for next iteration's expectation validation */
  private lastExpectedOutcome: string | undefined;
  /** Manus-style: Store last verificationCriteria for concrete success checking */
  private lastVerificationCriteria: string | undefined;
  /** Manus-style: Rolling reasoning history for consistency checks (bounded) */
  private reasoningHistory: string[] = [];
  /** Sliding window of last 3 strategy confidence scores */
  private confidenceHistory: number[] = [];
  /** Consecutive critic rejection counter (resets on approve) */
  private consecutiveCriticRejections = 0;
  /** Consecutive expectation mismatch counter */
  private consecutiveExpectationMisses = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // Cognitive: Working Memory
  // ═══════════════════════════════════════════════════════════════════════════
  private workingMemory: WorkingMemory = {
    formProgress: {},
    successfulActions: [],
    accomplishments: [],
    visitedPages: {},
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Cognitive: Circuit Breaker
  // ═══════════════════════════════════════════════════════════════════════════
  private circuitState: 'closed' | 'open' | 'half-open' = 'closed';
  private recentResults: boolean[] = [];

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
    circuitBreakerSkipCount: 0,
    criticLowRiskSkipCount: 0,
    criticOverrideAppliedCount: 0,
    reStrategizeCount: 0,
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

  /** Get accumulated context for monolithic fallback — don't lose knowledge */
  getAccumulatedContext(): AccumulatedContext | undefined {
    if (!LITE_ENGINE_FLAGS.preserveContextOnFallback) return undefined;

    const formEntries = Object.entries(this.workingMemory.formProgress);
    const formProgress = formEntries.length > 0
      ? formEntries.map(([ref, status]) => `${ref}[${status}]`).join(', ')
      : undefined;

    return {
      formProgress,
      recentInsights: this.reasoningHistory.slice(-2),
      lastExpectedOutcome: this.lastExpectedOutcome,
      accomplishments: this.workingMemory.accomplishments.slice(-3),
    };
  }

  /** Get consecutive critic rejection count for stuck detection */
  getConsecutiveCriticRejections(): number {
    return this.consecutiveCriticRejections;
  }

  /**
   * Execute the full Observer → Strategist → Actor → Critic pipeline
   * Cognitive: Circuit breaker, working memory, structured strategy, validated alternatives
   * Returns { success: false } if all branches fail (caller should fall through to monolithic)
   */
  async execute(input: MultiAgentInput): Promise<MultiAgentResult> {
    this.metrics.totalIterations++;

    // ═══════════════════════════════════════════════════════════════════════
    // Cognitive: Circuit Breaker — skip if failure rate too high
    // ═══════════════════════════════════════════════════════════════════════
    if (LITE_ENGINE_FLAGS.enableCircuitBreaker && this.circuitState === 'open') {
      if (this.metrics.totalIterations % LITE_ENGINE_FLAGS.circuitBreakerRetryInterval === 0) {
        this.circuitState = 'half-open';
        logger.info('[MULTI_AGENT] Circuit breaker half-open, retrying');
      } else {
        this.metrics.circuitBreakerSkipCount++;
        this.metrics.monolithicFallbackCount++;
        return { success: false, debug: { observerCacheHit: false, actorDeterministic: false, observerMs: 0, strategistMs: 0, actorMs: 0, criticMs: 0, totalMs: 0, circuitBreakerSkipped: true } };
      }
    }

    const totalStart = Date.now();
    let observerMs = 0;
    let strategistMs = 0;
    let actorMs = 0;
    let criticMs = 0;
    let observerCacheHit = false;
    let actorDeterministic = false;
    let criticVerdict: 'approve' | 'reject' | 'override' | 'skipped' = 'skipped';
    let criticSkippedLowRisk = false;
    let criticOverrideApplied = false;
    let reStrategized = false;

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
          hasCredentials: input.hasCredentials,
          goal: input.goal,
          // Manus-style enhancements
          previousSnapshot: input.previousSnapshot,
          networkActivity: input.networkActivity,
          lastExpectation: input.lastExpectation,
          lastAction: input.lastAction,
          // Manus parity: transient state, metadata, page structure
          transientState: input.transientState,
          pageMetadata: input.pageMetadata,
          pageStructure: input.pageStructure,
        });

        if (!observation) {
          logger.warn('[MULTI_AGENT] Observer failed, falling back to monolithic');
          this.recordCircuitBreakerResult(false);
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
      // Cognitive: Update Working Memory from Observer
      // ═══════════════════════════════════════════════════════════════════════
      if (LITE_ENGINE_FLAGS.enableWorkingMemory) {
        this.updateWorkingMemoryFromObserver(observation, input.url, input.iteration);
      }

      // Track expectation mismatches (predictions that were wrong)
      if (observation.expectationDiff && !observation.expectationDiff.met) {
        this.consecutiveExpectationMisses++;
        if (LITE_ENGINE_FLAGS.enableWorkingMemory) {
          this.workingMemory.consecutiveExpectationMisses = this.consecutiveExpectationMisses;
          this.workingMemory.lastExpectationMismatch = observation.expectationDiff.mismatch || observation.expectationDiff.actual;
        }
      } else if (!observation.expectationDiff || observation.expectationDiff.met) {
        // Reset on met expectation OR when no expectation was tracked (normal iterations)
        this.consecutiveExpectationMisses = 0;
        if (LITE_ENGINE_FLAGS.enableWorkingMemory) {
          this.workingMemory.consecutiveExpectationMisses = 0;
          this.workingMemory.lastExpectationMismatch = undefined;
        }
      }

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
        workingMemory: LITE_ENGINE_FLAGS.enableWorkingMemory ? this.workingMemory : undefined,
        hasCredentials: input.hasCredentials,
        currentUrl: input.url,
        // Manus parity: Observer analysis results
        tableContext: observation.tableAnalysis,
        listContext: observation.listAnalysis,
        loadingContext: observation.loadingState,
        overlapContext: observation.overlapInfo,
        // Manus gaps: confidence trend for declining-strategy warning
        confidenceTrend: this.confidenceHistory.length >= 2 &&
          this.confidenceHistory.slice(-2).every(c => c < 0.4) ? 'declining' : 'stable',
      });

      if (!strategy) {
        logger.warn('[MULTI_AGENT] Strategist failed, falling back to monolithic');
        this.recordCircuitBreakerResult(false);
        this.metrics.monolithicFallbackCount++;
        return { success: false };
      }
      strategistMs = Date.now() - strategistStart;

      // Store expectedOutcome for next iteration's expectation validation
      this.lastExpectedOutcome = strategy.expectedOutcome;
      this.lastVerificationCriteria = strategy.verificationCriteria;

      // Track confidence trend (sliding window of last 3)
      this.confidenceHistory.push(strategy.confidence);
      if (this.confidenceHistory.length > 3) {
        this.confidenceHistory = this.confidenceHistory.slice(-3);
      }

      // Store subGoal in working memory
      if (LITE_ENGINE_FLAGS.enableWorkingMemory && strategy.subGoal) {
        this.workingMemory.currentSubGoal = strategy.subGoal;
      }

      // Track reasoning history for consistency checks (bounded ring buffer)
      this.reasoningHistory.push(strategy.thought);
      const maxHistory = LITE_ENGINE_FLAGS.criticReasoningHistorySize;
      if (this.reasoningHistory.length > maxHistory) {
        this.reasoningHistory = this.reasoningHistory.slice(-maxHistory);
      }

      // Handle done/blocked from Strategist
      if (strategy.done) {
        this.recordCircuitBreakerResult(true);
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
        this.recordCircuitBreakerResult(true);
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
      // Cognitive: Pass structured strategy for direct resolution
      // Manus: Branching with validated alternatives
      // ═══════════════════════════════════════════════════════════════════════
      const actorStart = Date.now();

      // Build hypothesis tree: primary strategy + alternatives
      const hypotheses = [strategy.strategy, ...strategy.alternatives];

      // Cognitive: Validate alternatives before branching — filter duplicates and non-existent refs
      // Use index-preserving map so structured alternatives stay aligned with text alternatives
      const structuredAlts = strategy.structuredAlternatives;
      const structuredAltByIndex = new Map<number, { action: StrategyAction; confidence: number }>();
      if (LITE_ENGINE_FLAGS.enableValidatedAlternatives && structuredAlts && strategy.structuredStrategy) {
        const primaryStrategy = strategy.structuredStrategy; // Local ref for safe access inside loop
        for (let i = 0; i < structuredAlts.length; i++) {
          const alt = structuredAlts[i];
          // Alternative must NOT target same ref as primary (semantic diversity)
          if (alt.action.targetRef && alt.action.targetRef === primaryStrategy.targetRef) {
            continue;
          }
          // Alternative ref must exist in page elements (if specified) — word-boundary match to avoid e5 matching e50
          if (alt.action.targetRef) {
            const altRefPattern = new RegExp(`\\b${alt.action.targetRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (!altRefPattern.test(input.snapshotElements)) {
              continue;
            }
          }
          // Action-type diversity: skip duplicate actionType if we already have a diverse alternative
          if (structuredAlts.length > 1 && alt.action.actionType === primaryStrategy.actionType) {
            const hasDiverseAlt = [...structuredAltByIndex.values()].some(
              existing => existing.action.actionType !== primaryStrategy.actionType
            );
            if (hasDiverseAlt) continue;
          }
          structuredAltByIndex.set(i, alt);
        }
      } else if (structuredAlts) {
        // No validation — pass through all
        for (let i = 0; i < structuredAlts.length; i++) {
          structuredAltByIndex.set(i, structuredAlts[i]);
        }
      }

      let action = null;
      let usedHypothesisIndex = 0;

      for (let h = 0; h < hypotheses.length; h++) {
        const hypothesis = hypotheses[h];

        // Cognitive: Deterministic precondition filtering for alternatives (skip primary h=0)
        if (h > 0 && LITE_ENGINE_FLAGS.enableHypothesisPreconditions) {
          const alt = structuredAltByIndex.get(h - 1);
          if (alt) {
            // Confidence check (available on the wrapper, not inside StrategyAction)
            if (!input.isStuck && alt.confidence < 0.3) {
              logger.debug('[MULTI_AGENT] Hypothesis skipped: low confidence', { h, confidence: alt.confidence });
              continue;
            }
            if (!this.evaluateAlternativePreconditions(alt.action, observation, input)) {
              logger.debug('[MULTI_AGENT] Hypothesis skipped: preconditions not met', {
                h,
                actionType: alt.action.actionType,
                target: alt.action.target?.slice(0, 30),
              });
              continue;
            }
          }
        }

        // Cognitive: Pass structured strategy for primary (h=0), structured alternatives for others
        // h-1 maps to the alternative index in structuredAlternatives (parallel with strategy.alternatives)
        const structuredForThisHypothesis = h === 0
          ? (LITE_ENGINE_FLAGS.enableStructuredStrategy ? strategy.structuredStrategy : undefined)
          : (LITE_ENGINE_FLAGS.enableStructuredStrategy && structuredAltByIndex.get(h - 1)?.action);

        action = await ActorAgent.act({
          strategy: hypothesis,
          structuredStrategy: structuredForThisHypothesis || undefined,
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
        this.recordCircuitBreakerResult(false);
        this.metrics.monolithicFallbackCount++;
        return { success: false };
      }
      actorMs = Date.now() - actorStart;

      // Check if actor used deterministic path (explicit flag from Actor, not timing heuristic)
      actorDeterministic = action.deterministic === true;

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 4: Critic — "Should we really do this?" (Manus Red Teaming)
      // Cognitive: Skip for low-risk deterministic actions, apply structured overrides
      // ═══════════════════════════════════════════════════════════════════════
      let policyViolationCount = 0;

      // Cognitive: Skip critic for low-risk deterministic actions
      const shouldSkipCritic = LITE_ENGINE_FLAGS.criticSkipForLowRisk
        && actorDeterministic
        && strategy.confidence >= 0.9
        && strategy.riskLevel === 'low';

      if (LITE_ENGINE_FLAGS.enableCriticAgent && !shouldSkipCritic) {
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
          visionConflicts: input.visionHints?.conflicts,
          // Manus parity: loading and overlap context
          isPageLoading: observation.loadingState?.isLoading,
          coveredElements: (observation.overlapInfo || []).map(o => o.coveredRef),
        });

        criticMs = Date.now() - criticStart;

        if (verdict) {
          criticVerdict = verdict.verdict;
          policyViolationCount = verdict.policyViolations.length;

          if (verdict.verdict === 'reject') {
            this.consecutiveCriticRejections++;
            logger.warn('[MULTI_AGENT] Critic rejected action', {
              risk: verdict.riskAssessment.slice(0, 80),
              failureRisk: verdict.failureRisk.slice(0, 80),
              policyViolations: policyViolationCount,
              inconsistencies: verdict.reasoningInconsistencies.length,
              consecutiveRejections: this.consecutiveCriticRejections,
            });

            // Cognitive: Record critic rejection in working memory for cross-ref pattern avoidance
            if (LITE_ENGINE_FLAGS.enableCriticRejectionMemory && LITE_ENGINE_FLAGS.enableWorkingMemory) {
              this.workingMemory.criticRejections ??= [];
              this.workingMemory.criticRejections.push({
                iteration: input.iteration,
                action: action.command.action,
                ref: action.command.ref,
                reason: verdict.failureRisk || verdict.riskAssessment || 'Critic rejected',
                riskAssessment: verdict.riskAssessment,
              });
              const maxRejections = LITE_ENGINE_FLAGS.criticRejectionMemorySize;
              if (this.workingMemory.criticRejections.length > maxRejections) {
                this.workingMemory.criticRejections = this.workingMemory.criticRejections.slice(-maxRejections);
              }
            }

            // Try next alternative hypothesis if available
            // Re-run deterministic security checks on fallback (skip AI to avoid latency)
            let fallbackAction = null;
            for (let h = usedHypothesisIndex + 1; h < hypotheses.length; h++) {
              // Pass structured alternative if available (same as primary hypothesis loop)
              const fallbackStructured = LITE_ENGINE_FLAGS.enableStructuredStrategy
                ? structuredAltByIndex.get(h - 1)?.action
                : undefined;
              const candidate = await ActorAgent.act({
                strategy: hypotheses[h],
                structuredStrategy: fallbackStructured || undefined,
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
                  visionConflicts: input.visionHints?.conflicts,
                  isPageLoading: observation.loadingState?.isLoading,
                  coveredElements: (observation.overlapInfo || []).map(o => o.coveredRef),
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
              // ═══════════════════════════════════════════════════════════════
              // Cognitive: Re-Strategize on Rejection (one attempt, no loops)
              // Middle path between "try alternatives" and "bail to monolithic"
              // ═══════════════════════════════════════════════════════════════
              if (LITE_ENGINE_FLAGS.enableReStrategizeOnReject) {
                logger.info('[MULTI_AGENT] Re-strategizing after critic rejection');
                this.metrics.reStrategizeCount++;

                const reStrategistStart = Date.now();
                const reStrategy = await StrategistAgent.strategize({
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
                  workingMemory: LITE_ENGINE_FLAGS.enableWorkingMemory ? this.workingMemory : undefined,
                  criticFeedback: `${verdict.riskAssessment}. ${verdict.failureRisk}`,
                  hasCredentials: input.hasCredentials,
                  currentUrl: input.url,
                  // Manus parity: Observer analysis results
                  tableContext: observation.tableAnalysis,
                  listContext: observation.listAnalysis,
                  loadingContext: observation.loadingState,
                  overlapContext: observation.overlapInfo,
                  // Manus gaps: confidence trend
                  confidenceTrend: this.confidenceHistory.length >= 2 &&
                    this.confidenceHistory.slice(-2).every(c => c < 0.4) ? 'declining' : 'stable',
                });
                strategistMs += Date.now() - reStrategistStart;

                if (reStrategy && !reStrategy.done && !reStrategy.blockedInfo) {
                  const reActorStart = Date.now();
                  const reStructured = LITE_ENGINE_FLAGS.enableStructuredStrategy
                    ? reStrategy.structuredStrategy
                    : undefined;
                  const reAction = await ActorAgent.act({
                    strategy: reStrategy.strategy,
                    structuredStrategy: reStructured || undefined,
                    relevantElements: input.snapshotElements,
                    formAnalysis: observation.formAnalysis,
                    goal: input.goal,
                    hasCredentials: input.hasCredentials,
                  });
                  actorMs += Date.now() - reActorStart;

                  if (reAction) {
                    // Quick deterministic safety check on the re-strategized action
                    const reSafe = CriticAgent.quickSafetyCheck({
                      proposedCommand: reAction.command,
                      actorReasoning: reAction.reasoning,
                      goal: input.goal,
                      availableElements: input.snapshotElements,
                      observation,
                      currentUrl: input.url,
                      hasCredentials: input.hasCredentials,
                      formAnalysis: observation.formAnalysis,
                      iteration: input.iteration,
                      strategistThought: reStrategy.thought,
                      visionConflicts: input.visionHints?.conflicts,
                      isPageLoading: observation.loadingState?.isLoading,
                      coveredElements: (observation.overlapInfo || []).map(o => o.coveredRef),
                    });

                    if (reSafe) {
                      action = reAction;
                      criticVerdict = 'approve';
                      reStrategized = true;
                      this.lastExpectedOutcome = reStrategy.expectedOutcome;
                      this.lastVerificationCriteria = reStrategy.verificationCriteria;

                      // Update reasoning history
                      this.reasoningHistory.push(reStrategy.thought);
                      if (this.reasoningHistory.length > LITE_ENGINE_FLAGS.criticReasoningHistorySize) {
                        this.reasoningHistory = this.reasoningHistory.slice(-LITE_ENGINE_FLAGS.criticReasoningHistorySize);
                      }

                      // Track re-strategy confidence in trend history
                      this.confidenceHistory.push(reStrategy.confidence);
                      if (this.confidenceHistory.length > 3) {
                        this.confidenceHistory = this.confidenceHistory.slice(-3);
                      }

                      logger.info('[MULTI_AGENT] Re-strategize succeeded', {
                        strategy: reStrategy.strategy.slice(0, 60),
                        action: reAction.command.action,
                        ref: reAction.command.ref,
                      });
                    }
                  }
                }
              }

              // If re-strategize was not attempted or did not produce a safe action, fall back
              if (criticVerdict !== 'approve') {
                logger.warn('[MULTI_AGENT] Critic rejected and no safe alternatives (including re-strategize), falling back to monolithic');
                // Record failed action in working memory
                if (LITE_ENGINE_FLAGS.enableWorkingMemory && action?.command?.ref && action.command.action === 'fill') {
                  this.workingMemory.formProgress[action.command.ref] = 'failed';
                }
                this.recordCircuitBreakerResult(false);
                this.metrics.monolithicFallbackCount++;
                this.metrics.criticRejectCount++;
                this.metrics.policyViolationCount += policyViolationCount;
                return {
                  success: false,
                  rejectedAction: action?.command?.ref ? {
                    action: action.command.action,
                    ref: action.command.ref,
                    elementHint: action.reasoning?.slice(0, 60) || action.command.ref,
                    reason: verdict.failureRisk || verdict.riskAssessment || 'Critic rejected',
                  } : undefined,
                };
              }
            }
          } else if (verdict.verdict === 'override') {
            // Cognitive: Apply structured override if available and valid
            const VALID_ACTIONS = new Set(['click', 'fill', 'press', 'goto', 'scroll', 'select', 'hover', 'wait']);
            if (LITE_ENGINE_FLAGS.enableCriticOverride && verdict.structuredOverride?.ref) {
              const overrideRef = verdict.structuredOverride.ref;
              const overrideAction = verdict.structuredOverride.action;
              // Validate action type at runtime (AI output can be anything)
              if (!VALID_ACTIONS.has(overrideAction)) {
                logger.debug('[MULTI_AGENT] Critic override has invalid action type, ignoring', {
                  action: overrideAction,
                });
              } else {
                // Validate that override ref actually exists on the page
                const refPattern = new RegExp(`\\b${overrideRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                if (refPattern.test(input.snapshotElements)) {
                  action = {
                    command: {
                      action: overrideAction as 'click' | 'fill' | 'press' | 'goto' | 'scroll' | 'select' | 'hover' | 'wait',
                      ref: overrideRef,
                      value: verdict.structuredOverride.value,
                    },
                    reasoning: `Critic override: ${verdict.suggestedAction || 'alternative element selected'}`,
                  };
                  criticOverrideApplied = true;
                  actorDeterministic = false; // Override came from AI critic, not deterministic
                  this.metrics.criticOverrideAppliedCount++;
                  logger.info('[MULTI_AGENT] Critic override applied', {
                    ref: overrideRef,
                    action: overrideAction,
                  });
                } else {
                  // Override ref invalid — treat as approve with warning
                  logger.debug('[MULTI_AGENT] Critic override ref not found, proceeding with Actor choice', {
                    overrideRef,
                  });
                  criticVerdict = 'approve';
                }
              }
            } else if (verdict.suggestedAction) {
              // Legacy: Log text-based override suggestion (advisory only)
              logger.info('[MULTI_AGENT] Critic override suggestion (advisory)', {
                suggestion: verdict.suggestedAction.slice(0, 80),
              });
            }
          }

          // Log inconsistencies for debugging
          if (verdict.reasoningInconsistencies.length > 0) {
            logger.warn('[MULTI_AGENT] Reasoning inconsistencies detected', {
              count: verdict.reasoningInconsistencies.length,
              first: verdict.reasoningInconsistencies[0].description,
            });
          }
        }
      } else if (shouldSkipCritic) {
        criticSkippedLowRisk = true;
        this.metrics.criticLowRiskSkipCount++;
        this.metrics.criticSkippedCount++;
        this.consecutiveCriticRejections = 0;
        logger.debug('[MULTI_AGENT] Critic skipped: low-risk deterministic action', {
          confidence: strategy.confidence,
          riskLevel: strategy.riskLevel,
        });
      }

      // Reset consecutive critic rejections on successful pipeline completion
      if (criticVerdict === 'approve' || criticVerdict === 'override' || criticVerdict === 'skipped') {
        this.consecutiveCriticRejections = 0;
      }

      const totalMs = Date.now() - totalStart;
      const finalStrategy = hypotheses[usedHypothesisIndex];

      // ═══════════════════════════════════════════════════════════════════════
      // Cognitive: Update Working Memory from successful action
      // ═══════════════════════════════════════════════════════════════════════
      if (LITE_ENGINE_FLAGS.enableWorkingMemory) {
        this.updateWorkingMemoryFromAction(action.command, finalStrategy, input.iteration, action.reasoning);
      }

      // Record circuit breaker result
      this.recordCircuitBreakerResult(true);

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
        criticSkippedLowRisk,
        criticOverrideApplied,
        observerMs,
        strategistMs,
        actorMs,
        criticMs,
        totalMs,
        strategy: finalStrategy.slice(0, 50),
        action: action.command.action,
        ref: action.command.ref,
        usedAlternative: usedHypothesisIndex > 0,
        reStrategized,
        circuitState: this.circuitState,
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
          criticSkippedLowRisk: criticSkippedLowRisk || undefined,
          criticOverrideApplied: criticOverrideApplied || undefined,
          reStrategized: reStrategized || undefined,
        },
      };
    } catch (error) {
      logger.error('[MULTI_AGENT] Pipeline error, falling back to monolithic', {
        error: error instanceof Error ? error.message : String(error),
        elapsed: Date.now() - totalStart,
      });
      this.recordCircuitBreakerResult(false);
      this.metrics.monolithicFallbackCount++;
      return { success: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cognitive: Working Memory Management
  // ═══════════════════════════════════════════════════════════════════════════

  /** Update working memory from Observer's form analysis */
  private updateWorkingMemoryFromObserver(observation: ObserverOutput, url: string, iteration: number): void {
    // Track visited pages
    const urlKey = this.normalizeUrl(url);
    const existing = this.workingMemory.visitedPages[urlKey];
    if (existing) {
      existing.visitCount++;
      existing.lastIteration = iteration;
      existing.pageType = observation.pageType;
    } else {
      this.workingMemory.visitedPages[urlKey] = {
        pageType: observation.pageType,
        visitCount: 1,
        lastIteration: iteration,
      };
    }

    // Update form progress from Observer's formAnalysis
    if (observation.formAnalysis) {
      this.workingMemory.lastFormAnalysis = observation.formAnalysis;
      for (const field of observation.formAnalysis.fields) {
        const current = this.workingMemory.formProgress[field.ref];
        if (field.hasValue && current !== 'filled') {
          this.workingMemory.formProgress[field.ref] = 'filled';
        } else if (!field.hasValue && !current) {
          // Field exists but not yet interacted with — don't overwrite 'failed'
        }
      }
    }
  }

  /** Update working memory after a successful action */
  private updateWorkingMemoryFromAction(
    command: { action: string; ref?: string; value?: string },
    strategyDescription: string,
    iteration: number,
    actorReasoning?: string,
  ): void {
    // Record successful action (bounded to last 20)
    if (command.ref) {
      this.workingMemory.successfulActions.push({
        iteration,
        action: command.action,
        ref: command.ref,
        outcome: 'executed',
      });
      if (this.workingMemory.successfulActions.length > 20) {
        this.workingMemory.successfulActions = this.workingMemory.successfulActions.slice(-20);
      }
    }

    // Track accomplishment — use Actor reasoning for element context (e.g., "Clicked Submit button")
    const accomplishment = this.describeAccomplishment(command, strategyDescription, actorReasoning);
    if (accomplishment) {
      this.workingMemory.accomplishments.push(accomplishment);
      if (this.workingMemory.accomplishments.length > 10) {
        this.workingMemory.accomplishments = this.workingMemory.accomplishments.slice(-10);
      }
    }
  }

  /** Generate human-readable accomplishment from action */
  private describeAccomplishment(
    command: { action: string; ref?: string; value?: string },
    strategy: string,
    actorReasoning?: string,
  ): string | undefined {
    // Extract element label from actor reasoning (e.g., 'submit button "Login"', 'field "Email"')
    const elementLabel = actorReasoning ? this.extractElementLabel(actorReasoning) : undefined;
    const refLabel = command.ref
      ? (elementLabel ? `${command.ref} (${elementLabel})` : command.ref)
      : (elementLabel || 'element');

    switch (command.action) {
      case 'fill': return `Filled ${refLabel}`;
      case 'click': return `Clicked ${refLabel}`;
      case 'goto': return `Navigated to new page`;
      case 'select': return `Selected option in ${refLabel}`;
      default: return strategy.length > 60 ? strategy.slice(0, 57) + '...' : strategy;
    }
  }

  /** Extract element label from Actor reasoning (e.g., '"Email" field', 'Submit button') */
  private extractElementLabel(reasoning: string): string | undefined {
    // Match quoted text like "Login", "Email", "Submit" from reasoning
    const quotedMatch = reasoning.match(/"([^"]{1,30})"/);
    if (quotedMatch) return quotedMatch[1];
    // Match "button/field/input/link <name>" patterns
    const labelMatch = reasoning.match(/(?:button|field|input|link|form)\s+["']?([A-Za-z0-9 ]{1,25})["']?/i);
    if (labelMatch) return labelMatch[1].trim();
    return undefined;
  }

  /** Normalize URL for working memory (preserve significant query params) */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Preserve significant query params that change page content (search, filter, page, id)
      // Strip tracking/session params — exact match only to avoid stripping ref_id, sidebar, etc.
      const TRACKING_PARAMS = new Set([
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', '_ga', 'gclid', 'ref', 'source', 'token', 'session', 'sid', 'nonce',
      ]);
      const significantParams = new URLSearchParams();
      for (const [key, value] of parsed.searchParams.entries()) {
        if (!TRACKING_PARAMS.has(key.toLowerCase()) && !key.startsWith('utm_')) {
          significantParams.set(key, value);
        }
      }
      const queryStr = significantParams.toString();
      return `${parsed.origin}${parsed.pathname}${queryStr ? '?' + queryStr : ''}${parsed.hash}`;
    } catch {
      return url;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cognitive: Circuit Breaker
  // ═══════════════════════════════════════════════════════════════════════════

  /** Record pipeline result for circuit breaker sliding window */
  private recordCircuitBreakerResult(success: boolean): void {
    if (!LITE_ENGINE_FLAGS.enableCircuitBreaker) return;

    this.recentResults.push(success);
    const windowSize = LITE_ENGINE_FLAGS.circuitBreakerWindowSize;
    if (this.recentResults.length > windowSize) {
      this.recentResults = this.recentResults.slice(-windowSize);
    }

    // Only evaluate after minimum window
    if (this.recentResults.length < windowSize) return;

    const failRate = this.recentResults.filter(r => !r).length / this.recentResults.length;

    if (this.circuitState === 'half-open') {
      if (success) {
        this.circuitState = 'closed';
        logger.info('[MULTI_AGENT] Circuit breaker closed (recovered)');
      } else {
        this.circuitState = 'open';
        logger.warn('[MULTI_AGENT] Circuit breaker re-opened (half-open test failed)');
      }
    } else if (failRate > LITE_ENGINE_FLAGS.circuitBreakerFailThreshold) {
      this.circuitState = 'open';
      logger.warn('[MULTI_AGENT] Circuit breaker opened', {
        failRate: Math.round(failRate * 100),
        window: this.recentResults.length,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Metrics & Cache Management
  // ═══════════════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Hypothesis Precondition Evaluation (deterministic, <1ms)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate whether an alternative hypothesis should be attempted.
   * Returns false if preconditions are clearly not met — skips the Actor call.
   * Only used for alternatives (h > 0), never for the primary hypothesis.
   */
  private evaluateAlternativePreconditions(
    alt: StrategyAction,
    observation: ObserverOutput,
    input: MultiAgentInput,
  ): boolean {
    // Rule 1: Skip fill if the target field is already filled in working memory
    if (alt.actionType === 'fill' && alt.targetRef) {
      if (this.workingMemory.formProgress[alt.targetRef] === 'filled') {
        return false;
      }
    }

    // Rule 2: Skip if action+ref is in the blacklist (already failed execution)
    if (alt.targetRef && input.failedActions) {
      const isBlacklisted = input.failedActions.some(
        fa => fa.action === alt.actionType && fa.ref === alt.targetRef
      );
      if (isBlacklisted) return false;
    }

    // Rule 3: Skip non-click actions when a modal is blocking the page
    // (modals typically need a click to dismiss before other actions work)
    if (observation.modalInfo && alt.actionType !== 'click' && alt.actionType !== 'wait') {
      return false;
    }

    // Rule 4: Skip non-wait actions when our last action triggered async work
    // (DOM is actively changing from our action — not just background requests)
    if (observation.networkActivity?.asyncWorkTriggered && alt.actionType !== 'wait') {
      return false;
    }

    return true;
  }
}
