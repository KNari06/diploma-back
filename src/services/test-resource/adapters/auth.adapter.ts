/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AuthAdapter — the "Login" resource
 *
 * First implementation of ResourceAdapter. Owns:
 *   - Validation of Playwright storageState (cookies + localStorage)
 *   - Applying cached state to a browser context before the first step
 *   - Capturing fresh state from a live context (preview "save login" flow)
 *   - Healing: replay the login recipe IN THE SAME context when session
 *     is lost mid-run, then hand new state back to the service.
 *
 * What was previously `auth-profile.service.ts` is now split:
 *   - generic CRUD / encryption / defaults → TestResourceService
 *   - auth-specific shape + browser wiring → this file
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import {
  validateAuthFixture,
  type AuthFixture,
} from '@/agent/core/lite/exploration/auth-fixture';
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
 * Non-sensitive auth config. TTL / refresh live on the base row; this is
 * auth-specific knobs only.
 */
export interface AuthConfig extends Record<string, unknown> {
  /** Canonical AuthFixture is the only stored secret — nothing here yet. */
}

/** Encrypted side of the envelope. */
export interface AuthSensitive extends Record<string, unknown> {
  /**
   * Playwright storageState blob (cookies + origins[].localStorage).
   * Stored as an AuthFixture so validation/normalization is deterministic.
   */
  storageState?: AuthFixture;

  /**
   * Optional TOTP secret in `otpauth://` or bare-base32 form. Present only
   * when the user set up 2FA when creating the profile.
   */
  totpSecret?: string;
}

