/**
 * Centralized labels for paid-plan-gated features.
 *
 * `requirePaidPlan(label)` builds the user-facing 403 message as
 * `"${label} is available on paid plans. Upgrade to unlock it."`. Keeping the
 * label in ONE place stops the "Mobile testing" / "Mobile testing is..." drift
 * that crept in across the route middleware, the CI controller, and the mobile
 * dispatcher. New Pro-only features add a constant here and reuse it everywhere.
 */
export const PAID_FEATURE_LABELS = {
  MOBILE_TESTING: 'Mobile testing',
} as const;
