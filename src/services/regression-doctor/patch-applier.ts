/**
 * Regression Doctor — turning a proposed patch into a new `steps_json`.
 *
 * Pure and synchronous: steps in, steps out, no DB, no IO. Everything that can
 * go wrong with a patch is decided here, so `apply.service.ts` only has to deal
 * with persistence, concurrency and per-test isolation.
 *
 * The two rules that make a patch actually take effect at replay:
 *
 *  1. **`bindingHints` outrank `description`.** The mobile runner resolves
 *     `bindingHints.label || bindingHints.placeholder || description`
 *     (qait-mobile-runner/src/runner/intent-step-converter.ts:33), and on web the
 *     recorded fingerprint (`text`, `nearText`, `containerTitles`, …) feeds the
 *     locator builder. Rewriting the description while any of that survives
 *     changes nothing at runtime — the step keeps looking for the old element,
 *     now with a description that claims otherwise. So an element patch
 *     REPLACES the hints rather than merging into them.
 *
 *  2. **A stale compiled plan wins over both.** The compiled fast path has no
 *     age or staleness cutoff by design
 *     (qait-mobile-runner/src/runner/compiled-fast-path.ts:99) and validates
 *     against `compiled.fingerprint`, never against the step's current text. A
 *     patched step that keeps its compiled plan is re-run through the old plan
 *     and the fix is silently inert. So `compiled` — and the `evidence` /
 *     `recordedFingerprint` provenance that describes the same stale
 *     resolution — is dropped on every element patch.
 *
 * This is also why the apply path writes `steps_json` directly instead of going
 * through `IntentTestCaseService.update()`: that service's V16 merge re-hydrates
 * `compiled` from the DB for any step that arrives without one
 * (intent-test-case.service.ts:744), which would resurrect exactly the plan we
 * just dropped.
 */

import { randomUUID } from 'crypto';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { StepPatch } from './types';

export class StepNotFoundError extends Error {
  constructor(stepId: string) {
    super(`Step ${stepId} not found in test case`);
    this.name = 'StepNotFoundError';
  }
}

export class UnsupportedPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPatchError';
  }
}

export interface PatchApplication {
  steps: IntentStep[];
  /** Human-readable summary stored on the snapshot and shown in the UI. */
  description: string;
}

/**
 * Locate the step a finding is about.
 *
 * By id, exactly, or not at all. There is deliberately no positional fallback:
 * the same index in a different test case is a different step, and "apply the
 * fix to whatever is at position 4" is how a bulk apply quietly corrupts tests
 * it was never meant to touch. A miss is reported as `no_step_matched` and the
 * user handles that test by hand.
 */
export function locateStepById(steps: IntentStep[], stepId: string): number {
  return steps.findIndex((s) => s?.id === stepId);
}

