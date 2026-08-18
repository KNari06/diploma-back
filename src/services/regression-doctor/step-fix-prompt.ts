/**
 * Regression Doctor — the step-fix agent's prompt.
 *
 * Split out of `step-fix-agent.ts` to keep that file at its job (call, retry,
 * validate) and this one at its own: the exact wording that decides whether the
 * agent blames the test or the application. Prompt edits and call-path edits
 * have different review needs, and mixing them made one file that was mostly a
 * string literal.
 */

import { expandChunkForLLM, type KBChunk } from '@/services/kb/kb.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { FailedStepEvidence } from './types';

/** Cap on how much of a KB chunk reaches the prompt. */
const KB_CHUNK_CHARS = 500;
const KB_CHUNK_LIMIT = 3;

export const SYSTEM_PROMPT = `You are a senior QA automation engineer triaging ONE failed step of an automated UI test.

You must answer one question first: did the TEST go stale, or did the APPLICATION misbehave?

VERDICTS
- "test_fix"  — the application works; the test looks for something that moved, was renamed, or takes longer to appear, or the test's own assertion is wrong. Only this verdict may carry a patch.
- "app_bug"   — the application did something wrong: an error state, a crash, a missing feature, a broken flow. NEVER propose a patch here. Editing the test would hide the bug.
- "unclear"   — the evidence does not let you distinguish the two. Say so plainly. This is a respectable answer; guessing is not.

Default to "app_bug" or "unclear" when in doubt. A wrong "test_fix" silently deletes a real defect from the report.

PATCH ACTIONS (only for "test_fix", choose exactly one)

1. "update_element" — the step targets a control that was renamed, re-labelled, or moved.
   Provide "description" (a natural-language description of the element as it is NOW) and "bindingHints".
   CRITICAL: at replay the resolver reads bindingHints.label, then bindingHints.placeholder, then description — in that order. A stale label silently overrides your new description. So you MUST either give the correct new label/placeholder, or set them to null to fall back to the description. Never leave an outdated hint in place.
   "role" is a UI framework role (e.g. "flutter.Text", "button"); pass null if unsure — a wrong role is worse than none.

2. "insert_wait" — the element is correct but not on screen yet when the step runs (loading, animation, network).
   Provide "waitMs" between 1000 and 15000. Use this only when the evidence shows a timing problem — an element that never appears is not a timing problem.

3. "update_assertion" — ONLY for steps of type "ai_check", and only when the CHECK ITSELF is wrong: it describes an outcome the product intentionally changed, or it was written ambiguously.
   Provide "assertionText".
   This is the one patch that can hide a real bug. If the app failed to do what the assertion describes, that is "app_bug" — not a wrong assertion. In your reason, state explicitly why the assertion is wrong rather than the application. If you cannot make that argument, do not use this action.

CONFIDENCE
- 0.9-1.0  the screenshot or error text directly shows the cause
- 0.7-0.89 strong evidence, small ambiguity
- 0.5-0.69 plausible reading, unverified
- below 0.5 you are guessing — use "unclear"

DIAGNOSIS
One short paragraph (2-3 sentences), plain language, addressed to a QA engineer. Name what changed in the product or the test, not "the step failed". Write it in the same language the step descriptions use.

OUTPUT — strict JSON, no markdown:
{
  "verdict": "test_fix" | "app_bug" | "unclear",
  "diagnosis": "string",
  "confidence": 0.0,
  "patch": null | {
    "action": "update_element" | "insert_wait" | "update_assertion",
    "reason": "string",
    "description": "string",
    "bindingHints": { "label": "string|null", "placeholder": "string|null", "role": "string|null" },
    "waitMs": 0,
    "assertionText": "string"
  }
}
Include only the patch fields your chosen action uses.`;

export interface PromptInput {
  evidence: FailedStepEvidence;
  kbChunks: KBChunk[];
}

export function buildUserPrompt(input: PromptInput): string {
  const { evidence, kbChunks } = input;

  const kb =
    kbChunks.length === 0
      ? '  (nothing relevant)'
      : kbChunks
          .slice(0, KB_CHUNK_LIMIT)
          .map((c: KBChunk, i: number) => {
            const src = c.file_name ?? c.source_file ?? `chunk_${i + 1}`;
            return `  [${src}] ${expandChunkForLLM(c).slice(0, KB_CHUNK_CHARS).replace(/\s+/g, ' ')}`;
          })
          .join('\n');

  const aiRead = evidence.aiClassification
    ? `\nEARLIER AUTOMATED READ (may be wrong — your own judgement wins):\n  classification: ${evidence.aiClassification}${
        evidence.aiSummary ? `\n  summary: ${evidence.aiSummary}` : ''
      }`
    : '';

  return `TEST CASE: ${evidence.testCaseName}
PLATFORM:  ${evidence.platform}${evidence.currentApp ? `\nAPP:       ${evidence.currentApp}` : ''}

THE STEP THAT FAILED (index ${evidence.stepIndex}):
${describeStep(evidence.step)}

HOW IT FAILED:
  action:      ${evidence.action ?? evidence.step.type}
  reason:      ${evidence.failedReason ?? 'not classified'}
  explanation: ${evidence.failureExplanation ?? 'none recorded'}

STEPS BEFORE IT:
${evidence.precedingSteps.map((s: IntentStep, i: number) => `  ${evidence.stepIndex - evidence.precedingSteps.length + i}. ${oneLineStep(s)}`).join('\n') || '  (this was the first step)'}

STEP AFTER IT:
${evidence.followingStep ? `  ${evidence.stepIndex + 1}. ${oneLineStep(evidence.followingStep)}` : '  (this was the last step)'}

PROJECT KNOWLEDGE BASE:
${kb}${aiRead}

Return the JSON verdict now.`;
}

function describeStep(step: IntentStep): string {
  const lines = [
    `  type:         ${step.type}`,
    `  description:  ${step.description}`,
  ];
  if (step.value !== undefined) lines.push(`  value:        ${describeValue(step)}`);
  if (step.assertionText) lines.push(`  assertionText: ${step.assertionText}`);
  if (step.bindingHints && Object.keys(step.bindingHints).length > 0) {
    lines.push(`  bindingHints: ${JSON.stringify(step.bindingHints)}`);
  }
  return lines.join('\n');
}

function oneLineStep(step: IntentStep): string {
  return `${step.type} — ${step.description}`;
}

/**
 * A step's typed value never leaves this process in the clear.
 *
 * `isSensitive` is not a sufficient gate: it is set by the mobile agent's draft
 * authoring only, so a step recorded in the editor or imported carries a
 * literal `value` with no flag — a recorded login would send its password to
 * the model provider. Root CLAUDE.md hard invariant #10 puts the obligation on
 * whatever emits a step body, and this prompt emits one.
 *
 * `{{…}}` placeholders survive because they are the variable's NAME, not its
 * value, and knowing a field is bound to `{{secrets.password}}` genuinely helps
 * the agent read the step. Everything else is replaced by its shape: none of
 * the three patch actions can modify `value`, so the literal was never more
 * than context.
 */
function describeValue(step: IntentStep): string {
  const value = step.value;
  if (typeof value !== 'string' || value.length === 0) return '(empty)';
  if (/^\{\{[^}]+\}\}$/.test(value.trim())) return value;
  if (step.isSensitive) return '(sensitive, omitted)';
  return `(${value.length}-character literal, omitted)`;
}

