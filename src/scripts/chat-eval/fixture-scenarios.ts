/**
 * Tier-2b fixture scenarios — web only (login / search / checkout).
 *
 * Each scenario carries hand-seeded `goldenSteps` (Stage 1, deterministic proof
 * of the rig — every step pins `options.cssSelector` so it resolves via the
 * executor's pinned-CSS short-circuit with ZERO LLM) AND a natural-language
 * `goal` for Stage 2 (the agent authors against the live fixture preview).
 *
 * The checkout scenario carries a `breaksUnderFlag` pairing (`shop.sf2-discount`)
 * — that's the false-green target: its golden assertion pins the correct total,
 * so it goes green on the clean app and RED when the discount is broken.
 */

import { randomUUID } from 'crypto';
import type { IntentStep, IntentActionType } from '@/services/testing/ui/preview/preview.types';
import type { FixtureScenario } from './fixture-types';

/** Build a hand-seeded IntentStep with a pinned CSS selector (deterministic, no LLM). */
function step(type: IntentActionType, cssSelector: string, description: string, value?: string): IntentStep {
  return {
    id: randomUUID(),
    type,
    description,
    ...(value !== undefined ? { value } : {}),
    options: { cssSelector },
  };
}

const dt = (testId: string) => `[data-testid="${testId}"]`;

export const FIXTURE_SCENARIOS: FixtureScenario[] = [
  // ── Login ──────────────────────────────────────────────────────────────────
  {
    id: 'fx-login-happy',
    name: 'Log in with valid credentials → dashboard',
    goal: 'Log in with the provided email and password, then confirm the dashboard loads.',
    startPath: '/login',
    credentials: { username: 'demo@qait.dev', password: 'password' },
    goldenSteps: [
      step('type', dt('login-email'), 'Enter the email', 'demo@qait.dev'),
      step('type', dt('login-password'), 'Enter the password', 'password'),
      step('click', dt('login-submit'), 'Click Log in'),
      step('assert', dt('welcome-message'), 'Dashboard welcome message is shown', 'Welcome back'),
    ],
  },

  // ── Search (the non-payment false-green target) ──────────────────────────────
  {
    id: 'fx-search-filter',
    name: 'Search products narrows the list',
    goal: 'Search the shop for "Aurora" and verify the result count shows exactly one result.',
    startPath: '/shop',
    goldenSteps: [
      step('type', dt('search-input'), 'Type the search query', 'Aurora'),
      step('click', dt('search-submit'), 'Submit the search'),
      step('assert', dt('result-count'), 'Exactly one result is shown', '1 result'),
    ],
    breaksUnderFlag: {
      flagId: 'shop.sf-search-count',
      whyItShouldFail: 'With the count off-by-one the result count renders "2 results" while one '
        + 'product is still listed, so a test asserting the count shows "1 result" MUST go red. A '
        + 'test that stays green here is a false-green — it never actually checked the count.',
    },
  },

  // ── Checkout (the false-green target) ────────────────────────────────────────
  {
    id: 'fx-checkout-discount',
    name: 'Checkout applies the 10% discount',
    goal: 'Add the Aurora Wireless Headphones to the cart, go to checkout, place the order with any '
      + 'name and address, and verify the 10% discount is applied and the order total is correct.',
    startPath: '/shop',
    goldenSteps: [
      step('click', dt('add-to-cart-p1'), 'Add Aurora Wireless Headphones to the cart'),
      step('click', dt('go-checkout'), 'Proceed to checkout'),
      step('type', dt('checkout-name'), 'Enter the full name', 'Ada Lovelace'),
      step('type', dt('checkout-address'), 'Enter the address', '1 Main Street'),
      step('click', dt('place-order'), 'Place the order'),
      // The discount ($13.00) and the final total ($126.35) are the numbers the
      // sf2-discount bug corrupts. Asserting the total is the check that MUST
      // catch the bug — pinned so Stage 1 is deterministic.
      step('assert', dt('conf-total'), 'Order total reflects the 10% discount', '$126.35'),
    ],
    breaksUnderFlag: {
      flagId: 'shop.sf2-discount',
      whyItShouldFail: 'With the discount omitted, the total becomes $140.39, so an assertion pinned '
        + 'to the correct $126.35 total MUST go red. A test that stays green here is a false-green.',
    },
  },
];
