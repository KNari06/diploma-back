/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STEP VALIDATOR PROMPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Validates AI-generated IntentSteps against the user's goal and page DOM.
 * Runs BEFORE showing steps to the user — catches hallucinated elements,
 * missing steps, and goal misalignment.
 *
 * Input: user goal + generated steps JSON + compressed DOM context
 * Output: validation verdict (valid / needs_fix) + per-step issues
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function buildStepValidatorPrompt(
  userGoal: string,
  stepsJson: string,
  domContext: string,
  pageUrl: string,
  postNavigationStepIndices?: Set<number>,
): string {
  // Build multi-page flow note when navigate steps are present
  const multiPageNote = postNavigationStepIndices && postNavigationStepIndices.size > 0
    ? `\nMULTI-PAGE FLOW DETECTED:
Steps at indices [${[...postNavigationStepIndices].join(', ')}] come AFTER a "navigate" step and will execute on a DIFFERENT page than the DOM shown above.
- Do NOT flag these steps for "element not found in DOM" — the elements are on the target page, not the current page.
- Still validate: correct step type, has required fields, description is meaningful, logical sequence.
- These steps are operating without DOM context — minor description ambiguity is acceptable.`
    : '';

  return `You are a test step validator. Verify that AI-generated test steps are correct for the actual page.

USER'S GOAL: "${userGoal}"
PAGE URL: ${pageUrl}

PAGE DOM (interactive elements):
${domContext}
${multiPageNote}

GENERATED STEPS:
${stepsJson}

CHECK:
1. ELEMENT EXISTENCE — step descriptions should match real DOM elements above. Fuzzy match OK (e.g., "Login" vs "Log In"). Flag elements NOT in DOM as warnings (they may appear after interaction).
2. GOAL COVERAGE — do steps collectively fulfill the user's request? Flag missing key actions.
3. SEQUENCE — navigate first if URL mismatch, type before submit click, wait after page transitions.
4. COMPLETENESS — missing form fields? Missing ai_check for verification requests? Missing navigate step?

RULES:
- Be practical. Minor wording differences → valid.
- If ≥70% steps valid + goal covered → verdict "valid" (with warnings).
- Only "needs_fix" if critical steps wrong or missing.
- Skip format issues (id/type validation is done separately).

Respond in JSON:
{
  "verdict": "valid" | "needs_fix",
  "goalCoverage": 0.0-1.0,
  "issues": [{"stepIndex": 0, "severity": "error"|"warning", "issue": "...", "suggestion": "..."}],
  "missingSteps": [{"type": "step_type", "description": "...", "insertAfter": 0}],
  "reasoning": "1 sentence — why this verdict"
}`;
}
