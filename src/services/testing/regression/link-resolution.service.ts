import { RegressionTestQueryService } from './db/regression-test-query.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import type { VariableSource } from '@/utils/interpolation/resolve-placeholders';

/**
 * A VariableSource for a namespaced map (`<prefix>.<key>` → value) — shared
 * shape for both directions of link_test_case variable passing:
 *   - `link_input.<targetParam>` inside the LINKED test's own steps
 *     (inputBindings, resolved against the parent's scope before dispatch)
 *   - `link.<alias>` inside the PARENT's later steps (outputBindings,
 *     resolved from the linked run's final captured state after it completes)
 */
export function namespacedMapSource(prefix: string, values: Map<string, string>): VariableSource {
  const fullPrefix = `${prefix}.`;
  return {
    name: prefix,
    lookup: (key: string) => {
      if (!key.startsWith(fullPrefix)) return undefined;
      const shortKey = key.slice(fullPrefix.length);
      return values.has(shortKey) ? values.get(shortKey) : undefined;
    },
  };
}

/**
 * Resolves `link_test_case` steps before dispatch.
 *
 * Two edge shapes, same source (a step's `options.linkTestCase`):
 *   - Same platform as the step's own test case → inlined (recursively) at
 *     its exact position, same as how `collectPreconditionSteps` inlines a
 *     dependsOn precondition as a prefix — just generalized to splice
 *     anywhere, not only at the start.
 *   - Different platform → left as a marker. `segmentByLinks` then splits
 *     the (already same-platform-resolved) array into ordered segments so
 *     the caller can dispatch each "steps" segment normally and run each
 *     "link" segment as its own nested, awaited sub-dispatch (see
 *     linked-test-case-runner.service.ts). The runner never sees this step
 *     type either way — it's fully resolved here, before any dispatch payload
 *     is built.
 */

export const MAX_LINKED_TEST_CASE_DEPTH = 5;

export interface StepsSegment {
  kind: 'steps';
  steps: IntentStep[];
}

export interface LinkSegment {
  kind: 'link';
  step: IntentStep;
}

export type ExecutionSegment = StepsSegment | LinkSegment;

function getLinkOptions(step: IntentStep) {
  return step.type === 'link_test_case' ? step.options?.linkTestCase : undefined;
}

export class LinkResolutionService {
  /**
   * Recursively inlines same-platform `link_test_case` steps. Leaves
   * cross-platform ones untouched for `segmentByLinks`. Namespaces inlined
   * step ids (`link_<sourceId>_<originalId>`) so they can never collide with
   * the parent's own ids — same convention `collectPreconditionSteps` uses
   * for `pre_<sourceId>_<originalId>`.
   */
  static async resolveSameProlatformLinks(
    steps: IntentStep[],
    currentPlatform: string,
    userId: string,
    depth = 0,
  ): Promise<IntentStep[]> {
    if (depth > MAX_LINKED_TEST_CASE_DEPTH) {
      throw new ValidationError(
        `Linked test case chain exceeds max depth (${MAX_LINKED_TEST_CASE_DEPTH}) — check for an unintended long chain`,
      );
    }

    const resolved: IntentStep[] = [];
    for (const step of steps) {
      const link = getLinkOptions(step);
      if (!link) {
        resolved.push(step);
        continue;
      }

      if (!link.linkedTestCaseId) {
        throw new ValidationError(
          `Link Test Case step "${step.id}" has no linked test case selected — pick one before running.`,
        );
      }

      if (link.linkedPlatform !== currentPlatform) {
        // Cross-platform — leave as a marker for segmentByLinks.
        resolved.push(step);
        continue;
      }

      // getSavedTestCase enforces the same project/owner access check a
      // normal run already relies on — a link can't reach a test case the
      // dispatching user doesn't own.
      const linked = await RegressionTestQueryService.getSavedTestCase(link.linkedTestCaseId, userId);

      const linkedOwnSteps = ((linked.steps_json as IntentStep[]) || []);
      const recursivelyResolved = await this.resolveSameProlatformLinks(
        linkedOwnSteps,
        currentPlatform,
        userId,
        depth + 1,
      );

      logger.info('[LINK_RESOLUTION] Inlined same-platform linked test case', {
        parentStepId: step.id,
        linkedTestCaseId: link.linkedTestCaseId,
        linkedSteps: recursivelyResolved.length,
        depth,
      });

      const namespaced = recursivelyResolved.map((s) => ({
        ...s,
        id: `link_${link.linkedTestCaseId}_${s.id}`,
        _preconditionSource: s._preconditionSource, // preserve if the linked case itself had preconditions inlined
      }));

      resolved.push(...namespaced);
    }
    return resolved;
  }

  /**
   * Splits a (same-platform-already-resolved) step array into ordered
   * segments at any remaining `link_test_case` markers — these are, by
   * construction, all cross-platform. Consecutive non-link steps merge into
   * one `steps` segment, so a test with no cross-platform links produces
   * exactly one segment (the common case — unchanged dispatch behavior).
   */
  static segmentByLinks(steps: IntentStep[]): ExecutionSegment[] {
    const segments: ExecutionSegment[] = [];
    let current: IntentStep[] = [];

    for (const step of steps) {
      const link = getLinkOptions(step);
      if (link) {
        if (current.length > 0) {
          segments.push({ kind: 'steps', steps: current });
          current = [];
        }
        segments.push({ kind: 'link', step });
      } else {
        current.push(step);
      }
    }
    if (current.length > 0) {
      segments.push({ kind: 'steps', steps: current });
    }
    return segments;
  }
}