export function applyStepPatch(
  steps: IntentStep[],
  stepId: string,
  patch: StepPatch,
): PatchApplication {
  const index = locateStepById(steps, stepId);
  if (index < 0) {
    throw new StepNotFoundError(stepId);
  }

  const next = steps.slice();
  const target = next[index];

  switch (patch.action) {
    case 'update_element': {
      if (!patch.description) {
        throw new UnsupportedPatchError('update_element without a description');
      }
      next[index] = withStaleResolutionCleared({
        ...target,
        description: patch.description,
        bindingHints: replaceBindingHints(patch.bindingHints),
      });
      return {
        steps: next,
        description: `Step ${index + 1}: target changed to "${patch.description}"`,
      };
    }

    case 'insert_wait': {
      if (!patch.waitMs) {
        throw new UnsupportedPatchError('insert_wait without waitMs');
      }
      // `timeout`, never `wait`. On mobile the runner maps `wait` to
      // `observe_page` — a re-snapshot that returns as soon as the screen is
      // stable, which is not a pause and does not help an element that simply
      // renders late. `timeout` maps to a real sleep on the runner
      // (intent-step-converter.ts:454) and to `waitForTimeout` on web
      // (intent-step-converter.service.ts:383). Same step type works for both.
      const waitStep: IntentStep = {
        id: randomUUID(),
        type: 'timeout',
        description: `Wait ${patch.waitMs}ms for the screen to settle`,
        value: String(patch.waitMs),
      };
      next.splice(index, 0, waitStep);
      return {
        steps: next,
        description: `Inserted a ${patch.waitMs}ms wait before step ${index + 1}`,
      };
    }

    case 'update_assertion': {
      if (!patch.assertionText) {
        throw new UnsupportedPatchError('update_assertion without assertionText');
      }
      if (target.type !== 'ai_check') {
        // The agent is told this action is ai_check-only. If it proposes one
        // anyway, refuse: overwriting `assertionText` on a click step would
        // write a field nothing reads, and the user would see "applied" for a
        // change with no effect.
        throw new UnsupportedPatchError(
          `update_assertion targets a '${target.type}' step, expected 'ai_check'`,
        );
      }
      next[index] = {
        ...target,
        assertionText: patch.assertionText,
        // The two are mirrored on authored ai_check steps — the description is
        // what the editor's step list shows. Leaving it on the old text makes
        // the timeline disagree with what actually gets checked.
        description: patch.assertionText,
      };
      return {
        steps: next,
        description: `Step ${index + 1}: assertion changed to "${patch.assertionText}"`,
      };
    }

    default: {
      const exhaustive: never = patch.action;
      throw new UnsupportedPatchError(`Unknown patch action: ${String(exhaustive)}`);
    }
  }
}

/**
 * Replace the step's hints with the agent's — the old ones are not merged into
 * the result at all.
 *
 * This looks aggressive and is deliberate. `bindingHints` is a recorded
 * fingerprint of the element as it WAS: on mobile `{role, label}`, on web a
 * dozen fields including `text`, `nearText`, `containerTitles`, `cssClass` and
 * `ancestorSummary`. An `update_element` patch means precisely "that fingerprint
 * no longer describes the target". Keeping any part of it re-asserts the stale
 * copy the resolver reads first, and the patch quietly changes nothing —
 * observed on a real finding, where the agent rewrote the description to
 * "Seedance 2.0" while `nearText` still read "Enhanced Seedance 2.0".
 *
 * What the step loses (a strong `href`, a `testId`) it regains on the next run:
 * with no compiled plan and no hints, resolution falls back to the description
 * against the live page, which is the designed waterfall and is exactly what
 * the agent just rewrote. Losing a locator and re-deriving it beats keeping one
 * that points at something that is no longer there.
 */
function replaceBindingHints(patchHints: StepPatch['bindingHints']): IntentStep['bindingHints'] {
  const next: Record<string, unknown> = {};

  for (const key of ['label', 'placeholder', 'role'] as const) {
    const value = patchHints?.[key];
    if (typeof value === 'string' && value.trim()) {
      next[key] = value.trim();
    }
  }

  return (Object.keys(next).length > 0 ? next : undefined) as IntentStep['bindingHints'];
}

/**
 * Drop every cached resolution artefact from a step whose target just changed.
 *
 * `compiled` is the one that breaks the fix if left behind (see the file
 * header). `evidence` and `recordedFingerprint` never reach the mobile runner
 * at all — the payload builder sends a fixed field list
 * (mobile-step-apply.service.ts:488) — but they are what the editor shows as
 * "last resolved via…", and leaving them describes a resolution that no longer
 * exists.
 */
function withStaleResolutionCleared(step: IntentStep): IntentStep {
  const next = { ...step } as IntentStep & Record<string, unknown>;
  delete next.compiled;
  delete next.evidence;
  delete next.recordedFingerprint;
  return next;
}

/** @internal — exported for unit tests only. */
export const __testing = { replaceBindingHints, withStaleResolutionCleared };
