/**
 * SupervisorAgent — "Are we making progress?" (Manus Tiered Escalation)
 *
 * The "fourth agent" that monitors the cognitive pipeline.
 * Not a coordinator — a cynical watchdog that assumes agents WILL get stuck.
 *
 * Tier 1: Deterministic (<5ms, 0 tokens) — state hash, wrong page, forbidden actions
 * Tier 2: AI diagnosis (gemini-2.5-flash-lite, ~1s) — ONLY when stuck 5+ iterations
 *
 * Produces a Blackboard (shared reactive state) consumed by ALL agents.
 */

import type { MultiAgentInput, SupervisorBlackboard } from './types';
import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';
import { logger } from '@/utils/core/logger';

// Reuse the same dynamic patterns from LiteState for noise filtering
const DYNAMIC_NAME_PATTERNS = [
  /time/i,
  /clock/i,
  /timer/i,
  /countdown/i,
  /\d{1,2}:\d{2}(:\d{2})?/,
  /ad[_-]?banner/i,
  /advertisement/i,
  /sponsored/i,
  /promo/i,
  /spinner/i,
  /loading/i,
  /skeleton/i,
  /placeholder/i,
  /\d+\s*(views?|likes?|shares?)/i,
  /visitor[_-]?count/i,
  /live[_-]?update/i,
  /realtime/i,
  /streaming/i,
];

// Blocker detection patterns (Tier 1 regex)
const BLOCKER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /invalid session|session expired|unauthorized|401/i, label: 'Session expired' },
  { pattern: /captcha|recaptcha|hcaptcha/i, label: 'CAPTCHA blocking' },
  { pattern: /rate.?limit|429|too many/i, label: 'Rate limited' },
  { pattern: /access denied|403|forbidden/i, label: 'Access denied' },
  { pattern: /network error|timeout|ETIMEDOUT|ECONNREFUSED/i, label: 'Network error' },
];

/** Tier 2 AI diagnostic result */
interface Tier2DiagnosticResult {
  blocker: string;
  suggestedRecovery: string;
  severity: 'solvable' | 'needs_navigation' | 'needs_auth' | 'unsolvable';
  /** Mandatory action override — if AI can identify the exact next step */
  mandatoryAction?: { action: string; ref?: string; value?: string; url?: string };
}

export class SupervisorAgent {
  // State tracking
  private stateHashes: string[] = [];
  private interventionCount = 0;
  private wrongPageCount = 0;
  private knownGoodUrls: string[] = [];
  private backtrackFailures = 0;
  private recentActions: Array<{ action: string; ref?: string; url?: string }> = [];
  private recoveryModeActive = false;
  private lastObserverOutputs: string[] = [];
  private lastActions: Array<{ action: string; ref?: string; outcome?: string }> = [];
  // Jaccard similarity tracking
  private previousSignatureSet: Set<string> = new Set();
  private softLoopCount = 0;

  // ═══════════════════════════════════════════════════════════════════════
  // Tier 1: Deterministic Watchdog (<5ms, 0 tokens)
  // ═══════════════════════════════════════════════════════════════════════

