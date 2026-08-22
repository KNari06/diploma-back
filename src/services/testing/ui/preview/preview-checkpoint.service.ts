/**
 * Preview Checkpoint Service
 *
 * "Put the browser back the way it was before the step I just ran."
 *
 * Scope — read this before extending
 * ──────────────────────────────────
 * This restores the BROWSER, never the SERVER. A step that submitted a form,
 * created an order, sent an email or deleted a record cannot be taken back by
 * anything in this file. What a restore returns is the client-side session:
 * cookies, localStorage and the URL the author was on. That is enough for the
 * common authoring mistake ("that click navigated somewhere I didn't want"),
 * and it is deliberately NOT presented to the user as "undo the step" — see
 * the i18n copy, which says "return to the state before the step".
 *
 * Also outside the snapshot, by construction:
 *   • sessionStorage and IndexedDB — Playwright's `storageState()` covers
 *     cookies + localStorage only.
 *   • In-memory SPA state. The restore ends on a fresh navigation, so the app
 *     re-mounts and rebuilds from the seeded storage — usually the same thing
 *     it would do on a reload, but a client-only wizard step held purely in
 *     memory is gone.
 *
 * ONE checkpoint per session, on purpose
 * ──────────────────────────────────────
 * We keep exactly the state captured immediately before the most recent
 * single-step apply — "one step back", not a history. A deeper stack would
 * imply a reliability this mechanism does not have: the further back you go,
 * the more server-side state has drifted away from the client state we
 * restore, so a five-steps-back "undo" would look successful while landing
 * the author in a combination that never existed. Going further back is what
 * a replay from the start of the test is for.
 *
 * Restore REPLACES, it does not merge
 * ───────────────────────────────────
 * Note the difference from `auth.adapter.ts`'s `apply()`, which seeds a saved
 * login additively. Here the cookies and localStorage keys the step CREATED
 * must disappear, so we clear both before re-seeding. Merging would leave the
 * step's auth token or feature flag behind and produce a state that is
 * neither before nor after.
 */

