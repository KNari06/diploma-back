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
import { AdaptiveTimeoutConfig, computeAdaptiveTimeouts, LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { Page } from 'playwright';
import { checkTestCancelled, cleanupCancellationState, withCancellation } from '../../playwright/utils/test-cancellation-checker';
import { ClarificationService } from '../../utils/context/clarification.service';
import { buildSnapshotSummary } from './analysis/ai-goal-evaluator';
import { isDownloadText, isFileUploadTarget, isPaymentContext } from './analysis/clarification-gates';
import { classifyField } from './analysis/field-classifier';
import { FlowStateDetector } from './analysis/flow-state-detector';
import { FunnelAnalyzer, FunnelPhase } from './analysis/funnel-analyzer';
import { GoalDetector } from './analysis/goal-detector';
import { GoalExpander, type ExpandedGoal } from './analysis/goal-expander';
import { HybridSemanticWeightCalculator, matchesKeyword } from './analysis/hybrid-semantic-weight';
import { extractPageCredentials, parseCredentialsFromResponse } from './analysis/page-credentials-extractor';
import { PlanProgressEvaluator } from './analysis/plan-progress-evaluator';
import { StateDiffComputer } from './analysis/state-diff';
import { StateDriftAuditor } from './analysis/state-drift-auditor';
import { StateValidator } from './analysis/state-validator';
import { TargetAudit, type RankedCandidate } from './analysis/target-audit';
import { TaskPlanBuilder, type TaskPlan } from './analysis/task-plan-builder';
import { ConsoleCollector } from './collectors/console-collector';
import { ErrorCollector } from './collectors/error-collector';
import { NetworkTracker } from './collectors/network-tracker';
import { SnapshotCollector } from './collectors/snapshot-collector';
import { VisualStability } from './collectors/visual-stability';
import { ActionExecutor } from './execution/action-executor';
import { PageWatcher } from './execution/page-watcher';
import { MultiAgentOrchestrator } from './agents/multi-agent-orchestrator';
import type { MultiAgentInput } from './agents/types';
import { toDynamicAction, toGraphActionResult } from './graph/lite-graph-adapter';
import { LiteState } from './lite-state';
import type { AICommand, AIDecision, ActionOutcome, BlacklistedAction, CollectedError, ExecutionResult, FlowState, FunnelPhaseType, GoalContext, GoalGuidance, IterationRecord, LiteElement, LiteEngineConfig, LiteSnapshot, LiteTestResult, ModalDismissInfo, RecoveryPoint, StateDiff, StateDriftAuditResult, VisionHints } from './lite-types';
import type { PageVisit, ActionResult, DynamicAction, PageType } from '@/agent/types/intelligent-testing.types';
import { LitePromptBuilder, type TaskPlanContext, type ValidationErrorContext } from './prompt/lite-prompt-builder';
import { PromptSanitizer } from './security/prompt-sanitizer';
import { LiteTraceWriter } from './trace/lite-trace-writer';
import { WorkspaceMemoryService } from '@/services/ai/memory/workspace-memory.service';
import { WorkspaceService } from '@/services/core/workspace.service';

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
  private flowStateDetector: FlowStateDetector; // ✅ Task #21: Multi-step flow tracking
  private currentFlowState: FlowState | null = null; // ✅ Task #21: Current flow state
  private traceWriter: LiteTraceWriter; // ✅ NEW: Always-on JSONL trace for debugging
  private semanticWeightCalculator: HybridSemanticWeightCalculator; // ✅ NEW: Hybrid semantic weight (Manus Style)
  private pageWatcher: PageWatcher | null = null; // ✅ Phase A: Multi-tab/popup detection
  private startTime: number = 0;
  private adaptiveTimeouts: AdaptiveTimeoutConfig | null = null; // ✅ TASK 7: Adaptive timeouts based on site speed

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
  private lastGoalOrientedSummary: string | null = null; // ✅ NEW: Goal-Oriented Summary from last iteration (Hybrid Semantic Weight)
  private skillsContext = ''; // Workspace skills from KB (loaded once at start)

  // ═══════════════════════════════════════════════════════════════════════════
  // L2-L4-L5 MANUS ALIGNMENT PROPERTIES
  // ═══════════════════════════════════════════════════════════════════════════
  private expandedGoal: ExpandedGoal | null = null;
  private currentFunnelPhase: FunnelPhase = FunnelPhase.DISCOVERY;
  private previousFunnelPhase: FunnelPhase | null = null;
  private lastGoalRefinementTime: number = 0;
  private readonly _GOAL_REFINEMENT_COOLDOWN_MS = 5000; // Min time between refinements (reserved for future use)
  private consecutiveNoEffectCount: number = 0;
  private activeFrame: import('playwright').Frame | null = null; // L5: Store active frame for iframe execution

  // ✅ P0 FEATURE: Proactive Vision Detection
  // Track pages where we've already attempted vision to avoid redundant calls
  private visionAttemptedForPage = new Set<string>(); // URL → attempted

  // Multi-Agent Brain: Observer → Strategist → Actor orchestrator
  private multiAgentOrchestrator: MultiAgentOrchestrator | null = null;
  // Manus-style: Store previous snapshot for spatial diff
  private previousFormattedSnapshot: string | null = null;
  /** Last iteration's console/network errors for Supervisor blocker detection */
  private lastConsoleErrors: string[] = [];
  private lastNetworkErrors: import('./collectors/network-tracker').NetworkError[] = [];
  private lastValidationErrors: import('./lite-types').NetworkValidationError[] = [];
  // Store previous snapshot for state drift auditor (lost-field detection needs real elements)
  private lastSnapshotForAuditor: LiteSnapshot | null = null;
  // Manus-style: Store last expectedOutcome for expectation validation loop
  private lastExpectedOutcome: string | undefined;

  // ═══════════════════════════════════════════════════════════════════════════
  // L6: PAGE CREDENTIALS EXTRACTION (one-time for login goals)
  // PHASE 0.3: Credential auto-fill state machine
  // ═══════════════════════════════════════════════════════════════════════════
  private pageCredentialsAttempted = false; // Only try once per test
  private credentialClarificationAttempted = false; // Only ask user once per test
  private credentialFillState: 'idle' | 'filling_username' | 'filling_password' | 'submitting' | 'done' = 'idle';
  // ✅ FIX P0: Auto-fill timeout tracking to prevent infinite loops
  private autoFillIterationCount = 0;
  private readonly MAX_AUTO_FILL_ITERATIONS = 3; // Max consecutive auto-fill attempts
  private staleSnapshotGuardDone = false; // Run stale-snapshot re-wait only once after submit

  // ═══════════════════════════════════════════════════════════════════════════
  // L7: ADDITIONAL CLARIFICATION GATES
  // ═══════════════════════════════════════════════════════════════════════════
  private paymentApprovalAsked = false; // Only ask once per test
  private fileUploadApprovalAskedForRefs = new Set<string>(); // Track which file inputs we've asked about
  private skippedFileUploadRefs = new Set<string>(); // Track file upload refs user chose to skip
  private approvedExternalOrigins = new Set<string>(); // Cache approved external origins
  private deniedExternalOrigins = new Set<string>(); // Cache denied external origins (avoid repeated prompts)
  private downloadApprovalAskedForRefs = new Set<string>(); // Track which download refs we've asked about
  private deniedDownloadRefs = new Set<string>(); // Track denied download refs (avoid executing later)

  constructor(page: Page, config: LiteEngineConfig) {
    this.page = page;
    this.config = config;
    this.state = new LiteState();
    this.executor = new ActionExecutor(page);
    this.networkTracker = new NetworkTracker(page);
    this.consoleCollector = new ConsoleCollector(page);
    this.graphBuilder = new GraphBuilder(); // ✅ NEW: Initialize graph builder
    this.goalDetector = new GoalDetector(config.goal, config.testId); // ✅ NEW: Initialize goal detector with testId for AI fallback
    this.flowStateDetector = new FlowStateDetector(config.testId, config.goal); // ✅ Task #21: Initialize flow state detector
    this.traceWriter = new LiteTraceWriter({ testId: config.testId }); // ✅ NEW: Initialize trace writer
    this.semanticWeightCalculator = new HybridSemanticWeightCalculator(config.goal, config.testId); // ✅ NEW: Initialize hybrid semantic weight calculator

    // Multi-Agent Brain: Initialize orchestrator if enabled
    if (LITE_ENGINE_FLAGS.enableMultiAgentBrain) {
      this.multiAgentOrchestrator = new MultiAgentOrchestrator();
    }

    // WebSocket progress
    this.progressEmitter = new TestProgressEmitter(
      config.testId,
      config.browser || 'chrome',
      config.userId,
      config.chatSessionId
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

  // ═══════════════════════════════════════════════════════════════════════════
  // L4 TARGET AUDIT GUARD (MANUS STYLE)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply L4 Target Audit Guard before command execution.
   * Validates AI-chosen ref against expanded goal keywords.
   * If element doesn't match goal, triggers AI audit with top candidates.
   *
   * @param command AI command with proposed ref
   * @param snapshot Current page snapshot
   * @returns Command with potentially corrected ref
   */
  private async applyTargetAuditGuard(
    command: AICommand,
    snapshot: LiteSnapshot
  ): Promise<AICommand> {
    // Skip if no expanded goal or no ref
    if (!this.expandedGoal || !command.ref) {
      return command;
    }

    // Skip for wait commands (no element interaction)
    if (command.action === 'wait') {
      return command;
    }

    const targetElement = snapshot.elements.find(el => el.ref === command.ref);
    if (!targetElement) {
      return command; // Element not found, let executor handle
    }

    // Check if element is relevant to goal
    const isRelevant = this.checkElementRelevance(targetElement);

    if (isRelevant) {
      return command; // Element passes relevance check
    }

    // Element not relevant → Trigger L4 Audit
    logger.warn('[L4_GUARD] Command ref not relevant to goal, triggering audit', {
      testId: this.config.testId,
      ref: command.ref?.slice(0, 20),
      elementName: targetElement.name?.slice(0, 30),
    });

    // Get top candidates ranked by composite score
    const topCandidates = this.getTopRankedCandidates(snapshot, command.action, 5);

    // Ask AI to pick correct ref
    const auditResult = await TargetAudit.audit(
      command,
      topCandidates,
      this.expandedGoal,
      this.currentFunnelPhase
    );

    if (auditResult.correctedRef && auditResult.correctedRef !== command.ref) {
      logger.info('[L4_GUARD] Corrected ref via audit', {
        testId: this.config.testId,
        original: command.ref?.slice(0, 20),
        corrected: auditResult.correctedRef?.slice(0, 20),
        reason: auditResult.reason?.slice(0, 50),
        confidence: auditResult.confidence,
      });
      return { ...command, ref: auditResult.correctedRef };
    }

    return command;
  }

  /**
   * Check if element is relevant to expanded goal.
   * Returns true if element matches any goal keyword.
   * Returns false if element matches negative keywords.
   *
   * @param element Element to check
   * @returns True if element is relevant to goal
   */
  private checkElementRelevance(element: LiteElement): boolean {
    if (!this.expandedGoal) return true; // No expanded goal, trust AI

    const text = element.name || '';

    // Check against negative keywords first (quick reject)
    // ✅ FIX: Use token/boundary matching instead of includes() to prevent false positives
    for (const kw of this.expandedGoal.negativeKeywords) {
      if (matchesKeyword(text, kw, true)) {
        return false; // Matches dead-end keyword
      }
    }

    // Check against allKeywords
    // ✅ FIX: Use token/boundary matching instead of includes() to prevent false positives
    for (const kw of this.expandedGoal.allKeywords) {
      if (matchesKeyword(text, kw, true)) {
        return true; // Matches goal keyword
      }
    }

    // Gray zone - not in either list
    // For critical actions (submit, confirm), be strict
    const criticalActions = ['submit', 'confirm', 'pay', 'order', 'checkout'];
    if (criticalActions.some(a => matchesKeyword(text, a, true))) {
      return true; // Critical actions always pass (safety)
    }

    return false; // Default: not relevant, trigger audit
  }

  /**
   * Check if URL change is significant (different path).
   * Query parameter changes are not considered significant.
   *
   * @param before URL before action
   * @param after URL after action
   * @returns True if path changed
   */
  private isSignificantUrlChange(before: string, after: string): boolean {
    try {
      const beforeUrl = new URL(before);
      const afterUrl = new URL(after);

      // Different path = significant
      if (beforeUrl.pathname !== afterUrl.pathname) {
        return true;
      }

      // Same path with different query = not significant
      return false;
    } catch {
      // If URL parsing fails, compare as strings
      return before !== after;
    }
  }

  /**
   * Get top ranked candidate elements for L4 audit.
   * Ranks elements by composite score: heuristic * funnel * zIndex * goalRelevance.
   *
   * @param snapshot Current page snapshot
   * @param actionType Action type (click, fill, etc.)
   * @param count Number of candidates to return
   * @returns Array of ranked candidates
   */
  private getTopRankedCandidates(
    snapshot: LiteSnapshot,
    actionType: string,
    count: number
  ): RankedCandidate[] {
    // Filter by action type
    const eligible = snapshot.elements.filter(el => {
      if (actionType === 'click') {
        return ['button', 'a', 'input'].includes(el.tag) || el.role === 'button' || el.role === 'link';
      }
      if (actionType === 'fill') {
        return el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox';
      }
      if (actionType === 'select') {
        return el.tag === 'select' || el.role === 'combobox' || el.role === 'listbox';
      }
      return true;
    });

    // Calculate composite score for each element
    const scored: RankedCandidate[] = eligible.map(el => {
      const heuristicResult = this.semanticWeightCalculator.calculateHeuristic(el);
      const heuristicWeight = heuristicResult.weight;

      const elementCategory = FunnelAnalyzer.categorizeElement(el);
      const funnelMultipliers = FunnelAnalyzer.getMultipliers(this.currentFunnelPhase);
      const funnelMultiplier = funnelMultipliers[elementCategory] ?? 1.0;

      const zIndexBoost = el.isTopMostAtCenter ? 1.2 : (el.computedZIndex ?? 0) > 0 ? 1.1 : 1.0;
      const goalRelevance = this.checkElementRelevance(el) ? 1.5 : 1.0;

      const score = heuristicWeight * funnelMultiplier * zIndexBoost * goalRelevance;

      return {
        ref: el.ref,
        name: el.name || '',
        tag: el.tag,
        score,
        breakdown: {
          heuristic: heuristicWeight,
          funnelMultiplier,
          zIndexBoost,
          goalRelevance,
        },
      };
    });

    // Sort by score descending, take top N
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // L5 VISION ESCALATION (MANUS STYLE)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if we should escalate to Vision mode.
   * Triggers:
   * 1. Very few interactive elements (< 5) after stability wait
   * 2. Consecutive "No Effect" actions (>= 3)
   * 3. Canvas-heavy page (> 50% coverage)
   *
   * @param snapshot Current page snapshot
   * @returns True if vision escalation should be triggered
   */
  private shouldEscalateToVision(snapshot: LiteSnapshot): boolean {
    // Trigger 1: Very few interactive elements
    if (snapshot.elements.length < 5) {
      logger.info('[L5_VISION] Trigger: too few elements', {
        testId: this.config.testId,
        elementCount: snapshot.elements.length,
      });
      return true;
    }

    // Trigger 2: Consecutive No Effect
    if (this.consecutiveNoEffectCount >= LITE_ENGINE_FLAGS.visionEscalationThreshold) {
      logger.info('[L5_VISION] Trigger: consecutive no effect', {
        testId: this.config.testId,
        count: this.consecutiveNoEffectCount,
        threshold: LITE_ENGINE_FLAGS.visionEscalationThreshold,
      });
      return true;
    }

    // Trigger 3: Canvas-heavy page
    const canvasCoverage = this.detectCanvasCoverage(snapshot);
    if (canvasCoverage > 0.5) {
      logger.info('[L5_VISION] Trigger: canvas covers >50%', {
        testId: this.config.testId,
        coverage: canvasCoverage.toFixed(2),
      });
      return true;
    }

    return false;
  }

  /**
   * Detect canvas coverage on page.
   * Returns fraction of viewport covered by canvas elements.
   *
   * @param snapshot Current page snapshot
   * @returns Canvas coverage (0-1)
   */
  private detectCanvasCoverage(snapshot: LiteSnapshot): number {
    // Look for canvas elements in snapshot (they might have bounds)
    const canvasElements = snapshot.elements.filter(el => el.tag === 'canvas');
    if (canvasElements.length === 0) return 0;

    // Sum up canvas areas
    let totalCanvasArea = 0;
    for (const canvas of canvasElements) {
      if (canvas.bounds) {
        totalCanvasArea += canvas.bounds.width * canvas.bounds.height;
      }
    }

    // Estimate viewport size (use first element's context or default)
    const viewportWidth = 1280;
    const viewportHeight = 720;
    const viewportArea = viewportWidth * viewportHeight;

    return totalCanvasArea / viewportArea;
  }

  /**
   * Try vision fallback when DOM is weak.
   * Takes screenshot, analyzes with GPT-4o Vision, returns hints.
   *
   * @returns Vision hints or null if failed
   */
  private async tryVisionFallback(): Promise<VisionHints | null> {
    try {
      logger.info('[L5_VISION] Starting vision fallback', {
        testId: this.config.testId,
      });

      // 1. Take screenshot
      const screenshot = await this.page.screenshot({ type: 'png' });
      const base64 = screenshot.toString('base64');

      // 2. Call vision analyzer (import dynamically to avoid circular deps)
      const { analyzeScreenshotWithVision } = await import('@/services/ai/analysis/vision-analyzer.service');
      const analysis = await analyzeScreenshotWithVision(base64, {
        scope: this.config.goal,
        url: this.page.url(),
      });

      // 3. Cross-check: Vision sees element but DOM doesn't - populate conflicts
      const conflicts = await this.crossCheckVisionWithDOM(analysis);

      // 4. Convert to hints (with conflicts from cross-check)
      const hints: VisionHints = {
        visibleButtons: analysis.elements
          .filter(e => e.isCTA)
          .map(e => ({ text: e.text, location: e.location })),
        formFields: analysis.elements
          .filter(e => e.type === 'input')
          .map(e => ({ type: e.type, label: e.text })),
        modals: (analysis.modals || []).map(m => ({
          description: m.description,
          hasCloseButton: m.hasCloseButton,
        })),
        layoutHint: analysis.layout,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      };

      logger.info('[L5_VISION] Vision fallback completed', {
        testId: this.config.testId,
        buttonCount: hints.visibleButtons.length,
        fieldCount: hints.formFields.length,
        modalCount: hints.modals.length,
      });

      return hints;
    } catch (error) {
      logger.error('[L5_VISION] Vision fallback failed', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * WORKSTREAM 5: Cross-check Vision results with DOM, Shadow DOM, and Iframes.
   * Returns conflicts (disabled/covered/hidden/not_found) for prompt guidance.
   *
   * @param visionAnalysis Vision analysis result
   * @returns Array of conflicts for VisionHints
   */
  private async crossCheckVisionWithDOM(visionAnalysis: {
    elements: Array<{ text: string; isCTA?: boolean }>;
  }): Promise<Array<{
    visionText: string;
    domRef?: string;
    domName?: string;
    issue: 'disabled' | 'covered' | 'hidden' | 'not_found';
    note: string;
  }>> {
    const conflicts: Array<{
      visionText: string;
      domRef?: string;
      domName?: string;
      issue: 'disabled' | 'covered' | 'hidden' | 'not_found';
      note: string;
    }> = [];

    for (const element of visionAnalysis.elements.filter(e => e.isCTA)) {
      const buttonText = element.text;
      if (!buttonText || buttonText.length < 2) continue;

      try {
        // Check if element exists in main DOM
        const mainDomLocator = this.page.getByText(buttonText, { exact: false });
        const existsInMainDom = (await mainDomLocator.count()) > 0;

        if (existsInMainDom) {
          // Element found - check for disabled/covered/hidden states
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const elementState = await mainDomLocator.first().evaluate((el: any) => {
            const htmlEl = el;
            const rect = htmlEl.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            // Check if disabled
            const isDisabled =
              htmlEl.disabled ||
              htmlEl.getAttribute('aria-disabled') === 'true' ||
              htmlEl.classList?.contains('disabled');

            // Check if visible in viewport
            // @ts-expect-error - window available in browser context
            const computedStyle = window.getComputedStyle(htmlEl);
            // @ts-expect-error - window available in browser context
            const isOffscreen = rect.bottom < 0 || rect.top > window.innerHeight;
            const isHidden =
              rect.width === 0 ||
              rect.height === 0 ||
              isOffscreen ||
              computedStyle.display === 'none' ||
              computedStyle.visibility === 'hidden' ||
              parseFloat(computedStyle.opacity || '1') < 0.1;

            // Check if covered by another element
            // @ts-expect-error - document available in browser context
            const topElement = document.elementFromPoint(centerX, centerY);
            const isCovered = topElement !== el && !el.contains(topElement);

            // Get ref if available
            const ref = htmlEl.getAttribute('data-agent-ref') || undefined;

            return { isDisabled, isHidden, isCovered, ref, name: htmlEl.textContent?.slice(0, 30) };
          });

          if (elementState.isDisabled) {
            conflicts.push({
              visionText: buttonText,
              domRef: elementState.ref,
              domName: elementState.name,
              issue: 'disabled',
              note: 'Vision sees this button, but DOM reports it as disabled. Do NOT click; look for alternate path.',
            });
            logger.debug('[L5_VISION_CONFLICT] Disabled element', { text: buttonText });
          } else if (elementState.isCovered) {
            conflicts.push({
              visionText: buttonText,
              domRef: elementState.ref,
              domName: elementState.name,
              issue: 'covered',
              note: 'Vision sees this button, but another element is covering it. Try closing overlay or scrolling.',
            });
            logger.debug('[L5_VISION_CONFLICT] Covered element', { text: buttonText });
          } else if (elementState.isHidden) {
            conflicts.push({
              visionText: buttonText,
              domRef: elementState.ref,
              domName: elementState.name,
              issue: 'hidden',
              note: 'Vision sees this button, but DOM reports it as hidden. Try scrolling or waiting for animation.',
            });
            logger.debug('[L5_VISION_CONFLICT] Hidden element', { text: buttonText });
          }
          // No conflict - element is good
          continue;
        }

        logger.debug('[L5_VISION] Element visible in Vision but not in main DOM', {
          testId: this.config.testId,
          text: buttonText,
        });

        // Try Shadow DOM
        const shadowFound = await this.tryFindInShadowDOM(buttonText);
        if (shadowFound) {
          logger.info('[L5_VISION] Found in Shadow DOM', { text: buttonText });
          continue;
        }

        // Try Iframes
        const iframeFound = await this.tryFindInIframes(buttonText);
        if (iframeFound) {
          logger.info('[L5_VISION] Found in Iframe', { text: buttonText });
          continue;
        }

        // Not found anywhere
        conflicts.push({
          visionText: buttonText,
          issue: 'not_found',
          note: 'Vision sees this button, but not found in DOM, Shadow DOM, or Iframes. Element may require coordinate-based interaction.',
        });
        logger.warn('[L5_VISION_CONFLICT] Element not found', {
          text: buttonText,
          suggestion: 'May need coordinate-based click',
        });
      } catch {
        // Skip on error (element might have special characters)
        continue;
      }
    }

    return conflicts;
  }

  /**
   * Search for element text in Shadow DOM.
   *
   * @param text Text to search for
   * @returns True if found
   */
  private async tryFindInShadowDOM(text: string): Promise<boolean> {
    try {
      const found = await this.page.evaluate((searchText: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function findInNode(node: any): boolean {
          if (node.nodeType === 1 && node.textContent?.includes(searchText)) {
            return true;
          }
          if (node.shadowRoot) {
            return findInNode(node.shadowRoot);
          }
          for (const child of node.children || []) {
            if (findInNode(child)) return true;
          }
          return false;
        }
        // @ts-ignore - DOM types available in browser context
        return findInNode(document.body);
      }, text);

      return found;
    } catch {
      return false;
    }
  }

  /**
   * Search for element text in all iframes.
   * If found, stores the frame in this.activeFrame for execution.
   *
   * @param text Text to search for
   * @returns True if found
   */
  private async tryFindInIframes(text: string): Promise<boolean> {
    const frames = this.page.frames();

    for (const frame of frames) {
      if (frame === this.page.mainFrame()) continue;

      try {
        const locator = frame.getByText(text, { exact: false });
        const count = await locator.count();

        if (count > 0) {
          // ✅ L5: Store frame for execution
          this.activeFrame = frame;
          logger.debug('[L5_IFRAME] Found element in iframe, will execute in frame context', {
            testId: this.config.testId,
            text: text.slice(0, 30),
            frameUrl: frame.url(),
          });
          return true;
        }
      } catch {
        // Frame may be detached, skip
        continue;
      }
    }

    return false;
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

    // Load workspace skills for AI context (best-effort, 5s timeout to avoid blocking test start)
    if (this.config.userId) {
      try {
        const skillsPromise = (async () => {
          const workspaceId = await WorkspaceService.getActiveWorkspaceForUser(this.config.userId!);
          if (workspaceId) {
            return await WorkspaceMemoryService.getMemoryForContext(workspaceId, 1500);
          }
          return '';
        })();
        const skillsTimeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), 5000));
        this.skillsContext = await Promise.race([skillsPromise, skillsTimeout]);
        if (this.skillsContext) {
          logger.info('[LITE_ENGINE] Skills loaded for AI context', {
            testId: this.config.testId,
            skillsLength: this.skillsContext.length,
          });
        }
      } catch (err) {
        logger.warn('[LITE_ENGINE] Failed to load skills (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      return await Promise.race([this.runLoop(), timeoutPromise]);
    } catch (error) {
      if (error instanceof Error && error.message === 'TIMEOUT') {
        logger.error('[LITE_ENGINE] Time limit exceeded', {
          testId: this.config.testId,
          timeout: timeoutMs,
        });
        this.emitCompletion(false, `Time limit exceeded (${Math.round(timeoutMs / 60000)} min)`);

        // Flush pending uploads before returning (so graphData has URLs)
        await this.flushPendingGraphScreenshotUploads();

        return await this.buildResult(false, `Time limit exceeded (${Math.round(timeoutMs / 60000)} minutes)`);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // HARDENING: Convert unexpected errors into a safe terminal path.
      // This guarantees buildResult() runs (end node, final progress, watcher dispose).
      // ═══════════════════════════════════════════════════════════════════════
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[LITE_ENGINE] Unexpected error (terminating safely)', {
        testId: this.config.testId,
        error: errorMessage,
      });

      this.emitCompletion(false, 'Engine error');
      await this.flushPendingGraphScreenshotUploads();

      return await this.buildResult(false, `Engine error: ${errorMessage}`);
    } finally {
      // P1: Cleanup all collections to prevent memory leaks
      this.cleanup();
    }
  }

  /**
   * P1: Cleanup all collections to prevent memory leaks
   * Called at the end of test execution
   */
  private cleanup(): void {
    this.emittedNodeIds.clear();
    this.emittedEdgeIds.clear();
    this.seenErrorMessages.clear();
    this.visionAttemptedForPage.clear();
    this.fileUploadApprovalAskedForRefs.clear();
    this.skippedFileUploadRefs.clear();
    this.approvedExternalOrigins.clear();
    this.deniedExternalOrigins.clear();
    this.downloadApprovalAskedForRefs.clear();
    this.deniedDownloadRefs.clear();
    this.skillsContext = '';
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

    // ═══════════════════════════════════════════════════════════════════════════
    // L2 MANUS: Initialize GoalExpander (one-time call before loop)
    // ═══════════════════════════════════════════════════════════════════════════
    if (LITE_ENGINE_FLAGS.enableGoalExpander) {
      try {
        this.expandedGoal = await GoalExpander.expand(this.config.goal);
        // Update semantic weight calculator with expanded goal
        this.semanticWeightCalculator = new HybridSemanticWeightCalculator(
          this.expandedGoal,
          this.config.testId
        );
        logger.info('[L2_INIT] GoalExpander initialized', {
          testId: this.config.testId,
          keywordCount: this.expandedGoal.allKeywords.size,
          negativeCount: this.expandedGoal.negativeKeywords.size,
          language: this.expandedGoal.language,
        });
      } catch (error) {
        logger.warn('[L2_INIT] GoalExpander failed, using fallback', {
          testId: this.config.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE A: Initialize PageWatcher for multi-tab/popup detection
    // ═══════════════════════════════════════════════════════════════════════════
    const browserContext = this.page.context();
    this.pageWatcher = new PageWatcher(browserContext);
    logger.debug('[LITE_ENGINE] PageWatcher initialized for multi-tab detection');

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

    // ═══════════════════════════════════════════════════════════════════════════
    // TASK 7: Measure initial page load time and compute adaptive timeouts
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      const loadStartTime = Date.now();
      await this.page.goto(this.config.url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const loadTimeMs = Date.now() - loadStartTime;
      this.adaptiveTimeouts = computeAdaptiveTimeouts(loadTimeMs);

      logger.info('[LITE_ENGINE] Adaptive timeouts computed', {
        testId: this.config.testId,
        loadTimeMs,
        profile: this.adaptiveTimeouts.siteProfile,
        networkIdleMs: this.adaptiveTimeouts.networkIdleMs,
      });

      this.traceWriter.write({
        stage: 'initialization',
        eventType: 'adaptive_timeouts_computed',
        spanId: this.traceWriter.generateSpanId(),
        parentSpanId: this.traceWriter.getRootSpanId(),
        payload: {
          loadTimeMs,
          profile: this.adaptiveTimeouts.siteProfile,
          config: this.adaptiveTimeouts,
        },
      });
    } catch (error) {
      // Use default normal profile on error
      this.adaptiveTimeouts = computeAdaptiveTimeouts(2000);
      logger.warn('[LITE_ENGINE] Failed to measure initial load, using normal profile', {
        testId: this.config.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      for (let i = 0; i < this.MAX_ITERATIONS; i++) {
        logger.debug('[LITE_ENGINE] Starting iteration', { iteration: i });

        // ✅ L5: Clear active frame at start of each iteration
        this.activeFrame = null;

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

        // Critic rejection stuck signal — 3+ consecutive rejections = effectively stuck
        const criticRejectionCount = this.multiAgentOrchestrator?.getConsecutiveCriticRejections() ?? 0;
        if (criticRejectionCount >= 3 && !stuckCheck.stuck) {
          stuckCheck.stuck = true;
          stuckCheck.suggestion = 'Critic rejected 3+ consecutive actions. Agent strategy is fundamentally misaligned with page state.';
        }

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

        // 2b. Guard: stale snapshot after credential fill.
        // Runs only ONCE (flag prevents re-triggering on 2FA pages that also have password fields).
        // If auto-fill just completed (state='done') but snapshot still shows a login
        // form (password field visible), the page navigation hasn't settled yet.
        // Re-wait and re-collect so the AI doesn't see the old page.
        if (this.credentialFillState === 'done' && !this.staleSnapshotGuardDone) {
          this.staleSnapshotGuardDone = true;
          const hasPasswordField = snapshotBefore.elements.some(
            el => el.tag === 'input' && el.type === 'password' && el.visible
          );
          if (hasPasswordField) {
            logger.info('[LITE_ENGINE] Stale snapshot after auto-fill: login form still visible, re-waiting', {
              testId: this.config.testId,
              url: snapshotBefore.url,
              iteration: i,
            });
            try {
              await this.page.waitForLoadState('networkidle', { timeout: 8000 });
              await VisualStability.waitForStable(this.page);
            } catch {
              // Timeout OK — maybe it's a real login failure
            }
            snapshotBefore = await SnapshotCollector.collect(this.page);
          }
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
          },
        });

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 0.3 PRE: Activate auto-fill when user provided credentials and login form is visible
        // This bridges the gap: extractPageCredentials only runs when NO creds provided,
        // but when user provides creds, we still need to activate the auto-fill state machine
        // ═══════════════════════════════════════════════════════════════════════
        if (this.config.credentials && this.credentialFillState === 'idle') {
          const hasUsernameField = snapshotBefore.elements.some(el => {
            if (el.tag !== 'input' || !el.visible || el.disabled) return false;
            const c = classifyField(el);
            return (c.kind === 'email' || c.kind === 'username') && !el.hasValue;
          });
          const hasPasswordField = snapshotBefore.elements.some(el => {
            if (el.tag !== 'input' || !el.visible || el.disabled) return false;
            const c = classifyField(el);
            return c.kind === 'password' && !el.hasValue;
          });
          if (hasUsernameField && hasPasswordField) {
            this.credentialFillState = 'filling_username';
            logger.info('[LITE_ENGINE] Login form detected with user credentials, starting auto-fill', {
              testId: this.config.testId,
              iteration: i,
            });
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 0.3 FIX: Check credential auto-fill state FIRST (before all other logic)
        // If state is active, execute auto-fill command and skip AI decision this iteration
        // ✅ FIX P0: Added timeout to prevent infinite auto-fill loops
        // ═══════════════════════════════════════════════════════════════════════
        if (this.credentialFillState !== 'idle' && this.credentialFillState !== 'done') {
          const autoCommand = this.buildAutoCredentialCommand(snapshotBefore);

          if (autoCommand) {
            // ✅ FIX P0: Check if auto-fill is stuck (element keeps disappearing)
            if (this.autoFillIterationCount >= this.MAX_AUTO_FILL_ITERATIONS) {
              logger.warn('[LITE_ENGINE] Auto-fill stuck (max iterations reached), resetting to AI control', {
                testId: this.config.testId,
                state: this.credentialFillState,
                attemptCount: this.autoFillIterationCount,
                maxIterations: this.MAX_AUTO_FILL_ITERATIONS,
              });
              this.credentialFillState = 'idle';
              this.autoFillIterationCount = 0;
              // Don't continue - let AI take over this iteration
            } else {
              this.autoFillIterationCount++;

              const autoFillStateName = this.credentialFillState;
              logger.info('[LITE_ENGINE] Auto-fill active, executing command (skipping AI)', {
                testId: this.config.testId,
                state: autoFillStateName,
                action: autoCommand.action,
                iteration: i,
                attemptCount: this.autoFillIterationCount,
              });

              // Build safe (redacted) command for trace/graph
              const safeAutoCommand = this.buildSafeCommandForTrace(autoCommand, snapshotBefore) || autoCommand;

              // Trace action execute start (same as normal iterations)
              const autoActionSpanId = this.traceWriter.generateSpanId();
              this.traceWriter.write({
                iteration: i,
                stage: 'action_execution',
                eventType: 'action_execute_start',
                spanId: autoActionSpanId,
                parentSpanId: iterationSpanId,
                payload: {
                  command: safeAutoCommand,
                  thought: `Auto-fill credentials (${autoFillStateName})`,
                  isAutoFill: true,
                },
              });

              // Execute auto-command directly
              const execResult = await this.executor.execute(autoCommand, snapshotBefore, {});

              // After submit click, the page may navigate (e.g. login redirect).
              // Wait for navigation + stability so the NEXT iteration's snapshot
              // reflects the new page, not the stale login form.
              //
              // FIX: The old approach (waitForLoadState('domcontentloaded') + networkIdle)
              // failed for SPAs because:
              //   1. 'domcontentloaded' resolves instantly (already fired for current page)
              //   2. networkIdle resolves instantly (auth request hasn't fired yet)
              //   3. VisualStability passes (DOM hasn't changed yet)
              // Result: next iteration gets a stale snapshot of the login form.
              //
              // New approach: wait for a concrete signal that the page reacted to
              // the submit, THEN wait for everything to settle.
              if (autoFillStateName === 'submitting' && execResult.success) {
                try {
                  const currentUrl = this.page.url();

                  // Phase 1: Wait for ANY signal that the submit had an effect.
                  // Whichever fires first wins — we just need proof that the page reacted.
                  // NOTE: Every promise gets its own .catch() to prevent unhandled rejection
                  // warnings from the losers when the winner resolves first.
                  await Promise.race([
                    // Signal 1: A new fetch/xhr request starts (auth API call firing)
                    this.waitForPendingRequest(2000).catch(() => {}),
                    // Signal 2: URL changes (SPA client-side navigation or MPA full reload)
                    this.page.waitForURL(url => url.href !== currentUrl, { timeout: 2000 }).catch(() => {}),
                  ]);

                  // Phase 2: Now that something happened, wait for it to finish.
                  await this.networkTracker.waitForNetworkIdle(8000);
                  await VisualStability.waitForStable(this.page);
                } catch {
                  // Timeout is OK — page might not navigate (e.g. validation error).
                  // The next iteration will handle it either way.
                }
              }

              // Trace action execute end
              this.traceWriter.write({
                iteration: i,
                stage: 'action_execution',
                eventType: 'action_execute_end',
                spanId: this.traceWriter.generateSpanId(),
                parentSpanId: autoActionSpanId,
                payload: {
                  success: execResult.success,
                  error: execResult.error,
                  duration: execResult.duration,
                  isAutoFill: true,
                },
              });

              // Build synthetic decision for progress/graph emission
              const autoDecision: AIDecision = {
                thought: `Auto-fill credentials (${autoFillStateName})`,
                command: safeAutoCommand,
                done: false,
              };

              // Capture actual URL after action (may have changed due to redirect)
              const urlAfterAutoFill = this.page.url();

              // Record iteration with auto-fill
              const syntheticDiff: StateDiff = {
                urlChanged: urlAfterAutoFill !== snapshotBefore.url,
                urlBefore: snapshotBefore.url,
                urlAfter: urlAfterAutoFill,
                addedElements: [],
                removedRefs: [],
                changedElements: [],
                hasVisualChange: urlAfterAutoFill !== snapshotBefore.url,
                meaningfulChange: execResult.success,
                significantChange: urlAfterAutoFill !== snapshotBefore.url,
                semanticWeight: urlAfterAutoFill !== snapshotBefore.url ? 3 : 0,
                progressSentiment: execResult.success ? 'Minor Change' : 'No Effect',
                newPageErrors: [],
                newConsoleErrors: [],
              };

              this.state.recordIteration({
                iteration: i,
                decision: {
                  thought: `Auto-fill: ${autoFillStateName}`,
                  command: autoCommand,
                  done: false,
                },
                result: {
                  stateDiff: syntheticDiff,
                  outcome: execResult.success ? 'state_changed' : 'execution_error',
                  success: execResult.success,
                  duration: execResult.duration || 0,
                },
                stateBefore: {
                  url: snapshotBefore.url,
                  elementCount: snapshotBefore.elements.length,
                  pageErrors: [],
                },
                stateAfter: {
                  url: urlAfterAutoFill,
                  elementCount: snapshotBefore.elements.length, // snapshot not re-collected here; next iteration gets fresh
                  pageErrors: [],
                },
              });

              // Emit progress via WebSocket (so frontend shows auto-fill steps)
              const autoOutcome = execResult.success ? 'state_changed' as const : 'execution_error' as const;
              this.emitIterationProgress(i, autoDecision, autoOutcome, syntheticDiff);

              // Add action node to graph (so flowmap shows auto-fill steps)
              await this.addGraphActionNode(i, autoDecision, execResult, snapshotBefore, snapshotBefore, syntheticDiff);

              // Close iteration with proper trace event
              closeIteration({
                iteration: i,
                outcome: autoOutcome,
                urlAfter: urlAfterAutoFill,
                stateChanged: execResult.success,
                isAutoFill: true,
                autoFillState: autoFillStateName,
              });

              // Skip rest of this iteration (continue to next)
              continue;
            }
          } else {
            // Can't find element for auto-fill, reset state and let AI handle
            logger.warn('[LITE_ENGINE] Auto-fill failed (element not found), falling back to AI', {
              testId: this.config.testId,
              state: this.credentialFillState,
              attemptCount: this.autoFillIterationCount,
            });
            this.credentialFillState = 'idle';
            this.autoFillIterationCount = 0; // ✅ FIX P0: Reset counter
            // Continue to normal AI flow below
          }
        } else {
          // ✅ FIX P0: Reset auto-fill counter when state is idle/done
          if (this.autoFillIterationCount > 0) {
            this.autoFillIterationCount = 0;
          }
        }

        // ✅ Task #21: Update flow state based on current page
        this.currentFlowState = this.flowStateDetector.detect(
          snapshotBefore.url,
          snapshotBefore.elements,
          this.currentFlowState || undefined
        );

        // 2b. Build GoalContext for this iteration
        const goalContext = this.buildGoalContext(snapshotBefore, i, stuckCheck);

        // ✅ FIX P1: Check guidance lifetime and clear if expired
        if (this.currentGuidance) {
          const GUIDANCE_LIFETIME_ITERATIONS = 2;
          const lifetimeElapsed = i - this.currentGuidance.addedAtIteration;
          if (lifetimeElapsed >= GUIDANCE_LIFETIME_ITERATIONS) {
            logger.debug('[LITE_ENGINE] Guidance lifetime expired, clearing', {
              testId: this.config.testId,
              addedAt: this.currentGuidance.addedAtIteration,
              currentIteration: i,
              lifetimeElapsed,
            });
            this.currentGuidance = null;
          }
        }

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

        // ═══════════════════════════════════════════════════════════════════════
        // L6: PAGE CREDENTIALS EXTRACTION (one-time for login goals)
        // PHASE 0.2: Expanded trigger conditions - fallback to regex and login form detection
        // ═══════════════════════════════════════════════════════════════════════
        const goalForCredentials = this.goalDetector.getParsedGoal();

        // Detect login form in snapshot (password input present)
        const hasLoginForm = snapshotBefore.elements.some(el =>
          el.tag === 'input' &&
          el.type === 'password' &&
          el.visible &&
          !el.disabled
        );

        // Multiple trigger conditions (OR logic):
        // 1. Parsed goal action is 'login' or 'register'
        // 2. Goal text contains login/auth keywords (regex fallback)
        // 3. Login form detected in snapshot
        const shouldExtractCredentials =
          LITE_ENGINE_FLAGS.enablePageCredentialsExtraction &&
          !this.pageCredentialsAttempted &&
          !this.config.credentials &&
          (
            goalForCredentials?.action === 'login' ||
            goalForCredentials?.action === 'register' ||
            /login|sign.?in|auth|register|sign.?up/i.test(this.config.goal) ||
            hasLoginForm
          );

        if (shouldExtractCredentials) {
          this.pageCredentialsAttempted = true;
          const extractedCreds = extractPageCredentials(snapshotBefore, this.config.testId);

          if (extractedCreds.confidence !== 'none' && extractedCreds.password) {
            // Set credentials from page (SECURITY: never log actual values)
            this.config.credentials = {
              password: extractedCreds.password,
              ...(extractedCreds.username && { username: extractedCreds.username }),
            };

            logger.info('[LITE_ENGINE] Page credentials extracted', {
              testId: this.config.testId,
              hasUsername: !!extractedCreds.username,
              hasPassword: !!extractedCreds.password,
              confidence: extractedCreds.confidence,
              sourcePattern: extractedCreds.sourcePattern,
              // SECURITY: Never log actual credential values
            });

            // PHASE 0.3: Start auto-fill sequence (will execute in NEXT iteration via early check)
            this.credentialFillState = 'filling_username';
            logger.info('[LITE_ENGINE] Starting credential auto-fill sequence', {
              testId: this.config.testId,
            });
          } else {
            logger.debug('[LITE_ENGINE] No page credentials found', {
              testId: this.config.testId,
              confidence: extractedCreds.confidence,
            });
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // L6: CREDENTIAL CLARIFICATION FALLBACK (ask user if login form visible but no creds)
        // ═══════════════════════════════════════════════════════════════════════
        if (
          LITE_ENGINE_FLAGS.enableCredentialClarification &&
          !this.credentialClarificationAttempted &&
          goalForCredentials?.action === 'login'
        ) {
          // Check if login form is visible (password field present)
          const hasPasswordField = snapshotBefore.elements.some(
            el => el.type === 'password' && el.visible && !el.disabled
          );

          // Check if username/email field is present (common for login)
          // NOTE: Require strong signals to avoid false positives from search boxes, etc.
          const hasUsernameLikeField = snapshotBefore.elements.some(el => {
            const type = (el.type || '').toLowerCase();
            const ac = (el.autocomplete || '').toLowerCase();
            const n = (el.htmlName || '').toLowerCase();
            const id = (el.htmlId || '').toLowerCase();
            const label = (el.name || '').toLowerCase();

            if (!el.visible || el.disabled) return false;
            if (type === 'password') return false;

            // Strong signal: email type
            if (type === 'email') return true;

            // Strong signal: autocomplete hints
            if (ac.includes('username') || ac.includes('email')) return true;

            // Strong signal: name/id/label contains login-related keywords
            const hasLoginKeyword =
              /user|username|login|email|userid/.test(n) ||
              /user|username|login|email|userid/.test(id) ||
              /user|username|login|email/.test(label);

            // For type=text, require additional login-related keyword (avoid search boxes)
            if (type === 'text' && hasLoginKeyword) return true;

            return false;
          });

          const hasAnyCredentialIdentifier = !!(
            this.config.credentials?.username ||
            this.config.credentials?.email ||
            this.config.credentials?.phone
          );

          const needsIdentifier = hasUsernameLikeField && !hasAnyCredentialIdentifier;
          const needsPassword = !this.config.credentials?.password;

          // We ask if there is a login form and we don't have enough creds to proceed reliably.
          const shouldAskForCredentials = hasPasswordField && (needsPassword || needsIdentifier);

          if (shouldAskForCredentials) {
            this.credentialClarificationAttempted = true;

            // Build dynamic question based on what's missing
            let question: string;
            let expectingField: 'username' | 'password' | 'both';

            if (needsPassword && needsIdentifier) {
              question =
                'I found a login form but need credentials to proceed. Please provide login credentials (username/email and password).\n\n' +
                'You can respond in formats like:\n• username: xxx, password: yyy\n• xxx / yyy\n• or just: username password';
              expectingField = 'both';
            } else if (needsIdentifier) {
              question =
                'I have a password but need a username/email to complete login. Please provide the username or email.';
              expectingField = 'username';
            } else {
              question =
                'I have a username but need a password to complete login. Please provide the password.';
              expectingField = 'password';
            }

            logger.info('[LITE_ENGINE] Login form detected but credentials incomplete, asking user', {
              testId: this.config.testId,
              needsPassword,
              needsIdentifier,
            });

            try {
              const response = await ClarificationService.requestClarification({
                testId: this.config.testId,
                userId: this.config.userId,
                question,
                type: 'credentials',
                required: true,
                timeout: LITE_ENGINE_FLAGS.credentialClarificationTimeoutMs,
              });

              if (response) {
                const parsed = parseCredentialsFromResponse(response, expectingField);
                if (parsed && (parsed.username || parsed.password)) {
                  // Merge with existing credentials instead of full overwrite
                  const mergedPassword = parsed.password || this.config.credentials?.password;
                  if (mergedPassword) {
                    this.config.credentials = {
                      password: mergedPassword,
                      ...(this.config.credentials?.email && { email: this.config.credentials.email }),
                      ...(this.config.credentials?.phone && { phone: this.config.credentials.phone }),
                      ...(parsed.username
                        ? { username: parsed.username }
                        : this.config.credentials?.username && { username: this.config.credentials.username }),
                    };

                    logger.info('[LITE_ENGINE] Credentials received from user', {
                      testId: this.config.testId,
                      receivedUsername: !!parsed.username,
                      receivedPassword: !!parsed.password,
                      // SECURITY: Never log actual credential values
                    });
                  } else {
                    logger.warn('[LITE_ENGINE] Received credentials but still missing password', {
                      testId: this.config.testId,
                    });
                  }
                } else {
                  logger.warn('[LITE_ENGINE] Could not parse credentials from user response', {
                    testId: this.config.testId,
                    responseLength: response.length,
                  });
                }
              } else {
                logger.warn('[LITE_ENGINE] No response from user for credential clarification', {
                  testId: this.config.testId,
                });
              }
            } catch (clarificationError) {
              logger.warn('[LITE_ENGINE] Credential clarification failed', {
                testId: this.config.testId,
                error: clarificationError instanceof Error ? clarificationError.message : String(clarificationError),
              });
            }
          }
        }

        // ✅ NEW: Goal-first check BEFORE asking AI (using heuristic)
        const goalCheck = this.goalDetector.detectHeuristic(goalContext);

        // ═══════════════════════════════════════════════════════════════════════
        // POST-CREDENTIAL-FILL GOAL CHECK
        // When auto-fill completed (state='done') and URL redirected away from auth page,
        // the heuristic often fails because URL/form signals no longer match.
        // In this case, proactively call auditor (gpt-4o) to verify login success.
        // ═══════════════════════════════════════════════════════════════════════
        if (
          this.credentialFillState === 'done' &&
          !goalCheck.goalReached &&
          this.config.url &&
          snapshotBefore.url !== this.config.url
        ) {
          // URL changed after credential fill — likely a redirect post-login
          const isAuthGoal = /login|sign.?in|auth|авторизац|войти/i.test(this.config.goal);
          if (isAuthGoal) {
            logger.info('[LITE_ENGINE] Post-credential-fill: URL redirected, checking if login succeeded', {
              testId: this.config.testId,
              originalUrl: this.config.url,
              currentUrl: snapshotBefore.url,
              iteration: i,
            });

            try {
              // Collect network signals from recent activity (auth API calls)
              const recentResponses = this.networkTracker.getSuccessfulResponsesSince(
                Date.now() - 10000 // last 10 seconds covers auto-fill + redirect
              );
              const recentErrors = this.networkTracker.getErrorsSince(
                Date.now() - 10000
              );

              // Build enriched goal context with credential-fill + auth signals
              const credGoalContext: GoalContext = {
                ...goalContext,
                urlBefore: this.config.url,
                urlAfter: snapshotBefore.url,
                urlChanged: true,
                lastOutcome: 'Credentials filled and submitted via auto-fill, page redirected',
                authSignals: {
                  credentialsFilled: true,
                  successfulResponses: recentResponses.slice(-5).map(r => ({
                    url: r.url,
                    method: r.method,
                    status: r.status,
                  })),
                  failedResponses: recentErrors.slice(-3).map(r => ({
                    url: r.url,
                    method: r.method,
                    status: r.status || 0,
                    error: r.error,
                  })),
                  titleAfter: snapshotBefore.title,
                },
              };

              const auditorPromptSpanId = this.traceWriter.generateSpanId();
              this.traceWriter.write({
                iteration: i,
                stage: 'goal_validation',
                eventType: 'ai_auditor_prompt',
                spanId: auditorPromptSpanId,
                parentSpanId: iterationSpanId,
                payload: {
                  trigger: 'post_credential_fill',
                  goalContext: credGoalContext,
                  model: 'gpt-4o',
                },
              });

              const credAuditResult = await withCancellation(
                this.config.testId,
                this.goalDetector.auditDone(
                  credGoalContext,
                  'Credentials filled and submitted via auto-fill, page redirected to ' + snapshotBefore.url
                ),
                'goalDetector.auditDone (post-credential-fill)'
              );

              this.traceWriter.write({
                iteration: i,
                stage: 'goal_validation',
                eventType: 'ai_auditor_response',
                spanId: this.traceWriter.generateSpanId(),
                parentSpanId: auditorPromptSpanId,
                payload: {
                  auditResult: credAuditResult,
                  isDone: credAuditResult.isDone,
                  confidence: credAuditResult.confidence,
                  reason: credAuditResult.reason,
                  trigger: 'post_credential_fill',
                },
              });

              if (credAuditResult.isDone && credAuditResult.confidence >= 0.5) {
                logger.info('[LITE_ENGINE] Post-credential-fill: Login SUCCESS confirmed by auditor', {
                  testId: this.config.testId,
                  confidence: credAuditResult.confidence.toFixed(2),
                  reason: credAuditResult.reason,
                  iterations: i + 1,
                });
                this.emitCompletion(true, credAuditResult.reason || 'Login successful');
                await this.flushPendingGraphScreenshotUploads();
                closeIteration({
                  iteration: i,
                  outcome: 'goal_reached',
                  trigger: 'post_credential_fill',
                });
                return await this.buildResult(true, credAuditResult.reason || 'Login successful');
              } else if (credAuditResult.isBlocked) {
                logger.info('[LITE_ENGINE] Post-credential-fill: Blocked (2FA/captcha)', {
                  testId: this.config.testId,
                  blockedReason: credAuditResult.blockedReason,
                });
                // Don't stop — let AI try to handle the blocker
              } else {
                logger.info('[LITE_ENGINE] Post-credential-fill: Auditor says NOT done yet', {
                  testId: this.config.testId,
                  reason: credAuditResult.reason,
                  nextStep: credAuditResult.nextStepIfMissing,
                });
              }

              // Reset credentialFillState to prevent re-checking every iteration
              this.credentialFillState = 'idle';
            } catch (credAuditError) {
              if (credAuditError instanceof Error && credAuditError.message.includes('cancelled')) {
                throw credAuditError;
              }
              logger.warn('[LITE_ENGINE] Post-credential-fill auditor failed', {
                testId: this.config.testId,
                error: credAuditError instanceof Error ? credAuditError.message : String(credAuditError),
              });
              // Continue without completing (conservative)
            }
          }
        }

        // ✅ FIX P0: Decrement audit cooldown ONLY if heuristic doesn't claim done
        // This prevents wasting iterations when heuristic says "done" but cooldown is active
        if (this.auditCooldownRemaining > 0) {
          if (goalCheck.goalReached && goalCheck.confidence !== 'low') {
            // Heuristic claims done - force cooldown to 0 for immediate auditor call
            logger.debug('[LITE_ENGINE] Heuristic claims done - forcing audit cooldown to 0', {
              testId: this.config.testId,
              progressScore: Math.round(goalCheck.progressScore * 100) + '%',
              confidence: goalCheck.confidence,
              cooldownWas: this.auditCooldownRemaining,
            });
            this.auditCooldownRemaining = 0;
          } else {
            // Normal decrement (not done yet)
            this.auditCooldownRemaining--;
          }
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
                    userId: this.config.userId,
                    sessionId: this.config.chatSessionId,
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

        // ═══════════════════════════════════════════════════════════════════════
        // WORKSTREAM 4: State Recovery Ladder (before AI fallback)
        // ═══════════════════════════════════════════════════════════════════════
        if (stuckCheck.stuck && this.state.getConsecutiveStuckCount() >= this.STUCK_THRESHOLD) {
          // Try recovery ladder
          const allIterations = this.state.getAllIterations();
          const lastCommand = allIterations.length > 0
            ? allIterations[allIterations.length - 1].decision.command
            : undefined;
          const recoveryResult = await this.attemptStateRecovery({
            reason: stuckCheck.reason || 'stuck',
            lastCommand,
            snapshotBefore,
            iteration: i,
          });

          if (recoveryResult.shouldEscalate) {
            // Tier4: need_help - recovery exhausted
            logger.warn('[RECOVERY] Escalating to Tier4 (need_help)', {
              testId: this.config.testId,
              reason: 'Recovery exhausted for this URL+goal',
            });
            // Return need_help to end the test with user intervention request
            this.emitCompletion(false, 'Recovery exhausted - need help');
            await this.flushPendingGraphScreenshotUploads();
            return await this.buildResult(false, 'Recovery exhausted - need help');
          }

          if (recoveryResult.recovered && recoveryResult.newSnapshot) {
            snapshotBefore = recoveryResult.newSnapshot;
            // Reset stuck counter since recovery succeeded
            this.state.resetConsecutiveStuckCount();
            logger.info('[RECOVERY] Recovery successful, continuing', {
              testId: this.config.testId,
              method: recoveryResult.method,
            });
          } else {
            // Recovery didn't help, try AI fallback
            logger.info('[LITE_ENGINE] Recovery failed, trying AI fallback', {
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
                // AI fallback didn't help - try direct URL fallback
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

        // ✅ NEW: Build state drift analysis from last iteration
        const lastStateDiff = this.state.getLastStateDiff();
        const stateDriftAnalysis = lastStateDiff
          ? StateDiffComputer.formatForAI(lastStateDiff.diff, lastStateDiff.action)
          : undefined;

        // State Drift Auditor: Compute audited drift (replaces raw drift when enabled)
        let auditedDrift: StateDriftAuditResult | undefined;
        if (LITE_ENGINE_FLAGS.enableStateDriftAuditor && lastStateDiff) {
          // Use current snapshotBefore as "after" (it's the state we're about to act on)
          // and the previous snapshot stored in state for "before" (for lost-field detection)
          auditedDrift = StateDriftAuditor.audit(
            lastStateDiff.diff,
            this.lastSnapshotForAuditor || snapshotBefore,
            snapshotBefore,
            this.state,
          );
        }
        // Store snapshot for next iteration's auditor (lost-field detection needs real elements)
        this.lastSnapshotForAuditor = snapshotBefore;

        // Negative Reinforcement: Get blacklisted actions
        let failedActions: BlacklistedAction[] | undefined;
        if (LITE_ENGINE_FLAGS.enableNegativeReinforcement) {
          const blacklisted = this.state.getBlacklistedActions();
          if (blacklisted.length > 0) {
            failedActions = blacklisted;
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // L2 MANUS: Detect Funnel Phase
        // ═══════════════════════════════════════════════════════════════════════
        if (LITE_ENGINE_FLAGS.enableFunnelAnalyzer) {
          this.previousFunnelPhase = this.currentFunnelPhase;
          this.currentFunnelPhase = FunnelAnalyzer.analyze(snapshotBefore.url, snapshotBefore.elements);
          this.semanticWeightCalculator.updateFunnelPhase(this.currentFunnelPhase);

          if (FunnelAnalyzer.hasPhaseChanged(this.previousFunnelPhase, this.currentFunnelPhase)) {
            logger.info('[L2_FUNNEL] Phase changed', {
              testId: this.config.testId,
              from: this.previousFunnelPhase,
              to: this.currentFunnelPhase,
              iteration: i,
            });

            // WORKSTREAM 4: Reset recovery attempts on phase change (SPA-safe)
            this.state.resetAllRecoveryAttempts();
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // P0 FEATURE: Proactive Vision Detection
        // Check metadata first before reactive "No Effect" detection
        // ═══════════════════════════════════════════════════════════════════════
        let visionHints: VisionHints | null = null;
        if (LITE_ENGINE_FLAGS.enableVisionEscalation) {
          // NEW: Proactive vision detection based on snapshot metadata
          if (snapshotBefore.metadata?.recommendVision && !this.visionAttemptedForPage.has(snapshotBefore.url)) {
            logger.info('[P0_VISION] Proactive vision escalation (canvas/SVG/weak DOM detected)', {
              testId: this.config.testId,
              hasCanvas: snapshotBefore.metadata.hasCanvas,
              hasSVG: snapshotBefore.metadata.hasSVG,
              canvasArea: Math.round(snapshotBefore.metadata.canvasArea * 100) + '%',
              svgArea: Math.round(snapshotBefore.metadata.svgArea * 100) + '%',
              isDOMWeak: snapshotBefore.metadata.isDOMWeak,
              interactiveElements: snapshotBefore.metadata.interactiveElementCount,
            });

            visionHints = await this.tryVisionFallback();
            this.visionAttemptedForPage.add(snapshotBefore.url);

            if (visionHints) {
              logger.info('[P0_VISION] Vision hints acquired proactively', {
                testId: this.config.testId,
                buttonCount: visionHints.visibleButtons.length,
                fieldCount: visionHints.formFields.length,
              });
            }
          }
          // Fallback: Reactive vision escalation (original logic)
          else if (this.shouldEscalateToVision(snapshotBefore)) {
            visionHints = await this.tryVisionFallback();
            if (visionHints) {
              logger.info('[L5_VISION] Vision hints acquired reactively (No Effect fallback)', {
                testId: this.config.testId,
                buttonCount: visionHints.visibleButtons.length,
                fieldCount: visionHints.formFields.length,
              });
            }
          }
        }

        // 3a. TASK 9: Identify goal-relevant form
        let formFocusHint: string | undefined;
        const goalFormRefs = this.goalDetector.identifyGoalForm(snapshotBefore.elements, this.config.goal);
        if (goalFormRefs.length > 0) {
          formFocusHint = `The following fields belong to the goal-relevant form:\n${goalFormRefs.map(ref => `- ${ref}`).join('\n')}\n\nPrioritize interacting with these fields to complete your goal.`;
          logger.debug('[LITE_ENGINE] Goal form identified', {
            testId: this.config.testId,
            fieldCount: goalFormRefs.length,
            refs: goalFormRefs.slice(0, 5),
          });
        }

        // 4. Build prompt with stuck warning + progress signals + AI guidance + contextual hints + task plan + state drift
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
          stateDriftAnalysis, // ✅ NEW: State drift from last action
          lastAction: lastStateDiff?.action, // ✅ NEW: Last action for context
          goalOrientedSummary: this.lastGoalOrientedSummary || undefined, // ✅ NEW: Goal-Oriented Summary (Secret Sauce)
          visionHints: visionHints || undefined, // ✅ NEW: L5 Vision hints when DOM is weak
          formFocusHint, // ✅ TASK 9: Goal form identification
          failedActions, // Negative Reinforcement: blacklisted actions
          auditedDrift, // State Drift Auditor: enriched drift analysis
          skillsContext: this.skillsContext || undefined, // KB skills for smarter decisions
        });

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 0.3: Credential auto-fill state machine (bypass AI if active)
        // ═══════════════════════════════════════════════════════════════════════
        let decision: AIDecision;

        if (this.credentialFillState !== 'idle' && this.credentialFillState !== 'done') {
          // Try to auto-execute credential fill sequence
          const autoCommand = this.buildAutoCredentialCommand(snapshotBefore);

          if (autoCommand) {
            logger.info('[LITE_ENGINE] Auto-executing credential sequence', {
              testId: this.config.testId,
              state: this.credentialFillState,
              action: autoCommand.action,
              ref: autoCommand.ref,
            });

            // Create synthetic AI decision for auto-command
            decision = {
              thought: `Auto-filling credentials (state: ${this.credentialFillState})`,
              command: autoCommand,
              done: false,
            };

            // Skip AI call, proceed to execution
          } else {
            // Can't find target element, fall back to AI
            logger.warn('[LITE_ENGINE] Auto-fill failed, falling back to AI', {
              testId: this.config.testId,
              state: this.credentialFillState,
            });
            this.credentialFillState = 'idle';

            // Continue to normal AI decision
            decision = await this.getAIDecision(prompt, i, iterationSpanId, snapshotBefore);
            this.previousFormattedSnapshot = formattedSnapshot;
          }
        } else {
          // Normal AI decision (with multi-agent context when enabled)
          const multiAgentCtx = LITE_ENGINE_FLAGS.enableMultiAgentBrain ? {
            snapshot: formattedSnapshot,
            goal: this.config.goal,
            history: this.state.getFormattedHistory(),
            stateDrift: stateDriftAnalysis,
            visionHints: visionHints || undefined,
            taskPlanSummary: taskPlanContext ? `Step ${taskPlanContext.currentStepIndex + 1}/${taskPlanContext.totalSteps}: ${taskPlanContext.currentStep.goal}` : undefined,
            guidance: this.currentGuidance?.guidance,
            progressScore: goalCheck.progressScore,
            failedActions,
            auditedDrift,
            isStuck: stuckCheck.stuck,
            lastOutcome: this.state.getLastOutcome(),
            hasCredentials: !!this.config.credentials,
            snapshotElements: formattedSnapshot,
            // Manus-style enhancements
            previousSnapshot: this.previousFormattedSnapshot || undefined,
            networkActivity: this.networkTracker.getNetworkActivityState(),
            lastAction: i > 0 ? this.state.getAllIterations()[i - 1]?.decision.command.action : undefined,
            lastExpectation: this.lastExpectedOutcome, // Manus-style: Feed Strategist's expectedOutcome to Observer
            // Manus parity: transient state, metadata, page structure
            transientState: snapshotBefore.transientState,
            pageMetadata: snapshotBefore.metadata,
            pageStructure: snapshotBefore.pageStructure,
            // Goal URL for wrong-page detection and recovery
            goalUrl: this.config.url,
            // Consecutive critic rejections for stuck detection in orchestrator
            consecutiveCriticRejections: this.multiAgentOrchestrator?.getConsecutiveCriticRejections() ?? 0,
            // Supervisor: loop signals from state-drift-auditor
            loopDetected: auditedDrift?.repetition?.loopDetected || false,
            loopDescription: auditedDrift?.repetition?.loopDescription,
            // Supervisor: console/network errors from last action for blocker detection
            recentConsoleErrors: this.lastConsoleErrors.length > 0 ? this.lastConsoleErrors.slice(-5) : undefined,
            recentNetworkErrors: this.lastNetworkErrors.length > 0 ? this.lastNetworkErrors.slice(-3) : undefined,
            recentValidationErrors: this.lastValidationErrors.length > 0 ? this.lastValidationErrors.slice(-3) : undefined,
          } : undefined;
          decision = await this.getAIDecision(prompt, i, iterationSpanId, snapshotBefore, multiAgentCtx);

          // Store snapshot for next iteration's spatial diff
          this.previousFormattedSnapshot = formattedSnapshot;
        }

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
                  userId: this.config.userId,
                  sessionId: this.config.chatSessionId,
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
                userId: this.config.userId,
                sessionId: this.config.chatSessionId,
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
        let commandWithCredentials = this.overrideCredentialFillValue(decision.command, snapshotBefore);

        // ═══════════════════════════════════════════════════════════════════════
        // L4 MANUS: Apply Target Audit Guard
        // ═══════════════════════════════════════════════════════════════════════
        if (LITE_ENGINE_FLAGS.enableTargetAuditGuard) {
          const guardedCommand = await this.applyTargetAuditGuard(commandWithCredentials, snapshotBefore);
          if (guardedCommand.ref !== commandWithCredentials.ref) {
            logger.info('[L4_GUARD] Command ref corrected by audit', {
              testId: this.config.testId,
              original: commandWithCredentials.ref?.slice(0, 20),
              corrected: guardedCommand.ref?.slice(0, 20),
              iteration: i,
            });
            // Re-apply credential override for new ref
            commandWithCredentials = this.overrideCredentialFillValue(guardedCommand, snapshotBefore);
          }
        }

        // Build safe command for tracing (redact credentials)
        const safeCommand = this.buildSafeCommandForTrace(commandWithCredentials, snapshotBefore);

        // ═══════════════════════════════════════════════════════════════════════
        // L7: CLARIFICATION GATES (payment, upload, external/download)
        // ═══════════════════════════════════════════════════════════════════════

        // Gate 1: Payment/Checkout Approval
        if (LITE_ENGINE_FLAGS.enablePaymentApprovalGate && !this.paymentApprovalAsked) {
          const targetElement = snapshotBefore.elements.find(el => el.ref === commandWithCredentials.ref);
          const targetText = targetElement?.name || '';

          if (commandWithCredentials.action === 'click' && isPaymentContext(snapshotBefore, targetText)) {
            this.paymentApprovalAsked = true;

            logger.info('[LITE_ENGINE] Payment/checkout context detected, asking user', {
              testId: this.config.testId,
              targetText: targetText.slice(0, 50),
            });

            try {
              const response = await ClarificationService.requestClarification({
                testId: this.config.testId,
                userId: this.config.userId,
                question: `I detected a payment/checkout action: "${targetText}". How should I proceed?\n\nOptions:\n• proceed - Continue with the payment flow\n• stop_here - Stop the test successfully at this point\n• cancel_test - Cancel the entire test`,
                type: 'payment_approval',
                required: true,
                options: ['proceed', 'stop_here', 'cancel_test'],
                timeout: LITE_ENGINE_FLAGS.paymentApprovalTimeoutMs,
              });
              const normalized = response?.trim().toLowerCase();

              if (normalized === 'stop_here') {
                logger.info('[LITE_ENGINE] User chose to stop at checkout', {
                  testId: this.config.testId,
                });
                this.emitCompletion(true, 'Stopped by user at checkout');
                await this.flushPendingGraphScreenshotUploads();
                closeIteration({ skipped: true, reason: 'payment_stop_here' });
                return await this.buildResult(true, 'Test stopped at checkout (user choice)');
              } else if (normalized === 'cancel_test' || !normalized) {
                logger.info('[LITE_ENGINE] User cancelled test at checkout', {
                  testId: this.config.testId,
                });
                this.emitCompletion(false, 'Cancelled by user at checkout');
                await this.flushPendingGraphScreenshotUploads();
                closeIteration({ skipped: true, reason: 'payment_cancel_test' });
                return await this.buildResult(false, 'Test cancelled at checkout (user choice)');
              }
              // If 'proceed', continue normally
            } catch (clarificationError) {
              logger.warn('[LITE_ENGINE] Payment approval clarification failed', {
                testId: this.config.testId,
                error: clarificationError instanceof Error ? clarificationError.message : String(clarificationError),
              });
              // Continue on error (fail-open for usability)
            }
          }
        }

        // Gate 2: File Upload Clarification
        if (LITE_ENGINE_FLAGS.enableFileUploadGate && commandWithCredentials.ref) {
          if (this.skippedFileUploadRefs.has(commandWithCredentials.ref)) {
            closeIteration({ skipped: true, reason: 'file_upload_skipped_cached', ref: commandWithCredentials.ref });
            continue;
          }

          const isUploadTarget = isFileUploadTarget(commandWithCredentials.ref, snapshotBefore);

          if (isUploadTarget && !this.fileUploadApprovalAskedForRefs.has(commandWithCredentials.ref)) {
            this.fileUploadApprovalAskedForRefs.add(commandWithCredentials.ref);

            logger.info('[LITE_ENGINE] File upload target detected, asking user', {
              testId: this.config.testId,
              ref: commandWithCredentials.ref.slice(0, 30),
            });

            try {
              const response = await ClarificationService.requestClarification({
                testId: this.config.testId,
                userId: this.config.userId,
                question: 'I detected a file upload input. Lite mode cannot upload files. How should I proceed?\n\nOptions:\n• skip_upload - Skip this upload and continue\n• stop_test - Stop the test here',
                type: 'test_data',
                required: true,
                options: ['skip_upload', 'stop_test'],
                timeout: LITE_ENGINE_FLAGS.fileUploadTimeoutMs,
              });
              const normalized = response?.trim().toLowerCase();

              if (normalized === 'stop_test' || !normalized) {
                logger.info('[LITE_ENGINE] User chose to stop at file upload', {
                  testId: this.config.testId,
                });
                this.emitCompletion(false, 'File upload requires manual input');
                await this.flushPendingGraphScreenshotUploads();
                closeIteration({ skipped: true, reason: 'file_upload_stop_test', ref: commandWithCredentials.ref });
                return await this.buildResult(false, 'Stopped: File upload requires manual input');
              }
              // If 'skip_upload', skip this action and continue to next iteration
              if (normalized === 'skip_upload') {
                logger.info('[LITE_ENGINE] Skipping file upload as requested', {
                  testId: this.config.testId,
                });
                this.skippedFileUploadRefs.add(commandWithCredentials.ref);
                closeIteration({ skipped: true, reason: 'file_upload_skip_upload', ref: commandWithCredentials.ref });
                continue; // Skip to next iteration without executing this command
              }
            } catch (clarificationError) {
              logger.warn('[LITE_ENGINE] File upload clarification failed', {
                testId: this.config.testId,
                error: clarificationError instanceof Error ? clarificationError.message : String(clarificationError),
              });
              // On error, skip the upload action (safe default)
              closeIteration({ skipped: true, reason: 'file_upload_gate_error', ref: commandWithCredentials.ref });
              continue;
            }
          }
        }

        // Gate 3: External Domain Navigation Approval
        if (LITE_ENGINE_FLAGS.enableExternalDomainGate && commandWithCredentials.action === 'goto') {
          const currentUrl = snapshotBefore.url;
          const targetUrl = commandWithCredentials.url || '';

          // ✅ NEW: Security check for malicious URLs (data:, javascript:, etc.)
          if (PromptSanitizer.isUrlSuspicious(targetUrl)) {
            logger.warn('[SECURITY] Blocked suspicious URL navigation attempt', {
              testId: this.config.testId,
              targetUrl: targetUrl.slice(0, 100),
            });
            closeIteration({ skipped: true, reason: 'suspicious_url_blocked', url: targetUrl.slice(0, 50) });
            continue;
          }

          let currentOrigin: string | null = null;
          let targetOrigin: string | null = null;
          let resolvedTargetUrl: string | null = null;
          try {
            const current = new URL(currentUrl);
            const target = new URL(targetUrl, current);
            currentOrigin = current.origin;
            targetOrigin = target.origin;
            resolvedTargetUrl = target.toString();
          } catch {
            // If URL parsing fails, don't gate
          }

          if (currentOrigin && targetOrigin && resolvedTargetUrl && currentOrigin !== targetOrigin) {
            if (this.deniedExternalOrigins.has(targetOrigin)) {
              closeIteration({ skipped: true, reason: 'external_nav_denied_cached', origin: targetOrigin });
              continue;
            }

            if (!this.approvedExternalOrigins.has(targetOrigin)) {
              logger.info('[LITE_ENGINE] External domain navigation detected, asking user', {
                testId: this.config.testId,
                from: currentUrl.slice(0, 50),
                to: targetUrl.slice(0, 50),
              });

              try {
                const response = await ClarificationService.requestClarification({
                  testId: this.config.testId,
                  userId: this.config.userId,
                  question: `I'm about to navigate to a different domain: ${resolvedTargetUrl}\n\nCurrent domain: ${currentOrigin}\nNew domain: ${targetOrigin}\n\nOptions:\n• allow_once - Allow this navigation\n• deny - Stay on current domain`,
                  type: 'url',
                  required: true,
                  options: ['allow_once', 'deny'],
                  timeout: LITE_ENGINE_FLAGS.externalDownloadApprovalTimeoutMs,
                });
                const normalized = response?.trim().toLowerCase();

                if (normalized === 'deny' || !normalized) {
                  logger.info('[LITE_ENGINE] External navigation denied by user', {
                    testId: this.config.testId,
                  });
                  this.deniedExternalOrigins.add(targetOrigin);
                  closeIteration({ skipped: true, reason: 'external_nav_denied', origin: targetOrigin });
                  continue; // Skip this navigation, continue to next iteration
                }

                // Allow and cache the origin
                this.approvedExternalOrigins.add(targetOrigin);
              } catch (clarificationError) {
                logger.warn('[LITE_ENGINE] External navigation clarification failed', {
                  testId: this.config.testId,
                  error: clarificationError instanceof Error ? clarificationError.message : String(clarificationError),
                });
                // On error, deny navigation (safe default)
                if (targetOrigin) {
                  this.deniedExternalOrigins.add(targetOrigin);
                  closeIteration({ skipped: true, reason: 'external_nav_gate_error', origin: targetOrigin });
                } else {
                  closeIteration({ skipped: true, reason: 'external_nav_gate_error' });
                }
                continue;
              }
            }
          }
        }

        // Gate 4: Download/Export Click Approval
        if (LITE_ENGINE_FLAGS.enableDownloadApprovalGate && commandWithCredentials.action === 'click' && commandWithCredentials.ref) {
          if (this.deniedDownloadRefs.has(commandWithCredentials.ref)) {
            closeIteration({ skipped: true, reason: 'download_denied_cached', ref: commandWithCredentials.ref });
            continue;
          }

          const targetElement = snapshotBefore.elements.find(el => el.ref === commandWithCredentials.ref);
          const targetText = targetElement?.name || '';

          if (isDownloadText(targetText) && !this.downloadApprovalAskedForRefs.has(commandWithCredentials.ref)) {
            this.downloadApprovalAskedForRefs.add(commandWithCredentials.ref);

            logger.info('[LITE_ENGINE] Download/export action detected, asking user', {
              testId: this.config.testId,
              targetText: targetText.slice(0, 50),
            });

            try {
              const response = await ClarificationService.requestClarification({
                testId: this.config.testId,
                userId: this.config.userId,
                question: `I detected a download/export action: "${targetText}". Should I proceed?\n\nOptions:\n• allow - Proceed with download\n• deny - Skip this action`,
                type: 'url',
                required: true,
                options: ['allow', 'deny'],
                timeout: LITE_ENGINE_FLAGS.externalDownloadApprovalTimeoutMs,
              });
              const normalized = response?.trim().toLowerCase();

              if (normalized === 'deny' || !normalized) {
                logger.info('[LITE_ENGINE] Download action denied by user', {
                  testId: this.config.testId,
                });
                this.deniedDownloadRefs.add(commandWithCredentials.ref);
                closeIteration({ skipped: true, reason: 'download_denied', ref: commandWithCredentials.ref });
                continue; // Skip this action, continue to next iteration
              }
              // If 'allow', continue normally
            } catch (clarificationError) {
              logger.warn('[LITE_ENGINE] Download approval clarification failed', {
                testId: this.config.testId,
                error: clarificationError instanceof Error ? clarificationError.message : String(clarificationError),
              });
              // On error, deny download (safe default)
              this.deniedDownloadRefs.add(commandWithCredentials.ref);
              closeIteration({ skipped: true, reason: 'download_gate_error', ref: commandWithCredentials.ref });
              continue;
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE A: Prepare for popup detection before click (only if we will execute click)
        // ═══════════════════════════════════════════════════════════════════════
        if (commandWithCredentials.action === 'click' && this.pageWatcher) {
          this.pageWatcher.prepareForPopup();
        }

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
            activeFrame: this.activeFrame || undefined, // ✅ L5: Pass active frame if found in iframe
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

        // ✅ FIX P2: Handle validation error modal (rollback) with timeout
        if (execResult.modalDismissInfo?.modalType === 'validation') {
          try {
            const VALIDATION_HANDLER_TIMEOUT_MS = 10000; // 10s timeout
            await Promise.race([
              this.handleValidationError(execResult.modalDismissInfo, snapshotBefore.url),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('Validation error handler timeout')), VALIDATION_HANDLER_TIMEOUT_MS)
              ),
            ]);
          } catch (validationHandlerError) {
            logger.warn('[LITE_ENGINE] Validation error handler failed or timed out', {
              testId: this.config.testId,
              iteration: i,
              error: validationHandlerError instanceof Error ? validationHandlerError.message : String(validationHandlerError),
            });
            // Continue execution - validation error handling is best-effort
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE A: Detect and switch to new tab/popup after action
        // ═══════════════════════════════════════════════════════════════════════
        if (commandWithCredentials.action === 'click' && this.pageWatcher) {
          const newPageInfo = await this.pageWatcher.detectNewPage(1500);
          if (newPageInfo) {
            logger.info('[LITE_ENGINE] New page detected after click, switching context', {
              testId: this.config.testId,
              iteration: i,
              newUrl: newPageInfo.url,
              isPopup: newPageInfo.isPopup,
            });

            // Switch active page
            this.page = newPageInfo.page;
            this.activeFrame = null; // Reset active frame on page switch

            // Re-initialize per-page services with new page
            this.executor = new ActionExecutor(this.page);
            this.networkTracker = new NetworkTracker(this.page);
            this.consoleCollector = new ConsoleCollector(this.page);

            // Trace page switch
            this.traceWriter.write({
              iteration: i,
              stage: 'page_switch',
              eventType: 'new_page_detected',
              spanId: this.traceWriter.generateSpanId(),
              parentSpanId: actionSpanId,
              payload: {
                newUrl: newPageInfo.url,
                isPopup: newPageInfo.isPopup,
              },
            });
          }
        }

        // 7. Wait for stability (with cancellation support)
        // ✅ FIX: Wrap stability waits with cancellation for immediate abort
        await withCancellation(
          this.config.testId,
          this.networkTracker.waitForNetworkIdle(this.adaptiveTimeouts?.networkIdleMs || 5000),
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

        // ✅ NEW (Manus Style): Collect successful API responses and validation errors
        const successfulResponses = this.networkTracker.getSuccessfulResponsesSince(execResult.startTime);
        const validationErrors = this.networkTracker.getValidationErrorsSince(execResult.startTime);

        // Store for Supervisor blocker detection (available next iteration)
        this.lastConsoleErrors = consoleErrors;
        this.lastNetworkErrors = networkErrors;
        this.lastValidationErrors = validationErrors;

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

        // 10. Compute diff (Manus Style: with semantic weights, progress sentiment, network-awareness)
        const baseDiff = StateDiffComputer.compute(
          snapshotBefore,
          snapshotAfter,
          pageErrorsBefore,
          pageErrorsAfter,
          consoleErrors,
          networkErrorStrings,
          successfulResponses, // ✅ NEW: Successful API responses
          validationErrors, // ✅ NEW: Validation errors (400-499 with parsed body)
          this.config.goal // ✅ NEW: Goal for dynamic semantic weight priority
        );

        // 10.1 ✅ FIX P1: Enrich with AI (async) with timeout and fallback
        // This improves semantic weight accuracy for ambiguous elements (buttons, links, headers)
        const removedElements = snapshotBefore.elements.filter(el => baseDiff.removedRefs.includes(el.ref));
        let enrichedDiff: StateDiff;
        let goalOrientedSummary: string | null = null;
        try {
          // ✅ FIX P1: Add 5s timeout to prevent iteration blocking
          const AI_ENRICHMENT_TIMEOUT_MS = 5000;
          const enrichedResult = await Promise.race([
            this.semanticWeightCalculator.enrichWithAI(baseDiff, removedElements),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('AI enrichment timeout')), AI_ENRICHMENT_TIMEOUT_MS)
            ),
          ]);
          enrichedDiff = enrichedResult;

          // 10.2 ✅ NEW: Build Goal-Oriented Summary (Secret Sauce for Core Brain)
          goalOrientedSummary = this.semanticWeightCalculator.buildGoalOrientedSummary(enrichedResult);
        } catch (enrichmentError) {
          logger.warn('[LITE_ENGINE] AI enrichment failed, using base diff', {
            testId: this.config.testId,
            iteration: i,
            error: enrichmentError instanceof Error ? enrichmentError.message : String(enrichmentError),
          });
          // ✅ FIX P1: Fallback to base diff if AI enrichment fails or times out
          enrichedDiff = baseDiff;
          // Goal-oriented summary not available without enrichment
          goalOrientedSummary = null;
        }

        // ✅ Store for next iteration prompt (Secret Sauce for Core Brain)
        this.lastGoalOrientedSummary = goalOrientedSummary;

        // Use enriched diff for rest of processing
        const diff = enrichedDiff;

        // ═══════════════════════════════════════════════════════════════════════
        // L5 MANUS: Track consecutive "No Effect" for vision escalation
        // ═══════════════════════════════════════════════════════════════════════
        if (enrichedDiff.progressSentiment === 'No Effect') {
          this.consecutiveNoEffectCount++;
          logger.debug('[L5_VISION] No Effect detected', {
            testId: this.config.testId,
            consecutiveCount: this.consecutiveNoEffectCount,
            iteration: i,
          });
        } else {
          this.consecutiveNoEffectCount = 0; // Reset on any progress
        }

        // ═══════════════════════════════════════════════════════════════════════
        // L2 MANUS: Goal Refinement on significant change
        // ═══════════════════════════════════════════════════════════════════════
        if (LITE_ENGINE_FLAGS.enableGoalRefinement && this.expandedGoal) {
          const shouldRefine =
            (enrichedDiff.urlChanged && this.isSignificantUrlChange(enrichedDiff.urlBefore || '', enrichedDiff.urlAfter || '')) ||
            enrichedDiff.progressSentiment === 'Major Progress' ||
            FunnelAnalyzer.hasPhaseChanged(this.previousFunnelPhase, this.currentFunnelPhase);

          const now = Date.now();
          const cooldownElapsed = now - this.lastGoalRefinementTime > LITE_ENGINE_FLAGS.goalRefinementCooldownMs;

          if (shouldRefine && cooldownElapsed) {
            try {
              const refinedGoal = await GoalExpander.refine(
                this.config.goal,
                this.expandedGoal,
                snapshotAfter.url,
                snapshotAfter.elements,
                this.currentFunnelPhase,
                i
              );
              this.expandedGoal = refinedGoal;
              this.semanticWeightCalculator.updateGoal(refinedGoal);
              this.lastGoalRefinementTime = now;

              logger.info('[L2_REFINE] Goal refined for new phase', {
                testId: this.config.testId,
                phase: this.currentFunnelPhase,
                newKeywordCount: refinedGoal.allKeywords.size,
                iteration: i,
              });
            } catch (refineError) {
              logger.warn('[L2_REFINE] Goal refinement failed', {
                testId: this.config.testId,
                error: refineError instanceof Error ? refineError.message : String(refineError),
              });
            }
          }
        }

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
          snapshotAfter.elements.length,
          decision.command.action
        );

        // ═══════════════════════════════════════════════════════════════════════
        // WORKSTREAM 4: Set recovery point on progress
        // ═══════════════════════════════════════════════════════════════════════
        const hasProgress =
          enrichedDiff.progressSentiment === 'Major Progress' ||
          enrichedDiff.urlChanged ||
          outcome === 'state_changed';

        if (hasProgress) {
          this.setRecoveryPointForCurrentState(snapshotAfter, i);
        }

        // WORKSTREAM 4: Reset recovery attempts on meaningful URL/hash change or strong progress
        if (enrichedDiff.urlChanged) {
          const beforeKey = this.normalizeUrl(enrichedDiff.urlBefore || '');
          const afterKey = this.normalizeUrl(enrichedDiff.urlAfter || '');
          if (beforeKey && afterKey && beforeKey !== afterKey) {
            this.state.resetRecoveryAttempts(this.config.goal, enrichedDiff.urlAfter || snapshotAfter.url);
          }
        }

        if (enrichedDiff.progressSentiment === 'Major Progress') {
          this.state.resetRecoveryAttempts(this.config.goal, snapshotAfter.url);
        }

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
            await this.networkTracker.waitForNetworkIdle(this.adaptiveTimeouts?.networkIdleMs || 5000);
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

        // ═══════════════════════════════════════════════════════════════════════
        // ═══════════════════════════════════════════════════════════════════════
        // WORKSTREAM C: Record focused semantic metrics (goal-relevant + high-weight count)
        // ═══════════════════════════════════════════════════════════════════════
        let highWeightCount = 0;
        const goalRelevantElements = snapshotAfter.elements
          .filter(el => {
            // Get weight from HybridSemanticWeightCalculator (uses L2 ExpandedGoal)
            const heuristic = this.semanticWeightCalculator.calculateHeuristic(el);
            // Count high-weight elements (>=0.8) for "no growth" stuck detection
            if (heuristic.weight >= 0.8) {
              highWeightCount++;
            }
            return heuristic.weight >= 0.5; // Only include elements with >= 50% weight (significant)
          })
          .map(el => el.name || el.ref);

        this.state.recordFocusedMetrics(snapshotAfter.url, goalRelevantElements, highWeightCount);

        // 13b. Negative Reinforcement: Record failed/successful actions
        if (LITE_ENGINE_FLAGS.enableNegativeReinforcement && decision.command.ref) {
          // Clear all failed actions on URL change first (new page = new elements)
          if (diff.urlChanged) {
            this.state.clearFailedActions();
          } else {
            const failureOutcomes: ActionOutcome[] = ['no_effect', 'execution_error', 'validation_error'];
            if (failureOutcomes.includes(outcome)) {
              // Find element name for display
              const targetEl = snapshotBefore.elements.find(el => el.ref === decision.command.ref);
              const elementName = targetEl?.name || targetEl?.ariaLabel || targetEl?.placeholder || decision.command.ref;
              this.state.recordFailedAction(
                decision.command.action,
                decision.command.ref,
                elementName,
                outcome,
                i,
                execResult.error,
              );
            } else if (outcome === 'state_changed') {
              // Action succeeded — remove from failed actions
              this.state.removeFailedAction(decision.command.action, decision.command.ref);
            }
          }
        }

        // 13b2. Multi-Agent Brain: Invalidate observer cache on state change or URL change
        if (LITE_ENGINE_FLAGS.enableMultiAgentBrain && this.multiAgentOrchestrator) {
          if (outcome === 'state_changed' || diff.urlChanged) {
            this.multiAgentOrchestrator.invalidateCache(snapshotBefore.url);
          }
        }

        // 13c. State Drift Auditor: Record tracking data
        if (LITE_ENGINE_FLAGS.enableStateDriftAuditor) {
          this.state.recordUrlVisit(snapshotAfter.url);
          const allErrors = [...diff.newPageErrors, ...diff.newConsoleErrors];
          this.state.recordErrors(allErrors);
          this.state.recordErrorCount(allErrors.length);
          const currentRefs = new Set(snapshotAfter.elements.filter(el => el.visible).map(el => el.ref));
          this.state.recordElementRefSet(currentRefs);
        }

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
    if (TestRunRegistry.shouldSilenceEventsByTestId(this.config.testId)) {
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
  /**
   * Verify that the page contains goal-relevant content
   * Prevents false positives from 404→redirect scenarios
   */
  private verifyGoalRelevantPage(
    snapshot: LiteSnapshot,
    isRegistrationGoal: boolean,
    isLoginGoal: boolean
  ): boolean {
    // Minimum element count check
    if (snapshot.elements.length < 3) {
      return false;
    }

    const lowerText = snapshot.elements
      .map(el => `${el.name} ${el.context || ''}`.toLowerCase())
      .join(' ');

    // For registration goals: look for registration-specific fields or text
    if (isRegistrationGoal) {
      const hasEmailField = snapshot.elements.some(
        el => el.tag === 'input' && /email/i.test(el.name || el.type || '')
      );
      const hasPasswordField = snapshot.elements.some(
        el => el.tag === 'input' && /password/i.test(el.type || '')
      );
      const hasRegisterText = /register|sign\s*up|create.*account|зарегистр|регистрац/i.test(lowerText);

      return (hasEmailField && hasPasswordField) || hasRegisterText;
    }

    // For login goals: look for login-specific fields or text
    if (isLoginGoal) {
      const hasPasswordField = snapshot.elements.some(
        el => el.tag === 'input' && /password/i.test(el.type || '')
      );
      const hasLoginText = /login|sign\s*in|log\s*in|вход|войти/i.test(lowerText);

      return hasPasswordField || hasLoginText;
    }

    return true; // Default: accept for non-auth goals
  }

  private async tryDirectUrlFallback(
    currentUrl: string,
    options?: { forceLogin?: boolean }
  ): Promise<{
    navigated: boolean;
    finalUrl: string;
    attemptedPath?: string;
  }> {
    const goalLower = this.config.goal.toLowerCase();
    const forceLogin = options?.forceLogin === true;

    // Only for register/login goals
    const isRegistrationGoal = !forceLogin &&
      /register|sign\s*up|create\s+account|registration|зарегистр|регистрац/i.test(goalLower);
    const isLoginGoal = forceLogin ||
      /login|sign\s*in|log\s*in|вход|войти/i.test(goalLower);

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
          // Verify page contains goal-relevant content (not 404→redirect)
          await this.page.waitForTimeout(1000);
          const verificationSnapshot = await SnapshotCollector.collect(this.page);

          const contentVerified = this.verifyGoalRelevantPage(
            verificationSnapshot,
            isRegistrationGoal,
            isLoginGoal
          );

          if (!contentVerified) {
            logger.debug('[LITE_ENGINE] Direct URL fallback rejected - no goal-relevant content', {
              testId: this.config.testId,
              path,
              finalUrl,
              elementCount: verificationSnapshot.elements.length,
            });
            continue; // Try next path
          }

          logger.info('[LITE_ENGINE] Direct URL fallback successful', {
            testId: this.config.testId,
            attemptedPath: path,
            targetUrl,
            finalUrl,
            statusCode: response.status(),
            contentVerified: true,
          });

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

    // ✅ NEW: Get URL change from last state diff for auditor context
    const lastStateDiff = this.state.getLastStateDiff();
    const urlBefore = lastStateDiff?.diff.urlBefore;
    const urlAfter = lastStateDiff?.diff.urlAfter;
    const urlChanged = lastStateDiff?.diff.urlChanged || false;

    return {
      goal: this.config.goal,
      page: {
        url: snapshot.url,
        title: snapshot.title,
      },
      urlBefore,
      urlAfter,
      urlChanged,
      snapshotSummary,
      history: this.state.getFormattedHistory(5), // Last 5 iterations
      lastOutcome: this.state.getLastOutcome(),
      stuckCheck,
      consecutiveStuckCount: this.state.getConsecutiveStuckCount(),
      recentErrors,
      iteration,
      flowState: this.currentFlowState || undefined, // ✅ Task #21: Current flow state
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

    // ✅ HARDENING: Dispose PageWatcher to prevent listener leaks
    this.pageWatcher?.dispose();

    // ✅ NEW: Clear semantic weight cache and log stats
    const semanticStats = this.semanticWeightCalculator.getStats();
    this.semanticWeightCalculator.clearCache();
    logger.info('[LITE_ENGINE] Semantic weight stats', {
      testId: this.config.testId,
      cacheHits: semanticStats.cacheStats.hits,
      cacheMisses: semanticStats.cacheStats.misses,
      cacheSize: semanticStats.cacheStats.size,
      aiCalls: semanticStats.aiCalls,
      aiTimeouts: semanticStats.aiTimeouts,
      errorElementsDetected: semanticStats.errorElementsDetected,
      avgLatencyMs: semanticStats.aiCalls > 0 ? Math.round(semanticStats.totalLatencyMs / semanticStats.aiCalls) : 0,
    });

    // ✅ NEW: Add end node to graph and get full graph
    // ✅ FIX: Finalization flag should already be set by emitCompletion, but ensure it here
    this.isFinalizing = true;

    // Count unique pages visited from iteration records
    const iterationUrls = new Set(this.state.getAllIterations().map(it => it.stateBefore.url));
    this.state.getAllIterations().forEach(it => {
      if (it.result.stateDiff.urlChanged) iterationUrls.add(it.result.stateDiff.urlAfter);
    });
    const pagesVisitedCount = Math.max(iterationUrls.size, 1);

    const endUpdate = this.graphBuilder.addEndNode(success, reason, {
      pagesVisited: pagesVisitedCount,
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
        ...(this.multiAgentOrchestrator && {
          multiAgent: this.multiAgentOrchestrator.getRunMetrics(),
        }),
      },
    });

    // ✅ Close trace writer (flush pending writes) before uploading
    await this.traceWriter.close();

    // ✅ Upload trace log to Supabase Storage (production only)
    // In development, keep logs locally in test_logs/ for easy debugging
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction) {
      try {
        const traceFilePath = this.traceWriter.getFilePath();
        const runId = this.traceWriter.getRunId();
        const userId = this.config.userId;
        const testId = this.config.testId;

        // Validate UUIDs (trace_files requires UUID, not 'anonymous')
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isValidUserId = userId && UUID_REGEX.test(userId);
        const isValidTestId = testId && UUID_REGEX.test(testId);

        if (isValidUserId && isValidTestId) {
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

              const { uploadLiteTraceLogToStorage, insertTraceFileRecord, deleteLiteTraceLogFromStorage } = await import(
                '@/services/storage/test-artifacts-storage.service'
              );

              const fileName = path.basename(traceFilePath);
              const { storagePath, fileSize } = await uploadLiteTraceLogToStorage(
                traceFilePath,
                userId,
                fileName
              );

              let traceFileId: string | undefined;
              try {
                const { id } = await insertTraceFileRecord({
                  userId,
                  testId,
                  fileName,
                  storagePath,
                  fileSize,
                  browser: 'lite-trace-log',
                  status: 'uploaded',
                });
                traceFileId = id;
              } catch (insertError) {
                await deleteLiteTraceLogFromStorage(storagePath);
                throw insertError;
              }

              logger.info('[LITE_ENGINE] Trace log uploaded successfully', {
                testId,
                traceFileId,
                storagePath,
                runId,
              });

              // Clean up local file after successful upload (production only)
              try {
                await fs.unlink(traceFilePath);
                logger.debug('[LITE_ENGINE] Local trace log deleted', { traceFilePath });
              } catch (cleanupError) {
                logger.warn('[LITE_ENGINE] Failed to delete local trace log', {
                  traceFilePath,
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
              }
            }
          } catch (fileError) {
            logger.warn('[LITE_ENGINE] Trace log file not found or inaccessible, skipping upload', {
              testId,
              traceFilePath,
              error: fileError instanceof Error ? fileError.message : String(fileError),
            });
          }
        } else {
          // Non-UUID / anonymous runs
          const fs = await import('fs/promises');
          const path = await import('path');

          try {
            await fs.access(traceFilePath);
            const stats = await fs.stat(traceFilePath);

            if (stats.size > 0) {
              const { uploadLiteTraceLogToStorageAnonymous } = await import(
                '@/services/storage/test-artifacts-storage.service'
              );

              const fileName = path.basename(traceFilePath);
              const { storagePath } = await uploadLiteTraceLogToStorageAnonymous(traceFilePath, fileName);

              logger.info('[LITE_ENGINE] Trace log uploaded for non-UUID run (no DB record)', {
                testId,
                userId: userId?.substring(0, 20) || 'undefined',
                storagePath,
                runId,
              });

              // Clean up local file after successful upload (production only)
              try {
                await fs.unlink(traceFilePath);
                logger.debug('[LITE_ENGINE] Local trace log deleted (non-UUID run)', { traceFilePath });
              } catch (cleanupError) {
                logger.warn('[LITE_ENGINE] Failed to delete local trace log (non-UUID run)', {
                  traceFilePath,
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
              }
            }
          } catch (fileError) {
            logger.warn('[LITE_ENGINE] Trace log file not found or inaccessible (non-UUID run)', {
              traceFilePath,
              error: fileError instanceof Error ? fileError.message : String(fileError),
            });
          }
        }
      } catch (traceUploadError) {
        logger.error('[LITE_ENGINE] Failed to upload trace log', {
          testId: this.config.testId,
          error: traceUploadError instanceof Error ? traceUploadError.message : String(traceUploadError),
        });
      }
    } else {
      logger.info('[LITE_ENGINE] Keeping trace log locally (non-production)', {
        testId: this.config.testId,
        filePath: this.traceWriter.getFilePath(),
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

    // Multi-agent metrics (when enabled)
    const multiAgentMetrics = this.multiAgentOrchestrator?.getRunMetrics();

    // Build page visits and executed steps from iteration records
    const { pageVisits, uniquePagesVisited, executedSteps } = this.buildPageVisitsFromIterations();

    return {
      success,
      reason,
      iterations,
      history: this.state.getFormattedHistory(10), // Include last 10 iterations
      screenshots, // ✅ Lite mode: only final screenshot (after completion)
      duration, // Track actual execution time
      errors: this.collectedErrors, // ✅ Pro-grade error collection
      graphData, // ✅ Full graph like Pro
      ...(multiAgentMetrics && { multiAgentMetrics }),
      pageVisits,
      uniquePagesVisited,
      executedSteps,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSTREAM 4: STATE RECOVERY LADDER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Attempt state recovery using the priority ladder:
   * 1. Reload + retry last safe command
   * 2. GoBack / goto recoveryPoint URL (if we "flew away")
   * 3. Re-auth (if login pattern detected or anchor stale/zombie)
   * 4. Tier4 escalation (return need_help)
   *
   * @returns Object with recovery result and whether to continue or escalate
   */
  private async attemptStateRecovery(params: {
    reason: string;
    lastCommand?: AICommand;
    snapshotBefore: LiteSnapshot;
    iteration: number;
  }): Promise<{
    recovered: boolean;
    method: 'reload' | 'goBack' | 'goto' | 're-auth' | 'exhausted' | 'none';
    newSnapshot?: LiteSnapshot;
    shouldEscalate: boolean;
  }> {
    const { reason, lastCommand, snapshotBefore, iteration } = params;
    const goal = this.config.goal;
    const currentUrl = this.page.url();
    const recoveryKey = this.state.buildRecoveryKey(goal, currentUrl);

    // Check if recovery attempts are exhausted
    if (this.state.isRecoveryExhausted(goal, currentUrl)) {
      logger.warn('[RECOVERY] Attempts exhausted, escalating to Tier4', {
        testId: this.config.testId,
        reason,
      });
      return { recovered: false, method: 'exhausted', shouldEscalate: true };
    }

    // Get current funnel phase as type
    const currentPhaseType = this.currentFunnelPhase as unknown as FunnelPhaseType;

    // Check if we should use anchor-based recovery
    const recoveryPoint = this.state.getRecoveryPoint(currentPhaseType);

    // Check for zombie anchor (recovery led back to stuck quickly)
    if (this.state.shouldInvalidateRecoveryPoint(recoveryKey, iteration)) {
      if (recoveryPoint) {
        this.state.invalidateRecoveryPoint(currentPhaseType);
        logger.warn('[RECOVERY] Invalidated zombie anchor', {
          testId: this.config.testId,
          phase: currentPhaseType,
        });
      }

      // Hard reload path for zombie anchors
      const hardReloadSnapshot = await this.hardReload();
      return {
        recovered: true,
        method: 'reload',
        newSnapshot: hardReloadSnapshot,
        shouldEscalate: false,
      };
    }

    // Record recovery attempt for zombie detection
    this.state.recordRecoveryAttempt(recoveryKey, iteration);

    // Increment attempt counter
    const attemptCount = this.state.incRecoveryAttempt(goal, currentUrl);
    logger.info('[RECOVERY] Starting recovery attempt', {
      testId: this.config.testId,
      attempt: attemptCount,
      reason,
      url: currentUrl.slice(0, 50),
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Priority 1: Reload + retry last safe command
    // ═══════════════════════════════════════════════════════════════════════
    try {
      logger.info('[RECOVERY] Priority 1: Reload + retry', { testId: this.config.testId });

      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.networkTracker.waitForNetworkIdle(this.adaptiveTimeouts?.networkIdleMs || 5000);
      await VisualStability.waitForStable(this.page);

      const newSnapshot = await SnapshotCollector.collect(this.page);

      // Check if last command is safe to retry
      const safeActions = ['click', 'fill', 'select', 'scroll', 'wait', 'hover'];
      const canRetry = lastCommand && safeActions.includes(lastCommand.action);

      if (canRetry && lastCommand) {
        logger.debug('[RECOVERY] Retrying last command after reload', {
          action: lastCommand.action,
          ref: lastCommand.ref,
        });

        // Re-apply credential override if fill
        const commandWithCreds = this.overrideCredentialFillValue(lastCommand, newSnapshot);

        try {
          await this.executor.execute(commandWithCreds, newSnapshot);
          // Wait for potential navigation after retry
          try {
            await this.networkTracker.waitForNetworkIdle(5000);
            await VisualStability.waitForStable(this.page);
          } catch { /* timeout OK */ }
          const postRetrySnapshot = await SnapshotCollector.collect(this.page);
          logger.info('[RECOVERY] Reload + retry successful', { testId: this.config.testId });
          return { recovered: true, method: 'reload', newSnapshot: postRetrySnapshot, shouldEscalate: false };
        } catch (retryError) {
          logger.debug('[RECOVERY] Retry failed after reload', {
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
      }

      // Only treat as recovered if state changed meaningfully
      const meaningfulChange = this.isMeaningfulSnapshotChange(snapshotBefore, newSnapshot);

      // TASK 8: SPA-aware recovery - check content hash for SPA changes
      const newContentHash = this.state.computeContentHash(newSnapshot);
      const oldContentHash = recoveryPoint?.contentHash;
      const spaDetected = oldContentHash && newContentHash !== oldContentHash;

      if (meaningfulChange || spaDetected) {
        logger.debug('[RECOVERY] State changed', {
          meaningfulChange,
          spaDetected,
          testId: this.config.testId,
        });
        return { recovered: true, method: 'reload', newSnapshot, shouldEscalate: false };
      }
    } catch (reloadError) {
      logger.warn('[RECOVERY] Reload failed, trying Priority 2', {
        error: reloadError instanceof Error ? reloadError.message : String(reloadError),
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Priority 2: GoBack / goto recoveryPoint URL (if we "flew away")
    // ═══════════════════════════════════════════════════════════════════════
    const currentUrlNormalized = this.normalizeUrl(currentUrl);
    const originalUrlNormalized = this.normalizeUrl(this.config.url);
    const recoveryUrlNormalized = recoveryPoint ? this.normalizeUrl(recoveryPoint.url) : null;

    // Check if we "flew away" from expected path
    const flewAway = currentUrlNormalized !== originalUrlNormalized &&
      recoveryUrlNormalized &&
      currentUrlNormalized !== recoveryUrlNormalized;

    if (flewAway && recoveryPoint) {
      try {
        logger.info('[RECOVERY] Priority 2: GoBack/goto recovery URL', {
          testId: this.config.testId,
          currentUrl: currentUrl.slice(0, 50),
          recoveryUrl: recoveryPoint.url.slice(0, 50),
        });

        // Try goBack first
        try {
          await this.page.goBack({ timeout: 10000 });
          await this.networkTracker.waitForNetworkIdle(this.adaptiveTimeouts?.networkIdleMs || 5000);
          await VisualStability.waitForStable(this.page);

          const newSnapshot = await SnapshotCollector.collect(this.page);

          // TASK 8: Verify content changed for SPA success detection
          const newContentHash = this.state.computeContentHash(newSnapshot);
          const contentChanged = !recoveryPoint.contentHash || newContentHash !== recoveryPoint.contentHash;

          logger.info('[RECOVERY] GoBack successful', {
            testId: this.config.testId,
            contentChanged,
          });
          return { recovered: true, method: 'goBack', newSnapshot, shouldEscalate: false };
        } catch {
          // GoBack failed, try direct goto
          await this.page.goto(recoveryPoint.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await this.networkTracker.waitForNetworkIdle(this.adaptiveTimeouts?.networkIdleMs || 5000);
          await VisualStability.waitForStable(this.page);

          const newSnapshot = await SnapshotCollector.collect(this.page);

          // TASK 8: Verify content matches recovery point for SPA detection
          const newContentHash = this.state.computeContentHash(newSnapshot);
          const contentMatches = recoveryPoint.contentHash === newContentHash;

          logger.info('[RECOVERY] Goto recovery URL successful', {
            testId: this.config.testId,
            contentMatches,
          });
          return { recovered: true, method: 'goto', newSnapshot, shouldEscalate: false };
        }
      } catch (navError) {
        logger.warn('[RECOVERY] Navigation recovery failed', {
          error: navError instanceof Error ? navError.message : String(navError),
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Priority 3: Re-auth (if login pattern detected or anchor stale/zombie)
    // ═══════════════════════════════════════════════════════════════════════
    const isAuthUrl = /\/login|\/signin|\/auth\/login|вход|войти/i.test(currentUrl);
    const anchorStaleOrZombie = !recoveryPoint; // null means stale or zombie

    if (isAuthUrl || anchorStaleOrZombie) {
      logger.info('[RECOVERY] Priority 3: Re-auth', {
        testId: this.config.testId,
        isAuthUrl,
        anchorStaleOrZombie,
      });

      // Deterministic re-auth: navigate to login URL if possible
      if (this.config.credentials) {
        const fallbackResult = await this.tryDirectUrlFallback(currentUrl, { forceLogin: true });
        if (fallbackResult.navigated) {
          const newSnapshot = await SnapshotCollector.collect(this.page);
          return { recovered: true, method: 're-auth', newSnapshot, shouldEscalate: false };
        }

        // If already on auth URL, just proceed with current page
        if (isAuthUrl) {
          const newSnapshot = await SnapshotCollector.collect(this.page);
          return { recovered: true, method: 're-auth', newSnapshot, shouldEscalate: false };
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Nothing worked - return for main loop to continue
    // ═══════════════════════════════════════════════════════════════════════
    logger.warn('[RECOVERY] All recovery methods failed for this attempt', {
      testId: this.config.testId,
      attemptCount,
    });

    return { recovered: false, method: 'none', shouldEscalate: false };
  }

  /**
   * Normalize URL for comparison (origin + pathname, no query/hash)
   */
  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.origin + urlObj.pathname + urlObj.hash;
    } catch {
      return url;
    }
  }

  /**
   * Check if snapshot changed meaningfully after recovery
   */
  private isMeaningfulSnapshotChange(before: LiteSnapshot, after: LiteSnapshot): boolean {
    if (before.url !== after.url) return true;
    if (before.title !== after.title) return true;
    const elementDelta = Math.abs(before.elements.length - after.elements.length);
    return elementDelta >= 3;
  }

  /**
   * WORKSTREAM 4: Best-effort hard reload (clears runtime caches)
   */
  private async hardReload(): Promise<LiteSnapshot> {
    try {
      this.semanticWeightCalculator.clearCache();
      this.state.clearVisualSignatures();
    } catch {
      // Best-effort cache clearing
    }

    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await this.networkTracker.waitForNetworkIdle(this.adaptiveTimeouts?.networkIdleMs || 5000);
    await VisualStability.waitForStable(this.page);
    return await SnapshotCollector.collect(this.page);
  }

  /**
   * Set a recovery point for the current state (called on progress)
   */
  private setRecoveryPointForCurrentState(snapshot: LiteSnapshot, iteration: number): void {
    const phaseType = this.currentFunnelPhase as unknown as FunnelPhaseType;
    const contentHash = this.state.computeContentHash(snapshot);
    const point: RecoveryPoint = {
      url: snapshot.url,
      snapshot,
      funnelPhase: phaseType,
      timestamp: Date.now(),
      iteration,
      contentHash,
    };
    this.state.setRecoveryPoint(point);
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
    if (TestRunRegistry.shouldSilenceEventsByTestId(this.config.testId)) {
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
        sessionId: this.config.chatSessionId, // Chat session for routing isolation
      };

      // ✅ Use webSocketService.emitTestGraphUpdate for proper routing (test room + chat room)
      webSocketService.emitTestGraphUpdate(this.config.testId, payload as any);

      // Fallback: also emit to user room if no sessionId (backward compatibility)
      if (!this.config.chatSessionId) {
        webSocketService.emitToUser(this.config.userId, 'test:graph-update', payload);
      }

      logger.debug('[LITE_ENGINE] Graph update emitted', {
        testId: this.config.testId,
        type: normalized.type,
        hasNewNode: !!normalized.newNode,
        hasNewEdge: !!normalized.newEdge,
        hasUpdatedNode: !!normalized.updatedNode,
        hasFullGraph: !!normalized.fullGraph,
        hasSessionId: !!this.config.chatSessionId,
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

  /**
   * PHASE 0.3: Helper method to extract AI decision logic
   * Wrapped for easier testing and auto-fill bypass
   * Multi-Agent Brain: When enabled, tries orchestrator first, falls back to monolithic
   */
  private async getAIDecision(
    prompt: string,
    iteration: number,
    iterationSpanId: string,
    snapshotBefore: LiteSnapshot,
    multiAgentContext?: Omit<MultiAgentInput, 'url' | 'title' | 'iteration' | 'contentHash'>,
  ): Promise<AIDecision> {
    // Multi-Agent Brain: Try orchestrator first when enabled
    if (LITE_ENGINE_FLAGS.enableMultiAgentBrain && this.multiAgentOrchestrator && multiAgentContext) {
      try {
        const contentHash = this.state.computeContentHash(snapshotBefore);
        const result = await this.multiAgentOrchestrator.execute({
          ...multiAgentContext,
          url: snapshotBefore.url,
          title: snapshotBefore.title,
          iteration,
          contentHash,
        });

        if (result.success && result.decision) {
          // Trace multi-agent debug info
          this.traceWriter.write({
            iteration,
            stage: 'ai_decision',
            eventType: 'multi_agent_debug',
            spanId: this.traceWriter.generateSpanId(),
            parentSpanId: iterationSpanId,
            payload: {
              success: true,
              debug: result.debug,
              thought: result.decision.thought,
              command: this.buildSafeCommandForTrace(result.decision.command, snapshotBefore),
            },
          });

          // Manus-style: Store expectedOutcome for next iteration's expectation validation
          this.lastExpectedOutcome = result.expectedOutcome;

          return result.decision as AIDecision;
        }

        // Record critic-rejected action in blacklist so Strategist avoids it next iteration
        if (LITE_ENGINE_FLAGS.enableNegativeReinforcement && result.rejectedAction) {
          this.state.recordFailedAction(
            result.rejectedAction.action,
            result.rejectedAction.ref,
            result.rejectedAction.elementHint,
            'critic_rejected',
            iteration,
            result.rejectedAction.reason,
          );
        }

        // Fall through to monolithic if orchestrator failed
        // Clear stale expectation so next Observer doesn't validate against wrong prediction
        this.lastExpectedOutcome = undefined;
        this.traceWriter.write({
          iteration,
          stage: 'ai_decision',
          eventType: 'multi_agent_debug',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: iterationSpanId,
          payload: {
            success: false,
            fallbackReason: 'orchestrator_failed',
          },
        });
        logger.info('[LITE_ENGINE] Multi-agent failed, falling back to monolithic', {
          testId: this.config.testId,
          iteration,
        });
      } catch (error) {
        this.lastExpectedOutcome = undefined;
        this.traceWriter.write({
          iteration,
          stage: 'ai_decision',
          eventType: 'multi_agent_debug',
          spanId: this.traceWriter.generateSpanId(),
          parentSpanId: iterationSpanId,
          payload: {
            success: false,
            fallbackReason: 'orchestrator_error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        logger.warn('[LITE_ENGINE] Multi-agent error, falling back to monolithic', {
          testId: this.config.testId,
          iteration,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Monolithic path (existing behavior)
    // Inject accumulated context from multi-agent brain if available
    let monolithicPrompt = prompt;
    if (LITE_ENGINE_FLAGS.preserveContextOnFallback && this.multiAgentOrchestrator) {
      const accCtx = this.multiAgentOrchestrator.getAccumulatedContext();
      if (accCtx) {
        const ctxSection = LitePromptBuilder.formatAccumulatedContext(accCtx);
        if (ctxSection) {
          const historyMarker = '\nHISTORY:\n';
          const idx = monolithicPrompt.indexOf(historyMarker);
          if (idx !== -1) {
            monolithicPrompt = monolithicPrompt.slice(0, idx) + ctxSection + monolithicPrompt.slice(idx);
          } else {
            monolithicPrompt = monolithicPrompt + '\n' + ctxSection;
          }
        }
      }
    }

    // Trace AI prompt
    const aiPromptSpanId = this.traceWriter.generateSpanId();
    this.traceWriter.write({
      iteration,
      stage: 'ai_decision',
      eventType: 'ai_prompt',
      spanId: aiPromptSpanId,
      parentSpanId: iterationSpanId,
      payload: {
        prompt: monolithicPrompt,
        model: LITE_ENGINE_FLAGS.coreBrainModel,
        promptLength: monolithicPrompt.length,
        estimatedTokens: Math.ceil(monolithicPrompt.length / 4),
      },
    });

    // Ask AI
    const decision = await withCancellation(
      this.config.testId,
      LitePromptBuilder.askAI(monolithicPrompt),
      'LitePromptBuilder.askAI'
    );

    // Trace AI response (with redaction)
    const safeCommand = this.buildSafeCommandForTrace(decision?.command, snapshotBefore);
    const safeDecision = {
      ...decision,
      command: safeCommand,
    };
    this.traceWriter.write({
      iteration,
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
        analysis: decision.analysis,
      },
    });

    return decision;
  }

  /**
   * Wait for at least one pending network request to appear.
   * Used after form submit to detect the auth API call before checking networkIdle.
   * Without this, networkIdle resolves instantly because the request hasn't fired yet.
   */
  private waitForPendingRequest(timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (this.networkTracker.getPendingCount() > 0) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('No pending request within timeout'));
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * PHASE 0.3: Build auto-credential command based on current fill state
   * Returns command if target element found, null otherwise
   */
  private buildAutoCredentialCommand(snapshot: LiteSnapshot): AICommand | null {
    const { username, email, phone, password } = this.config.credentials || {};
    // Fallback chain: username → email → phone (matches overrideCommandWithCredentials logic)
    const usernameValue = username || email || phone;

    switch (this.credentialFillState) {
      case 'filling_username': {
        // Find username/email field
        const usernameField = snapshot.elements.find(el => {
          if (el.tag !== 'input' || !el.visible || el.disabled) return false;

          const classification = classifyField(el);
          return (
            classification.kind === 'username' ||
            classification.kind === 'email'
          ) && !el.hasValue; // Don't fill if already filled
        });

        if (usernameField && usernameValue) {
          this.credentialFillState = 'filling_password';
          return { action: 'fill', ref: usernameField.ref, value: usernameValue };
        }

        // Skip to password if username field not found or no username
        this.credentialFillState = 'filling_password';
        return this.buildAutoCredentialCommand(snapshot);
      }

      case 'filling_password': {
        // Find password field
        const passwordField = snapshot.elements.find(el => {
          if (el.tag !== 'input' || !el.visible || el.disabled) return false;

          const classification = classifyField(el);
          return classification.kind === 'password' && !el.hasValue;
        });

        if (passwordField && password) {
          this.credentialFillState = 'submitting';
          return { action: 'fill', ref: passwordField.ref, value: password };
        }

        // Can't find password field
        break;
      }

      case 'submitting': {
        // Find submit button
        const submitButton = snapshot.elements.find(el => {
          if (!el.visible || el.disabled) return false;

          const isButton = el.role === 'button' || el.tag === 'button' ||
            (el.tag === 'input' && el.type === 'submit');

          const hasSubmitText = /submit|login|sign.?in|log.?in|continue|enter|next|войти|вход|кіру|увійти|giriş|вхід|жіберу|отправить/i.test(el.name);

          return isButton && hasSubmitText;
        });

        if (submitButton) {
          this.credentialFillState = 'done';
          return { action: 'click', ref: submitButton.ref };
        }

        // Can't find submit button
        break;
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE VISITS & EXECUTED STEPS CONVERSION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect page type from URL path using simple heuristics
   */
  private detectPageTypeFromUrl(url: string): PageType {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (/\/(login|auth|signin|sign-in|authorization)/.test(path)) return 'login';
      if (/\/(register|signup|sign-up)/.test(path)) return 'register';
      if (/\/dashboard/.test(path)) return 'dashboard';
      if (/\/cart/.test(path)) return 'cart';
      if (/\/(checkout|payment)/.test(path)) return 'checkout';
      if (/\/search/.test(path)) return 'search_results';
      if (/\/(profile|account)/.test(path)) return 'profile';
      if (/\/settings/.test(path)) return 'settings';
      if (/\/(category|catalog)/.test(path)) return 'category';
      if (/\/(product|item)/.test(path)) return 'product';
      if (path === '/' || path === '') return 'home';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Map AICommand action to DynamicAction action type
   */
  private mapCommandToDynamicAction(cmd: AICommand, thought: string): DynamicAction {
    const actionMap: Record<string, DynamicAction['action']> = {
      click: 'click',
      fill: 'fill',
      press: 'press',
      goto: 'goto',
      scroll: 'scroll',
      select: 'select',
      hover: 'hover',
      wait: 'wait',
    };

    return {
      action: actionMap[cmd.action] || 'click',
      selector: cmd.ref,
      value: cmd.value,
      url: cmd.url,
      description: thought,
    };
  }

  /**
   * Build PageVisit[] and executedSteps[] from iteration records.
   * Groups iterations by URL and creates structured data for DB storage.
   */
  private buildPageVisitsFromIterations(): {
    pageVisits: PageVisit[];
    uniquePagesVisited: number;
    executedSteps: LiteTestResult['executedSteps'];
  } {
    const iterations = this.state.getAllIterations();
    if (iterations.length === 0) {
      return { pageVisits: [], uniquePagesVisited: 1, executedSteps: [] };
    }

    const pageVisits: PageVisit[] = [];
    const executedSteps: NonNullable<LiteTestResult['executedSteps']> = [];
    const uniqueUrls = new Set<string>();
    let currentPageVisit: PageVisit | null = null;
    let cumulativeDuration = 0;

    for (let i = 0; i < iterations.length; i++) {
      const iter = iterations[i];
      const url = iter.stateBefore.url;
      uniqueUrls.add(url);

      // Check if we need to start a new PageVisit (URL changed from previous)
      if (!currentPageVisit || currentPageVisit.url !== url) {
        // Finalize previous page visit
        if (currentPageVisit) {
          currentPageVisit.success = (currentPageVisit.actionResults || []).some(r => r.success);
        }
        // Start new page visit
        currentPageVisit = {
          url,
          pageType: this.detectPageTypeFromUrl(url),
          timestamp: this.startTime + cumulativeDuration,
          actions: [],
          actionResults: [],
          success: false,
        };
        pageVisits.push(currentPageVisit);
      }

      // Build DynamicAction from AICommand
      const cmd = iter.decision.command;
      const thought = iter.decision.thought;
      const dynamicAction = this.mapCommandToDynamicAction(cmd, thought);
      currentPageVisit.actions.push(dynamicAction);

      // Build ActionResult
      const actionResult: ActionResult = {
        action: dynamicAction,
        success: iter.result.success,
        error: iter.result.error,
        urlChanged: iter.result.stateDiff.urlChanged,
        urlBefore: iter.result.stateDiff.urlBefore,
        urlAfter: iter.result.stateDiff.urlAfter,
        timestamp: this.startTime + cumulativeDuration,
        durationMs: iter.result.duration,
      };
      currentPageVisit.actionResults!.push(actionResult);

      // Track URL after action
      if (iter.result.stateDiff.urlChanged) {
        uniqueUrls.add(iter.result.stateDiff.urlAfter);
      }

      // Build executed step event
      executedSteps.push({
        ts: new Date(this.startTime + cumulativeDuration).toISOString(),
        type: 'step_completed',
        data: {
          step: i + 1,
          action: cmd.action,
          description: thought,
          success: iter.result.success,
          url,
        },
      });

      cumulativeDuration += iter.result.duration;
    }

    // Finalize last page visit
    if (currentPageVisit) {
      currentPageVisit.success = (currentPageVisit.actionResults || []).some(r => r.success);
    }

    return {
      pageVisits,
      uniquePagesVisited: uniqueUrls.size,
      executedSteps,
    };
  }

}
