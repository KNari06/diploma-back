/**
 * TimeoutGovernor — Adaptive Timeout System for LiteEngine
 *
 * Replaces the hardcoded 5-minute timeout with an intelligent system that
 * extends or reduces test time based on real-time progress signals.
 *
 * Architecture:
 * - Tier 1 (every iteration, 0 tokens, <1ms): deterministic checks + stall monitor
 * - Tier 2 (gated, max 5-6 per test): AI narrative call at decision points
 *
 * Stall Monitor detects patterns that isStuck() misses:
 * - 2-state oscillation (URL/hash trajectory)
 * - Validation error cycles (network error repetition)
 * - 2-URL ping-pong (URL frequency)
 * - Blacklist deadlock (outcome monotony + accomplishment plateau)
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type UrgencyLevel = 'normal' | 'hurry' | 'critical';

/** Snapshot of a single iteration for the stall monitor sliding window */
export interface IterationSnapshot {
  iteration: number;
  url: string;
  outcome: string;
  action: string;
  ref: string | null;
  networkErrors: Array<{ method: string; url: string; status: number }>;
  accomplishmentAdded: boolean;
  durationMs: number;
}

/** Stall signals computed from the sliding window */
export interface StallSignals {
  urlRepetition: { detected: boolean; url?: string; count?: number };
  errorRepetition: { detected: boolean; pattern?: string; count?: number };
  outcomeMonotony: { detected: boolean; badCount: number; total: number };
  accomplishmentPlateau: { detected: boolean; iterationsSinceLast: number };
  actionRepetition: { detected: boolean; action?: string; ref?: string; count?: number };
  isStalled: boolean;
}

/** Full input to the governor — assembled by lite-engine.ts each iteration */
export interface TimeoutGovernorInput {
  // Time
  elapsedMs: number;
  iteration: number;

  // Latest iteration data (for stall window)
  latestSnapshot: IterationSnapshot;

  // Progress (heuristic — labeled as such in AI prompt)
  progressScore: number;

  // Plan
  planSteps: Array<{ id: string; goal: string; status: string }> | null;
  planStepChanged: boolean;

  // Stuck (from LiteState)
  stuck: boolean;
  consecutiveStuckCount: number;
  stuckReason: string | null;
  consecutiveNoEffectCount: number;

  // Blockers
  currentBlocker: string | null;
  lastBlockerInfo: { type: string; description: string } | null;
  blockerDurationMs: number;

  // Health
  circuitBreakerOpen: boolean;
  visionAttemptedForPage: boolean;

  // Time compensations (cumulative from test start)
  clarificationPauseMs: number;
  rateLimitBackoffMs: number;

  // Narrative context (for Tier 2 AI)
  goal: string;
  currentUrl: string;
  pageTitle: string;
  accomplishments: string[];
  visitedPages: Record<string, { visitCount: number; pageType?: string }>;
  last5Outcomes: Array<{ iteration: number; action: string; outcome: string; durationMs: number }>;
  recentNetworkErrors: Array<{ method: string; url: string; status: number }>;
  recentConsoleErrors: string[];
}

/** Tier 1 decision output */
export interface TimeoutDecision {
  deadlineMs: number;
  remainingMs: number;
  urgencyLevel: UrgencyLevel;
  extended: boolean;
  extensionMs: number;
  extensionReason: string | null;
  shouldTerminate: boolean;
  terminateReason: string | null;
  skipCritic: boolean;
  gateTriggered: string | null;
  stallSignals: StallSignals;
  requiresAICall: boolean;
}

/** Tier 2 AI decision */
export interface AITimeoutDecision {
  decision: 'extend' | 'continue' | 'reduce' | 'terminate' | 'partial_success';
  extensionMs: number;
  reason: string;
  confidence: number;
}

