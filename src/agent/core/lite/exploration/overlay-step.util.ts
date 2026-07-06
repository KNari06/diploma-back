/**
 * Overlay-dismissal → DiscoveredStep mapping (pure).
 *
 * The exploration engine dismisses noise overlays (cookie banners, promo
 * modals, chat widgets) OUT-OF-BAND — directly on the page, not through the
 * executor — so those dismissals were never recorded as steps. On replay the
 * saved test would hit the same overlay with no step to clear it, making the
 * first real action flaky/slow. This helper turns a successful dismissal into a
 * replayable `DiscoveredStep` so the cleanup reproduces deterministically.
 *
 * Reproducibility is the gate: only dismissals we can replay WITHOUT an
 * ephemeral snapshot ref become steps.
 *   - escape  → a `press` step (key only, no selector — always replayable)
 *   - button  → a `click` step ONLY when a durable selector is available
 *               (an ephemeral `eN` ref is dead on a fresh page, so it's dropped)
 *   - click_away / wait → not reproducible as an explicit step → dropped
 *
 * Pure: no Playwright, no I/O — unit-tested without a browser.
 */

import { ESCAPE_KEY, type DismissalAttempt } from './overlay-dismisser';
import { VALID_REF_RE } from '@/agent/core/lite/execution/iframe-ref.util';
import type { DiscoveredStep } from './types';

/**
 * A dismissal captured during a flow, tagged with the page it happened on.
 * The pipeline accumulates these (pre-pipeline + intra-round) and the flow
 * runner converts them to leading steps via {@link dismissalToStep}.
 */
export interface RecordedDismissal {
  attempt: DismissalAttempt;
  pageUrl: string;
}

/**
 * A durable selector is something replay can resolve on a FRESH page — a CSS
 * selector or data-testid, NOT an ephemeral collector ref. `VALID_REF_RE` is
 * the single source for the ephemeral-ref shape (`eN` / `sN` / `ifrN_M`); a ref
 * that matches it is per-collection and dead on replay, so it's not durable.
 */
function isDurableSelector(ref: string | undefined): ref is string {
  const trimmed = ref?.trim();
  return !!trimmed && !VALID_REF_RE.test(trimmed);
}

/**
 * Convert one dismissal attempt into a replayable step, or null when it can't
 * be reproduced as an explicit step. `stepNumber` is assigned by the caller
 * (it owns the final ordering across navigate + dismissals + flow steps).
 */
export function dismissalToStep(
  attempt: DismissalAttempt,
  pageUrl: string,
  stepNumber: number,
): DiscoveredStep | null {
  // Only steps that actually cleared the overlay are worth replaying.
  if (!attempt.dismissed) return null;

  switch (attempt.method) {
    case 'escape':
      return {
        stepNumber,
        description: `Dismiss ${attempt.obstacleType} overlay (press ${ESCAPE_KEY})`,
        action: 'press',
        value: ESCAPE_KEY,
        pageUrl,
        expectedOutcome: 'Overlay is dismissed',
      };

    case 'button':
      // Only replayable if the close control has a durable selector. An
      // ephemeral snapshot ref would resolve to nothing (or worse, the wrong
      // element) on a fresh page — drop it and let replay's reactive overlay
      // handling clear it instead.
      if (!isDurableSelector(attempt.ref)) return null;
      return {
        stepNumber,
        description: `Dismiss ${attempt.obstacleType} overlay (close button)`,
        action: 'click',
        ref: attempt.ref,
        pageUrl,
        expectedOutcome: 'Overlay is dismissed',
      };

    // click_away (a coordinate/elsewhere click) and wait (passive) have no
    // stable, replayable representation as a single step.
    case 'click_away':
    case 'wait':
    default:
      return null;
  }
}

/**
 * Assemble the SELF-CONTAINED step list persisted on a discovered test case:
 *   [navigate to entry URL] + [replayable dismissals] + [flow steps]
 *
 * So a replay reproduces the entry navigation + overlay cleanup that discovery
 * did out-of-band, instead of starting mid-flow and stalling on an overlay.
 * Pure (no I/O) — owns the ordering, the navigate-dedup, the dismissal mapping
 * (drops non-replayable ones), and 1-based contiguous `stepNumber`.
 *
 * The leading navigate is skipped when the URL is unusable OR the flow already
 * starts by navigating to the same URL (the Planner can emit navigate_to) — so
 * we never duplicate the entry navigation.
 */
export function buildSelfContainedSteps(
  entryUrl: string | undefined,
  dismissals: readonly { attempt: DismissalAttempt; pageUrl: string }[],
  flowSteps: readonly DiscoveredStep[],
): DiscoveredStep[] {
  const out: DiscoveredStep[] = [];

  const firstFlowStep = flowSteps[0];
  const flowAlreadyNavigatesToEntry =
    firstFlowStep?.action === 'navigate' && firstFlowStep.value === entryUrl;
  if (entryUrl && entryUrl.trim().length > 0 && !flowAlreadyNavigatesToEntry) {
    out.push({
      stepNumber: 0, // resequenced below
      description: `Navigate to ${entryUrl}`,
      action: 'navigate',
      value: entryUrl,
      pageUrl: entryUrl,
      expectedOutcome: 'Page is loaded',
    });
  }

  for (const { attempt, pageUrl } of dismissals) {
    const step = dismissalToStep(attempt, pageUrl, 0);
    if (step) out.push(step);
  }

  out.push(...flowSteps);

  // Re-sequence stepNumber → 1-based contiguous.
  return out.map((step, i) => ({ ...step, stepNumber: i + 1 }));
}
