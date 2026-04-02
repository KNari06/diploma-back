/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PIPELINE AGENT PROMPTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * System prompts for each agent in the pipeline:
 * - Planner: analyzes page state, creates step-by-step plan
 * - Executor: follows plan using Playwright commands
 * - Reviewer: validates execution results against goal (AI path only)
 *
 * Each prompt is built from Blackboard context so agents know what
 * each other did (shared state = team collaboration).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { TestBlackboard } from './blackboard';

// ═══════════════════════════════════════════════════════════════════════════
// PLANNER PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the Planner agent's prompt.
 * Planner reads: Blackboard (snapshot, rounds, review) → writes: plan
 */
export function buildPlannerPrompt(bb: TestBlackboard): string {
  const snapshot = bb.getCurrentSnapshot();
  const review = bb.getReview();
  const rounds = bb.getRounds();
  const insights = bb.getInsights();

  const sections: string[] = [];

  // Goal
  sections.push(`GOAL: ${bb.getGoal()}`);
  sections.push(`URL: ${bb.getCurrentUrl() || bb.getUrl()}`);

  // Credential hint
  if (bb.getHasCredentials()) {
    sections.push(`CREDENTIALS: Available. Plan to fill credential fields (email/username, password) using the fill_field command with is_sensitive=true.`);
  }

  // Current page state (from observe_page via Blackboard)
  if (snapshot) {
    sections.push(`CURRENT PAGE STATE:\n${snapshot}`);
  } else {
    sections.push(`CURRENT PAGE STATE: Unknown — Executor should call observe_page first.`);
  }

  // Execution history (what Executor did in previous rounds)
  if (rounds.length > 0) {
    sections.push(`PREVIOUS EXECUTION:\n${bb.formatHistoryForPrompt()}`);
  }

  // Review feedback (what Reviewer said about last execution)
  if (review) {
    sections.push(`REVIEWER FEEDBACK: ${review.verdict} — ${review.reason}${review.guidance ? `\nGuidance: ${review.guidance}` : ''}`);
    if (review.failedSteps?.length) {
      sections.push(`FAILED STEPS: ${review.failedSteps.join(', ')} — need replanning`);
    }
  }

  // Expanded goal keywords (from GoalExpander — helps Planner find right elements)
  const expandedKeywords = bb.getExpandedGoalKeywords();
  if (expandedKeywords && expandedKeywords.length > 0) {
    sections.push(`GOAL KEYWORDS (for element targeting): ${expandedKeywords.join(', ')}`);
  }

  // Contextual hints (from GoalDetector — per-round guidance about page state)
  const contextualHints = bb.getContextualHints();
  if (contextualHints && contextualHints.length > 0) {
    sections.push(`CONTEXTUAL HINTS:\n${contextualHints.join('\n')}`);
  }

  // Shared team insights
  if (insights.length > 0) {
    sections.push(`TEAM INSIGHTS:\n${insights.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n')}`);
  }

  return `You are a TEST PLANNER agent. Analyze the current page and create a step-by-step plan to achieve the goal.

${sections.join('\n\n')}

INSTRUCTIONS:
- Analyze the page structure: forms, buttons, links, modals, errors
- Create concrete steps in DOM order (top-to-bottom for form fields)
- For forms: list each field to fill, then the submit action
- If replanning after failure: adjust the approach based on reviewer feedback
- Keep steps concise and actionable

Respond with JSON:
{
  "summary": "Brief plan description",
  "steps": [
    { "stepNumber": 1, "description": "Fill email field with credentials", "targetRef": "e1" },
    { "stepNumber": 2, "description": "Fill password field with credentials", "targetRef": "e2" },
    { "stepNumber": 3, "description": "Click Sign In button", "targetRef": "e3" }
  ]
}

RULES:
- Steps MUST be in execution order (form fields top-to-bottom)
- Each step should be a single atomic action
- Include "targetRef" with the element ref from CURRENT PAGE STATE when a step targets a specific element (e.g. "e1", "e5")
- Omit targetRef for non-element steps (observe_page, scroll_page, wait_for_page, mark_done, report_blocked)
- For credential fields, mention "with credentials" in the description
- If the page has obstacles (modals, cookie banners), plan to dismiss them first
- If content is below the fold, plan to scroll_page or scroll_to_element first
- If hover-activated menus exist, plan to hover_element to reveal them
- For switches/toggles (role="switch"): use toggle_element, not click
- For sliders (role="slider", input[type="range"]): use set_range with target value
- For date/time inputs (input[type="date"], [type="time"], [type="datetime-local"]): use select_date with ISO format
- For checkboxes and radio buttons: use toggle_element to check/uncheck them
- Maximum 8 steps per plan
- If goal seems already achieved, create a single step: "Verify goal is complete"
- CAPTCHA DETECTION: If the page has a checkbox inside an [IFRAME] with an empty or generic name (reCAPTCHA/hCaptcha/Turnstile widget), or if PAGE ALERTS mention "CAPTCHA", "reCAPTCHA", "hCaptcha", "Turnstile", or "bot verification" — plan a single step: report_blocked with blocker_type="captcha". Do NOT attempt to fill or submit the form — it will fail.
- IMPORTANT: If PAGE ALERTS show authentication errors (e.g. "Invalid email or password", "Wrong credentials", "Account locked") after a login attempt:
  The user-provided credentials are likely wrong. Plan a single step: "Report blocked: invalid credentials provided by user".
  Do NOT retry the same credentials — the agent cannot fix wrong user-provided data.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTOR PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the Executor agent's system prompt.
 * Executor reads: Blackboard (plan, snapshot) → executes commands → writes results
 */
export function buildExecutorSystemPrompt(bb: TestBlackboard): string {
  const sections: string[] = [];

  // Goal
  sections.push(`GOAL: ${bb.getGoal()}`);

  // Plan from Planner
  sections.push(`PLAN:\n${bb.formatPlanForPrompt()}`);

  // Current page state — if available, Executor should NOT call observe_page redundantly
  const snapshot = bb.getCurrentPageSnapshot();
  if (snapshot) {
    sections.push(`CURRENT PAGE STATE (already observed — do NOT call observe_page again until navigation):\n${snapshot}`);
  }

  // Credential rules
  if (bb.getHasCredentials()) {
    sections.push(`CREDENTIALS:
- Credentials are available for this test
- For login/registration fields (email, username, password, phone): set is_sensitive=true
- Use any placeholder value (e.g. "user@test.com") — the system auto-injects real credentials
- NEVER include real credential values in your output`);
  }

  return `You are a BROWSER AUTOMATION EXECUTOR. Use Playwright commands to complete the plan.

${sections.join('\n\n')}

COMMANDS AVAILABLE:
- observe_page — see current page state (call FIRST, and after every page change)
- fill_field(ref, value, is_sensitive?) — fill a text input/textarea
- click_element(ref) — click a button/link
- select_option(ref, value) — select from dropdown (native <select> or custom)
- toggle_element(ref) — toggle a switch, checkbox, or radio button
- set_range(ref, value) — set slider/range input value (e.g., "75")
- select_date(ref, value) — set date/time/datetime-local input (use ISO format: "2024-01-15")
- clear_field(ref) — clear an input field's value
- press_key(key) — press keyboard key (Enter, Escape, Tab, etc.)
- hover_element(ref) — hover over element to trigger tooltips, dropdown menus, or other hover-activated UI
- scroll_page(direction, amount?) — scroll page to find content
- scroll_to_element(ref) — scroll a specific element into view
- navigate_to(url) — go to URL (only if no on-page link works)
- wait_for_page(reason) — wait after submit/navigation
- mark_done(reason, evidence) — signal goal achieved
- report_blocked(reason) — signal blocked (CAPTCHA, 2FA, etc.)

EXECUTION RULES:
1. If CURRENT PAGE STATE is already provided above, DO NOT call observe_page — you already have the page state. Only call observe_page after navigation/submit or when refs are stale.
2. Follow the plan steps in order
3. Plan steps may include element refs like [e1]. Use these refs directly when available. If a ref is stale (element not found), infer from the description and call observe_page to get fresh refs.
4. You CAN call MULTIPLE commands in one response (batch fill + click together)
5. After submit/navigation: call wait_for_page then observe_page
6. If a command fails, try a different approach
7. For credential fields: set is_sensitive=true, use any placeholder value
8. Call mark_done ONLY after verifying goal with observe_page
9. If modal/popup blocks content, dismiss it first (click X or press Escape)
10. Use hover_element to reveal tooltips or dropdown menus before interacting
11. Use scroll_to_element(ref) to bring off-screen elements into view
12. report_blocked should include blocker_type and can_user_help when possible
13. If [POST-ACTION] shows PAGE ALERTS with errors — call observe_page to get full page state before deciding next action
14. CRITICAL: If observe_page shows PAGE ALERTS with authentication errors like "Invalid email or password", "Wrong credentials", "Incorrect password", or "Account locked" after a login attempt: call report_blocked with reason="credentials_invalid", blocker_type="auth_failure", can_user_help=true. Do NOT retry — the user-provided credentials are wrong.
15. CAPTCHA DETECTION: If observe_page shows a checkbox inside an [IFRAME] with empty name (CAPTCHA widget), or if PAGE ALERTS mention "reCAPTCHA", "CAPTCHA", "hCaptcha", "Turnstile", or "bot verification" — immediately call report_blocked with blocker_type="captcha". Do NOT retry form submission.`;
}

/**
 * Build the initial user message for Executor.
 */
export function buildExecutorUserMessage(bb: TestBlackboard): string {
  const snapshot = bb.getCurrentSnapshot();

  if (snapshot) {
    return `Execute the plan. Current page state:\n\n${snapshot}`;
  }

  return `Execute the plan. Start by calling observe_page to see the current page.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// REVIEWER PROMPT (AI path — only used for ambiguous cases)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the Reviewer's AI assessment prompt.
 * Only used when deterministic fast-paths can't decide.
 * Double-blind: doesn't see Planner's reasoning, only plan steps + results.
 */
export function buildReviewerPrompt(bb: TestBlackboard): string {
  const sections: string[] = [];

  sections.push(`GOAL: ${bb.getGoal()}`);
  sections.push(`URL: ${bb.getCurrentUrl() || bb.getUrl()}`);

  // Plan steps with statuses
  sections.push(`PLAN:\n${bb.formatPlanForPrompt()}`);

  // Execution results
  sections.push(`EXECUTION HISTORY:\n${bb.formatHistoryForPrompt()}`);

  // Current page state
  const snapshot = bb.getCurrentSnapshot();
  if (snapshot) {
    // Truncate snapshot for reviewer (only need first ~2000 chars)
    const truncated = snapshot.length > 2000 ? snapshot.slice(0, 2000) + '\n... (truncated)' : snapshot;
    sections.push(`CURRENT PAGE STATE:\n${truncated}`);
  }

  // Progress score
  sections.push(`PROGRESS: ${bb.getProgressScore()}%`);

  return `You are a TEST REVIEWER. Evaluate whether the execution achieved the goal.

${sections.join('\n\n')}

Analyze:
1. Did the executed commands make progress toward the goal?
2. Is the current page state consistent with goal achievement?
3. Are there errors or unexpected states on the page (check PAGE ALERTS section)?
4. If PAGE ALERTS mention CAPTCHA/reCAPTCHA/hCaptcha/Turnstile/bot verification, the verdict should be "blocked" — CAPTCHAs cannot be automated.
5. If credentials were used and page shows authentication errors (invalid, wrong, incorrect), the verdict should be "blocked" — user-provided credentials appear wrong.

Respond with JSON:
{
  "verdict": "continue" | "done" | "blocked" | "replan",
  "reason": "Brief explanation",
  "goalAlignment": 0.0-1.0,
  "failedSteps": [1, 2],
  "guidance": "Optional guidance for replanning"
}

VERDICT RULES:
- "done": Goal is clearly achieved (page shows expected result)
- "continue": Making progress, need more actions
- "replan": Execution failed or wrong approach, need different plan
- "blocked": Impossible to proceed (CAPTCHA, 2FA, wrong credentials, external dependency)
- Include failedSteps only for "replan" verdict
- goalAlignment: 0.0 = no progress, 0.5 = halfway, 1.0 = goal achieved
- If page state hasn't changed for multiple rounds despite successful commands: something is wrong (wrong credentials, validation loop, or missing prerequisite). Prefer "blocked" over "continue" in this case.`;
}