import type { BrowserContext, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { getPreviewSessionService } from './preview-session.service';

/** One origin's localStorage, in Playwright's `storageState()` shape. */
interface CheckpointOrigin {
  origin: string;
  localStorage: { name: string; value: string }[];
}

interface CheckpointStorageState {
  cookies: unknown[];
  origins: CheckpointOrigin[];
}

export interface PreviewCheckpoint {
  /** Where the page was pointed before the step ran. */
  url: string;
  storageState: CheckpointStorageState;
  /**
   * The tabs that existed at capture time, held by reference. Anything open at
   * restore time that is NOT in here was opened by the step (a `target=_blank`
   * click, a popup) and gets closed — otherwise "back to before the step"
   * leaves the tab strip in the after state.
   *
   * Safe to hold: these belong to the same session, and the whole checkpoint is
   * dropped when that session stops.
   */
  pagesAtCapture: Set<Page>;
  /** The step whose apply this checkpoint precedes — drives the UI label. */
  stepId?: string;
  stepLabel?: string;
  capturedAt: number;
}

/**
 * What the UI needs to render the control, without shipping it the payload.
 *
 * `previewSessionId` is REQUIRED even though it looks redundant: the run loop
 * announces state via `emitToUser`, which reaches every socket the user has, so
 * a second editor tab would otherwise adopt a checkpoint belonging to another
 * session. The client filters on this field.
 */
export interface PreviewCheckpointInfo {
  previewSessionId: string;
  available: boolean;
  url?: string;
  stepId?: string;
  stepLabel?: string;
  capturedAt?: number;
}

export type RestoreFailureReason =
  | 'no_checkpoint'
  | 'session_gone'
  | 'restore_failed';

export type RestoreResult =
  | { ok: true; url: string }
  | { ok: false; reason: RestoreFailureReason; message: string };

/**
 * Session-scoped and in-memory: a checkpoint is only meaningful against the
 * live browser it was taken from, so it must not outlive the session (and
 * must never reach the database — it holds live auth cookies).
 */
const checkpoints = new Map<string, PreviewCheckpoint>();

function describe(
  previewSessionId: string,
  checkpoint: PreviewCheckpoint | undefined,
): PreviewCheckpointInfo {
  if (!checkpoint) return { previewSessionId, available: false };
  return {
    previewSessionId,
    available: true,
    url: checkpoint.url,
    stepId: checkpoint.stepId,
    stepLabel: checkpoint.stepLabel,
    capturedAt: checkpoint.capturedAt,
  };
}

function resolveLive(
  previewSessionId: string,
  userId: string,
): { context: BrowserContext; page: Page } | null {
  const sessionService = getPreviewSessionService();
  const context = sessionService.getContext(previewSessionId, userId);
  const page = sessionService.getPage(previewSessionId, userId);
  if (!context || !page) return null;
  return { context, page };
}

/**
 * Snapshot the live session immediately BEFORE a step is applied.
 *
 * Fail-open by design: capture runs on the hot path of every single-step
 * apply, and a session that cannot be snapshotted (already torn down, CDP
 * hiccup) must not block the author from running their step. A failure just
 * means no checkpoint is offered afterwards.
 */
export async function captureCheckpoint(
  previewSessionId: string,
  userId: string,
  step?: { id?: string; label?: string },
): Promise<PreviewCheckpointInfo> {
  try {
    // Inside the try on purpose: this runs before every step of a run, and
    // resolving the session touches code this module does not own. Anything
    // it throws must degrade to "no restore point", never abort the run the
    // author actually asked for.
    const live = resolveLive(previewSessionId, userId);
    if (!live) {
      checkpoints.delete(previewSessionId);
      return { previewSessionId, available: false };
    }

    const raw = (await live.context.storageState()) as unknown as CheckpointStorageState;
    const checkpoint: PreviewCheckpoint = {
      url: live.page.url(),
      storageState: {
        cookies: Array.isArray(raw?.cookies) ? raw.cookies : [],
        origins: Array.isArray(raw?.origins) ? raw.origins : [],
      },
      pagesAtCapture: new Set(live.context.pages()),
      stepId: step?.id,
      stepLabel: step?.label,
      capturedAt: Date.now(),
    };
    checkpoints.set(previewSessionId, checkpoint);

    logger.debug('[PREVIEW_CHECKPOINT] Captured', {
      previewSessionId,
      stepId: step?.id,
      cookies: checkpoint.storageState.cookies.length,
      origins: checkpoint.storageState.origins.length,
    });

    return describe(previewSessionId, checkpoint);
  } catch (err) {
    // Drop any stale checkpoint rather than leaving one that predates the
    // step before last — offering that as "one step back" would be a lie.
    checkpoints.delete(previewSessionId);
    logger.warn('[PREVIEW_CHECKPOINT] Capture failed (non-fatal)', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { previewSessionId, available: false };
  }
}

/** Seed one origin's localStorage, replacing whatever the step left behind. */
async function reseedOriginStorage(page: Page, origin: CheckpointOrigin): Promise<void> {
  const currentOrigin = (() => {
    try {
      return new URL(page.url() || 'about:blank').origin;
    } catch {
      return 'about:blank';
    }
  })();

  if (currentOrigin !== origin.origin) {
    await page.goto(origin.origin, { waitUntil: 'load' });
  }

  await page.evaluate((entries) => {
    // `window` isn't in the server tsconfig; page.evaluate runs in the browser,
    // so reach it via globalThis (same trick as auth.adapter).
    const storage = (globalThis as any).localStorage as
      | { clear(): void; setItem(k: string, v: string): void }
      | undefined;
    if (!storage) return;
    try {
      storage.clear();
    } catch {
      /* disabled or partitioned; seeding below is still worth attempting */
    }
    for (const { name, value } of entries) {
      try {
        storage.setItem(name, value);
      } catch {
        /* quota or disabled; ignore per-entry */
      }
    }
  }, origin.localStorage);
}

/**
 * The origins whose localStorage the restore must write: every origin captured
 * in the checkpoint, plus every origin that has storage NOW but did not then —
 * the latter get an empty entry so `reseedOriginStorage` clears them.
 *
 * Reading the live storage state can fail (page detached mid-restore); a
 * failure degrades to "only reset what we captured", which is the previous
 * behaviour rather than an aborted restore.
 */
async function currentOriginsToReset(
  context: BrowserContext,
  captured: Map<string, CheckpointOrigin>,
): Promise<CheckpointOrigin[]> {
  const toReset = [...captured.values()];
  try {
    const now = (await context.storageState()) as unknown as CheckpointStorageState;
    for (const origin of now?.origins ?? []) {
      if (!origin?.origin || captured.has(origin.origin)) continue;
      if (!origin.localStorage?.length) continue;
      toReset.push({ origin: origin.origin, localStorage: [] });
    }
  } catch (err) {
    logger.warn('[PREVIEW_CHECKPOINT] Could not read current origins; clearing captured ones only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return toReset;
}

/**
 * Close every tab that appeared after the checkpoint was taken.
 *
 * Goes through the session service's `closeTab` rather than `page.close()`:
 * the session owns the tab array, the active index and the page-switch
 * callback, and closing a Playwright page behind its back leaves the editor's
 * tab strip describing tabs that no longer exist. `closeTab` also refuses to
 * close the last remaining tab, which is the behaviour we want anyway.
 *
 * Best-effort per tab — a tab that refuses to close must not abort the rest of
 * the restore, which is the part the author actually asked for.
 */
async function closeTabsOpenedAfterCapture(
  previewSessionId: string,
  userId: string,
  pagesAtCapture: Set<Page>,
): Promise<void> {
  try {
    const sessionService = getPreviewSessionService();
    const session = sessionService.getSession(previewSessionId) as
      | { pages?: Page[] }
      | null
      | undefined;
    const pages = session?.pages;
    if (!Array.isArray(pages)) return;

    const opened = pages.filter((page) => !pagesAtCapture.has(page));
    for (const page of opened) {
      // Re-read the index each time — closing one tab shifts the rest.
      const index = (session?.pages ?? []).indexOf(page);
      if (index === -1) continue;
      try {
        await sessionService.closeTab(previewSessionId, userId, index);
      } catch (err) {
        logger.warn('[PREVIEW_CHECKPOINT] Could not close a tab opened by the step', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('[PREVIEW_CHECKPOINT] Tab cleanup skipped (non-fatal)', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Put the live session back to the captured checkpoint, then drop it — after a
 * restore there is nothing further back to go, and keeping the entry would let
 * a second click "restore" a state already current.
 */
export async function restoreCheckpoint(
  previewSessionId: string,
  userId: string,
): Promise<RestoreResult> {
  const checkpoint = checkpoints.get(previewSessionId);
  if (!checkpoint) {
    return {
      ok: false,
      reason: 'no_checkpoint',
      message: 'No checkpoint captured for this session',
    };
  }

  let live: ReturnType<typeof resolveLive>;
  try {
    // Inside a try for the same reason capture is: resolving the session
    // reaches into code this module does not own, and this function's contract
    // is a typed RestoreResult, not a thrown error.
    live = resolveLive(previewSessionId, userId);
  } catch (err) {
    logger.warn('[PREVIEW_CHECKPOINT] Could not resolve session for restore', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    live = null;
  }

  if (!live) {
    checkpoints.delete(previewSessionId);
    return {
      ok: false,
      reason: 'session_gone',
      message: 'Preview session is no longer available',
    };
  }

  try {
    // 0. Close tabs the step opened. Done FIRST so the steps below act on the
    //    tab that was active before, not on a popup the step spawned.
    await closeTabsOpenedAfterCapture(previewSessionId, userId, checkpoint.pagesAtCapture);

    // Closing tabs can change which page is active, so re-resolve before
    // touching storage — `live.page` may now be a page we just closed.
    const current = resolveLive(previewSessionId, userId) ?? live;

    // 1. Cookies: clear first so anything the step set (a fresh session
    //    cookie, a consent flag) is gone rather than merged over.
    await current.context.clearCookies();
    if (checkpoint.storageState.cookies.length > 0) {
      await current.context.addCookies(checkpoint.storageState.cookies as any);
    }

    // 2. localStorage per origin. Requires being ON the origin, so this may
    //    navigate; the final goto below lands us back where we belong.
    //
    //    Origins the STEP introduced get an empty seed rather than being
    //    skipped: they are absent from the checkpoint, so iterating only over
    //    captured origins would leave everything the step wrote on a
    //    first-visited host intact — a merge, which is exactly what this
    //    function promises not to do.
    const capturedOrigins = new Map(
      checkpoint.storageState.origins.map((origin) => [origin.origin, origin]),
    );
    for (const origin of await currentOriginsToReset(current.context, capturedOrigins)) {
      await reseedOriginStorage(current.page, origin);
    }

    // 3. Land on the captured URL. Going through the session service (rather
    //    than a bare page.goto) keeps the external-nav trap, DOM snapshot and
    //    version counter consistent with any other navigation.
    const sessionService = getPreviewSessionService();
    await sessionService.navigate(previewSessionId, checkpoint.url, userId);

    checkpoints.delete(previewSessionId);
    logger.info('[PREVIEW_CHECKPOINT] Restored', {
      previewSessionId,
      url: checkpoint.url,
      stepId: checkpoint.stepId,
    });
    return { ok: true, url: checkpoint.url };
  } catch (err) {
    // Keep the checkpoint on failure: a half-applied restore is exactly when
    // the author wants to try again rather than lose the only way back.
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[PREVIEW_CHECKPOINT] Restore failed', { previewSessionId, error: message });
    return { ok: false, reason: 'restore_failed', message };
  }
}

/** What the UI should render right now. */
export function getCheckpointInfo(previewSessionId: string): PreviewCheckpointInfo {
  return describe(previewSessionId, checkpoints.get(previewSessionId));
}

/** Session teardown — a checkpoint holds live auth cookies, so don't leak it. */
export function clearCheckpoint(previewSessionId: string): void {
  checkpoints.delete(previewSessionId);
}
