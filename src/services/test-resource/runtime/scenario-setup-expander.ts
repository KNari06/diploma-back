/**
 * ═══════════════════════════════════════════════════════════════════════════
 * scenario-setup-expander — recursive `use_setup` step expander
 *
 * Shared between the mobile compiler (`resource-step-compiler.service.ts`)
 * and the web runner (`scenario-setup-runner.ts`). Walks a scenario_setup
 * resource's `config.steps`, replacing every step with `type === 'use_setup'`
 * by the steps of the resource it references — recursively, with cycle
 * detection and a hard depth cap.
 *
 * The function returns a FLAT array of step objects suitable to be:
 *   - passed through `normaliseRecipeStep` and prepended to mobile run
 *     (the mobile compiler's path); or
 *   - converted to PlaywrightCommands and executed on web (the web
 *     runner's path).
 *
 * Failure modes are all `throw` — callers decide whether to abort the
 * run (`required: true`) or soft-skip (`required: false`).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { loadDecrypted } from '../test-resource.service';
import type { DecryptedResource } from '../types';

/**
 * Cycle / depth guards for nested setup expansion. Real-world test suites
 * very rarely exceed 2-3 levels; the cap exists to stop pathological
 * misconfiguration and runaway LLM-generated graphs, not to constrain
 * legitimate usage. Bump if Slice 3 telemetry shows users hitting it.
 */
export const MAX_SETUP_NESTING_DEPTH = 5;

/**
 * Recursively walk a scenario_setup's `config.steps`, replacing every
 * `use_setup` step with the steps of the referenced setup.
 *
 * Cycle detection: `visiting` is the *call stack* of setup ids — if we
 * try to enter a setup we're already mid-walking, it's a cycle. (A setup
 * appearing twice on independent branches is fine: the duplicate would
 * just run twice, which can be wasteful but isn't a bug.)
 */
export async function expandScenarioSetupRecursively(
  resource: DecryptedResource,
  userId: string,
  visiting: Set<string>,
  depth: number,
): Promise<unknown[]> {
  if (depth > MAX_SETUP_NESTING_DEPTH) {
    throw new Error(
      `scenario_setup nesting depth ${depth} exceeds max ${MAX_SETUP_NESTING_DEPTH} (resource "${resource.name}")`,
    );
  }
  if (visiting.has(resource.id)) {
    const trail = Array.from(visiting).join(' → ') + ` → ${resource.id}`;
    throw new Error(`scenario_setup cycle detected: ${trail}`);
  }

  const config = (resource.config ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(config.steps) ? config.steps : [];
  const flat: unknown[] = [];
  const nextVisiting = new Set(visiting);
  nextVisiting.add(resource.id);

  for (const raw of rawSteps) {
    const step = (raw ?? {}) as Record<string, unknown>;
    if (step.type !== 'use_setup') {
      flat.push(step);
      continue;
    }
    const refId = typeof step.refSetupId === 'string' ? step.refSetupId : '';
    if (!refId) {
      throw new Error(
        `scenario_setup "${resource.name}" has a use_setup step with empty refSetupId`,
      );
    }
    const nested = await loadDecrypted(refId, userId).catch(() => null);
    if (!nested) {
      throw new Error(
        `scenario_setup "${resource.name}" references unknown setup ${refId}`,
      );
    }
    if (nested.kind !== 'scenario_setup') {
      throw new Error(
        `scenario_setup "${resource.name}" references resource ${refId} of kind "${nested.kind}" (must be scenario_setup)`,
      );
    }
    const nestedFlat = await expandScenarioSetupRecursively(
      nested,
      userId,
      nextVisiting,
      depth + 1,
    );
    flat.push(...nestedFlat);
  }

  return flat;
}
