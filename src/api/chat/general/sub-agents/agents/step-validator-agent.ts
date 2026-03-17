import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { raceWithTimeout } from '../tool-constants';
import { buildStepValidatorPrompt } from '../prompts/step-validator-prompt';
import { VALID_STEP_TYPES } from '@/services/skills/qa/qa-tool-handlers';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { StepValidationResult, StepValidationIssue, MissingStep } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STEP VALIDATOR AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Validates AI-generated IntentSteps against the user's goal and page DOM
 * BEFORE showing them to the user.
 *
 * Only runs in editor mode when the executor generates test steps as text.
 * Uses the same fast model as the reviewer (gemini-2.5-flash-lite).
 *
 * Checks:
 * 1. Element existence — do descriptions match DOM elements?
 * 2. Goal alignment — do steps cover the user's request?
 * 3. Step sequence — is the execution order logical?
 * 4. Completeness — are any steps missing?
 *
 * Key safety: Defaults to 'valid' on any failure (never blocks pipeline).
 * The validator is advisory — it adds warnings/suggestions but never blocks
 * the user from seeing their generated steps.
 *
 * Smart-skip: skips AI phase for trivial cases (≤2 steps, all deterministic checks pass).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Step types that require a `value` field */
const TYPES_REQUIRING_VALUE = new Set(['type', 'navigate', 'select', 'press']);

/** Step types that require `assertionText` */
const TYPES_REQUIRING_ASSERTION = new Set(['ai_check']);

/**
 * Try to extract IntentStep[] JSON from the executor's assistant text content.
 * Returns the raw JSON string and parsed array, or null if no steps found.
 *
 * Uses VALID_STEP_TYPES from qa-tool-handlers.ts — no hardcoded type list.
 */
export function extractStepsFromContent(
  assistantContent: string
): { stepsJson: string; stepsArray: any[] } | null {
  if (!assistantContent) return null;

  // Strategy: find JSON arrays in the text and check if they contain IntentStep-like objects
  // Try code blocks first (more reliable), then raw JSON arrays
  const candidates: string[] = [];

  // 1. Code blocks: ```json [...] ```
  const codeBlockRegex = /```(?:json)?\s*(\[\s*\{[^]*?\}\s*\])\s*```/g;
  let cbMatch;
  while ((cbMatch = codeBlockRegex.exec(assistantContent)) !== null) {
    candidates.push(cbMatch[1]);
  }

  // 2. Raw JSON arrays: [{ ... }]
  // Use a simpler regex that doesn't hardcode step types
  const rawArrayRegex = /\[\s*\{[^]*?"type"\s*:[^]*?"description"\s*:[^]*?\}\s*\]/g;
  let rawMatch;
  while ((rawMatch = rawArrayRegex.exec(assistantContent)) !== null) {
    candidates.push(rawMatch[0]);
  }

  // Try parsing each candidate
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed[0].type &&
        VALID_STEP_TYPES.has(parsed[0].type)
      ) {
        return { stepsJson: candidate, stepsArray: parsed };
      }
    } catch {
      // Parse failed — try next candidate
    }
  }

  return null;
}

/**
 * Extract DOM context from pipeline context messages.
 * Looks for the "CURRENT PAGE CONTEXT" system message injected by handler.ts.
 */
function extractDomContext(contextMessages: ChatCompletionMessageParam[]): {
  domContext: string;
  pageUrl: string;
} {
  let domContext = '';
  let pageUrl = 'unknown';

  for (const msg of contextMessages) {
    if (msg.role !== 'system') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.includes('CURRENT PAGE CONTEXT')) {
      domContext = content;
      const urlMatch = content.match(/URL:\s*(.+)/);
      if (urlMatch) {
        pageUrl = urlMatch[1].trim();
      }
      break;
    }
  }

  return { domContext, pageUrl };
}

/**
 * Identify step indices that come AFTER a navigate step.
 * These steps reference elements on a different page — element existence
 * checks against the current DOM are invalid for these.
 */
