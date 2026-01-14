/**
 * LiteEngine
 * Main test execution engine with feedback loop and dual timeout
 * CORE: Test EVERY step before moving on
 *
 * ✅ NEW: Full GraphBuilder integration (like Pro) for real-time graph streaming
 */

import { TestRunRegistry } from '@/agent/playwright/core/test-run-registry';
import { GraphBuilder, GraphUpdate } from '@/agent/utils/visualization/graph-builder.service';
import { TestProgressEmitter } from '@/agent/utils/visualization/progress-emitter';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { Page } from 'playwright';
import { checkTestCancelled, cleanupCancellationState, withCancellation } from '../../playwright/utils/test-cancellation-checker';
import { buildSnapshotSummary } from './analysis/ai-goal-evaluator';
import { classifyField } from './analysis/field-classifier';
import { GoalDetector } from './analysis/goal-detector';
import { PlanProgressEvaluator } from './analysis/plan-progress-evaluator';
import { StateDiffComputer } from './analysis/state-diff';
import { StateValidator } from './analysis/state-validator';
import { TaskPlanBuilder, type TaskPlan } from './analysis/task-plan-builder';
import { ConsoleCollector } from './collectors/console-collector';
import { ErrorCollector } from './collectors/error-collector';
import { NetworkTracker } from './collectors/network-tracker';
import { SnapshotCollector } from './collectors/snapshot-collector';
import { VisualStability } from './collectors/visual-stability';
import { ActionExecutor } from './execution/action-executor';
import { toDynamicAction, toGraphActionResult } from './graph/lite-graph-adapter';
import { LiteState } from './lite-state';
import type { AICommand, AIDecision, ActionOutcome, CollectedError, ExecutionResult, GoalContext, GoalGuidance, LiteEngineConfig, LiteSnapshot, LiteTestResult, ModalDismissInfo, StateDiff } from './lite-types';
import { LitePromptBuilder, type TaskPlanContext, type ValidationErrorContext } from './prompt/lite-prompt-builder';
import { LiteTraceWriter } from './trace/lite-trace-writer';

export class LiteEngine {
  private page: Page;
  private config: LiteEngineConfig;
  private state: LiteState;
  private executor: ActionExecutor;
  private networkTracker: NetworkTracker;
  private consoleCollector: ConsoleCollector;
  private progressEmitter: TestProgressEmitter;
  private graphBuilder: GraphBuilder; // ✅ NEW: Full graph like Pro
  private goalDetector: GoalDetector; // ✅ NEW: Goal-first detection
  private traceWriter: LiteTraceWriter; // ✅ NEW: Always-on JSONL trace for debugging
  private startTime: number = 0;

  // Track emitted node IDs to avoid duplicates
  private emittedNodeIds = new Set<string>();
  private emittedEdgeIds = new Set<string>();

  // Flag to prevent graph updates after test completion
  private isTestCompleted = false;

  // Flag to prevent non-final graph updates during finalization (race-safe)
  private isFinalizing = false;

  // Pro-grade error collection
  private collectedErrors: CollectedError[] = [];
  private seenErrorMessages = new Set<string>(); // Deduplication by message+page+type

  // AI Guidance from stuck recovery (lifetime: 2 iterations)
  private currentGuidance: GoalGuidance | null = null;

  // Limits
  private readonly MAX_ITERATIONS = 20; // Step limit
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 min time limit
  private readonly STUCK_THRESHOLD = 2; // Consecutive stuck iterations before AI fallback

  // Rate limiting tracking (exponential backoff)
  private consecutiveRateLimitCount = 0;
  private readonly BASE_RATE_LIMIT_BACKOFF_MS = 5000; // 5s base
  private readonly MAX_RATE_LIMIT_BACKOFF_MS = 30000; // 30s max
  private readonly MAX_CONSECUTIVE_RATE_LIMITS = 3; // After 3 → blockedInfo

  // ✅ NEW: Audit cooldown tracking (prevents expensive repeated gpt-4o calls)
  // Cooldown: 3 iterations after auditor returns isDone=false
  // Bypass: if state hash or URL changes significantly
  private auditCooldownRemaining = 0;
  private lastAuditStateHash: string | null = null;
  private lastAuditUrl: string | null = null;
  private readonly AUDIT_COOLDOWN_ITERATIONS = 3;

  // ✅ NEW (Lite Autonomy v3): Task Plan and Progress
  private taskPlanBuilder: TaskPlanBuilder | null = null;
  private planProgressEvaluator: PlanProgressEvaluator | null = null;
  private currentPlan: TaskPlan | null = null;
  private lastModalDismissInfo: ModalDismissInfo | null = null;
  private validationErrorContext: ValidationErrorContext | null = null;
  private microCorrectionAttempted = false;
  private transientWaitStartTime: number | null = null;
  private readonly MAX_TRANSIENT_WAIT_MS = 15000; // 15 seconds max wait for loaders

  constructor(page: Page, config: LiteEngineConfig) {
    this.page = page;
    this.config = config;
    this.state = new LiteState();
    this.executor = new ActionExecutor(page);
    this.networkTracker = new NetworkTracker(page);
    this.consoleCollector = new ConsoleCollector(page);
    this.graphBuilder = new GraphBuilder(); // ✅ NEW: Initialize graph builder
    this.goalDetector = new GoalDetector(config.goal, config.testId); // ✅ NEW: Initialize goal detector with testId for AI fallback
    this.traceWriter = new LiteTraceWriter({ testId: config.testId }); // ✅ NEW: Initialize trace writer

    // WebSocket progress
    this.progressEmitter = new TestProgressEmitter(
      config.testId,
      config.browser || 'chrome',
      config.userId
    );

    logger.info('[LITE_ENGINE] Initialized', {
      testId: config.testId,
      goal: config.goal.slice(0, 100),
      maxIterations: this.MAX_ITERATIONS,
      timeout: this.TIMEOUT_MS,
      hasGraphBuilder: true,
      hasGoalDetector: true,
      hasTraceWriter: true,
      hasCredentials: !!config.credentials, // Log if credentials provided (never log actual values)
    });
  }

  /**
   * Override fill value for credential fields (email/username/phone/password)
   * SECURITY: Never sends credentials to LLM - backend injects correct values
   * Uses shared field classifier (3-level hierarchy) for reliable detection
   *
   * @param command - AI command to potentially override
   * @param snapshotBefore - Current page snapshot for element detection
   * @returns Modified command with credential value if applicable
   */
  private overrideCredentialFillValue(
    command: AICommand,
    snapshotBefore: LiteSnapshot
  ): AICommand {
    // Only process fill commands
    if (command.action !== 'fill' || !command.ref) {
      return command;
    }

    // No credentials available
    if (!this.config.credentials) {
      return command;
    }

    // Find target element in snapshot
    const element = snapshotBefore.elements.find(el => el.ref === command.ref);
    if (!element) {
      return command;
    }

    // Use shared classifier (Level 1-3 hierarchy)
    const classification = classifyField(element);
    if (!classification.kind) {
      return command;
    }

    const { credentials } = this.config;

    // Map classified kind to credential value
    switch (classification.kind) {
      case 'password':
        logger.debug('[LITE_ENGINE] Overriding password field with credential', {
          testId: this.config.testId,
          ref: command.ref,
          confidence: classification.confidence,
          reasons: classification.reasons,
        });
        return { ...command, value: credentials.password };

      case 'phone':
        if (credentials.phone) {
          logger.debug('[LITE_ENGINE] Overriding phone field with credential', {
            testId: this.config.testId,
            ref: command.ref,
            confidence: classification.confidence,
            reasons: classification.reasons,
          });
          return { ...command, value: credentials.phone };
        }
        break;

      case 'email':
        if (credentials.email) {
          logger.debug('[LITE_ENGINE] Overriding email field with credential', {
            testId: this.config.testId,
            ref: command.ref,
            confidence: classification.confidence,
            reasons: classification.reasons,
          });
          return { ...command, value: credentials.email };
        }
        break;

      case 'username': {
        // Fallback chain: username → email → phone
        const usernameValue = credentials.username || credentials.email || credentials.phone;
        if (usernameValue) {
          logger.debug('[LITE_ENGINE] Overriding username field with credential', {
            testId: this.config.testId,
            ref: command.ref,
            confidence: classification.confidence,
            reasons: classification.reasons,
          });
          return { ...command, value: usernameValue };
        }
        break;
      }
    }

    return command;
  }

  /**
   * Build a safe command for trace logging (smart redaction)
   * Only redacts fill values for credential fields; keeps other values visible for debugging
   * Validates AI isSensitive hint - only honored if classifier agrees
   *
   * @param command - AI command to sanitize
   * @param snapshot - Current page snapshot for field classification
   * @returns Command with value redacted only if credential field or validated isSensitive
   */
  private buildSafeCommandForTrace(
    command: AICommand | undefined,
    snapshot: LiteSnapshot
  ): AICommand | undefined {
    if (!command) return command;

    // Only redact fill commands with a ref
    if (command.action !== 'fill' || !command.ref || !command.value) {
      return command;
    }

    // Find target element and classify
    const element = snapshot.elements.find(el => el.ref === command.ref);
    if (!element) {
      // Element not found - redact if AI marked as sensitive (better safe than sorry)
      if (command.isSensitive) {
        return { ...command, value: '[REDACTED]' };
      }
      return command;
    }

    // Use shared classifier to decide redaction (validates isSensitive hint)
    const classification = classifyField(element);

    // Redact if: credential field detected
    if (classification.kind !== null) {
      return { ...command, value: '[REDACTED]' };
    }

    // Honor isSensitive only if classifier has medium/high confidence
    // This prevents AI from forcing redaction on arbitrary fields
    if (command.isSensitive && (classification.confidence === 'medium' || classification.confidence === 'high')) {
      return { ...command, value: '[REDACTED]' };
    }

    // Non-credential field - keep value visible for debugging
    return command;
  }

