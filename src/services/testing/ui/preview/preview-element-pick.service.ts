/**
 * Preview Element Pick Service
 *
 * Implements the one-shot "Pick element" mode used by the manual step form.
 *
 * Flow
 * ────
 *   1. Frontend opens the "Add step" form and clicks the "Pick element"
 *      button next to the action-type field.
 *   2. WS handler invokes `start()` → this service injects an in-page
 *      overlay that highlights interactive elements on hover and intercepts
 *      the next click in capture phase (preventDefault + stopImmediate-
 *      Propagation). The page never sees the click — picking is read-only.
 *   3. On click the in-page script reports the (x, y) back via an exposed
 *      callback. We probe the element using the SAME pipeline recording
 *      uses (RecordingCaptureService.probeForRecording →
 *      buildRecordedFingerprint / buildBindingHints / generate description),
 *      then run a dry-run lint to predict whether the picked element will
 *      resolve cleanly at replay time. The result is emitted as
 *      `preview:pick:result` and pick-mode exits (`preview:pick:state
 *      { active: false, reason: 'picked' }`).
 *
 * Mutex contract
 * ──────────────
 * Recording / Run / Pick are mutually exclusive. The WS handler owns the
 * guard via `previewPickActiveSessionIds` (synchronous Set, sibling of
 * `previewRunStartInFlight`). This service assumes the guard was already
 * acquired by the caller — it does not re-check.
 *
 * Lifetime
 * ────────
 *   - Auto-cancels after PICK_TIMEOUT_MS if the user never clicks.
 *   - Auto-cancels on `page.on('framenavigated')` if the page navigates
 *     to a different URL (the in-page state is gone anyway).
 *   - Always emits a `preview:pick:state { active: false, ... }` terminator
 *     when exiting, regardless of path (success / cancel / timeout / error).
 */

import type { Page, Frame } from 'playwright';
import type { Namespace } from 'socket.io';
import { logger } from '@/utils/core/logger';
import {
  createRoomName,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketData,
  type PreviewPickResultPayload,
  type PreviewPickLintPayload,
  type PreviewPickStatePayload,
} from '@/websocket/types/types';
import type {
  TargetFingerprint,
  BindingHints,
  LintStatus,
  IntentActionType,
} from './preview.types';
import { buildOverlayResolverHelpers } from './overlay-resolver-helpers';

/**
 * We accept a Socket.IO Namespace rather than a single socket. Emits target
 * the preview room — any subscribed socket (e.g. multiple tabs of the same
 * user) sees the result. This mirrors how recording handlers emit.
 */
type PreviewNamespace = Namespace<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const PICK_CB_NAME = '__qai_pick_callback';
const PICK_TIMEOUT_MS = 60_000;

interface PickSession {
  nsp: PreviewNamespace;
  userId: string;
  page: Page;
  startedAt: number;
  timeoutTimer: NodeJS.Timeout;
  navHandler: (frame: Frame) => void;
  /** `page.on('close')` listener — torn down in cancelPick. */
  pageCloseHandler: () => void;
  /**
   * Caller-supplied callback fired when pick mode exits for ANY reason
   * (picked / cancelled / timeout / nav / error). Used by the WS handler to
   * release `previewPickActiveSessionIds`. Best-effort — never throws.
   */
  onExit?: (reason: PreviewPickStatePayload['reason']) => void;
  closed: boolean;
  resolved: boolean; // true once a pick was emitted; prevents double-resolution
  /**
   * True while `startPick` is still wiring up listeners + injecting the
   * overlay. `isPickActive` treats this as active (so recording / run
   * can't sneak in during the gap), but the in-page callback ignores
   * clicks until initialization finishes. P1 race fix.
   */
  initializing: boolean;
}

const activePickSessions = new Map<string, PickSession>();

/**
 * WS handler asks us this before allowing recording / run / a second pick.
 * Returns true for both fully-armed sessions and initializing ones — the
 * latter to close the P1 race where overlay injection is mid-await.
 */
export function isPickActive(previewSessionId: string): boolean {
  const session = activePickSessions.get(previewSessionId);
  return !!session && !session.closed;
}

