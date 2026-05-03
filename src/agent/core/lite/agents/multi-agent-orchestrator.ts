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
import { z } from 'zod';
import { ActorAgent } from './actor-agent';
import { CriticAgent } from './critic-agent';
import { ObserverCache } from './observer-cache';
import { ObserverAgent } from './observer-agent';
import { SafetyInterceptor } from './safety-interceptor';
import { StrategistAgent } from './strategist-agent';
import { SupervisorAgent } from './supervisor-agent';
import type {
  AccumulatedContext,
  MultiAgentInput,
  MultiAgentResult,
  MultiAgentRunMetrics,
  ObserverOutput,
  StrategyAction,
  SupervisorBlackboard,
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
  /** Supervisor agent — Manus Tiered Escalation watchdog */
  private supervisor = new SupervisorAgent();

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
    supervisorRecoveryModeCount: 0,
    supervisorHardBacktrackCount: 0,
    supervisorTier2Count: 0,
    skipPathSafetyBlockCount: 0,
  };

  constructor() {
    this.observerCache = new ObserverCache();

    // Startup sanity check: criticConcerns recording requires working memory
    // to be enabled. If only enableCriticConcernsMemory is on, concerns are
    // silently dropped. Log once at construction so a misconfig is visible
    // in server startup logs instead of silently failing at runtime.
    if (
      LITE_ENGINE_FLAGS.enableCriticConcernsMemory
      && !LITE_ENGINE_FLAGS.enableWorkingMemory
    ) {
      logger.warn(
        '[MULTI_AGENT] Misconfiguration: enableCriticConcernsMemory=true '
          + 'but enableWorkingMemory=false. Critic concerns will NOT be '
          + 'recorded. Either enable working memory or disable the concerns '
          + 'flag to avoid confusion.',
      );
    }
  }

  /** Get last expected outcome for expectation validation loop */
  getLastExpectedOutcome(): string | undefined {
    return this.lastExpectedOutcome;
  }

  /** Get last verification criteria */
  getLastVerificationCriteria(): string | undefined {
    return this.lastVerificationCriteria;
  }

  /** Get circuit breaker state for TimeoutGovernor */
  isCircuitBreakerOpen(): boolean {
    return this.circuitState === 'open';
  }

  /** Get a copy of working memory for TimeoutGovernor narrative */
  getWorkingMemoryCopy(): WorkingMemory {
    return {
      formProgress: { ...this.workingMemory.formProgress },
      successfulActions: [...this.workingMemory.successfulActions],
      accomplishments: [...this.workingMemory.accomplishments],
      visitedPages: { ...this.workingMemory.visitedPages },
    };
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

    // ═══════════════════════════════════════════════════════════════════════
    // Supervisor Layer — Manus Tiered Escalation
    // Tier 1: Deterministic blackboard (<5ms, 0 tokens)
    // Tier 2: AI diagnosis (gemini-2.5-flash-lite) only when stuck 5+ iterations
    // ═══════════════════════════════════════════════════════════════════════
    let blackboard: SupervisorBlackboard | undefined;

    if (LITE_ENGINE_FLAGS.enableSupervisorLayer) {
      // Record previous action's outcome for Tier 2 context (available from engine)
      if (input.lastOutcome) {
        this.supervisor.recordActionOutcome(input.lastOutcome);
      }

      blackboard = this.supervisor.computeBlackboard(input);

      // Hard Backtrack: skip entire pipeline, force navigation to known-good URL
      const backtrackUrl = blackboard.knownGoodUrls[0];
      if (blackboard.hardBacktrack && backtrackUrl) {
        this.metrics.supervisorHardBacktrackCount++;
        return {
          success: true,
          decision: {
            thought: `[SUPERVISOR] Hard backtrack: wrong page for ${blackboard.wrongPageCount} iterations → navigating to ${backtrackUrl}`,
            command: { action: 'goto', url: backtrackUrl },
          },
          debug: {
            observerCacheHit: false,
            actorDeterministic: true,
            observerMs: 0,
            strategistMs: 0,
            actorMs: 0,
            criticMs: 0,
            totalMs: Date.now() - totalStart,
            supervisorHardBacktrack: true,
            supervisorTier: 1,
            supervisorRecoveryMode: true,
          },
        };
      }

      // Tier 2 Nuclear: AI diagnosis when Tier 1 exhausted.
      //
      // PR1B: trigger rework:
      //   - Threshold lowered 5 → 3 (see supervisorMaxInterventions)
      //   - Old `% 3` cooldown removed — it was a rate limiter with no upper
      //     bound, so a deeply stuck run would pay indefinitely for Tier 2.
      //   - New hard cap via supervisorTier2MaxPerRun: once the per-run
      //     budget is exhausted, Tier 2 is disabled for the rest of the run.
      //   - Tier 2 now fires on every intervention past the threshold until
      //     the budget runs out — earlier help, predictable max cost.
      const tier2Eligible = blackboard.recoveryMode
        && blackboard.interventionCount >= LITE_ENGINE_FLAGS.supervisorMaxInterventions
        && LITE_ENGINE_FLAGS.enableSupervisorTier2
        && !this.supervisor.isTier2BudgetExhausted();

      if (tier2Eligible) {
        const diagnosis = await this.supervisor.diagnoseBlocker(input, blackboard);
        if (diagnosis) {
          blackboard.aiDiagnosis = diagnosis.suggestedRecovery;
          blackboard.recoveryTier = 2;
          this.metrics.supervisorTier2Count++;

          // Mandatory Action Override: Tier 2 AI is confident about the exact next step
          // Validate: action type valid + ref exists on page + NOT in forbidden list
          if (diagnosis.mandatoryAction) {
            const ma = diagnosis.mandatoryAction;
            const VALID_ACTIONS = new Set(['click', 'fill', 'press', 'goto', 'scroll', 'select', 'hover', 'wait', 'toggle', 'setRange', 'clear', 'selectDate']);
            const refValid = !ma.ref || (
              input.parsedSnapshot
                ? input.parsedSnapshot.hasRef(ma.ref)
                : new RegExp(`\\b${ma.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(input.snapshotElements)
            );

            // Check against forbidden actions — mandatory actions must NOT repeat failed actions
            const isForbidden = blackboard.forbiddenActions.some(fa =>
              (fa.action === ma.action && fa.ref && fa.ref === ma.ref) ||
              (fa.action === 'goto' && ma.action === 'goto' && fa.url && fa.url === ma.url),
            );

            if (VALID_ACTIONS.has(ma.action) && refValid && !isForbidden) {
              blackboard.mandatoryAction = ma;
              logger.info('[SUPERVISOR] Tier 2: Mandatory action override set', {
                action: ma.action,
                ref: ma.ref,
              });
            } else {
              logger.warn('[SUPERVISOR] Tier 2: Mandatory action rejected', {
                action: ma.action,
                ref: ma.ref,
                refValid,
                isForbidden,
              });
            }
          }
        }
      }

      if (blackboard.recoveryMode) {
        this.metrics.supervisorRecoveryModeCount++;
      }

      // Mandatory Action Override: skip entire pipeline, execute Tier 2's prescribed action
      if (blackboard.mandatoryAction) {
        const ma = blackboard.mandatoryAction;
        this.supervisor.recordAction(ma);
        return {
          success: true,
          decision: {
            thought: `[SUPERVISOR] Tier 2 mandatory override: ${ma.action}${ma.ref ? `(${ma.ref})` : ''}${ma.url ? ` → ${ma.url}` : ''}`,
            command: {
              action: ma.action as any,
              ref: ma.ref,
              value: ma.value,
              url: ma.url,
            },
          },
          debug: {
            observerCacheHit: false,
            actorDeterministic: true,
            observerMs: 0,
            strategistMs: 0,
            actorMs: 0,
            criticMs: 0,
            totalMs: Date.now() - totalStart,
            supervisorRecoveryMode: true,
            supervisorTier: 2,
          },
        };
      }
    }

    // Fire-and-forget thinking step callback — never throws, never blocks
    const think = input.onThinkingStep
      ? (phase: string, message: string) => {
          try { input.onThinkingStep!(phase, message); } catch { /* swallow */ }
        }
      : undefined;

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // Phase 1: Observer — "What do I see?"
      // ═══════════════════════════════════════════════════════════════════════
      think?.('observer', 'Observing page structure...');
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
          // Supervisor: shared recovery context
          blackboard,
          // Layer 2: Obstacle facts for LLM classification
          obstacleFacts: input.obstacleFacts,
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
      // Layer 2 Post-Processing: Validate & merge classifiedObstacles
      // Zod validates LLM output — malformed entries are silently dropped.
      // Makes Strategist aware of ALL obstacles without modifying Strategist code.
      // ═══════════════════════════════════════════════════════════════════════
      if (observation.classifiedObstacles?.length) {
        const ClassifiedObstacleSchema = z.object({
          ref: z.string(),
          type: z.string(),
          isBlocking: z.boolean().default(false),
          isDismissible: z.boolean().default(false),
          dismissStrategy: z.string().optional(),
          affectedArea: z.string().optional(),
          reason: z.string().default(''),
        });

        const validObstacles = observation.classifiedObstacles.filter(o => {
          const result = ClassifiedObstacleSchema.safeParse(o);
          if (!result.success) {
            logger.warn('[MULTI_AGENT] Invalid classifiedObstacle from LLM — dropped', {
              obstacle: o,
              error: result.error.message,
            });
          }
          return result.success;
        });
        observation.classifiedObstacles = validObstacles as typeof observation.classifiedObstacles;
      }

      if (observation.classifiedObstacles?.length) {
        for (const classified of observation.classifiedObstacles) {
          // Add blocking obstacles to the obstacles array
          if (classified.isBlocking) {
            const obstacleMsg = `${classified.type}: ${classified.reason}${classified.dismissStrategy ? ` (dismiss: ${classified.dismissStrategy})` : ''}`;
            if (!observation.obstacles.includes(obstacleMsg)) {
              observation.obstacles.push(obstacleMsg);
            }
          }

          // Set modalInfo if a blocking modal/drawer is classified
          if (classified.isBlocking && (classified.type === 'modal' || classified.type === 'drawer') && !observation.modalInfo) {
            observation.modalInfo = `${classified.reason}${classified.dismissStrategy ? ` — ${classified.dismissStrategy}` : ''}`;
          }
        }

        logger.debug('[MULTI_AGENT] Layer 2 obstacle classification', {
          total: observation.classifiedObstacles.length,
          blocking: observation.classifiedObstacles.filter(o => o.isBlocking).length,
          types: observation.classifiedObstacles.map(o => o.type),
        });
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Layer 2 Post-Processing: Consume pageStateAnalysis
      // Holistic page state → obstacles array for Strategist awareness
      // ═══════════════════════════════════════════════════════════════════════
      if (observation.pageStateAnalysis) {
        if (observation.pageStateAnalysis.isFlowBlocked && observation.pageStateAnalysis.blockReason) {
          observation.obstacles.unshift(`FLOW BLOCKED: ${observation.pageStateAnalysis.blockReason}`);
        }
        if (observation.pageStateAnalysis.isLoading) {
          observation.obstacles.push('Page is in loading state — wait before acting');
        }
      }

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
      const pageType = observation.pageType || 'page';
      const actionsCount = observation.availableActions?.length || 0;
      think?.('strategist', `Observed ${pageType} with ${actionsCount} actions, planning next step...`);
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
        transitionSummary: input.transitionSummary,
        // Manus parity: Observer analysis results
        tableContext: observation.tableAnalysis,
        listContext: observation.listAnalysis,
        loadingContext: observation.loadingState,
        overlapContext: observation.overlapInfo,
        // Manus gaps: confidence trend for declining-strategy warning
        confidenceTrend: this.confidenceHistory.length >= 2 &&
          this.confidenceHistory.slice(-2).every(c => c < 0.4) ? 'declining' : 'stable',
        goalUrl: input.goalUrl,
        // Supervisor: shared recovery context
        blackboard,
        // TimeoutGovernor: time pressure signal
        urgencyLevel: input.urgencyLevel,
        // PR1C: vision escalation signal for SPAs with sparse DOM semantics
        visionRecommendation: input.pageMetadata
          ? {
              isDOMWeak: input.pageMetadata.isDOMWeak,
              recommendVision: input.pageMetadata.recommendVision,
              interactiveElementCount: input.pageMetadata.interactiveElementCount,
            }
          : undefined,
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
      think?.('actor', `Strategy: ${strategy.thought.slice(0, 60)}`);
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
            const altRefExists = input.parsedSnapshot
              ? input.parsedSnapshot.hasRef(alt.action.targetRef)
              : new RegExp(`\\b${alt.action.targetRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(input.snapshotElements);
            if (!altRefExists) {
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
          // Safety check for alternatives (h > 0): verify policy compliance before accepting
          if (h > 0) {
            const isSafe = CriticAgent.quickSafetyCheck({
              proposedCommand: action.command,
              actorReasoning: action.reasoning,
              goal: input.goal,
              availableElements: input.snapshotElements,
              observation,
              currentUrl: input.url,
              hasCredentials: input.hasCredentials,
              formAnalysis: observation.formAnalysis,
              iteration: input.iteration,
              strategistThought: hypothesis,
              visionConflicts: input.visionHints?.conflicts,
              isPageLoading: observation.loadingState?.isLoading,
              coveredElements: (observation.overlapInfo || []).map(o => o.coveredRef),
              blackboard,
              parsedSnapshot: input.parsedSnapshot,
            });
            if (!isSafe) {
              logger.info('[MULTI_AGENT] Alternative blocked by safety check', {
                alternativeIndex: h,
                action: action.command.action,
                ref: action.command.ref,
              });
              action = null;
              continue; // Try next hypothesis
            }
            logger.info('[MULTI_AGENT] Primary strategy failed Actor, used alternative', {
              alternativeIndex: h,
              strategy: hypothesis.slice(0, 60),
            });
          }
          usedHypothesisIndex = h;
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
      think?.('critic', `Checking safety: ${action.command.action}${action.command.ref ? ` on ${action.command.ref}` : ''}...`);
      let policyViolationCount = 0;

      // Cognitive: Skip critic for low-risk deterministic actions OR critical time pressure
      const shouldSkipCritic = (LITE_ENGINE_FLAGS.criticSkipForLowRisk
        && actorDeterministic
        && strategy.confidence >= 0.9
        && strategy.riskLevel === 'low')
        || input.urgencyLevel === 'critical';

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
          // Supervisor: shared recovery context
          blackboard,
          // Layer 3: Last blocker info from previous iteration
          lastBlockerInfo: input.lastBlockerInfo,
          // PR1: O(1) ref existence check
          parsedSnapshot: input.parsedSnapshot,
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
                  blackboard,
                  parsedSnapshot: input.parsedSnapshot,
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
                  transitionSummary: input.transitionSummary,
                  // Manus parity: Observer analysis results
                  tableContext: observation.tableAnalysis,
                  listContext: observation.listAnalysis,
                  loadingContext: observation.loadingState,
                  overlapContext: observation.overlapInfo,
                  // Manus gaps: confidence trend
                  confidenceTrend: this.confidenceHistory.length >= 2 &&
                    this.confidenceHistory.slice(-2).every(c => c < 0.4) ? 'declining' : 'stable',
                  goalUrl: input.goalUrl,
                  // Supervisor: shared recovery context
                  blackboard,
                  // TimeoutGovernor: time pressure signal
                  urgencyLevel: input.urgencyLevel,
                  // PR1C: vision escalation signal
                  visionRecommendation: input.pageMetadata
                    ? {
                        isDOMWeak: input.pageMetadata.isDOMWeak,
                        recommendVision: input.pageMetadata.recommendVision,
                        interactiveElementCount: input.pageMetadata.interactiveElementCount,
                      }
                    : undefined,
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
                      blackboard,
                      parsedSnapshot: input.parsedSnapshot,
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

              // If re-strategize was not attempted or did not produce a safe action, check Supervisor backtrack
              if (criticVerdict !== 'approve') {
                // Supervisor: In recovery mode with critic rejection, backtrack to known-good URL
                const criticBacktrackUrl = blackboard?.knownGoodUrls?.[0];
                if (LITE_ENGINE_FLAGS.enableSupervisorLayer && blackboard?.recoveryMode && criticBacktrackUrl) {
                  this.metrics.supervisorHardBacktrackCount++;
                  logger.info('[SUPERVISOR] Critic rejected in recovery — backtracking', {
                    url: criticBacktrackUrl,
                  });
                  return {
                    success: true,
                    decision: {
                      thought: `[SUPERVISOR] Critic rejected in recovery — backtracking to ${criticBacktrackUrl}`,
                      command: { action: 'goto', url: criticBacktrackUrl },
                    },
                    debug: {
                      observerCacheHit,
                      actorDeterministic: true,
                      observerMs,
                      strategistMs,
                      actorMs,
                      criticMs,
                      totalMs: Date.now() - totalStart,
                      supervisorHardBacktrack: true,
                      supervisorRecoveryMode: true,
                    },
                  };
                }

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
            const VALID_ACTIONS = new Set(['click', 'fill', 'press', 'goto', 'scroll', 'select', 'hover', 'wait', 'toggle', 'setRange', 'clear', 'selectDate']);
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
                const overrideRefExists = input.parsedSnapshot
                  ? input.parsedSnapshot.hasRef(overrideRef)
                  : new RegExp(`\\b${overrideRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(input.snapshotElements);
                if (overrideRefExists) {
                  action = {
                    command: {
                      action: overrideAction as 'click' | 'fill' | 'press' | 'goto' | 'scroll' | 'select' | 'hover' | 'wait' | 'toggle' | 'setRange' | 'clear' | 'selectDate',
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

          // PR1B: Record critic CONCERNS (warn-level violations on APPROVED
          // actions) into working memory. Distinct from criticRejections:
          // these are actions that went through but the Critic flagged
          // something worth remembering. Feeds the next Strategist so it
          // can avoid repeating the same risky pattern.
          //
          // Only records on approve / override — rejection already records
          // via criticRejections above. Reject doesn't double-count here.
          if (
            LITE_ENGINE_FLAGS.enableCriticConcernsMemory
            && LITE_ENGINE_FLAGS.enableWorkingMemory
            && (verdict.verdict === 'approve' || verdict.verdict === 'override')
            && verdict.policyViolations.length > 0
          ) {
            const warnings = verdict.policyViolations.filter(v => v.severity === 'warn');
            if (warnings.length > 0 && action.command.ref) {
              this.workingMemory.criticConcerns ??= [];
              this.workingMemory.criticConcerns.push({
                iteration: input.iteration,
                action: action.command.action,
                ref: action.command.ref,
                concern: (verdict.riskAssessment || warnings[0].description).slice(0, 120),
                violationTypes: warnings.map(w => w.type),
              });
              const maxConcerns = LITE_ENGINE_FLAGS.criticConcernsMemorySize;
              // Guard against misconfiguration: if someone sets memorySize to 0
              // (or a negative number), `length > 0` would stay false forever
              // and the array would grow unbounded. Require a positive cap to
              // apply the trim; otherwise leave the array as-is (callers can
              // either use the default 5 or opt out entirely via the boolean
              // enableCriticConcernsMemory flag).
              if (maxConcerns > 0 && this.workingMemory.criticConcerns.length > maxConcerns) {
                this.workingMemory.criticConcerns = this.workingMemory.criticConcerns.slice(-maxConcerns);
              }
              logger.debug('[MULTI_AGENT] Critic concern recorded (approved with warnings)', {
                action: action.command.action,
                ref: action.command.ref,
                violations: warnings.length,
              });
            }
          }
        }
      } else if (shouldSkipCritic) {
        criticSkippedLowRisk = true;

        // PR2: Run SafetyInterceptor (Phase 1 deterministic checks) on the
        // skip path so hallucinated refs and forbidden actions cannot bypass
        // safety entirely. Default OFF — flip via enableSafetyInterceptorOnSkip.
        // <1ms overhead. Pure function. See safety-interceptor.ts.
        if (LITE_ENGINE_FLAGS.enableSafetyInterceptorOnSkip) {
          const safetyResult = SafetyInterceptor.check({
            proposedCommand: action.command,
            parsedSnapshot: input.parsedSnapshot,
            availableElements: input.snapshotElements,
            currentUrl: input.url,
            hasCredentials: input.hasCredentials,
            formAnalysis: observation.formAnalysis,
            visionConflicts: input.visionHints?.conflicts,
            isPageLoading: observation.loadingState?.isLoading,
            coveredElements: (observation.overlapInfo || []).map(o => o.coveredRef),
            blackboard,
            lastBlockerInfo: input.lastBlockerInfo,
            iteration: input.iteration,
          });

          if (!safetyResult.safe) {
            // Skip-path action blocked by deterministic safety check.
            // Bail out to monolithic fallback so the engine can re-decide
            // with full Critic involvement on the next attempt. The blocked
            // action is recorded in rejectedAction so the engine's blacklist
            // (LITE_ENGINE_FLAGS.enableNegativeReinforcement) prevents repeats.
            //
            // We deliberately do NOT enter the AI Critic reject cascade
            // (try alternatives → re-strategize → backtrack) because:
            //   1. We never had an AI Critic verdict here (skip path)
            //   2. The cascade is tightly coupled to AI verdict context
            //   3. Monolithic fallback is the existing safe escape hatch
            //
            // Net effect: hallucinated/forbidden actions on the skip path
            // cause one extra monolithic iteration instead of executing.
            this.metrics.skipPathSafetyBlockCount++;
            this.metrics.monolithicFallbackCount++;
            this.recordCircuitBreakerResult(false);

            logger.warn('[SAFETY_INTERCEPTOR] Skip-path action blocked', {
              reason: safetyResult.reason,
              action: action.command.action,
              ref: action.command.ref,
              iteration: input.iteration,
            });

            return {
              success: false,
              rejectedAction: action.command.ref ? {
                action: action.command.action,
                ref: action.command.ref,
                elementHint: action.reasoning?.slice(0, 60) || action.command.ref,
                reason: `SAFETY_INTERCEPTOR: ${safetyResult.reason ?? 'deterministic block'}`,
              } : undefined,
            };
          }
        }

        // Safety passed (or feature flag off) — original skip path behavior
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

      // ═══════════════════════════════════════════════════════════════════════
      // Supervisor: Record action and observer output for Tier 2 context
      // ═══════════════════════════════════════════════════════════════════════
      if (LITE_ENGINE_FLAGS.enableSupervisorLayer) {
        this.supervisor.recordAction(action.command);
        if (observation) {
          this.supervisor.recordObserverOutput(
            `pageType=${observation.pageType} obstacles=[${observation.obstacles.join(',')}] error=${observation.errorState || 'none'}`,
          );
        }
        if (!blackboard?.recoveryMode && input.progressScore > 0.1) {
          this.supervisor.resetOnProgress(input.progressScore);
        }
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
        supervisorRecoveryMode: blackboard?.recoveryMode,
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
          supervisorRecoveryMode: blackboard?.recoveryMode || undefined,
          supervisorTier: blackboard?.recoveryTier,
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
      // P0 fix — cap visitedPages to prevent unbounded growth on long
      // tests with heavy navigation. Each entry is small (~100 bytes)
      // but unconstrained: a 200-iteration crawl across 200 unique
      // URLs accumulates 200 entries forever (used by Strategist for
      // "have we been here before" loop detection).
      // LRU policy: when over cap, drop the oldest by `lastIteration`.
      // Cap = 50 unique URLs is more than enough for loop detection
      // (most tests visit ≤20 unique pages); keeps the structure
      // bounded under any test length.
      const MAX_VISITED_PAGES = 50;
      const keys = Object.keys(this.workingMemory.visitedPages);
      if (keys.length > MAX_VISITED_PAGES) {
        // Find oldest by lastIteration (smallest = stalest).
        let oldestKey = keys[0];
        let oldestIter = this.workingMemory.visitedPages[oldestKey].lastIteration;
        for (const k of keys) {
          const it = this.workingMemory.visitedPages[k].lastIteration;
          if (it < oldestIter) {
            oldestIter = it;
            oldestKey = k;
          }
        }
        // Don't evict the entry we just added (rare race when
        // iteration === oldestIter and oldestKey === urlKey, but be
        // defensive).
        if (oldestKey !== urlKey) {
          delete this.workingMemory.visitedPages[oldestKey];
        }
      }
    }

    // Update form progress from Observer's formAnalysis
    if (observation.formAnalysis) {
      this.workingMemory.lastFormAnalysis = observation.formAnalysis;
      // P1 fix — prune formProgress entries whose refs no longer
      // exist in the current form. Without pruning, every form the
      // test ever touched leaves its field refs behind forever
      // (multi-step flows: login form → settings form → checkout
      // form → ... accumulating field refs the rest of the test
      // doesn't care about, but Strategist re-reads on every
      // iteration). Pruning to current-form-refs only is correct:
      // a field that left the DOM cannot be filled again.
      const currentRefs = new Set(observation.formAnalysis.fields.map((f) => f.ref));
      for (const ref of Object.keys(this.workingMemory.formProgress)) {
        if (!currentRefs.has(ref)) {
          delete this.workingMemory.formProgress[ref];
        }
      }
      for (const field of observation.formAnalysis.fields) {
        const current = this.workingMemory.formProgress[field.ref];
        if (field.hasValue && current !== 'filled') {
          this.workingMemory.formProgress[field.ref] = 'filled';
        } else if (!field.hasValue && !current) {
          // Field exists but not yet interacted with — don't overwrite 'failed'
        }
      }
    } else {
      // No form on current page → drop stale form progress entirely.
      // Strategist will re-populate when next form appears.
      if (Object.keys(this.workingMemory.formProgress).length > 0) {
        this.workingMemory.formProgress = {};
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
      case 'press': return `Pressed key "${command.value || 'Enter'}"`;
      case 'scroll': return `Scrolled page`;
      case 'hover': return `Hovered over ${refLabel}`;
      case 'wait': return `Waited for page`;
      case 'toggle': return `Toggled ${refLabel}`;
      case 'setRange': return `Set range on ${refLabel}`;
      case 'clear': return `Cleared ${refLabel}`;
      case 'selectDate': return `Set date on ${refLabel}`;
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