  computeBlackboard(input: MultiAgentInput): SupervisorBlackboard {
    const startMs = Date.now();

    // 1. Compute semantic state hash + extract element signatures for Jaccard
    const { hash: stateHash, signatures: currentSignatures } = this.computeStateHashWithSignatures(
      input.url,
      input.snapshotElements,
      input.lastAction,
    );

    // 1b. Jaccard similarity: compare current vs previous element signature sets
    const jaccardSimilarity = this.computeJaccard(this.previousSignatureSet, currentSignatures);
    if (jaccardSimilarity >= 0.85 && this.previousSignatureSet.size > 0) {
      this.softLoopCount++;
    } else {
      this.softLoopCount = 0;
    }
    const softLoopTriggered = this.softLoopCount >= 2;
    // Store for next iteration
    this.previousSignatureSet = currentSignatures;

    // 2. Check hash repeats
    this.stateHashes.push(stateHash);
    const threshold = LITE_ENGINE_FLAGS.supervisorStateHashRepeatThreshold;
    let stateHashRepeatCount = 0;
    if (this.stateHashes.length >= threshold) {
      const recent = this.stateHashes.slice(-threshold);
      if (recent.every(h => h === recent[0])) {
        stateHashRepeatCount = threshold;
      } else {
        // Count consecutive repeats from end
        for (let i = this.stateHashes.length - 2; i >= 0; i--) {
          if (this.stateHashes[i] === stateHash) {
            stateHashRepeatCount++;
          } else {
            break;
          }
        }
        stateHashRepeatCount++; // Include current
      }
    }
    const hashTriggered = stateHashRepeatCount >= threshold;

    // 3. Wrong page detection
    const wrongPage = this.detectWrongPage(input.url, input.goalUrl);
    if (wrongPage) {
      this.wrongPageCount++;
    } else {
      this.wrongPageCount = 0;
    }
    const hardBacktrack = this.wrongPageCount >= LITE_ENGINE_FLAGS.supervisorWrongPageThreshold
      && this.knownGoodUrls.length > 0;

    // 4. Recovery mode = any trigger
    const decliningConfidence = input.auditedDrift?.confidence?.score !== undefined
      && input.auditedDrift.confidence.score < 0.3;
    const recoveryMode = hashTriggered
      || softLoopTriggered
      || input.isStuck
      || (input.loopDetected ?? false)
      || hardBacktrack
      || decliningConfidence;

    if (recoveryMode && !this.recoveryModeActive) {
      this.interventionCount = 1;
      this.recoveryModeActive = true;
    } else if (recoveryMode) {
      this.interventionCount++;
    } else {
      // Not in recovery — don't reset counters here, resetOnProgress() handles that
    }

    // 5. Forbidden actions (only during recovery)
    const forbiddenActions = recoveryMode
      ? [...this.recentActions]
      : [];

    // 6. Blocker detection
    const currentBlocker = this.detectCurrentBlocker(input);

    // 7. Known good URL — update only on progress
    if (!recoveryMode && !wrongPage && input.progressScore > 0.1) {
      this.pushKnownGoodUrl(input.url);
    }

    // Handle backtrack failures: if hard backtrack was triggered before and we're still on wrong page
    if (hardBacktrack && this.backtrackFailures >= 2 && this.knownGoodUrls.length > 1) {
      this.knownGoodUrls.shift();
      this.backtrackFailures = 0;
      logger.warn('[SUPERVISOR] Popped failed knownGoodUrl, trying next in stack', {
        remainingUrls: this.knownGoodUrls.length,
      });
    }

    const blackboard: SupervisorBlackboard = {
      recoveryMode,
      recoveryTier: recoveryMode ? 1 : 0,
      currentBlocker,
      forbiddenActions,
      knownGoodUrls: [...this.knownGoodUrls],
      backtrackFailures: this.backtrackFailures,
      interventionCount: this.interventionCount,
      stateHash,
      stateHashRepeatCount,
      hardBacktrack,
      wrongPageCount: this.wrongPageCount,
      jaccardSimilarity,
      softLoopCount: this.softLoopCount,
    };

    const elapsedMs = Date.now() - startMs;
    if (recoveryMode) {
      logger.info('[SUPERVISOR] Tier 1 blackboard computed', {
        recoveryMode,
        stateHashRepeatCount,
        jaccardSimilarity: jaccardSimilarity.toFixed(3),
        softLoopCount: this.softLoopCount,
        wrongPageCount: this.wrongPageCount,
        hardBacktrack,
        interventionCount: this.interventionCount,
        forbiddenCount: forbiddenActions.length,
        currentBlocker,
        knownGoodUrlCount: this.knownGoodUrls.length,
        elapsedMs,
      });
    }

    return blackboard;
  }

