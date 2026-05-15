/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SecretAdapter — workspace-shared encrypted values
 *
 * For things like Stripe test keys, Twilio sandbox tokens, integration
 * passwords, and any other API key that:
 *   1. Has to be reused across many tests in a workspace.
 *   2. MUST NOT live in plaintext anywhere — DB, screenshots, logs,
 *      step text shown in the editor.
 *
 * Shape:
 *   {
 *     values: {
 *       STRIPE_TEST_KEY: 'sk_test_xxx',
 *       TWILIO_TOKEN:    'tok_yyy',
 *     }
 *   }
 *
 * Why a single `values` blob instead of one envelope key per name:
 *   The base service's `splitSensitive` reads a STATIC list from
 *   `adapter.sensitiveFields()` — it has no way to know which top-level
 *   keys to encrypt for a given row. Wrapping every secret inside a
 *   single `values` object lets us keep the per-row dynamic shape
 *   (any number of named secrets) while still telling the service
 *   "encrypt the `values` field". Decryption restores the JSON object
 *   automatically because `decryptEnvelope` JSON-parses each plain
 *   blob it pulls out.
 *
 * On apply():
 *   For every (name, value) pair, the adapter writes
 *   `secrets.<name>` into `runVariables`. Steps then reference them
 *   via `{{secrets.STRIPE_TEST_KEY}}` and the unified
 *   `resolvePlaceholders` helper substitutes the real value at run time.
 *
 * Logging:
 *   This adapter doesn't log values. The masking that prevents
 *   `{{secrets.X}}` from leaking after substitution lives in the
 *   `redactSecrets` utility, which step-execution code calls before
 *   logging interpolated step bodies.
 *
 * No teardown / no heal / no isFresh — values are static configuration.
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

/** Acceptable scalar — same shape as environment for symmetry. */
type SecretScalar = string | number | boolean;

export interface SecretConfig extends Record<string, unknown> {
  /** All secrets are stored in this single field; the service encrypts it. */
  values: Record<string, SecretScalar>;
}

/** No separate `sensitive` channel — `values` is the sensitive payload. */
export interface SecretSensitive extends Record<string, unknown> {}

// ─────────────────────────────────────────────────────────────────────────────
// Validation rules — strict because malformed names later cause silent
// `{{secrets.foo}}` literals to leak into pages instead of substituting.
// ─────────────────────────────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;
const RESERVED_PREFIXES = ['env.', 'secrets.', 'fixtures.', 'email.'];
const MAX_KEYS = 200;
/**
 * 64 KiB ceiling per value — enough for JWTs, RSA keys in PEM form, and
 * the occasional service-account JSON, but small enough that an
 * accidental file upload doesn't blow past sane DB row sizes. Larger
 * payloads belong in the `file` resource kind (future).
 */
const MAX_VALUE_LENGTH = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const secretAdapter: ResourceAdapter<SecretConfig, SecretSensitive> = {
  kind: 'secret',

  /**
   * Tell the base service to push the entire `values` object into the
   * encrypted envelope. Everything else stays in plaintext config —
   * which, by validate(), means "nothing else".
   */
  sensitiveFields(): string[] {
    return ['values'];
  },

  validate({ config }): ValidationResult {
    const errors: string[] = [];
    const root = (config ?? {}) as Record<string, unknown>;

    // Reject any unknown top-level keys to stop users accidentally
    // leaking metadata into plaintext (e.g. `description: 'prod stripe'`
    // belongs in the resource row's `description` column, not in config).
    const allowedTopKeys = new Set(['values']);
    const extraTopKeys = Object.keys(root).filter((k) => !allowedTopKeys.has(k));
    if (extraTopKeys.length > 0) {
      errors.push(
        `unexpected fields at top level: ${extraTopKeys.join(', ')} (only 'values' is allowed)`,
      );
    }

    const rawValues = root.values;
    if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
      return {
        valid: false,
        errors: ['values must be an object of name → secret pairs'],
      };
    }

    const entries = Object.entries(rawValues as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push('values must contain at least one entry');
    }
    if (entries.length > MAX_KEYS) {
      errors.push(`too many secrets (${entries.length}); max is ${MAX_KEYS}`);
    }

    const normalizedValues: Record<string, SecretScalar> = {};
    const seen = new Set<string>();

    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim();
      if (!key) {
        errors.push('secret name cannot be empty');
        continue;
      }
      if (!KEY_RE.test(key)) {
        errors.push(`invalid secret name "${key}" — use letters, digits, _, -, .`);
        continue;
      }
      const lower = key.toLowerCase();
      if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
        errors.push(
          `secret name "${key}" must not use a reserved prefix (env./secrets./fixtures./email.)`,
        );
        continue;
      }
      if (seen.has(key)) {
        errors.push(`duplicate secret name "${key}"`);
        continue;
      }
      seen.add(key);

      let coerced: SecretScalar;
      if (typeof rawValue === 'string') {
        if (rawValue.length === 0) {
          // Distinguish "delete this entry" (omit it) from "store empty
          // string". An empty secret is almost always a UI bug, so reject
          // it loudly.
          errors.push(`value for "${key}" is empty`);
          continue;
        }
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
        errors.push(
          `value for "${key}" must be string | number | boolean (got ${typeof rawValue})`,
        );
        continue;
      }

      normalizedValues[key] = coerced;
    }

    if (errors.length > 0) {
      return { valid: false, errors: errors.slice(0, 10) };
    }

    return {
      valid: true,
      normalized: {
        config: { values: normalizedValues },
      },
    };
  },

  /**
   * Stamp every secret into runVariables under the `secrets.` prefix.
   * Intentionally never logs values; even the diagnostic line uses just
   * the count + key names so trace files stay safe to share.
   */
  async apply(
    ctx: ApplyContext,
    resource: DecryptedResource<SecretConfig, SecretSensitive>,
  ): Promise<void> {
    // After decryption the service merges `sensitive.values` into
    // `config.values` (because the adapter declared `values` sensitive,
    // splitSensitive pushed it to the envelope, and on read it's
    // restored back to the top of `config`). So the runtime shape we
    // see is `resource.config.values`.
    const values = resource.config?.values;
    if (!values || typeof values !== 'object') {
      logger.warn('[SECRET_ADAPTER] No values to apply', {
        resourceId: resource.id,
        name: resource.name,
      });
      return;
    }

    const names: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      ctx.runVariables.set(`secrets.${key}`, value);
      names.push(key);
    }

    // Names are not secret; values are. Log names only so postmortems
    // can see which secrets were active without recovering them.
    logger.debug('[SECRET_ADAPTER] Applied secrets', {
      resourceId: resource.id,
      name: resource.name,
      secretCount: names.length,
      keys: names,
    });
  },

  /** Static config — nothing expires. */
  isFresh(): boolean {
    return true;
  },
};

/** Convenience boot wiring (mirrors `registerEnvironmentAdapter`). */
export function registerSecretAdapter(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerResourceAdapter } = require('../adapter-registry');
  registerResourceAdapter(secretAdapter);
}
