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
import { captureState, markBroken } from './test-resource.service';
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

// Match `/login`, `/signin`, `/sign-in`, `/auth`, `/oauth/*` paths regardless
// of query string. Kept conservative — we don't want to misfire on product
// pages that happen to have "login" in the name (use word boundaries).
const LOGIN_URL_RE = /\/(login|signin|sign[-_]?in|auth|oauth|sso)(\/|$|\?)/i;

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

/**
 * Detect if the current page looks like an auth-loss state. Pure + fast:
 *   (a) URL matches login pattern
 *   (b) last navigation response was 401 / 403
 *
 * DOM probing (password-input detection) is intentionally NOT done here —
 * it would slow every inter-step call. Supervisor calls this first as a
 * cheap filter; deeper probe lives below in `confirmAuthLoss`.
 */
export function looksLikeAuthLoss(
  page: Page,
  statusTracker: NavigationStatusTracker,
): boolean {
  try {
    const url = page.url();
    if (url && LOGIN_URL_RE.test(url)) return true;
  } catch {
    /* page may be closing; treat as no-signal */
  }
  const s = statusTracker.lastNavigationStatus();
  if (s === 401 || s === 403) return true;
  return false;
}

/**
 * Slow-path confirmation before triggering a heal. Runs a small DOM probe
 * for a password input. Gives us one more false-positive filter (e.g.
 * pages that have `/login` in the URL but are marketing content).
 */
async function confirmAuthLoss(page: Page): Promise<boolean> {
  try {
    const hasPwd = await page
      .locator('input[type="password"]:visible')
      .first()
      .count()
      .then((n) => n > 0);
    if (hasPwd) return true;
  } catch {
    /* page may be transient */
  }
  // If we got here via URL/status but there's no password field, default
  // to YES — the signals were strong and the DOM probe can race page
  // loads. False positives on heal are cheap (one replay); false
  // negatives corrupt the test.
  return true;
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

  if (!looksLikeAuthLoss(cfg.page, statusTracker)) return false;
  if (!(await confirmAuthLoss(cfg.page))) return false;

  logger.warn('[RESOURCE_SUPERVISOR] Auth loss detected — healing', {
    resourceId: cfg.authResource.id,
    url: safeUrl(cfg.page),
    lastStatus: statusTracker.lastNavigationStatus(),
  });

  await withResourceMutex(cfg.authResource.id, async () => {
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

