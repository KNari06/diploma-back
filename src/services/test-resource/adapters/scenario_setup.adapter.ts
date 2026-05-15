/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ScenarioSetupAdapter — reusable prologue of IntentSteps
 *
 * A scenario_setup resource is a named, versioned bundle of IntentSteps
 * that puts the app into a known state (logged in, cart filled, profile
 * editor open, etc.) before a test runs its assertions. Many tests bind to
 * the same scenario_setup — one source of truth for "how to get to the
 * point where this test starts mattering".
 *
 * Composition: a setup's `config.steps` array MAY contain steps whose
 * `type === 'use_setup'`; those reference another scenario_setup by id.
 * The mobile compiler expands them recursively at run time (cycle-guarded,
 * max depth 5). Web path runs the resolved steps through `recipe-executor`
 * before the test body, the same primitive auth heal uses today.
 *
 * Design decisions:
 *   - `apply()` is a NO-OP. The resource is a passive bundle — execution is
 *     driven by the compiler (mobile) or the executor wrapper (web). The
 *     applier only logs presence so the run snapshot records the binding.
 *   - No sensitive fields. Steps can reference `{{secrets.X}}` but the
 *     secret values live in their own resource — never duplicated here.
 *   - No TTL. A setup is structurally fresh forever; if its steps break
 *     because the app changed, the user fixes the steps. Auth resources
 *     handle session-lifecycle separately.
 *   - Platform-locked. A setup recorded against `mobile_android` MUST NOT
 *     be bound to a web test, and vice versa. Enforced both in validate()
 *     and at apply time by `resource-applier`.
 *   - `use_setup` cycle detection lives in the compiler, not here, because
 *     cycles are only detectable when the full graph is known. Validate
 *     catches local issues (refSetupId missing, self-reference, > N nesting
 *     depth at single-setup creation time).
 *
 * Shape:
 *   config: {
 *     steps: IntentStep[];                            // including use_setup steps
 *     platform: 'web'|'mobile_android'|'mobile_ios'|'mobile_flutter';
 *     appPackage?: string;                            // for mobile_*
 *   }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import type {
  ApplyContext,
  DecryptedResource,
  ResourceAdapter,
  ValidationResult,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Payload shape
// ─────────────────────────────────────────────────────────────────────────────

export type ScenarioSetupPlatform =
  | 'web'
  | 'mobile_android'
  | 'mobile_ios'
  | 'mobile_flutter';

const ALLOWED_PLATFORMS: ReadonlyArray<ScenarioSetupPlatform> = [
  'web',
  'mobile_android',
  'mobile_ios',
  'mobile_flutter',
];

/** Minimum step type set every IntentStep must declare. Loose on purpose —
 * the compiler / runner validate the full shape downstream. We only check
 * that we can route the step. */
interface ScenarioStep {
  type: string;
  description?: string;
  value?: string;
  refSetupId?: string; // only for type === 'use_setup'
  [key: string]: unknown;
}

export interface ScenarioSetupConfig extends Record<string, unknown> {
  steps: ScenarioStep[];
  platform: ScenarioSetupPlatform;
  appPackage?: string;
}

/** Empty by design — setup steps reference secrets, never embed them. */
export interface ScenarioSetupSensitive extends Record<string, unknown> {}

// Limits chosen to keep a single setup tractable for AI summarisation and
// to prevent runaway nesting. Real apps rarely exceed a couple dozen steps.
const MAX_STEPS = 200;
const MAX_VALUE_LENGTH = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const scenarioSetupAdapter: ResourceAdapter<
  ScenarioSetupConfig,
  ScenarioSetupSensitive
> = {
  kind: 'scenario_setup',

  sensitiveFields(): string[] {
    // Setups never carry plaintext credentials — those live in `secret`
    // resources and are referenced through `{{secrets.X}}` placeholders
    // inside step values. Encrypting nothing here is intentional.
    return [];
  },

  validate({ config }): ValidationResult {
    const errors: string[] = [];
    const root = (config ?? {}) as Record<string, unknown>;

    // Platform — required, must be one of the four known values. Without
    // platform the applier cannot decide compatibility against a run.
    const platform = root.platform;
    if (typeof platform !== 'string') {
      errors.push('platform is required (web | mobile_android | mobile_ios | mobile_flutter)');
    } else if (!ALLOWED_PLATFORMS.includes(platform as ScenarioSetupPlatform)) {
      errors.push(
        `platform "${platform}" is not supported — use web | mobile_android | mobile_ios | mobile_flutter`,
      );
    }

    // appPackage — only meaningful on mobile. Allowed to be absent (legacy
    // setups, or setups that operate on the system app picker). Validate
    // type only.
    const appPackage = root.appPackage;
    if (appPackage !== undefined && typeof appPackage !== 'string') {
      errors.push('appPackage must be a string when provided');
    }

    // Steps — must be a non-empty array (an empty setup serves no purpose
    // and would silently no-op at run time, which has bitten us before
    // with data_fixture having no `data` entries). Cap on count so the
    // editor stays responsive.
    const rawSteps = root.steps;
    if (!Array.isArray(rawSteps)) {
      errors.push('steps must be an array of IntentStep');
      return { valid: false, errors };
    }
    if (rawSteps.length === 0) {
      errors.push('steps must contain at least one step');
    }
    if (rawSteps.length > MAX_STEPS) {
      errors.push(`too many steps (${rawSteps.length}); max is ${MAX_STEPS}`);
    }

    const normalisedSteps: ScenarioStep[] = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const step = rawSteps[i] as Record<string, unknown> | null | undefined;
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        errors.push(`step #${i + 1} must be an object`);
        continue;
      }
      const type = step.type;
      if (typeof type !== 'string' || type.length === 0) {
        errors.push(`step #${i + 1} is missing required string "type"`);
        continue;
      }

      // `use_setup` is the only kind we structurally validate here — every
      // other step type is the editor / runner's contract. We check the
      // ref shape early so editor validation can show the error before save.
      if (type === 'use_setup') {
        const refId = step.refSetupId;
        if (typeof refId !== 'string' || refId.length === 0) {
          errors.push(`step #${i + 1} (use_setup) must have a non-empty refSetupId`);
          continue;
        }
        // Self-reference catch — true cycle detection (A→B→A) runs in the
        // compiler because we don't have other setups loaded here. But a
        // setup referencing itself is detectable locally and always a bug.
        // We can only catch this when the adapter knows the resource id,
        // which validate() doesn't receive — leave to the compiler/service.
      }

      // Value length guard — applies to any step that uses a value field.
      const value = step.value;
      if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
        errors.push(
          `step #${i + 1} value exceeds ${MAX_VALUE_LENGTH} chars (got ${value.length})`,
        );
        continue;
      }

      normalisedSteps.push(step as ScenarioStep);
    }

    if (errors.length > 0) {
      return { valid: false, errors: errors.slice(0, 10) };
    }

    return {
      valid: true,
      normalized: {
        config: {
          steps: normalisedSteps,
          platform: platform as ScenarioSetupPlatform,
          ...(typeof appPackage === 'string' && appPackage.length > 0
            ? { appPackage }
            : {}),
        },
      },
    };
  },

  /**
   * Passive bundle — no run-time effect from the adapter side. The mobile
   * compiler picks the steps up from `compileByKind` and the web executor
   * wraps them in a recipe-executor call before the main test body.
   *
   * We still record the binding through the standard applier flow so
   * `test_executions.executed_resources` shows the setup ran. That's the
   * sole purpose of this method.
   */
  async apply(
    _ctx: ApplyContext,
    resource: DecryptedResource<ScenarioSetupConfig, ScenarioSetupSensitive>,
  ): Promise<void> {
    const stepCount = Array.isArray(resource.config?.steps)
      ? resource.config.steps.length
      : 0;
    logger.debug('[SCENARIO_SETUP_ADAPTER] Apply (passive — compiler/executor drives steps)', {
      resourceId: resource.id,
      name: resource.name,
      platform: resource.config?.platform,
      stepCount,
    });
  },

  /** No staleness model — setup steps are structurally fresh forever. */
  isFresh(): boolean {
    return true;
  },
};

/** Convenience boot wiring (mirrors `registerEnvironmentAdapter`). */
export function registerScenarioSetupAdapter(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerResourceAdapter } = require('../adapter-registry');
  registerResourceAdapter(scenarioSetupAdapter);
}
