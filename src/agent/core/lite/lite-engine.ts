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
import { GoalDetector } from './analysis/goal-detector';
import { StateDiffComputer } from './analysis/state-diff';
import { StateValidator } from './analysis/state-validator';
import { ConsoleCollector } from './collectors/console-collector';
import { ErrorCollector } from './collectors/error-collector';
import { NetworkTracker } from './collectors/network-tracker';
import { SnapshotCollector } from './collectors/snapshot-collector';
import { VisualStability } from './collectors/visual-stability';
import { ActionExecutor } from './execution/action-executor';
import { toDynamicAction, toGraphActionResult } from './graph/lite-graph-adapter';
import { LiteState } from './lite-state';
import type { AIDecision, ActionOutcome, CollectedError, ExecutionResult, GoalContext, GoalGuidance, LiteEngineConfig, LiteSnapshot, LiteTestResult, StateDiff } from './lite-types';
import { LitePromptBuilder } from './prompt/lite-prompt-builder';

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

  constructor(page: Page, config: LiteEngineConfig) {
    this.page = page;
    this.config = config;
    this.state = new LiteState();
    this.executor = new ActionExecutor(page);
    this.networkTracker = new NetworkTracker(page);
    this.consoleCollector = new ConsoleCollector(page);
    this.graphBuilder = new GraphBuilder(); // ✅ NEW: Initialize graph builder
    this.goalDetector = new GoalDetector(config.goal, config.testId); // ✅ NEW: Initialize goal detector with testId for AI fallback

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
    });
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
    }

    // ✅ NEW: Emit start node to graph (like Pro)
    const startUpdate = this.graphBuilder.addStartNode();
    this.emitGraphUpdate(startUpdate);

    try {
      for (let i = 0; i < this.MAX_ITERATIONS; i++) {
        logger.debug('[LITE_ENGINE] Starting iteration', { iteration: i });

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

        // 2b. Build GoalContext for this iteration
        const goalContext = this.buildGoalContext(snapshotBefore, i, stuckCheck);

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
              const auditResult = await withCancellation(
              this.config.testId,
              this.goalDetector.auditDone(goalContext, this.state.getLastOutcome()),
              'goalDetector.auditDone'
            );

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

        // 4. Build prompt with stuck warning + progress signals + AI guidance + contextual hints
        const prompt = LitePromptBuilder.build({
          goal: this.config.goal,
          snapshot: SnapshotCollector.format(snapshotBefore),
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
        });

        // 5. Ask AI (returns JSON command, not code)
        // ✅ FIX: Wrap AI call with cancellation support
        const decision = await withCancellation(
          this.config.testId,
          LitePromptBuilder.askAI(prompt),
          'LitePromptBuilder.askAI'
        );

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
            continue;
          }

          try {
            logger.info('[LITE_ENGINE] AI claims done, calling auditor for validation', {
              testId: this.config.testId,
              thought: decision.thought?.slice(0, 50),
            });

            const auditResult = await withCancellation(
              this.config.testId,
              this.goalDetector.auditDone(goalContext, decision.thought),
              'goalDetector.auditDone (AI done path)'
            );

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
            continue;
          }
        }

        // 6. Execute command (safe switch/case, with fuzzy fallback)
        // ✅ Pass dynamic entryPointKeywords from AI-generated strategy for modal detection
        const parsedGoal = this.goalDetector.getParsedGoal();
        const execResult = await this.executor.execute(
          decision.command, // JSON command, not code
          snapshotBefore,
          { entryPointKeywords: parsedGoal.entryPointKeywords }
        );

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

        // 11. Validate outcome (with element counts for critical error detection)
        const outcome = StateValidator.validate(
          diff,
          execResult.error,
          snapshotBefore.elements.length,
          snapshotAfter.elements.length
        );

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
}