  /**
   * Semantic state hash + signature set — only interactive elements, filter noise.
   * Returns both djb2 hash (for exact match) and signature Set (for Jaccard similarity).
   */
  private computeStateHashWithSignatures(
    url: string,
    snapshotElements: string,
    lastAction?: string,
  ): { hash: string; signatures: Set<string> } {
    // Parse element signatures from formatted snapshot
    // Format: "e0: \"Submit\" type=submit" or "[ref] \"name\" role tag"
    const signatures: string[] = [];
    const lines = snapshotElements.split('\n');
    const maxElements = LITE_ENGINE_FLAGS.supervisorStateHashElementCount;

    for (const line of lines) {
      if (signatures.length >= maxElements) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('─')) continue;

      // Extract ref pattern: e0: "name" or s0: "name"
      const match = trimmed.match(/^([es]\d+):\s*"([^"]*)"(.*)$/);
      if (!match) continue;

      const name = match[2] || '';

      // Filter out dynamic/noisy names
      if (name && DYNAMIC_NAME_PATTERNS.some(p => p.test(name))) continue;

      // Use the full line as signature (includes tag, role, type info)
      // This is stable across renders because it's based on semantic content
      signatures.push(trimmed.slice(0, 80)); // Cap individual signature length
    }

    // Signature set for Jaccard (without URL/lastAction — pure element comparison)
    const signatureSet = new Set(signatures);

    // Build hash input: URL + sorted signatures + lastAction
    const hashInput = url + '|' + signatures.sort().join(',') + '|' + (lastAction || '');

    // djb2 hash (unsigned to avoid negative hex strings)
    let hash = 5381;
    for (let i = 0; i < hashInput.length; i++) {
      hash = (hash * 33) ^ hashInput.charCodeAt(i);
    }
    return { hash: (hash >>> 0).toString(16), signatures: signatureSet };
  }

  /**
   * Jaccard similarity: |A ∩ B| / |A ∪ B|
   * Returns 0 if both sets are empty, 1 if identical.
   */
  private computeJaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Wrong page detection — pathname comparison.
   */
  private detectWrongPage(currentUrl: string, goalUrl?: string): boolean {
    if (!goalUrl) return false;
    try {
      const current = new URL(currentUrl);
      const goal = new URL(goalUrl);
      return current.pathname !== goal.pathname;
    } catch {
      return false;
    }
  }

  /**
   * Blocker detection — checks real network status codes, console errors, and text patterns.
   * Priority: direct status codes > console errors > regex on text.
   */
  private detectCurrentBlocker(input: MultiAgentInput): string | undefined {
    // 1. Direct network status code checks (most reliable)
    if (input.recentNetworkErrors?.length) {
      for (const err of input.recentNetworkErrors) {
        if (err.status === 429) return `Rate limited (HTTP 429)`;
        if (err.status === 401) return `Unauthorized (HTTP 401)`;
        if (err.status === 403) return `Access denied (HTTP 403)`;
        if (err.status === 503) return `Service unavailable (HTTP 503)`;
      }
    }

    // 2. Validation errors with rich context (auth hints, rate limits)
    if (input.recentValidationErrors?.length) {
      for (const ve of input.recentValidationErrors) {
        if (ve.rateLimitInfo?.retryAfter) {
          return `Rate limited — retry after ${ve.rateLimitInfo.retryAfter}s`;
        }
        if (ve.authErrorHint) {
          return `Auth error: ${ve.authErrorHint}`;
        }
        if (ve.status === 429) return `Rate limited (HTTP 429)`;
        if (ve.status === 401) return `Unauthorized (HTTP 401)`;
        if (ve.status === 403) return `Access denied (HTTP 403)`;
      }
    }

    // 3. Console errors (CORS, JS errors)
    if (input.recentConsoleErrors?.length) {
      for (const err of input.recentConsoleErrors) {
        if (/CORS|cross-origin|blocked by CORS/i.test(err)) return `CORS error blocking requests`;
        if (/ERR_CONNECTION_REFUSED|ERR_NETWORK/i.test(err)) return `Network connection error`;
      }
    }

    // 4. Regex on lastOutcome / stateDrift (fallback)
    const textToCheck = [
      input.lastOutcome || '',
      input.stateDrift || '',
    ].join(' ');

    for (const { pattern, label } of BLOCKER_PATTERNS) {
      if (pattern.test(textToCheck)) return label;
    }

    // 5. Transient loading state
    if (input.transientState?.isTransient) {
      return `Page loading (${input.transientState.type || 'unknown'})`;
    }

    return undefined;
  }

  /**
   * Push a URL onto the known-good stack (max 3, deduped).
   */
  private pushKnownGoodUrl(url: string): void {
    try {
      const normalized = new URL(url).origin + new URL(url).pathname;
      // Remove if already in stack (will re-add at front)
      this.knownGoodUrls = this.knownGoodUrls.filter(u => u !== normalized);
      // Push to front
      this.knownGoodUrls.unshift(normalized);
      // Keep max 3
      if (this.knownGoodUrls.length > 3) {
        this.knownGoodUrls.pop();
      }
    } catch {
      // Invalid URL, skip
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tier 2: Nuclear AI Diagnosis (gemini-2.5-flash-lite, only when stuck 5+)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * AI diagnosis — called ONLY when Tier 1 is exhausted (5+ interventions).
   * Uses gpt-5.4-mini for a diagnostic call.
   * Returns actionable hint + optional mandatory action override.
   */
  async diagnoseBlocker(
    input: MultiAgentInput,
    blackboard: SupervisorBlackboard,
  ): Promise<Tier2DiagnosticResult | undefined> {
    try {
      const observerContext = this.lastObserverOutputs.slice(-3).join('\n---\n');
      const actionContext = this.lastActions.slice(-3)
        .map(a => `${a.action}${a.ref ? `(${a.ref})` : ''} → ${a.outcome || 'unknown'}`)
        .join('\n');

      // Extract top interactive elements for ref resolution
      const elementLines = input.snapshotElements.split('\n')
        .filter(l => l.trim() && !l.trim().startsWith('[') && !l.trim().startsWith('─'))
        .slice(0, 15)
        .join('\n');

      const prompt = `You are a diagnostic agent. The AI test agent is stuck for ${blackboard.interventionCount}+ iterations.
Analyze the context and identify the SEMANTIC BLOCKER — why can't the agent proceed?

Goal: ${input.goal}
Current URL: ${input.url}
Last 3 Observer outputs:
${observerContext || '(none)'}

Last 3 actions + outcomes:
${actionContext || '(none)'}

Error/state info: ${input.lastOutcome || '(none)'}
${blackboard.currentBlocker ? `Known blocker: ${blackboard.currentBlocker}` : ''}

Available interactive elements:
${elementLines || '(none)'}

CRITICAL: Your suggestedRecovery MUST be an ACTIONABLE HINT with specific element refs from the list above.
BAD: "There is an overlay blocking the button"
GOOD: "Click the 'Close' button (e12) on the cookie banner to dismiss it, then click Submit (e5)"

If you can identify the EXACT next action to unblock the agent, include mandatoryAction.
This will OVERRIDE the Strategist — the agent will execute this action directly.

Respond with JSON ONLY:
{
  "blocker": "description of what is blocking progress, reference specific elements",
  "suggestedRecovery": "specific actionable step with element refs (e.g. click e12, then fill e5)",
  "severity": "solvable | needs_navigation | needs_auth | unsolvable",
  "mandatoryAction": { "action": "click", "ref": "e12" }
}
mandatoryAction is OPTIONAL. Only include it when you are confident about the exact action+ref.
Valid actions: click, fill, select, press, goto, scroll, hover, wait.`;

      logger.info('[SUPERVISOR] Tier 2: Invoking AI diagnosis', {
        interventionCount: blackboard.interventionCount,
        promptLength: prompt.length,
      });

      const result = await LitePromptBuilder.askJson<Tier2DiagnosticResult>(prompt, {
        model: AI_TASK_MODELS.goalAuditor,
        temperature: 0.0,
        maxTokens: 300,
        timeoutMs: LITE_ENGINE_FLAGS.supervisorTier2TimeoutMs,
      });

      if (result?.suggestedRecovery) {
        logger.info('[SUPERVISOR] Tier 2: AI diagnosis complete', {
          blocker: result.blocker,
          severity: result.severity,
          recovery: result.suggestedRecovery,
          hasMandatoryAction: !!result.mandatoryAction,
        });
        return result;
      }

      return undefined;
    } catch (error) {
      logger.error('[SUPERVISOR] Tier 2: AI diagnosis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // State Management
  // ═══════════════════════════════════════════════════════════════════════

  /** Record an action for forbidden action tracking (ring buffer) */
  recordAction(command: { action: string; ref?: string; url?: string; value?: string }): void {
    let normalizedUrl: string | undefined;
    if (command.action === 'goto' && command.url) {
      try {
        const parsed = new URL(command.url);
        normalizedUrl = parsed.origin + parsed.pathname;
      } catch {
        normalizedUrl = command.url;
      }
    }
    this.recentActions.push({
      action: command.action,
      ref: command.ref,
      url: normalizedUrl,
    });
    // Keep bounded by forbidden action window
    const maxWindow = LITE_ENGINE_FLAGS.supervisorForbiddenActionWindow;
    if (this.recentActions.length > maxWindow) {
      this.recentActions = this.recentActions.slice(-maxWindow);
    }

    // Also record for Tier 2 context
    this.lastActions.push({
      action: command.action,
      ref: command.ref,
    });
    if (this.lastActions.length > 5) {
      this.lastActions = this.lastActions.slice(-5);
    }
  }

  /** Record action outcome (updates last action entry) */
  recordActionOutcome(outcome: string): void {
    if (this.lastActions.length > 0) {
      this.lastActions[this.lastActions.length - 1].outcome = outcome;
    }
  }

  /** Record observer output for Tier 2 context (ring buffer, last 3) */
  recordObserverOutput(observation: string): void {
    this.lastObserverOutputs.push(observation);
    if (this.lastObserverOutputs.length > 3) {
      this.lastObserverOutputs = this.lastObserverOutputs.slice(-3);
    }
  }

  /** Reset counters on meaningful progress.
   *  @param progressScore — when > 0.5 (strong progress), also clears forbidden actions
   *  to prevent stale constraints from blocking legitimate re-attempts. */
  resetOnProgress(progressScore?: number): void {
    this.interventionCount = 0;
    this.wrongPageCount = 0;
    this.backtrackFailures = 0;
    this.recoveryModeActive = false;
    this.softLoopCount = 0;
    // Clear forbidden actions on strong progress — stale constraints would block legitimate actions
    if (progressScore !== undefined && progressScore > 0.5) {
      this.recentActions = [];
    }
    // Don't clear stateHashes — they naturally cycle
    // Don't clear previousSignatureSet — needed for next Jaccard comparison
  }

  /** Record a backtrack failure (knownGoodUrl didn't work) */
  recordBacktrackFailure(): void {
    this.backtrackFailures++;
    logger.warn('[SUPERVISOR] Backtrack failure recorded', {
      failures: this.backtrackFailures,
      knownGoodUrlCount: this.knownGoodUrls.length,
    });
  }

  /** Get current intervention count (for external checks) */
  getInterventionCount(): number {
    return this.interventionCount;
  }
}