  /**
   * Main execution with DUAL TIMEOUT:
   * 1. Time limit: 5 minutes via Promise.race (or config.timeout)
   * 2. Step limit: 20 iterations max
   */
  async execute(): Promise<LiteTestResult> {
    // ✅ FIX: Use config.timeout if provided (with minimum 60s validation)
    const timeoutMs = Math.max(this.config.timeout || this.TIMEOUT_MS, 60000);

    const timeoutPromise = new Promise<LiteTestResult>((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    });

    try {
      return await Promise.race([this.runLoop(), timeoutPromise]);
    } catch (error) {
      if (error instanceof Error && error.message === 'TIMEOUT') {
        logger.error('[LITE_ENGINE] Time limit exceeded', {
          testId: this.config.testId,
          timeout: timeoutMs,
        });
        this.emitCompletion(false, `Time limit exceeded (${Math.round(timeoutMs / 60000)} min)`);

        // ✅ FIX: Flush pending uploads before returning (so graphData has URLs)
        await this.flushPendingGraphScreenshotUploads();

        return await this.buildResult(false, `Time limit exceeded (${Math.round(timeoutMs / 60000)} minutes)`);
      }

      logger.error('[LITE_ENGINE] Unexpected error', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Main test loop
   */
  private async runLoop(): Promise<LiteTestResult> {
    this.startTime = Date.now();

    logger.info('[LITE_ENGINE] Starting test loop', {
      testId: this.config.testId,
    });

    // Emit start progress
    this.progressEmitter.emit({
      progress: 20,
      phase: 'execution',
      currentStep: '🚀 Starting Lite Engine',
      status: 'running',
    });

    // ✅ NEW: Initialize dynamic strategy using AI (one-time call before loop)
    // ✅ FIX: Wrap with cancellation support for immediate abort
    try {
      await checkTestCancelled(this.config.testId);
      await withCancellation(
        this.config.testId,
        this.goalDetector.initializeDynamicStrategy(),
        'goalDetector.initializeDynamicStrategy'
      );

      // ✅ NEW: Trace strategy initialization success
      this.traceWriter.write({
        stage: 'initialization',
        eventType: 'ai_strategy_initialized',
        spanId: this.traceWriter.generateSpanId(),
        parentSpanId: this.traceWriter.getRootSpanId(),
        payload: {
          success: true,
          message: 'Dynamic strategy initialized successfully',
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('cancelled')) {
        logger.info('[LITE_ENGINE] Test cancelled during strategy init', {
          testId: this.config.testId,
        });
        this.emitCompletion(false, 'Test cancelled by user');
        return await this.buildResult(false, 'Test cancelled by user');
      }
      // Strategy init failed - continue with fallback heuristics
      logger.warn('[LITE_ENGINE] Strategy init failed, using fallback heuristics', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });

      // ✅ NEW: Trace strategy initialization failure
      this.traceWriter.write({
        stage: 'initialization',
        eventType: 'ai_strategy_failed',
        spanId: this.traceWriter.generateSpanId(),
        parentSpanId: this.traceWriter.getRootSpanId(),
        payload: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          fallback: 'Using fallback heuristics',
        },
      });
    }

    // ✅ NEW (Lite Autonomy v3): Initialize Task Plan
    await this.initializeTaskPlan();

    // ✅ NEW: Emit start node to graph (like Pro)
    const startUpdate = this.graphBuilder.addStartNode();
    this.emitGraphUpdate(startUpdate);

    // ✅ NEW: Write trace run_start event
    const rootSpanId = this.traceWriter.getRootSpanId();
    this.traceWriter.write({
      stage: 'initialization',
      eventType: 'run_start',
      spanId: rootSpanId,
      payload: {
        testId: this.config.testId,
        goal: this.config.goal,
        url: this.config.url,
        browser: this.config.browser || 'chrome',
        mode: 'lite',
        limits: {
          maxIterations: this.MAX_ITERATIONS,
          timeoutMs: this.config.timeout || this.TIMEOUT_MS,
        },
        startTime: new Date(this.startTime).toISOString(),
      },
    });

    try {
      for (let i = 0; i < this.MAX_ITERATIONS; i++) {
        logger.debug('[LITE_ENGINE] Starting iteration', { iteration: i });

        // ✅ NEW: Trace iteration start
        const iterationSpanId = this.traceWriter.generateSpanId();
        this.traceWriter.write({
          iteration: i,
          stage: 'iteration',
          eventType: 'iteration_start',
          spanId: iterationSpanId,
          parentSpanId: this.traceWriter.getRootSpanId(),
          payload: {
            iteration: i,
            maxIterations: this.MAX_ITERATIONS,
          },
        });

        // ✅ NEW: Ensure iteration_end is always emitted (even on early continue/return)
        let isIterationClosed = false;
        const closeIteration = (payload: Record<string, any>) => {
          if (isIterationClosed) return;
          isIterationClosed = true;
          this.traceWriter.write({
            iteration: i,
            stage: 'iteration',
            eventType: 'iteration_end',
            spanId: this.traceWriter.generateSpanId(),
            parentSpanId: iterationSpanId,
            payload,
          });
        };

        // 0. Check if test was cancelled (allows frontend to stop test)
        try {
          await checkTestCancelled(this.config.testId);
        } catch (cancelError) {
          if (cancelError instanceof Error && cancelError.message.includes('cancelled')) {
            logger.info('[LITE_ENGINE] Test cancelled by user', {
              testId: this.config.testId,
              iteration: i,
            });
            this.emitCompletion(false, 'Test cancelled by user');
            await this.flushPendingGraphScreenshotUploads();
            closeIteration({ skipped: true, reason: 'cancelled_by_user' });
            return await this.buildResult(false, 'Test cancelled by user');
          }
          // If check failed (timeout, etc.), continue execution
        }

        // 0a. Set current iteration for network error context
        this.networkTracker.setIteration(i);

        // 1. Check if stuck
        const stuckCheck = this.state.isStuck();

        // 2. Collect snapshot BEFORE (with visual stability)
        let snapshotBefore = await SnapshotCollector.collect(this.page);
        const pageErrorsBefore = await ErrorCollector.collectFromPage(this.page);

        // 2a. Guard: check if snapshot is too empty (page still loading)
        if (snapshotBefore.elements.length < 3) {
          logger.warn('[LITE_ENGINE] Snapshot too empty, waiting for page load', {
            testId: this.config.testId,
            elementCount: snapshotBefore.elements.length,
            iteration: i,
          });
          await this.page.waitForLoadState('domcontentloaded');
          await this.page.waitForTimeout(2000);
          snapshotBefore = await SnapshotCollector.collect(this.page);
        }

        // ✅ NEW: Trace snapshot
        const formattedSnapshot = SnapshotCollector.format(snapshotBefore);
        this.traceWriter.write({
          iteration: i,
          stage: 'snapshot',
          eventType: 'snapshot',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: iterationSpanId,
          payload: {
            url: snapshotBefore.url,
            title: snapshotBefore.title,
            elementCount: snapshotBefore.elements.length,
            hasActiveModal: !!snapshotBefore.activeModalRef,
            isTransient: snapshotBefore.transientState?.isTransient || false,
            formattedSnapshot, // Full formatted snapshot for AI context
            liteSnapshot: snapshotBefore, // Raw LiteSnapshot object
          },
        });

        // 2b. Build GoalContext for this iteration
        const goalContext = this.buildGoalContext(snapshotBefore, i, stuckCheck);

        // ✅ NEW (Lite Autonomy v3): Evaluate task plan progress
        // Used for guidance and context, but NOT as primary completion criterion
        if (this.planProgressEvaluator) {
          const planProgress = this.planProgressEvaluator.evaluate(snapshotBefore);

          // Log plan progress for debugging
          logger.debug('[LITE_ENGINE] Task plan progress', {
            testId: this.config.testId,
            currentStep: planProgress.currentStepIndex + 1,
            totalSteps: this.currentPlan?.steps.length || 0,
            stepCompleted: planProgress.stepCompleted,
            overallProgress: Math.round(planProgress.overallProgress * 100) + '%',
          });

          // ⚠️ CRITICAL: Don't complete test only by plan - validate with GoalDetector
          // Task plan might complete before actual goal (e.g., form submitted but validation error)
          // Instead, use plan completion as a STRONG hint to GoalDetector
          if (planProgress.planCompleted) {
            logger.info('[LITE_ENGINE] Task plan reports completion, will validate with GoalDetector', {
              testId: this.config.testId,
              totalSteps: this.currentPlan?.steps.length || 0,
            });
            // Don't return here - let GoalDetector confirm below
          }

          // Check for system error from plan evaluation
          // ⚠️ Only stop for STRONG system errors (500, crash, etc.)
          if (planProgress.errorType === 'system' && planProgress.failSignals.length > 0) {
            const errorMsg = planProgress.failSignals.join(', ');
            logger.warn('[LITE_ENGINE] System error signals detected from plan', {
              testId: this.config.testId,
              error: errorMsg,
            });
            // Record as error but don't stop - let GoalDetector or AI decide if it's critical
            this.addError({
              message: `Potential system error: ${errorMsg}`,
              page: snapshotBefore.url,
              type: 'page',
              iteration: i,
              timestamp: Date.now(),
            });
            // Continue execution - system errors are also caught by ErrorCollector
          }
        }

        // ✅ NEW: Goal-first check BEFORE asking AI (using heuristic)
        const goalCheck = this.goalDetector.detectHeuristic(goalContext);

        // ✅ NEW: Decrement audit cooldown each iteration
        if (this.auditCooldownRemaining > 0) {
          this.auditCooldownRemaining--;
        }

        // ✅ NEW: Check if audit cooldown should be bypassed (state changed significantly)
        const currentStateHash = this.state.getCurrentStateHash();
        const stateChangedSignificantly =
          (this.lastAuditStateHash && currentStateHash !== this.lastAuditStateHash) ||
          (this.lastAuditUrl && snapshotBefore.url !== this.lastAuditUrl);

        if (stateChangedSignificantly && this.auditCooldownRemaining > 0) {
          logger.debug('[LITE_ENGINE] Audit cooldown bypassed - state changed significantly', {
            testId: this.config.testId,
            oldHash: this.lastAuditStateHash?.slice(0, 16),
            newHash: currentStateHash?.slice(0, 16),
            urlChanged: this.lastAuditUrl !== snapshotBefore.url,
            cooldownRemaining: this.auditCooldownRemaining,
          });
          this.auditCooldownRemaining = 0; // Reset cooldown
        }

        // ✅ NEW: If heuristic claims done, validate with auditor (with cooldown)
        if (goalCheck.goalReached && goalCheck.confidence !== 'low') {
          const shouldCallAuditor = this.auditCooldownRemaining === 0;

          if (!shouldCallAuditor) {
            logger.debug('[LITE_ENGINE] Heuristic claims done but auditor on cooldown, skipping', {
              testId: this.config.testId,
              cooldownRemaining: this.auditCooldownRemaining,
              progressScore: Math.round(goalCheck.progressScore * 100) + '%',
            });
            // Continue to next iteration without completing
          } else {
            // Call auditor (gpt-4o) for final validation
            logger.info('[LITE_ENGINE] Heuristic claims done, calling auditor for validation', {
              testId: this.config.testId,
              progressScore: Math.round(goalCheck.progressScore * 100) + '%',
              confidence: goalCheck.confidence,
            });

            try {
              // ✅ NEW: Trace auditor prompt (heuristic path)
              const auditorPromptSpanId = this.traceWriter.generateSpanId();
              this.traceWriter.write({
                iteration: i,
                stage: 'goal_validation',
                eventType: 'ai_auditor_prompt',
                spanId: auditorPromptSpanId,
                parentSpanId: iterationSpanId,
                payload: {
                  trigger: 'heuristic_done',
                  goalContext,
                  lastOutcome: this.state.getLastOutcome(),
                  model: 'gpt-4o', // Auditor uses gpt-4o
                },
              });

              const auditResult = await withCancellation(
              this.config.testId,
              this.goalDetector.auditDone(goalContext, this.state.getLastOutcome()),
              'goalDetector.auditDone'
            );

              // ✅ NEW: Trace auditor response
              this.traceWriter.write({
                iteration: i,
                stage: 'goal_validation',
                eventType: 'ai_auditor_response',
                spanId: this.traceWriter.generateSpanId(),
                parentSpanId: auditorPromptSpanId,
                payload: {
                  auditResult,
                  isDone: auditResult.isDone,
                  isBlocked: auditResult.isBlocked,
                  confidence: auditResult.confidence,
                  reason: auditResult.reason,
                },
              });

              // Update cooldown tracking
              this.lastAuditStateHash = currentStateHash;
              this.lastAuditUrl = snapshotBefore.url;

              if (auditResult.isBlocked) {
                // ✅ BLOCKED: Stop test and return blocked result (same as existing hard-block path)
                const blockedReason = auditResult.blockedReason || 'Test blocked';
                logger.info('[LITE_ENGINE] Auditor detected hard block', {
                  testId: this.config.testId,
                  blockedReason,
                  canUserHelp: auditResult.canUserHelp,
                });

                // Emit blocked progress via WebSocket (consistent with existing hard-block path)
                try {
                  webSocketService.emitTestProgress(this.config.testId, {
                    testId: this.config.testId,
                    browser: this.config.browser || 'chrome',
                    progress: Math.round((i / this.MAX_ITERATIONS) * 70) + 20,
                    phase: 'blocked',
                    currentStep: `🚫 ${blockedReason}`,
                    status: 'failed',
                    timestamp: new Date().toISOString(),
                  });
                } catch {
                  // Ignore WebSocket errors
                }

                this.emitCompletion(false, blockedReason);
                await this.flushPendingGraphScreenshotUploads();
                return await this.buildResult(false, `Blocked: ${blockedReason}`);
              }

              if (auditResult.isDone && auditResult.confidence >= 0.5) {
                // ✅ DONE: Complete the test
                logger.info('[LITE_ENGINE] Auditor confirmed goal reached', {
                  testId: this.config.testId,
                  confidence: auditResult.confidence.toFixed(2),
                  reason: auditResult.reason,
                  iterations: i + 1,
                });
                this.currentGuidance = null;
                this.emitCompletion(true, auditResult.reason || 'Goal reached');
                await this.flushPendingGraphScreenshotUploads();
                return await this.buildResult(true, auditResult.reason || 'Goal reached');
              } else {
                // ✅ NOT DONE: Start cooldown and continue
                logger.info('[LITE_ENGINE] Auditor rejected heuristic done claim, starting cooldown', {
                  testId: this.config.testId,
                  isDone: auditResult.isDone,
                  confidence: auditResult.confidence.toFixed(2),
                  reason: auditResult.reason,
                  nextStep: auditResult.nextStepIfMissing,
                  cooldownIterations: this.AUDIT_COOLDOWN_ITERATIONS,
                });
                this.auditCooldownRemaining = this.AUDIT_COOLDOWN_ITERATIONS;

                // Optionally use nextStepIfMissing as guidance
                if (auditResult.nextStepIfMissing) {
                  this.currentGuidance = {
                    guidance: auditResult.reason,
                    nextSubgoal: auditResult.nextStepIfMissing,
                    addedAtIteration: i,
                  };
                }
                // Continue to next iteration
              }
            } catch (auditError) {
              if (auditError instanceof Error && auditError.message.includes('cancelled')) {
                logger.info('[LITE_ENGINE] Test cancelled during auditor', {
                  testId: this.config.testId,
                });
                this.emitCompletion(false, 'Test cancelled by user');
                await this.flushPendingGraphScreenshotUploads();
                return await this.buildResult(false, 'Test cancelled by user');
              }
              // Auditor failed - continue without completing (conservative)
              logger.warn('[LITE_ENGINE] Auditor failed, continuing (conservative)', {
                testId: this.config.testId,
                error: auditError instanceof Error ? auditError.message : String(auditError),
              });
            }
          }
        }

        // ✅ NEW (Lite Autonomy v3): Handle transient state (loaders/spinners)
        // If page is loading, skip stuck detection and wait
        if (snapshotBefore.transientState?.isTransient) {
          const shouldSkipStuck = await this.handleTransientState(snapshotBefore);
          if (shouldSkipStuck) {
            logger.debug('[LITE_ENGINE] Skipping iteration due to transient state', {
              testId: this.config.testId,
              transientType: snapshotBefore.transientState.type,
              iteration: i,
            });
            closeIteration({
              skipped: true,
              reason: 'transient_state',
              transientType: snapshotBefore.transientState.type,
            });
            continue;
          }
        }

        // ✅ NEW (Lite Autonomy v3): Try micro-correction before expensive stuck recovery
        if (stuckCheck.stuck && this.state.getConsecutiveStuckCount() >= this.STUCK_THRESHOLD && !this.microCorrectionAttempted) {
          const corrected = await this.tryMicroCorrection();
          if (corrected) {
            logger.info('[LITE_ENGINE] Micro-correction successful, continuing', {
              testId: this.config.testId,
            });
            closeIteration({ skipped: true, reason: 'micro_correction' });
            continue;
          }
        }

        // ✅ NEW: AI fallback for stuck recovery (when stuck for 2+ iterations)
        if (stuckCheck.stuck && this.state.getConsecutiveStuckCount() >= this.STUCK_THRESHOLD) {
          logger.info('[LITE_ENGINE] Stuck for 2+ iterations, trying AI fallback', {
            testId: this.config.testId,
            consecutiveStuckCount: this.state.getConsecutiveStuckCount(),
            iteration: i,
          });

          try {
            const stuckEval = await withCancellation(
              this.config.testId,
              this.goalDetector.evaluateForStuckRecovery(goalContext),
              'goalDetector.evaluateForStuckRecovery'
            );

            if (stuckEval?.nextSubgoal) {
              // Store guidance for next iterations
              this.currentGuidance = {
                guidance: stuckEval.reason || '',
                nextSubgoal: stuckEval.nextSubgoal,
                addedAtIteration: i,
              };

              // Reset stuck counter since we got new guidance
              this.state.resetConsecutiveStuckCount();

              logger.info('[LITE_ENGINE] Got AI guidance for stuck recovery', {
                testId: this.config.testId,
                nextSubgoal: stuckEval.nextSubgoal.slice(0, 50),
                progressScore: Math.round(stuckEval.progressScore * 100) + '%',
              });
            } else {
              // ✅ NEW: AI fallback didn't help - try direct URL fallback
              // Only for register/login goals
              const urlFallbackResult = await this.tryDirectUrlFallback(snapshotBefore.url);
              if (urlFallbackResult.navigated) {
                logger.info('[LITE_ENGINE] Direct URL fallback successful', {
                  testId: this.config.testId,
                  newUrl: urlFallbackResult.finalUrl,
                });
                // Re-collect snapshot after navigation
                snapshotBefore = await SnapshotCollector.collect(this.page);
                // Reset stuck counter since we made progress
                this.state.resetConsecutiveStuckCount();
              }
            }
          } catch (stuckError) {
            // Check if cancelled
            if (stuckError instanceof Error && stuckError.message.includes('cancelled')) {
              logger.info('[LITE_ENGINE] Test cancelled during stuck recovery', {
                testId: this.config.testId,
              });
              this.emitCompletion(false, 'Test cancelled by user');
              await this.flushPendingGraphScreenshotUploads();
              return await this.buildResult(false, 'Test cancelled by user');
            }
            // If AI fallback failed, just continue with regular flow
            logger.warn('[LITE_ENGINE] Stuck recovery AI fallback failed, continuing', {
              testId: this.config.testId,
              error: stuckError instanceof Error ? stuckError.message : String(stuckError),
            });
          }
        }

        // Clear expired guidance (lifetime: 2 iterations)
        if (this.currentGuidance && !LitePromptBuilder.isGuidanceValid(this.currentGuidance, i)) {
          logger.debug('[LITE_ENGINE] Clearing expired guidance', {
            testId: this.config.testId,
            addedAt: this.currentGuidance.addedAtIteration,
            currentIteration: i,
          });
          this.currentGuidance = null;
        }

        // 3. Screenshot BEFORE - REMOVED for Lite mode (no screenshots)

        // ✅ NEW: Get contextual hints from GoalDetector for smarter navigation
        const contextualHints = this.goalDetector.buildContextualHints(snapshotBefore);

        // ✅ NEW (Lite Autonomy v3): Build task plan context for prompt
        const taskPlanContext = this.buildTaskPlanContext(stuckCheck.stuck);

        // 4. Build prompt with stuck warning + progress signals + AI guidance + contextual hints + task plan
        const prompt = LitePromptBuilder.build({
          goal: this.config.goal,
          snapshot: formattedSnapshot,
          history: this.state.getFormattedHistory(),
          stuckCheck,
          lastOutcome: this.state.getLastOutcome(),
          progressSignals: {
            currentUrl: snapshotBefore.url,
            progressScore: goalCheck.progressScore,
            matchedSignals: goalCheck.signals.filter(s => s.match).map(s => s.detail || s.type),
          },
          guidance: this.currentGuidance || undefined,
          currentIteration: i,
          contextualHints, // ✅ NEW: Pass dynamic hints for entry point exploration
          taskPlanContext, // ✅ NEW (Lite Autonomy v3): Task plan context
          modalDismissInfo: this.lastModalDismissInfo || undefined, // ✅ NEW: Modal dismiss info
          validationErrorContext: this.validationErrorContext || undefined, // ✅ NEW: Validation error context
          hasCredentials: !!this.config.credentials, // ✅ NEW: Tell LLM not to invent credentials
        });

        // ✅ NEW: Trace AI prompt
        const aiPromptSpanId = this.traceWriter.generateSpanId();
        this.traceWriter.write({
          iteration: i,
          stage: 'ai_decision',
          eventType: 'ai_prompt',
          spanId: aiPromptSpanId,
          parentSpanId: iterationSpanId,
          payload: {
            prompt,
            model: 'gpt-4o-mini', // Main decision model
            promptLength: prompt.length,
            estimatedTokens: Math.ceil(prompt.length / 4),
          },
        });

        // 5. Ask AI (returns JSON command, not code)
        // ✅ FIX: Wrap AI call with cancellation support
        const decision = await withCancellation(
          this.config.testId,
          LitePromptBuilder.askAI(prompt),
          'LitePromptBuilder.askAI'
        );

        // ✅ NEW: Trace AI response (smart redaction: only credential fields)
        const safeCommand = this.buildSafeCommandForTrace(decision?.command, snapshotBefore);
        const safeDecision = {
          ...decision,
          command: safeCommand,
        };
        this.traceWriter.write({
          iteration: i,
          stage: 'ai_decision',
          eventType: 'ai_response',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: aiPromptSpanId,
          payload: {
            decision: safeDecision,
            thought: decision.thought,
            command: safeCommand,
            done: decision.done || false,
            blocked: decision.blocked,
            blockedInfo: decision.blockedInfo,
          },
        });

        // Check terminal states
        if (decision.done) {
          // ✅ NEW: Validate AI's done claim with auditor (gpt-4o) with cooldown
          const shouldCallAuditorForAIDone = this.auditCooldownRemaining === 0;

          if (!shouldCallAuditorForAIDone) {
            logger.debug('[LITE_ENGINE] AI claims done but auditor on cooldown, skipping', {
              testId: this.config.testId,
              cooldownRemaining: this.auditCooldownRemaining,
              thought: decision.thought?.slice(0, 50),
            });
            // Continue to next iteration
            closeIteration({ skipped: true, reason: 'ai_done_auditor_cooldown' });
            continue;
          }

          try {
            logger.info('[LITE_ENGINE] AI claims done, calling auditor for validation', {
              testId: this.config.testId,
              thought: decision.thought?.slice(0, 50),
            });

            // ✅ NEW: Trace auditor prompt (AI done path)
            const auditorPromptSpanId2 = this.traceWriter.generateSpanId();
            this.traceWriter.write({
              iteration: i,
              stage: 'goal_validation',
              eventType: 'ai_auditor_prompt',
              spanId: auditorPromptSpanId2,
              parentSpanId: iterationSpanId,
              payload: {
                trigger: 'ai_done',
                goalContext,
                aiThought: decision.thought,
                model: 'gpt-4o', // Auditor uses gpt-4o
              },
            });

            const auditResult = await withCancellation(
              this.config.testId,
              this.goalDetector.auditDone(goalContext, decision.thought),
              'goalDetector.auditDone (AI done path)'
            );

            // ✅ NEW: Trace auditor response
            this.traceWriter.write({
              iteration: i,
              stage: 'goal_validation',
              eventType: 'ai_auditor_response',
              spanId: this.traceWriter.generateSpanId(),
              parentSpanId: auditorPromptSpanId2,
              payload: {
                auditResult,
                isDone: auditResult.isDone,
                isBlocked: auditResult.isBlocked,
                confidence: auditResult.confidence,
                reason: auditResult.reason,
              },
            });

            // Update cooldown tracking
            const currentStateHash = this.state.getCurrentStateHash();
            this.lastAuditStateHash = currentStateHash;
            this.lastAuditUrl = snapshotBefore.url;

            if (auditResult.isBlocked) {
              // ✅ BLOCKED: Stop test and return blocked result (same as existing hard-block path)
              const blockedReason = auditResult.blockedReason || 'Test blocked';
              logger.info('[LITE_ENGINE] Auditor detected hard block (AI done path)', {
                testId: this.config.testId,
                blockedReason,
                canUserHelp: auditResult.canUserHelp,
              });

              // Emit blocked progress via WebSocket (consistent with existing hard-block path)
              try {
                webSocketService.emitTestProgress(this.config.testId, {
                  testId: this.config.testId,
                  browser: this.config.browser || 'chrome',
                  progress: Math.round((i / this.MAX_ITERATIONS) * 70) + 20,
                  phase: 'blocked',
                  currentStep: `🚫 ${blockedReason}`,
                  status: 'failed',
                  timestamp: new Date().toISOString(),
                });
              } catch {
                // Ignore WebSocket errors
              }

              this.emitCompletion(false, blockedReason);
              await this.flushPendingGraphScreenshotUploads();
              return await this.buildResult(false, `Blocked: ${blockedReason}`);
            }

            if (auditResult.isDone && auditResult.confidence >= 0.5) {
              // ✅ DONE: Complete the test
              logger.info('[LITE_ENGINE] Auditor confirmed AI done claim', {
                testId: this.config.testId,
                confidence: auditResult.confidence.toFixed(2),
                reason: auditResult.reason,
                thought: decision.thought?.slice(0, 50),
                iterations: i + 1,
              });
              this.currentGuidance = null;
              this.emitCompletion(true, decision.thought || auditResult.reason);
              await this.flushPendingGraphScreenshotUploads();
              return await this.buildResult(true, decision.thought || auditResult.reason);
            } else {
              // ✅ NOT DONE: Start cooldown and continue
              logger.info('[LITE_ENGINE] Auditor rejected AI done claim, starting cooldown', {
                testId: this.config.testId,
                isDone: auditResult.isDone,
                confidence: auditResult.confidence.toFixed(2),
                reason: auditResult.reason,
                nextStep: auditResult.nextStepIfMissing,
                cooldownIterations: this.AUDIT_COOLDOWN_ITERATIONS,
              });
              this.auditCooldownRemaining = this.AUDIT_COOLDOWN_ITERATIONS;

              // Optionally use nextStepIfMissing as guidance
              if (auditResult.nextStepIfMissing) {
                this.currentGuidance = {
                  guidance: auditResult.reason,
                  nextSubgoal: auditResult.nextStepIfMissing,
                  addedAtIteration: i,
                };
              }
              // Continue to next iteration
              closeIteration({ skipped: true, reason: 'ai_done_auditor_rejected' });
              continue;
            }
          } catch (doneError) {
            // Check if cancelled
            if (doneError instanceof Error && doneError.message.includes('cancelled')) {
              logger.info('[LITE_ENGINE] Test cancelled during done validation', {
                testId: this.config.testId,
              });
              this.emitCompletion(false, 'Test cancelled by user');
              await this.flushPendingGraphScreenshotUploads();
              return await this.buildResult(false, 'Test cancelled by user');
            }
            // Auditor failed - continue without completing (conservative)
            logger.warn('[LITE_ENGINE] Auditor failed for AI done claim, continuing', {
              testId: this.config.testId,
              error: doneError instanceof Error ? doneError.message : String(doneError),
            });
            closeIteration({ skipped: true, reason: 'ai_done_auditor_failed' });
            continue;
          }
        }

        // Check for blocked state (support both old string and new structured format)
        // ✅ NEW: Only stop for HARD blocks where user can help (captcha/2FA/verification)
        //         For soft blocks, keep trying until limits
        if (decision.blocked || decision.blockedInfo) {
          const reason = decision.blockedInfo?.reason || decision.blocked || 'Unknown reason';
          const canUserHelp = decision.blockedInfo?.canUserHelp || false;

          logger.warn('[LITE_ENGINE] Test blocked', {
            testId: this.config.testId,
            reason,
            canUserHelp,
            iterations: i + 1,
          });

          // Only emit clarification and stop for HARD blocks where user can help
          if (canUserHelp) {
            // Hard block: captcha, 2FA, verification code, etc.
            // Emit clarification request via WebSocket
            try {
              webSocketService.emitTestProgress(this.config.testId, {
                testId: this.config.testId,
                browser: this.config.browser || 'chrome',
                progress: Math.round((i / this.MAX_ITERATIONS) * 70) + 20,
                phase: 'blocked',
                currentStep: `🚫 ${reason}`,
                status: 'failed', // Use 'failed' for blocked state
                timestamp: new Date().toISOString(),
              });
            } catch {
              // Ignore WebSocket errors
            }

            this.emitCompletion(false, reason);
            await this.flushPendingGraphScreenshotUploads();
            return await this.buildResult(false, `Blocked: ${reason}`);
          } else {
            // Soft block: just log and continue trying
            logger.info('[LITE_ENGINE] Soft block detected, continuing', {
              testId: this.config.testId,
              reason,
              iteration: i,
            });
            // Record as warning, not error
            this.addError({
              message: `Soft block: ${reason}`,
              page: snapshotBefore.url,
              type: 'ui',
              iteration: i,
              timestamp: Date.now(),
            });
            // Continue to next iteration
            closeIteration({ skipped: true, reason: 'soft_block', details: reason });
            continue;
          }
        }

        // 6. Execute command (safe switch/case, with fuzzy fallback)
        // ✅ Pass dynamic keywords from AI-generated strategy for modal detection + self-healing
        const parsedGoal = this.goalDetector.getParsedGoal();
        const modalKeywords = this.goalDetector.getModalKeywords();

        // ✅ CREDENTIAL OVERRIDE: Replace AI-generated fill values for credential fields
        // SECURITY: Credentials never sent to LLM - backend injects correct values here
        const commandWithCredentials = this.overrideCredentialFillValue(decision.command, snapshotBefore);

        // ✅ NEW: Trace action execute start
        const actionSpanId = this.traceWriter.generateSpanId();
        this.traceWriter.write({
          iteration: i,
          stage: 'action_execution',
          eventType: 'action_execute_start',
          spanId: actionSpanId,
          parentSpanId: iterationSpanId,
          payload: {
            command: safeCommand, // Always log redacted version
            thought: decision.thought,
          },
        });

        const execResult = await this.executor.execute(
          commandWithCredentials, // Use command with credential override
          snapshotBefore,
          {
            entryPointKeywords: parsedGoal.entryPointKeywords,
            modalKeywords, // ✅ NEW: Pass modal keywords for hybrid auto-dismiss
            // ✅ NEW: Pass trace hook for detailed action logging
            traceHook: (event) => {
              this.traceWriter.write({
                iteration: i,
                stage: 'action_execution_detail',
                eventType: `action_${event.stage}`,
                spanId: this.traceWriter.generateSpanId(),
                parentSpanId: actionSpanId,
                payload: {
                  action: event.action,
                  success: event.success,
                  error: event.error,
                  duration: event.duration,
                  details: event.details,
                },
              });
            },
          }
        );

        // ✅ NEW: Trace action execute end
        this.traceWriter.write({
          iteration: i,
          stage: 'action_execution',
          eventType: 'action_execute_end',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: actionSpanId,
          payload: {
            success: execResult.success,
            error: execResult.error,
            duration: execResult.duration,
            usedFallback: execResult.usedFallback,
            fallbackInfo: execResult.fallbackInfo,
            modalDismissInfo: execResult.modalDismissInfo,
            usedForceClick: execResult.usedForceClick,
          },
        });

        // ✅ NEW (Lite Autonomy v3): Store modal dismiss info for next iteration's prompt
        this.lastModalDismissInfo = execResult.modalDismissInfo || null;

        // ✅ NEW (Lite Autonomy v3): Handle validation error modal (rollback)
        if (execResult.modalDismissInfo?.modalType === 'validation') {
          await this.handleValidationError(execResult.modalDismissInfo, snapshotBefore.url);
        }

        // 7. Wait for stability (with cancellation support)
        // ✅ FIX: Wrap stability waits with cancellation for immediate abort
        await withCancellation(
          this.config.testId,
          this.networkTracker.waitForNetworkIdle(5000),
          'networkTracker.waitForNetworkIdle'
        );
        await withCancellation(
          this.config.testId,
          VisualStability.waitForStable(this.page),
          'VisualStability.waitForStable'
        );

        // 7a. Check cancellation again after action (user might cancel during execution)
        try {
          await checkTestCancelled(this.config.testId);
        } catch (cancelError) {
          if (cancelError instanceof Error && cancelError.message.includes('cancelled')) {
            logger.info('[LITE_ENGINE] Test cancelled by user after action', {
              testId: this.config.testId,
              iteration: i,
            });
            this.emitCompletion(false, 'Test cancelled by user');
            await this.flushPendingGraphScreenshotUploads();
            return await this.buildResult(false, 'Test cancelled by user');
          }
        }

        // 8. Screenshot AFTER - REMOVED for Lite mode (no screenshots)

        // 9. Collect after snapshot
        const snapshotAfter = await SnapshotCollector.collect(this.page);
        const pageErrorsAfter = await ErrorCollector.collectFromPage(this.page);
        const consoleErrors = this.consoleCollector.getErrorsSince(execResult.startTime);
        const networkErrors = this.networkTracker.getErrorsSince(execResult.startTime);
        const networkErrorStrings = networkErrors.map((e) => {
          const statusPart = e.status ? ` ${e.status}` : '';
          return `${e.error}${statusPart} ${e.url}`;
        });

        // 9a. Collect UI errors (Pro-grade)
        const uiErrors = await ErrorCollector.collectUIErrors(this.page, i);

        // 9b. Record execution error if any
        if (execResult.error) {
          this.addError({
            message: execResult.error,
            page: snapshotAfter.url,
            type: 'execution',
            iteration: i,
            timestamp: Date.now(),
          });
        }

        // 9c. Record console errors (consoleErrors is string[])
        for (const consoleError of consoleErrors) {
          this.addError({
            message: consoleError, // Already a string
            page: snapshotAfter.url,
            type: 'console',
            iteration: i,
            timestamp: Date.now(),
          });
        }

        // 9d. Record page errors (new ones)
        for (const pageError of pageErrorsAfter) {
          if (!pageErrorsBefore.includes(pageError)) {
            this.addError({
              message: pageError,
              page: snapshotAfter.url,
              type: 'page',
              iteration: i,
              timestamp: Date.now(),
            });
          }
        }

        // 9e. Record UI errors
        for (const uiError of uiErrors) {
          this.addError({
            message: uiError.text,
            page: snapshotAfter.url,
            type: 'ui',
            iteration: i,
            timestamp: uiError.timestamp,
            details: { selector: uiError.selector, uiType: uiError.type },
          });
        }

        // 9f. Record network errors (action-scoped)
        for (const netError of networkErrors) {
          this.addError({
            message: netError.error,
            page: netError.url,
            type: 'network',
            iteration: i,
            timestamp: netError.timestamp,
            details: { method: netError.method, status: netError.status },
          });
        }

        // 10. Compute diff
        const diff = StateDiffComputer.compute(
          snapshotBefore,
          snapshotAfter,
          pageErrorsBefore,
          pageErrorsAfter,
          consoleErrors,
          networkErrorStrings
        );

        // ✅ NEW: Trace state diff
        this.traceWriter.write({
          iteration: i,
          stage: 'diff_validation',
          eventType: 'state_diff',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: iterationSpanId,
          payload: {
            urlChanged: diff.urlChanged,
            urlBefore: diff.urlBefore,
            urlAfter: diff.urlAfter,
            addedElementsCount: diff.addedElements.length,
            removedRefsCount: diff.removedRefs.length,
            changedElementsCount: diff.changedElements.length,
            newPageErrorsCount: diff.newPageErrors.length,
            newConsoleErrorsCount: diff.newConsoleErrors.length,
            newNetworkErrorsCount: diff.newNetworkErrors?.length || 0,
            // Include subset of actual changes for debugging
            addedElements: diff.addedElements.slice(0, 10),
            removedRefs: diff.removedRefs.slice(0, 10),
            changedElements: diff.changedElements.slice(0, 10),
          },
        });

        // 11. Validate outcome (with element counts for critical error detection)
        const outcome = StateValidator.validate(
          diff,
          execResult.error,
          snapshotBefore.elements.length,
          snapshotAfter.elements.length
        );

        // ✅ NEW: Trace validation
        this.traceWriter.write({
          iteration: i,
          stage: 'diff_validation',
          eventType: 'validation',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: iterationSpanId,
          payload: {
            outcome,
            isStateChanged: outcome === 'state_changed',
            isValidationError: outcome === 'validation_error',
            isCriticalError: outcome === 'critical_error',
            isRateLimited: outcome === 'rate_limited',
            hasExecutionError: !!execResult.error,
          },
        });

        // 11a. Exponential backoff on rate limit (HTTP 429) - do not hammer the site
        if (outcome === 'rate_limited') {
          this.consecutiveRateLimitCount++;

          // ✅ EXPERT ADVICE: After 3 consecutive rate limits, inform user and stop
          if (this.consecutiveRateLimitCount >= this.MAX_CONSECUTIVE_RATE_LIMITS) {
            logger.error('[LITE_ENGINE] Too many rate limits, stopping test', {
              testId: this.config.testId,
              consecutiveCount: this.consecutiveRateLimitCount,
              iteration: i,
            });

            this.emitCompletion(false, 'Site rate limiting - please wait and try again');
            await this.flushPendingGraphScreenshotUploads();
            return await this.buildResult(false, 'Site temporarily restricted access (HTTP 429). Please wait a few minutes and try again.');
          }

          // Exponential backoff: 5s → 10s → 20s (capped at MAX)
          const backoffMs = Math.min(
            this.BASE_RATE_LIMIT_BACKOFF_MS * Math.pow(2, this.consecutiveRateLimitCount - 1),
            this.MAX_RATE_LIMIT_BACKOFF_MS
          );

          logger.warn('[LITE_ENGINE] Rate limited, exponential backoff', {
            testId: this.config.testId,
            iteration: i,
            consecutiveCount: this.consecutiveRateLimitCount,
            backoffMs,
            sample: (diff.newNetworkErrors || []).slice(0, 2),
          });

          await this.page.waitForTimeout(backoffMs);
        } else {
          // Reset rate limit counter on any non-rate-limited outcome
          if (this.consecutiveRateLimitCount > 0) {
            logger.debug('[LITE_ENGINE] Rate limit counter reset', {
              testId: this.config.testId,
              previousCount: this.consecutiveRateLimitCount,
            });
            this.consecutiveRateLimitCount = 0;
          }
        }

        // 12. On error - log error (screenshots removed for Lite mode)
        if (outcome === 'execution_error' || outcome === 'validation_error' || outcome === 'critical_error') {
          logger.warn('[LITE_ENGINE] Error detected (screenshots disabled in Lite mode)', {
            testId: this.config.testId,
            iteration: i,
            outcome,
            error: execResult.error || (outcome === 'critical_error' ? 'Page appears blank/crashed' : 'Unknown error'),
          });
        }

        // 12a. CRITICAL ERROR RECOVERY - reload page
        if (outcome === 'critical_error') {
          logger.warn('[LITE_ENGINE] Critical error detected, reloading page', {
            testId: this.config.testId,
            iteration: i,
            elementsBefore: snapshotBefore.elements.length,
            elementsAfter: snapshotAfter.elements.length,
          });

          try {
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.networkTracker.waitForNetworkIdle(5000);
            await VisualStability.waitForStable(this.page);
          } catch (reloadError) {
            logger.error('[LITE_ENGINE] Failed to reload page after critical error', {
              error: reloadError instanceof Error ? reloadError.message : String(reloadError),
            });
          }
        }

        // 13. Record iteration
        this.state.recordIteration({
          iteration: i,
          decision,
          result: { outcome, ...execResult, stateDiff: diff },
          stateBefore: {
            url: snapshotBefore.url,
            elementCount: snapshotBefore.elements.length,
            pageErrors: pageErrorsBefore,
          },
          stateAfter: {
            url: snapshotAfter.url,
            elementCount: snapshotAfter.elements.length,
            pageErrors: pageErrorsAfter,
          },
        });

        // 14. Emit progress via WebSocket (with diff for frontend highlighting)
        this.emitIterationProgress(i, decision, outcome, diff);

        // ✅ NEW: Add action node to graph (like Pro)
        // Pass snapshotAfter for page node title when URL changes
        await this.addGraphActionNode(i, decision, execResult, snapshotBefore, snapshotAfter, diff);

        // 15. Log fallback usage
        if (execResult.usedFallback) {
          logger.info('[LITE_ENGINE] Used fallback', {
            testId: this.config.testId,
            iteration: i,
            info: execResult.fallbackInfo,
          });
        }

        // ✅ NEW: Trace iteration end (normal path)
        closeIteration({
          iteration: i,
          outcome,
          urlAfter: snapshotAfter.url,
          stateChanged: outcome === 'state_changed',
          hasErrors:
            diff.newPageErrors.length > 0 ||
            diff.newConsoleErrors.length > 0 ||
            (diff.newNetworkErrors?.length || 0) > 0,
        });
      }

      // Step limit reached
      logger.warn('[LITE_ENGINE] Step limit reached', {
        testId: this.config.testId,
        maxIterations: this.MAX_ITERATIONS,
      });
      this.emitCompletion(false, `Step limit reached (${this.MAX_ITERATIONS} iterations)`);
      await this.flushPendingGraphScreenshotUploads();
      return await this.buildResult(false, `Step limit reached (${this.MAX_ITERATIONS} iterations)`);
    } catch (error) {
      logger.error('[LITE_ENGINE] Error in main loop', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });

      this.emitCompletion(false, 'Engine error');
      await this.flushPendingGraphScreenshotUploads();
      return await this.buildResult(false, `Engine error: ${error instanceof Error ? error.message : 'Unknown'}`);
    } finally {
      // ✅ NEW: Always close trace writer (flushes pending writes)
      try {
        await this.traceWriter.close();
      } catch (closeError) {
        logger.error('[LITE_ENGINE] Failed to close trace writer', {
          testId: this.config.testId,
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      }
    }
  }

  /**
   * Emit iteration progress via WebSocket
   * Includes state diff for frontend element highlighting
   * ✅ FIX: Checks for cancellation/completion before emitting
   */
  private emitIterationProgress(
    iteration: number,
    decision: AIDecision,
    outcome: ActionOutcome,
    diff?: StateDiff
  ): void {
    // ✅ FIX: Skip if test is cancelled or completed
    if (this.isTestCompleted || this.isFinalizing) {
      return;
    }
    if (TestRunRegistry.shouldSilenceEvents(this.config.testId)) {
      return;
    }

    try {
      const progress = Math.round((iteration / this.MAX_ITERATIONS) * 70) + 20;
      const emoji =
        outcome === 'state_changed'
          ? '✅'
          : outcome === 'validation_error'
          ? '⚠️'
          : outcome === 'rate_limited'
          ? '⏳'
          : outcome === 'no_effect'
          ? '➖'
          : outcome === 'critical_error'
          ? '🔴'
          : '❌';

      this.progressEmitter.emit({
        progress: Math.min(90, progress),
        phase: 'execution',
        currentStep: `${emoji} ${decision.command.action}: ${decision.thought.slice(0, 50)}`,
        action: {
          type: decision.command.action,
          description: decision.thought,
          target: decision.command.ref,
        },
        completedSteps: iteration + 1,
        status: 'running',
        // Include diff summary for frontend highlighting
        diff: diff ? {
          urlChanged: diff.urlChanged,
          addedCount: diff.addedElements.length,
          removedCount: diff.removedRefs.length,
          changedRefs: diff.changedElements.map(e => e.ref),
          newErrors: diff.newPageErrors.length + diff.newConsoleErrors.length,
        } : undefined,
      });
    } catch (error) {
      logger.error('[LITE_ENGINE] Failed to emit progress', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - progress emission should never break the test
    }
  }

  /**
   * Emit finalizing state (progress=95, not 100)
   * ✅ FIX: progress=100 is now only sent after flush via emitFinalCompletion
   */
  private emitCompletion(success: boolean, reason: string): void {
    // ✅ FIX: Set isFinalizing flag BEFORE emitting
    this.isFinalizing = true;

    try {
      // Emit progress=95 to indicate "finalizing" state (not 100 yet)
      this.progressEmitter.emit({
        progress: 95,
        phase: 'finalization',
        currentStep: success ? `⏳ Finalizing: ${reason}` : `⏳ Stopping: ${reason}`,
        status: 'running', // Still running until truly done
      });
    } catch (error) {
      logger.error('[LITE_ENGINE] Failed to emit completion', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emit final completion (progress=100) AFTER all async operations are done
   * ✅ NEW: Called from buildResult after flush
   */
  private emitFinalCompletion(success: boolean, reason: string): void {
    try {
      this.progressEmitter.emit({
        progress: 100,
        phase: 'finalization',
        currentStep: success ? `✅ ${reason}` : `❌ ${reason}`,
        status: success ? 'completed' : 'failed',
      });
    } catch (error) {
      logger.error('[LITE_ENGINE] Failed to emit final completion', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Try direct URL fallback for register/login goals when stuck
   * Only called when stuck for 2+ iterations
   *
   * @param currentUrl - Current page URL
   * @returns Object with navigation status and final URL
   */
  private async tryDirectUrlFallback(currentUrl: string): Promise<{
    navigated: boolean;
    finalUrl: string;
    attemptedPath?: string;
  }> {
    const goalLower = this.config.goal.toLowerCase();

    // Only for register/login goals
    const isRegistrationGoal = /register|sign\s*up|create\s+account|registration|зарегистр|регистрац/i.test(goalLower);
    const isLoginGoal = /login|sign\s*in|log\s*in|вход|войти/i.test(goalLower);

    if (!isRegistrationGoal && !isLoginGoal) {
      return { navigated: false, finalUrl: currentUrl };
    }

    // Extract base URL
    let baseUrl: string;
    try {
      const url = new URL(currentUrl);
      baseUrl = `${url.protocol}//${url.host}`;
    } catch (error) {
      logger.error('[LITE_ENGINE] Failed to parse URL for fallback', {
        testId: this.config.testId,
        currentUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return { navigated: false, finalUrl: currentUrl };
    }

    // Define URL paths to try
    const pathsToTry = isRegistrationGoal
      ? ['/register', '/signup', '/sign-up', '/create-account', '/join', '/registration']
      : ['/login', '/signin', '/sign-in', '/auth/login', '/account/login'];

    // Try each path
    for (const path of pathsToTry) {
      const targetUrl = `${baseUrl}${path}`;

      logger.info('[LITE_ENGINE] Trying direct URL fallback', {
        testId: this.config.testId,
        targetUrl,
        reason: 'stuck',
        consecutiveStuckCount: this.state.getConsecutiveStuckCount(),
      });

      try {
        const response = await this.page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 10000,
        });

        const finalUrl = this.page.url();

        // Check if navigation was successful (not 404/error)
        if (response && response.ok() && finalUrl !== currentUrl) {
          logger.info('[LITE_ENGINE] Direct URL fallback successful', {
            testId: this.config.testId,
            attemptedPath: path,
            targetUrl,
            finalUrl,
            statusCode: response.status(),
          });

          // Wait a bit for page to load
          await this.page.waitForTimeout(1000);

          return {
            navigated: true,
            finalUrl,
            attemptedPath: path,
          };
        }

        logger.debug('[LITE_ENGINE] Direct URL fallback failed for path', {
          testId: this.config.testId,
          path,
          statusCode: response?.status(),
          finalUrl,
        });
      } catch (navError) {
        logger.debug('[LITE_ENGINE] Direct URL navigation error', {
          testId: this.config.testId,
          path,
          error: navError instanceof Error ? navError.message : String(navError),
        });
        // Continue to next path
        continue;
      }
    }

    // All paths failed
    logger.warn('[LITE_ENGINE] All direct URL fallback paths failed', {
      testId: this.config.testId,
      attemptedPaths: pathsToTry,
      currentUrl,
    });

    return { navigated: false, finalUrl: currentUrl };
  }

  /**
   * Build GoalContext for goal detection
   * Aggregates all relevant context for heuristic and AI evaluation
   */
  private buildGoalContext(
    snapshot: LiteSnapshot,
    iteration: number,
    stuckCheck: { stuck: boolean; reason?: string; suggestion?: string }
  ): GoalContext {
    // Build compact snapshot summary (max 50 elements)
    const snapshotSummary = buildSnapshotSummary(snapshot.elements);

    // Get recent errors (last 5, deduplicated)
    const recentErrors = this.collectedErrors
      .slice(-5)
      .map(e => ({ message: e.message.slice(0, 100), type: e.type }));

    return {
      goal: this.config.goal,
      page: {
        url: snapshot.url,
        title: snapshot.title,
      },
      snapshotSummary,
      history: this.state.getFormattedHistory(5), // Last 5 iterations
      lastOutcome: this.state.getLastOutcome(),
      stuckCheck,
      consecutiveStuckCount: this.state.getConsecutiveStuckCount(),
      recentErrors,
      iteration,
    };
  }

  /**
   * Add error with deduplication
   * ✅ FIX: Deduplicate by message+page+type (not just message)
   * This ensures same error on different pages is tracked separately
   */
  private addError(error: CollectedError): void {
    // Create composite key: message+page+type
    const errorKey = `${error.type}::${error.page}::${error.message}`;

    // Deduplicate by composite key
    if (this.seenErrorMessages.has(errorKey)) {
      return;
    }

    // Skip common false positives
    const lowerMsg = error.message.toLowerCase();
    if (
      lowerMsg.includes('required') && !lowerMsg.includes('error') ||
      lowerMsg.includes('please enter') ||
      lowerMsg.length < 5
    ) {
      return;
    }

    this.seenErrorMessages.add(errorKey);
    this.collectedErrors.push(error);

    logger.debug('[LITE_ENGINE] Error collected', {
      type: error.type,
      message: error.message.slice(0, 100),
      page: error.page.slice(0, 50),
      iteration: error.iteration,
    });
  }


  /**
   * Build final test result
   * ✅ NEW: Now includes graphData (like Pro) and Pro-grade errors[]
   * ✅ FIX: Emits progress=100 AFTER all finalization is complete
   * ✅ FIX: Captures final page screenshot for results (not during test execution)
   */
  private async buildResult(success: boolean, reason: string): Promise<LiteTestResult> {
    const duration = this.startTime > 0 ? Date.now() - this.startTime : 0;
    const iterations = this.state.getIterationCount();

    // ✅ FIX: Clean up cancellation state
    cleanupCancellationState(this.config.testId);

    // ✅ NEW: Add end node to graph and get full graph
    // ✅ FIX: Finalization flag should already be set by emitCompletion, but ensure it here
    this.isFinalizing = true;

    const endUpdate = this.graphBuilder.addEndNode(success, reason, {
      pagesVisited: 1, // Lite typically stays on one page
      actionsTaken: iterations,
      successRate: `${iterations > 0 ? Math.round((this.graphBuilder.getMetadata().completedSteps / iterations) * 100) : 0}%`,
      duration: `${Math.round(duration / 1000)}s`,
    });
    this.emitGraphUpdate(endUpdate, { force: true });

    // ✅ FIX: Mark test as completed AFTER emitting endUpdate (so endUpdate isn't blocked)
    this.isTestCompleted = true;

    // Get final graph data
    const graphData = this.graphBuilder.getFullGraph();

    // Collect network errors from tracker
    const networkErrors = this.networkTracker.getErrors();
    for (const netError of networkErrors) {
      this.addError({
        message: netError.error,
        page: netError.url,
        type: 'network',
        iteration: netError.iteration,
        timestamp: netError.timestamp,
        details: { method: netError.method, status: netError.status },
      });
    }

    // ✅ NEW: Capture final page screenshot for results (after test completion)
    let finalScreenshotUrl: string | undefined;
    try {
      if (this.page && !this.page.isClosed()) {
        const screenshotBuffer = await this.page.screenshot({
          fullPage: true,
          type: 'png',
          timeout: 5000,
        }).catch(() => null);

        if (screenshotBuffer) {
          const { uploadScreenshotBufferToStorage } = await import('@/services/storage/test-artifacts-storage.service');
          finalScreenshotUrl = await uploadScreenshotBufferToStorage(
            screenshotBuffer,
            this.config.testId,
            this.config.userId || 'anonymous',
            0 // Final screenshot index
          ).catch(() => undefined);

          if (finalScreenshotUrl) {
            logger.info('[LITE_ENGINE] Final screenshot captured and uploaded', {
              testId: this.config.testId,
              url: finalScreenshotUrl,
            });
          }
        }
      }
    } catch (screenshotError) {
      logger.warn('[LITE_ENGINE] Failed to capture final screenshot', {
        testId: this.config.testId,
        error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
      });
    }

    logger.info('[LITE_ENGINE] Building result with errors', {
      testId: this.config.testId,
      success,
      errorCount: this.collectedErrors.length,
      errorTypes: [...new Set(this.collectedErrors.map((e) => e.type))],
      hasFinalScreenshot: !!finalScreenshotUrl,
    });

    // ✅ FIX: Emit final progress=100 NOW that everything is truly done
    // This is after flush (called before buildResult) and after endUpdate
    this.emitFinalCompletion(success, reason);

    // ✅ NEW: Write run_end trace event
    this.traceWriter.write({
      stage: 'completion',
      eventType: 'run_end',
      spanId: this.traceWriter.generateSpanId(),
      parentSpanId: this.traceWriter.getRootSpanId(),
      payload: {
        success,
        reason,
        iterations,
        duration,
        durationSeconds: Math.round(duration / 1000),
        errorCount: this.collectedErrors.length,
        errorTypes: [...new Set(this.collectedErrors.map((e) => e.type))],
        hasFinalScreenshot: !!finalScreenshotUrl,
        endTime: new Date().toISOString(),
      },
    });

    // ✅ NEW: Close trace writer and upload to Supabase Storage
    try {
      await this.traceWriter.close();

      const traceFilePath = this.traceWriter.getFilePath();
      const runId = this.traceWriter.getRunId();
      const userId = this.config.userId;
      const testId = this.config.testId;

      // Validate UUIDs (trace_files requires UUID, not 'anonymous')
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isValidUserId = userId && UUID_REGEX.test(userId);
      const isValidTestId = testId && UUID_REGEX.test(testId);

      if (isValidUserId && isValidTestId) {
        // Check if file exists and has content
        const fs = await import('fs/promises');
        const path = await import('path');

        try {
          await fs.access(traceFilePath);
          const stats = await fs.stat(traceFilePath);

          if (stats.size > 0) {
            logger.info('[LITE_ENGINE] Uploading trace log to Storage', {
              testId,
              filePath: traceFilePath,
              fileSize: `${Math.round(stats.size / 1024)}KB`,
              runId,
            });

            const { uploadLiteTraceLogToStorage, insertTraceFileRecord } = await import(
              '@/services/storage/test-artifacts-storage.service'
            );

            const fileName = path.basename(traceFilePath);
            const { storagePath, fileSize } = await uploadLiteTraceLogToStorage(
              traceFilePath,
              userId,
              fileName
            );

            const { id } = await insertTraceFileRecord({
              userId,
              testId,
              fileName,
              storagePath,
              fileSize,
              browser: 'lite-trace-log',
              status: 'uploaded',
            });

            logger.info('[LITE_ENGINE] Trace log uploaded successfully', {
              testId,
              traceFileId: id,
              storagePath,
              runId,
            });

            // Clean up local file (best-effort)
            try {
              await fs.unlink(traceFilePath);
              logger.debug('[LITE_ENGINE] Local trace log deleted', { traceFilePath });
            } catch (cleanupError) {
              logger.warn('[LITE_ENGINE] Failed to delete local trace log', {
                traceFilePath,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              });
            }
          } else {
            logger.warn('[LITE_ENGINE] Trace log file is empty, skipping upload', {
              testId,
              traceFilePath,
            });
          }
        } catch (fileError) {
          logger.warn('[LITE_ENGINE] Trace log file not found or inaccessible, skipping upload', {
            testId,
            traceFilePath,
            error: fileError instanceof Error ? fileError.message : String(fileError),
          });
        }
      } else {
        logger.warn('[LITE_ENGINE] Invalid userId or testId (not UUID), skipping trace log upload', {
          testId,
          userId: userId?.substring(0, 20) || 'undefined',
          isValidUserId,
          isValidTestId,
        });
      }
    } catch (traceUploadError) {
      // Don't fail the test if trace upload fails
      logger.error('[LITE_ENGINE] Failed to upload trace log', {
        testId: this.config.testId,
        error: traceUploadError instanceof Error ? traceUploadError.message : String(traceUploadError),
      });
    }

    // Build screenshots array (only final screenshot for Lite mode)
    const screenshots: Array<{ url: string; screenshot: string }> = [];
    if (finalScreenshotUrl) {
      try {
        const currentUrl = this.page?.url() || this.config.url;
        screenshots.push({ url: currentUrl, screenshot: finalScreenshotUrl });
      } catch {
        // Fallback to config URL
        screenshots.push({ url: this.config.url, screenshot: finalScreenshotUrl });
      }
    }

    return {
      success,
      reason,
      iterations,
      history: this.state.getFormattedHistory(10), // Include last 10 iterations
      screenshots, // ✅ Lite mode: only final screenshot (after completion)
      duration, // Track actual execution time
      errors: this.collectedErrors, // ✅ Pro-grade error collection
      graphData, // ✅ Full graph like Pro
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GRAPH METHODS (like Pro)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add action node to graph and emit update
   * ✅ NEW: Full graph support like Pro
   * ✅ FIX: Now adds page node when URL changes (like Pro)
   */
  private async addGraphActionNode(
    iteration: number,
    decision: AIDecision,
    execResult: ExecutionResult,
    snapshotBefore: LiteSnapshot,
    snapshotAfter: LiteSnapshot, // ✅ FIX: Added for page node title
    diff: StateDiff
  ): Promise<void> {
    try {
      // ✅ FIX: Add page node if URL changed (like Pro)
      if (diff.urlChanged && diff.urlAfter) {
        // ✅ FIX: Clear guidance when URL changes (radical state change)
        if (this.currentGuidance) {
          logger.debug('[LITE_ENGINE] Clearing guidance due to URL change', {
            testId: this.config.testId,
            from: diff.urlBefore,
            to: diff.urlAfter,
            iteration,
          });
          this.currentGuidance = null;
        }

        const pageUpdate = this.graphBuilder.addPageNode(
          diff.urlAfter,
          'unknown', // pageType - can be enhanced later with page analysis
          {
            title: snapshotAfter.title,
          }
        );
        this.emitGraphUpdate(pageUpdate);
      }

      // Convert Lite types to Pro-compatible types for GraphBuilder
      const dynamicAction = toDynamicAction(decision, snapshotBefore);
      const graphResult = toGraphActionResult(execResult, diff);

      // Add action node to graph
      const graphUpdate = this.graphBuilder.addActionNode(dynamicAction, graphResult);

      // Emit the graph update via WebSocket (Lite mode - no screenshots)
      this.emitGraphUpdate(graphUpdate);
    } catch (error) {
      logger.error('[LITE_ENGINE] Failed to add graph action node', {
        testId: this.config.testId,
        iteration,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - graph updates should never break the test
    }
  }

  /**
   * Best-effort wait for pending operations to finish (no-op for Lite mode - no screenshots)
   * Kept for API compatibility but does nothing in Lite mode
   */
  private async flushPendingGraphScreenshotUploads(): Promise<void> {
    // Lite mode has no screenshot uploads - this is a no-op
    logger.debug('[LITE_ENGINE] No screenshot uploads to flush (Lite mode)', {
      testId: this.config.testId,
    });
  }

  /**
   * Emit graph update via WebSocket (like Pro)
   * ✅ NEW: Uses emitToUser for user-room delivery
   * ✅ FIX: Prevents emitting after test completion
   * ✅ FIX: Also checks TestRunRegistry for cancelled/completed state
   */
  private emitGraphUpdate(update: GraphUpdate, options?: { force?: boolean }): void {
    // ✅ FIX: Skip if test is already completed (prevents late events from async operations)
    if (this.isTestCompleted) {
      logger.debug('[LITE_ENGINE] Skipping graph emit - test already completed', {
        testId: this.config.testId,
      });
      return;
    }

    // ✅ FIX: Check TestRunRegistry for global cancellation/completion
    if (TestRunRegistry.shouldSilenceEvents(this.config.testId)) {
      logger.debug('[LITE_ENGINE] Skipping graph emit - registry says silence events', {
        testId: this.config.testId,
      });
      return;
    }

    // ✅ FIX: During finalization, block all non-forced graph updates (prevents spam from async uploads)
    if (this.isFinalizing && !options?.force) {
      logger.debug('[LITE_ENGINE] Skipping graph emit - finalizing', {
        testId: this.config.testId,
      });
      return;
    }

    // Skip if no userId (can't emit to user room)
    if (!this.config.userId) {
      logger.debug('[LITE_ENGINE] Skipping graph emit - no userId', {
        testId: this.config.testId,
      });
      return;
    }

    try {
      // Normalize update to prevent duplicates (like Pro)
      const normalized = this.normalizeGraphUpdate(update);

      // Check if we have any data to emit
      const hasIncrementalData = normalized.newNode || normalized.newEdge || normalized.updatedNode;
      const hasFullData = normalized.fullGraph;

      if (!hasIncrementalData && !hasFullData) {
        return; // Nothing to emit
      }

      // Build payload matching TestGraphUpdatePayload
      const payload = {
        testId: this.config.testId,
        type: normalized.type,
        mode: 'lite' as const, // ✅ NEW: Indicate Lite mode (no screenshots)
        data: {
          newNode: normalized.newNode,
          newEdge: normalized.newEdge,
          updatedNode: normalized.updatedNode,
          fullGraph: normalized.fullGraph,
        },
        timestamp: new Date().toISOString(),
      };

      // Emit to user room (like Pro)
      webSocketService.emitToUser(this.config.userId, 'test:graph-update', payload);

      logger.debug('[LITE_ENGINE] Graph update emitted', {
        testId: this.config.testId,
        type: normalized.type,
        hasNewNode: !!normalized.newNode,
        hasNewEdge: !!normalized.newEdge,
        hasUpdatedNode: !!normalized.updatedNode,
        hasFullGraph: !!normalized.fullGraph,
      });
    } catch (error) {
      logger.error('[LITE_ENGINE] Failed to emit graph update', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - graph updates should never break the test
    }
  }

  /**
   * Normalize graph update to prevent duplicate nodes/edges
   */
  private normalizeGraphUpdate(update: GraphUpdate): GraphUpdate {
    const normalized: GraphUpdate = { type: update.type };

    // For 'full' type, just pass through fullGraph
    if (update.type === 'full' && update.fullGraph) {
      normalized.fullGraph = update.fullGraph;
      // Also track all node/edge IDs
      update.fullGraph.nodes.forEach(n => this.emittedNodeIds.add(n.id));
      update.fullGraph.edges.forEach(e => this.emittedEdgeIds.add(e.id));
      return normalized;
    }

    // For incremental, check for duplicates
    if (update.newNode) {
      if (!this.emittedNodeIds.has(update.newNode.id)) {
        normalized.newNode = update.newNode;
        this.emittedNodeIds.add(update.newNode.id);
      }
    }

    if (update.newEdge) {
      if (!this.emittedEdgeIds.has(update.newEdge.id)) {
        normalized.newEdge = update.newEdge;
        this.emittedEdgeIds.add(update.newEdge.id);
      }
    }

    // updatedNode is always allowed (same node can be updated multiple times)
    if (update.updatedNode) {
      normalized.updatedNode = update.updatedNode;
    }

    return normalized;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW (Lite Autonomy v3): Task Plan Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize task plan at the start of the test
   */
  private async initializeTaskPlan(): Promise<void> {
    try {
      // Get initial snapshot for plan generation
      const initialSnapshot = await SnapshotCollector.collect(this.page);
      const snapshotSummary = initialSnapshot.elements
        .slice(0, 20)
        .map(el => `${el.tag}[${el.role}]: ${el.name || el.placeholder || ''}`.slice(0, 60));

      // Create task plan builder
      this.taskPlanBuilder = new TaskPlanBuilder(this.config.goal, this.config.testId);

      // Generate plan
      this.currentPlan = await this.taskPlanBuilder.generatePlan(
        this.config.url,
        snapshotSummary
      );

      if (this.currentPlan) {
        // Initialize progress evaluator
        this.planProgressEvaluator = new PlanProgressEvaluator(
          this.config.testId,
          this.currentPlan
        );

        logger.info('[LITE_ENGINE] Task plan initialized', {
          testId: this.config.testId,
          stepsCount: this.currentPlan.steps.length,
          isAIGenerated: this.currentPlan.isAIGenerated,
        });
      }
    } catch (error) {
      logger.warn('[LITE_ENGINE] Task plan initialization failed, continuing without plan', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Build task plan context for prompt
   */
  private buildTaskPlanContext(isStuck: boolean): TaskPlanContext | undefined {
    if (!this.currentPlan || !this.planProgressEvaluator) {
      return undefined;
    }

    const currentStep = this.planProgressEvaluator.getCurrentStep();
    const nextStep = this.planProgressEvaluator.getNextStep();
    const currentStepIndex = this.planProgressEvaluator.getCurrentStepIndex();

    if (!currentStep) {
      return undefined;
    }

    return {
      currentStep,
      nextStep: nextStep || undefined,
      currentStepIndex,
      totalSteps: this.currentPlan.steps.length,
      isStuckOnStep: isStuck,
    };
  }

  // Maximum validation error retries before giving up
  private readonly MAX_VALIDATION_RETRIES = 3;

  /**
   * Handle validation error - rollback to previous step
   * NOTE: Limited retries to avoid infinite loop on SPA edge cases
   */
  private async handleValidationError(
    modalInfo: ModalDismissInfo,
    currentUrl: string
  ): Promise<void> {
    if (!this.planProgressEvaluator) {
      return;
    }

    const currentStepIndex = this.planProgressEvaluator.getCurrentStepIndex();

    // Don't rollback if on first step
    if (currentStepIndex === 0) {
      logger.debug('[LITE_ENGINE] Validation error on first step, cannot rollback');
      return;
    }

    // Track attempt count
    const newAttemptCount = (this.validationErrorContext?.attemptCount || 0) + 1;

    // Check if we've exceeded max retries (SPA edge case prevention)
    if (newAttemptCount > this.MAX_VALIDATION_RETRIES) {
      const deadlockError = modalInfo.modalTextPreview?.slice(0, 100) || 'Repeated validation error';

      logger.warn('[LITE_ENGINE] Logic Deadlock detected - max validation retries exceeded', {
        testId: this.config.testId,
        attemptCount: newAttemptCount,
        maxRetries: this.MAX_VALIDATION_RETRIES,
        error: deadlockError,
      });

      // Record as Logic Deadlock in error collection
      // This indicates: plan too ambitious OR site requires specific data agent doesn't know
      this.addError({
        message: `Logic Deadlock: Repeated validation error after ${this.MAX_VALIDATION_RETRIES} attempts. Error: "${deadlockError}". Site may require specific data (valid email, phone, etc.) that agent cannot guess.`,
        page: currentUrl,
        type: 'validation', // Use validation type for semantic clarity
        iteration: this.state.getIterationCount(),
        timestamp: Date.now(),
        details: {
          deadlockType: 'validation_retry_exceeded',
          attemptCount: newAttemptCount,
          lastError: deadlockError,
          stepIndex: currentStepIndex,
        },
      });

      // Clear context to stop retry cycle
      this.validationErrorContext = null;
      return;
    }

    // Rollback step in memory
    const previousStepIndex = currentStepIndex - 1;
    this.planProgressEvaluator.setCurrentStepIndex(previousStepIndex);

    // Get last known good URL
    const lastGoodUrl = this.planProgressEvaluator.getLastKnownGoodUrl();

    // Set validation error context for prompt
    this.validationErrorContext = {
      errorText: modalInfo.modalTextPreview || 'Validation error',
      previousStepGoal: this.currentPlan?.steps[previousStepIndex]?.goal,
      attemptCount: newAttemptCount,
    };

    // Navigate back to clean state
    if (lastGoodUrl && lastGoodUrl !== currentUrl) {
      try {
        logger.info('[LITE_ENGINE] Rolling back to previous step', {
          testId: this.config.testId,
          fromStep: currentStepIndex,
          toStep: previousStepIndex,
          navigatingTo: lastGoodUrl,
        });

        await this.page.goto(lastGoodUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
      } catch (error) {
        logger.warn('[LITE_ENGINE] Failed to navigate back, trying goBack()', {
          testId: this.config.testId,
          error: error instanceof Error ? error.message : String(error),
        });

        try {
          await this.page.goBack({ timeout: 10000 });
        } catch {
          // Ignore navigation errors
        }
      }
    }
  }

  /**
   * Check if page is in transient state and handle accordingly
   * Returns true if should skip stuck detection
   */
  private async handleTransientState(snapshot: LiteSnapshot): Promise<boolean> {
    if (!snapshot.transientState?.isTransient) {
      // Reset transient wait tracking
      this.transientWaitStartTime = null;
      return false;
    }

    // Start tracking if not already
    if (!this.transientWaitStartTime) {
      this.transientWaitStartTime = Date.now();
      logger.debug('[LITE_ENGINE] Transient state detected, entering wait mode', {
        testId: this.config.testId,
        type: snapshot.transientState.type,
        ref: snapshot.transientState.ref,
      });
    }

    const waitTime = Date.now() - this.transientWaitStartTime;

    // Check if exceeded max wait
    if (waitTime >= this.MAX_TRANSIENT_WAIT_MS) {
      logger.warn('[LITE_ENGINE] Transient state exceeded max wait, treating as stuck', {
        testId: this.config.testId,
        waitTimeMs: waitTime,
        maxWaitMs: this.MAX_TRANSIENT_WAIT_MS,
      });
      this.transientWaitStartTime = null;
      return false; // Don't skip stuck detection
    }

    // Wait and retry
    await this.page.waitForTimeout(2000);
    return true; // Skip stuck detection
  }

  /**
   * Try micro-correction (page refresh) before expensive plan refine
   */
  private async tryMicroCorrection(): Promise<boolean> {
    if (this.microCorrectionAttempted) {
      return false; // Only try once per test
    }

    this.microCorrectionAttempted = true;

    logger.info('[LITE_ENGINE] Trying micro-correction (page refresh)', {
      testId: this.config.testId,
    });

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.page.waitForTimeout(2000);

      // Reset stuck counter
      this.state.resetConsecutiveStuckCount();

      return true;
    } catch (error) {
      logger.warn('[LITE_ENGINE] Micro-correction failed', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