/** Constructor config */
export interface TimeoutGovernorConfig {
  baseTimeoutMs: number;
  maxTimeoutMs: number;
  extensionMaxPerCallMs: number;
  hurryThresholdMs: number;
  criticalThresholdMs: number;
  stallWindowSize: number;
  stallUrlThreshold: number;
  stallErrorThreshold: number;
  stallOutcomeThreshold: number;
  stallAccomplishmentIters: number;
  /**
   * P2 fix — blocker-persist gate threshold. When a known blocker
   * (e.g. captcha, 2FA, file-upload prompt) has been outstanding for
   * longer than this duration, fire the `blocker_decision` gate to
   * trigger an AI deadline-extension narrative. Default 30000ms (30s)
   * — was hardcoded inline at line 532.
   */
  blockerPersistMs: number;
}

/** Extension log entry */
interface ExtensionLogEntry {
  iteration: number;
  amount: number;
  reason: string;
  gate: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class TimeoutGovernor {
  private readonly config: TimeoutGovernorConfig;

  // Mutable state
  private currentDeadlineMs: number;
  private totalExtensionsMs = 0;
  private totalCompensationsMs = 0;
  private lastCompensatedClarificationMs = 0;
  private lastCompensatedBackoffMs = 0;
  private gatesFired = new Map<string, number>();
  private lastPlanStepIndex = -1;
  private firstPlanStepSeen = false; // suppress plan_milestone on iter 0
  private stallWindow: IterationSnapshot[] = [];
  private iterationsSinceLastAccomplishment = 0;
  // Note: stall_detected fires max 2x total (hard-capped by gatesFired counter)
  private extensionLog: ExtensionLogEntry[] = [];
  private blockerStartIteration: number | null = null;
  private blockerType: string | null = null;

  constructor(config: TimeoutGovernorConfig) {
    this.config = config;
    this.currentDeadlineMs = Math.min(config.baseTimeoutMs, config.maxTimeoutMs);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: Deterministic evaluation (every iteration, 0 tokens, <1ms)
  // ═══════════════════════════════════════════════════════════════════════════

  evaluate(input: TimeoutGovernorInput): TimeoutDecision {
    // 1. Update stall window
    this.updateStallWindow(input.latestSnapshot);

    // 2. Auto-compensate lost time (clarification gates, rate limit backoff)
    const deadlineBeforeCompensation = this.currentDeadlineMs;
    this.autoCompensate(input);
    const autoCompensated = this.currentDeadlineMs > deadlineBeforeCompensation;

    // 3. Compute remaining
    const remainingMs = this.currentDeadlineMs - input.elapsedMs;

    // 4. Immediate terminate checks
    const terminateCheck = this.checkImmediateTermination(input);
    if (terminateCheck) {
      return {
        deadlineMs: this.currentDeadlineMs,
        remainingMs: Math.max(0, remainingMs),
        urgencyLevel: 'critical',
        extended: false,
        extensionMs: 0,
        extensionReason: null,
        shouldTerminate: true,
        terminateReason: terminateCheck,
        skipCritic: true,
        gateTriggered: null,
        stallSignals: this.computeStallSignals(),
        requiresAICall: false,
      };
    }

    // 5. Compute stall signals
    const stallSignals = this.computeStallSignals();

    // 6. Track blocker duration
    this.trackBlocker(input);

    // 8. Check gates (may trigger Tier 2 AI call)
    const gate = this.checkGates(input, stallSignals, remainingMs);

    // 9. Compute urgency level
    const updatedRemainingMs = this.currentDeadlineMs - input.elapsedMs;
    const urgencyLevel = this.computeUrgency(updatedRemainingMs);

    return {
      deadlineMs: this.currentDeadlineMs,
      remainingMs: Math.max(0, updatedRemainingMs),
      urgencyLevel,
      extended: autoCompensated,
      extensionMs: autoCompensated ? this.currentDeadlineMs - deadlineBeforeCompensation : 0,
      extensionReason: autoCompensated ? 'Auto-compensation for external time sinks' : null,
      shouldTerminate: false,
      terminateReason: null,
      skipCritic: urgencyLevel === 'critical',
      gateTriggered: gate,
      stallSignals,
      requiresAICall: gate !== null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: AI Narrative evaluation (gated, max 5-6 per test)
  // ═══════════════════════════════════════════════════════════════════════════

  async evaluateWithAI(
    input: TimeoutGovernorInput,
    gate: string,
    stallSignals: StallSignals,
  ): Promise<AITimeoutDecision> {
    const narrative = this.buildNarrative(input, gate, stallSignals);

    try {
      const response = await Promise.race([
        getChatCompletionWithMessages(
          [{ role: 'user', content: narrative }],
          {
            model: AI_TASK_MODELS.coreBrain,
            temperature: 0.05,
            response_format: { type: 'json_object' },
            max_tokens: 300,
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TimeoutGovernor AI timeout')), 8000),
        ),
      ]);

      const content = response.content;
      if (!content) {
        logger.warn('[TIMEOUT_GOVERNOR] Empty AI response, defaulting to continue');
        return { decision: 'continue', extensionMs: 0, reason: 'AI returned empty', confidence: 0 };
      }

      let parsed: AITimeoutDecision;
      try {
        parsed = JSON.parse(content) as AITimeoutDecision;
      } catch (parseErr) {
        logger.warn('[TIMEOUT_GOVERNOR] Failed to parse AI JSON response', {
          gate,
          content: content.slice(0, 200),
        });
        return { decision: 'continue', extensionMs: 0, reason: 'Invalid AI JSON response', confidence: 0 };
      }

      // Validate and cap extension
      if (parsed.decision === 'extend') {
        parsed.extensionMs = Math.min(
          parsed.extensionMs || 0,
          this.config.extensionMaxPerCallMs,
        );
      }

      // Apply decision
      this.applyAIDecision(parsed, input.iteration, gate, input.elapsedMs);

      logger.info('[TIMEOUT_GOVERNOR] AI decision', {
        gate,
        decision: parsed.decision,
        extensionMs: parsed.extensionMs,
        reason: parsed.reason?.slice(0, 100),
        confidence: parsed.confidence,
        newDeadlineMs: this.currentDeadlineMs,
      });

      return parsed;
    } catch (err) {
      logger.warn('[TIMEOUT_GOVERNOR] AI call failed, defaulting to continue', {
        gate,
        error: err instanceof Error ? err.message : String(err),
      });
      return { decision: 'continue', extensionMs: 0, reason: 'AI call failed', confidence: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  getCurrentDeadlineMs(): number {
    return this.currentDeadlineMs;
  }

  getExtensionLog(): ReadonlyArray<ExtensionLogEntry> {
    return this.extensionLog;
  }

  getStallSignals(): StallSignals {
    return this.computeStallSignals();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Stall window management
  // ═══════════════════════════════════════════════════════════════════════════

  private updateStallWindow(snapshot: IterationSnapshot): void {
    this.stallWindow.push(snapshot);
    if (this.stallWindow.length > this.config.stallWindowSize) {
      this.stallWindow.shift();
    }

    // Track accomplishment plateau
    if (snapshot.accomplishmentAdded) {
      this.iterationsSinceLastAccomplishment = 0;
    } else {
      this.iterationsSinceLastAccomplishment++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Stall signal computation
  // ═══════════════════════════════════════════════════════════════════════════

  private computeStallSignals(): StallSignals {
    const window = this.stallWindow;
    const size = window.length;

    if (size < 3) {
      return {
        urlRepetition: { detected: false },
        errorRepetition: { detected: false },
        outcomeMonotony: { detected: false, badCount: 0, total: size },
        accomplishmentPlateau: { detected: false, iterationsSinceLast: this.iterationsSinceLastAccomplishment },
        actionRepetition: { detected: false },
        isStalled: false,
      };
    }

    // URL frequency
    const urlCounts = new Map<string, number>();
    for (const snap of window) {
      urlCounts.set(snap.url, (urlCounts.get(snap.url) || 0) + 1);
    }
    let urlRepetition: StallSignals['urlRepetition'] = { detected: false };
    for (const [url, count] of urlCounts) {
      if (count >= this.config.stallUrlThreshold) {
        urlRepetition = { detected: true, url, count };
        break;
      }
    }

    // Network error repetition (normalize: method + status)
    const errorPatterns = new Map<string, number>();
    for (const snap of window) {
      for (const err of snap.networkErrors) {
        const key = `${err.method} ${err.status}`;
        errorPatterns.set(key, (errorPatterns.get(key) || 0) + 1);
      }
    }
    let errorRepetition: StallSignals['errorRepetition'] = { detected: false };
    for (const [pattern, count] of errorPatterns) {
      if (count >= this.config.stallErrorThreshold) {
        errorRepetition = { detected: true, pattern, count };
        break;
      }
    }

    // Outcome monotony (no_effect + validation_error + execution_error)
    const badOutcomes = new Set(['no_effect', 'validation_error', 'execution_error', 'critic_rejected']);
    let badCount = 0;
    for (const snap of window) {
      if (badOutcomes.has(snap.outcome)) badCount++;
    }
    const outcomeMonotony: StallSignals['outcomeMonotony'] = {
      detected: badCount >= this.config.stallOutcomeThreshold,
      badCount,
      total: size,
    };

    // Accomplishment plateau
    const accomplishmentPlateau: StallSignals['accomplishmentPlateau'] = {
      detected: this.iterationsSinceLastAccomplishment >= this.config.stallAccomplishmentIters,
      iterationsSinceLast: this.iterationsSinceLastAccomplishment,
    };

    // Action+ref repetition
    const actionCounts = new Map<string, number>();
    for (const snap of window) {
      const key = `${snap.action}|${snap.ref || ''}`;
      actionCounts.set(key, (actionCounts.get(key) || 0) + 1);
    }
    let actionRepetition: StallSignals['actionRepetition'] = { detected: false };
    for (const [key, count] of actionCounts) {
      if (count >= this.config.stallErrorThreshold) { // Reuse error threshold (3) for action repetition
        const [action, ref] = key.split('|');
        actionRepetition = { detected: true, action, ref: ref || undefined, count };
        break;
      }
    }

    const isStalled = urlRepetition.detected
      || errorRepetition.detected
      || outcomeMonotony.detected
      || accomplishmentPlateau.detected
      || actionRepetition.detected;

    return { urlRepetition, errorRepetition, outcomeMonotony, accomplishmentPlateau, actionRepetition, isStalled };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Auto-compensation for external time sinks
  // ═══════════════════════════════════════════════════════════════════════════

  private autoCompensate(input: TimeoutGovernorInput): void {
    // Compensate clarification gate pauses
    const clarificationDelta = input.clarificationPauseMs - this.lastCompensatedClarificationMs;
    if (clarificationDelta > 0) {
      this.extendDeadline(clarificationDelta, input.iteration, 'Clarification gate time compensation', null);
      this.totalCompensationsMs += clarificationDelta;
      this.lastCompensatedClarificationMs = input.clarificationPauseMs;
    }

    // Compensate rate limit backoff pauses
    const backoffDelta = input.rateLimitBackoffMs - this.lastCompensatedBackoffMs;
    if (backoffDelta > 0) {
      this.extendDeadline(backoffDelta, input.iteration, 'Rate limit backoff time compensation', null);
      this.totalCompensationsMs += backoffDelta;
      this.lastCompensatedBackoffMs = input.rateLimitBackoffMs;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Immediate termination checks (Tier 1)
  // ═══════════════════════════════════════════════════════════════════════════

  private checkImmediateTermination(input: TimeoutGovernorInput): string | null {
    // Circuit breaker open
    if (input.circuitBreakerOpen) {
      return 'Circuit breaker open — multi-agent failure rate exceeded threshold';
    }

    // Stuck ≥5 + near-zero progress + vision exhausted
    if (
      input.consecutiveStuckCount >= 5
      && input.progressScore < 0.1
      && input.visionAttemptedForPage
    ) {
      return `Stuck ${input.consecutiveStuckCount} iterations with <10% progress, vision exhausted`;
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Blocker duration tracking
  // ═══════════════════════════════════════════════════════════════════════════

  private trackBlocker(input: TimeoutGovernorInput): void {
    if (input.currentBlocker) {
      if (this.blockerType !== input.currentBlocker) {
        this.blockerStartIteration = input.iteration;
        this.blockerType = input.currentBlocker;
      }
    } else {
      this.blockerStartIteration = null;
      this.blockerType = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Gate logic (determines when to call Tier 2 AI)
  // ═══════════════════════════════════════════════════════════════════════════

  private checkGates(
    input: TimeoutGovernorInput,
    stallSignals: StallSignals,
    remainingMs: number,
  ): string | null {
    // Gate 1: Plan milestone — step index changed
    // Skip on very first detection to avoid firing before any progress is made
    if (input.planStepChanged && input.planSteps) {
      const currentIndex = input.planSteps.findIndex(s => s.status === 'current' || s.status === 'in_progress');
      if (currentIndex !== -1) {
        if (!this.firstPlanStepSeen) {
          // First time we see a plan step — record it but don't fire
          this.firstPlanStepSeen = true;
          this.lastPlanStepIndex = currentIndex;
        } else if (currentIndex !== this.lastPlanStepIndex) {
          const gateKey = `plan_milestone_${currentIndex}`;
          if (!this.gatesFired.has(gateKey)) {
            this.gatesFired.set(gateKey, 1);
            this.lastPlanStepIndex = currentIndex;
            return 'plan_milestone';
          }
        }
      }
    }

    // Gate 2: Stall detected — progress monitor found pattern (max 2x total)
    if (stallSignals.isStalled) {
      const stallCount = this.gatesFired.get('stall_detected') || 0;
      if (stallCount < 2) {
        this.gatesFired.set('stall_detected', stallCount + 1);
        return 'stall_detected';
      }
    }

    // Gate 3: Blocker decision — known blocker persisting > blockerPersistMs
    if (input.currentBlocker && input.blockerDurationMs > this.config.blockerPersistMs) {
      const blockerKey = `blocker_${input.currentBlocker.replace(/\s+/g, '_').toLowerCase()}`;
      if (!this.gatesFired.has(blockerKey)) {
        this.gatesFired.set(blockerKey, 1);
        return 'blocker_decision';
      }
    }

    // Gate 4: Time pressure — remaining < hurry AND ambiguous progress
    if (
      remainingMs < this.config.hurryThresholdMs
      && remainingMs > this.config.criticalThresholdMs
      && input.progressScore >= 0.2
      && input.progressScore <= 0.8
      && !this.gatesFired.has('time_pressure')
    ) {
      this.gatesFired.set('time_pressure', 1);
      return 'time_pressure';
    }

    // Gate 5: Last chance — remaining < critical
    if (remainingMs <= this.config.criticalThresholdMs && !this.gatesFired.has('last_chance')) {
      this.gatesFired.set('last_chance', 1);
      return 'last_chance';
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Urgency level computation
  // ═══════════════════════════════════════════════════════════════════════════

  private computeUrgency(remainingMs: number): UrgencyLevel {
    if (remainingMs <= this.config.criticalThresholdMs) return 'critical';
    if (remainingMs <= this.config.hurryThresholdMs) return 'hurry';
    return 'normal';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Apply AI decision to deadline
  // ═══════════════════════════════════════════════════════════════════════════

  private applyAIDecision(decision: AITimeoutDecision, iteration: number, gate: string, elapsedMs: number): void {
    switch (decision.decision) {
      case 'extend':
        if (decision.extensionMs > 0) {
          this.extendDeadline(decision.extensionMs, iteration, decision.reason, gate);
        }
        break;

      case 'reduce': {
        // Reduce remaining time by 25% — but never let deadline go below elapsed + critical threshold.
        // currentDeadlineMs is duration-from-start, elapsedMs is current elapsed.
        const remainingMs = this.currentDeadlineMs - elapsedMs;
        const minRemaining = this.config.criticalThresholdMs;
        if (remainingMs > minRemaining) {
          // Cut 25% of remaining, keeping at least criticalThresholdMs remaining
          const reductionMs = Math.floor((remainingMs - minRemaining) * 0.25);
          if (reductionMs > 0) {
            this.currentDeadlineMs -= reductionMs;
            this.extensionLog.push({ iteration, amount: -reductionMs, reason: decision.reason, gate });
          }
        }
        break;
      }

      case 'terminate':
      case 'partial_success':
        // Caller will handle these via the return value
        break;

      case 'continue':
      default:
        // No change
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Deadline extension (with cap)
  // ═══════════════════════════════════════════════════════════════════════════

  private extendDeadline(amountMs: number, iteration: number, reason: string, gate: string | null): void {
    const cap = this.config.maxTimeoutMs - this.currentDeadlineMs;
    const actualExtension = Math.min(amountMs, Math.max(0, cap));

    if (actualExtension > 0) {
      this.currentDeadlineMs += actualExtension;
      this.totalExtensionsMs += actualExtension;
      this.extensionLog.push({ iteration, amount: actualExtension, reason, gate });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: Narrative builder for Tier 2 AI
  // ═══════════════════════════════════════════════════════════════════════════

  private buildNarrative(
    input: TimeoutGovernorInput,
    gate: string,
    stallSignals: StallSignals,
  ): string {
    const elapsedSec = Math.floor(input.elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedSecRem = elapsedSec % 60;
    const remainingMs = this.currentDeadlineMs - input.elapsedMs;
    const remainingSec = Math.floor(Math.max(0, remainingMs) / 1000);
    const remainingMin = Math.floor(remainingSec / 60);
    const remainingSecRem = remainingSec % 60;

    const planSection = input.planSteps
      ? input.planSteps.map(s => {
        const icon = s.status === 'done' || s.status === 'completed' ? '✅'
          : s.status === 'current' || s.status === 'in_progress' ? '⏳'
            : '⬜';
        return `  ${icon} ${s.id}: ${s.goal}`;
      }).join('\n')
      : '  No task plan generated for this test.';

    const accomplishmentsSection = input.accomplishments.length > 0
      ? input.accomplishments.slice(-10).map(a => `  - ${a}`).join('\n')
      : '  None recorded yet.';

    const visitedSection = Object.entries(input.visitedPages)
      .map(([url, info]) => `  ${url} (${info.visitCount}x${info.pageType ? `, type: ${info.pageType}` : ''})`)
      .join('\n') || '  None.';

    const outcomesSection = input.last5Outcomes
      .map(o => `  iter ${o.iteration}: ${o.action} → ${o.outcome} (${o.durationMs}ms)`)
      .join('\n') || '  None.';

    const stallSection = [
      stallSignals.urlRepetition.detected ? `  URL repetition: ${stallSignals.urlRepetition.url} visited ${stallSignals.urlRepetition.count}x in last ${this.config.stallWindowSize} iterations` : null,
      stallSignals.errorRepetition.detected ? `  Error repetition: "${stallSignals.errorRepetition.pattern}" occurred ${stallSignals.errorRepetition.count}x` : null,
      stallSignals.outcomeMonotony.detected ? `  Outcome monotony: ${stallSignals.outcomeMonotony.badCount}/${stallSignals.outcomeMonotony.total} outcomes are failures` : null,
      stallSignals.accomplishmentPlateau.detected ? `  Accomplishment plateau: 0 new accomplishments in ${stallSignals.accomplishmentPlateau.iterationsSinceLast} iterations` : null,
      stallSignals.actionRepetition.detected ? `  Action repetition: ${stallSignals.actionRepetition.action} on ${stallSignals.actionRepetition.ref || 'unknown'} repeated ${stallSignals.actionRepetition.count}x` : null,
    ].filter(Boolean).join('\n') || '  None detected.';

    const networkSection = input.recentNetworkErrors.length > 0
      ? input.recentNetworkErrors.map(e => `  ${e.method} ${e.url.slice(0, 80)} → ${e.status}`).join('\n')
      : '  None.';

    const consoleSection = input.recentConsoleErrors.length > 0
      ? input.recentConsoleErrors.slice(-3).map(e => `  ${e.slice(0, 120)}`).join('\n')
      : '  None.';

    // Gate-specific trigger reason
    let gateReason = '';
    switch (gate) {
      case 'plan_milestone':
        gateReason = 'A plan step was just completed. Assess if remaining time is sufficient for remaining steps.';
        break;
      case 'stall_detected':
        gateReason = 'Progress stall detected. Determine if this is a temporary obstacle or terminal stall.';
        break;
      case 'blocker_decision':
        gateReason = `Known blocker "${input.currentBlocker}" has persisted for >${Math.round(input.blockerDurationMs / 1000)}s. Decide: wait for resolution or terminate.`;
        break;
      case 'time_pressure':
        gateReason = 'Less than 60 seconds remaining with ambiguous progress. Decide: extend time or stop.';
        break;
      case 'last_chance':
        gateReason = 'Less than 30 seconds remaining. Final assessment: partial success or fail.';
        break;
      default:
        gateReason = 'Periodic assessment.';
    }

    return `ROLE: You are the TimeoutGovernor for an autonomous web testing agent.
You must decide how to manage the remaining test time based on FACTUAL evidence below.

DECISION CRITERIA:
- EXTEND: Accomplishments are growing, actions succeed, clear path to goal remains. Worth more time.
- CONTINUE: Progress is steady, no time pressure. No change needed.
- REDUCE: Progress is weak but not hopeless. Tighten the deadline to avoid waste.
- TERMINATE: No path forward — CAPTCHA, login wall without credentials, infinite loop, or 0 progress after many attempts. Stop immediately.
- PARTIAL_SUCCESS: Some goal steps completed (e.g. navigated to page, filled form) but cannot finish remaining steps. Declare what was achieved.

IMPORTANT: Base your decision on the FACTUAL action history and outcomes below, NOT on the heuristic progress estimate.

GOAL: "${input.goal}"

TIME: ${elapsedMin}m ${elapsedSecRem}s elapsed, ${remainingMin}m ${remainingSecRem}s remaining
  Base: ${Math.round(this.config.baseTimeoutMs / 60000)}min, Extensions so far: ${Math.round(this.totalExtensionsMs / 1000)}s, Compensations: ${Math.round(this.totalCompensationsMs / 1000)}s, Max: ${Math.round(this.config.maxTimeoutMs / 60000)}min

TASK PLAN:
${planSection}

COMPLETED ACTIONS (factual):
${accomplishmentsSection}

PAGES VISITED:
${visitedSection}

CURRENT PAGE: ${input.currentUrl} — "${input.pageTitle}"

LAST 5 ACTIONS & OUTCOMES:
${outcomesSection}

STUCK STATUS:
  Stuck: ${input.stuck ? 'yes' : 'no'} (${input.consecutiveStuckCount} consecutive)
  Reason: ${input.stuckReason || 'none'}

STALL SIGNALS (from progress monitor):
${stallSection}

BLOCKERS:
  Supervisor blocker: ${input.currentBlocker || 'none'}
  Last click blocker: ${input.lastBlockerInfo?.description || 'none'}

ERRORS (recent factual):
  Network:
${networkSection}
  Console:
${consoleSection}

AGENT STATUS:
  Vision tried for this page: ${input.visionAttemptedForPage ? 'yes' : 'no'}
  Consecutive no-effect actions: ${input.consecutiveNoEffectCount}

ESTIMATED PROGRESS: ${Math.round(input.progressScore * 100)}%
  ⚠️ Heuristic estimate (keyword matching) — may be inaccurate.
  Use the factual action history above for your own assessment.

GATE TRIGGER: ${gate} — ${gateReason}

Respond in JSON only:
{
  "decision": "extend" | "continue" | "reduce" | "terminate" | "partial_success",
  "extensionMs": <number, only if decision=extend, max ${this.config.extensionMaxPerCallMs}>,
  "reason": "<1-2 sentence explanation>",
  "confidence": <0.0-1.0>
}`;
  }
}