/**
 * Enter pick mode. Caller must have acquired the pick-mutex already.
 * Idempotent: starting twice for the same session cancels the previous
 * session first.
 */
export async function startPick(params: {
  previewSessionId: string;
  nsp: PreviewNamespace;
  userId: string;
  page: Page;
  onExit?: (reason: PreviewPickStatePayload['reason']) => void;
}): Promise<void> {
  const { previewSessionId, nsp, userId, page, onExit } = params;

  // P2 — page lifecycle guard. The session service can hand us a Page
  // reference for a tab the user has since closed (popup dismissed,
  // navigation-spawned popup, session torn down between handler entry
  // and here). All Playwright calls below would throw — emit a clean
  // error to the FE instead.
  if (page.isClosed()) {
    emitState(nsp, previewSessionId, false, 'error', 'page_closed');
    onExit?.('error');
    return;
  }

  // Defensive cancel — start should not arrive while another session is
  // active (handler guard prevents it), but be safe. Idempotent.
  if (activePickSessions.has(previewSessionId)) {
    await cancelPick(previewSessionId, 'preempted');
  }

  // P1 race fix — register the session in the map BEFORE any await, with
  // `initializing: true`. `isPickActive` treats initializing entries as
  // active, so a concurrent recording:start / run:start / second pick:
  // start cannot sneak past the mutex during the in-page injection await.
  const session: PickSession = {
    nsp,
    userId,
    page,
    startedAt: Date.now(),
    closed: false,
    resolved: false,
    initializing: true,
    onExit,
    // Filled below; placeholders satisfy strict types.
    timeoutTimer: setTimeout(() => undefined, 0),
    navHandler: () => undefined,
    pageCloseHandler: () => undefined,
  };
  clearTimeout(session.timeoutTimer);
  activePickSessions.set(previewSessionId, session);

  // Auto-timeout watchdog.
  session.timeoutTimer = setTimeout(() => {
    void cancelPick(previewSessionId, 'timeout');
  }, PICK_TIMEOUT_MS);

  // P4 — auto-cancel on navigation. We treat ANY main-frame navigation
  // event as a teardown signal EXCEPT pure hash changes on the same
  // origin+pathname (Angular / Vue hash routing keeps the DOM intact).
  // Reloads (same URL) reset window state — overlay + exposeFunction are
  // gone — so we must still cancel; we detect that via the absence of
  // the `__qai_pick_state` marker after navigation.
  const startUrl = page.url();
  const startKey = pageNavKey(startUrl);
  session.navHandler = (frame) => {
    if (frame !== page.mainFrame()) return;
    const currentKey = pageNavKey(frame.url());
    // Same origin+path: most likely a hash-only SPA route or a pushState
    // call that did NOT reload the document. Verify our overlay marker
    // is still there — if it isn't, the page actually reloaded and we
    // must cancel.
    if (currentKey === startKey) {
      // Fire-and-forget probe — never throw out of a navigation handler.
      page
        .evaluate(`!!(window)['${OVERLAY_STATE_KEY}']`)
        .then((stillThere) => {
          if (stillThere) return;
          void cancelPick(previewSessionId, 'session_closed');
        })
        .catch(() => {
          // page closed / context destroyed → cancel
          void cancelPick(previewSessionId, 'session_closed');
        });
      return;
    }
    void cancelPick(previewSessionId, 'session_closed');
  };
  page.on('framenavigated', session.navHandler);

  // P3 — page close watcher. Without this, if the tab/popup is closed
  // mid-pick, the session leaks in the map (we'd only notice on user
  // disconnect or explicit cancel).
  session.pageCloseHandler = () => {
    void cancelPick(previewSessionId, 'session_closed');
  };
  page.once('close', session.pageCloseHandler);

  // Expose the in-page callback that the overlay script will invoke.
  // exposeFunction throws if the name is already taken (e.g. left over
  // from a previous pick that didn't clean up). We swallow that — the
  // callback below resolves through the session map anyway, so a stale
  // exposure that points at the same JS function is fine. We do still
  // log non-AlreadyExposed errors so a CSP / page-closed failure is
  // visible in postmortem.
  try {
    await page.exposeFunction(PICK_CB_NAME, (clickPayload: InPagePickPayload) => {
      const live = activePickSessions.get(previewSessionId);
      if (!live || live.closed || live.resolved) return;
      // Reject clicks that arrive before overlay injection finished. The
      // overlay script itself doesn't bind listeners until the closure
      // runs, so this is mostly defensive against a misbehaving manual
      // page.evaluate by the user.
      if (live.initializing) return;
      // Disarm the timeout watchdog IMMEDIATELY — before any await — so
      // it can't fire mid-`finishPick` and double-emit a `:state {timeout}`
      // after `:result {picked}`. Audit issue #1.
      clearTimeout(live.timeoutTimer);
      live.resolved = true;
      void finishPick(previewSessionId, clickPayload).catch((err) => {
        logger.error('[PREVIEW_PICK] finishPick failed', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        void cancelPick(previewSessionId, 'error', err instanceof Error ? err.message : String(err));
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "Function has been already registered" is benign (re-injection).
    // Everything else (page closed, target detached, CSP) means startup
    // failed and we must back out.
    if (!/already (registered|exposed)/i.test(msg)) {
      logger.warn('[PREVIEW_PICK] exposeFunction failed — cancelling pick', {
        previewSessionId,
        error: msg,
      });
      await cancelPick(previewSessionId, 'error', 'expose_function_failed');
      return;
    }
  }

  // Inject the overlay UI. Done after exposeFunction so the script can
  // safely reference window[PICK_CB_NAME].
  if (page.isClosed()) {
    await cancelPick(previewSessionId, 'session_closed');
    return;
  }
  try {
    await page.evaluate(buildOverlayScript(PICK_CB_NAME));
  } catch (err) {
    logger.warn('[PREVIEW_PICK] Overlay injection failed — cancelling pick', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await cancelPick(previewSessionId, 'error', 'overlay_injection_failed');
    return;
  }

  // Initialization done — accept clicks.
  session.initializing = false;
  emitState(nsp, previewSessionId, true, 'started');

  logger.info('[PREVIEW_PICK] Pick mode started', {
    previewSessionId,
    userId,
    startUrl: pageNavKey(startUrl), // P17 — redact query/hash from logs
  });
}

/**
 * Exit pick mode (no element chosen). Idempotent.
 *
 * `reason` distinguishes the exit cause for the FE — it can show a toast
 * for 'timeout' but stay silent for 'cancelled'.
 */
export async function cancelPick(
  previewSessionId: string,
  reason: PreviewPickStatePayload['reason'] = 'cancelled',
  errorMessage?: string,
): Promise<void> {
  const session = activePickSessions.get(previewSessionId);
  if (!session || session.closed) return;
  session.closed = true;

  clearTimeout(session.timeoutTimer);
  try {
    session.page.off('framenavigated', session.navHandler);
  } catch {
    /* page closed */
  }
  try {
    session.page.off('close', session.pageCloseHandler);
  } catch {
    /* page closed */
  }

  // Remove overlay from the page. Best-effort — `page.evaluate` rejects
  // synchronously when the page is closed, so the catch chain (and the
  // outer try) cover the same case from different angles depending on
  // Playwright version.
  if (!session.page.isClosed()) {
    try {
      await session.page.evaluate(teardownOverlayScript()).catch(() => undefined);
    } catch {
      /* page closed mid-evaluate */
    }
  }

  activePickSessions.delete(previewSessionId);

  emitState(session.nsp, previewSessionId, false, reason, errorMessage);

  // Notify the caller (WS handler) so it can release its mutex Set. We
  // catch defensively — the callback is best-effort observability, not a
  // critical path.
  try {
    session.onExit?.(reason);
  } catch (err) {
    logger.debug('[PREVIEW_PICK] onExit callback threw', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[PREVIEW_PICK] Pick mode ended', {
    previewSessionId,
    reason,
    durationMs: Date.now() - session.startedAt,
  });
}

/** Force-cancel pick when the preview session itself is torn down. */
export async function cancelPickForSession(previewSessionId: string): Promise<void> {
  if (!activePickSessions.has(previewSessionId)) return;
  await cancelPick(previewSessionId, 'session_closed');
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

interface InPagePickPayload {
  x: number;
  y: number;
}

async function finishPick(
  previewSessionId: string,
  clickPayload: InPagePickPayload,
): Promise<void> {
  const session = activePickSessions.get(previewSessionId);
  if (!session) return;

  const { nsp, userId, page } = session;

  // Helper: bail out if the session was closed mid-async (disconnect,
  // explicit cancel, page closed). Without this guard `finishPick`
  // would happily emit `:result` after teardown — audit issue #1.
  // Also covers P2: the page itself could be closed while we're awaiting
  // an LLM call; probing a closed page throws.
  const stillAlive = () =>
    activePickSessions.get(previewSessionId) === session
    && !session.closed
    && !page.isClosed();

  // 1) Probe — same pipeline recording uses for a click.
  const { RecordingCaptureService } = await import('./recording-capture.service');
  if (!stillAlive()) return;
  const probed = await RecordingCaptureService.probeForRecording(page, clickPayload.x, clickPayload.y);
  if (!stillAlive()) return;

  if (!probed) {
    logger.warn('[PREVIEW_PICK] Probe returned null — exiting pick mode', {
      previewSessionId,
      x: clickPayload.x,
      y: clickPayload.y,
    });
    await cancelPick(previewSessionId, 'error', 'probe_returned_null');
    return;
  }

  // 2) Build identity / hints (reuses recording pipeline byte-for-byte).
  let fingerprint: TargetFingerprint | undefined;
  let bindingHints: BindingHints | undefined;
  try {
    fingerprint = RecordingCaptureService.buildRecordedFingerprint(probed);
  } catch (err) {
    logger.warn('[PREVIEW_PICK] buildRecordedFingerprint failed', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    bindingHints = RecordingCaptureService.buildBindingHints(probed);
  } catch (err) {
    logger.warn('[PREVIEW_PICK] buildBindingHints failed', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3) Suggested action — cheap structural guess, user can change.
  const suggestedAction = inferSuggestedAction(probed);

  // 4) Description — LLM-backed, but fail-open. We dual-track: synchronous
  //    structural fallback so the form is never left with an empty label,
  //    plus the awaited LLM call (it has its own 1-slot throttle so this
  //    is fast in the happy path).
  let description: string | undefined;
  try {
    const { generateRecordedDescription } = await import('./recorded-description-llm.service');
    if (!stillAlive()) return;
    description = await generateRecordedDescription(probed);
  } catch (err) {
    logger.debug('[PREVIEW_PICK] LLM description failed; falling back', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!stillAlive()) return;
  if (!description) {
    description = buildStructuralDescription(probed, suggestedAction);
  }

  // 5) Build + emit the PRIMARY result. The fingerprint is the source of
  //    truth for identity; flat shortcuts (stableId/testId/tag/ref) are
  //    surfaced only for the FE's "tag#id" label rendering so it doesn't
  //    have to unpack the fingerprint client-side.
  //
  // ⚠️ Two-phase emit (May 2026, bi.group UX incident):
  //   Before, lint dry-run ran INLINE and `preview:pick:result` was emitted
  //   only after the LLM finished — adding 5-10s between user's click and
  //   the form showing any data. From the user's POV the picker felt frozen
  //   even though the recorded fingerprint was already in hand.
  //
  //   Now we emit `preview:pick:result` immediately (description, fingerprint,
  //   bindingHints — the data the form actually needs) and run lint as
  //   FIRE-AND-FORGET, emitting a follow-up `preview:pick:lint` when it
  //   resolves. The lint payload only carries confidence/warning text, so
  //   late arrival is purely additive.
  //
  //   `lint` on the primary payload is intentionally omitted now — FE
  //   reads the same fields off `preview:pick:lint` instead. Old FE
  //   clients that read `lint` from the result keep working (field is
  //   `undefined`, no visual warning) until they upgrade.
  const payload: PreviewPickResultPayload = {
    previewSessionId,
    description,
    stableId: probed.elementId,
    testId: probed.testId,
    ref: probed.ref,
    tag: probed.tag,
    recordedFingerprint: fingerprint,
    bindingHints,
    suggestedAction,
    timestamp: new Date().toISOString(),
  };

  if (!stillAlive()) return;
  const room = createRoomName('preview', previewSessionId);
  nsp.to(room).emit('preview:pick:result', payload);

  // 6) Exit pick mode immediately so the picker overlay clears in the
  //    preview — the lint still runs but the user can already proceed.
  await cancelPick(previewSessionId, 'picked');

  // 7) Lint dry-run — predict whether the picked element will resolve
  //    uniquely at replay. Fire-and-forget; the result is purely advisory
  //    (a confidence badge / "locator may be fragile" warning). Runs after
  //    we've already released pick mode so a slow LLM never blocks the UI.
  void (async () => {
    try {
      const { IntentStepLintService } = await import('./intent-step-lint.service');
      const lintResult = await IntentStepLintService.lintStepWithAI({
        previewSessionId,
        userId,
        forceFreshSnapshot: true,
        // P14 — `pick_dry_run` makes pick-session lint hits trivially
        // filterable in intent_resolve.log without confusing them with
        // apply-prelint or find-button traffic.
        auditTrigger: 'pick_dry_run',
        stepDraft: {
          id: `pick-${previewSessionId}-${Date.now()}`,
          // `SuggestedAction` is a strict subset of `IntentActionType`
          // (click | type | select | hover) — narrow widening via cast.
          type: suggestedAction as IntentActionType,
          description,
          bindingHints,
          recordedFingerprint: fingerprint,
          recordedDescription: description,
        },
      });
      // Session may have closed during the lint await — drop silently.
      if (!stillAlive()) return;
      const lintPayload: PreviewPickLintPayload = {
        previewSessionId,
        lint: {
          status: lintResult.status as LintStatus,
          confidence: lintResult.confidence,
          message: lintResult.message,
        },
        timestamp: new Date().toISOString(),
      };
      nsp.to(room).emit('preview:pick:lint', lintPayload);
    } catch (err) {
      logger.debug('[PREVIEW_PICK] Lint dry-run failed (background); no lint emit', {
        previewSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

type SuggestedAction = 'click' | 'type' | 'select' | 'hover';

/**
 * Reduce a URL to its "page identity" — origin + pathname, no search,
 * no hash. Used by the navigation watchdog so hash-routing SPAs (Angular,
 * Vue) don't cancel pick on `#/foo` → `#/bar` transitions where the DOM
 * is intact. Falls back to the raw URL on parse errors.
 */
function pageNavKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function inferSuggestedAction(probed: { tag: string; type?: string; role?: string }): SuggestedAction {
  const tag = probed.tag.toLowerCase();
  const role = (probed.role || '').toLowerCase();
  const inputType = (probed.type || '').toLowerCase();

  if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select';
  if (tag === 'textarea') return 'type';
  if (tag === 'input') {
    if (['checkbox', 'radio', 'button', 'submit', 'reset'].includes(inputType)) return 'click';
    return 'type';
  }
  // contenteditable handled as type at fill-time; default to click here for safety.
  return 'click';
}

function buildStructuralDescription(
  probed: {
    tag: string;
    text?: string;
    ariaLabel?: string;
    labelText?: string;
    placeholder?: string;
    title?: string;
    elementId?: string;
    testId?: string;
  },
  action: SuggestedAction,
): string {
  const name =
    probed.labelText
    || probed.ariaLabel
    || probed.text
    || probed.placeholder
    || probed.title
    || probed.testId
    || probed.elementId
    || probed.tag;
  const cleaned = (name || probed.tag).trim().replace(/\s+/g, ' ').slice(0, 80);
  const prefix = action === 'type' ? 'Type into' : action === 'select' ? 'Select' : 'Click';
  return `${prefix} "${cleaned}"`;
}

function emitState(
  nsp: PreviewNamespace,
  previewSessionId: string,
  active: boolean,
  reason: PreviewPickStatePayload['reason'],
  errorMessage?: string,
): void {
  const room = createRoomName('preview', previewSessionId);
  const payload: PreviewPickStatePayload = {
    previewSessionId,
    active,
    reason,
    error: errorMessage,
    timestamp: new Date().toISOString(),
  };
  nsp.to(room).emit('preview:pick:state', payload);
}

// ────────────────────────────────────────────────────────────────────────
// In-page overlay (string template, evaluated in the live page context)
// ────────────────────────────────────────────────────────────────────────

const OVERLAY_ROOT_ID = '__qai_pick_overlay_root';
const OVERLAY_TOOLTIP_ID = '__qai_pick_overlay_tooltip';
const OVERLAY_STATE_KEY = '__qai_pick_state';

/**
 * Builds the script that the page evaluates to enter pick mode.
 *
 * Event blocking matrix (all in capture phase, with stopImmediatePropagation):
 *   pointerdown / mousedown — block focus arrival on inputs, dropdown opens
 *   click / dblclick / auxclick — the actual selection signal (click fires
 *     the callback; the others are blocked silently)
 *   touchstart / touchend / touchcancel — mobile/touchscreen parity
 *   contextmenu — block right-click menu
 *   dragstart — block native HTML5 drag
 *   submit — keyed Enter on a form would otherwise post
 *   focusin — Tab key landing on next element shouldn't shift focus
 *   keydown — block EVERYTHING; Esc additionally tears down. This prevents
 *     Enter/Space on a focused button from triggering activation, and
 *     prevents inadvertent typing into a focused input.
 *   wheel / scroll — NOT blocked; user must be able to scroll to reach
 *     off-screen targets. We listen to `scroll` to repaint the outline.
 */
function buildOverlayScript(callbackName: string): string {
  return `(() => {
    const CB_NAME = ${JSON.stringify(callbackName)};
    const ROOT_ID = ${JSON.stringify(OVERLAY_ROOT_ID)};
    const TOOLTIP_ID = ${JSON.stringify(OVERLAY_TOOLTIP_ID)};
    const STATE_KEY = ${JSON.stringify(OVERLAY_STATE_KEY)};

    // Teardown any previous instance — re-injection is allowed.
    try { (window)[STATE_KEY] && (window)[STATE_KEY].teardown && (window)[STATE_KEY].teardown(); } catch (e) {}

    const existingRoot = document.getElementById(ROOT_ID);
    if (existingRoot) existingRoot.remove();
    const existingTip = document.getElementById(TOOLTIP_ID);
    if (existingTip) existingTip.remove();

    // Defocus whatever the page had focused — otherwise keystrokes we
    // can't fully suppress (e.g. IME composition) leak into the field.
    try {
      const a = document.activeElement;
      if (a && typeof a.blur === 'function' && a !== document.body) a.blur();
    } catch (e) {}

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('style', [
      'position:fixed','left:0','top:0','width:0','height:0',
      'pointer-events:none','z-index:2147483646',
      'box-sizing:border-box',
      'border:2px solid #2563eb',
      'background:rgba(37,99,235,0.08)',
      'transition:all 60ms linear',
      'display:none',
    ].join(';'));

    const tip = document.createElement('div');
    tip.id = TOOLTIP_ID;
    tip.setAttribute('style', [
      'position:fixed','left:0','top:0',
      'pointer-events:none','z-index:2147483647',
      'background:#111827','color:#fff',
      'font:12px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      'padding:4px 8px','border-radius:4px',
      'box-shadow:0 4px 12px rgba(0,0,0,.25)',
      'max-width:320px','white-space:nowrap','overflow:hidden','text-overflow:ellipsis',
      'display:none',
    ].join(';'));

    document.documentElement.appendChild(root);
    document.documentElement.appendChild(tip);

    // ── Shared resolver helpers ─────────────────────────────────────────
    // safeAttr / looksDynamicId / describeElement / hasClickHandler /
    // isInteractive / promoteToClickableRow / elevateLabelToControl /
    // findInteractive. Single source of truth in
    // overlay-resolver-helpers.ts; the hover-overlay service injects the
    // same block so hover outline and pick outline pick the SAME element
    // for any given (x,y).
    ${buildOverlayResolverHelpers()}

    let lastTargetEl = null;
    let lastClientX = 0;
    let lastClientY = 0;

    function paint(el) {
      if (!(el instanceof Element)) { root.style.display = 'none'; tip.style.display = 'none'; return; }
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return; }
      if (!rect || (rect.width === 0 && rect.height === 0)) { root.style.display='none'; tip.style.display='none'; return; }
      root.style.display = 'block';
      root.style.left = rect.left + 'px';
      root.style.top = rect.top + 'px';
      root.style.width = rect.width + 'px';
      root.style.height = rect.height + 'px';

      const label = describeElement(el);
      tip.textContent = label;
      tip.style.display = 'block';
      // Position tooltip just above the target; clamp to viewport.
      // P8 — width heuristic is approximate; max-width:320px CSS caps
      // it for wide-char strings (CJK/emoji) so overflow is impossible.
      const tw = Math.min(320, label.length * 7 + 16);
      let tx = rect.left;
      let ty = rect.top - 22;
      if (ty < 0) ty = rect.bottom + 4;
      if (tx + tw > window.innerWidth) tx = Math.max(0, window.innerWidth - tw - 4);
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    }

    function updateTargetFromPoint(x, y) {
      let realTarget = null;
      try {
        const stack = (typeof document.elementsFromPoint === 'function')
          ? document.elementsFromPoint(x, y)
          : [];
        realTarget = stack && stack.length ? stack[0] : null;
      } catch (e) {}
      if (!(realTarget instanceof Element)) return;
      const target = findInteractive(realTarget) || realTarget;
      if (target === lastTargetEl) return;
      lastTargetEl = target;
      paint(target);
    }

    function onMouseMove(ev) {
      const path = (typeof ev.composedPath === 'function') ? ev.composedPath() : [];
      const realTarget = (path && path.length ? path[0] : ev.target);
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;
      if (!(realTarget instanceof Element)) return;
      const target = findInteractive(realTarget) || realTarget;
      if (target === lastTargetEl) return;
      lastTargetEl = target;
      paint(target);
    }

    function onScroll() {
      // Layout shifted under the cursor — re-resolve the topmost element
      // at the last known cursor coords and re-paint. P12.
      if (!lastTargetEl) return;
      updateTargetFromPoint(lastClientX, lastClientY);
      // Even if the target didn't change, its rect did.
      paint(lastTargetEl);
    }

    function blockEvent(ev) {
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopImmediatePropagation(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}
    }

    function onPointerDown(ev) { blockEvent(ev); }
    function onMouseDown(ev) { blockEvent(ev); }
    function onMouseUp(ev) { blockEvent(ev); }
    function onAuxClick(ev) { blockEvent(ev); }
    function onDblClick(ev) { blockEvent(ev); }
    function onTouchStart(ev) { blockEvent(ev); }
    function onTouchEnd(ev) { blockEvent(ev); }
    function onTouchCancel(ev) { blockEvent(ev); }
    function onDragStart(ev) { blockEvent(ev); }
    function onSubmit(ev) { blockEvent(ev); }
    function onFocusIn(ev) { blockEvent(ev); try { ev.target && ev.target.blur && ev.target.blur(); } catch (e) {} }
    function onContextMenu(ev) { blockEvent(ev); }

    function onClick(ev) {
      blockEvent(ev);
      const x = ev.clientX;
      const y = ev.clientY;
      // Show a brief "✓ Recorded" badge on the chosen element.
      try {
        if (lastTargetEl) {
          const r = lastTargetEl.getBoundingClientRect();
          // P18 — if the element is at the very top, place the badge
          // below it instead so it stays on-screen.
          const above = r.top - 28;
          const top = above >= 0 ? above : Math.min(window.innerHeight - 28, r.bottom + 4);
          const badge = document.createElement('div');
          badge.textContent = '\\u2713 Recorded';
          badge.setAttribute('style', [
            'position:fixed','z-index:2147483647',
            'left:' + Math.max(0, r.left) + 'px','top:' + top + 'px',
            'background:#10b981','color:#fff','padding:4px 8px',
            'border-radius:4px','font:12px/1.4 ui-sans-serif, system-ui, sans-serif',
            'box-shadow:0 4px 12px rgba(0,0,0,.25)','pointer-events:none',
          ].join(';'));
          document.documentElement.appendChild(badge);
          setTimeout(() => { try { badge.remove(); } catch (e) {} }, 1200);
        }
      } catch (e) {}
      try {
        const fn = (window)[CB_NAME];
        if (typeof fn === 'function') fn({ x: x, y: y });
      } catch (e) {}
      // We do NOT teardown the overlay here — the server emits
      // preview:pick:state { active:false, reason:'picked' } and then
      // calls teardownOverlayScript() to remove the overlay from the page.
    }

    function onKeyDown(ev) {
      // P7/P8 — block ALL keydowns. Esc additionally tears down.
      // Without blocking, Enter/Space on a focused button activates it,
      // and typing into a still-focused input pollutes the form.
      blockEvent(ev);
      if (ev.key === 'Escape') {
        try { teardown(); } catch (e) {}
      }
    }
    function onKeyPress(ev) { blockEvent(ev); }
    function onKeyUp(ev) { blockEvent(ev); }

    function teardown() {
      try { document.removeEventListener('pointerdown', onPointerDown, true); } catch(e){}
      try { document.removeEventListener('mousedown', onMouseDown, true); } catch(e){}
      try { document.removeEventListener('mouseup', onMouseUp, true); } catch(e){}
      try { document.removeEventListener('mousemove', onMouseMove, true); } catch(e){}
      try { document.removeEventListener('click', onClick, true); } catch(e){}
      try { document.removeEventListener('dblclick', onDblClick, true); } catch(e){}
      try { document.removeEventListener('auxclick', onAuxClick, true); } catch(e){}
      try { document.removeEventListener('touchstart', onTouchStart, true); } catch(e){}
      try { document.removeEventListener('touchend', onTouchEnd, true); } catch(e){}
      try { document.removeEventListener('touchcancel', onTouchCancel, true); } catch(e){}
      try { document.removeEventListener('dragstart', onDragStart, true); } catch(e){}
      try { document.removeEventListener('submit', onSubmit, true); } catch(e){}
      try { document.removeEventListener('focusin', onFocusIn, true); } catch(e){}
      try { document.removeEventListener('keydown', onKeyDown, true); } catch(e){}
      try { document.removeEventListener('keypress', onKeyPress, true); } catch(e){}
      try { document.removeEventListener('keyup', onKeyUp, true); } catch(e){}
      try { document.removeEventListener('contextmenu', onContextMenu, true); } catch(e){}
      try { window.removeEventListener('scroll', onScroll, true); } catch(e){}
      try { window.removeEventListener('resize', onScroll, true); } catch(e){}
      try { root.remove(); } catch(e){}
      try { tip.remove(); } catch(e){}
      try { delete (window)[STATE_KEY]; } catch (e) {}
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('auxclick', onAuxClick, true);
    document.addEventListener('touchstart', onTouchStart, true);
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchCancel, true);
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keypress', onKeyPress, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    // Repaint the outline on layout shifts so the highlight follows the
    // element when the user scrolls. Passive: yes (we never preventDefault
    // on scroll — user must be able to scroll to reach off-screen targets).
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);

    (window)[STATE_KEY] = { teardown: teardown };
  })();`;
}

function teardownOverlayScript(): string {
  const STATE_KEY = OVERLAY_STATE_KEY;
  return `(() => { try { (window)[${JSON.stringify(STATE_KEY)}] && (window)[${JSON.stringify(STATE_KEY)}].teardown && (window)[${JSON.stringify(STATE_KEY)}].teardown(); } catch (e) {} })();`;
}
