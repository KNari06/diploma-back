/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DataFixtureAdapter — workspace-shared test data
 *
 * Phase 4 Step 3 (May 2026). Models a named **data fixture** ("Sample User
 * Profile", "Demo Cart") — a plaintext map of arbitrary keys used as
 * deterministic test data:
 *
 *   { data: { USER_EMAIL: 'demo@x.com', USER_PHONE: '+7700...', CART_QTY: 3 } }
 *
 * `apply()` writes each entry into `runVariables` under the `fixtures.` prefix:
 *
 *   runVariables.set('fixtures.USER_EMAIL', 'demo@x.com')
 *
 * Steps reference them via `{{fixtures.USER_EMAIL}}` through the unified
 * `resolvePlaceholders` helper.
 *
 * Design choices (slice 1):
 *   - **Plaintext only.** No `sensitive` field. If a value should be a
 *     credential, use the `secret` adapter — that's exactly what it's for.
 *     Defer "sensitive fixture row" until a real use-case shows up.
 *   - **No recursive interpolation.** `data.A = '{{fixtures.B}}'` is treated
 *     as a literal string. Documented as unsupported; not silently broken.
 *   - **Flat key/value only** (string | number | boolean). Nested objects /
 *     arrays would force us to invent path syntax for `{{...}}`. Keep it
 *     boring; users with structured data can stringify JSON themselves.
 *   - **No TTL.** Static data, always fresh.
 *
 * Quotas mirror `environment`, except `MAX_VALUE_LENGTH = 16384` (16 KB) —
 * fixtures often hold long-form strings (sample addresses, IDs, etc.).
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

type FixtureScalar = string | number | boolean;

export interface DataFixtureConfig extends Record<string, unknown> {
  /** Map of fixture key → value. Names follow the rules in `KEY_RE`. */
  data: Record<string, FixtureScalar>;
}

/** Empty by design — fixtures are plaintext in slice 1. */
export interface DataFixtureSensitive extends Record<string, unknown> {}

/** Same constraint as `environment`. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/** Names whose `<prefix>.` form is owned by other adapters / sources. */
const RESERVED_PREFIXES = ['env.', 'secrets.', 'fixtures.', 'email.'];

const MAX_KEYS = 200;
/** 16 KB — fixtures may carry long-form sample text (addresses, JSON-as-string). */
const MAX_VALUE_LENGTH = 16384;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const dataFixtureAdapter: ResourceAdapter<DataFixtureConfig, DataFixtureSensitive> = {
  kind: 'data_fixture',

  sensitiveFields(): string[] {
    return [];
  },

  validate({ config }): ValidationResult {
    const errors: string[] = [];
    const root = (config ?? {}) as Record<string, unknown>;
    const rawData = root.data;

    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      return {
        valid: false,
        errors: ['data must be an object of name → value pairs'],
      };
    }

    const entries = Object.entries(rawData as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push('data must contain at least one entry');
    }
    if (entries.length > MAX_KEYS) {
      errors.push(`too many fixture keys (${entries.length}); max is ${MAX_KEYS}`);
    }

    const normalizedData: Record<string, FixtureScalar> = {};
    const seen = new Set<string>();

    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim();
      if (!key) {
        errors.push('fixture key cannot be empty');
        continue;
      }
      if (!KEY_RE.test(key)) {
        errors.push(`invalid fixture key "${key}" — use letters, digits, _, -, .`);
        continue;
      }
      const lower = key.toLowerCase();
      if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
        errors.push(`fixture key "${key}" must not use a reserved prefix (env./secrets./fixtures./email.)`);
        continue;
      }
      if (seen.has(key)) {
        errors.push(`duplicate fixture key "${key}"`);
        continue;
      }
      seen.add(key);

      let coerced: FixtureScalar;
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

      normalizedData[key] = coerced;
    }

    if (errors.length > 0) {
      return { valid: false, errors: errors.slice(0, 10) };
    }

    return {
      valid: true,
      normalized: {
        config: { data: normalizedData },
      },
    };
  },

  /**
   * Stamps each fixture entry into `runVariables` under the `fixtures.` prefix.
   * Idempotent — re-applying just overwrites the same keys. No recursive
   * interpolation: values are written as-is.
   */
  async apply(ctx: ApplyContext, resource: DecryptedResource<DataFixtureConfig, DataFixtureSensitive>): Promise<void> {
    const data = resource.config?.data;
    if (!data || typeof data !== 'object') {
      logger.warn('[DATA_FIXTURE_ADAPTER] No data to apply', {
        resourceId: resource.id,
        name: resource.name,
      });
      return;
    }

    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      ctx.runVariables.set(`fixtures.${key}`, value);
      count++;
    }

    logger.debug('[DATA_FIXTURE_ADAPTER] Applied data fixture', {
      resourceId: resource.id,
      name: resource.name,
      fixtureKeyCount: count,
    });
  },

  /** Always fresh — no TTL semantic for static data. */
  isFresh(): boolean {
    return true;
  },
};

/** Convenience boot wiring (mirrors other adapters). */
export function registerDataFixtureAdapter(): void {
  // Lazy import to avoid a circular module-eval ordering with the registry.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerResourceAdapter } = require('../adapter-registry');
  registerResourceAdapter(dataFixtureAdapter);
}
