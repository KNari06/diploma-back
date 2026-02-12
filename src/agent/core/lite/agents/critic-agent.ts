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
      model: LITE_ENGINE_FLAGS.coreBrainModel as 'gpt-4o' | 'gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 250,
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
      confidence: aiResult.confidence,
      refExists,
      policyViolations,
      reasoningInconsistencies,
    };

    // If AI approved but we have warnings or inconsistencies, downgrade confidence
    if (verdict.verdict === 'approve') {
      const warningCount = policyViolations.filter(v => v.severity === 'warn').length;
      if (warningCount > 0 || reasoningInconsistencies.length > 0) {
        verdict.confidence = Math.max(0.3, verdict.confidence - 0.2 * warningCount - 0.15 * reasoningInconsistencies.length);
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
    return !violations.some(v => v.severity === 'block');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Deterministic checks (no AI, <1ms each)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Hallucination check: Does the ref exist in available elements?
   */
  private static checkRefExists(input: CriticInput): boolean {
    const ref = input.proposedCommand.ref;
    if (!ref) return true; // Actions without ref (wait, press) are fine

    // Check if ref appears in the available elements string
    // Format: elements contain refs like "e5", "e12" etc.
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
        // Check if it's labeled as password — sometimes type="text" is used with visibility toggle
        const isLikelyPasswordField = /password|passwd|secret/i.test(targetField.label);
        if (!isLikelyPasswordField) {
          violations.push({
            type: 'password_exposure',
            description: `Filling sensitive data into type="text" field "${targetField.label}" (ref: ${targetField.ref}). Expected type="password"`,
            severity: 'block',
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

    return `You are a RED TEAM Critic. Your job is to DISPROVE the proposed action.
Find at least ONE reason it could FAIL or be WRONG.

═══ CONTEXT (what you know) ═══
GOAL: ${input.goal}
PAGE: ${input.observation.pageType}
Available actions: ${input.observation.availableActions.join(', ') || 'none'}
${obstacles}
${formInfo}
${errorInfo}

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

If overriding:
{
  "verdict": "override",
  "riskAssessment": "Wrong element selected. The correct submit button is e12, not e5.",
  "failureRisk": "e5 is a decorative element that won't trigger form submission",
  "suggestedAction": "click e12 instead — it is the actual form submit button",
  "confidence": 0.85
}

Rules:
- Be SKEPTICAL. Your job is to find flaws, not agree.
- Check goal alignment: does this action ACTUALLY help reach the goal?
- Check element correctness: is this the RIGHT element?
- "approve" should still include a failureRisk (what COULD go wrong)
- Return ONLY valid JSON`;
  }
}
