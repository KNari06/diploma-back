/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EnvironmentAdapter — workspace-shared variables (no secrets)
 *
 * First non-auth adapter. Models a named environment ("Staging", "Prod")
 * exposing public configuration that users want to share across many
 * tests in a workspace:
 *
 *   { variables: { BASE_URL: 'https://stg.app.com', FEATURE_X: 'true' } }
 *
 * `apply()` writes each entry into `runVariables` under the `env.` prefix:
 *
 *   runVariables.set('env.BASE_URL', 'https://stg.app.com')
 *
 * which lets steps reference them via `{{env.BASE_URL}}` once the unified
 * `resolvePlaceholders` helper consults `runVariables` (it does, see
 * test-executor.ts and preview-step-apply.ts).
 *
 * Design choices:
 *   - All values are non-secret. This adapter intentionally has zero
 *     sensitive fields. Anything credential-shaped goes in the `secret`
 *     adapter (next phase). We don't even quietly accept passwords here.
 *   - Keys are validated to a conservative shape so users can't shadow
 *     reserved namespaces (`env.` is reserved for our own prefix; we
 *     also reject `secrets.`, `fixtures.`, `email.` to avoid confusion
 *     between source and consumer).
 *   - No teardown: variables live in the run-scoped Map and disappear
 *     when the run ends. No external state to revert.
 *   - Always fresh: there is no TTL semantic for static config.
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

/**
 * Permissible scalar value. We coerce numbers and booleans to strings at
 * apply time so `{{env.FEATURE_X}}` always produces a string substitution.
 */
type EnvScalar = string | number | boolean;

export interface EnvironmentConfig extends Record<string, unknown> {
  /** Map of variable name → value. Names follow the rules in `KEY_RE`. */
  variables: Record<string, EnvScalar>;
}

/** Empty by design — environment is plaintext public config. */
export interface EnvironmentSensitive extends Record<string, unknown> {}

/**
 * Variable key constraint. Allows uppercase / lowercase / digit / underscore
 * / hyphen / dot, must start with a letter or underscore. We pick a strict
 * shape rather than letting users put arbitrary characters in because:
 *   - Resolvers match `[\w.\-]+` between `{{ }}`. Arbitrary characters
 *     would silently fail to resolve.
 *   - Quoting / shell-like interpolation would be a footgun.
 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/** Names whose `<prefix>.` form is owned by other adapters / sources. */
const RESERVED_PREFIXES = ['env.', 'secrets.', 'fixtures.', 'email.'];

const MAX_KEYS = 200;
const MAX_VALUE_LENGTH = 4096;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const environmentAdapter: ResourceAdapter<EnvironmentConfig, EnvironmentSensitive> = {
  kind: 'environment',

  sensitiveFields(): string[] {
    return [];
  },

  validate({ config }): ValidationResult {
    const errors: string[] = [];
    const root = (config ?? {}) as Record<string, unknown>;
    const rawVars = root.variables;

    if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars)) {
      return {
        valid: false,
        errors: ['variables must be an object of name → value pairs'],
      };
    }

    const entries = Object.entries(rawVars as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push('variables must contain at least one entry');
    }
    if (entries.length > MAX_KEYS) {
      errors.push(`too many variables (${entries.length}); max is ${MAX_KEYS}`);
    }

    const normalizedVars: Record<string, EnvScalar> = {};
    const seen = new Set<string>();

    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim();
      if (!key) {
        errors.push('variable name cannot be empty');
        continue;
      }
      if (!KEY_RE.test(key)) {
        errors.push(`invalid variable name "${key}" — use letters, digits, _, -, .`);
        continue;
      }
      // Reject if user wrote `env.X` themselves; the prefix is added by
      // the adapter at apply time (so a single `BASE_URL` always becomes
      // `env.BASE_URL`, never `env.env.BASE_URL`).
      const lower = key.toLowerCase();
      if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
        errors.push(`variable name "${key}" must not use a reserved prefix (env./secrets./fixtures./email.)`);
        continue;
      }
      if (seen.has(key)) {
        errors.push(`duplicate variable name "${key}"`);
        continue;
      }
      seen.add(key);

      let coerced: EnvScalar;
      if (typeof rawValue === 'string') {
        if (rawValue.length > MAX_VALUE_LENGTH) {
          errors.push(`value for "${key}" exceeds ${MAX_VALUE_LENGTH} chars`);
          continue;
        }
        coerced = rawValue;
      } else if (typeof rawValue === 'number') {
        if (!Number.isFinite(rawValue)) {
          errors.push(`value for "${key}" must be a finite number`);
          continue;
        }
        coerced = rawValue;
      } else if (typeof rawValue === 'boolean') {
        coerced = rawValue;
      } else {
        errors.push(`value for "${key}" must be string | number | boolean (got ${typeof rawValue})`);
        continue;
      }

      normalizedVars[key] = coerced;
    }

    if (errors.length > 0) {
      return { valid: false, errors: errors.slice(0, 10) };
    }

    return {
      valid: true,
      normalized: {
        config: { variables: normalizedVars },
      },
    };
  },

  /**
   * Stamps each variable into `runVariables` under the `env.` prefix.
   * Idempotent — re-applying just overwrites the same keys.
   */
  async apply(ctx: ApplyContext, resource: DecryptedResource<EnvironmentConfig, EnvironmentSensitive>): Promise<void> {
    const variables = resource.config?.variables;
    if (!variables || typeof variables !== 'object') {
      logger.warn('[ENVIRONMENT_ADAPTER] No variables to apply', {
        resourceId: resource.id,
        name: resource.name,
      });
      return;
    }

    let count = 0;
    for (const [key, value] of Object.entries(variables)) {
      ctx.runVariables.set(`env.${key}`, value);
      count++;
    }

    logger.debug('[ENVIRONMENT_ADAPTER] Applied environment', {
      resourceId: resource.id,
      name: resource.name,
      variableCount: count,
    });
  },

  /** Always fresh — no TTL semantic for static config. */
  isFresh(): boolean {
    return true;
  },
};

/** Convenience boot wiring (mirrors `registerAuthAdapter`). */
export function registerEnvironmentAdapter(): void {
  // Lazy import to avoid a circular module-eval ordering with the registry.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerResourceAdapter } = require('../adapter-registry');
  registerResourceAdapter(environmentAdapter);
}
