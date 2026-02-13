/**
 * Strategist Agent — "What should I do?" (Manus-style)
 * Takes Observer's structured understanding and decides on strategy.
 * Never sees raw snapshot — works with structured observation.
 * Temperature: 0.15 (slight creativity for strategy)
 * ~6k input tokens, ~400 output tokens
 *
 * Manus enhancements:
 * A) Branching & Backtracking — pre-computed alternatives with instant switching
 * B) Tool-Constraint Awareness — cost/risk matrix for each action type
 * В) Verification Criteria — concrete success conditions, not vague expectations
 * Г) Rolling Context — compressed old history + detailed recent iterations
 * D) Negative Constraints — explicit "do NOT" rules to prevent common mistakes
 *
 * Cognitive enhancements:
 * E) Working Memory — structured form progress, accomplishments, visited pages
 * F) Structured Strategy — typed StrategyAction for Actor direct resolution
 * G) Structured Alternatives — with confidence scores and semantic diversity
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';
import type { StrategistInput, StrategistOutput, WorkingMemory } from './types';

export class StrategistAgent {
  /**
   * Decide on a strategy based on the Observer's output
   */
  static async strategize(input: StrategistInput): Promise<StrategistOutput | null> {
    const prompt = StrategistAgent.buildPrompt(input);

    const result = await LitePromptBuilder.askJson<StrategistOutput>(prompt, {
      model: LITE_ENGINE_FLAGS.coreBrainModel as 'gpt-4o' | 'gpt-4o-mini',
      temperature: 0.15,
      maxTokens: 500,
      timeoutMs: LITE_ENGINE_FLAGS.multiAgentStrategistTimeoutMs,
    });

    if (!result || !result.strategy) {
      logger.warn('[STRATEGIST] Failed to produce strategy');
      return null;
    }

    // Ensure defaults
    result.alternatives = result.alternatives || [];
    result.confidence = result.confidence ?? 0.5;
    result.riskLevel = result.riskLevel || 'medium';

    logger.debug('[STRATEGIST] Strategy complete', {
      strategy: result.strategy.slice(0, 50),
      confidence: result.confidence,
      riskLevel: result.riskLevel,
      done: result.done || false,
      blocked: !!result.blockedInfo,
      alternativeCount: result.alternatives.length,
      hasVerification: !!result.verificationCriteria,
      hasStructured: !!result.structuredStrategy,
      structuredAltCount: result.structuredAlternatives?.length ?? 0,
    });

    return result;
  }

  /**
   * Manus-style Rolling Context: Compress old history, keep recent detailed
   * Old iterations (before last 3) → compressed into summary paragraph
   * Last 3 iterations → full detail
   */
  private static buildRollingHistory(history: string): string {
    const lines = history.split('\n').filter(l => l.trim());

    // Short history — no compression needed
    if (lines.length <= 3) {
      return `RECENT ACTIONS:\n${lines.join('\n')}`;
    }

    // Split into old (compress) and recent (keep detailed)
    const recentCount = Math.min(3, lines.length);
    const oldLines = lines.slice(0, lines.length - recentCount);
    const recentLines = lines.slice(-recentCount);

    // Compress old lines into a brief summary
    const oldSummary = StrategistAgent.compressOldHistory(oldLines);

    return `CONTEXT SUMMARY (iterations 1-${oldLines.length}): ${oldSummary}\n\nRECENT ACTIONS (detailed):\n${recentLines.join('\n')}`;
  }

  /**
   * Compress older history lines into a brief narrative
   */
  private static compressOldHistory(lines: string[]): string {
    if (lines.length === 0) return 'No prior actions';

    // Extract key events: URL changes, errors, form fills, clicks
    const urlChanges: string[] = [];
    const errors: string[] = [];
    let fillCount = 0;
    let clickCount = 0;
    let actionCount = 0;

    for (const line of lines) {
      actionCount++;
      const urlMatch = line.match(/→\s*(\S+)/);
      if (urlMatch) urlChanges.push(urlMatch[1]);
      if (line.includes('❌') || line.includes('error')) errors.push(line.replace(/^\d+\.\s*\S+\s*/, '').slice(0, 40));
      if (/fill\(/i.test(line)) fillCount++;
      if (/click\(/i.test(line)) clickCount++;
    }

    const parts: string[] = [];
    parts.push(`${actionCount} actions`);
    if (clickCount > 0) parts.push(`${clickCount} clicks`);
    if (fillCount > 0) parts.push(`${fillCount} fills`);
    if (urlChanges.length > 0) parts.push(`navigated: ${urlChanges.join(' → ')}`);
    if (errors.length > 0) parts.push(`errors: ${errors.slice(0, 2).join('; ')}`);

    return parts.join(', ') + '.';
  }

  /**
   * Cognitive: Format working memory into a concise prompt section
   */
  private static formatWorkingMemory(memory: WorkingMemory): string {
    const parts: string[] = [];

    // Form progress
    const formEntries = Object.entries(memory.formProgress);
    if (formEntries.length > 0) {
      const formStatus = formEntries.map(([ref, status]) => `${ref}[${status}]`).join(', ');
      parts.push(`Form fields: ${formStatus}`);
    }

    // Recent accomplishments (last 5)
    if (memory.accomplishments.length > 0) {
      const recent = memory.accomplishments.slice(-5);
      parts.push(`Done: ${recent.join(' → ')}`);
    }

    // Visited pages
    const pageEntries = Object.entries(memory.visitedPages);
    if (pageEntries.length > 0) {
      const pages = pageEntries.map(([url, info]) => {
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        return `${path}(${info.pageType}, ${info.visitCount}x)`;
      });
      parts.push(`Visited: ${pages.join(', ')}`);
    }

    // Current sub-goal
    if (memory.currentSubGoal) {
      parts.push(`Current sub-goal: ${memory.currentSubGoal}`);
    }

    // Critic rejections (cross-ref pattern avoidance)
    if (memory.criticRejections && memory.criticRejections.length > 0) {
      const rejections = memory.criticRejections.map(r =>
        `- [iter ${r.iteration}] ${r.action}${r.ref ? `(${r.ref})` : ''}: ${r.reason}`
      );
      parts.push(`\n🛡️ CRITIC REJECTIONS (avoid these patterns):\n${rejections.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n') : 'No accumulated memory yet';
  }

  private static buildPrompt(input: StrategistInput): string {
    // ═══════════════════════════════════════════════════════════════════════
    // Context sections
    // ═══════════════════════════════════════════════════════════════════════

    const failedActionsSection = input.failedActions && input.failedActions.length > 0
      ? `\n🚫 BLACKLISTED ACTIONS (DO NOT use these — already failed):\n${input.failedActions.map(fa => {
        const reason = fa.lastError ? `: ${fa.lastError.slice(0, 60)}` : '';
        if (fa.lastOutcome === 'critic_rejected') {
          return `- ${fa.action}(${fa.ref}) "${fa.elementName}" VETOED by safety critic ${fa.failureCount}x${reason}`;
        }
        return `- ${fa.action}(${fa.ref}) "${fa.elementName}" failed ${fa.failureCount}x (${fa.lastOutcome}${reason})`;
      }).join('\n')}\n`
      : '';

    const auditSection = input.auditedDrift
      ? `\nDRIFT AUDIT: confidence=${Math.round(input.auditedDrift.confidence.score * 100)}%, ${input.auditedDrift.attribution.summary}${input.auditedDrift.repetition.loopDetected ? ' | ⚠️ LOOP: ' + input.auditedDrift.repetition.loopDescription : ''}\n`
      : '';

    const stuckSection = input.isStuck
      ? '\n⚠️ AGENT IS STUCK. You MUST choose a fundamentally different approach. Do NOT repeat any previous strategy.\n'
      : '';

    const criticFeedbackSection = input.criticFeedback
      ? `\n⚠️ CRITIC FEEDBACK: ${input.criticFeedback}\nYour previous strategy was REJECTED by the safety critic. You MUST propose a DIFFERENT approach that avoids this risk.\n`
      : '';

    const guidanceSection = input.guidance
      ? `\nSYSTEM GUIDANCE: ${input.guidance}\n`
      : '';

    const planSection = input.taskPlanSummary
      ? `\nTASK PLAN: ${input.taskPlanSummary}\n`
      : '';

    // ═══════════════════════════════════════════════════════════════════════
    // Manus enhancements
    // ═══════════════════════════════════════════════════════════════════════

    const impactSection = input.observation.impactScores && input.observation.impactScores.length > 0
      ? `\nIMPACT-SCORED CHANGES:\n${input.observation.impactScores.map(i => `- [${i.significance}/${i.type}] ${i.change}`).join('\n')}\n`
      : '';

    const spatialSection = input.observation.spatialDrift?.detected
      ? `\n⚠️ SPATIAL DRIFT: ${input.observation.spatialDrift.description}\n${input.observation.spatialDrift.movedElements?.map(m => `  - ${m.ref}: ${m.shift}`).join('\n') || ''}\n`
      : '';

    const networkStateSection = input.observation.networkActivity?.hasPendingRequests
      ? `\n🌐 NETWORK: Data in transit (${input.observation.networkActivity.asyncWorkTriggered ? 'async work triggered' : 'waiting'}). Consider waiting before next action.\n`
      : '';

    const expectationSection = input.observation.expectationDiff && !input.observation.expectationDiff.met
      ? `\n❌ EXPECTATION MISMATCH:\nExpected: ${input.observation.expectationDiff.expected}\nActual: ${input.observation.expectationDiff.actual}\nAnalysis: ${input.observation.expectationDiff.mismatch}\n→ Your last prediction was WRONG. Adjust strategy based on what actually happened.\n`
      : '';

    // Rolling context: compress old history, keep recent detailed
    const rollingHistory = StrategistAgent.buildRollingHistory(input.history);

    // ═══════════════════════════════════════════════════════════════════════
    // Cognitive: Working Memory section
    // ═══════════════════════════════════════════════════════════════════════
    const workingMemorySection = input.workingMemory
      ? `\n═══ WORKING MEMORY (accumulated across iterations) ═══\n${StrategistAgent.formatWorkingMemory(input.workingMemory)}\n`
      : '';

    // ═══════════════════════════════════════════════════════════════════════
    // Cognitive: Structured Strategy output format
    // ═══════════════════════════════════════════════════════════════════════
    const structuredStrategyFormat = LITE_ENGINE_FLAGS.enableStructuredStrategy
      ? `,
  "structuredStrategy": {
    "actionType": "fill",
    "target": "email field",
    "targetRef": "e5",
    "isSensitive": true
  },
  "structuredAlternatives": [
    { "action": { "actionType": "click", "target": "Google sign-in button" }, "confidence": 0.7 }
  ]`
      : '';

    const structuredStrategyRules = LITE_ENGINE_FLAGS.enableStructuredStrategy
      ? `\n- "structuredStrategy": Typed action for the Actor — actionType + target + optional targetRef from form fields. If you know the exact ref from form analysis, include targetRef
- "structuredAlternatives": Typed alternatives with confidence. Alternatives MUST target different elements/approaches than primary (semantic diversity)`
      : '';

    // Build form field refs hint for Strategist (so it can populate targetRef)
    const formRefsHint = input.observation.formAnalysis
      ? `\nForm field refs: ${input.observation.formAnalysis.fields.map(f => `${f.ref}="${f.label}"(${f.type}${f.hasValue ? ',filled' : ''})`).join(', ')}${input.observation.formAnalysis.submitButtonRef ? ` | Submit: ${input.observation.formAnalysis.submitButtonRef}="${input.observation.formAnalysis.submitButtonText}"` : ''}`
      : '';

    return `You are a Strategy Agent (Manus architecture). Decide the next action based on structured observation.

GOAL: ${input.goal}

═══ PAGE STATE ═══
- Page type: ${input.observation.pageType}
- Available actions: ${input.observation.availableActions.join(', ') || 'none identified'}
- Obstacles: ${input.observation.obstacles.join(', ') || 'none'}
- Form: ${input.observation.formAnalysis ? `${input.observation.formAnalysis.fields.length} fields, submit="${input.observation.formAnalysis.submitButtonText || 'unknown'}"` : 'none'}
- Error state: ${input.observation.errorState || 'none'}
- Modal: ${input.observation.modalInfo || 'none'}${formRefsHint}
${impactSection}${spatialSection}${networkStateSection}${expectationSection}${workingMemorySection}
═══ TOOL COST & RISK MATRIX ═══
Before choosing an action, consider its cost and risk:
| Action   | Cost   | Risk   | When to use                              |
|----------|--------|--------|------------------------------------------|
| scroll   | LOW    | NONE   | Need to see more content. Always safe.   |
| hover    | LOW    | NONE   | Need tooltips or dropdowns. Always safe. |
| wait     | LOW    | NONE   | Page loading or async work pending.      |
| click    | MEDIUM | LOW    | Interact with buttons, links, tabs.      |
| fill     | MEDIUM | LOW    | Fill form fields with data.              |
| select   | MEDIUM | LOW    | Choose dropdown option.                  |
| press    | MEDIUM | MEDIUM | Keyboard shortcut. May trigger submit.   |
| goto     | HIGH   | HIGH   | Navigate to new URL. Loses current page. |
Prefer LOW-cost actions when multiple paths exist. Use HIGH-risk actions only when necessary.
${planSection}${guidanceSection}${stuckSection}${criticFeedbackSection}${failedActionsSection}${auditSection}
═══ PROGRESS ═══
Progress: ${Math.round(input.progressScore * 100)}% | Iteration: ${input.iteration}
Last outcome: ${input.lastOutcome || 'none'}

═══ HISTORY ═══
${rollingHistory}

═══ NEGATIVE CONSTRAINTS (NEVER violate these) ═══
- Do NOT click external links that navigate away from the test domain
- Do NOT fill fields with random/garbage data — use realistic test values
- Do NOT submit forms with empty required fields
- Do NOT use goto when a link/button on the page achieves the same navigation
- Do NOT repeat a strategy that already failed (check HISTORY and BLACKLIST)
- Do NOT ignore obstacles — dismiss modals/popups before proceeding

═══ OUTPUT FORMAT ═══
Respond with JSON:
{
  "strategy": "Fill the email field with test credentials, then fill password",
  "thought": "Login form visible with 2 empty fields. Must fill before submit.",
  "expectedOutcome": "Both fields filled, form ready to submit",
  "verificationCriteria": "email field has value AND password field has value",
  "alternatives": ["Click 'Sign in with Google' button", "Click 'Forgot password' link"],
  "confidence": 0.85,
  "riskLevel": "low",
  "done": false,
  "blockedInfo": null${structuredStrategyFormat}
}

Rules:
- "strategy": Clear single-step instruction for the Actor (what to do RIGHT NOW)
- "alternatives": 1-2 backup strategies if primary fails. Pre-computed — Actor will try these automatically
- "expectedOutcome": What you predict will happen after this action
- "verificationCriteria": Concrete check using DOM/URL (e.g., "URL contains /dashboard OR element with text 'Welcome' visible"). NOT vague descriptions
- "riskLevel": "low" (scroll/hover/wait/fill), "medium" (click/select/press), "high" (goto/submit with side effects)
- "confidence": 0-1. Lower if obstacles present, history shows failures, or expectation mismatch${structuredStrategyRules}
- If goal is achieved: set "done": true
- If blocked (captcha, 2FA, verification): set "blockedInfo": {"reason": "...", "canUserHelp": true/false}
- Return ONLY valid JSON`;
  }
}
