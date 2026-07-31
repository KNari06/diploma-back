import { RegressionTestQueryService } from './db/regression-test-query.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import type { VariableSource } from '@/utils/interpolation/resolve-placeholders';
import type { UiStepCountRow } from './credit-estimate.util';

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
   * Resolves same-platform links, then segments the result — the
   * "resolve, then check for a remaining cross-platform segment" pair every
   * dispatch call site needs before it can send steps anywhere. Shared by
   * `RegressionRunService.runSavedTestCase` (dispatches `segments` itself —
   * a same-platform-only test always gets a single "steps" segment, a
   * cross-platform link starts the segmented dispatch-and-poll chain) and
   * `TestExecutionOrchestratorService` (plan/module/flow runs don't support
   * that chain, so it rejects any "link" segment outright). Each caller
   * still does its OWN handling of `segments` — this only dedupes the
   * resolve+segment call pair itself.
   */
  static async resolveAndCheckForCrossPlatform(
    steps: IntentStep[],
    platform: string,
    userId: string,
  ): Promise<{ resolvedSteps: IntentStep[]; segments: ExecutionSegment[] }> {
    const resolvedSteps = await this.resolveSameProlatformLinks(steps, platform, userId);
    const segments = this.segmentByLinks(resolvedSteps);
    return { resolvedSteps, segments };
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

  /**
   * Read-only, count-only mirror of `resolveSameProlatformLinks`, for credit
   * pre-flight estimation (`RegressionRunService.checkCreditBalance`) —
   * NEVER fetches steps to inline, only to count. A `link_test_case` step
   * costs exactly 1 in `steps_json.length`, but at dispatch time a
   * same-platform link inlines the ENTIRE linked test case into the SAME
   * execution (same rate, same billing) — so a link to a 100-step test case
   * is a 100-step charge, not a 1-step one.
   *
   * Fully recursive (as of ADR-0011 update 6) — expands nested same-platform
   * links up to the same `MAX_LINKED_TEST_CASE_DEPTH` the runtime resolver
   * uses, breadth-first, one batched `getUiStepCountRows` call PER DEPTH
   * LEVEL (never per-link — critical-patterns.md #11). Originally scoped to
   * one level deep as a deliberate trade-off; widened because a chain nested
   * 2+ levels was under-estimated at the credit gate while dispatch billed
   * the full expansion — a user with credit for ~2 steps could pass the gate
   * and then be charged for hundreds.
   *
   * Cycle-safe two ways: `visited` stops the BFS from re-fetching (or ever
   * re-adding to the frontier) an id already discovered, so a same-platform
   * cycle can't grow the fetch set unboundedly; `computing` (in
   * `computeEffectiveLength`) stops the bottom-up length computation itself
   * from recursing forever on that same cycle, falling back to counting the
   * repeated occurrence as 1 (the marker). Save-time cycle detection
   * (41b7f025/d53eff49) should mean a real cycle never gets this far — this
   * is defense-in-depth, not the primary guard.
   *
   * Cross-platform links are deliberately NOT expanded here: the linked test
   * case dispatches as its OWN separate, independently billed execution (see
   * link-resolution.service.ts module docs), so folding its cost into THIS
   * total would double-count rather than fix an undercount. Flagged via
   * `hasCrossPlatformLinks` instead, so the caller can log/surface "this
   * estimate may be understated."
   */
  static async expandLinkedStepCounts(
    uiCases: { testCaseId: string; platform?: string | null }[],
    rows: UiStepCountRow[],
  ): Promise<{ expandedLengthById: Map<string, number>; hasCrossPlatformLinks: boolean }> {
    const platformByCaseId = new Map(uiCases.map((tc) => [tc.testCaseId, tc.platform || 'web']));
    let hasCrossPlatformLinks = false;

    // Accumulates every row discovered across all BFS levels (top-level rows
    // + every same-platform linked case reachable within the depth cap),
    // keyed by id, so the bottom-up pass below can resolve any link target in
    // O(1) without re-fetching. `visited` doubles as the fetch-dedup set —
    // once an id is in it, it's never added to a future frontier, which is
    // what makes a same-platform cycle terminate the BFS instead of growing
    // it forever.
    const rowById = new Map<string, UiStepCountRow>(rows.map((r) => [r.id, r]));
    const visited = new Set<string>(rows.map((r) => r.id));

    let frontier = rows;
    let depth = 0;
    while (frontier.length > 0) {
      const nextIds = new Set<string>();
      for (const row of frontier) {
        if (!Array.isArray(row.steps_json)) continue;
        // Top-level rows get their platform from the caller (`uiCases`);
        // rows discovered deeper in the BFS have no entry there, so fall
        // back to the row's own `platform` column.
        const platform = platformByCaseId.get(row.id) ?? row.platform ?? 'web';
        for (const step of row.steps_json as IntentStep[]) {
          const link = getLinkOptions(step);
          if (!link?.linkedTestCaseId) continue;
          if (link.linkedPlatform === platform) {
            if (!visited.has(link.linkedTestCaseId)) nextIds.add(link.linkedTestCaseId);
          } else {
            hasCrossPlatformLinks = true;
          }
        }
      }

      if (nextIds.size === 0) break;

      if (depth >= MAX_LINKED_TEST_CASE_DEPTH) {
        throw new ValidationError(
          `Linked test case chain exceeds max depth (${MAX_LINKED_TEST_CASE_DEPTH}) — check for an unintended long chain`,
        );
      }

      for (const id of nextIds) visited.add(id);
      const nextRows = await RegressionTestQueryService.getUiStepCountRows([...nextIds]);
      for (const r of nextRows) rowById.set(r.id, r);
      frontier = nextRows;
      depth += 1;
    }

    // Bottom-up, memoized: a row's effective length is its own step count
    // with each same-platform link replaced by ITS effective length
    // (recursively) — everything else (cross-platform marker, a link whose
    // target vanished or fell outside the depth cap, or a cycle caught by
    // `computing`) counts as 1, matching the marker-itself fallback the
    // original one-level version already used.
    const effectiveLengthById = new Map<string, number>();
    const computing = new Set<string>();
    const computeEffectiveLength = (id: string): number => {
      const cached = effectiveLengthById.get(id);
      if (cached !== undefined) return cached;

      const row = rowById.get(id);
      if (!row || !Array.isArray(row.steps_json)) {
        const len = 0;
        effectiveLengthById.set(id, len);
        return len;
      }

      if (computing.has(id)) {
        // Cycle encountered mid-computation — count this occurrence as the
        // marker itself rather than recursing forever. Does not memoize
        // (the real, non-cyclic length for `id` is still being computed by
        // the outer call on the stack).
        return 1;
      }
      computing.add(id);

      const platform = platformByCaseId.get(id) ?? row.platform ?? 'web';
      let total = 0;
      for (const step of row.steps_json as IntentStep[]) {
        // Author-disabled steps are dropped before dispatch and never billed,
        // so they must not inflate the estimate — including a disabled
        // `link_test_case` marker, which would otherwise pull in the whole
        // linked case's step count.
        if (step?.options?.enabled === false) continue;
        const link = getLinkOptions(step);
        if (link?.linkedTestCaseId && link.linkedPlatform === platform && rowById.has(link.linkedTestCaseId)) {
          total += computeEffectiveLength(link.linkedTestCaseId);
        } else {
          // Fall back to 1 (the marker itself) for a cross-platform link, a
          // linked case that vanished after the link was created
          // (getUiStepCountRows just omits missing ids, it doesn't error),
          // or one the depth cap stopped short of fetching.
          total += 1;
        }
      }

      computing.delete(id);
      effectiveLengthById.set(id, total);
      return total;
    };

    const expandedLengthById = new Map<string, number>();
    for (const row of rows) {
      if (!Array.isArray(row.steps_json)) continue;
      expandedLengthById.set(row.id, computeEffectiveLength(row.id));
    }

    return { expandedLengthById, hasCrossPlatformLinks };
  }
}
