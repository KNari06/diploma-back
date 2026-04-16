/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTRA-FLOW OVERLAY GATE — decide when to re-run cleanup between steps
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Background:
 *
 *   OverlayDismisser runs at flow start and around branch detection. That
 *   covers "the page loaded with a cookie banner". What it does NOT cover:
 *   banners / modals / toasts that appear AFTER an action fires inside the
 *   flow (e.g. a "please rate us" popup after the third click, a tooltip
 *   walkthrough that kicks in on first form focus).
 *
 *   Running the full dismisser on every observe_page would add ~200-400ms
 *   per round. On a 10-round flow that's 2-4 extra seconds for nothing
 *   when no overlay ever appears. So we need a cheap gate that skips the
 *   dismisser when it has no work to do.
 *
 * Gate:
 *
 *   SnapshotCollector already returns obstacleFacts on every collect() —
 *   essentially free DOM analysis. We classify those facts:
 *
 *     noise   — known dismissible chrome that is safe to auto-close:
 *                 cookie_consent, chat_widget, onboarding, tooltip, toast.
 *     app     — legitimate app dialogs we MUST leave alone:
 *                 modal, drawer, paywall (the flow may need to use them).
 *     inert   — facts we don't act on: sticky_header/footer, loading_overlay
 *               (handled by VisualStability elsewhere), dropdown (user-opened).
 *
 *   The gate returns true iff there is ≥1 noise-class obstacle AND no app
 *   dialog is also present. An app dialog "wins" — if the snapshot shows a
 *   confirm dialog, we do not touch it even if a toast is also visible.
 *
 * Policy rationale:
 *
 *   False negative (missed banner) = flow wastes a round blocked. Recoverable.
 *   False positive (dismissed app dialog) = flow deletes user data or
 *                                           confirms an unintended action.
 *                                           Unrecoverable. Bias accordingly.
 */

import type { LiteSnapshot, ObstacleFact, ObstacleType } from '../lite-types';

/**
 * Obstacles that are safe to auto-dismiss mid-flow. These are always
 * page chrome / ambient noise, never something the flow's goal depends on.
 */
const NOISE_OBSTACLE_TYPES: ReadonlySet<ObstacleType> = new Set<ObstacleType>([
  'cookie_consent',
  'chat_widget',
  'onboarding',
  'tooltip',
  'toast',
]);

/**
 * Obstacles that represent actual app state. The flow may need to click
 * inside them ("Delete this project" confirmation, a slide-over form,
 * a "subscribe to continue" wall). Auto-dismiss would corrupt the flow.
 */
const APP_DIALOG_TYPES: ReadonlySet<ObstacleType> = new Set<ObstacleType>([
  'modal',
  'drawer',
  'paywall',
]);

/** Result of evaluating whether to run intra-flow cleanup. */
export interface OverlayGateDecision {
  /** True iff the caller should invoke OverlayDismisser now. */
  shouldDismiss: boolean;
  /**
   * Obstacle types that triggered the decision. Empty when shouldDismiss=false.
   * Caller can log / trace these for diagnostics.
   */
  noiseTypes: ObstacleType[];
  /**
   * When false, why not. Useful for trace logging when we intentionally
   * chose not to dismiss (e.g. "app dialog present, hands off").
   */
  reason?: 'no_obstacles' | 'app_dialog_present' | 'only_inert_obstacles';
}

/**
 * Decide whether to trigger overlay dismissal based on the current snapshot.
 *
 * Pure function — no page interaction, no allocations beyond a small array.
 * Called inside observePage on every round, so hot-path performance matters;
 * keep this O(n) in obstacleFacts.
 */
export function evaluateOverlayGate(snapshot: LiteSnapshot | null | undefined): OverlayGateDecision {
  const facts: ObstacleFact[] = snapshot?.obstacleFacts ?? [];

  if (facts.length === 0) {
    return { shouldDismiss: false, noiseTypes: [], reason: 'no_obstacles' };
  }

  let hasAppDialog = false;
  const noiseTypes = new Set<ObstacleType>();

  for (const fact of facts) {
    const type = fact.hintType;
    if (!type) continue; // unclassified — leave alone
    if (APP_DIALOG_TYPES.has(type)) {
      hasAppDialog = true;
      // Keep scanning to populate noiseTypes for diagnostics, but the
      // decision is already decided — we will not dismiss.
    } else if (NOISE_OBSTACLE_TYPES.has(type)) {
      noiseTypes.add(type);
    }
  }

  if (hasAppDialog) {
    return {
      shouldDismiss: false,
      noiseTypes: Array.from(noiseTypes),
      reason: 'app_dialog_present',
    };
  }

  if (noiseTypes.size === 0) {
    // Obstacles present but none are dismissible noise (e.g. only sticky
    // headers / loading overlays). Nothing for us to do.
    return {
      shouldDismiss: false,
      noiseTypes: [],
      reason: 'only_inert_obstacles',
    };
  }

  return { shouldDismiss: true, noiseTypes: Array.from(noiseTypes) };
}
