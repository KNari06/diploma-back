/**
 * SafetyInterceptor — Critic Phase 1 deterministic checks, always-on.
 *
 * Designed to run on EVERY action, including the skip path where the AI
 * Critic is bypassed for low-risk deterministic actions. <1ms overhead.
 *
 * Closes the safety gap at multi-agent-orchestrator.ts:1063-1072 where
 * `criticSkipForLowRisk` skips ALL safety checks — letting stale refs
 * and forbidden actions through.
 *
 * NOTE: Methods are COPIED from CriticAgent (not extracted) for PR2 to
 * minimize blast radius and avoid touching CriticAgent internals at all.
 * PR3 will dedupe by extracting CriticAgent.checkX methods to call this
 * class. Until then: KEEP IN SYNC if Critic policies change.
 *
 * Copy origin: critic-agent.ts:196-227 (checkForbiddenActions),
 *              critic-agent.ts:241-253 (checkRefExists),
 *              critic-agent.ts:259-398 (checkSecurityPolicies),
 *              critic-agent.ts:470-502 (checkVisualConflicts).
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import type { AICommand, BlockerInfo, VisionHints } from '../lite-types';
import type { ParsedSnapshot } from './parsed-snapshot';
import type { FormAnalysis, PolicyViolation, SupervisorBlackboard } from './types';

/**
 * Minimal input for deterministic safety checks.
 * Intentionally smaller than CriticInput — no AI-context fields like
 * actorReasoning, strategistThought, reasoningHistory, observation.
 */
export interface SafetyInput {
  /** The proposed action to validate */
  proposedCommand: AICommand;
  /** Pre-parsed snapshot for O(1) ref lookup */
  parsedSnapshot?: ParsedSnapshot;
  /** Fallback for ref check if parsedSnapshot absent (formatted snapshot string) */
  availableElements: string;
  /** Current page URL — for domain/protocol policies */
  currentUrl: string;
  /** Whether credentials are present in the run */
  hasCredentials: boolean;
  /** Form analysis from Observer (for password-field type policy) */
  formAnalysis?: FormAnalysis;
  /** Vision-detected conflicts for the target element */
  visionConflicts?: VisionHints['conflicts'];
  /** Whether page is currently in loading state */
  isPageLoading?: boolean;
  /** Refs of elements currently covered by overlays */
  coveredElements?: string[];
  /** Supervisor Blackboard — for forbidden-action enforcement in recovery mode */
  blackboard?: SupervisorBlackboard;
  /** Layer 3: Blocker info from previous iteration's failed click */
  lastBlockerInfo?: BlockerInfo;
  /** Iteration number — for logging only */
  iteration?: number;
}

/**
 * Result of a safety check. Compatible with CriticVerdict synthesis for
 * the orchestrator's reject cascade.
 */
export interface SafetyResult {
  /** True if no blocking violations were found */
  safe: boolean;
  /** First blocking violation reason (if !safe) */
  reason?: string;
  /** All violations (block + warn) for downstream consumers */
  policyViolations: PolicyViolation[];
  /** Whether the proposed ref exists in snapshot (for synthesizing CriticVerdict.refExists) */
  refExists: boolean;
}

export class SafetyInterceptor {
  /**
   * Run all Phase 1 deterministic safety checks.
   * Returns immediately on the first BLOCKING violation.
   * Pure function. <1ms typical runtime.
   */
  static check(input: SafetyInput): SafetyResult {
    const violations: PolicyViolation[] = [];

    // 1. Hallucination check — most common gating issue
    const refExists = SafetyInterceptor.checkRefExists(input);
    if (!refExists && input.proposedCommand.ref) {
      return {
        safe: false,
        reason: `Element ref "${input.proposedCommand.ref}" does not exist in page`,
        refExists: false,
        policyViolations: [{
          type: 'unsafe_action',
          description: `Hallucinated ref: ${input.proposedCommand.ref}`,
          severity: 'block',
        }],
      };
    }

    // 2. Security policies (8 deterministic checks)
    violations.push(...SafetyInterceptor.checkSecurityPolicies(input));

    // 3. Visual conflicts (covered/hidden/disabled)
    if (LITE_ENGINE_FLAGS.enableCriticVisualCheck) {
      violations.push(...SafetyInterceptor.checkVisualConflicts(input));
    }

    // 4. Forbidden actions (recovery mode only)
    if (LITE_ENGINE_FLAGS.enableSupervisorLayer) {
      violations.push(...SafetyInterceptor.checkForbiddenActions(input));
    }

    // First blocking violation wins
    const blockingViolations = violations.filter(v => v.severity === 'block');
    if (blockingViolations.length > 0) {
      return {
        safe: false,
        reason: blockingViolations.map(v => v.description).join('; '),
        refExists: true,
        policyViolations: violations,
      };
    }

    // Passed — warnings (if any) returned for logging by caller
    return { safe: true, refExists: true, policyViolations: violations };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Hallucination check (mirror of CriticAgent.checkRefExists)
  // ═══════════════════════════════════════════════════════════════════════

  private static checkRefExists(input: SafetyInput): boolean {
    const ref = input.proposedCommand.ref;
    if (!ref) return true; // Actions without ref (wait, press) are fine

    // Fast path
    if (input.parsedSnapshot) {
      return input.parsedSnapshot.hasRef(ref);
    }

    // Fallback: regex on formatted string
    const refPattern = new RegExp(`\\b${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return refPattern.test(input.availableElements);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Security & Policy enforcement (mirror of CriticAgent.checkSecurityPolicies)
  // KEEP IN SYNC with critic-agent.ts:259-398
  // ═══════════════════════════════════════════════════════════════════════

  private static checkSecurityPolicies(input: SafetyInput): PolicyViolation[] {
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

  // ═══════════════════════════════════════════════════════════════════════
  // Visual conflicts (mirror of CriticAgent.checkVisualConflicts)
  // KEEP IN SYNC with critic-agent.ts:470-502
  // ═══════════════════════════════════════════════════════════════════════

  private static checkVisualConflicts(input: SafetyInput): PolicyViolation[] {
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
  // Forbidden actions (mirror of CriticAgent.checkForbiddenActions)
  // KEEP IN SYNC with critic-agent.ts:196-227
  // ═══════════════════════════════════════════════════════════════════════

  private static checkForbiddenActions(input: SafetyInput): PolicyViolation[] {
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
}