function identifyPostNavigationStepIndices(stepsArray: any[]): Set<number> {
  const postNavIndices = new Set<number>();
  let afterNavigate = false;

  for (let i = 0; i < stepsArray.length; i++) {
    if (afterNavigate) {
      postNavIndices.add(i);
    }
    if (stepsArray[i].type === 'navigate') {
      afterNavigate = true;
    }
  }

  return postNavIndices;
}

/** Regex to detect element-existence warnings from AI that should be suppressed for post-navigation steps */
const ELEMENT_EXISTENCE_ISSUE_RE = /not found|not in DOM|doesn't exist|missing from page|not visible|no matching element/i;

/**
 * Validate AI-generated IntentSteps against the user's goal and page DOM.
 *
 * Returns a StepValidationResult with verdict, issues, and missing steps.
 * Defaults to 'valid' on any failure — validator should NEVER block the pipeline.
 *
 * Smart-skip: for trivial step sets (≤2 steps with zero deterministic issues),
 * skips the AI call entirely — saves ~2-4s latency and tokens.
 */
export async function validateEditorSteps(
  userGoal: string,
  assistantContent: string,
  contextMessages: ChatCompletionMessageParam[],
  abortSignal?: AbortSignal
): Promise<StepValidationResult | null> {
  const startMs = Date.now();

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 1: Extract steps and DOM (deterministic, 0 tokens)
  // ═══════════════════════════════════════════════════════════════════════

  const extracted = extractStepsFromContent(assistantContent);
  if (!extracted) {
    logger.debug('[STEP_VALIDATOR] No IntentStep JSON found in assistant content — skipping');
    return null;
  }

  const { domContext, pageUrl } = extractDomContext(contextMessages);
  if (!domContext) {
    logger.debug('[STEP_VALIDATOR] No DOM context found in messages — skipping');
    return null;
  }

  // Detect multi-page flows (steps after a navigate step target a different page)
  const postNavStepIndices = identifyPostNavigationStepIndices(extracted.stepsArray);
  if (postNavStepIndices.size > 0) {
    logger.debug('[STEP_VALIDATOR] Multi-page flow detected', {
      postNavStepCount: postNavStepIndices.size,
      totalSteps: extracted.stepsArray.length,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 2: Deterministic pre-checks (0 tokens, <1ms)
  // Uses VALID_STEP_TYPES from qa-tool-handlers — single source of truth.
  // ═══════════════════════════════════════════════════════════════════════

  const deterministicIssues: StepValidationIssue[] = [];

  for (let i = 0; i < extracted.stepsArray.length; i++) {
    const step = extracted.stepsArray[i];

    // Required: id
    if (!step.id) {
      deterministicIssues.push({
        stepIndex: i,
        severity: 'warning',
        issue: 'Missing step ID (UUID)',
        suggestion: 'Auto-generate a UUID for this step',
      });
    }

    // Required: type (must be in VALID_STEP_TYPES)
    if (!step.type) {
      deterministicIssues.push({
        stepIndex: i,
        severity: 'error',
        issue: 'Missing step type',
        suggestion: `Allowed types: ${[...VALID_STEP_TYPES].join(', ')}`,
      });
    } else if (!VALID_STEP_TYPES.has(step.type)) {
      deterministicIssues.push({
        stepIndex: i,
        severity: 'error',
        issue: `Invalid step type "${step.type}"`,
        suggestion: `Allowed types: ${[...VALID_STEP_TYPES].join(', ')}`,
      });
    }

    // Required: description
    if (!step.description || step.description.length < 3) {
      deterministicIssues.push({
        stepIndex: i,
        severity: 'error',
        issue: 'Missing or too short description',
        suggestion: 'Add a specific description referencing the actual element',
      });
    }

    // Type-specific: value required for type/navigate/select/press
    if (TYPES_REQUIRING_VALUE.has(step.type) && !step.value) {
      deterministicIssues.push({
        stepIndex: i,
        severity: 'error',
        issue: `"${step.type}" step missing value`,
        suggestion: 'Add a value field',
      });
    }

    // Type-specific: assertionText required for ai_check
    if (TYPES_REQUIRING_ASSERTION.has(step.type) && !step.assertionText) {
      deterministicIssues.push({
        stepIndex: i,
        severity: 'error',
        issue: '"ai_check" step missing assertionText',
        suggestion: 'Add assertionText describing what to verify',
      });
    }
  }

  // If all steps have critical format errors, skip AI and return immediately
  const criticalErrors = deterministicIssues.filter(i => i.severity === 'error');
  if (criticalErrors.length >= extracted.stepsArray.length) {
    logger.info('[STEP_VALIDATOR] All steps have critical format errors — immediate needs_fix', {
      errorCount: criticalErrors.length,
      stepCount: extracted.stepsArray.length,
      durationMs: Date.now() - startMs,
    });
    return {
      verdict: 'needs_fix',
      goalCoverage: 0,
      issues: deterministicIssues,
      missingSteps: [],
      reasoning: 'All steps have critical format errors',
      durationMs: Date.now() - startMs,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Smart-skip: trivial step sets (≤2 steps, zero deterministic issues)
  // don't need AI validation — save ~2-4s latency + tokens
  // ═══════════════════════════════════════════════════════════════════════

  if (extracted.stepsArray.length <= 2 && deterministicIssues.length === 0) {
    logger.debug('[STEP_VALIDATOR] Trivial step set (≤2, no issues) — fast approve', {
      stepCount: extracted.stepsArray.length,
      durationMs: Date.now() - startMs,
    });
    return {
      verdict: 'valid',
      goalCoverage: 0.9,
      issues: [],
      missingSteps: [],
      reasoning: 'Trivial step set — deterministic fast-path',
      durationMs: Date.now() - startMs,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 3: AI Assessment (fast model — goal alignment, element existence)
  // Only for: ≥3 steps, or any deterministic issues detected
  // ═══════════════════════════════════════════════════════════════════════

  const prompt = buildStepValidatorPrompt(userGoal, extracted.stepsJson, domContext, pageUrl, postNavStepIndices);

  try {
    const aiPromise = getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: AI_TASK_MODELS.chatReviewer,
        temperature: SUB_AGENT_CONFIG.stepValidatorTemperature,
        max_tokens: SUB_AGENT_CONFIG.stepValidatorMaxTokens,
        response_format: { type: 'json_object' },
        abortSignal,
      }
    );

    const response = await raceWithTimeout(aiPromise, SUB_AGENT_CONFIG.stepValidatorTimeoutMs);

    if (!response || !response.content) {
      logger.warn('[STEP_VALIDATOR] Timeout — defaulting to valid', {
        durationMs: Date.now() - startMs,
      });
      return {
        verdict: 'valid',
        goalCoverage: 0.7,
        issues: deterministicIssues,
        missingSteps: [],
        reasoning: 'Timeout — defaulting to valid',
        durationMs: Date.now() - startMs,
      };
    }

    // Parse AI response
    const cleanContent = response.content.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    // Merge AI issues with deterministic issues (dedup by stepIndex + issue)
    // Filter out element-existence warnings for post-navigation steps (they target a different page)
    const aiIssues: StepValidationIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter((i: any) => i && typeof i.stepIndex === 'number' && i.issue)
          .filter((i: any) => {
            if (postNavStepIndices.has(i.stepIndex) && ELEMENT_EXISTENCE_ISSUE_RE.test(String(i.issue))) {
              logger.debug('[STEP_VALIDATOR] Filtered post-navigation element issue', {
                stepIndex: i.stepIndex,
                issue: String(i.issue).substring(0, 100),
              });
              return false;
            }
            return true;
          })
          .map((i: any) => ({
            stepIndex: i.stepIndex,
            severity: i.severity === 'error' ? 'error' : 'warning',
            issue: String(i.issue).substring(0, 200),
            suggestion: String(i.suggestion || '').substring(0, 200),
          }))
      : [];

    const deterministicKeys = new Set(deterministicIssues.map(i => `${i.stepIndex}-${i.issue}`));
    const mergedIssues = [
      ...deterministicIssues,
      ...aiIssues.filter(i => !deterministicKeys.has(`${i.stepIndex}-${i.issue}`)),
    ];

    const missingSteps: MissingStep[] = Array.isArray(parsed.missingSteps)
      ? parsed.missingSteps
          .filter((s: any) => s && s.type && s.description)
          .map((s: any) => ({
            type: String(s.type),
            description: String(s.description).substring(0, 200),
            insertAfter: typeof s.insertAfter === 'number' ? s.insertAfter : -1,
          }))
      : [];

    const goalCoverage = typeof parsed.goalCoverage === 'number'
      ? Math.max(0, Math.min(1, parsed.goalCoverage))
      : 0.7;

    // Determine final verdict
    const hasErrors = mergedIssues.some(i => i.severity === 'error');
    let verdict: 'valid' | 'needs_fix';
    if (parsed.verdict === 'needs_fix' && hasErrors) {
      verdict = 'needs_fix';
    } else if (hasErrors && goalCoverage < 0.5) {
      verdict = 'needs_fix';
    } else {
      verdict = 'valid';
    }

    const result: StepValidationResult = {
      verdict,
      goalCoverage,
      issues: mergedIssues,
      missingSteps,
      reasoning: String(parsed.reasoning || '').substring(0, 300),
      durationMs: Date.now() - startMs,
    };

    logger.info('[STEP_VALIDATOR] Validation complete', {
      verdict: result.verdict,
      goalCoverage: result.goalCoverage,
      issueCount: result.issues.length,
      errorCount: result.issues.filter(i => i.severity === 'error').length,
      warningCount: result.issues.filter(i => i.severity === 'warning').length,
      missingStepCount: result.missingSteps.length,
      stepCount: extracted.stepsArray.length,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error) {
    // On any failure, default to 'valid' — validator should NEVER block
    logger.error('[STEP_VALIDATOR] AI validation failed — defaulting to valid', {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startMs,
    });

    return {
      verdict: 'valid',
      goalCoverage: 0.7,
      issues: deterministicIssues,
      missingSteps: [],
      reasoning: `Validator error — defaulting to valid`,
      durationMs: Date.now() - startMs,
    };
  }
}

/**
 * Format validation result as advisory text to inject into the executor's response.
 * Only injects if there are actionable issues the user should know about.
 */
export function formatValidationWarnings(result: StepValidationResult): string | undefined {
  if (result.verdict === 'valid' && result.issues.length === 0 && result.missingSteps.length === 0) {
    return undefined;
  }

  const parts: string[] = [];

  // Errors
  const errors = result.issues.filter(i => i.severity === 'error');
  if (errors.length > 0) {
    parts.push('⚠️ **Validation warnings:**');
    for (const err of errors) {
      parts.push(`- Step ${err.stepIndex + 1}: ${err.issue}`);
      if (err.suggestion) parts.push(`  → ${err.suggestion}`);
    }
  }

  // Missing steps suggestions
  if (result.missingSteps.length > 0) {
    parts.push('');
    parts.push('💡 **Suggested additional steps:**');
    for (const ms of result.missingSteps) {
      parts.push(`- [${ms.type}] ${ms.description}`);
    }
  }

  // Warnings (only if no errors — don't overwhelm)
  if (errors.length === 0) {
    const warnings = result.issues.filter(i => i.severity === 'warning');
    if (warnings.length > 0) {
      parts.push('');
      parts.push('ℹ️ **Notes:**');
      for (const warn of warnings.slice(0, 3)) {
        parts.push(`- Step ${warn.stepIndex + 1}: ${warn.issue}`);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}
