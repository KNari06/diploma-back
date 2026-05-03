/**
 * Critic Agent — "Should we really do this?" (Manus-style)
 * Independent auditor that validates Actor's decision BEFORE execution.
 * Temperature: 0.0 (fully deterministic judgment)
 * ~3k input tokens, ~200 output tokens
 *
 * Manus principles:
 * A) Double-Blind: Critic does NOT see Strategist's reasoning — independently assesses
 * B) Red Teaming: "Find at least one reason this action could fail"
 * В) Security & Policy Enforcement: Deterministic checks (no AI cost)
 * Г) Reasoning Consistency: Catches contradictions across iteration history
 * D) Hallucination Check: Verifies chosen ref exists in real elements
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';
import type {
  CriticInput,
  CriticVerdict,
  PolicyViolation,
  ReasoningInconsistency,
} from './types';

/** AI-returned portion of critic verdict (before we merge deterministic checks) */
interface AICriticResponse {
  verdict: 'approve' | 'reject' | 'override';
  riskAssessment: string;
  failureRisk: string;
  suggestedAction?: string;
  /** Cognitive: Structured override command — actionable, not just advisory */
  structuredOverride?: { action: string; ref?: string; value?: string };
  confidence: number;
}

export class CriticAgent {
  /**
   * Validate Actor's proposed action before execution.
   * Combines:
   * 1. Deterministic checks (hallucination, security, consistency) — <1ms, free
   * 2. AI Red Teaming (double-blind) — ~2s, 1 API call
   *
   * Returns null on failure (caller should proceed without critic).
   */
  static async critique(input: CriticInput): Promise<CriticVerdict | null> {
    const start = Date.now();

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 1: Deterministic checks (free, <1ms)
    // ═══════════════════════════════════════════════════════════════════════

    // 1a. Hallucination check — does the ref actually exist?
    const refExists = CriticAgent.checkRefExists(input);

    // 1b. Security & Policy enforcement
    const policyViolations = CriticAgent.checkSecurityPolicies(input);

    // 1c. Reasoning consistency across iterations
    const reasoningInconsistencies = CriticAgent.checkReasoningConsistency(input);

    // 1d. Visual conflict check (covered/hidden/disabled elements from VisionHints)
    if (LITE_ENGINE_FLAGS.enableCriticVisualCheck) {
      const visualConflictViolations = CriticAgent.checkVisualConflicts(input);
      policyViolations.push(...visualConflictViolations);
    }

    // 1e. Supervisor forbidden action check (recovery mode only)
    if (LITE_ENGINE_FLAGS.enableSupervisorLayer) {
      policyViolations.push(...CriticAgent.checkForbiddenActions(input));
    }

    // If critical policy violation found, reject immediately (no AI call needed)
    const blockingViolations = policyViolations.filter(v => v.severity === 'block');
    if (blockingViolations.length > 0) {
      logger.warn('[CRITIC] Blocking policy violation detected', {
        violations: blockingViolations.map(v => v.type),
      });
      return {
        verdict: 'reject',
        riskAssessment: `BLOCKED: ${blockingViolations.map(v => v.description).join('; ')}`,
        failureRisk: blockingViolations[0].description,
        confidence: 1.0,
        refExists,
        policyViolations,
        reasoningInconsistencies,
      };
    }

    // If ref doesn't exist, reject immediately (hallucination)
    if (!refExists && input.proposedCommand.ref) {
      logger.warn('[CRITIC] Hallucinated ref detected', {
        ref: input.proposedCommand.ref,
      });
      return {
        verdict: 'reject',
        riskAssessment: `Element ref "${input.proposedCommand.ref}" does not exist in page`,
        failureRisk: 'Actor hallucinated a non-existent element reference',
        confidence: 1.0,
        refExists: false,
        policyViolations,
        reasoningInconsistencies,
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2: AI Red Teaming (Double-Blind)
    // Critic sees page state + goal but NOT Strategist's reasoning
    // ═══════════════════════════════════════════════════════════════════════
    const prompt = CriticAgent.buildRedTeamPrompt(input);

    const aiResult = await LitePromptBuilder.askJson<AICriticResponse>(prompt, {
      model: LITE_ENGINE_FLAGS.coreBrainModel as string,
      temperature: 0.0,
      maxTokens: LITE_ENGINE_FLAGS.criticMaxTokens,
      timeoutMs: LITE_ENGINE_FLAGS.multiAgentCriticTimeoutMs,
    });

    const elapsed = Date.now() - start;

    if (!aiResult || !aiResult.verdict) {
      logger.warn('[CRITIC] AI failed, proceeding without critic', { elapsed });
      return null;
    }

    // Merge deterministic checks with AI verdict
    const verdict: CriticVerdict = {
      verdict: aiResult.verdict,
      riskAssessment: aiResult.riskAssessment,
      failureRisk: aiResult.failureRisk,
      suggestedAction: aiResult.suggestedAction,
      structuredOverride: aiResult.structuredOverride,
      confidence: aiResult.confidence,
      refExists,
      policyViolations,
      reasoningInconsistencies,
    };

    // If AI approved but we have warnings or inconsistencies, downgrade confidence
    if (verdict.verdict === 'approve') {
      const warningCount = policyViolations.filter(v => v.severity === 'warn').length;
      if (warningCount > 0 || reasoningInconsistencies.length > 0) {
        const warnPenalty = LITE_ENGINE_FLAGS.criticWarningPenalty;
        const inconsistencyPenalty = LITE_ENGINE_FLAGS.criticInconsistencyPenalty;
        const minConfidence = LITE_ENGINE_FLAGS.criticMinConfidence;
        verdict.confidence = Math.max(minConfidence, verdict.confidence - warnPenalty * warningCount - inconsistencyPenalty * reasoningInconsistencies.length);
        verdict.riskAssessment += ` (${warningCount} warnings, ${reasoningInconsistencies.length} inconsistencies)`;
      }
    }

    logger.debug('[CRITIC] Verdict complete', {
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      refExists,
      policyViolations: policyViolations.length,
      inconsistencies: reasoningInconsistencies.length,
      elapsed,
    });

    return verdict;
  }

  /**
   * Quick safety check (deterministic only, no AI call, <1ms).
   * Used when validating fallback actions after Critic rejected primary.
   * Returns true if action passes all deterministic safety checks.
   */
  static quickSafetyCheck(input: CriticInput): boolean {
    // Check ref exists
    if (!CriticAgent.checkRefExists(input) && input.proposedCommand.ref) {
      return false;
    }
    // Check security policies
    const violations = CriticAgent.checkSecurityPolicies(input);
    if (violations.some(v => v.severity === 'block')) return false;
    // Check visual conflicts
    if (LITE_ENGINE_FLAGS.enableCriticVisualCheck) {
      const visualViolations = CriticAgent.checkVisualConflicts(input);
      if (visualViolations.some(v => v.severity === 'block')) return false;
    }
    // Supervisor forbidden action check
    if (LITE_ENGINE_FLAGS.enableSupervisorLayer) {
      if (CriticAgent.checkForbiddenActions(input).some(v => v.severity === 'block')) return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Supervisor: Forbidden Action Enforcement
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Check if proposed action is forbidden by Supervisor during recovery mode.
   * Returns blocking violations for actions that were tried in recent iterations.
   * Zero AI cost, <1ms.
   */
  static checkForbiddenActions(input: CriticInput): PolicyViolation[] {
    if (!input.blackboard?.recoveryMode || !input.blackboard.forbiddenActions.length) return [];
    const violations: PolicyViolation[] = [];
    const proposed = input.proposedCommand;

    for (const forbidden of input.blackboard.forbiddenActions) {
      // Exact match: same action + same ref
      if (forbidden.action === proposed.action && forbidden.ref && forbidden.ref === proposed.ref) {
        violations.push({
          type: 'unsafe_action',
          description: `SUPERVISOR: ${proposed.action}(${proposed.ref}) forbidden — attempted in recent iterations`,
          severity: 'block',
        });
        break;
      }
      // Goto URL match (normalize proposed URL to match supervisor's normalization)
      if (forbidden.action === 'goto' && proposed.action === 'goto' &&
          forbidden.url && proposed.url) {
        let normalizedProposed = proposed.url;
        try { const u = new URL(proposed.url); normalizedProposed = u.origin + u.pathname; } catch { /* keep raw */ }
        if (forbidden.url === normalizedProposed) {
          violations.push({
            type: 'unsafe_action',
            description: `SUPERVISOR: goto("${proposed.url}") forbidden — already attempted`,
            severity: 'block',
          });
          break;
        }
      }
    }
    return violations;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Deterministic checks (no AI, <1ms each)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Hallucination check: Does the ref exist in available elements?
   *
   * Fast path: O(1) Set lookup via parsedSnapshot when available.
   * Fallback: word-boundary regex over the formatted snapshot string.
   * Both paths are equivalent for ref existence — see parsed-snapshot.ts
   * for the rules on which refs the Set contains.
   */
  private static checkRefExists(input: CriticInput): boolean {
    const ref = input.proposedCommand.ref;
    if (!ref) return true; // Actions without ref (wait, press) are fine

    // Fast path
    if (input.parsedSnapshot) {
      return input.parsedSnapshot.hasRef(ref);
    }

    // Fallback: regex on formatted string (legacy, equivalent semantics)
    const refPattern = new RegExp(`\\b${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return refPattern.test(input.availableElements);
  }

  /**
   * Security & Policy enforcement
   * All checks are deterministic — zero AI cost
   */
  private static checkSecurityPolicies(input: CriticInput): PolicyViolation[] {
    const violations: PolicyViolation[] = [];

    // Policy 1: Password in non-password field (type="text" instead of type="password")
    if (input.proposedCommand.action === 'fill' && input.proposedCommand.isSensitive && input.formAnalysis) {
      const targetField = input.formAnalysis.fields.find(f => f.ref === input.proposedCommand.ref);
      if (targetField && targetField.type === 'text') {
        // Many modern forms use type="text" with JS visibility toggles ("show/hide password")
        // Check label, name, placeholder, and nearby context for password-related hints
        const fieldContext = `${targetField.label} ${(targetField as any).name || ''} ${(targetField as any).placeholder || ''}`.toLowerCase();
        const isLikelyPasswordField = /password|passwd|secret|пароль|парол|құпия/i.test(fieldContext);
        if (!isLikelyPasswordField) {
          violations.push({
            type: 'password_exposure',
            description: `Filling sensitive data into type="text" field "${targetField.label}" (ref: ${targetField.ref}). Expected type="password"`,
            severity: 'warn',
          });
        }
      }
    }

    // Policy 2: Navigating to external domain
    if (input.proposedCommand.action === 'goto' && input.proposedCommand.url) {
      try {
        const currentDomain = new URL(input.currentUrl).hostname;
        const targetDomain = new URL(input.proposedCommand.url).hostname;
        if (currentDomain !== targetDomain) {
          violations.push({
            type: 'external_navigation',
            description: `goto navigates to external domain "${targetDomain}" (current: "${currentDomain}")`,
            severity: 'warn',
          });
        }
      } catch {
        // Invalid URL — warn
        violations.push({
          type: 'unsafe_action',
          description: `goto has invalid URL: "${input.proposedCommand.url}"`,
          severity: 'warn',
        });
      }
    }

    // Policy 3: Filling credentials when URL doesn't match expected login domain
    if (input.proposedCommand.action === 'fill' && input.proposedCommand.isSensitive && input.hasCredentials) {
      try {
        const url = new URL(input.currentUrl);
        // Warn if filling credentials on HTTP (not HTTPS)
        if (url.protocol === 'http:') {
          violations.push({
            type: 'password_exposure',
            description: `Filling credentials on insecure HTTP connection (${input.currentUrl})`,
            severity: 'warn',
          });
        }
      } catch {
        // Can't parse URL — skip
      }
    }

    // Policy 4: Filling value that looks like PII into an unexpected field
    if (input.proposedCommand.action === 'fill' && input.proposedCommand.value && !input.proposedCommand.isSensitive) {
      const value = input.proposedCommand.value;
      // Check if value looks like a real email/SSN/credit card
      const looksLikePII = /^\d{3}-\d{2}-\d{4}$/.test(value) || // SSN
                           /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/.test(value); // Credit card
      if (looksLikePII) {
        violations.push({
          type: 'pii_leak',
          description: 'Value looks like PII (SSN/credit card) but field not marked sensitive',
          severity: 'block',
        });
      }
    }

    // Policy 5: Clicking "Forgot Password" / "Reset Password" when credentials are provided
    // Warn only — not block. Agent may need forgot password for legitimate test scenarios
    // (e.g., testing password reset flow, credentials failed, etc.)
    if (input.hasCredentials && input.proposedCommand.action === 'click' && input.proposedCommand.ref) {
      const refEscaped = input.proposedCommand.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const refPattern = new RegExp(`\\b${refEscaped}\\b[^\\n]*`, 'i');
      const elementLine = input.availableElements.match(refPattern)?.[0] || '';
      const isForgotPassword = /forgot|reset|recover|құпия сөзді ұмыт|парольді қалпына|восстанов|сбросить/i.test(elementLine);
      if (isForgotPassword) {
        violations.push({
          type: 'unsafe_action',
          description: 'Clicking password reset/forgot link when credentials are provided. Consider filling login form first.',
          severity: 'warn',
        });
      }
    }

    // Policy 6: Clicking during loading state
    if (input.isPageLoading && input.proposedCommand.action === 'click') {
      violations.push({
        type: 'unsafe_action',
        description: 'Clicking while page is loading (skeleton/spinner). Wait for load to complete.',
        severity: 'warn',
      });
    }

    // Policy 7: Clicking covered element
    if (input.proposedCommand.ref && input.coveredElements?.includes(input.proposedCommand.ref)) {
      violations.push({
        type: 'unsafe_action',
        description: `Element ${input.proposedCommand.ref} is covered by overlay. Dismiss overlay first.`,
        severity: 'block',
      });
    }

    // Policy 8: Blocker-aware action blocking (Layer 3 feedback)
    // If previous iteration's click was blocked and recovery failed,
    // warn (not block) if the same element is being retried without addressing the blocker.
    if (input.lastBlockerInfo && input.proposedCommand.ref === input.lastBlockerInfo.targetRef) {
      const blocker = input.lastBlockerInfo;
      const recoveryHints: Record<string, string> = {
        modal: 'Dismiss the modal first (Escape or close button)',
        drawer: 'Close the drawer first (Escape or close button)',
        cookie_consent: 'Accept or dismiss the cookie banner first',
        chat_widget: 'Close the chat widget first',
        toast: 'Wait for the notification to disappear',
        sticky_header: 'Scroll element to center of viewport to avoid sticky header',
        sticky_footer: 'Scroll element to center of viewport to avoid sticky footer',
        loading_overlay: 'Wait for loading to complete',
        dropdown: 'Click away to close the open dropdown first',
        tooltip: 'Move away to dismiss the tooltip first',
        onboarding: 'Dismiss the onboarding tour overlay first',
        paywall: 'Navigate away — element is behind a paywall/login wall',
        unknown: 'Dismiss the overlapping element first (try Escape)',
      };
      const hint = recoveryHints[blocker.hintType || 'unknown'] || 'Dismiss the blocking element first';
      violations.push({
        type: 'unsafe_action',
        description: `Element ${blocker.targetRef} was blocked by ${blocker.hintType || 'unknown'} (${blocker.blockerTag}.${blocker.blockerClass.slice(0, 40)} "${blocker.blockerText.slice(0, 40)}"). ${hint}.`,
        severity: 'warn',
      });
    }

    return violations;
  }

  /**
   * Reasoning consistency: Check for contradictions in strategy history
   */
  private static checkReasoningConsistency(input: CriticInput): ReasoningInconsistency[] {
    const inconsistencies: ReasoningInconsistency[] = [];

    if (!input.reasoningHistory || input.reasoningHistory.length < 2) {
      return inconsistencies;
    }

    const currentThought = input.strategistThought.toLowerCase();

    // Pattern detection: claiming something was found then later saying still searching
    // Note: "see" excluded — too common and causes false positives
    const foundPatterns = [
      /(?:found|located|identified|spotted)\s+(?:the\s+)?(\w+(?:\s+\w+)?)/,
      /(?:successfully|already)\s+(?:completed|done|finished|found)/,
    ];
    const searchingPatterns = [
      /(?:looking for|searching|trying to find|need to find|still searching|cannot find)\s+(?:the\s+)?(\w+(?:\s+\w+)?)/,
      /(?:not found|missing|absent|can't locate)/,
    ];

    for (let i = 0; i < input.reasoningHistory.length; i++) {
      const historical = input.reasoningHistory[i].toLowerCase();

      // Check: historical claims "found X" but current says "searching for X"
      for (const foundPattern of foundPatterns) {
        const foundMatch = historical.match(foundPattern);
        if (foundMatch) {
          for (const searchPattern of searchingPatterns) {
            if (searchPattern.test(currentThought)) {
              inconsistencies.push({
                previousClaim: input.reasoningHistory[i].slice(0, 60),
                currentClaim: input.strategistThought.slice(0, 60),
                iterations: [i + 1, input.iteration],
                description: `Earlier claimed "${foundMatch[0]}" but now searching again`,
              });
            }
          }
        }
      }

      // Check: historical claims "done/completed" but current takes new actions
      // Tight pattern: only match explicit goal-level completion claims, not "done filling" etc.
      if (/(?:goal\s+(?:is\s+)?achieved|task\s+(?:is\s+)?complete(?:d)?|(?:all|everything)\s+(?:is\s+)?done|test\s+(?:is\s+)?finished)/i.test(historical)) {
        if (input.proposedCommand.action !== 'wait') {
          inconsistencies.push({
            previousClaim: input.reasoningHistory[i].slice(0, 60),
            currentClaim: input.strategistThought.slice(0, 60),
            iterations: [i + 1, input.iteration],
            description: 'Earlier claimed goal was achieved but now taking new actions',
          });
        }
      }
    }

    // Cap at 3 inconsistencies
    return inconsistencies.slice(0, 3);
  }

  /**
   * Visual conflict check: Does the target ref have a known vision conflict?
   * Zero AI cost, <1ms — purely deterministic lookup against VisionHints.conflicts.
   *
   * Severity rules:
   * - 'covered' or 'hidden' → block (element not interactable)
   * - 'disabled' → warn (element exists but may not respond)
   * - 'not_found' → skip (already caught by checkRefExists)
   */
  private static checkVisualConflicts(input: CriticInput): PolicyViolation[] {
    const violations: PolicyViolation[] = [];

    if (!input.visionConflicts || input.visionConflicts.length === 0) {
      return violations;
    }

    const targetRef = input.proposedCommand.ref;
    if (!targetRef) return violations;

    for (const conflict of input.visionConflicts) {
      if (conflict.domRef !== targetRef) continue;

      // Skip 'not_found' — already handled by checkRefExists
      if (conflict.issue === 'not_found') continue;

      if (conflict.issue === 'covered' || conflict.issue === 'hidden') {
        violations.push({
          type: 'unsafe_action',
          description: `Target element ${targetRef} ("${conflict.domName || conflict.visionText}") is ${conflict.issue} by another element.${conflict.note ? ' ' + conflict.note : ''}`,
          severity: 'block',
        });
      } else if (conflict.issue === 'disabled') {
        violations.push({
          type: 'unsafe_action',
          description: `Target element ${targetRef} ("${conflict.domName || conflict.visionText}") is disabled.${conflict.note ? ' ' + conflict.note : ''}`,
          severity: 'warn',
        });
      }
    }

    return violations;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AI Red Teaming prompt (Double-Blind)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build Red Team prompt.
   * Key Manus principle: Critic does NOT see Strategist's reasoning.
   * It sees: goal + page state + proposed action. That's it.
   * Its job is to DISPROVE the action, not confirm it.
   */
  private static buildRedTeamPrompt(input: CriticInput): string {
    // Build concise page context from Observer (NOT from Strategist)
    const obstacles = input.observation.obstacles.length > 0
      ? `Obstacles: ${input.observation.obstacles.join(', ')}`
      : '';

    const formInfo = input.observation.formAnalysis
      ? `Form: ${input.observation.formAnalysis.fields.length} fields (${input.observation.formAnalysis.fields.map(f => `${f.label}:${f.type}${f.hasValue ? '[filled]' : '[empty]'}${f.required ? '*' : ''}`).join(', ')})`
      : '';

    const errorInfo = input.observation.errorState
      ? `⚠️ Errors: ${input.observation.errorState}`
      : '';

    // Compact element list for override accuracy — Critic needs real refs to suggest alternatives
    const maxLines = LITE_ENGINE_FLAGS.criticElementListMaxLines;
    const allElementLines = input.availableElements ? input.availableElements.split('\n').filter(l => l.trim()) : [];
    const elementLines = allElementLines.slice(0, maxLines);
    const elementsSection = elementLines.length > 0
      ? `\n═══ PAGE ELEMENTS (real refs — use ONLY these for override) ═══\n${elementLines.join('\n')}${allElementLines.length > maxLines ? '\n... (truncated)' : ''}\n`
      : '';

    return `You are a RED TEAM Critic. Your job is to DISPROVE the proposed action.
Find at least ONE reason it could FAIL or be WRONG.

═══ CONTEXT (what you know) ═══
GOAL: ${input.goal}
PAGE: ${input.observation.pageType}
Available actions: ${input.observation.availableActions.join(', ') || 'none'}
${obstacles}
${formInfo}
${errorInfo}
${elementsSection}
═══ PROPOSED ACTION (challenge this) ═══
Action: ${input.proposedCommand.action}${input.proposedCommand.ref ? `(${input.proposedCommand.ref})` : ''}${input.proposedCommand.value ? ` value="${input.proposedCommand.value}"` : ''}${input.proposedCommand.key ? ` key="${input.proposedCommand.key}"` : ''}${input.proposedCommand.url ? ` url="${input.proposedCommand.url}"` : ''}
Actor reasoning: "${input.actorReasoning}"

═══ YOUR TASK ═══
1. Does this action move toward the GOAL? (Goal alignment)
2. Is the target element the RIGHT one? (Could it be a different element?)
3. What could go WRONG? (Find at least one failure risk)
4. Should we proceed, reject, or do something else?

Respond with JSON:
{
  "verdict": "approve",
  "riskAssessment": "Action is aligned with goal. Submit button is the correct target.",
  "failureRisk": "Form may have client-side validation that prevents submission with placeholder values",
  "confidence": 0.8
}

Verdict options:
- "approve": Action looks correct. Proceed.
- "reject": Action is wrong or too risky. Try alternative strategy.
- "override": Action is wrong. Use "suggestedAction" instead.

If overriding, use ONLY refs from PAGE ELEMENTS above:
{
  "verdict": "override",
  "riskAssessment": "Wrong element selected. The correct submit button is e12, not e5.",
  "failureRisk": "e5 is a decorative element that won't trigger form submission",
  "suggestedAction": "click e12 instead — it is the actual form submit button",
  "structuredOverride": { "action": "click", "ref": "e12" },
  "confidence": 0.85
}

Element-marker reference (per-line in PAGE ELEMENTS):
- [EXPANDED] / [COLLAPSED] / [CHECKED] / [SELECTED] / [PRESSED] — ARIA toggle states.
- [STATE=open|closed|active|inactive|on|off] — Radix UI / shadcn / Vaul data-state attribute.
  Many primitives do not mirror to aria-* — these markers are the ONLY signal of
  open/active state for Dialog, Popover, DropdownMenu, Collapsible, Tabs.
- [DISABLED] / [INVALID] — input cannot be used / failed validation.

Rules:
- Be SKEPTICAL. Your job is to find flaws, not agree.
- Check goal alignment: does this action ACTUALLY help reach the goal?
- Check element correctness: is this the RIGHT element?
- "approve" should still include a failureRisk (what COULD go wrong)
- Override refs MUST exist in PAGE ELEMENTS above — never invent refs
- **TOGGLE-REGRESSION REJECTION**: REJECT a click when:
  (a) goal text implies "open" / "show" / "expand" AND
  (b) the target element shows [STATE=open], [STATE=active], [STATE=on], or [EXPANDED]
  Reason: clicking such a trigger TOGGLES it closed — that's a regression, not progress.
  Inverse case: REJECT clicks on [STATE=closed]/[COLLAPSED] triggers when goal is "close"/"collapse".
  Suggested fix: respond with verdict "reject" and failureRisk noting the toggle regression;
  Strategist will mark goal done next iteration.
- Return ONLY valid JSON`;
  }
}
