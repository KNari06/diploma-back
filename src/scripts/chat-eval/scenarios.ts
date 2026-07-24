/**
 * Bootstrap scenarios for the chat authoring eval (web only, add + edit).
 *
 * ⚠️ BIASED BOOTSTRAP SET — hand-written from what I *think* breaks, not mined
 * from real usage. `test_logs/chat_test/` is empty until real traces accrue.
 * Treat any baseline off these as directional, not ground truth; swap for a
 * mined, representative corpus before trusting the number (plan §3).
 *
 * Mobile is intentionally excluded here — it drags in the emulator + dev-stack
 * lock. Add it once the loop is proven on web.
 */

import type { Scenario } from './types';

export const BOOTSTRAP_SCENARIOS: Scenario[] = [
  // ── add (global create) ──────────────────────────────────────────────────
  {
    id: 'add-login-happy',
    name: 'Author a positive login test',
    scope: 'add',
    userMessage: 'Create a test that logs in with a valid email and password and checks the dashboard loads.',
    expectsSteps: true,
    grounding: 'credentials',
    note: 'Needs credentials that no store holds yet → the runnable move is to ASK '
      + '(or leave a placeholder), NEVER fabricate "a valid email". A fabricated '
      + 'credential looks well-formed but cannot run — a false-green the grounding check catches.',
  },
  {
    id: 'add-search-filter',
    name: 'Author a search + filter test',
    scope: 'add',
    userMessage: 'Make a test that searches for "shoes" and applies the price filter, then verifies results updated.',
    expectsSteps: true,
    note: 'Multi-action flow; probes step granularity.',
  },
  {
    id: 'add-checkout-promo',
    name: 'Author a checkout-with-promo test',
    scope: 'add',
    userMessage: 'Write a test: add the first product to the cart, open checkout, apply promo code SAVE10, and assert the discount shows.',
    expectsSteps: true,
    note: 'Includes an assertion step (ai_check).',
  },
  {
    id: 'add-vague-underspecified',
    name: 'Underspecified request',
    scope: 'add',
    userMessage: 'Test the thing.',
    expectsSteps: false,
    note: 'Should clarify, not hallucinate steps. producedSteps=false is the pass shape.',
  },

  // ── edit (per-test-case scope) ───────────────────────────────────────────
  {
    id: 'edit-add-step',
    name: 'Add a step to the bound test case',
    scope: 'edit',
    boundTestCaseName: 'Positive Login Flow',
    userMessage: 'Also verify the user avatar is visible after login. Update this test.',
    expectsSteps: true,
    note: 'Must call qa_update_test_case_steps — NOT create a duplicate.',
  },
  {
    id: 'edit-change-assertion',
    name: 'Change an assertion in the bound test case',
    scope: 'edit',
    boundTestCaseName: 'Checkout with Promo Code',
    userMessage: 'Change the final check to assert the total is $45 instead of $50. Save it.',
    expectsSteps: true,
    note: '"Save it" in tc-scope means update-in-place, the duplicate-bug trap.',
  },
  {
    id: 'edit-remove-step',
    name: 'Remove a step from the bound test case',
    scope: 'edit',
    boundTestCaseName: 'Reset Password Email',
    userMessage: 'Remove the step that waits for the toast, it flakes. Update the test.',
    expectsSteps: true,
    note: 'Edit that reduces step count; still update-in-place.',
  },
  {
    id: 'edit-russian-save',
    name: 'Russian "save" phrasing in tc-scope',
    scope: 'edit',
    boundTestCaseName: 'Positive Login Flow',
    userMessage: 'Добавь шаг проверки приветственного сообщения и сохрани.',
    expectsSteps: true,
    note: 'RU "сохрани" must resolve to update-in-place, not create.',
  },
];
