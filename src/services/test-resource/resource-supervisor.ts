/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Resource Supervisor — detect auth loss mid-run and heal in place
 *
 * Runs between every step in the LiteEngine loop. Cheap when healthy
 * (URL / response-code check, no DOM probing on each call). Only does
 * real work when it sees signs of a lost session.
 *
 * On detection:
 *   1. Find the bound `auth` resource for the current run.
 *   2. Acquire the per-resource mutex so 10 parallel tests share one heal.
 *   3. Replay the resource's `recipe` via the caller-supplied executor
 *      (injected — keeps us decoupled from CommandExecutor).
 *   4. Call AuthAdapter.capture() to snapshot the fresh context.
 *   5. Persist via TestResourceService.captureState({heal:true}).
 *   6. Mark the applied-binding snapshot `healed_during_run=true` so the
 *      final test_executions row reflects reality.
 *
 * Never throws from `checkAndHealIfNeeded` when auth is healthy — that
 * would turn a benign inter-step call into a test failure. Only heal
 * FAILURES (recipe dies, capture throws) propagate up.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BrowserContext, Page, Response as PlaywrightResponse } from 'playwright';
import { logger } from '@/utils/core/logger';
import { requireResourceAdapter } from './adapter-registry';
import { captureState, loadDecrypted, markBroken } from './test-resource.service';
import { withResourceMutex } from './resource-mutex';
import type { DecryptedResource } from './types';
import type { AppliedBinding as AppliedBindingFromApplier } from './resource-applier';

// Re-export so callers only import supervisor types.
type AuthResource = DecryptedResource;

/** Executor the supervisor uses to replay a recipe IntentStep[]. */
export interface RecipeExecutor {
  /** Replay `recipe` in the same (current) browser context. Throws on failure. */
  run(params: {
    page: Page;
    context: BrowserContext;
    recipe: unknown[];
    userId: string;
    projectId: string;
    /**
     * Plaintext secrets keyed by `_secret_*` (from the decrypted resource
     * sensitive envelope). Step values containing `{{_secret_<key>}}` are
     * interpolated against this map at replay time. Optional — recipes
     * without redacted values pass through unchanged.
     */
    secrets?: Record<string, string>;
  }): Promise<void>;
}

