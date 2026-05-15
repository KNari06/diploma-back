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

/**
 * Mobile fast-auth snapshot. Captured once (via the editor "Save login" flow
 * or auto-captured after a successful recipe replay) and restored before
 * each test that uses this resource on the matching platform/package. Lets
 * mobile tests skip the login recipe — the mobile equivalent of web's
 * cookie+localStorage injection.
 *
 * Invalidation triggers, all handled by the consumer (compiler / mobile-job),
 * never silently inside the adapter:
 *   1. `apkVersionCode` change → app may have migrated SharedPrefs schema.
 *      Confident invalidation: fall back to recipe AND mark for re-capture.
 *   2. Restore failed at runtime (runner returns 409/500) → fall back to
 *      recipe AND mark snapshot broken so next clean login re-captures.
 *
 * Note on TTL: TTL expiry on the base row does NOT invalidate the
 * snapshot specifically. The server-side session lifetime that TTL
 * approximates affects recipe-replay credentials and snapshot-restored
 * cookies equally — both paths would 401 from the app's backend. We let
 * TTL flow through to whichever path we picked rather than forcing the
 * "slower" path on stale rows.
 *
 * v1 is Android-only. iOS Keychain export needs XCUITest infra we don't
 * have yet — adding `platform: 'ios'` later is the schema-friendly way
 * to extend; existing `'android'` rows stay valid.
 */
export interface AuthMobileSnapshot {
  platform: 'android';
  /** Must match the resolved APK's package at apply time — refuse on mismatch. */
  packageName: string;
  /** `ro.build.version.sdk` at capture (e.g. 35 for redroid 15). */
  androidApiLevel: number;
  /** Gzipped tar of /data/data/<pkg>/{shared_prefs,databases}, base64-encoded. */
  dataTarballBase64: string;
  sizeBytes: number;
  /** ISO 8601. Distinct from base row `captured_at`: that one bumps on heal
   *  even when the snapshot wasn't refreshed — this one only bumps on a real
   *  re-capture. */
  capturedAt: string;
  /** APK `versionCode` at capture time — null if the build pipeline didn't
   *  surface one. When it differs from the current run's APK, invalidate. */
  apkVersionCode?: number;
  /** Privilege path that produced this blob — surfaced in admin telemetry
   *  so we can see if customers hit the su-fallback often (signals their
   *  QA builds aren't debuggable). Not a security boundary. */
  capturedVia: 'run-as' | 'su';
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

  /**
   * Mobile fast-auth blob. Present only when the user (or auto-capture)
   * has snapshot'd the logged-in app-data dir. Web-only resources never
   * have this; mobile resources MAY have it — absence means the compiler
   * falls back to recipe replay (the existing behaviour).
   */
  mobileSnapshot?: AuthMobileSnapshot;
}

export const AUTH_SENSITIVE_FIELDS: Array<keyof AuthSensitive> = [
  'storageState',
  'totpSecret',
  'mobileSnapshot',
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

    // Fast-auth snapshot shape check. We don't try to validate the tarball
    // bytes here (impossible without unpacking + on-device replay) — we
    // only enforce the envelope so a malformed write doesn't survive
    // round-trip. Runtime invalidation (size, age, restore failure) is
    // the compiler / mobile-job's job, not ours.
    if (merged.mobileSnapshot !== undefined && merged.mobileSnapshot !== null) {
      const s = merged.mobileSnapshot as Partial<AuthMobileSnapshot>;
      if (s.platform !== 'android') {
        errors.push('mobileSnapshot.platform must be "android" (iOS deferred)');
      }
      if (!s.packageName || typeof s.packageName !== 'string') {
        errors.push('mobileSnapshot.packageName must be a non-empty string');
      }
      if (typeof s.androidApiLevel !== 'number' || s.androidApiLevel < 21) {
        errors.push('mobileSnapshot.androidApiLevel must be a number ≥ 21');
      }
      if (!s.dataTarballBase64 || typeof s.dataTarballBase64 !== 'string'
        || s.dataTarballBase64.length < 32) {
        // 32 chars ≈ 24 bytes — implausibly small for any real tarball.
        // Better to reject than persist a garbage blob the runner can't
        // base64-decode without a confusing error mid-test.
        errors.push('mobileSnapshot.dataTarballBase64 missing or implausibly short');
      }
      if (typeof s.sizeBytes !== 'number' || s.sizeBytes < 0) {
        errors.push('mobileSnapshot.sizeBytes must be a non-negative number');
      }
      if (!s.capturedAt || typeof s.capturedAt !== 'string') {
        errors.push('mobileSnapshot.capturedAt must be an ISO 8601 string');
      }
      if (s.capturedVia !== 'run-as' && s.capturedVia !== 'su') {
        errors.push('mobileSnapshot.capturedVia must be "run-as" or "su"');
      }
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