export const AUTH_SENSITIVE_FIELDS: Array<keyof AuthSensitive> = [
  'storageState',
  'totpSecret',
];

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const authAdapter: ResourceAdapter<AuthConfig, AuthSensitive> = {
  kind: 'auth',

  sensitiveFields(): string[] {
    return AUTH_SENSITIVE_FIELDS as string[];
  },

  /**
   * Validate a merged (config + sensitive) payload. storageState is the
   * only shape we strictly check — everything else is optional metadata.
   */
  validate({ config }): ValidationResult {
    const errors: string[] = [];
    const merged = (config ?? {}) as Record<string, unknown>;

    let normalizedStorageState: AuthFixture | undefined;
    if (merged.storageState !== undefined && merged.storageState !== null) {
      const v = validateAuthFixture(merged.storageState);
      if (!v.valid || !v.fixture) {
        errors.push(...(v.errors ?? ['Invalid storageState']).slice(0, 3));
      } else {
        normalizedStorageState = v.fixture;
      }
    }

    if (merged.totpSecret !== undefined && typeof merged.totpSecret !== 'string') {
      errors.push('totpSecret must be a string');
    }

    if (errors.length > 0) return { valid: false, errors };

    const normalized: Record<string, unknown> = { ...merged };
    if (normalizedStorageState) normalized.storageState = normalizedStorageState;

    return { valid: true, normalized: { config: normalized } };
  },

  /**
   * Inject cached login state into the live browser context. Cookies go
   * via `addCookies()`; localStorage via an in-page `evaluate()` after a
   * navigation to the origin. The caller (test-executor) does its own
   * `navigateToUrl(testUrl)` AFTER apply returns — that navigation acts
   * as the effective reload, so the app re-mounts and reads the freshly
   * seeded storage on render. We deliberately do NOT issue an extra
   * `page.reload()` here — it would add a wasted network round-trip per
   * test for no observable benefit.
   *
   * Idempotent: re-applying overwrites — if the runner retries, no cookie
   * duplication.
   */
  async apply(ctx, resource) {
    const state = resource.sensitive.storageState;
    if (!state) {
      // Empty profile is a hard error at apply time. Reaching this branch
      // means the resource is `active` (otherwise the applier would have
      // tried to heal first) yet has no actual session payload — that is
      // either a corrupt write or a service bug. Failing here surfaces a
      // clear "re-record" CTA instead of letting the test run without auth
      // and fail later with a misleading "login button not found" error.
      throw new Error(
        `Auth resource "${resource.name}" has no storageState — re-record the login`,
      );
    }

    if (!ctx.context) {
      throw new Error('auth adapter requires a BrowserContext in ApplyContext');
    }

    try {
      if (state.cookies.length > 0) {
        await ctx.context.addCookies(state.cookies as any);
      }

      if (state.origins.length > 0 && ctx.page) {
        // localStorage is per-origin and can only be written once a page
        // on that origin is loaded, so we navigate first if the page is
        // blank and then seed.
        for (const origin of state.origins) {
          if (origin.localStorage.length === 0) continue;
          const currentOrigin = new URL(ctx.page.url() || 'about:blank').origin;
          if (currentOrigin !== origin.origin) {
            await ctx.page.goto(origin.origin, { waitUntil: 'load' });
          }
          await ctx.page.evaluate((entries) => {
            // `window` type isn't on the server tsconfig; page.evaluate runs
            // in the browser so casting via globalThis keeps tsc happy
            // without pulling DOM libs into the main compile.
            const storage = (globalThis as any).localStorage as
              | { setItem(k: string, v: string): void }
              | undefined;
            if (!storage) return;
            for (const { name, value } of entries) {
              try {
                storage.setItem(name, value);
              } catch {
                /* quota or disabled; ignore per-entry */
              }
            }
          }, origin.localStorage);
        }
      }
    } catch (err) {
      // Don't markBroken from here — the adapter is pure. The supervisor
      // decides how to react to apply failures (retry vs re-record).
      logger.error('[AUTH_ADAPTER] apply failed', {
        resourceId: resource.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  /**
   * TTL-based: base-row captured_at/expires_at drive freshness. The
   * service-level default already handles this, so we simply defer.
   */
  isFresh(resource) {
    if (resource.status === 'broken') return false;
    if (!resource.expiresAt || !resource.ttlSeconds) return true;
    const remainingMs = resource.expiresAt.getTime() - Date.now();
    if (remainingMs <= 0) return false;
    return remainingMs / (resource.ttlSeconds * 1000) > 0.1;
  },

  /**
   * Heal = replay the login recipe inside the SAME browser context (not a
   * fresh one — that would lose whatever client-side state the test has
   * already built up before the session expired).
   *
   * The recipe is an IntentStep[] and is executed by the caller using
   * the existing CommandExecutor — this adapter deliberately does NOT
   * import the executor to keep the dependency graph flat. Instead it
   * throws a well-known error telling the supervisor to drive the replay.
   *
   * After the supervisor completes the replay it re-invokes `capture()`
   * and passes the result to TestResourceService.captureState({heal:true}).
   */
  async heal() {
    // Why no-op: the recipe executor lives in the runner layer (jobs +
    // lite-engine) which imports this file. Driving execution from here
    // would create a cycle. The supervisor calls `recipe` + `capture()`
    // directly — this method exists for interface completeness and so
    // future adapters with in-process heal paths (e.g. OAuth token
    // refresh) have a consistent slot.
    throw new Error(
      'AuthAdapter.heal is orchestrated by the runner supervisor (recipe replay + capture). Call supervisor.healAuth(resource) instead.',
    );
  },

  /**
   * Snapshot the current live context as a fresh auth payload. Used by
   * the preview "I'm in — save login" flow and by the supervisor after
   * a successful heal replay.
   */
  async capture(ctx: ApplyContext): Promise<{
    config: AuthConfig;
    sensitive: AuthSensitive;
  }> {
    if (!ctx.context) {
      throw new Error('auth adapter capture() requires a BrowserContext');
    }

    const raw = await ctx.context.storageState();
    const v = validateAuthFixture(raw);
    if (!v.valid || !v.fixture) {
      throw new Error(
        `Captured storageState invalid: ${(v.errors ?? ['unknown']).slice(0, 3).join('; ')}`,
      );
    }

    return {
      config: {},
      sensitive: { storageState: v.fixture },
    };
  },
};

/**
 * Convenience: call at app boot to wire the adapter into the registry.
 */
export function registerAuthAdapter(): void {
  // Lazy import to keep this file importable from scripts that don't
  // bring up the full DI graph.
  const { registerResourceAdapter } = require('../adapter-registry') as typeof import('../adapter-registry');
  registerResourceAdapter(authAdapter);
}