export interface SupervisorConfig {
  userId: string;
  projectId: string;
  page: Page;
  context: BrowserContext;
  /** The auth resource (if any) currently bound to the run. */
  authResource?: AuthResource;
  /** Injected at runner startup (keeps this file free of CommandExecutor). */
  recipeExecutor: RecipeExecutor;
  /** Mutable — supervisor flips healed_during_run on success for the final snapshot. */
  appliedSnapshot: AppliedBindingFromApplier[];
  runVariables?: Map<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Detection patterns
// ═══════════════════════════════════════════════════════════════════════════

// Match dedicated auth routes only. The path's LAST segment must be one
// of the login keywords — this rules out `/auth/users`, `/oauth/clients`,
// `/login/help` and other interior occurrences that aren't auth-loss
// pages. We still trigger on `/login`, `/login/`, `/auth?return_to=...`,
// `/sso/saml/init` etc. via the trailing `(\/?($|\?|#))` group.
const LOGIN_URL_RE =
  /\/(login|signin|sign[-_]?in|auth|oauth|sso|logon)(\/?($|\?|#))/i;

/** Tracks the last navigation response's status so we can spot 401s. */
export class NavigationStatusTracker {
  private lastStatus: number | undefined;
  private attached = false;

  attach(page: Page): void {
    if (this.attached) return;
    this.attached = true;
    page.on('response', (resp: PlaywrightResponse) => {
      // Only care about main-frame navigation responses; subresources
      // 401 all day on well-behaved apps (e.g. probe pings).
      try {
        if (resp.request().isNavigationRequest()) {
          this.lastStatus = resp.status();
        }
      } catch {
        // Playwright occasionally throws when the request is destroyed;
        // ignore — we'll pick up the next response.
      }
    });
  }

  lastNavigationStatus(): number | undefined {
    return this.lastStatus;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════════

interface CheapSignal {
  matched: boolean;
  /** Trustworthy on its own (skip DOM probe). 401/403 is decisive. */
  decisive: boolean;
}

/**
 * Detect if the current page looks like an auth-loss state. Pure + fast:
 *   (a) URL matches login pattern (NOT decisive — too easy to false-positive)
 *   (b) last navigation response was 401 / 403 (decisive)
 *
 * DOM probing (password-input detection) is intentionally NOT done here —
 * it would slow every inter-step call. Supervisor calls this first as a
 * cheap filter; deeper probe lives below in `confirmAuthLoss`.
 */
export function looksLikeAuthLoss(
  page: Page,
  statusTracker: NavigationStatusTracker,
): boolean {
  return cheapSignal(page, statusTracker).matched;
}

function cheapSignal(
  page: Page,
  statusTracker: NavigationStatusTracker,
): CheapSignal {
  const s = statusTracker.lastNavigationStatus();
  if (s === 401 || s === 403) return { matched: true, decisive: true };
  try {
    const url = page.url();
    if (url && LOGIN_URL_RE.test(url)) return { matched: true, decisive: false };
  } catch {
    /* page may be closing; treat as no-signal */
  }
  return { matched: false, decisive: false };
}

/**
 * Slow-path confirmation before triggering a heal. URL match alone is no
 * longer enough — many SPAs route through `/auth/...` interior paths or
 * have legitimate `/login` marketing pages. We require a visible password
 * input to confirm an auth-loss state. 401/403 from the status tracker is
 * decisive on its own (caller passes `decisive=true` to skip the probe).
 */
async function confirmAuthLoss(page: Page, decisive: boolean): Promise<boolean> {
  if (decisive) return true;
  try {
    const hasPwd = await page
      .locator('input[type="password"]:visible')
      .first()
      .count()
      .then((n) => n > 0);
    return hasPwd;
  } catch {
    // Page is transient (closing / navigating). Don't heal on a guess —
    // the supervisor runs every step, we'll re-check shortly.
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Heal
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One-shot check + heal. Call between every step. Returns true if a heal
 * actually happened (caller should retry the failing step once) or false
 * if everything looked healthy.
 *
 * NEVER throws on healthy state. ONLY throws if a heal was attempted and
 * failed — the test can't proceed without a session.
 */
export async function checkAndHealIfNeeded(
  cfg: SupervisorConfig,
  statusTracker: NavigationStatusTracker,
): Promise<boolean> {
  // No auth resource → nothing to supervise. Test is either anon or used
  // a non-auth resource kind (environment, etc).
  if (!cfg.authResource) return false;

  const signal = cheapSignal(cfg.page, statusTracker);
  if (!signal.matched) return false;
  if (!(await confirmAuthLoss(cfg.page, signal.decisive))) return false;

  logger.warn('[RESOURCE_SUPERVISOR] Auth loss detected — healing', {
    resourceId: cfg.authResource.id,
    url: safeUrl(cfg.page),
    lastStatus: statusTracker.lastNavigationStatus(),
  });

  // Capture our pre-mutex view so the critical section can detect that a
  // sibling test already healed and skip the recipe replay. expiresAt is
  // the most reliable freshness watermark — captureState bumps it on every
  // successful heal, so a strictly-newer value (or the absence-to-presence
  // flip for static resources) means somebody beat us to it.
  const staleSnapshotExpiresAt = cfg.authResource.expiresAt?.getTime() ?? null;

  await withResourceMutex(cfg.authResource.id, async () => {
    // Re-read inside the lock. If the previous mutex holder just healed,
    // the row's expires_at jumped forward — replaying the recipe again
    // would mean N concurrent regression tests doing N sequential logins
    // (rate-limit / lockout territory) for one shared session loss.
    const fresh = await loadDecrypted(cfg.authResource!.id, cfg.userId);
    const freshExpiresAt = fresh?.expiresAt
      ? new Date(fresh.expiresAt).getTime()
      : null;
    const someoneElseHealed =
      fresh != null &&
      fresh.status === 'active' &&
      // Either they bumped expires_at past ours, or our view had no TTL
      // and they wrote one (stale → active transition).
      ((staleSnapshotExpiresAt != null &&
        freshExpiresAt != null &&
        freshExpiresAt > staleSnapshotExpiresAt) ||
        (staleSnapshotExpiresAt == null && freshExpiresAt != null));

    if (someoneElseHealed && fresh) {
      // Reapply the freshly-captured state into THIS test's context so the
      // next step runs authenticated, then return — recipe replay skipped.
      const adapter = requireResourceAdapter(fresh.kind);
      try {
        await adapter.apply(
          {
            userId: cfg.userId,
            projectId: cfg.projectId,
            page: cfg.page,
            context: cfg.context,
            runVariables: cfg.runVariables ?? new Map(),
          },
          fresh,
        );
        // Update the held snapshot so subsequent supervisor iterations
        // compare against the now-fresh view.
        cfg.authResource = fresh;
        logger.info('[RESOURCE_SUPERVISOR] Sibling already healed — reapplied fresh state', {
          resourceId: fresh.id,
        });
        return;
      } catch (err) {
        // Reapply failed — fall through to a real heal so we don't leave
        // this test running with stale cookies.
        logger.warn(
          '[RESOURCE_SUPERVISOR] Reapply of sibling-healed state failed — falling back to recipe',
          {
            resourceId: fresh.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    await healAuthInPlace(cfg);
  });

  // Flip the snapshot flag so the final test_executions row records that
  // this run survived a heal.
  const snap = cfg.appliedSnapshot.find(
    (s) => s.binding.resource_id === cfg.authResource!.id,
  );
  if (snap) snap.healed_during_run = true;

  return true;
}

/**
 * Replay recipe + capture + persist. Runs inside the per-resource mutex.
 *
 * Critical: the recipe runs IN THE SAME browser context as the test.
 * Spawning a new context would throw away whatever client state the test
 * has accumulated (cart, draft form, etc.) — the entire point of inline
 * heal is to preserve it.
 */
async function healAuthInPlace(cfg: SupervisorConfig): Promise<void> {
  const resource = cfg.authResource!;

  if (!resource.recipe || !Array.isArray(resource.recipe) || resource.recipe.length === 0) {
    // No recipe → nothing we can do. Mark broken so the UI shows a
    // "Re-record" CTA instead of silently retrying forever.
    await markBroken(resource.id, cfg.userId, 'Auth lost mid-run and no recipe available');
    throw new Error(`Auth "${resource.name}" has no recipe — cannot auto-heal`);
  }

  try {
    await cfg.recipeExecutor.run({
      page: cfg.page,
      context: cfg.context,
      recipe: resource.recipe,
      userId: cfg.userId,
      projectId: cfg.projectId,
      // Plaintext secrets pulled from the decrypted resource. Recipe values
      // like `{{_secret_step123}}` resolve against this map; non-secret
      // recipes (no placeholders) ignore it. Cast through unknown because
      // adapters store typed sensitive fields (e.g. AuthSensitive) but the
      // executor only cares about string values for interpolation.
      secrets: resource.sensitive as unknown as Record<string, string>,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markBroken(resource.id, cfg.userId, `Recipe replay failed: ${msg.slice(0, 200)}`);
    throw new Error(`Auth "${resource.name}" recipe failed during heal: ${msg}`);
  }

  // Capture the refreshed state via the adapter. The service then
  // re-encrypts + persists with heal_count++.
  const adapter = requireResourceAdapter(resource.kind);
  if (!adapter.capture) {
    // Shouldn't happen for auth kind — adapter.capture is defined — but
    // guarding keeps the supervisor kind-agnostic.
    throw new Error(`Adapter for kind=${resource.kind} has no capture()`);
  }

  const captured = await adapter.capture({
    userId: cfg.userId,
    projectId: cfg.projectId,
    page: cfg.page,
    context: cfg.context,
    runVariables: cfg.runVariables ?? new Map(),
  });

  await captureState(
    resource.id,
    cfg.userId,
    { config: captured.config, sensitive: captured.sensitive },
    { heal: true },
  );

  logger.info('[RESOURCE_SUPERVISOR] Heal succeeded', {
    resourceId: resource.id,
    name: resource.name,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════════════════════════════════════

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '<closed>';
  }
}

