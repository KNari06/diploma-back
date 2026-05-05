/**
 * Preview Handler V7
 * Handles WebSocket events for step editor preview sessions
 * Features:
 * - Ownership enforcement, rate limiting
 * - AI semantic matching, clarification flow
 * - Video stream (CDP screencast) instead of 500ms screenshot polling
 * - DevTools tabs: Console, Network, HTML, Accessibility, Context
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
import {
    ClientToServerEvents,
    createRoomName,
    PreviewIntentStep,
    PreviewLintCandidate,
    PreviewPagePayload,
    ServerToClientEvents,
    SocketData,
} from '../types/types';
import {
    emitSnapshotAlways,
    emitSnapshotForHandshake,
    emitSnapshotIfChanged,
    validateInputRequest,
} from './preview-input-helpers';
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { uploadEditorTrace } from '@/services/testing/ui/preview/editor-trace-upload';
import { webSocketService } from '@/websocket/core/websocket.service';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// Track subscribed preview sessions per socket
const previewSubscriptions = new Map<string, Set<string>>();

// ═══════════════════════════════════════════════════════════════════════════
// RECORDING: Module-level state
// ═══════════════════════════════════════════════════════════════════════════

/** Per-session typing debounce timers */
const recordingTypingTimers = new Map<string, NodeJS.Timeout>();
const RECORDING_TYPING_DEBOUNCE_MS = 1500;

/** Per-socket+session hover probe state (throttle + dedup). Key: `${socketId}:${sessionId}` */
const hoverProbeState = new Map<string, {
  lastProbeAt: number;
  lastElementKey: string | null;
  probeInFlight: boolean;
  pageUrl: string | null; // Guards against stale probe after navigation
  /** Latest mouse coordinates — updated on every mouse:move, used by next probe */
  latestX: number;
  latestY: number;
}>();
const HOVER_PROBE_THROTTLE_MS = 200;

/** Per-session scroll debounce timers */
const recordingScrollTimers = new Map<string, { deltaY: number; deltaX: number; timer: NodeJS.Timeout; containerSelector?: string | null }>();
const RECORDING_SCROLL_DEBOUNCE_MS = 500;
/** V10: Time window (ms) within which consecutive scroll steps merge into one */
const RECORDING_SCROLL_MERGE_WINDOW_MS = 3000;

/**
 * Per-session auto-stop timers for recordings.
 * Parity with the mobile runner's RecordingStateRegistry — caps how long a
 * recording can run unattended so abandoned tabs don't leak Playwright
 * listeners, typing buffers, and editor traces indefinitely. Cleared on
 * manual stop, disconnect, and when the timer itself fires.
 */
const recordingAutoStopTimers = new Map<string, NodeJS.Timeout>();
/**
 * Max recording duration. Mirrors mobile's `RECORDING_MAX_TIME_MS` default
 * (30 min). Override via `WEB_RECORDING_MAX_TIME_MS` env var; set to 0 to
 * disable (e.g., for long-running dev sessions).
 */
const RECORDING_MAX_TIME_MS = (() => {
  const raw = parseInt(process.env.WEB_RECORDING_MAX_TIME_MS || '1800000', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1800000;
})();

/**
 * Max number of NEW steps per recording session. When reached, recording
 * auto-stops with reason 'max_steps' so the user applies the batch (via the
 * existing "Apply All" button) before starting a new recording. Keeps the
 * editor, LLM costs, and compiled-plan persistence in a sane range.
 * Override via `WEB_RECORDING_MAX_STEPS`; set to 0 to disable.
 */
const RECORDING_MAX_STEPS = (() => {
  const raw = parseInt(process.env.WEB_RECORDING_MAX_STEPS || '50', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 50;
})();

/**
 * V20: Per-socket+session move coalescing state.
 * Multiple `preview:mouse:move` events arriving within one event loop tick are
 * collapsed into a single Playwright call with the latest coordinates.
 * Key: `${socketId}:${previewSessionId}`
 */
const moveCoalesceState = new Map<string, {
  latestX: number;
  latestY: number;
  flushScheduled: boolean;
}>();

/**
 * V20: Per-socket+session wheel coalescing state.
 * Multiple `preview:mouse:wheel` events arriving within one event loop tick are
 * accumulated into a single Playwright call with the summed delta.
 * Key: `${socketId}:${previewSessionId}`
 */
const wheelCoalesceState = new Map<string, {
  accDeltaX: number;
  accDeltaY: number;
  lastX: number | undefined;
  lastY: number | undefined;
  flushScheduled: boolean;
}>();

// ═══════════════════════════════════════════════════════════════════════════
// V14: Inter-step delay stamping for recording
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Etap 1D.3 — Fire-and-forget LLM enrichment of a recording step.
 *
 * Called AFTER the synchronous `emitRecordingStep` so the UI never waits
 * on the LLM. When the description is ready (~150-300ms cold, 0ms cached)
 * we emit `preview:recording:step:update` with `{stepId, recordedDescription}`
 * so the editor can show it on the existing step row.
 *
 * Skipped silently for:
 *   - probed elements with no useful descriptors (`generateRecordedDescription`
 *     returns undefined — see hasAnyDescriptor fast-skip in the service)
 *   - LLM failures / timeouts (service swallows; we just see undefined)
 *
 * Never throws — the caller is fire-and-forget (`void scheduleRecordedDescription(...)`).
 */
function scheduleRecordedDescription(
  socket: TypedSocket,
  room: string,
  previewSessionId: string,
  step: import('@/services/testing/ui/preview/preview.types').IntentStep,
  probedElement: import('@/services/testing/ui/preview/recording-capture.service').ProbedElement,
): void {
  // setImmediate so the original emit is fully flushed before we touch
  // the LLM. Eliminates any chance of accidentally blocking the WS write.
  setImmediate(async () => {
    try {
      const { generateRecordedDescription } = await import(
        '@/services/testing/ui/preview/recorded-description-llm.service'
      );
      const description = await generateRecordedDescription(probedElement);
      if (!description) return;
      // Emit the FULL step shape (per `preview:recording:step:update`
      // contract — `PreviewRecordingStepPayload.step` is `PreviewIntentStep`,
      // not a partial). Frontend replaces the row by id; sending only
      // {id, recordedDescription} would clobber other fields with
      // undefined.
      socket.nsp.to(room).emit('preview:recording:step:update', {
        previewSessionId,
        step: { ...step, recordedDescription: description } as any,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Defensive — generateRecordedDescription already swallows internally,
      // but a top-level catch here protects against import-time errors.
      logger.warn('[RECORDING] Recorded-description hook failed', {
        previewSessionId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Emit a NEW recording step with inter-step delay stamping.
 * Replaces direct `socket.nsp.to(room).emit('preview:recording:step', ...)` calls.
 * Automatically computes and stamps interStepDelayMs on the step's evidence.
 */
function emitRecordingStep(
  socket: TypedSocket,
  room: string,
  sessionService: ReturnType<typeof import('@/services/testing/ui/preview/preview-session.service').getPreviewSessionService>,
  previewSessionId: string,
  userId: string,
  payload: { step: Record<string, any>; highlight?: any; timestamp?: string; previewSessionId?: string },
): void {
  try {
    sessionService.stampInterStepDelay(previewSessionId, userId, payload.step);
  } catch { /* non-critical — don't break recording */ }

  // V15: Stamp tabIndex on every recording step so run mode knows which tab to target
  try {
    const session = sessionService.getSession(previewSessionId);
    if (session && payload.step && payload.step.tabIndex === undefined) {
      payload.step.tabIndex = session.activeTabIndex;
    }
  } catch { /* non-critical */ }

  // Coalescing-chain breakers. For each type of `recordingLast*Step`, if the
  // incoming step is NOT of the matching kind, we clear that chain so the
  // next occurrence starts a fresh series. Callers emitting the matching
  // kind are responsible for re-seeding (or reusing) their own chain.
  try {
    const kind = payload.step?.type;
    if (kind !== 'press') {
      sessionService.setRecordingLastPressStep(previewSessionId, userId, null);
    }
    if (kind !== 'click' && kind !== 'dblclick') {
      sessionService.setRecordingLastClickStep(previewSessionId, userId, null);
    }
    if (kind !== 'navigate') {
      sessionService.setRecordingLastNavigateStep(previewSessionId, userId, null);
    }
  } catch { /* non-critical */ }

  // Increment the session step counter. We do this in the single emit helper
  // (rather than 20+ call sites) so the number stays accurate. Merge updates
  // go via `preview:recording:step:update` which does NOT route through here.
  let stepCount = 0;
  try {
    stepCount = sessionService.incrementRecordingStepCount(previewSessionId, userId);
  } catch { /* non-critical */ }

  socket.nsp.to(room).emit('preview:recording:step', {
    previewSessionId,
    ...payload,
    stepCount,
    timestamp: payload.timestamp || new Date().toISOString(),
  } as any);

  // Max-steps auto-stop. Fires exactly once when the count reaches the cap so
  // the user is forced to "Apply All" before recording more. Non-blocking —
  // schedule on microtask so we don't race the just-emitted step on the wire.
  if (RECORDING_MAX_STEPS > 0 && stepCount >= RECORDING_MAX_STEPS) {
    queueMicrotask(() => {
      void finalizeRecording(socket, previewSessionId, userId, 'max_steps').catch((err) => {
        logger.error('[RECORDING] Max-steps finalize failed', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }
}

/**
 * Flush pending scroll timer for a session.
 * Emits accumulated scroll as a recording step (or merges with previous scroll step).
 * Call BEFORE emitting another step to preserve correct step order.
 */
async function flushPendingScroll(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string,
  sessionService: ReturnType<typeof import('@/services/testing/ui/preview/preview-session.service').getPreviewSessionService>,
  source: string,
): Promise<void> {
  const pendingScroll = recordingScrollTimers.get(previewSessionId);
  if (!pendingScroll) return;

  clearTimeout(pendingScroll.timer);
  recordingScrollTimers.delete(previewSessionId);
  if (pendingScroll.deltaY === 0 && pendingScroll.deltaX === 0) return;

  try {
    const { RecordingCaptureService } = await import('@/services/testing/ui/preview/recording-capture.service');
    const scrollPage = sessionService.getPage(previewSessionId, userId);
    const scrollPageUrl = scrollPage?.url();
    if (!scrollPageUrl || scrollPageUrl === 'about:blank') return;

    let scrollTargetHints: import('@/services/testing/ui/preview/preview.types').BindingHints | null = null;
    if (scrollPage) {
      try { scrollTargetHints = await RecordingCaptureService.probeScrollTarget(scrollPage); } catch { /* non-critical */ }
    }

    const room = createRoomName('preview', previewSessionId);
    const lastScrollStep = sessionService.getRecordingLastScrollStep(previewSessionId, userId);
    const now = Date.now();
    const withinMergeWindow = lastScrollStep && (now - lastScrollStep.emittedAt) < RECORDING_SCROLL_MERGE_WINDOW_MS;

    const flushContainerSel = pendingScroll.containerSelector ?? null;

    if (withinMergeWindow && lastScrollStep) {
      const mergedDelta = lastScrollStep.totalDelta + pendingScroll.deltaY;
      const mergedDeltaX = (lastScrollStep.totalDeltaX || 0) + pendingScroll.deltaX;
      const scrollStep = RecordingCaptureService.captureScroll(mergedDelta, scrollPageUrl, mergedDeltaX, scrollTargetHints ?? undefined, flushContainerSel);
      if (scrollStep) {
        scrollStep.id = lastScrollStep.id;
        socket.nsp.to(room).emit('preview:recording:step:update', { previewSessionId, step: scrollStep, timestamp: new Date().toISOString() });
        sessionService.setRecordingLastScrollStep(previewSessionId, userId, { id: lastScrollStep.id, totalDelta: mergedDelta, totalDeltaX: mergedDeltaX, emittedAt: now });
      }
    } else {
      const scrollStep = RecordingCaptureService.captureScroll(pendingScroll.deltaY, scrollPageUrl, pendingScroll.deltaX, scrollTargetHints ?? undefined, flushContainerSel);
      if (scrollStep) {
        emitRecordingStep(socket, room, sessionService, previewSessionId, userId, { step: scrollStep });
        const fTrace = EditorTraceService.get(previewSessionId);
        if (fTrace) fTrace.writeStepCaptured(scrollStep, `scroll_flush_${source}`);
        sessionService.setRecordingLastScrollStep(previewSessionId, userId, { id: scrollStep.id, totalDelta: pendingScroll.deltaY, totalDeltaX: pendingScroll.deltaX, emittedAt: now });
      }
    }
  } catch { /* non-critical — don't block caller */ }
}

/**
/**
 * V22 Pkg8: Close the active Field Session — read the LIVE input value
 * (single source of truth) and emit a single Type step with the canonical
 * final value, regardless of what physical events the user generated
 * inside the focus span (typing, backspace, arrow-key navigation, mid-
 * string edits, paste, autocomplete picks).
 *
 * Lifecycle contract:
 *   - Caller must invoke BEFORE emitting any non-typing step (click,
 *     scroll, navigate, etc.) so step order is preserved.
 *   - Idempotent — no-op if no session open.
 *   - When emittedStepId is set (subsequent re-reads), dispatches
 *     `preview:recording:step:update` to merge into the existing UI list
 *     entry. Otherwise emits a fresh `preview:recording:step:capture`.
 *   - When the live value reverted to initialValue (user typed-and-undid),
 *     removes the previously-emitted step via `step:remove` to keep the
 *     trace clean. No step is emitted on first close-with-no-change.
 *   - All async work is awaited — caller should `await closeFieldSession(...)`.
 */
async function closeFieldSession(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string,
  sessionService: ReturnType<typeof import('@/services/testing/ui/preview/preview-session.service').getPreviewSessionService>,
  source: string,
): Promise<void> {
  const fs = sessionService.getRecordingFieldSession(previewSessionId, userId);
  if (!fs) return;
  // Always clear session state FIRST so re-entry during live-value read
  // cannot loop. Page evaluate may take ms-scale time during which the
  // user might fire another focus event — we don't want a recursive close.
  sessionService.setRecordingFieldSession(previewSessionId, userId, null);

  const room = createRoomName('preview', previewSessionId);
  const fTrace = EditorTraceService.get(previewSessionId);
  try {
    const page = sessionService.getPage(previewSessionId, userId);
    if (!page) return;
    // Read live value via Playwright. inputValue() works for input/textarea/
    // select; for contenteditable we read textContent. We pick by tag, not
    // by isMultiline alone, because <select multiple> is also "multiline"
    // semantically but uses .value/inputValue.
    let liveValue: string | null = null;
    try {
      // Use the recorded ref-attribute to relocate the element. The
      // data-agent-ref is injected during recording; if it's absent now
      // (DOM rebuilt), liveValue stays null and we fall back to the
      // initialValue diff (no step emitted).
      const tag = (fs.elementTag || '').toLowerCase();
      const refSel = `[data-agent-ref="${fs.elementRef}"]`;
      const locator = page.locator(refSel).first();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        // inputValue() throws for non-form controls; guarded by tag check.
        liveValue = await locator.inputValue({ timeout: 500 });
      } else {
        // contenteditable / div role=textbox path — read textContent.
        liveValue = await locator.evaluate((el: any) => el?.textContent || '', undefined, { timeout: 500 });
      }
    } catch (err) {
      // Element gone, ref stale, or read timeout — degrade gracefully:
      // no live value means we can't be sure of the final state, so we
      // skip the emission. The legacy buffer-based path may have already
      // captured an approximate step earlier.
      if (fTrace) fTrace.writeStepCaptured(
        { id: 'fs-fail', type: 'type', description: `[FieldSession ${source}] live read failed` } as any,
        'field_session_read_fail',
      );
      return;
    }

    if (liveValue === null) return;
    if (liveValue === fs.initialValue) {
      // No net change. If we previously emitted a Type step (user typed
      // then deleted everything), remove it to keep the trace clean.
      if (fs.emittedStepId) {
        const stepCount = sessionService.decrementRecordingStepCount(previewSessionId, userId);
        socket.nsp.to(room).emit('preview:recording:step:remove', {
          previewSessionId, stepId: fs.emittedStepId, stepCount, timestamp: new Date().toISOString(),
        });
        if (fTrace) fTrace.writeStepRemoved(fs.emittedStepId, 'field_session_no_change');
      }
      return;
    }

    // Build the Type step. Use buildBindingHints from the recorded
    // fingerprint so resolver has identifying data on first apply.
    const { RecordingCaptureService } = await import(
      '@/services/testing/ui/preview/recording-capture.service'
    );
    const truncatedValue = liveValue.length > 500 ? liveValue.slice(0, 500) : liveValue;
    const description = `Type '${truncatedValue.slice(0, 40)}' in '${fs.elementLabel || 'element'}'`;
    const recStepIdLocal = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const step: any = {
      id: fs.emittedStepId || recStepIdLocal,
      type: 'type',
      description,
      value: truncatedValue,
      // V22 Pkg8: bindingHints were pre-built at open time via
      // buildBindingHints (semantic locator hints — role/label/text/testId
      // /etc). recordedFingerprint travels separately as the structural
      // fingerprint snapshot. The two have intentionally different shapes
      // — see TargetFingerprint vs BindingHints in preview.types.ts.
      bindingHints: fs.bindingHints,
      recordedFingerprint: fs.recordedFingerprint,
      // Forward the input's `type` attribute (e.g. 'password', 'email') so
      // downstream consumers like preview:save-login can redact / move
      // sensitive values into the encrypted resource envelope. Pure
      // metadata — never affects replay.
      ...(fs.elementType ? { recordedInputType: fs.elementType } : {}),
      evidence: {
        pageUrl: fs.pageUrl,
      },
    };

    if (fs.emittedStepId) {
      // Update existing — fold subsequent edits into the same list entry.
      socket.nsp.to(room).emit('preview:recording:step:update', {
        previewSessionId, step, timestamp: new Date().toISOString(),
      });
      if (fTrace) fTrace.writeStepUpdated(step, `field_session_update_${source}`);
    } else {
      // First-time emit — set the id BEFORE the emit so subsequent updates
      // (in case the same session re-opens) can find it.
      // Use emitRecordingStep so step counter / inter-step delay tracking
      // run consistently with other capture paths.
      emitRecordingStep(socket, room, sessionService, previewSessionId, userId, { step });
      if (fTrace) fTrace.writeStepCaptured(step, `field_session_close_${source}`);
    }

    // Mirror to legacy lastTypeStep so that ANY subsequent legacy code
    // path (typing buffer flush during the same session) doesn't create
    // a duplicate step. Once Field Session is the sole path this can be
    // removed; for now the dual-path safety prevents regressions.
    sessionService.setRecordingLastTypeStep(previewSessionId, userId, {
      id: step.id,
      elementRef: fs.elementRef,
      value: truncatedValue,
    });
  } catch (err) {
    if (fTrace) fTrace.writeStepCaptured(
      { id: 'fs-err', type: 'type', description: `[FieldSession ${source}] error` } as any,
      'field_session_close_error',
    );
  }
}

/**
 * Flush pending typing buffer for a session.
 * Emits accumulated text as a recording step (or merges with previous type step).
 * Call BEFORE emitting another step to preserve correct step order.
 */
function flushPendingTyping(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string,
  sessionService: ReturnType<typeof import('@/services/testing/ui/preview/preview-session.service').getPreviewSessionService>,
  RecordingCaptureService: typeof import('@/services/testing/ui/preview/recording-capture.service').RecordingCaptureService,
  source: string,
): void {
  const buffer = sessionService.getRecordingBuffer(previewSessionId, userId);
  if (!buffer) return;
  // V22 Pkg8: when a Field Session is active, the canonical Type step has
  // ALREADY been (or will be) emitted via closeFieldSession with the live
  // input.value. Skip the legacy buffer-based emission here to prevent a
  // duplicate step. We still clear the buffer so it doesn't leak to the
  // next field. The Field Session close runs on its own lifecycle hooks
  // (click / nav / stop) — caller invokes both helpers in sequence.
  const activeFieldSession = sessionService.getRecordingFieldSession(previewSessionId, userId);
  if (activeFieldSession) {
    sessionService.setRecordingBuffer(previewSessionId, userId, null);
    const timer = recordingTypingTimers.get(previewSessionId);
    if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
    return;
  }

  const room = createRoomName('preview', previewSessionId);
  const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, userId);
  const sameElement = lastTypeStep && buffer.elementRef && lastTypeStep.elementRef === buffer.elementRef;
  const fTrace = EditorTraceService.get(previewSessionId);

  if (sameElement && lastTypeStep) {
    const mergedValue = lastTypeStep.value + buffer.text;
    const typingStep = RecordingCaptureService.flushTypingBuffer({ ...buffer, text: mergedValue });
    if (typingStep) {
      typingStep.id = lastTypeStep.id;
      socket.nsp.to(room).emit('preview:recording:step:update', { previewSessionId, step: typingStep, timestamp: new Date().toISOString() });
      if (fTrace) fTrace.writeStepUpdated(typingStep, `type_merge_${source}`);
    }
  } else {
    const typingStep = RecordingCaptureService.flushTypingBuffer(buffer);
    if (typingStep) {
      emitRecordingStep(socket, room, sessionService, previewSessionId, userId, { step: typingStep });
      if (fTrace) fTrace.writeStepCaptured(typingStep, `type_flush_${source}`);
    }
  }

  sessionService.setRecordingLastTypeStep(previewSessionId, userId, null);
  sessionService.setRecordingBuffer(previewSessionId, userId, null);
  const timer = recordingTypingTimers.get(previewSessionId);
  if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
}

/**
 * Shared finalizer for a recording session. Flushes pending typing/scroll
 * buffers, removes injected page listeners, clears auto-stop/debounce timers,
 * resets dialog mode, closes the editor trace, and broadcasts
 * `preview:recording:state { recording: false, reason? }` to the room.
 *
 * Called by:
 *   - `preview:recording:stop` socket handler (reason = 'user')
 *   - `preview:run:start` socket handler when a recording is still live
 *     (reason = 'user', intentTestCaseId is forwarded to the trace uploader
 *     so the trace file gets attached to the run)
 *   - auto-stop timer when RECORDING_MAX_TIME_MS elapses (reason = 'max_time')
 *   - emitRecordingStep once the step counter hits RECORDING_MAX_STEPS
 *     (reason = 'max_steps')
 *
 * The disconnect handler does its own best-effort cleanup (the socket is
 * already gone, so there's nobody to broadcast to) and does not call this.
 *
 * Idempotent: safe to call when recording is already false (just no-ops).
 */
async function finalizeRecording(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string,
  reason: 'user' | 'max_time' | 'max_steps',
  intentTestCaseId?: string,
): Promise<void> {
  const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
  const sessionService = getPreviewSessionService();

  if (!sessionService.isRecording(previewSessionId, userId)) return;

  const room = createRoomName('preview', previewSessionId);

  // Always clear the auto-stop timer first so it can't fire mid-finalize.
  const autoStopTimer = recordingAutoStopTimers.get(previewSessionId);
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    recordingAutoStopTimers.delete(previewSessionId);
  }

  const finalizeTrace = EditorTraceService.get(previewSessionId);

  // V22 Pkg8: close any active Field Session FIRST. Reads live input.value
  // for canonical Type step. Runs before legacy buffer flush so the legacy
  // path becomes a no-op (the lastTypeStep mirror is set inside close).
  await closeFieldSession(socket, previewSessionId, userId, sessionService, `stop_${reason}`);

  // Flush pending typing buffer (with merge logic).
  const buffer = sessionService.getRecordingBuffer(previewSessionId, userId);
  if (buffer) {
    const { RecordingCaptureService } = await import(
      '@/services/testing/ui/preview/recording-capture.service'
    );
    const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, userId);
    const sameElement = lastTypeStep && buffer.elementRef && lastTypeStep.elementRef === buffer.elementRef;

    if (sameElement && lastTypeStep) {
      const mergedValue = lastTypeStep.value + buffer.text;
      const step = RecordingCaptureService.flushTypingBuffer({ ...buffer, text: mergedValue });
      if (step) {
        step.id = lastTypeStep.id;
        socket.nsp.to(room).emit('preview:recording:step:update', {
          previewSessionId, step, timestamp: new Date().toISOString(),
        });
        if (finalizeTrace) finalizeTrace.writeStepUpdated(step, `type_merge_on_stop_${reason}`);
      }
    } else {
      const step = RecordingCaptureService.flushTypingBuffer(buffer);
      if (step) {
        emitRecordingStep(socket, room, sessionService, previewSessionId, userId, { step });
        if (finalizeTrace) finalizeTrace.writeStepCaptured(step, `type_flush_on_stop_${reason}`);
      }
    }
    sessionService.setRecordingLastTypeStep(previewSessionId, userId, null);
    sessionService.setRecordingBuffer(previewSessionId, userId, null);
  }

  // Clear typing debounce timer.
  const typingTimer = recordingTypingTimers.get(previewSessionId);
  if (typingTimer) {
    clearTimeout(typingTimer);
    recordingTypingTimers.delete(previewSessionId);
  }

  // Clear scroll timer and flush (with merge logic).
  const scrollState = recordingScrollTimers.get(previewSessionId);
  if (scrollState) {
    clearTimeout(scrollState.timer);
    recordingScrollTimers.delete(previewSessionId);

    const { RecordingCaptureService: RecCapSvcScroll } = await import(
      '@/services/testing/ui/preview/recording-capture.service'
    );
    const stopScrollPage = sessionService.getPage(previewSessionId, userId);
    const stopScrollPageUrl = stopScrollPage?.url();

    const lastScrollStep = sessionService.getRecordingLastScrollStep(previewSessionId, userId);
    const withinMergeWindow = lastScrollStep && (Date.now() - lastScrollStep.emittedAt) < RECORDING_SCROLL_MERGE_WINDOW_MS;

    if (withinMergeWindow && lastScrollStep) {
      const mergedDelta = lastScrollStep.totalDelta + scrollState.deltaY;
      const mergedDeltaX = (lastScrollStep.totalDeltaX || 0) + (scrollState.deltaX || 0);
      const scrollStep = RecCapSvcScroll.captureScroll(mergedDelta, stopScrollPageUrl, mergedDeltaX);
      if (scrollStep) {
        scrollStep.id = lastScrollStep.id;
        socket.nsp.to(room).emit('preview:recording:step:update', {
          previewSessionId, step: scrollStep, timestamp: new Date().toISOString(),
        });
        if (finalizeTrace) finalizeTrace.writeStepUpdated(scrollStep, `scroll_merge_on_stop_${reason}`);
      }
    } else {
      const scrollStep = RecCapSvcScroll.captureScroll(scrollState.deltaY, stopScrollPageUrl, scrollState.deltaX);
      if (scrollStep) {
        emitRecordingStep(socket, room, sessionService, previewSessionId, userId, { step: scrollStep });
        if (finalizeTrace) finalizeTrace.writeStepCaptured(scrollStep, `scroll_flush_on_stop_${reason}`);
      }
    }
    sessionService.setRecordingLastScrollStep(previewSessionId, userId, null);
  }

  // Remove injected page listeners.
  const page = sessionService.getPage(previewSessionId, userId);
  if (page) {
    try {
      const { RecordingCaptureService } = await import(
        '@/services/testing/ui/preview/recording-capture.service'
      );
      await RecordingCaptureService.removeSelectChangeListener(page);
      const loadHandler = (page as any).__qai_recording_load_handler;
      if (loadHandler) {
        page.off('load', loadHandler);
        delete (page as any).__qai_recording_load_handler;
      }
      const fcHandler = (page as any).__qai_recording_filechooser_handler;
      if (fcHandler) {
        page.off('filechooser', fcHandler);
        delete (page as any).__qai_recording_filechooser_handler;
      }
      // Drop any still-open inline upload prompts — matches the
      // `preview:recording:stop` socket handler path. Covers auto-stop
      // (max_time / max_steps / run:start) where the user never pressed
      // Stop manually.
      cancelPendingUploadsForSession(previewSessionId, (stepId) => {
        try {
          socket.nsp.to(room).emit('preview:recording:step:remove', {
            previewSessionId,
            stepId,
            timestamp: new Date().toISOString(),
          } as any);
        } catch { /* non-critical */ }
      });
      await RecordingCaptureService.removeAutofillListener(page).catch(() => {});
      const autofillHandler = (page as any).__qai_recording_autofill_handler;
      if (autofillHandler) {
        page.off('load', autofillHandler);
        delete (page as any).__qai_recording_autofill_handler;
      }
    } catch {
      // Page may be closed already — not fatal.
    }
  }

  sessionService.setRecording(previewSessionId, userId, false);
  sessionService.setDialogMode(previewSessionId, userId, 'passive');

  // Editor trace: log stop reason and close writer. When a test-case id is
  // supplied (run:start path), forward it so the uploaded trace is linked
  // to the run that triggered the stop.
  const traceOnStop = EditorTraceService.get(previewSessionId);
  if (traceOnStop) {
    traceOnStop.writeRecordingStop(reason);
    EditorTraceService.close(previewSessionId).then((meta) => {
      if (meta) uploadEditorTrace({
        filePath: meta.filePath,
        userId: meta.userId,
        previewSessionId,
        traceType: 'editor',
        ...(intentTestCaseId ? { intentTestCaseId } : {}),
      }).catch((err) => logger.error('[EDITOR_TRACE] Upload failed on recording:stop', { previewSessionId, reason, error: err instanceof Error ? err.message : String(err) }));
    }).catch((err) => logger.error('[EDITOR_TRACE] Close failed on recording:stop', { previewSessionId, reason, error: err instanceof Error ? err.message : String(err) }));
  }

  socket.nsp.to(room).emit('preview:recording:state', {
    previewSessionId,
    recording: false,
    // Only forward server-initiated reasons — 'user' stays implicit so we
    // don't mis-trigger the frontend's auto-stop toast on an explicit click.
    ...(reason === 'max_time' || reason === 'max_steps' ? { reason } : {}),
    timestamp: new Date().toISOString(),
  });

  logger.info('[RECORDING] Stopped', { previewSessionId, userId, reason });
}

// ═══════════════════════════════════════════════════════════════════════════
// V7: Video + DevTools streaming registry
// ═══════════════════════════════════════════════════════════════════════════

// Subscriber refcount per room (preview:<sessionId>)
const previewRoomRefCount = new Map<string, number>();

// Stream context to remember userId/room for streams
interface StreamContext {
  previewSessionId: string;
  userId: string;
  room: string;
}
const previewStreamContext = new Map<string, StreamContext>();

// DOM update interval for preview:page (check every 500ms, emit only on change)
const DOM_UPDATE_INTERVAL_MS = 500;
const activeDomUpdateIntervals = new Map<string, NodeJS.Timeout>();
const activeDomUpdateTicks = new Set<string>();

/**
 * Acquire per-session DOM tick guard.
 * Returns true when the current tick is allowed to run.
 */
export function acquireDomTickGuard(previewSessionId: string, inFlight: Set<string>): boolean {
  if (inFlight.has(previewSessionId)) {
    return false;
  }
  inFlight.add(previewSessionId);
  return true;
}

/**
 * Release per-session DOM tick guard.
 */
export function releaseDomTickGuard(previewSessionId: string, inFlight: Set<string>): void {
  inFlight.delete(previewSessionId);
}

/**
 * Confirm whether user actually selected file(s) after filechooser opened.
 * filechooser event fires on dialog open, including cancel path.
 */
export async function waitForFileSelectionConfirmation(
  element: { evaluate: <T>(fn: (el: { files?: { length: number } | null }) => T) => Promise<T> },
  wait: (ms: number) => Promise<void>,
  maxAttempts = 50,
  intervalMs = 100,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const hasSelectedFiles = await element
      .evaluate((el) => (el.files?.length || 0) > 0)
      .catch(() => false);
    if (hasSelectedFiles) {
      return true;
    }
    await wait(intervalMs).catch(() => {});
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// V3: Pending clarifications cache
// ═══════════════════════════════════════════════════════════════════════════
interface PendingClarification {
  candidates: PreviewLintCandidate[];
  stepDraft: PreviewIntentStep;
  userId: string;
  timestamp: number;
}

// Key: `${previewSessionId}:${stepId}` -> PendingClarification
const pendingClarifications = new Map<string, PendingClarification>();

// ═══════════════════════════════════════════════════════════════════════════
// V3: Confirmed selections cache (after user picks from clarify options)
// Used by apply to skip re-linting and use user's choice directly
// ═══════════════════════════════════════════════════════════════════════════
interface ConfirmedSelection {
  selectedRef: string;
  userId: string;
  timestamp: number;
}

// Key: `${previewSessionId}:${stepId}` -> ConfirmedSelection
const confirmedSelections = new Map<string, ConfirmedSelection>();

// Cleanup old clarifications and selections (older than 5 minutes)
const CLARIFICATION_TTL_MS = 5 * 60 * 1000;

const clarificationCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingClarifications) {
    if (now - value.timestamp > CLARIFICATION_TTL_MS) {
      pendingClarifications.delete(key);
    }
  }
  // Also cleanup confirmed selections
  for (const [key, value] of confirmedSelections) {
    if (now - value.timestamp > CLARIFICATION_TTL_MS) {
      confirmedSelections.delete(key);
    }
  }
}, 60 * 1000); // Check every minute
clarificationCleanupInterval.unref?.();

// ═══════════════════════════════════════════════════════════════════════════
// Pending inline-upload prompts
// ───────────────────────────────────────────────────────────────────────────
// When a `filechooser` event fires during recording we DO NOT wait for the
// native OS dialog. Instead we park the fileChooser + metadata here, emit
// `preview:recording:upload:prompt` to the UI, and wait for the user's
// choice (resolve / cancel) via a matching WS event. Keyed by `stepId` so
// the frontend's placeholder step maps 1:1 to the held chooser.
//
// Old native-dialog flow is still the path that produced this event — we
// just intercept before `waitForFileSelectionConfirmation`. Native cancel
// is handled by the `setFiles([])` call on UI cancel/timeout.
// ═══════════════════════════════════════════════════════════════════════════
interface PendingUploadPrompt {
  previewSessionId: string;
  userId: string;
  /** Playwright FileChooser object — kept live until resolve/cancel. */
  fileChooser: { setFiles: (files: string | string[]) => Promise<void>; isMultiple?: () => boolean };
  /** Probed element hints (for binding on the final captured step). Typed
   *  as `any` here because `ProbedElement` isn't imported in this handler
   *  module; values flow straight into RecCapSvc.captureFileUpload. */
  probedEl: any | null;
  pageUrl?: string;
  /** Auto-cancel timer — clears on resolve/cancel/recording-stop. */
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

// Key: stepId (unique across sessions — generated via randomUUID)
const pendingUploadPrompts = new Map<string, PendingUploadPrompt>();

/** Server-side timeout for the inline upload picker. After this we drop the
 *  native dialog and warn the UI. 60s is comfortable for users picking from
 *  a real file system; shorter windows caused regressions in QA. */
const UPLOAD_PROMPT_TIMEOUT_MS = 60_000;

/**
 * Cancel every pending upload prompt attached to a preview session. Called
 * on recording stop / finalizeRecording so stale FileChooser handles don't
 * leak and the UI's placeholder steps get cleaned up.
 */
function cancelPendingUploadsForSession(
  previewSessionId: string,
  emitWarnTo: ((stepId: string, reason: 'no_file_selected') => void) | null,
): void {
  for (const [stepId, pending] of pendingUploadPrompts) {
    if (pending.previewSessionId !== previewSessionId) continue;
    clearTimeout(pending.timeout);
    // Best-effort dismiss — Playwright requires setFiles to be called exactly
    // once; `[]` dismisses the native dialog cleanly.
    pending.fileChooser.setFiles([]).catch(() => { /* page may be closed */ });
    pendingUploadPrompts.delete(stepId);
    if (emitWarnTo) emitWarnTo(stepId, 'no_file_selected');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V2: Rate limiting
// ═══════════════════════════════════════════════════════════════════════════
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Rate limits per socket (events per window)
const RATE_LIMITS = {
  lint: { max: 30, windowMs: 10000 },     // 30 lint requests per 10s
  apply: { max: 10, windowMs: 10000 },    // 10 apply requests per 10s
  subscribe: { max: 5, windowMs: 10000 }, // 5 subscribes per 10s
  mouse: { max: 100, windowMs: 10000 },   // 100 mouse events per 10s
  // Typing can be bursty (frontend sends per-keystroke type/press events),
  // so keep this high enough to avoid UX throttling while still preventing abuse.
  keyboard: { max: 600, windowMs: 10000 }, // 600 keyboard events per 10s
  pageAction: { max: 5, windowMs: 10000 }, // 5 refresh/reset per 10s
};

const rateLimitStore = new Map<string, Map<string, RateLimitEntry>>();

/**
 * Check and update rate limit for a socket/action
 */
function checkRateLimit(socketId: string, action: keyof typeof RATE_LIMITS): boolean {
  const limit = RATE_LIMITS[action];
  const now = Date.now();

  let socketLimits = rateLimitStore.get(socketId);
  if (!socketLimits) {
    socketLimits = new Map();
    rateLimitStore.set(socketId, socketLimits);
  }

  let entry = socketLimits.get(action);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + limit.windowMs };
    socketLimits.set(action, entry);
  }

  if (entry.count >= limit.max) {
    return false; // Rate limited
  }

  entry.count++;
  return true; // Allowed
}

/**
 * Cleanup rate limit data for a socket
 */
function cleanupRateLimits(socketId: string): void {
  rateLimitStore.delete(socketId);
}

/**
 * Emit action result for page actions (refresh/reset/back/forward)
 */
function emitPageActionResult(
  socket: TypedSocket,
  previewSessionId: string,
  action: 'refresh' | 'reset' | 'back' | 'forward',
  success: boolean,
  error?: string
): void {
  socket.emit('preview:page:action:result', {
    previewSessionId,
    action,
    success,
    error,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get preview subscriptions for a socket
 */
const getPreviewSubs = (socketId: string): Set<string> => {
  const existing = previewSubscriptions.get(socketId);
  if (existing) return existing;
  const created = new Set<string>();
  previewSubscriptions.set(socketId, created);
  return created;
};

/**
 * Cleanup preview subscriptions on disconnect
 */
const cleanupPreviewSubscriptions = (socketId: string): void => {
  previewSubscriptions.delete(socketId);
};

/**
 * Start video stream + DevTools collectors for a preview session
 * - Video: CDP screencast ~10 fps
 * - DOM updates: preview:page only on change
 * - DevTools: Console/Network push, HTML/Accessibility on-demand
 */
const startPreviewStreams = async (context: StreamContext, nsp: any): Promise<void> => {
  const { previewSessionId, userId, room } = context;

  // Don't start if already streaming
  if (activeDomUpdateIntervals.has(previewSessionId)) {
    return;
  }

  previewStreamContext.set(previewSessionId, context);

  try {
    const { getPreviewSessionService, getPreviewVideoStreamRegistry, getPreviewDevToolsRegistry } =
      await import('@/services/testing/ui/preview');
    const sessionService = getPreviewSessionService();
    const videoRegistry = getPreviewVideoStreamRegistry();
    const devtoolsRegistry = getPreviewDevToolsRegistry();

    // Get page from session
    const page = sessionService.getPage(previewSessionId, userId);
    if (!page) {
      logger.warn('[PREVIEW_STREAM] No page found for session', { previewSessionId });
      return;
    }

    // Start video stream (CDP screencast)
    const videoStarted = await videoRegistry.startStream(previewSessionId, userId, room, page, nsp);
    if (videoStarted) {
      logger.info('[PREVIEW_STREAM] Video stream started', { previewSessionId, room });
    }

    // Start DevTools collectors (console/network push)
    devtoolsRegistry.start(previewSessionId, room, page, nsp);

    // V15: Emit initial tab list so frontend can render tab bar
    try {
      const tabsInfo = sessionService.getTabsInfo(previewSessionId, userId);
      const session = sessionService.getSession(previewSessionId);
      nsp.to(room).emit('preview:tab:list', {
        previewSessionId,
        tabs: tabsInfo,
        activeTabIndex: session?.activeTabIndex ?? 0,
        timestamp: new Date().toISOString(),
      });
    } catch { /* non-critical */ }

    // Start DOM update interval (emit preview:page only on change)
    const domInterval = setInterval(async () => {
      if (!acquireDomTickGuard(previewSessionId, activeDomUpdateTicks)) {
        return;
      }
      try {
        // V21: Early exit if the session was torn down since this tick was
        // scheduled. Without this, the interval races with stopSession() —
        // the tick fires, calls getSnapshot() → page.evaluate() on an
        // already-closed page, and Playwright throws
        // "Target page, context or browser has been closed" which used to
        // land in error.log on every session close. Check both the session
        // record AND the page object to cover partial tear-down states.
        const liveSession = sessionService.getSession(previewSessionId);
        if (!liveSession || !liveSession.page || liveSession.page.isClosed()) {
          return;
        }

        // Skip snapshot collection during run mode — run loop manages its own state,
        // frontend only uses preview:run:step events, and video stream is independent.
        // Avoids page.evaluate() contention with step apply/readiness checks.
        try {
          const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
          if (PreviewRunService.isRunning(previewSessionId)) {
            return;
          }
        } catch { /* non-critical — continue with snapshot if import fails */ }

        const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
          onlyIfChanged: true, // Only return full data if changed
        });

        if (snapshot && snapshot.changed) {
          // V20: Second-level dedup — even though getSnapshot returned changed=true
          // against `lastPageSignature`, another emit site (click, apply, subscribe)
          // may have already pushed this exact signature to the wire. Compare against
          // `lastEmittedSignature` before sending to avoid a double-emit race.
          const lastEmitted = sessionService.getLastEmittedSignature(previewSessionId, userId);
          if (lastEmitted && snapshot.pageSignature === lastEmitted) {
            // Still bump video stream's domVersion pointer and bail.
            videoRegistry.setDomVersion(previewSessionId, snapshot.domVersion);
          } else {
            const payload: PreviewPagePayload = {
              previewSessionId,
              url: snapshot.url,
              pageTitle: snapshot.pageTitle,
              domVersion: snapshot.domVersion,
              pageSignature: snapshot.pageSignature,
              domNodes: snapshot.domNodes, // Only included when changed
              timestamp: new Date().toISOString(),
            };

            // Emit to entire room
            nsp.to(room).emit('preview:page', payload);

            // V20: Record the signature so subsequent emit sites can dedup
            sessionService.markEmittedSignature(previewSessionId, userId, snapshot.pageSignature);

            // Update video stream with new DOM version
            videoRegistry.setDomVersion(previewSessionId, snapshot.domVersion);

            logger.debug('[PREVIEW_STREAM] Emitted preview:page (DOM changed)', {
              previewSessionId,
              domVersion: snapshot.domVersion,
              nodeCount: snapshot.domNodes?.length || 0,
            });
          }
        }
      } catch (error) {
        // V21: "Target closed" errors here are the same shutdown race as in
        // snapshot-collector — the tick survived one cycle past stop(). Log
        // at debug level so error.log stays clean during normal session
        // teardown. Real errors (e.g. evaluate bugs) still surface.
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isShutdownRace =
          errorMessage.includes('Target page, context or browser has been closed') ||
          errorMessage.includes('Target closed') ||
          errorMessage.includes('has been closed') ||
          errorMessage.includes('Execution context was destroyed');

        if (isShutdownRace) {
          logger.debug('[PREVIEW_STREAM] DOM tick skipped (shutdown race)', {
            previewSessionId,
            reason: errorMessage,
          });
        } else {
          logger.error('[PREVIEW_STREAM] Failed to check DOM update', {
            previewSessionId,
            error: errorMessage,
          });
        }
      } finally {
        releaseDomTickGuard(previewSessionId, activeDomUpdateTicks);
      }
    }, DOM_UPDATE_INTERVAL_MS);

    activeDomUpdateIntervals.set(previewSessionId, domInterval);

    // V11: Register page-switch callback so popup/new-tab auto-restarts video + devtools
    sessionService.setOnPageSwitch(previewSessionId, userId, (newPage, previousUrl) => {
      logger.info('[PREVIEW_STREAM] Page switched (popup/new tab) — restarting streams', {
        previewSessionId,
        previousUrl,
        newUrl: newPage.url(),
      });

      // Restart video + devtools on the new page (async, non-blocking)
      setImmediate(async () => {
        try {
          // Restart video stream (startStream internally stops the old one and inherits seq)
          await videoRegistry.startStream(previewSessionId, userId, room, newPage, nsp);

          // Restart devtools collectors
          devtoolsRegistry.stop(previewSessionId);
          devtoolsRegistry.start(previewSessionId, room, newPage, nsp);

          logger.info('[PREVIEW_STREAM] Streams restarted after page switch', { previewSessionId });

          // V15: If recording, emit switch_tab step automatically
          try {
            const session = sessionService.getSession(previewSessionId);
            if (session?.recording) {
              const newTabIndex = session.activeTabIndex;
              nsp.to(room).emit('preview:recording:step', {
                previewSessionId,
                step: {
                  id: `auto-switch-tab-${Date.now()}`,
                  type: 'switch_tab',
                  description: `Switch to tab ${newTabIndex}`,
                  value: String(newTabIndex),
                  tabIndex: newTabIndex,
                  evidence: {
                    pageUrl: newPage.url(),
                    tabIndex: newTabIndex,
                  },
                },
                timestamp: new Date().toISOString(),
              });
            }
          } catch { /* non-critical */ }

          // V11: Force-emit a fresh DOM snapshot after page switch.
          // DOM tick may have been blocked by pageSwitchInProgress, so we need to send
          // the first valid snapshot explicitly. Retry up to 3 times if nodeCount is 0
          // (page may still be rendering).
          //
          // V20: Page switch is a handshake — we MUST deliver at least one snapshot
          // to the frontend so its lastKnownDomNodes reflect the new page. Dedup by
          // signature WITHIN the retry loop (skip emit if identical to previous retry)
          // but always allow the first successful emit through even if by coincidence
          // the new signature matches a stale lastEmittedSignature from the old page.
          let lastRetrySignature: string | null = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
                force: true,
                includeDomNodes: true,
              });
              if (snapshot) {
                const sameAsLastRetry = lastRetrySignature !== null
                  && snapshot.pageSignature === lastRetrySignature;
                if (!sameAsLastRetry) {
                  const payload: PreviewPagePayload = {
                    previewSessionId,
                    url: snapshot.url,
                    pageTitle: snapshot.pageTitle,
                    domVersion: snapshot.domVersion,
                    pageSignature: snapshot.pageSignature,
                    domNodes: snapshot.domNodes,
                    timestamp: new Date().toISOString(),
                  };
                  nsp.to(room).emit('preview:page', payload);
                  // V20: Record signature so subsequent emit sites dedup correctly
                  sessionService.markEmittedSignature(previewSessionId, userId, snapshot.pageSignature);
                  lastRetrySignature = snapshot.pageSignature;
                  videoRegistry.setDomVersion(previewSessionId, snapshot.domVersion);

                  logger.info('[PREVIEW_STREAM] Emitted fresh snapshot after page switch', {
                    previewSessionId,
                    attempt,
                    domVersion: snapshot.domVersion,
                    nodeCount: snapshot.domNodes?.length || 0,
                  });
                }

                // If we got actual DOM nodes, we're done
                if (snapshot.domNodes && snapshot.domNodes.length > 0) {
                  break;
                }
              }
              // Wait before retry (page may still be rendering)
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch (snapshotError) {
              logger.warn('[PREVIEW_STREAM] Failed to emit snapshot after page switch', {
                previewSessionId,
                attempt,
                error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
              });
            }
          }
        } catch (restartError) {
          logger.warn('[PREVIEW_STREAM] Failed to restart streams after page switch', {
            previewSessionId,
            error: restartError instanceof Error ? restartError.message : String(restartError),
          });
        }
      });
    });

    logger.info('[PREVIEW_STREAM] All streams started', { previewSessionId, room });
  } catch (error) {
    logger.error('[PREVIEW_STREAM] Failed to start streams', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Stop all preview streams for a session
 */
const stopPreviewStreams = async (previewSessionId: string): Promise<void> => {
  // Stop DOM update interval
  const domInterval = activeDomUpdateIntervals.get(previewSessionId);
  if (domInterval) {
    clearInterval(domInterval);
    activeDomUpdateIntervals.delete(previewSessionId);
  }
  activeDomUpdateTicks.delete(previewSessionId);

  // Stop video stream
  try {
    const { getPreviewVideoStreamRegistry, getPreviewDevToolsRegistry } =
      await import('@/services/testing/ui/preview');

    await getPreviewVideoStreamRegistry().stopStream(previewSessionId);
    getPreviewDevToolsRegistry().stop(previewSessionId);
  } catch (error) {
    logger.warn('[PREVIEW_STREAM] Error stopping streams', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  previewStreamContext.delete(previewSessionId);
  logger.info('[PREVIEW_STREAM] All streams stopped', { previewSessionId });
};

/**
 * Handle preview-related events
 */
export const handlePreviewEvents = (socket: TypedSocket): void => {
  // Get userId safely
  let userId: string | undefined;
  try {
    userId = getUserId(socket);
  } catch {
    userId = undefined;
  }

  const requireUser = (): string | null => {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      socket.emit('error', {
        code: 'UNAUTHORIZED',
        message: 'Authentication required for preview events',
        timestamp: new Date().toISOString(),
      });
      return null;
    }
    return userId;
  };

  // Subscribe to preview updates
  socket.on('subscribe:preview', async ({ previewSessionId }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // V2: Rate limit check
      if (!checkRateLimit(socket.id, 'subscribe')) {
        socket.emit('error', {
          code: 'RATE_LIMITED',
          message: 'Too many subscribe requests. Please wait.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!previewSessionId || typeof previewSessionId !== 'string' || previewSessionId.trim().length === 0) {
        logger.warn('[WebSocket] Invalid previewSessionId in subscribe:preview', {
          socketId: socket.id,
          userId: ensuredUserId,
          previewSessionId,
        });
        socket.emit('error', {
          code: 'VALIDATION_ERROR',
          message: 'Invalid previewSessionId provided',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!socket.connected) {
        return;
      }

      const normalizedPreviewSessionId = previewSessionId.trim();

      // ✅ Security: validate session ownership before joining room
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(normalizedPreviewSessionId, ensuredUserId)) {
        socket.emit('error', {
          code: 'FORBIDDEN',
          message: 'Preview session not found or not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const room = createRoomName('preview', normalizedPreviewSessionId);
      const subs = getPreviewSubs(socket.id);

      // Idempotent subscribe
      if (subs.has(room)) {
        logger.debug('[WebSocket] Already subscribed to preview', {
          socketId: socket.id,
          previewSessionId,
        });
        return;
      }

      socket.join(room);
      subs.add(room);

      // V7: Start video + devtools streaming on first subscriber
      const currentCount = previewRoomRefCount.get(room) || 0;
      previewRoomRefCount.set(room, currentCount + 1);

      if (currentCount === 0 && !activeDomUpdateIntervals.has(normalizedPreviewSessionId)) {
        // First subscriber - start streaming (async, non-blocking)
        startPreviewStreams(
          {
            previewSessionId: normalizedPreviewSessionId,
            userId: ensuredUserId,
            room,
          },
          socket.nsp
        ).catch((err) => {
          logger.error('[WebSocket] Failed to start preview streams', {
            previewSessionId: normalizedPreviewSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.info('[WebSocket] Subscribed to preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
        room,
        subscriberCount: currentCount + 1,
      });

      // V7: Emit initial preview:page with domNodes (video stream handles visuals)
      // V20 note: This is a PER-SOCKET emit (only to the new subscriber), not a room
      // broadcast. We intentionally do NOT call markEmittedSignature here — that map
      // tracks what was last sent to the WHOLE ROOM. If we updated it here, other
      // subscribers already in the room would get stuck on a stale snapshot because
      // subsequent room-wide emit sites would think "already sent" when those others
      // never received this payload.
      try {
        const snapshot = await sessionService.getSnapshot(normalizedPreviewSessionId, ensuredUserId, {
          force: true,
          includeDomNodes: true, // Always include domNodes on initial load
        });

        if (snapshot) {
          socket.emit('preview:page', {
            previewSessionId: normalizedPreviewSessionId,
            url: snapshot.url,
            pageTitle: snapshot.pageTitle,
            domVersion: snapshot.domVersion,
            pageSignature: snapshot.pageSignature,
            domNodes: snapshot.domNodes,
            timestamp: new Date().toISOString(),
          });

          logger.debug('[WebSocket] Emitted initial preview:page', {
            socketId: socket.id,
            previewSessionId,
            domVersion: snapshot.domVersion,
            nodeCount: snapshot.domNodes?.length || 0,
          });

          // V5: Emit viewport metadata for coordinate mapping
          const viewportMeta = sessionService.getViewportMetadata(normalizedPreviewSessionId, ensuredUserId);
          if (viewportMeta) {
            socket.emit('preview:viewport', {
              previewSessionId: normalizedPreviewSessionId,
              viewport: {
                width: viewportMeta.width,
                height: viewportMeta.height,
              },
              devicePixelRatio: viewportMeta.devicePixelRatio,
              timestamp: new Date().toISOString(),
            });
          }

        }
      } catch (snapshotError) {
        logger.warn('[WebSocket] Failed to emit initial preview:page', {
          socketId: socket.id,
          previewSessionId,
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        });
        // Don't fail subscription - just log warning
      }
    } catch (error) {
      logger.error('[WebSocket] Error in subscribe:preview', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'SUBSCRIPTION_ERROR',
        message: 'Failed to subscribe to preview updates',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Unsubscribe from preview updates
  socket.on('unsubscribe:preview', ({ previewSessionId }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!previewSessionId || typeof previewSessionId !== 'string' || previewSessionId.trim().length === 0) {
        return;
      }

      const normalizedPreviewSessionId = previewSessionId.trim();
      const room = createRoomName('preview', normalizedPreviewSessionId);
      socket.leave(room);
      const subs = getPreviewSubs(socket.id);
      subs.delete(room);

      // V7: Stop all streaming when last subscriber leaves
      const currentCount = previewRoomRefCount.get(room) || 0;
      const newCount = Math.max(0, currentCount - 1);
      previewRoomRefCount.set(room, newCount);

      if (newCount === 0) {
        // Last subscriber left - stop all streams
        stopPreviewStreams(normalizedPreviewSessionId).catch((err) => {
          logger.warn('[WebSocket] Error stopping preview streams on unsubscribe', {
            previewSessionId: normalizedPreviewSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        previewRoomRefCount.delete(room);
      }

      // V18: Clear hover probe state for this session
      hoverProbeState.delete(`${socket.id}:${normalizedPreviewSessionId}`);
      // V20: Clear move/wheel coalesce state for this session
      moveCoalesceState.delete(`${socket.id}:${normalizedPreviewSessionId}`);
      wheelCoalesceState.delete(`${socket.id}:${normalizedPreviewSessionId}`);

      logger.info('[WebSocket] Unsubscribed from preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
        subscriberCount: newCount,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:preview', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle step lint request (V5: with HardAllowed/SoftAllowed sets + includeAlternatives)
  socket.on('preview:step:lint', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // V2: Rate limit check
      if (!checkRateLimit(socket.id, 'lint')) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Rate limited. Please slow down.',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { previewSessionId, stepDraft, pageRef, includeAlternatives } = data;

      if (!previewSessionId || !stepDraft) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Missing required fields',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      logger.debug('[WebSocket] Step lint request (V5)', {
        socketId: socket.id,
        previewSessionId,
        stepType: stepDraft.type,
        descriptionPreview: typeof stepDraft.description === 'string' ? stepDraft.description.slice(0, 80) : '',
        includeAlternatives: !!includeAlternatives,
      });

      // Import linting service dynamically to avoid circular deps
      const { IntentStepLintService } = await import('@/services/testing/ui/preview/intent-step-lint.service');

      // V5: Use AI-powered linting with includeAlternatives flag.
      // forceFreshSnapshot: this handler serves the Find button and the debounced
      // typing lint — both are user-triggered moments where the 500ms snapshot
      // cache can be stale (e.g. a modal just appeared). The per-call fresh
      // collect adds ~170ms and only runs on explicit user intent.
      const result = await IntentStepLintService.lintStepWithAI({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
        includeAlternatives: !!includeAlternatives,
        forceFreshSnapshot: true,
        // Editor-side lint: Find button + debounced auto-lint after typing.
        // We can't tell them apart from this socket event alone, so use the
        // generic 'find_button' label (covers both user-triggered moments).
        auditTrigger: 'find_button',
      });

      // V5: Handle needs_clarification status
      if (result.status === 'needs_clarification') {
        const validCandidates = result.candidates.filter(c => c.ref && c.ref.trim().length > 0);

        // Store pending clarification for this step (for use if user clicks "Show alternatives")
        const clarifyKey = `${previewSessionId}:${stepDraft.id}`;
        if (validCandidates.length > 0) {
          pendingClarifications.set(clarifyKey, {
            candidates: validCandidates,
            stepDraft,
            userId: ensuredUserId,
            timestamp: Date.now(),
          });
        }

        // V5: If includeAlternatives=true, emit clarify event with candidates
        // Otherwise, just emit lint:result with LLM message (no candidates)
        if (includeAlternatives && validCandidates.length > 0) {
          // Emit clarify event with candidates (for "Show alternatives" flow)
          socket.emit('preview:step:clarify', {
            previewSessionId,
            stepId: stepDraft.id,
            candidates: validCandidates.slice(0, 5).map(c => ({
              ref: c.ref!,
              label: c.label,
              reason: c.reason,
              boundingBox: c.boundingBox,
            })),
            interpretation: result.interpretation || '',
            message: result.clarificationQuestion || result.message,
            timestamp: new Date().toISOString(),
          });

          logger.info('[WebSocket] Emitted clarify event (alternatives requested)', {
            socketId: socket.id,
            previewSessionId,
            stepId: stepDraft.id,
            candidateCount: validCandidates.length,
          });
        }

        // V5: Always emit lint:result for needs_clarification
        // Frontend uses this to show LLM message and disable Apply
        socket.emit('preview:step:lint:result', {
          status: result.status,
          message: result.message,
          confidence: result.confidence,
          // V5: Only include candidates if includeAlternatives=true
          candidates: includeAlternatives ? validCandidates.slice(0, 5).map(c => ({
            ref: c.ref,
            label: c.label,
            reason: c.reason,
            confidence: c.confidence,
            boundingBox: c.boundingBox,
          })) : [],
          highlight: includeAlternatives ? result.highlight : [],
          interpretation: result.interpretation,
          clarificationQuestion: result.clarificationQuestion,
          alternativesIncluded: !!includeAlternatives,
          applyDisabled: true, // V5: Apply should be disabled for needs_clarification
          // V23: forward AMBIGUOUS coaching so the editor renders an
          // actionable hint alongside the alternatives picker.
          ...(result.suggestion ? { suggestion: result.suggestion } : {}),
          timestamp: new Date().toISOString(),
        });

        return;
      }

      // For resolved/not_found/error, emit result as usual
      socket.emit('preview:step:lint:result', {
        ...result,
        applyDisabled: result.status !== 'resolved', // V5: Apply only enabled for resolved
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:step:lint', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:step:lint:result', {
        status: 'error',
        message: error instanceof Error ? error.message : 'Linting failed',
        confidence: 0,
        candidates: [],
        highlight: [],
        applyDisabled: true,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // V3: Handle user selection from clarify options
  socket.on('preview:step:clarify:select', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, stepId, selectedRef } = data;

      if (!previewSessionId || !stepId || !selectedRef) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Missing required fields for clarification selection',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Get pending clarification
      const clarifyKey = `${previewSessionId}:${stepId}`;
      const pending = pendingClarifications.get(clarifyKey);

      if (!pending) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Clarification session expired or not found',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate user owns this clarification
      if (pending.userId !== ensuredUserId) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Unauthorized clarification selection',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Find selected candidate
      const selectedCandidate = pending.candidates.find(c => c.ref === selectedRef);

      if (!selectedCandidate) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Selected element not found in candidates',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Clean up pending clarification
      pendingClarifications.delete(clarifyKey);

      // V3: Store confirmed selection for use in apply
      confirmedSelections.set(clarifyKey, {
        selectedRef,
        userId: ensuredUserId,
        timestamp: Date.now(),
      });

      logger.info('[WebSocket] Clarification selected and stored', {
        socketId: socket.id,
        previewSessionId,
        stepId,
        selectedRef,
      });

      // Return resolved result with user-confirmed candidate
      socket.emit('preview:step:lint:result', {
        status: 'resolved',
        message: 'User confirmed element selection',
        confidence: 1.0, // User confirmed = 100% confidence
        candidates: [selectedCandidate],
        highlight: [{
          ref: selectedCandidate.ref,
          boundingBox: selectedCandidate.boundingBox,
          type: 'success',
        }],
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:step:clarify:select', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:step:lint:result', {
        status: 'error',
        message: error instanceof Error ? error.message : 'Clarification selection failed',
        confidence: 0,
        candidates: [],
        highlight: [],
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle step apply request
  socket.on('preview:step:apply', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // V2: Rate limit check
      if (!checkRateLimit(socket.id, 'apply')) {
        socket.emit('preview:step:apply:result', {
          success: false,
          error: 'Rate limited. Please slow down.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { previewSessionId, stepDraft, pageRef, intentTestCaseId } = data;

      // V9: Guard — cannot manually apply steps while a run is active
      {
        const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
        if (PreviewRunService.isRunning(previewSessionId)) {
          socket.emit('preview:step:apply:result', {
            success: false,
            error: 'Cannot apply steps while a run is in progress',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      if (!previewSessionId || !stepDraft) {
        socket.emit('preview:step:apply:result', {
          success: false,
          error: 'Missing required fields',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // V4: Normalize/sanitize options if present
      if (stepDraft.options) {
        const opts = stepDraft.options;
        // Normalize timeout: must be number >= 0 and <= 60000 (max 1 min)
        if (opts.timeout !== undefined) {
          const t = Number(opts.timeout);
          if (Number.isNaN(t) || t < 0) {
            opts.timeout = undefined;
          } else {
            opts.timeout = Math.min(t, 60000);
          }
        }
        // Normalize booleans
        if (opts.replaceContent !== undefined) {
          opts.replaceContent = Boolean(opts.replaceContent);
        }
        if (opts.pressEnter !== undefined) {
          opts.pressEnter = Boolean(opts.pressEnter);
        }
      }

      // V3: Check if user confirmed a selection for this step
      const selectionKey = `${previewSessionId}:${stepDraft.id}`;
      const confirmedSelection = confirmedSelections.get(selectionKey);
      let selectedRef: string | undefined;

      if (confirmedSelection && confirmedSelection.userId === ensuredUserId) {
        selectedRef = confirmedSelection.selectedRef;
        logger.debug('[WebSocket] Using confirmed selection for apply', {
          socketId: socket.id,
          previewSessionId,
          stepId: stepDraft.id,
          selectedRef,
        });
      } else {
        logger.debug('[WebSocket] Step apply request (no confirmed selection)', {
          socketId: socket.id,
          previewSessionId,
          stepType: stepDraft.type,
          descriptionPreview: typeof stepDraft.description === 'string' ? stepDraft.description.slice(0, 80) : '',
          intentTestCaseId,
        });
      }

      // Import apply service dynamically to avoid circular deps
      const { PreviewStepApplyService } = await import('@/services/testing/ui/preview/preview-step-apply.service');

      // Editor trace: log step apply request (getOrCreate ensures trace file exists even without recording)
      const applyTrace = EditorTraceService.getOrCreate(previewSessionId, ensuredUserId);
      applyTrace.writeStepApplyRequest(stepDraft);

      const result = await PreviewStepApplyService.applyStep({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
        selectedRef, // V3: Pass confirmed selection
      });

      // Editor trace: log step apply result
      applyTrace.writeStepApplyResult(result);

      // V3: Clean up confirmed selection only after successful apply
      if (result.success && confirmedSelection) {
        confirmedSelections.delete(selectionKey);
      }

      socket.emit('preview:step:apply:result', {
        ...result,
        timestamp: new Date().toISOString(),
      });

      // V8: Auto-persist to DB if intentTestCaseId provided and apply succeeded.
      // Skip if a run is active (the run will batch-persist at the end).
      // Awaited instead of setImmediate to prevent race with run:start.
      if (result.success && intentTestCaseId && result.appliedStep) {
        try {
          const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
          if (!PreviewRunService.isRunning(previewSessionId)) {
            const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
            // Etap 1D.2 — clear stale failureEvidence on success. The
            // step that just succeeded is no longer "needs review"; the
            // bundle from the previous failed apply would be misleading.
            const stepToPersist = result.appliedStep.failureEvidence
              ? { ...result.appliedStep, failureEvidence: undefined }
              : result.appliedStep;
            const updated = await IntentTestCaseService.updateStepFromPreviewApply({
              intentTestCaseId,
              appliedStep: stepToPersist,
              userId: ensuredUserId,
            });

            if (updated) {
              logger.info('[WebSocket] Auto-persisted appliedStep to DB', {
                socketId: socket.id,
                intentTestCaseId,
                stepId: result.appliedStep!.id,
              });
            }
          }
        } catch (persistError) {
          logger.error('[WebSocket] Error auto-persisting appliedStep to DB', {
            socketId: socket.id,
            intentTestCaseId,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        }
      }

      // Failed-but-plan-is-proven persistence.
      //
      // The mobile apply service forwards `appliedStep` even on failure if
      // the runner emitted a compiled plan AND resolveVia was a "proven"
      // strategy (compiled_fast_path / cache) — meaning the plan already
      // matched the current tree, the failure was downstream of resolution.
      // Persist that plan so the next run keeps fast-path coverage instead
      // of re-paying full LLM cost. failureEvidence path below handles the
      // "needs review" flow separately; this branch is purely about not
      // losing valid compiled plans.
      if (
        !result.success
        && intentTestCaseId
        && result.appliedStep
        && (result.appliedStep as { compiled?: unknown }).compiled
        && !result.appliedStep.failureEvidence
      ) {
        try {
          const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
          if (!PreviewRunService.isRunning(previewSessionId)) {
            const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
            await IntentTestCaseService.updateStepFromPreviewApply({
              intentTestCaseId,
              appliedStep: result.appliedStep,
              userId: ensuredUserId,
            });
            logger.info('[WebSocket] Persisted proven-plan from failed apply', {
              socketId: socket.id,
              intentTestCaseId,
              stepId: result.appliedStep.id,
            });
          }
        } catch (provenPersistError) {
          logger.warn('[WebSocket] Failed to persist proven-plan from failed apply', {
            socketId: socket.id,
            intentTestCaseId,
            error: provenPersistError instanceof Error ? provenPersistError.message : String(provenPersistError),
          });
        }
      }

      // Etap 1D.2 — failure persistence + needs-review WS event.
      //
      // When apply fully failed AND the collector built a failureEvidence
      // bundle, persist it to DB and emit `preview:step:needs-review`
      // so the editor can show a badge/debug panel without re-fetching.
      //
      // Skipped when run is active: the run loop's batch-persist handles
      // failure bundles too, and emitting per-step here would spam the
      // frontend during a long run.
      if (
        !result.success
        && intentTestCaseId
        && result.appliedStep?.failureEvidence
      ) {
        try {
          const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
          if (!PreviewRunService.isRunning(previewSessionId)) {
            const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
            await IntentTestCaseService.updateStepFromPreviewApply({
              intentTestCaseId,
              appliedStep: result.appliedStep,
              userId: ensuredUserId,
            });
            logger.info('[WebSocket] Persisted failureEvidence', {
              socketId: socket.id,
              intentTestCaseId,
              stepId: result.appliedStep.id,
              attemptsLogged: result.appliedStep.failureEvidence.attempts.length,
            });
            socket.nsp.to(createRoomName('preview', previewSessionId)).emit('preview:step:needs-review', {
              previewSessionId,
              stepId: result.appliedStep.id,
              intentTestCaseId,
              summary: {
                lastError: result.appliedStep.failureEvidence.lastError,
                totalAttempts: result.appliedStep.failureEvidence.totalAttempts,
                pageUrl: result.appliedStep.failureEvidence.pageUrl,
                // V26 Batch A: top-level failure category — lets the editor
                // dashboard group "stuck steps" by reason without parsing
                // the full bundle. Non-breaking: optional, old clients
                // ignore unknown fields.
                originatingStrategy: result.appliedStep.failureEvidence.originatingStrategy,
              },
              timestamp: new Date().toISOString(),
            });
          }
        } catch (failurePersistError) {
          logger.error('[WebSocket] Failed to persist failureEvidence', {
            socketId: socket.id,
            intentTestCaseId,
            error: failurePersistError instanceof Error ? failurePersistError.message : String(failurePersistError),
          });
        }
      }

      // If successful, emit updated page state to all subscribers
      if (result.success) {
        // Emit result immediately, then snapshot async
        setImmediate(async () => {
          try {
            const { getPreviewSessionService, getPreviewVideoStreamRegistry } =
              await import('@/services/testing/ui/preview');
            const sessionService = getPreviewSessionService();

            // V9: Update recording URL baseline after step:apply (prevents false nav steps)
            if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              if (page) {
                sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
              }
            }

            const snapshot = await sessionService.getSnapshot(previewSessionId, ensuredUserId, {
              force: true,
              includeDomNodes: true, // Always include after action
              onlyIfChanged: true,
            });

            if (snapshot && snapshot.changed) {
              // V20: Second-level dedup — another emit site may have pushed this
              // exact signature already (e.g. DOM tick + apply racing on the same
              // mutation). Bump video stream domVersion either way.
              const lastEmitted = sessionService.getLastEmittedSignature(previewSessionId, ensuredUserId);
              if (lastEmitted && snapshot.pageSignature === lastEmitted) {
                getPreviewVideoStreamRegistry().setDomVersion(previewSessionId, snapshot.domVersion);
              } else {
                const room = createRoomName('preview', previewSessionId);
                const payload: PreviewPagePayload = {
                  previewSessionId,
                  url: snapshot.url,
                  pageTitle: snapshot.pageTitle,
                  domVersion: snapshot.domVersion,
                  pageSignature: snapshot.pageSignature,
                  domNodes: snapshot.domNodes,
                  timestamp: new Date().toISOString(),
                };

                // Emit to the caller immediately (even if not subscribed)
                socket.emit('preview:page', payload);
                // Emit to other subscribers
                socket.to(room).emit('preview:page', payload);

                // V20: Record signature so subsequent emit sites can dedup
                sessionService.markEmittedSignature(previewSessionId, ensuredUserId, snapshot.pageSignature);

                // Update video stream with new DOM version
                getPreviewVideoStreamRegistry().setDomVersion(previewSessionId, snapshot.domVersion);

                logger.debug('[WebSocket] Emitted preview:page after apply', {
                  socketId: socket.id,
                  previewSessionId,
                  domVersion: snapshot.domVersion,
                  changed: snapshot.changed,
                });
              }
            }
          } catch (snapshotError) {
            logger.warn('[WebSocket] Failed to emit preview:page after apply', {
              socketId: socket.id,
              previewSessionId,
              error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
            });
          }
        });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:step:apply', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:step:apply:result', {
        success: false,
        error: error instanceof Error ? error.message : 'Apply failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE STEP APPLY — WebSocket equivalent of POST /mobile/sessions/:id/apply.
  // Parallels `preview:step:apply` so the mobile editor gets the same live-update
  // flow (no request/response latency for UI state), and the backend auto-persists
  // the resulting appliedStep to DB when intentTestCaseId is provided.
  // ═══════════════════════════════════════════════════════════════════════════
  socket.on('mobile:step:apply', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'apply')) {
        socket.emit('mobile:step:apply:result', {
          success: false,
          error: 'Rate limited. Please slow down.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { mobileSessionId, stepDraft, intentTestCaseId } = data;

      if (!mobileSessionId || !stepDraft) {
        socket.emit('mobile:step:apply:result', {
          success: false,
          error: 'mobileSessionId and stepDraft are required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Editor trace: log request
      const traceSessionId = `mobile-${mobileSessionId}`;
      const trace = EditorTraceService.getOrCreate(traceSessionId, ensuredUserId);
      const rawStepType = stepDraft.type || (stepDraft as any).kind || 'click';
      const description = String(
        (stepDraft as any).elementDescription || stepDraft.description || ''
      )
        .replace(/['"]+([^'"]+)['"]+/g, '$1')
        .trim();
      trace.writeMobileApplyRequest({
        stepId: stepDraft.id || `apply_${Date.now()}`,
        stepType: rawStepType,
        description,
        value: (stepDraft as any).value,
        sessionId: mobileSessionId,
      });
      const applyStart = Date.now();

      // Delegate to shared apply service
      const { MobileStepApplyService } = await import('@/services/mobile/mobile-step-apply.service');
      const output = await MobileStepApplyService.apply({
        sessionId: mobileSessionId,
        stepDraft,
        userId: ensuredUserId,
      });

      trace.writeMobileApplyResult({
        stepId: stepDraft.id || `apply_${Date.now()}`,
        sessionId: mobileSessionId,
        latencyMs: Date.now() - applyStart,
        result: {
          success: output.stepResult?.success ?? false,
          error: output.stepResult?.error,
          resolvedVia: output.stepResult?.resolvedVia,
          durationMs: output.stepResult?.durationMs,
        },
      });

      socket.emit('mobile:step:apply:result', {
        success: output.success,
        error: output.stepResult?.error,
        appliedStep: output.appliedStep as any,
        stepResult: output.stepResult,
        status: output.status,
        mobileSessionId,
        timestamp: new Date().toISOString(),
      } as any);

      // Auto-persist to DB if intentTestCaseId provided and apply succeeded.
      // Matches the web preview:step:apply flow (line ~1329 above).
      if (output.stepResult?.success && intentTestCaseId && output.appliedStep) {
        try {
          const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
          const updated = await IntentTestCaseService.updateStepFromPreviewApply({
            intentTestCaseId,
            appliedStep: output.appliedStep as any,
            userId: ensuredUserId,
          });

          if (updated) {
            logger.info('[WebSocket] Auto-persisted mobile appliedStep to DB', {
              socketId: socket.id,
              intentTestCaseId,
              stepId: output.appliedStep.id,
            });
          }
        } catch (persistError) {
          logger.error('[WebSocket] Error auto-persisting mobile appliedStep to DB', {
            socketId: socket.id,
            intentTestCaseId,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        }
      }
    } catch (error) {
      logger.error('[WebSocket] Error in mobile:step:apply', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('mobile:step:apply:result', {
        success: false,
        error: error instanceof Error ? error.message : 'Mobile apply failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V5: Interactive preview control handlers
  // ═══════════════════════════════════════════════════════════════════════════

  // Handle mouse move (hover) — fire-and-forget, no error/success emitted to client.
  // Hover is a passive, high-frequency event; emitting errors would spam the UI with
  // "Preview action failed (move)" toasts that are meaningless to the user.
  //
  // V20: Coalescing — multiple move events arriving within one event-loop tick collapse
  // into a single Playwright `mouse.move` call with the latest coordinates. The hover
  // probe and recording lastHover cache are updated SYNCHRONOUSLY on every WS event so
  // they always see the freshest position regardless of how the Playwright call is batched.
  socket.on('preview:mouse:move', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { x, y } = data;
      if (x === undefined || y === undefined) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // V20: Coalesce — record latest coords and schedule one Playwright call per tick.
      // We do NOT block on the Playwright call; downstream side effects (hover probe,
      // recordingLastHover) work off these in-memory coords, not page state, so they are
      // updated below regardless of when the actual page.mouse.move() resolves.
      const moveKey = `${socket.id}:${previewSessionId}`;
      let mState = moveCoalesceState.get(moveKey);
      if (!mState) {
        mState = { latestX: x, latestY: y, flushScheduled: false };
        moveCoalesceState.set(moveKey, mState);
      } else {
        mState.latestX = x;
        mState.latestY = y;
      }
      if (!mState.flushScheduled) {
        mState.flushScheduled = true;
        const flushRef = mState;
        setImmediate(() => {
          flushRef.flushScheduled = false;
          // Fire-and-forget — executeMouseAction is itself fire-and-forget for 'move' (V20)
          sessionService.executeMouseAction({
            sessionId: previewSessionId,
            userId: ensuredUserId,
            action: 'move',
            x: flushRef.latestX,
            y: flushRef.latestY,
          }).catch(() => { /* fire-and-forget — already logged inside */ });
        });
      }

      // Side effects below run on EVERY WS event with the just-received coords —
      // they don't wait for the coalesced Playwright call to land.
      {
        // V11: Track last hover position for recording (used to emit hover step before click)
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          sessionService.setRecordingLastHover(previewSessionId, ensuredUserId, {
            x, y, timestamp: Date.now(),
          });
        }

        // V18: Non-blocking hover probe for Cursor-style element highlight
        const now = Date.now();
        const hKey = `${socket.id}:${previewSessionId}`;
        let hState = hoverProbeState.get(hKey);
        if (!hState) {
          hState = { lastProbeAt: 0, lastElementKey: null, probeInFlight: false, pageUrl: null, latestX: x, latestY: y };
          hoverProbeState.set(hKey, hState);
        }
        // Always update latest coords — probe will use freshest position when it starts
        hState.latestX = x;
        hState.latestY = y;
        if (!hState.probeInFlight && now - hState.lastProbeAt >= HOVER_PROBE_THROTTLE_MS) {
          hState.probeInFlight = true;
          hState.lastProbeAt = now;
          const hStateRef = hState;
          // Capture page URL before probe to detect navigation during setImmediate
          const preProbeUrl = sessionService.getPage(previewSessionId, ensuredUserId)?.url() || null;
          // Pre-resolve import outside setImmediate to reduce async overhead in hot path
          const runServicePromise = import('@/services/testing/ui/preview/preview-run.service');
          setImmediate(async () => {
            const probeStartMs = Date.now();
            const hTrace = EditorTraceService.get(previewSessionId);
            try {
              // Fix #7: Skip probe during active preview run
              const { PreviewRunService } = await runServicePromise;
              if (PreviewRunService.isRunning(previewSessionId)) {
                // Clear hover during run
                if (hStateRef.lastElementKey !== null) {
                  hStateRef.lastElementKey = null;
                  const room = createRoomName('preview', previewSessionId);
                  socket.nsp.to(room).emit('preview:element:hover' as any, {
                    previewSessionId, element: null, timestamp: new Date().toISOString(),
                  });
                }
                hTrace?.writeHoverProbe({ x: hStateRef.latestX, y: hStateRef.latestY, latencyMs: Date.now() - probeStartMs, result: null, skipped: 'run_active' });
                return;
              }

              // Use latest coords (not closure coords) — cursor may have moved during throttle window
              const probeX = hStateRef.latestX;
              const probeY = hStateRef.latestY;

              // V23: ask probe for the precise reject reason. Without this
              // every null result trace-encodes as 'no_interactive_element'
              // — so 53× identical rows during a stuck recording look
              // identical regardless of whether the page is empty, the
              // hit-test landed in a cross-origin iframe, or a non-
              // interactive <div> covered the area.
              const probeResult = await sessionService.probeInteractiveElementAt({
                sessionId: previewSessionId,
                userId: ensuredUserId,
                x: probeX, y: probeY,
                withRejectReason: true,
              });
              // Narrow: a "real" element has tag/label; rejection has only rejectReason.
              const el = probeResult && 'tag' in probeResult ? probeResult : null;
              const rejectReason = probeResult && 'rejectReason' in probeResult
                ? probeResult.rejectReason : undefined;

              const probeLatencyMs = Date.now() - probeStartMs;

              // Fix #6: Discard result if page navigated during probe
              const postProbeUrl = sessionService.getPage(previewSessionId, ensuredUserId)?.url() || null;
              if (preProbeUrl && postProbeUrl && preProbeUrl !== postProbeUrl) {
                hStateRef.lastElementKey = null;
                hTrace?.writeHoverProbe({ x: probeX, y: probeY, latencyMs: probeLatencyMs, result: null, skipped: 'page_navigated' });
                return;
              }

              hTrace?.writeHoverProbe({
                x: probeX, y: probeY,
                originalX: x, originalY: y,
                latencyMs: probeLatencyMs,
                result: el ? { tag: el.tag, label: el.label, resolvedVia: el.resolvedVia } : null,
                skipped: el ? undefined : (rejectReason || 'no_interactive_element'),
              });

              const elKey = el
                ? `${el.tag}:${el.boundingBox.x}:${el.boundingBox.y}:${el.boundingBox.width}:${el.boundingBox.height}`
                : null;
              // Dedup: only emit when element changes
              const deduped = elKey === hStateRef.lastElementKey;
              if (!deduped) {
                hStateRef.lastElementKey = elKey;
                const room = createRoomName('preview', previewSessionId);
                socket.nsp.to(room).emit('preview:element:hover' as any, {
                  previewSessionId,
                  element: el,
                  timestamp: new Date().toISOString(),
                });
                hTrace?.writeHoverEmit({ element: el, deduped: false, room });
              } else {
                hTrace?.writeHoverEmit({ element: el, deduped: true });
              }
            } catch { /* non-critical — don't break hover */ }
            finally { // Fix #3: Always reset probeInFlight
              hStateRef.probeInFlight = false;
            }
          });
        }
      }
      // No snapshot, no error emit for hover
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:move', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse click
  socket.on('preview:mouse:click', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { x, y, button, clickCount, modifiers } = data;
      if (x === undefined || y === undefined) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // V9: Pre-click probe for recording (state-aware: need element state BEFORE click)
      let preClickElement: Awaited<ReturnType<typeof import('@/services/testing/ui/preview/recording-capture.service').RecordingCaptureService.probeForRecording>> = null;
      const isRecording = sessionService.isRecording(previewSessionId, ensuredUserId);
      if (isRecording) {
        try {
          // V18: Reuse hover probe result if fresh AND click lands inside the highlighted element's bbox.
          // This ensures the recorded step matches exactly what the user saw highlighted.
          // BBox hit test is more robust than distance check — user can click anywhere inside the highlight.
          const lastHover = sessionService.getRecordingLastHover(previewSessionId, ensuredUserId);
          const hoverAge = lastHover ? Date.now() - lastHover.timestamp : Infinity;
          const hoverBBox = lastHover?.probedElement?.boundingBox;
          const clickInsideHoverBBox = hoverBBox
            && x >= hoverBBox.x && x <= hoverBBox.x + hoverBBox.width
            && y >= hoverBBox.y && y <= hoverBBox.y + hoverBBox.height;
          if (lastHover?.probedElement && hoverAge <= 500 && clickInsideHoverBBox) {
            preClickElement = lastHover.probedElement;
          } else {
            const { RecordingCaptureService } = await import(
              '@/services/testing/ui/preview/recording-capture.service'
            );
            const page = sessionService.getPage(previewSessionId, ensuredUserId);
            if (page) {
              preClickElement = await RecordingCaptureService.probeForRecording(page, x, y);
            }
          }
        } catch {
          // Non-critical — recording probe failure doesn't block click
        }
      }

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'click',
        x,
        y,
        button,
        clickCount,
      });

      if (result.success) {
        if (result.needsSnapshot) {
          // Always emit snapshot after click so user always sees visual feedback
          setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
        }

        // Editor trace: log click input
        const clickTrace = EditorTraceService.get(previewSessionId);
        if (clickTrace) clickTrace.writeClick({ x, y, button, clickCount, preClickElement, isRecording });

        // V9: Recording hook (non-blocking)
        if (isRecording && preClickElement) {
          // V14: Warn user if click was inside a cross-origin iframe (cannot be recorded)
          if (preClickElement.crossOriginIframe) {
            const room = createRoomName('preview', previewSessionId);
            socket.nsp.to(room).emit('preview:recording:warning' as any, {
              previewSessionId,
              type: 'cross_origin_iframe',
              message: 'This element is inside a cross-origin iframe and cannot be recorded. Payment forms, OAuth widgets, and third-party embeds are not yet supported.',
              iframeSelector: preClickElement.iframeSelector,
              timestamp: new Date().toISOString(),
            });
            return; // Don't try to create a step from cross-origin element
          }
          // V23: <webview> / <object> / <embed> host a separate browsing
          // context Playwright cannot reach — recording silently captures
          // nothing. Surface a clear message instead of "no element here".
          if (preClickElement.unsupportedHost) {
            const room = createRoomName('preview', previewSessionId);
            const hostKind = preClickElement.unsupportedHost;
            const hostMsg = hostKind === 'webview'
              ? 'This site renders its content inside an Electron <webview> element. Playwright runs vanilla Chromium, so the inner content is not reachable. Recording will not capture clicks or typing here.'
              : `This site renders content inside a <${hostKind}> element whose internals are not accessible to recording.`;
            socket.nsp.to(room).emit('preview:recording:warning' as any, {
              previewSessionId,
              type: 'unsupported_host',
              hostKind,
              message: hostMsg,
              timestamp: new Date().toISOString(),
            });
            return; // No usable target — skip step creation
          }
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const room = createRoomName('preview', previewSessionId);
              const cTrace = EditorTraceService.get(previewSessionId);

              // Flush pending scroll + typing + close Field Session BEFORE
              // emitting the click step — preserves correct step order and
              // captures the canonical input value before the user navigates
              // away from the focused control.
              await flushPendingScroll(socket, previewSessionId, ensuredUserId, sessionService, 'click');
              flushPendingTyping(socket, previewSessionId, ensuredUserId, sessionService, RecordingCaptureService, 'click');
              // V22 Pkg8: close Field Session on click — re-reads live
              // input.value for the canonical Type step. Skipped silently
              // when no session open (idempotent).
              await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, 'click');

              // V22 Pkg5+ Patch A & C: Emit hover-steps before click using
              //   (A) Adaptive dwell threshold — 80ms for popup-trigger
              //       elements (aria-haspopup, dropdown classes, bsToggle),
              //       400ms for everything else. Quick hover on a real
              //       trigger (Documentolog Market hover-menu) now records
              //       a hover-step even if the user moves fast.
              //   (B) Hover CHAIN — multi-level menus (Menu → Submenu →
              //       Click leaf) emit a hover-step per distinct ancestor
              //       trigger, preserving order. Replays deterministically
              //       even when CSS :hover-only menus drive the UI.
              //
              // Old behaviour (single 400ms dwell on lastHover) is fully
              // subsumed — chain falls back to lastHover when empty.
              try {
                const page = sessionService.getPage(previewSessionId, ensuredUserId);
                const chain = sessionService.getRecordingHoverChain(previewSessionId, ensuredUserId);
                if (page && preClickElement) {
                  // Build the candidate list. Prefer chain (multi-level);
                  // fall back to lastHover (single-step legacy path).
                  const candidates: Array<{ x: number; y: number; timestamp: number; probedElement?: any }> = [];
                  if (chain.length > 0) {
                    for (const c of chain) candidates.push(c);
                  } else {
                    const lastHover = sessionService.getRecordingLastHover(previewSessionId, ensuredUserId);
                    if (lastHover) candidates.push(lastHover);
                  }
                  const cBB = preClickElement.boundingBox;
                  const seenBBoxKeys = new Set<string>();
                  for (let ci = 0; ci < candidates.length; ci++) {
                    const cand = candidates[ci];
                    const timeSinceHover = Date.now() - cand.timestamp;
                    if (timeSinceHover >= 5000) continue; // too stale
                    // Re-probe if no cached probedElement (legacy lastHover path)
                    let hoverElement = cand.probedElement || null;
                    if (!hoverElement) {
                      hoverElement = await RecordingCaptureService.probeForRecording(page, cand.x, cand.y);
                    }
                    if (!hoverElement || !hoverElement.boundingBox) continue;
                    // Skip if this hover-target equals the click-target (same element).
                    const hBB = hoverElement.boundingBox;
                    const isSameElement = hBB && cBB
                      && hBB.x === cBB.x && hBB.y === cBB.y
                      && hBB.width === cBB.width && hBB.height === cBB.height;
                    if (isSameElement) continue;
                    // De-dupe within the chain itself (rare but possible
                    // when chain entries probed the same element from
                    // slightly-different coords).
                    const bboxKey = `${hBB.x}|${hBB.y}|${hBB.width}|${hBB.height}`;
                    if (seenBBoxKeys.has(bboxKey)) continue;
                    seenBBoxKeys.add(bboxKey);
                    // Patch A: adaptive dwell threshold.
                    // Popup-trigger signals (aria-haspopup, bsToggle="dropdown",
                    // class*="dropdown|menu-trigger|has-submenu", or any
                    // ancestor-summary that hints at a menu container) → 80ms.
                    // Everything else → 400ms (legacy threshold).
                    const cls = (hoverElement.cssClass || '') + ' ' + (hoverElement.ancestorSummary || '');
                    const isLikelyPopupTrigger =
                      !!hoverElement.ariaHasPopup
                      || hoverElement.bsToggle === 'dropdown'
                      || hoverElement.bsToggle === 'menu'
                      || /\b(dropdown|menu-trigger|has-submenu|popper-trigger|has-dropdown|nav-item|MuiMenuItem|MuiMenu-)\b/i.test(cls);
                    const minDwell = isLikelyPopupTrigger ? 80 : 400;
                    if (timeSinceHover < minDwell) continue;
                    // Skip generic-label hovers. If the probe couldn't find any
                    // descriptive name for the target (no aria-label, no text,
                    // no title, no id, no testId), the recorded step ends up as
                    // "Hover 'element'" which is useless for replay — the
                    // resolver has nothing semantic to match against. Most of
                    // these come from cursor sweeps between meaningful targets
                    // (e.g. mouse passing over a wrapper div on the way to the
                    // language flag). Exception: keep the step when the probe
                    // indicates a popup-trigger (aria-haspopup / dropdown class)
                    // — there the hover IS the action even without a label.
                    const probedLabel = RecordingCaptureService.getProbedLabel(hoverElement, 60);
                    if (!probedLabel && !isLikelyPopupTrigger) continue;
                    const hoverStep = RecordingCaptureService.captureHover(hoverElement, page.url());
                    emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: hoverStep });
                    if (cTrace) cTrace.writeStepCaptured(hoverStep, 'hover_before_click');
                    // Etap 1D.3 — fire-and-forget LLM enrichment.
                    scheduleRecordedDescription(socket, room, previewSessionId, hoverStep, hoverElement);
                  }
                }
              } catch {
                // Non-critical — hover step is best-effort
              }
              sessionService.setRecordingLastHover(previewSessionId, ensuredUserId, null);
              sessionService.clearRecordingHoverChain(previewSessionId, ensuredUserId);

              // V19: Non-blocking click step emission.
              // Old flow: await LLM (up to 2s) → emit step → user sees step ~2s after click.
              // New flow: build step from pre-click probe → emit immediately → run LLM in background
              //          → if LLM refines the element, emit preview:recording:step:update with same id.
              // Data preservation:
              //   - step.id is generated ONCE and reused for the update (frontend merges by id)
              //   - All initial fields (modifiers, iframe, evidence.pageUrl, tabIndex) are kept
              //   - Update only overrides type/description/bindingHints/iframe/highlight/evidence.lastSuccessRef
              //   - If LLM fails or returns same element, no update is sent (initial step stays correct)

              // V10: Pass button and clickCount to inferClickActionType for dblclick/right-click support
              const safeButton = (data.button === 'right' || data.button === 'middle') ? data.button : 'left';
              const safeClickCount = (data.clickCount === 2) ? 2 : 1;
              const needsLLM = preClickElement!.resolvedVia === 'directHit' || preClickElement!.resolvedVia === 'cssClass';

              // Helper: build a click step from a ProbedElement (kept local so initial + update are identical).
              // NOTE: `let` (not const) because the dblclick coalescing path below may rewrite this to the
              // previous single-click's id so LLM refinement updates the correct row instead of creating
              // a phantom one that FE would treat as a new step.
              let stepIdForClick = `rec_${Date.now().toString(36)}`;
              const currentPage = sessionService.getPage(previewSessionId, ensuredUserId);
              const initialPageUrl = currentPage?.url();
              const hasModifiers = modifiers && (modifiers.shift || modifiers.ctrl || modifiers.meta || modifiers.alt);

              const buildClickStep = (el: NonNullable<typeof preClickElement>): PreviewIntentStep => {
                const aType = RecordingCaptureService.inferClickActionType(el, safeClickCount, safeButton);
                const desc = RecordingCaptureService.buildDescription(aType, el);
                const bHints = RecordingCaptureService.buildBindingHints(el);
                // V22: Fingerprint set NOW so LLM resolver has identifying
                // data on the first apply (before compiled plan exists).
                const recFp = RecordingCaptureService.buildRecordedFingerprint(el);
                const iSel = el.iframeSelector;
                const built: PreviewIntentStep = {
                  id: stepIdForClick,
                  type: aType,
                  description: desc,
                  bindingHints: Object.keys(bHints).length > 0 ? bHints : undefined,
                  recordedFingerprint: Object.keys(recFp).length > 0 ? recFp : undefined,
                  options: {
                    ...(hasModifiers && {
                      modifiers: {
                        ...(modifiers.shift && { shift: true }),
                        ...(modifiers.ctrl && { ctrl: true }),
                        ...(modifiers.meta && { meta: true }),
                        ...(modifiers.alt && { alt: true }),
                      },
                    }),
                    ...(iSel && { iframe: { selector: iSel } }),
                  },
                  evidence: {
                    ...(el.ref && { lastSuccessRef: el.ref }),
                    confidence: 1.0,
                    pageUrl: initialPageUrl,
                    capturedAt: new Date().toISOString(), // V15.7: TTL support
                  },
                };
                if (built.options && Object.keys(built.options).length === 0) {
                  delete built.options;
                }
                return built;
              };

              // Build & emit the initial step IMMEDIATELY using pre-click probe data
              const step = buildClickStep(preClickElement!);

              // Diagnostic — audit what the recorder actually built. If
              // `hasRecordedFingerprint: false` here, the loss is upstream
              // (probe didn't capture identity); if it's true here but
              // false in fp_audit.log on the next Run, the loss is in
              // frontend serialize / DB persist.
              try {
                const fs = await import('fs');
                const path = await import('path');
                const auditPath = path.join(process.cwd(), 'logs', 'fp_audit.log');
                const fpKeys = step.recordedFingerprint && typeof step.recordedFingerprint === 'object'
                  ? Object.keys(step.recordedFingerprint).slice(0, 15)
                  : undefined;
                const probeKeys = preClickElement
                  ? Object.keys(preClickElement).filter(k => preClickElement![k as keyof typeof preClickElement] != null).slice(0, 20)
                  : undefined;
                fs.appendFileSync(auditPath, JSON.stringify({
                  ts: new Date().toISOString(),
                  scope: 'recorder_emit',
                  stepId: step.id?.slice(0, 8),
                  type: step.type,
                  hasRecordedFingerprint: !!step.recordedFingerprint,
                  hasBindingHints: !!step.bindingHints,
                  hasEvidence: !!step.evidence,
                  fpKeys,
                  probeKeys,
                  probeTag: preClickElement?.tag,
                  probeId: preClickElement?.elementId,
                  probeTestId: preClickElement?.testId,
                  probeRef: preClickElement?.ref,
                }) + '\n');
              } catch { /* non-fatal */ }

              // V10: Click breaks scroll merge context
              sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, null);

              // Double-click coalescing. The browser fires click (detail=1)
              // followed by click (detail=2) for every double-click. Without
              // dedup the recording ends up with two steps — a single click
              // and a dblclick — for one intent. If the previous click step
              // was on the same element within ~500ms and the current event
              // is a double-click (clickCount>=2), promote the existing step
              // in place instead of emitting a new row.
              const clickElSignature = `${preClickElement?.ref ?? ''}|${preClickElement?.tag ?? ''}|${preClickElement?.boundingBox?.x ?? -1}|${preClickElement?.boundingBox?.y ?? -1}`;
              const lastClick = sessionService.getRecordingLastClickStep(previewSessionId, ensuredUserId);
              const dblClickWindow = 500; // ms — matches default OS double-click interval
              const isDbl = safeClickCount >= 2;
              if (
                isDbl
                && lastClick
                && lastClick.elementSignature === clickElSignature
                && Date.now() - lastClick.emittedAt <= dblClickWindow
              ) {
                // Upgrade the existing step to dblclick in place. Also rewire
                // `stepIdForClick` so the LLM refinement closure below targets
                // the SAME row (otherwise a phantom dblclick step appears
                // because FE's "idx === -1" branch falls back to append).
                stepIdForClick = lastClick.id;
                step.id = lastClick.id;
                const upgraded: PreviewIntentStep = { ...step };
                socket.nsp.to(room).emit('preview:recording:step:update', {
                  previewSessionId,
                  step: upgraded,
                  timestamp: new Date().toISOString(),
                });
                if (cTrace) cTrace.writeStepUpdated(upgraded, 'click_to_dblclick');
                sessionService.setRecordingLastClickStep(previewSessionId, ensuredUserId, {
                  id: lastClick.id,
                  elementSignature: clickElSignature,
                  emittedAt: Date.now(),
                });
              } else {
                emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step, highlight: preClickElement?.boundingBox });
                if (cTrace) cTrace.writeStepCaptured(step, needsLLM ? 'click_pending_llm' : 'click');
                // Etap 1D.3 — fire-and-forget LLM enrichment.
                if (preClickElement) {
                  scheduleRecordedDescription(socket, room, previewSessionId, step, preClickElement);
                }
                sessionService.setRecordingLastClickStep(previewSessionId, ensuredUserId, {
                  id: step.id,
                  elementSignature: clickElSignature,
                  emittedAt: Date.now(),
                });
              }

              // V19: Background LLM refinement — does NOT block step appearing in the panel.
              // We snapshot the original element for diffing so we only emit an update when LLM
              // actually picked a different ancestor.
              if (needsLLM) {
                const originalEl = preClickElement!;
                const originalKey = `${originalEl.tag}|${originalEl.boundingBox?.x ?? -1}|${originalEl.boundingBox?.y ?? -1}|${originalEl.boundingBox?.width ?? -1}|${originalEl.boundingBox?.height ?? -1}|${originalEl.ref ?? ''}`;
                // Fire-and-forget: refines step in background. Errors are non-fatal.
                (async () => {
                  try {
                    const llmPage = sessionService.getPage(previewSessionId, ensuredUserId);
                    if (!llmPage) return;
                    const refined = await RecordingCaptureService.resolveInteractiveTarget(
                      llmPage, originalEl, x, y,
                    );
                    if (!refined) return;
                    const refinedKey = `${refined.tag}|${refined.boundingBox?.x ?? -1}|${refined.boundingBox?.y ?? -1}|${refined.boundingBox?.width ?? -1}|${refined.boundingBox?.height ?? -1}|${refined.ref ?? ''}`;
                    if (refinedKey === originalKey) return; // LLM confirmed original — nothing to update
                    // Mutate the closure ref so the navigation block below sees the refined element
                    preClickElement = refined;
                    const updatedStep = buildClickStep(refined);
                    socket.nsp.to(room).emit('preview:recording:step:update', {
                      previewSessionId,
                      step: updatedStep,
                      highlight: refined.boundingBox,
                      timestamp: new Date().toISOString(),
                    } as any);
                    if (cTrace) cTrace.writeStepUpdated(updatedStep, 'click_llm_refine');
                  } catch (e) {
                    logger.debug('[RECORDING] Background LLM refinement failed', {
                      error: e instanceof Error ? e.message : String(e),
                    });
                  }
                })();
              }

              // V13: Smart navigation detection — condition-based polling instead of fixed 500ms
              // Wait for domcontentloaded first, then poll URL for up to 2s (SPA redirects can be delayed)
              const navPage = sessionService.getPage(previewSessionId, ensuredUserId);
              if (navPage) {
                await navPage.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => {});
                let currentUrl = navPage.url();
                const prevUrl = sessionService.getRecordingLastUrl(previewSessionId, ensuredUserId);

                // Smart poll: if URL hasn't changed yet, give SPA routers up to 2s to push new URL
                // Exits immediately once URL changes — no wasted time on fast navigations
                if (prevUrl && currentUrl === prevUrl) {
                  const deadline = Date.now() + 2000;
                  while (Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 100));
                    currentUrl = navPage.url();
                    if (currentUrl !== prevUrl) break;
                  }
                }

                if (prevUrl && currentUrl !== prevUrl) {
                  if (cTrace) cTrace.writeNavDetected({ fromUrl: prevUrl, toUrl: currentUrl });
                  const navStep = RecordingCaptureService.captureNavigation(currentUrl, prevUrl);
                  if (navStep) {
                    emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: navStep });
                    if (cTrace) cTrace.writeStepCaptured(navStep, 'nav_after_click');
                  }
                  sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, currentUrl);
                }
              }
            } catch (e) {
              logger.debug('[RECORDING] Click capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        const clickErrTrace = EditorTraceService.get(previewSessionId);
        if (clickErrTrace) clickErrTrace.writeError('click_failed', { x, y, button, error: result.error });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:click', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse down (drag start)
  socket.on('preview:mouse:down', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { x, y, button } = data;
      if (x === undefined || y === undefined) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'down',
        x,
        y,
        button,
      });

      if (result.success) {
        // Editor trace: log mouse down
        const downTrace = EditorTraceService.get(previewSessionId);
        if (downTrace) downTrace.writeMouseDown({ x, y, button });

        // V10 Fix #4: Recording hook — start drag tracking
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              const startElement = page
                ? await RecordingCaptureService.probeForRecording(page, x, y)
                : null;
              sessionService.setRecordingDragState(previewSessionId, ensuredUserId, {
                startX: x,
                startY: y,
                startElement,
                startedAt: Date.now(),
                viewport: page?.viewportSize() || undefined,
              });
            } catch (e) {
              logger.debug('[RECORDING] Drag start capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        const downErrTrace = EditorTraceService.get(previewSessionId);
        if (downErrTrace) downErrTrace.writeError('mouse_down_failed', { x, y, error: result.error });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:down', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse up (drag end)
  socket.on('preview:mouse:up', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { x, y, button } = data;
      if (x === undefined || y === undefined) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'up',
        x,
        y,
        button,
      });

      if (result.success) {
        if (result.needsSnapshot) {
          // Always emit snapshot after mouse up (drag end) so user sees visual feedback
          setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
        }

        // Editor trace: log mouse up
        const upTrace = EditorTraceService.get(previewSessionId);
        if (upTrace) upTrace.writeMouseUp({ x, y, button });

        // V10 Fix #4: Recording hook — detect drag & drop
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const dragState = sessionService.getRecordingDragState(previewSessionId, ensuredUserId);
              // Clear drag state regardless
              sessionService.setRecordingDragState(previewSessionId, ensuredUserId, null);

              if (!dragState) return; // No drag was started

              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );

              // Probe drop target
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              const endElement = page
                ? await RecordingCaptureService.probeForRecording(page, x, y)
                : null;

              const dragStep = RecordingCaptureService.captureDragAndDrop(
                dragState,
                x,
                y,
                endElement,
                page?.url(),
              );

              if (dragStep) {
                const room = createRoomName('preview', previewSessionId);
                emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: dragStep });
                // Editor trace: log drag-drop step
                const ddTrace = EditorTraceService.get(previewSessionId);
                if (ddTrace) {
                  ddTrace.writeDragDrop({
                    startX: dragState.startX, startY: dragState.startY,
                    endX: x, endY: y,
                    startElement: dragState.startElement, endElement,
                  });
                  ddTrace.writeStepCaptured(dragStep, 'drag_drop');
                }
              }
            } catch (e) {
              logger.debug('[RECORDING] Drag end capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        const upErrTrace = EditorTraceService.get(previewSessionId);
        if (upErrTrace) upErrTrace.writeError('mouse_up_failed', { x, y, error: result.error });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:up', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse wheel (scroll) — fire-and-forget for validation errors.
  // Scroll is high-frequency; emitting errors would spam the UI with toasts.
  //
  // V20: Coalescing — multiple wheel events arriving within one event-loop tick are
  // accumulated (deltas summed) into a single Playwright `mouse.wheel` call. Snapshot
  // emit and recording scroll debounce both run synchronously per WS event so neither
  // waits for the coalesced Playwright call.
  socket.on('preview:mouse:wheel', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { deltaX, deltaY } = data;
      if (deltaX === undefined || deltaY === undefined) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // V20: Coalesce — accumulate deltas until next event-loop tick, then send one wheel call.
      const wheelKey = `${socket.id}:${previewSessionId}`;
      let wState = wheelCoalesceState.get(wheelKey);
      if (!wState) {
        wState = {
          accDeltaX: deltaX,
          accDeltaY: deltaY,
          lastX: typeof data.x === 'number' ? data.x : undefined,
          lastY: typeof data.y === 'number' ? data.y : undefined,
          flushScheduled: false,
        };
        wheelCoalesceState.set(wheelKey, wState);
      } else {
        wState.accDeltaX += deltaX;
        wState.accDeltaY += deltaY;
        if (typeof data.x === 'number') wState.lastX = data.x;
        if (typeof data.y === 'number') wState.lastY = data.y;
      }
      if (!wState.flushScheduled) {
        wState.flushScheduled = true;
        const flushRef = wState;
        setImmediate(() => {
          const dx = flushRef.accDeltaX;
          const dy = flushRef.accDeltaY;
          flushRef.accDeltaX = 0;
          flushRef.accDeltaY = 0;
          flushRef.flushScheduled = false;
          if (dx === 0 && dy === 0) return;
          // Fire-and-forget — executeMouseWheel is itself fire-and-forget (V20)
          sessionService.executeMouseWheel({
            sessionId: previewSessionId,
            userId: ensuredUserId,
            deltaX: dx,
            deltaY: dy,
          }).catch(() => { /* non-critical — already logged inside */ });
        });
      }

      // V20: Side effects below run on EVERY WS event regardless of when the coalesced
      // wheel call lands in Playwright. Errors from the actual page.mouse.wheel() call
      // are logged at debug level inside executeMouseWheel and don't affect this path.
      {
        // Scroll may reveal lazy-loaded content – always emit for visual feedback
        setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));

        // Editor trace: log scroll input
        const scrollTrace = EditorTraceService.get(previewSessionId);
        if (scrollTrace) scrollTrace.writeScroll({ deltaX, deltaY });

        // V9: Recording hook — debounced scroll step
        // V10: Merge consecutive scrolls within SCROLL_MERGE_WINDOW_MS into a single step
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          const existing = recordingScrollTimers.get(previewSessionId);
          const accumulatedDeltaY = (existing?.deltaY ?? 0) + (data.deltaY ?? 0);
          // V14: Track horizontal scroll
          const accumulatedDeltaX = (existing?.deltaX ?? 0) + (data.deltaX ?? 0);
          if (existing) clearTimeout(existing.timer);

          // Detect scrollable container on first wheel event (if x,y provided by frontend)
          // Reuse container from existing accumulator if already detected
          let containerSelector = existing?.containerSelector;
          if (containerSelector === undefined && typeof data.x === 'number' && typeof data.y === 'number') {
            try {
              const { RecordingCaptureService } = await import('@/services/testing/ui/preview/recording-capture.service');
              const scrollPage = sessionService.getPage(previewSessionId, ensuredUserId);
              if (scrollPage) {
                containerSelector = await RecordingCaptureService.detectScrollContainer(scrollPage, data.x, data.y);
              }
            } catch { /* non-critical */ }
          }

          recordingScrollTimers.set(previewSessionId, {
            deltaY: accumulatedDeltaY,
            deltaX: accumulatedDeltaX,
            containerSelector,
            timer: setTimeout(async () => {
              try {
                const scrollState = recordingScrollTimers.get(previewSessionId);
                const finalDeltaY = scrollState?.deltaY ?? accumulatedDeltaY;
                const finalDeltaX = scrollState?.deltaX ?? accumulatedDeltaX;
                const finalContainerSelector = scrollState?.containerSelector ?? null;
                recordingScrollTimers.delete(previewSessionId);
                if (finalDeltaY === 0 && finalDeltaX === 0) return;

                const { RecordingCaptureService } = await import(
                  '@/services/testing/ui/preview/recording-capture.service'
                );
                const room = createRoomName('preview', previewSessionId);
                const sTrace = EditorTraceService.get(previewSessionId);

                // V13: Capture page URL for evidence (used by auto-wait injection)
                const scrollPage = sessionService.getPage(previewSessionId, ensuredUserId);
                const scrollPageUrl = scrollPage?.url();

                // V15: Guard against scroll before page load (race condition)
                if (!scrollPageUrl || scrollPageUrl === 'about:blank') return;

                // V15: Probe scroll target — find meaningful element near viewport center
                // so replay can use scrollIntoView instead of absolute pixels
                let scrollTargetHints: import('@/services/testing/ui/preview/preview.types').BindingHints | null = null;
                if (scrollPage) {
                  try {
                    scrollTargetHints = await RecordingCaptureService.probeScrollTarget(scrollPage);
                  } catch { /* non-critical */ }
                }

                // V10: Merge with previous scroll step if emitted recently (within 3s)
                const lastScrollStep = sessionService.getRecordingLastScrollStep(previewSessionId, ensuredUserId);
                const now = Date.now();
                const withinMergeWindow = lastScrollStep && (now - lastScrollStep.emittedAt) < RECORDING_SCROLL_MERGE_WINDOW_MS;
                // Only merge if same scroll target (both page-level, or same container)
                const sameScrollTarget = !lastScrollStep
                  || (lastScrollStep.containerSelector ?? null) === (finalContainerSelector ?? null);

                if (withinMergeWindow && lastScrollStep && sameScrollTarget) {
                  // Same direction or continuation — merge deltas
                  const mergedDelta = lastScrollStep.totalDelta + finalDeltaY;
                  const mergedDeltaX = (lastScrollStep.totalDeltaX || 0) + finalDeltaX;
                  const scrollStep = RecordingCaptureService.captureScroll(mergedDelta, scrollPageUrl, mergedDeltaX, scrollTargetHints ?? undefined, finalContainerSelector);
                  if (scrollStep) {
                    scrollStep.id = lastScrollStep.id; // Reuse original step id
                    socket.nsp.to(room).emit('preview:recording:step:update', {
                      previewSessionId, step: scrollStep, timestamp: new Date().toISOString(),
                    });
                    if (sTrace) sTrace.writeStepUpdated(scrollStep, 'scroll_merge');
                    sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, {
                      id: lastScrollStep.id,
                      totalDelta: mergedDelta,
                      totalDeltaX: mergedDeltaX,
                      emittedAt: now,
                      containerSelector: finalContainerSelector,
                    });
                  }
                } else {
                  // New scroll sequence — emit new step
                  const scrollStep = RecordingCaptureService.captureScroll(finalDeltaY, scrollPageUrl, finalDeltaX, scrollTargetHints ?? undefined, finalContainerSelector);
                  if (scrollStep) {
                    emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: scrollStep });
                    if (sTrace) sTrace.writeStepCaptured(scrollStep, 'scroll');
                    sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, {
                      id: scrollStep.id,
                      totalDelta: finalDeltaY,
                      totalDeltaX: finalDeltaX,
                      emittedAt: now,
                      containerSelector: finalContainerSelector,
                    });
                  }
                }
              } catch (e) {
                logger.debug('[RECORDING] Scroll capture failed', {
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }, RECORDING_SCROLL_DEBOUNCE_MS),
          });
        }
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:wheel', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle keyboard type
  socket.on('preview:keyboard:type', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'keyboard')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { text } = data;
      if (!text) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeKeyboardType({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        text,
      });

      if (result.success) {
        setImmediate(() => emitSnapshotIfChanged(socket, previewSessionId, ensuredUserId));

        // Editor trace: log type input
        const typeTrace = EditorTraceService.get(previewSessionId);
        if (typeTrace) typeTrace.writeType({ text: data.text });

        // V9: Recording hook — accumulate typing into buffer
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );

              // V13: Check if this typing is from a paste (Ctrl+V/Cmd+V detected in keyboard:press)
              const isPaste = sessionService.isRecordingPendingPaste(previewSessionId, ensuredUserId);
              if (isPaste) {
                sessionService.setRecordingPendingPaste(previewSessionId, ensuredUserId, false);

                // V22 Pkg8: paste replaces / appends-to live input value.
                // Close any active Field Session FIRST so its canonical
                // Type step is emitted with the pre-paste value (avoids
                // a duplicate / wrong-order step). Paste itself emits as
                // its own dedicated step below.
                await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, 'paste');

                // Immediately emit paste step — no debounce, no merge with regular typing
                const page = sessionService.getPage(previewSessionId, ensuredUserId);
                const focusedEl = page ? await RecordingCaptureService.probeFocusedElement(page) : null;
                const label = RecordingCaptureService.getElementLabel(focusedEl);
                const pasteStep: PreviewIntentStep = {
                  id: `rec_${require('crypto').randomUUID().slice(0, 8)}`,
                  type: 'type',
                  description: `Paste '${data.text.slice(0, 40)}' in '${label}'`,
                  value: data.text,
                  bindingHints: focusedEl ? RecordingCaptureService.buildBindingHints(focusedEl) as Record<string, string> : undefined,
                  options: { isPaste: true },
                  evidence: {
                    ...(focusedEl?.ref && { lastSuccessRef: focusedEl.ref }),
                    confidence: 1.0,
                    pageUrl: page?.url(),
                    capturedAt: new Date().toISOString(), // V15.7: TTL support
                  },
                };
                const room = createRoomName('preview', previewSessionId);
                emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: pasteStep });
                const ptTrace = EditorTraceService.get(previewSessionId);
                if (ptTrace) ptTrace.writeStepCaptured(pasteStep, 'paste');
                return; // Don't accumulate paste into typing buffer
              }

              let buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);

              if (!buffer) {
                // First character — probe focused element for label
                const page = sessionService.getPage(previewSessionId, ensuredUserId);
                const focusedEl = page ? await RecordingCaptureService.probeFocusedElement(page) : null;
                // V22: capture fingerprint at focus time so the eventual
                // type-step has identifying data on first apply.
                const focusedFp = focusedEl
                  ? RecordingCaptureService.buildRecordedFingerprint(focusedEl)
                  : undefined;
                buffer = {
                  text: data.text,
                  elementRef: focusedEl?.ref,
                  elementLabel: RecordingCaptureService.getElementLabel(focusedEl),
                  lastCharAt: Date.now(),
                  bindingHints: focusedEl ? RecordingCaptureService.buildBindingHints(focusedEl) as Record<string, string> : undefined,
                  recordedFingerprint: focusedFp && Object.keys(focusedFp).length > 0 ? focusedFp : undefined,
                  isMultiline: focusedEl?.isMultiline,
                  pageUrl: page?.url(),
                  iframeSelector: focusedEl?.iframeSelector, // V13: iframe context for replay
                };

                // V22 Pkg8: open a Field Session in parallel — captures the
                // user's intent to FILL this control as one logical unit,
                // independent of the per-keystroke buffer above. The session
                // closes on focus shift / click outside / nav / submit and
                // emits ONE step with the live input.value as the canonical
                // final value (resilient to mid-string Backspace, arrow-key
                // edits, paste, autocomplete picks).
                const existingFs = sessionService.getRecordingFieldSession(previewSessionId, ensuredUserId);
                const sameTarget = existingFs && existingFs.elementRef === focusedEl?.ref;
                if (!sameTarget && focusedEl?.ref) {
                  // Different target than previous session → close the prior
                  // session first (emits its own Type step with live value),
                  // then open a fresh one for the new control.
                  if (existingFs) {
                    await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, 'focus_shift_type');
                  }
                  // Read the initial input value so we can detect "user typed
                  // and erased everything back to the original" later. This
                  // is async but fast — page already loaded the control.
                  let initialValue = '';
                  try {
                    const refSel = `[data-agent-ref="${focusedEl.ref}"]`;
                    const tagL = (focusedEl.tag || '').toLowerCase();
                    if (tagL === 'input' || tagL === 'textarea' || tagL === 'select') {
                      initialValue = await page!.locator(refSel).first().inputValue({ timeout: 300 }).catch(() => '');
                    } else {
                      initialValue = await page!.locator(refSel).first().evaluate(
                        (el: any) => el?.textContent || '',
                        undefined,
                        { timeout: 300 },
                      ).catch(() => '');
                    }
                  } catch { /* tolerant — empty initial is the safe default */ }
                  sessionService.setRecordingFieldSession(previewSessionId, ensuredUserId, {
                    elementRef: focusedEl.ref,
                    elementLabel: RecordingCaptureService.getElementLabel(focusedEl),
                    elementTag: focusedEl.tag || '',
                    elementType: focusedEl.type || undefined,
                    isMultiline: focusedEl.isMultiline,
                    initialValue,
                    startedAt: Date.now(),
                    pageUrl: page?.url() || '',
                    iframeSelector: focusedEl.iframeSelector,
                    recordedFingerprint: focusedFp && Object.keys(focusedFp).length > 0 ? focusedFp : undefined,
                    // V22 Pkg8: pre-build BindingHints at session open so
                    // close-time emission can reuse them — no second probe.
                    bindingHints: RecordingCaptureService.buildBindingHints(focusedEl) as Record<string, unknown>,
                  });
                }
              } else {
                buffer.text += data.text;
                buffer.lastCharAt = Date.now();
              }

              sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, buffer);

              // Reset debounce timer
              const existingTimer = recordingTypingTimers.get(previewSessionId);
              if (existingTimer) clearTimeout(existingTimer);

              recordingTypingTimers.set(previewSessionId, setTimeout(async () => {
                try {
                  // V22 Pkg8: when a Field Session is active, debounced
                  // mid-typing flushes are pre-empted. The session closes
                  // on click/nav/blur and reads live input.value as the
                  // canonical Type step value — running a buffer flush
                  // here would emit a duplicate (or worse, an outdated
                  // intermediate value). We DO NOT close the session
                  // from a timer because the user may still be typing
                  // in this same field; closing on quiet would reset
                  // the SoT contract.
                  if (sessionService.getRecordingFieldSession(previewSessionId, ensuredUserId)) {
                    sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                    return;
                  }
                  const currentBuffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
                  if (currentBuffer) {
                    const room = createRoomName('preview', previewSessionId);
                    const tTrace = EditorTraceService.get(previewSessionId);

                    // V10: Check if this is a continuation of typing in the same element
                    const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                    const sameElement = lastTypeStep
                      && currentBuffer.elementRef
                      && lastTypeStep.elementRef === currentBuffer.elementRef;

                    if (sameElement && lastTypeStep) {
                      // Merge: combine previous + current text, reuse same step id
                      const mergedValue = lastTypeStep.value + currentBuffer.text;
                      const mergedStep = RecordingCaptureService.flushTypingBuffer({
                        ...currentBuffer,
                        text: mergedValue,
                      });
                      if (mergedStep) {
                        mergedStep.id = lastTypeStep.id; // Reuse the original step id
                        socket.nsp.to(room).emit('preview:recording:step:update', {
                          previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                        });
                        if (tTrace) tTrace.writeStepUpdated(mergedStep, 'type_merge');
                        sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                          id: lastTypeStep.id,
                          elementRef: currentBuffer.elementRef,
                          value: mergedValue,
                        });
                      }
                    } else {
                      // New element or first type — emit new step
                      const step = RecordingCaptureService.flushTypingBuffer(currentBuffer);
                      if (step) {
                        emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
                        if (tTrace) tTrace.writeStepCaptured(step, 'type');
                        sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                          id: step.id,
                          elementRef: currentBuffer.elementRef,
                          value: currentBuffer.text,
                        });
                      }
                    }

                    sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                  }
                } catch (e) {
                  logger.debug('[RECORDING] Typing flush failed', {
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
                recordingTypingTimers.delete(previewSessionId);
              }, RECORDING_TYPING_DEBOUNCE_MS));
            } catch (e) {
              logger.debug('[RECORDING] Type capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        const typeErrTrace = EditorTraceService.get(previewSessionId);
        if (typeErrTrace) typeErrTrace.writeError('type_failed', { text: data.text, error: result.error });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:keyboard:type', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle keyboard press
  socket.on('preview:keyboard:press', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'keyboard')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const { key, modifiers } = data;
      if (!key) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeKeyboardPress({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        key,
        modifiers,
      });

      if (result.success) {
        setImmediate(() => emitSnapshotIfChanged(socket, previewSessionId, ensuredUserId));

        // Editor trace: log press input
        const pressTrace = EditorTraceService.get(previewSessionId);
        if (pressTrace) pressTrace.writePress({ key, modifiers, isRecording: sessionService.isRecording(previewSessionId, ensuredUserId) });

        // V9: Recording hook — flush typing buffer + emit press step
        // V10: When Enter is pressed after typing, merge into single step with pressEnter:true
        // V10 Fix #1: Shift+Enter in multiline elements appends \n to buffer instead of flushing
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const room = createRoomName('preview', previewSessionId);
              const pTrace = EditorTraceService.get(previewSessionId);

              // Flush pending scroll before press step — preserve step order
              await flushPendingScroll(socket, previewSessionId, ensuredUserId, sessionService, 'press');

              // V13: Detect paste (Ctrl+V / Cmd+V) — set flag so next keyboard:type marks step as isPaste
              const isPasteShortcut = data.key?.toLowerCase() === 'v'
                && data.modifiers
                && (data.modifiers.includes('Control') || data.modifiers.includes('Meta'))
                && !data.modifiers.includes('Shift'); // Shift+Ctrl+V is "paste as plain text" — handled separately if needed
              if (isPasteShortcut) {
                // Flush any existing typing buffer before paste (different input method)
                const existingBuffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
                if (existingBuffer) {
                  const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                  const sameElement = lastTypeStep && existingBuffer.elementRef && lastTypeStep.elementRef === existingBuffer.elementRef;
                  if (sameElement && lastTypeStep) {
                    const mergedValue = lastTypeStep.value + existingBuffer.text;
                    const mergedStep = RecordingCaptureService.flushTypingBuffer({ ...existingBuffer, text: mergedValue });
                    if (mergedStep) {
                      mergedStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                      });
                    }
                  } else {
                    const step = RecordingCaptureService.flushTypingBuffer(existingBuffer);
                    if (step) {
                      emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
                    }
                  }
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                  sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                  const timer = recordingTypingTimers.get(previewSessionId);
                  if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
                }

                sessionService.setRecordingPendingPaste(previewSessionId, ensuredUserId, true);
                return; // Don't emit press step for Ctrl+V
              }

              const isEnterKey = data.key === 'Enter';
              let mergedEnterIntoType = false;

              // V10 Fix #1: Detect Shift+Enter in multiline → append \n to buffer
              const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
              const isMultiline = buffer?.isMultiline ?? false;

              if (RecordingCaptureService.isNewlineInsertion(data.key, data.modifiers, isMultiline)) {
                // Shift+Enter in textarea/contenteditable = newline character
                // Append \n to typing buffer instead of flushing
                if (buffer) {
                  buffer.text += '\n';
                  buffer.lastCharAt = Date.now();
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, buffer);

                  // Reset debounce timer (same as regular typing, with merge logic)
                  const existingTimer = recordingTypingTimers.get(previewSessionId);
                  if (existingTimer) clearTimeout(existingTimer);
                  recordingTypingTimers.set(previewSessionId, setTimeout(async () => {
                    try {
                      const currentBuffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
                      if (currentBuffer) {
                        // V10: Same merge logic as keyboard:type debounce
                        const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                        const sameElement = lastTypeStep
                          && currentBuffer.elementRef
                          && lastTypeStep.elementRef === currentBuffer.elementRef;

                        if (sameElement && lastTypeStep) {
                          const mergedValue = lastTypeStep.value + currentBuffer.text;
                          const mergedStep = RecordingCaptureService.flushTypingBuffer({
                            ...currentBuffer,
                            text: mergedValue,
                          });
                          if (mergedStep) {
                            mergedStep.id = lastTypeStep.id;
                            socket.nsp.to(room).emit('preview:recording:step:update', {
                              previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                            });
                            if (pTrace) pTrace.writeStepUpdated(mergedStep, 'multiline_type_merge');
                            sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                              id: lastTypeStep.id,
                              elementRef: currentBuffer.elementRef,
                              value: mergedValue,
                            });
                          }
                        } else {
                          const step = RecordingCaptureService.flushTypingBuffer(currentBuffer);
                          if (step) {
                            emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
                            if (pTrace) pTrace.writeStepCaptured(step, 'multiline_type');
                            sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                              id: step.id,
                              elementRef: currentBuffer.elementRef,
                              value: currentBuffer.text,
                            });
                          }
                        }
                        sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                      }
                    } catch { /* ignore */ }
                    recordingTypingTimers.delete(previewSessionId);
                  }, RECORDING_TYPING_DEBOUNCE_MS));
                }
                // Don't flush, don't emit press step — the \n is part of the typed text
                return;
              }

              // Backspace/Delete while typing: edit the buffer instead of emitting a separate press step.
              // This ensures the recorded type step reflects the final corrected text, not the raw keystrokes.
              if (data.key === 'Backspace' || data.key === 'Delete') {
                const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);

                if (buffer && buffer.text.length > 0) {
                  // Case 1: Active buffer with text — remove last char from current buffer batch
                  buffer.text = buffer.text.slice(0, -1);
                  buffer.lastCharAt = Date.now();
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, buffer);

                  // If we have a previously emitted step for same element, update it with corrected merge
                  const sameElement = lastTypeStep
                    && buffer.elementRef
                    && lastTypeStep.elementRef === buffer.elementRef;

                  if (sameElement && lastTypeStep) {
                    const mergedValue = lastTypeStep.value + buffer.text;
                    const mergedStep = RecordingCaptureService.flushTypingBuffer({
                      ...buffer, text: mergedValue,
                    });
                    if (mergedStep) {
                      mergedStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepUpdated(mergedStep, 'backspace_buffer_edit');
                    }
                  }
                  return; // Absorbed into buffer edit
                }

                if (lastTypeStep && lastTypeStep.value.length > 0) {
                  // Case 2: Buffer is empty/null (debounce already flushed) — trim the lastTypeStep value directly
                  const trimmedValue = lastTypeStep.value.slice(0, -1);
                  sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                    ...lastTypeStep,
                    value: trimmedValue,
                  });

                  if (trimmedValue.length > 0) {
                    const updatedStep = RecordingCaptureService.flushTypingBuffer({
                      text: trimmedValue,
                      elementLabel: '',
                      elementRef: lastTypeStep.elementRef,
                      lastCharAt: Date.now(),
                    });
                    if (updatedStep) {
                      updatedStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: updatedStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepUpdated(updatedStep, 'backspace_trim');
                    }
                  } else {
                    // All text deleted — remove the step entirely. Keep the
                    // session step counter honest so the max-steps cap only
                    // counts *surviving* steps the user will have to apply.
                    const stepCount = sessionService.decrementRecordingStepCount(previewSessionId, ensuredUserId);
                    socket.nsp.to(room).emit('preview:recording:step:remove', {
                      previewSessionId, stepId: lastTypeStep.id, stepCount, timestamp: new Date().toISOString(),
                    });
                    if (pTrace) pTrace.writeStepRemoved(lastTypeStep.id, 'all_text_deleted');
                    sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                  }
                  return; // Absorbed into lastTypeStep edit
                }

                // No buffer and no lastTypeStep — fall through to emit "Press Backspace" as normal
              }

              // V22 Pkg8: close Field Session on Enter/Tab/Escape — these
              // keys terminate the editing transaction (Enter submits,
              // Tab moves to next control, Escape cancels). Reads live
              // input.value and emits the canonical Type step, then the
              // legacy buffer flush below becomes a no-op (handled by
              // the in-fn skip when session was active).
              if (RecordingCaptureService.shouldFlushOnKey(data.key, data.modifiers, isMultiline)
                  && sessionService.getRecordingFieldSession(previewSessionId, ensuredUserId)) {
                await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, `key_${data.key.toLowerCase()}`);
              }

              // Flush typing buffer if Enter/Tab triggers it
              if (RecordingCaptureService.shouldFlushOnKey(data.key, data.modifiers, isMultiline)) {
                if (buffer) {
                  // V10: If Enter triggered the flush and there's text in the buffer,
                  // merge type + Enter into a single step with pressEnter: true.
                  // This avoids creating two steps (type + press Enter) and prevents
                  // double-Enter during replay.
                  //
                  // V10: Also merge with previous type step if same element
                  const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                  const sameElement = lastTypeStep
                    && buffer.elementRef
                    && lastTypeStep.elementRef === buffer.elementRef;

                  if (sameElement && lastTypeStep) {
                    // Merge with previously emitted step for same element
                    const mergedValue = lastTypeStep.value + buffer.text;
                    const typingStep = RecordingCaptureService.flushTypingBuffer(
                      { ...buffer, text: mergedValue },
                      isEnterKey,
                    );
                    if (typingStep) {
                      typingStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepUpdated(typingStep, isEnterKey ? 'type_merge_enter' : 'type_merge_flush');
                      if (isEnterKey) mergedEnterIntoType = true;
                    }
                  } else {
                    const typingStep = RecordingCaptureService.flushTypingBuffer(
                      buffer,
                      isEnterKey,
                    );
                    if (typingStep) {
                      emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: typingStep });
                      if (pTrace) pTrace.writeStepCaptured(typingStep, isEnterKey ? 'type_enter' : 'type_flush');
                      if (isEnterKey) mergedEnterIntoType = true;
                    }
                  }

                  // Enter/Tab = user finished typing in this field → clear merge state
                  sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                  const timer = recordingTypingTimers.get(previewSessionId);
                  if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
                }
              }

              // V22 Pkg8: Suppress navigation keys when a Field Session is
              // active. ArrowLeft/Right/Up/Down + Home/End inside an open
              // input are cursor-positioning operations, not user-intent
              // steps. The eventual Type step's value (read from live
              // input.value at session close) already reflects whatever
              // edits the user made at any cursor position. Emitting a
              // separate "Press ArrowLeft × 4" step:
              //   - clutters the UI (8 atomic steps for one fill action)
              //   - is meaningless on replay (Playwright's locator.fill()
              //     sets the final value directly, no cursor walk needed)
              //   - confuses non-technical users reviewing the trace
              // Backspace/Delete: when a Field Session is open we suppress
              // the press emission too — the canonical Type step (read at
              // session close from live input.value) already reflects whatever
              // characters survived. A dangling "Press Backspace" step in
              // the trace would replay BEFORE the Type step could correct
              // for it, double-clobbering the input on replay.
              const fsActive = sessionService.getRecordingFieldSession(previewSessionId, ensuredUserId);
              const isNavKeyInsideFieldSession =
                fsActive
                && (
                  data.key === 'ArrowLeft' || data.key === 'ArrowRight'
                  || data.key === 'ArrowUp' || data.key === 'ArrowDown'
                  || data.key === 'Home' || data.key === 'End'
                  || data.key === 'Backspace' || data.key === 'Delete'
                );
              // Emit press step for meaningful keys
              // V10: Skip emitting separate "Press Enter" if it was merged into the type step
              if (!mergedEnterIntoType && !isNavKeyInsideFieldSession) {
                const pressStep = RecordingCaptureService.capturePress(data.key, data.modifiers);
                if (pressStep) {
                  // Coalesce consecutive identical presses into one step with
                  // a "× N" suffix. Mashing Backspace on an empty field used
                  // to produce one standalone step per keystroke — you'd end
                  // up with 5–6 duplicated "Press Backspace" rows. Now they
                  // fold into one step that updates its description in place.
                  //
                  // Identity = same key AND same modifier combo. Any other
                  // key breaks the chain (handled by `setRecordingLastPressStep(null)`
                  // below).
                  const modifiersKey = Array.isArray(data.modifiers) && data.modifiers.length > 0
                    ? [...data.modifiers].sort().join('+')
                    : '';
                  const lastPress = sessionService.getRecordingLastPressStep(previewSessionId, ensuredUserId);
                  const isSameKey = !!lastPress
                    && lastPress.key === data.key
                    && lastPress.modifiersKey === modifiersKey;

                  if (isSameKey && lastPress) {
                    // Update in place — bump the count and re-emit as :step:update.
                    const nextCount = lastPress.count + 1;
                    const keyLabel = modifiersKey ? `${modifiersKey}+${data.key}` : data.key;
                    const updatedStep = {
                      ...pressStep,
                      id: lastPress.id,
                      description: `Press ${keyLabel} × ${nextCount}`,
                    };
                    socket.nsp.to(room).emit('preview:recording:step:update', {
                      previewSessionId,
                      step: updatedStep,
                      timestamp: new Date().toISOString(),
                    });
                    if (pTrace) pTrace.writeStepUpdated(updatedStep, 'press_coalesce');
                    sessionService.setRecordingLastPressStep(previewSessionId, ensuredUserId, {
                      id: lastPress.id,
                      key: data.key,
                      modifiersKey,
                      count: nextCount,
                    });
                  } else {
                    emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: pressStep });
                    if (pTrace) pTrace.writeStepCaptured(pressStep, 'press');
                    sessionService.setRecordingLastPressStep(previewSessionId, ensuredUserId, {
                      id: pressStep.id,
                      key: data.key,
                      modifiersKey,
                      count: 1,
                    });
                  }
                }
              }
            } catch (e) {
              logger.debug('[RECORDING] Press capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        // Silent — no error emit for press; trace only
        const pressErrTrace = EditorTraceService.get(previewSessionId);
        if (pressErrTrace) pressErrTrace.writeError('press_failed', { key, error: result.error });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:keyboard:press', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle viewport change (live resize)
  socket.on('preview:viewport:set', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, width, height } = data;

      if (!previewSessionId || !Number.isFinite(width) || !Number.isFinite(height)) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'Missing previewSessionId or invalid dimensions',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const normalizedPreviewSessionId = String(previewSessionId).trim();

      logger.info('[WebSocket] Viewport change requested', {
        socketId: socket.id,
        previewSessionId: normalizedPreviewSessionId,
        width,
        height,
      });

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.setViewport(normalizedPreviewSessionId, ensuredUserId, width, height);

      if (!result.success) {
        socket.emit('error', {
          code: 'VIEWPORT_CHANGE_FAILED',
          message: result.error || 'Failed to change viewport',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Restart video stream so CDP screencast renders at the NEW resolution.
      // Without this, CDP continues emitting frames at the old viewport size.
      const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
      const videoReg = getPreviewVideoStreamRegistry();
      const session = sessionService.getSession(normalizedPreviewSessionId);
      if (session?.page) {
        const room = createRoomName('preview', normalizedPreviewSessionId);
        await videoReg.startStream(normalizedPreviewSessionId, ensuredUserId, room, session.page, socket.nsp);
      }

      // Force snapshot re-collect with the new viewport already reflowed.
      // This ensures domNodes/boundingBox are correct BEFORE the client rescales.
      // V20: bypass signature dedup — the frontend treats this as a handshake and
      // must receive the snapshot even when DOM bytes are unchanged, because it
      // needs the fresh coordinates for its rescale pipeline.
      await emitSnapshotForHandshake(socket, normalizedPreviewSessionId, ensuredUserId);

      // Emit viewport metadata so client updates coordinate mapping
      // with coordinates that match the freshly-collected snapshot.
      const roomName = createRoomName('preview', normalizedPreviewSessionId);
      const viewportPayload = {
        previewSessionId: normalizedPreviewSessionId,
        viewport: { width, height },
        devicePixelRatio: 1,
        timestamp: new Date().toISOString(),
      };
      socket.emit('preview:viewport', viewportPayload);
      socket.to(roomName).emit('preview:viewport', viewportPayload);
    } catch (error) {
      logger.error('[WebSocket] Error in preview:viewport:set', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle page refresh
  socket.on('preview:page:refresh', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) {
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        return;
      }

      logger.info('[WebSocket] Preview refresh requested', { previewSessionId, userId: ensuredUserId });

      // Block page actions during active run — prevents race conditions with step execution
      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
      if (PreviewRunService.isRunning(previewSessionId)) {
        emitPageActionResult(socket, previewSessionId, 'refresh', false, 'Cannot refresh while test is running');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Refresh page
      const result = await sessionService.refreshPage(previewSessionId, ensuredUserId);

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'refresh', true);
        // Snapshot is already kicked off inside refreshPage() via setImmediate —
        // the DOM-update interval (500ms) will pick it up and emit preview:page.

        // V13: Re-arm the first-frame guarantee instead of issuing a single
        // injectFrame. After page.reload() the existing CDP screencast may
        // emit no frames until the page repaints, so we need the same retry
        // ladder used at start() to survive transient inject failures.
        try {
          const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
          getPreviewVideoStreamRegistry().armFirstFrameGuarantee(previewSessionId);
        } catch {
          // Non-critical — CDP screencast will resume on its own
        }

        // V9: Recording hook — flush buffers and update URL baseline after refresh
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );

              const room = createRoomName('preview', previewSessionId);

              // Flush pending scroll + typing + close Field Session before refresh.
              await flushPendingScroll(socket, previewSessionId, ensuredUserId, sessionService, 'refresh');
              flushPendingTyping(socket, previewSessionId, ensuredUserId, sessionService, RecordingCaptureService, 'refresh');
              // V22 Pkg8: refresh wipes DOM — close session NOW while ref still valid.
              await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, 'refresh');

              // V11: Record a navigate step for refresh.
              // Coalesce consecutive refreshes on the same URL so mashing F5
              // doesn't create 3–5 identical "Refresh page" rows.
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              if (page) {
                const currentUrl = page.url();
                const lastNav = sessionService.getRecordingLastNavigateStep(previewSessionId, ensuredUserId);
                const isRepeatRefresh = !!lastNav
                  && lastNav.kind === 'refresh'
                  && lastNav.url === currentUrl;

                if (isRepeatRefresh && lastNav) {
                  const nextCount = lastNav.count + 1;
                  const updatedStep: PreviewIntentStep = {
                    id: lastNav.id,
                    type: 'navigate',
                    description: `Refresh page × ${nextCount}`,
                    value: currentUrl,
                  };
                  socket.nsp.to(room).emit('preview:recording:step:update', {
                    previewSessionId,
                    step: updatedStep,
                    timestamp: new Date().toISOString(),
                  });
                  sessionService.setRecordingLastNavigateStep(previewSessionId, ensuredUserId, {
                    id: lastNav.id,
                    url: currentUrl,
                    kind: 'refresh',
                    count: nextCount,
                  });
                } else {
                  const refreshStep: PreviewIntentStep = {
                    id: `rec_${Date.now().toString(36)}`,
                    type: 'navigate',
                    description: 'Refresh page',
                    value: currentUrl,
                  };
                  emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: refreshStep });
                  sessionService.setRecordingLastNavigateStep(previewSessionId, ensuredUserId, {
                    id: refreshStep.id,
                    url: currentUrl,
                    kind: 'refresh',
                    count: 1,
                  });
                }

                // Update URL baseline (URL may change after redirect)
                sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, currentUrl);
              }
            } catch (e) {
              logger.debug('[RECORDING] Refresh hook failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        emitPageActionResult(socket, previewSessionId, 'refresh', false, 'Refresh failed or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:refresh', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'refresh', false, 'Internal error');
      }
    }
  });

  // Handle page back (browser history)
  socket.on('preview:page:back', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      logger.info('[WebSocket] Preview goBack requested', { previewSessionId, userId: ensuredUserId });

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
      if (PreviewRunService.isRunning(previewSessionId)) {
        emitPageActionResult(socket, previewSessionId, 'back', false, 'Cannot navigate while test is running');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Flush pending scroll+typing before navigation — preserve step order
      if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
        await flushPendingScroll(socket, previewSessionId, ensuredUserId, sessionService, 'back');
        try {
          const { RecordingCaptureService } = await import('@/services/testing/ui/preview/recording-capture.service');
          flushPendingTyping(socket, previewSessionId, ensuredUserId, sessionService, RecordingCaptureService, 'back');
          // V22 Pkg8: close Field Session before back navigation — DOM about to swap.
          await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, 'back');
        } catch { /* non-critical */ }
      }

      const result = await sessionService.goBack(previewSessionId, ensuredUserId);

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'back', true);
        // Snapshot is already kicked off inside goBack() via setImmediate —
        // the DOM-update interval (500ms) will pick it up and emit preview:page.

        // V13: Re-arm first-frame guarantee instead of single injectFrame.
        try {
          const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
          getPreviewVideoStreamRegistry().armFirstFrameGuarantee(previewSessionId);
        } catch {
          // Non-critical
        }

        // V11: Recording hook — record navigate step for back
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          const page = sessionService.getPage(previewSessionId, ensuredUserId);
          if (page) {
            const room = createRoomName('preview', previewSessionId);
            const step: PreviewIntentStep = {
              id: `rec_${Date.now().toString(36)}`,
              type: 'navigate',
              description: 'Navigate back',
              value: page.url(),
            };
            emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
            sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
          }
        }
      } else {
        emitPageActionResult(socket, previewSessionId, 'back', false, 'No history to go back or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:back', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'back', false, 'Internal error');
      }
    }
  });

  // Handle page forward (browser history)
  socket.on('preview:page:forward', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      logger.info('[WebSocket] Preview goForward requested', { previewSessionId, userId: ensuredUserId });

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
      if (PreviewRunService.isRunning(previewSessionId)) {
        emitPageActionResult(socket, previewSessionId, 'forward', false, 'Cannot navigate while test is running');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Flush pending scroll+typing before navigation — preserve step order
      if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
        await flushPendingScroll(socket, previewSessionId, ensuredUserId, sessionService, 'forward');
        try {
          const { RecordingCaptureService } = await import('@/services/testing/ui/preview/recording-capture.service');
          flushPendingTyping(socket, previewSessionId, ensuredUserId, sessionService, RecordingCaptureService, 'forward');
          // V22 Pkg8: close Field Session before forward navigation.
          await closeFieldSession(socket, previewSessionId, ensuredUserId, sessionService, 'forward');
        } catch { /* non-critical */ }
      }

      const result = await sessionService.goForward(previewSessionId, ensuredUserId);

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'forward', true);
        // Snapshot is already kicked off inside goForward() via setImmediate —
        // the DOM-update interval (500ms) will pick it up and emit preview:page.

        // V13: Re-arm first-frame guarantee instead of single injectFrame.
        try {
          const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
          getPreviewVideoStreamRegistry().armFirstFrameGuarantee(previewSessionId);
        } catch {
          // Non-critical
        }

        // V11: Recording hook — record navigate step for forward
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          const page = sessionService.getPage(previewSessionId, ensuredUserId);
          if (page) {
            const room = createRoomName('preview', previewSessionId);
            const step: PreviewIntentStep = {
              id: `rec_${Date.now().toString(36)}`,
              type: 'navigate',
              description: 'Navigate forward',
              value: page.url(),
            };
            emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
            sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
          }
        }
      } else {
        emitPageActionResult(socket, previewSessionId, 'forward', false, 'No history to go forward or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:forward', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'forward', false, 'Internal error');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V15: Multi-tab — switch active tab
  // ═══════════════════════════════════════════════════════════════════════════
  socket.on('preview:tab:switch', async (data: { previewSessionId?: string; tabIndex?: number }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const tabIndex = data.tabIndex;
      if (tabIndex === undefined || tabIndex === null || typeof tabIndex !== 'number') {
        socket.emit('preview:tab:switched', {
          previewSessionId,
          tabs: [],
          activeTabIndex: 0,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      logger.info('[WebSocket] Tab switch requested', { previewSessionId, tabIndex, userId: ensuredUserId });

      const { getPreviewSessionService: getSessionSvc } = await import('@/services/testing/ui/preview');
      const sessionService = getSessionSvc();
      const switched = await sessionService.switchTab(previewSessionId, ensuredUserId, tabIndex);

      if (!switched) {
        logger.warn('[WebSocket] Tab switch failed', { previewSessionId, tabIndex });
      }

      // Emit tab list regardless (so frontend stays in sync)
      const tabsInfo = sessionService.getTabsInfo(previewSessionId, ensuredUserId);
      const session = sessionService.getSession(previewSessionId);

      socket.emit('preview:tab:switched', {
        previewSessionId,
        tabs: tabsInfo,
        activeTabIndex: session?.activeTabIndex ?? 0,
        timestamp: new Date().toISOString(),
      });

      // If recording and switched successfully, emit a switch_tab recording step
      if (switched && session?.recording) {
        const newPage = sessionService.getPage(previewSessionId, ensuredUserId);
        const newUrl = newPage?.url() || '';
        socket.emit('preview:recording:step', {
          previewSessionId,
          step: {
            id: `switch-tab-${Date.now()}`,
            type: 'switch_tab',
            description: `Switch to tab ${tabIndex}`,
            value: String(tabIndex),
            tabIndex,
            evidence: {
              pageUrl: newUrl,
              tabIndex,
            },
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:tab:switch', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // V-PhaseB: Close a secondary/popup tab. The frontend's tab bar puts a
  // "×" button on every non-root tab; it emits this event. Root tab is
  // protected server-side (`closeTab` refuses when pages.length <= 1) so
  // the UI can't accidentally orphan the session. Rebroadcasts the
  // updated tab list to everyone subscribed to the preview room so
  // multiple-connected-clients (editor + devtools panel) stay in sync.
  socket.on('preview:tab:close', async (data: { previewSessionId?: string; tabIndex?: number }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;
      if (!checkRateLimit(socket.id, 'pageAction')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      const tabIndex = data.tabIndex;
      if (typeof tabIndex !== 'number' || !Number.isFinite(tabIndex) || tabIndex < 0) {
        logger.warn('[WebSocket] Invalid tab close request', { previewSessionId, tabIndex });
        return;
      }

      logger.info('[WebSocket] Tab close requested', { previewSessionId, tabIndex, userId: ensuredUserId });

      const { getPreviewSessionService: getSessionSvc } = await import('@/services/testing/ui/preview');
      const sessionService = getSessionSvc();
      const closed = await sessionService.closeTab(previewSessionId, ensuredUserId, tabIndex);

      if (!closed) {
        // closeTab() returns false on: invalid index, last tab (root guard),
        // or unauthorized. Log for debug and emit nothing — client keeps its
        // existing tab list which already reflects reality.
        logger.warn('[WebSocket] Tab close refused', { previewSessionId, tabIndex });
        return;
      }

      const tabsInfo = sessionService.getTabsInfo(previewSessionId, ensuredUserId);
      const session = sessionService.getSession(previewSessionId);
      const room = createRoomName('preview', previewSessionId);

      // Emit to ROOM (not only this socket) so every connected client sees
      // the closure. closeTab() already fired onPageSwitch internally when
      // the active tab was the closed one, which restarts video/devtools
      // on the newly-active page via preview.handler's session callback.
      socket.nsp.to(room).emit('preview:tab:closed', {
        previewSessionId,
        tabs: tabsInfo,
        activeTabIndex: session?.activeTabIndex ?? 0,
        closedTabIndex: tabIndex,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:tab:close', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle page reset
  socket.on('preview:page:reset', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) {
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        return;
      }

      logger.info('[WebSocket] Preview reset requested', { previewSessionId, userId: ensuredUserId });

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
      if (PreviewRunService.isRunning(previewSessionId)) {
        emitPageActionResult(socket, previewSessionId, 'reset', false, 'Cannot reset while test is running');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Editor trace — capture reset entry so future regressions in the
      // reset path (video freeze, stale page handle, etc.) show up in the
      // JSONL without needing to grep server logs.
      const resetEntryTrace = EditorTraceService.get(previewSessionId);
      const resetStart = Date.now();
      const resetFromUrl = sessionService.getPage(previewSessionId, ensuredUserId)?.url();
      resetEntryTrace?.writeSessionReset({ phase: 'start', fromUrl: resetFromUrl });

      // V9: Capture recording state BEFORE reset (reset clears it)
      const wasRecording = sessionService.isRecording(previewSessionId, ensuredUserId);
      if (wasRecording) {
        // Flush typing buffer before reset destroys the session state
        const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
        if (buffer) {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );
          const typingStep = RecordingCaptureService.flushTypingBuffer(buffer);
          if (typingStep) {
            const room = createRoomName('preview', previewSessionId);
            emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step: typingStep });
          }
        }
      }

      // Reset session (clears cookies/storage/context)
      const result = await sessionService.resetSession({
        sessionId: previewSessionId,
        userId: ensuredUserId,
      });

      if (result) {
        // V13: Restart video + devtools streams on the new page BEFORE we ack
        // the reset to the client. The pre-V13 flow used setImmediate
        // fire-and-forget, which left a window where the frontend thought
        // reset was complete while the new screencast was still being attached.
        // Awaiting here is cheap (CDP attach + startScreencast is sub-100ms)
        // and eliminates the race entirely.
        try {
          const { getPreviewVideoStreamRegistry, getPreviewDevToolsRegistry, getPreviewSessionService: getSvc } =
            await import('@/services/testing/ui/preview');
          const videoReg = getPreviewVideoStreamRegistry();
          const devtoolsReg = getPreviewDevToolsRegistry();
          const svc = getSvc();
          const newPage = svc.getPage(previewSessionId, ensuredUserId);

          if (newPage) {
            const room = createRoomName('preview', previewSessionId);

            // Start fresh stream on the new page. Do NOT call stopStream()
            // first — startStream() internally:
            //   1) reads the current stream's seq counter,
            //   2) stops it,
            //   3) constructs a new stream with the inherited seq.
            // Pre-stopping here would delete the old stream from the map
            // BEFORE startStream can read its seq, so the replacement
            // would restart counting at 0. Because the frontend
            // deduplicates frames by `seq > lastSeq` and keeps its seq
            // state across reset (sessionId is stable), those seq=0..N
            // frames would all be dropped as "out of order" until the
            // counter caught up — manifesting as a frozen preview for
            // 5-10s after every Reset. The mutex inside startStream()
            // already guards against concurrent resets.
            await videoReg.startStream(previewSessionId, ensuredUserId, room, newPage, socket.nsp);

            // Restart devtools collectors on new page
            devtoolsReg.stop(previewSessionId);
            devtoolsReg.start(previewSessionId, room, newPage, socket.nsp);

            logger.info('[PREVIEW_STREAM] Streams restarted after reset', { previewSessionId });
          }
        } catch (restartError) {
          logger.warn('[PREVIEW_STREAM] Failed to restart streams after reset', {
            previewSessionId,
            error: restartError instanceof Error ? restartError.message : String(restartError),
          });
        }

        emitPageActionResult(socket, previewSessionId, 'reset', true);
        // V20: page reset is a handshake — the frontend must receive the fresh DOM
        // even if by coincidence the new page's signature matches the previous. Also
        // `resetSession` already cleared `lastEmittedSignature` internally, but we
        // still use the bypass path so the intent is explicit.
        setImmediate(() => emitSnapshotForHandshake(socket, previewSessionId, ensuredUserId));

        resetEntryTrace?.writeSessionReset({
          phase: 'end',
          fromUrl: resetFromUrl,
          toUrl: sessionService.getPage(previewSessionId, ensuredUserId)?.url(),
          success: true,
          durationMs: Date.now() - resetStart,
        });

        // V9: Recording — reset destroys old page+context, so recording must stop
        // (resetSession already sets recording=false and clears buffer)
        // But we need to flush pending buffers, clean up timers, and notify client
        if (wasRecording) {
          const room = createRoomName('preview', previewSessionId);

          // Clean up timers
          const typingTimer = recordingTypingTimers.get(previewSessionId);
          if (typingTimer) { clearTimeout(typingTimer); recordingTypingTimers.delete(previewSessionId); }
          const scrollState = recordingScrollTimers.get(previewSessionId);
          if (scrollState) { clearTimeout(scrollState.timer); recordingScrollTimers.delete(previewSessionId); }

          // Notify client that recording has stopped
          socket.nsp.to(room).emit('preview:recording:state', {
            previewSessionId,
            recording: false,
            timestamp: new Date().toISOString(),
          });

          // Editor trace: log recording stop on page reset
          const resetTrace = EditorTraceService.get(previewSessionId);
          if (resetTrace) {
            resetTrace.writeRecordingStop('user');
            EditorTraceService.close(previewSessionId).then((meta) => {
              if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor' })
                .catch((err) => logger.error('[EDITOR_TRACE] Upload failed on page reset', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
            }).catch((err) => logger.error('[EDITOR_TRACE] Close failed on page reset', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
          }

          logger.info('[RECORDING] Stopped due to page reset', { previewSessionId, userId: ensuredUserId });
        }
      } else {
        emitPageActionResult(socket, previewSessionId, 'reset', false, 'Reset failed or session not found');
        resetEntryTrace?.writeSessionReset({
          phase: 'end',
          fromUrl: resetFromUrl,
          success: false,
          error: 'Reset failed or session not found',
          durationMs: Date.now() - resetStart,
        });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:reset', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'reset', false, 'Internal error');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V7: DevTools handlers (on-demand requests)
  // ═══════════════════════════════════════════════════════════════════════════

  // Handle network detail request (on-demand body fetch)
  socket.on('preview:network:detail:request', async (data) => {
    const psid = (data as any)?.previewSessionId || '';
    const reqId = (data as any)?.id || '';
    const emptyDetail = { previewSessionId: psid, id: reqId } as any;
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId || !psid || !reqId) {
        socket.emit('preview:network:detail', emptyDetail);
        return;
      }

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      if (!sessionService.isSessionOwned(psid, ensuredUserId)) {
        socket.emit('preview:network:detail', emptyDetail);
        return;
      }

      const collector = devtoolsRegistry.get(psid);
      if (!collector) {
        socket.emit('preview:network:detail', emptyDetail);
        return;
      }

      const detail = collector.getNetworkDetail(reqId);
      socket.emit('preview:network:detail', detail || emptyDetail);
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:network:detail:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:network:detail', emptyDetail);
    }
  });

  // Handle network list request (on-demand, for initial load)
  socket.on('preview:network:list:request', async (data) => {
    const psid = (data as any)?.previewSessionId;
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId || !psid) {
        socket.emit('preview:network:list', { previewSessionId: psid, items: [] });
        return;
      }

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      if (!sessionService.isSessionOwned(psid, ensuredUserId)) {
        socket.emit('preview:network:list', { previewSessionId: psid, items: [] });
        return;
      }

      const collector = devtoolsRegistry.get(psid);
      if (!collector) {
        socket.emit('preview:network:list', { previewSessionId: psid, items: [] });
        return;
      }

      const items = collector.getNetworkItems();
      socket.emit('preview:network:list', { previewSessionId: psid, items });
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:network:list:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:network:list', { previewSessionId: psid, items: [] });
    }
  });

  // Handle HTML request (on-demand, heavy content)
  socket.on('preview:html:request', async (data) => {
    try {
      const ensuredUserId = requireUser();
      const { previewSessionId: rawPsid, domVersion } = data;
      const previewSessionId = rawPsid as string | undefined;
      if (!ensuredUserId || !previewSessionId) {
        socket.emit('preview:html:update', { previewSessionId: previewSessionId || '', domVersion: 0, html: '<!-- No session -->', truncated: false });
        return;
      }

      logger.debug('[WebSocket] HTML request received', {
        socketId: socket.id,
        previewSessionId,
        clientDomVersion: domVersion,
      });

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        socket.emit('preview:html:update', { previewSessionId, domVersion: 0, html: '<!-- Not authorized -->', truncated: false });
        return;
      }

      const currentDomVersion = sessionService.getDomVersion(previewSessionId, ensuredUserId);

      const collector = devtoolsRegistry.get(previewSessionId);
      if (!collector) {
        socket.emit('preview:html:update', { previewSessionId, domVersion: 0, html: '<!-- No collector available -->', truncated: false });
        return;
      }

      const htmlPayload = await collector.fetchHtml(currentDomVersion || 1);
      socket.emit('preview:html:update', htmlPayload || { previewSessionId, domVersion: 0, html: '<!-- Failed to fetch -->', truncated: false });
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:html:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Always respond on error so frontend doesn't hang
      socket.emit('preview:html:update', { previewSessionId: (data as any)?.previewSessionId, domVersion: 0, html: `<!-- Error: ${error instanceof Error ? error.message : String(error)} -->`, truncated: false });
    }
  });

  // Handle Accessibility request (on-demand, heavy content)
  socket.on('preview:accessibility:request', async (data) => {
    try {
      const ensuredUserId = requireUser();
      const { previewSessionId, domVersion } = data;
      if (!ensuredUserId || !previewSessionId) {
        socket.emit('preview:accessibility:update', { previewSessionId: previewSessionId || '', domVersion: 0, tree: [], truncated: false });
        return;
      }

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        socket.emit('preview:accessibility:update', { previewSessionId, domVersion: 0, tree: [], truncated: false });
        return;
      }

      const currentDomVersion = sessionService.getDomVersion(previewSessionId, ensuredUserId);

      const collector = devtoolsRegistry.get(previewSessionId);
      if (!collector) {
        socket.emit('preview:accessibility:update', { previewSessionId, domVersion: 0, tree: [], truncated: false });
        return;
      }

      const accessibilityPayload = await collector.fetchAccessibility(currentDomVersion || 1);
      socket.emit('preview:accessibility:update', accessibilityPayload || { previewSessionId, domVersion: 0, tree: [], truncated: false });
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:accessibility:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Always respond on error so frontend doesn't hang
      socket.emit('preview:accessibility:update', { previewSessionId: (data as any)?.previewSessionId, domVersion: 0, tree: [], truncated: false });
    }
  });

  // Handle Context set (step editor env/variables)
  socket.on('preview:context:set', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, data: contextData } = data;
      if (!previewSessionId || !contextData) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Check session ownership
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        return;
      }

      const result = sessionService.setContextData(previewSessionId, ensuredUserId, contextData);
      if (result) {
        const room = createRoomName('preview', previewSessionId);

        // Emit to all subscribers including sender
        socket.nsp.to(room).emit('preview:context:update', {
          previewSessionId,
          version: result.version,
          data: result.data,
          timestamp: new Date().toISOString(),
        });

        logger.debug('[WebSocket] Context updated', {
          previewSessionId,
          version: result.version,
        });
      }
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:context:set', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse probe (debug: element under point)
  socket.on('preview:mouse:probe', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // Use mouse rate limit for probe as well
      if (!checkRateLimit(socket.id, 'mouse')) {
        return; // Silently drop - this is debug tool, no error needed
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        return; // Silently drop - debug tool
      }

      const { x, y } = data;
      if (x === undefined || y === undefined) {
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.probeElementAt({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        x,
        y,
      });

      socket.emit('preview:mouse:probe:result', {
        previewSessionId,
        x,
        y,
        element: result.element,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:mouse:probe', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V8: Preview Run Handlers ("Run from start" feature)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle preview:run:start - Start "Run from start" execution
   * Executes all saved steps sequentially in existing preview session
   */
  socket.on('preview:run:start', async (data) => {
    try {
      const userId = getUserId(socket);
      const { previewSessionId, intentTestCaseId, steps: inlineSteps, startUrl: inlineStartUrl, mobileSessionId: mobileSessionIdFromClient, authReset: clientAuthReset, startFromIndex: clientStartFromIndex } = data;

      // Validate input
      if (!previewSessionId || !intentTestCaseId) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'previewSessionId and intentTestCaseId are required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // ── Check if this is a mobile test case ──────────────────────────
      // Use getByIdInternal (no user_id filter) because in workspaces the
      // test case owner may differ from the socket user. We only need the
      // platform field to decide the routing — ownership is validated later
      // by the preview session service (web) or mobile runner (mobile).
      const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
      const testCase = await IntentTestCaseService.getByIdInternal(intentTestCaseId);
      const isMobile = testCase && testCase.platform && testCase.platform.startsWith('mobile_');

      logger.info('[WebSocket] preview:run:start — routing decision', {
        intentTestCaseId,
        platform: testCase?.platform ?? 'NO_TEST_CASE',
        isMobile: !!isMobile,
        previewSessionId,
        userId,
      });

      // Diagnostic — write to a dedicated file (winston dev config drops
      // info/warn to stdout-only, which we can't read from outside the
      // process). Bypassing winston with direct fs.appendFile gives us a
      // disk artifact we can grep regardless of log level config.
      try {
        const fs = await import('fs');
        const path = await import('path');
        const dbSteps = ((testCase?.stepsJson || []) as unknown as Array<Record<string, unknown>>);
        const fpAudit = dbSteps.map((s, idx) => {
          const compiled = s?.compiled as Record<string, unknown> | undefined;
          const evidence = s?.evidence as Record<string, unknown> | undefined;
          const bindingHints = s?.bindingHints as Record<string, unknown> | undefined;
          const compiledContext = compiled?.context as Record<string, unknown> | undefined;
          const locatorPlan = compiled?.locatorPlan as Array<Record<string, unknown>> | undefined;
          return {
            locatorStrategies: locatorPlan?.map(l => `${l.strategy}=${typeof l.value === 'string' ? l.value.slice(0, 40) : ''}@${l.confidence}`).slice(0, 5),
            idx,
            id: typeof s?.id === 'string' ? s.id.slice(0, 8) : undefined,
            type: s?.type,
            description: typeof s?.description === 'string' ? (s.description as string).slice(0, 80) : undefined,
            // Where the step was applied (compiled plan stamps the URL it
            // was generated for). Run-time URL mismatch with this is the
            // canonical "compiled stale" signal.
            compiledPageUrl: typeof compiledContext?.pageUrl === 'string' ? compiledContext.pageUrl : undefined,
            // What evidence ref was cached + what URL it was captured on.
            evidencePageUrl: typeof evidence?.pageUrl === 'string' ? evidence.pageUrl : undefined,
            evidenceLastSuccessRef: typeof evidence?.lastSuccessRef === 'string' ? evidence.lastSuccessRef : undefined,
            evidenceCapturedAt: typeof evidence?.capturedAt === 'string' ? evidence.capturedAt : undefined,
            // bindingHints captured at apply time — primary semantic anchor.
            bhLabel: typeof bindingHints?.label === 'string' ? (bindingHints.label as string).slice(0, 80) : undefined,
            bhText: typeof bindingHints?.text === 'string' ? (bindingHints.text as string).slice(0, 80) : undefined,
            bhRole: typeof bindingHints?.role === 'string' ? bindingHints.role : undefined,
            bhTag: typeof bindingHints?.tag === 'string' ? bindingHints.tag : undefined,
            bhTestId: typeof bindingHints?.testId === 'string' ? bindingHints.testId : undefined,
            bhElementId: typeof bindingHints?.elementId === 'string' ? bindingHints.elementId : undefined,
            // Flags + fingerprint key list (compact summary for grep).
            hasRecordedFingerprint: !!s?.recordedFingerprint,
            hasBindingHints: !!bindingHints,
            hasCompiled: !!compiled,
            hasEvidence: !!evidence,
            fpKeys: s?.recordedFingerprint && typeof s.recordedFingerprint === 'object'
              ? Object.keys(s.recordedFingerprint as object).slice(0, 10)
              : undefined,
          };
        });
        const auditPath = path.join(process.cwd(), 'logs', 'fp_audit.log');
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          intentTestCaseId,
          stepCount: dbSteps.length,
          steps: fpAudit,
        }) + '\n';
        fs.appendFileSync(auditPath, line);
      } catch { /* non-fatal — diagnostic only */ }

      if (isMobile && testCase) {
        // Mobile path: delegate to mobile runner via HTTP
        logger.info('[WebSocket] Starting mobile preview run', {
          previewSessionId,
          intentTestCaseId,
          platform: testCase.platform,
          userId,
          socketId: socket.id,
        });

        // Always use stepsJson from DB — it's already in the format the mobile runner expects
        const steps = (testCase.stepsJson || []) as any[];

        if (!steps.length) {
          socket.emit('error', {
            code: 'NO_STEPS',
            message: 'No steps to run',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // If inline steps provided, save them to DB first (Apply All flow)
        if (Array.isArray(inlineSteps) && inlineSteps.length > 0) {
          // Diagnostic — answers "did the frontend ship `recordedFingerprint`
          // for click/type steps, or did toIntentStepForSave drop it?". When
          // the value is false here, the cause is upstream of this handler
          // (frontend serialization, recorder emit, or initial DB load).
          try {
            const fpAudit = (inlineSteps as unknown as Array<Record<string, unknown>>).map((s, idx) => ({
              idx,
              id: typeof s?.id === 'string' ? s.id.slice(0, 8) : undefined,
              type: s?.type,
              hasRecordedFingerprint: !!s?.recordedFingerprint,
              hasBindingHints: !!s?.bindingHints,
              hasCompiled: !!s?.compiled,
              hasEvidence: !!s?.evidence,
              fpKeys: s?.recordedFingerprint && typeof s.recordedFingerprint === 'object'
                ? Object.keys(s.recordedFingerprint as object).slice(0, 10)
                : undefined,
            }));
            logger.info('[APPLY_ALL_FP_AUDIT] inline steps received', {
              intentTestCaseId,
              stepCount: inlineSteps.length,
              steps: fpAudit,
            });
          } catch { /* non-fatal — diagnostic only */ }
          const patch: Record<string, unknown> = { steps: inlineSteps };
          if (inlineStartUrl) {
            patch.url = inlineStartUrl;
            patch.startUrl = inlineStartUrl;
          }
          await IntentTestCaseService.update({ id: intentTestCaseId, userId, ...patch });
        }

        // ── Resolve mobile runner session ID BEFORE emitting started ──
        // 1. From client payload (if frontend sent it)
        // 2. From Redis warmup cache (mobile_warmup:{projectId}:{userId})
        // 3. From previewSessionId (frontend may send mobileSessionId as previewSessionId)
        // 4. Fail with clear error
        let mobileSessionId = mobileSessionIdFromClient;
        if (!mobileSessionId) {
          try {
            const { redisConnection } = await import('@/config/infrastructure/queues');
            const redisKey = `mobile_warmup:${testCase.projectId}:${userId}`;
            const warmupRaw = await redisConnection.get(redisKey);
            if (warmupRaw) {
              const warmup = JSON.parse(warmupRaw);
              if (warmup.sessionId && warmup.sessionId !== '_booting') {
                mobileSessionId = warmup.sessionId;
                logger.info('[WebSocket] Resolved mobile session from Redis warmup', {
                  mobileSessionId, projectId: testCase.projectId, userId,
                });
              }
            }
          } catch (err) {
            logger.warn('[WebSocket] Failed to look up mobile session from Redis', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Fallback: the frontend sends mobileSessionId as previewSessionId via effectiveSessionId
        if (!mobileSessionId && previewSessionId) {
          mobileSessionId = previewSessionId;
          logger.info('[WebSocket] Using previewSessionId as mobile session fallback', {
            mobileSessionId, userId,
          });
        }
        if (!mobileSessionId) {
          socket.emit('error', {
            code: 'NO_MOBILE_SESSION',
            message: 'No active mobile emulator session. Please wait for the emulator to connect.',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const { getMobileRunnerClient } = await import('@/services/mobile');
        const mobileClient = getMobileRunnerClient();
        const { buildMetadataFromTestCase } = await import('@/services/mobile/mobile-runner.types');

        // Emit started AFTER session is validated
        webSocketService.emitToUser(userId, 'preview:run:started', {
          previewSessionId,
          totalSteps: steps.length,
          startUrl: testCase.startUrl || testCase.url || '',
          timestamp: new Date().toISOString(),
        });

        logger.info('[WebSocket] Mobile run: sending steps to runner', {
          mobileSessionId,
          stepCount: steps.length,
          stepTypes: steps.map((s: any) => s.type),
          stepIds: steps.map((s: any) => s.id),
        });

        // Run steps on mobile runner (async)
        mobileClient.runSteps(mobileSessionId, steps, {
          screenshotEachStep: true,
          stopOnFailure: true,
          metadata: buildMetadataFromTestCase(testCase),
        }).then((result) => {
          logger.info('[WebSocket] Mobile run completed', {
            mobileSessionId,
            totalSteps: result.totalSteps,
            passedSteps: result.passedSteps,
            failedSteps: result.failedSteps,
            skippedSteps: result.skippedSteps,
            stepErrors: result.steps
              .filter((s: any) => !s.success)
              .map((s: any) => ({ stepId: s.stepId, error: s.error })),
          });
          // Emit per-step results
          for (let i = 0; i < result.steps.length; i++) {
            const stepResult = result.steps[i];
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: i,
              stepId: stepResult.stepId,
              status: stepResult.success ? 'passed' : 'failed',
              error: stepResult.error,
              screenshot: stepResult.screenshot,
              durationMs: stepResult.durationMs,
              timestamp: new Date().toISOString(),
              // Advisory warnings from the runner (e.g. WebView debugging
              // missing on release APK). Only attached when present.
              ...(stepResult.warnings && stepResult.warnings.length > 0
                ? { warnings: stepResult.warnings }
                : {}),
            });
          }

          // Emit completed event
          webSocketService.emitToUser(userId, 'preview:run:completed', {
            previewSessionId,
            totalSteps: result.totalSteps,
            passedSteps: result.passedSteps,
            failedSteps: result.failedSteps,
            skippedSteps: result.skippedSteps,
            cancelled: false,
            duration: result.durationMs,
            timestamp: new Date().toISOString(),
          });
        }).catch((error) => {
          logger.error('[WebSocket] Mobile preview run failed', {
            previewSessionId,
            intentTestCaseId,
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          // Emit completed with failure so frontend exits running state
          webSocketService.emitToUser(userId, 'preview:run:completed', {
            previewSessionId,
            totalSteps: steps.length,
            passedSteps: 0,
            failedSteps: steps.length,
            skippedSteps: 0,
            cancelled: false,
            duration: 0,
            error: error instanceof Error ? error.message : 'Mobile run failed',
            timestamp: new Date().toISOString(),
          });
        });

        return; // Mobile path done — skip web flow below
      }

      // ── Web path (existing flow) ─────────────────────────────────────
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Check ownership
      if (!sessionService.isSessionOwned(previewSessionId, userId)) {
        socket.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Session not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Import PreviewRunService
      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');

      // Check if already running
      if (PreviewRunService.isRunning(previewSessionId)) {
        socket.emit('error', {
          code: 'RUN_IN_PROGRESS',
          message: 'Run already in progress',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // V9: Stop recording if active (run replays existing steps, would
      // create duplicates). Delegates to the shared finalizer so the flush,
      // listener cleanup, and broadcast stay identical to other stop paths.
      // The intentTestCaseId is forwarded so the editor trace upload is
      // linked to the run that just started.
      if (sessionService.isRecording(previewSessionId, userId)) {
        await finalizeRecording(socket, previewSessionId, userId, 'user', intentTestCaseId);
      }

      logger.info('[WebSocket] Starting preview run', {
        previewSessionId,
        intentTestCaseId,
        userId,
        socketId: socket.id,
      });

      // Start run (async, emits progress via WebSocket)
      // If inline steps are provided (Apply All flow), save them first and use directly.
      //
      // authReset is forwarded when the client provided one via the
      // SessionDetectedBanner UI. When omitted we pass `undefined`
      // so the service's own default ('never' as of 2026-04-21) applies.
      // Validate explicitly — random strings from a tampered client must
      // not reach the service.
      const safeAuthReset: 'always' | 'never' | undefined =
        clientAuthReset === 'always' || clientAuthReset === 'never'
          ? clientAuthReset
          : undefined;
      const hasInline = Array.isArray(inlineSteps) && inlineSteps.length > 0;
      // Sanitize startFromIndex: must be a non-negative finite integer.
      // Anything else (NaN, negative, undefined, string, etc.) collapses to
      // the default "run from step 0" behaviour. This is the safe fallback
      // — a malformed value never accidentally skips steps.
      const safeStartFromIndex =
        typeof clientStartFromIndex === 'number'
        && Number.isFinite(clientStartFromIndex)
        && clientStartFromIndex > 0
        && Math.floor(clientStartFromIndex) === clientStartFromIndex
          ? clientStartFromIndex
          : undefined;
      const runOptions = hasInline
        ? { inlineSteps, startUrl: inlineStartUrl, authReset: safeAuthReset, startFromIndex: safeStartFromIndex }
        : (safeAuthReset || safeStartFromIndex !== undefined)
          ? { authReset: safeAuthReset, startFromIndex: safeStartFromIndex }
          : undefined;
      PreviewRunService.runSavedSteps(previewSessionId, intentTestCaseId, userId, runOptions).catch((error) => {
        logger.error('[WebSocket] Preview run failed', {
          previewSessionId,
          intentTestCaseId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit('error', {
          code: 'RUN_FAILED',
          message: error instanceof Error ? error.message : 'Run failed',
          timestamp: new Date().toISOString(),
        });
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:run:start', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Internal error',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * Handle `preview:session:inspect` — read-only snapshot of the preview
   * context's session state. Called by the UI right before a Run so we
   * can decide whether to show the "Active session detected" banner.
   *
   * Returns counts only, not values:
   *   - cookieCount, sessionStorageKeyCount, localStorageKeyCount (if same-origin)
   *   - cookieNames (up to 20), localStorageKeys (if same-origin)
   *   - sameOriginAsStartUrl so the UI knows whether localStorage is
   *     actually visible in the count (cross-origin pages hide it)
   *
   * Never mutates anything. Safe to call many times per session.
   * Mobile sessions skip this check (different runner path).
   */
  socket.on('preview:session:inspect', async (data) => {
    try {
      const userId = getUserId(socket);
      if (!userId) {
        socket.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      const { previewSessionId } = data ?? {};
      if (!previewSessionId) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'previewSessionId is required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { getPreviewSessionService } = await import(
        '@/services/testing/ui/preview/preview-session.service'
      );
      const sessionService = getPreviewSessionService();
      // Check ownership FIRST (before touching session.page) so an
      // unauthenticated caller can't learn whether a session exists
      // based on the error code we return.
      if (!sessionService.isSessionOwned(previewSessionId, userId)) {
        socket.emit('error', {
          code: 'FORBIDDEN',
          message: 'Session not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      const session = sessionService.getSession(previewSessionId);
      if (!session) {
        socket.emit('error', {
          code: 'SESSION_NOT_FOUND',
          message: 'Preview session not found or expired',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Cookies are context-scoped — can be read regardless of current URL.
      let cookieCount = 0;
      let cookieNames: string[] = [];
      try {
        const cookies = await session.page.context().cookies();
        cookieCount = cookies.length;
        cookieNames = cookies.slice(0, 20).map((c) => c.name);
      } catch (err) {
        logger.debug('[WebSocket] inspect: cookie read failed', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Storage is origin-scoped. We can only read it reliably when the
      // current page is on the same origin as the test's startUrl. If the
      // session hasn't navigated yet (about:blank) or is cross-origin,
      // return 0 and flag `sameOriginAsStartUrl=false` so the UI explains
      // "cookies only" instead of silently under-reporting.
      let currentUrl = '';
      try { currentUrl = session.page.url(); } catch { /* page closed */ }

      // startUrl is stored on the session via start payload. Fall back to
      // the page's origin if not set so the comparison still works.
      const startUrl = session.startUrl || currentUrl;
      let sameOriginAsStartUrl = false;
      try {
        if (startUrl && currentUrl && currentUrl !== 'about:blank') {
          sameOriginAsStartUrl = new URL(startUrl).origin === new URL(currentUrl).origin;
        }
      } catch { /* malformed url */ }

      let localStorageKeyCount = 0;
      let sessionStorageKeyCount = 0;
      let localStorageKeys: string[] | undefined;
      if (sameOriginAsStartUrl) {
        try {
          const storage = await session.page.evaluate(() => {
            // @ts-expect-error - browser context
            const ls = localStorage;
            // @ts-expect-error - browser context
            const ss = sessionStorage;
            const keys: string[] = [];
            for (let i = 0; i < Math.min(ls.length, 20); i++) {
              const k = ls.key(i);
              if (k !== null) keys.push(k);
            }
            return {
              lsCount: ls.length,
              ssCount: ss.length,
              keys,
            };
          });
          localStorageKeyCount = storage.lsCount ?? 0;
          sessionStorageKeyCount = storage.ssCount ?? 0;
          localStorageKeys = storage.keys;
        } catch (err) {
          // Storage read can fail in edge cases (disabled by policy,
          // page mid-navigation, etc.) — don't fail the whole inspect.
          logger.debug('[WebSocket] inspect: storage read failed', {
            previewSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      socket.emit('preview:session:state', {
        previewSessionId,
        cookieCount,
        localStorageKeyCount,
        sessionStorageKeyCount,
        currentUrl,
        sameOriginAsStartUrl,
        cookieNames,
        localStorageKeys,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('[WebSocket] preview:session:inspect failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      socket.emit('error', {
        code: 'INSPECT_FAILED',
        message: err instanceof Error ? err.message : 'Failed to inspect session',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * Handle preview:run:cancel - Cancel active preview run
   * Sets cancellation flag, main loop handles skipping remaining steps
   */
  socket.on('preview:run:cancel', async (data) => {
    try {
      const userId = getUserId(socket);
      const { previewSessionId } = data;

      if (!previewSessionId) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'previewSessionId is required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');

      logger.info('[WebSocket] Cancelling preview run', {
        previewSessionId,
        userId,
        socketId: socket.id,
      });

      PreviewRunService.cancelRun(previewSessionId, userId);

      // Acknowledge cancellation immediately so frontend can update UI
      socket.emit('preview:run:cancelled', { previewSessionId });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:run:cancel', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Cancel failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V9: Recording handlers
  // ═══════════════════════════════════════════════════════════════════════════

  socket.on('preview:recording:start', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId } = data;
      if (!previewSessionId) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        socket.emit('error', {
          code: 'FORBIDDEN',
          message: 'Session not found or not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // V9: Guard — cannot start recording while a run is active
      {
        const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
        if (PreviewRunService.isRunning(previewSessionId)) {
          socket.emit('error', {
            code: 'RUN_IN_PROGRESS',
            message: 'Cannot start recording while a run is in progress',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      // Already recording? Ignore silently
      if (sessionService.isRecording(previewSessionId, ensuredUserId)) return;

      sessionService.setRecording(previewSessionId, ensuredUserId, true);

      // Arm auto-stop timer. Mirrors the mobile runner's RecordingStateRegistry
      // so an abandoned recording doesn't leak buffers/listeners forever.
      // Skipped when RECORDING_MAX_TIME_MS is 0 (disabled via env).
      if (RECORDING_MAX_TIME_MS > 0) {
        const prev = recordingAutoStopTimers.get(previewSessionId);
        if (prev) clearTimeout(prev);
        const autoStopTimer = setTimeout(() => {
          recordingAutoStopTimers.delete(previewSessionId);
          logger.info('[RECORDING] Auto-stop: max recording time reached', {
            previewSessionId,
            userId: ensuredUserId,
            maxMs: RECORDING_MAX_TIME_MS,
          });
          void finalizeRecording(socket, previewSessionId, ensuredUserId, 'max_time').catch((err) => {
            logger.error('[RECORDING] Auto-stop finalize failed', {
              previewSessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, RECORDING_MAX_TIME_MS);
        recordingAutoStopTimers.set(previewSessionId, autoStopTimer);
      }

      // V13: Switch dialog handler to recording mode (emit to frontend, wait for user response)
      sessionService.setDialogMode(previewSessionId, ensuredUserId, 'recording');

      // Set the current URL as baseline for navigation detection
      const page = sessionService.getPage(previewSessionId, ensuredUserId);

      // V13: Save actual page URL at recording start (used as fallback startUrl for Apply All)
      if (page) {
        sessionService.setRecordingStartUrl(previewSessionId, ensuredUserId, page.url());
      }

      // Editor trace: create writer and log recording start
      const recStartTrace = EditorTraceService.getOrCreate(previewSessionId, ensuredUserId);
      recStartTrace.writeRecordingStart(page?.url());

      if (page) {
        sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());

        // Inject <select> change listener
        try {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );

          const SELECT_CB_NAME = '__qai_select_change';

          // Expose callback function (ignore if already exposed)
          await page.exposeFunction(SELECT_CB_NAME, (changeData: { label: string; text: string; value: string; name?: string; id?: string; ariaLabel?: string; role?: string }) => {
            try {
              // Guard: only emit if still recording
              if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;

              // V13: Capture page URL for evidence (page accessible from closure)
              const selectPageUrl = page.url();
              const step = RecordingCaptureService.captureSelectChange({
                label: changeData.label,
                selectedText: changeData.text,
                selectedValue: changeData.value,
                pageUrl: selectPageUrl,
                name: changeData.name,
                id: changeData.id,
                ariaLabel: changeData.ariaLabel,
                role: changeData.role,
              });
              const room = createRoomName('preview', previewSessionId);
              emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
              // Editor trace: log select change
              const selTrace = EditorTraceService.get(previewSessionId);
              if (selTrace) {
                selTrace.writeSelectChange({ label: changeData.label, selectedText: changeData.text, selectedValue: changeData.value });
                selTrace.writeStepCaptured(step, 'select_change');
              }
            } catch (e) {
              logger.debug('[RECORDING] Select change callback error', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }).catch(() => {
            // exposeFunction may fail if already exposed (e.g., page reload) — that's OK
          });

          await RecordingCaptureService.injectSelectChangeListener(page, SELECT_CB_NAME);

          // Re-inject on navigation (page.evaluate scripts are lost on load)
          const reInjectHandler = async () => {
            try {
              if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
                await RecordingCaptureService.injectSelectChangeListener(page, SELECT_CB_NAME);
              }
            } catch {
              // Page may be closing during navigation
            }
          };
          page.on('load', reInjectHandler);
          // Store cleanup reference (removed on recording:stop)
          (page as any).__qai_recording_load_handler = reInjectHandler;
        // V13: Inject autofill detection listener
          // Monitors 'change' events on input fields that weren't caused by keyboard typing.
          // Autofill typically fires 'change' without prior 'input' events from user keystrokes.
          const AUTOFILL_CB_NAME = '__qai_autofill_change';
          await page.exposeFunction(AUTOFILL_CB_NAME, (data: {
            tag: string;
            type: string;
            name: string;
            id: string;
            ariaLabel: string;
            label: string;
            value: string;
            ref: string;
          }) => {
            try {
              if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;
              if (!data.value) return;

              // Skip if there's an active typing buffer for this element (user is typing, not autofill)
              const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
              if (buffer && buffer.elementRef === data.ref) return;

              // Skip if a type step was just emitted for this element (buffer already flushed,
              // but browser 'change' event fires after debounce — not real autofill)
              const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
              if (lastTypeStep && lastTypeStep.elementRef === data.ref && lastTypeStep.value === data.value) return;

              const autoPage = sessionService.getPage(previewSessionId, ensuredUserId);
              const step: PreviewIntentStep = {
                id: `rec_${Date.now().toString(36)}`,
                type: 'type',
                description: `Autofill '${data.value.slice(0, 40)}' in '${data.label || data.name || data.ariaLabel || data.tag}'`,
                value: data.value,
                bindingHints: {
                  ...(data.label && { label: data.label }),
                  ...(data.ariaLabel && { nearText: data.ariaLabel }),
                  ...(data.name && { autocomplete: data.name }),
                  ...(data.type && { type: data.type }),
                },
                evidence: {
                  ...(data.ref && { lastSuccessRef: data.ref }),
                  confidence: 1.0,
                  pageUrl: autoPage?.url(),
                  capturedAt: new Date().toISOString(), // V15.7: TTL support
                },
              };

              const room = createRoomName('preview', previewSessionId);
              emitRecordingStep(socket, room, sessionService, previewSessionId, ensuredUserId, { step });
              const afTrace = EditorTraceService.get(previewSessionId);
              if (afTrace) afTrace.writeStepCaptured(step, 'autofill');
            } catch { /* non-critical */ }
          }).catch(() => { /* already exposed — OK */ });

          await RecordingCaptureService.injectAutofillListener(page, AUTOFILL_CB_NAME);

          // Re-inject on navigation
          const reInjectAutofill = async () => {
            try {
              if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
                await RecordingCaptureService.injectAutofillListener(page, AUTOFILL_CB_NAME);
              }
            } catch { /* page may be closing */ }
          };
          page.on('load', reInjectAutofill);
          (page as any).__qai_recording_autofill_handler = reInjectAutofill;
        } catch (e) {
          logger.debug('[RECORDING] Select listener injection failed (non-critical)', {
            error: e instanceof Error ? e.message : String(e),
          });
        }

        // V10 Fix #5: Listen for filechooser events to record file uploads
        //
        // QA-visibility: previously EVERY failure path here was silent (catch +
        // logger.debug, no WS emit). When a user clicked Upload and the step
        // didn't appear, there was no way to tell why. We now emit
        // `preview:recording:upload:warning` with a machine-readable reason
        // for each failure path so the UI can surface it.
        const emitUploadWarning = (
          reason: 'no_file_selected' | 'capture_failed' | 'listener_setup_failed',
          detail?: string,
          orphanedStepId?: string,
        ) => {
          try {
            const room = createRoomName('preview', previewSessionId);
            socket.nsp.to(room).emit('preview:recording:upload:warning', {
              previewSessionId,
              reason,
              ...(detail ? { detail } : {}),
              ...(orphanedStepId ? { stepId: orphanedStepId } : {}),
              timestamp: new Date().toISOString(),
            });
            // When the warning correlates to a placeholder the UI already
            // rendered, tear that row down too — otherwise the user is left
            // with a ghost "Choose file…" row that does nothing.
            if (orphanedStepId) {
              socket.nsp.to(room).emit('preview:recording:step:remove', {
                previewSessionId,
                stepId: orphanedStepId,
                timestamp: new Date().toISOString(),
              } as any);
            }
          } catch { /* non-critical — never let a warn emit break recording */ }
        };

        try {
          const { RecordingCaptureService: RecCapSvc } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );

          const fileChooserHandler = async (fileChooser: any) => {
            // NEW FLOW (inline-picker): instead of waiting for the OS file
            // dialog to commit (which silently fails on cancel, headless,
            // listener races), we IMMEDIATELY park the fileChooser here and
            // ask the UI to pick a file through its own picker. When the UI
            // responds with `preview:recording:upload:resolve` we download
            // the file to tmp and call setFiles() so the real page sees the
            // upload happen as if the user had used the native dialog.
            try {
              if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;

              // Probe the file input element for binding hints. Best-effort
              // — if it fails we still show the inline picker (the step just
              // won't carry bindingHints for replay).
              let probedEl: any = null;
              let probeError: string | undefined;
              try {
                const element = fileChooser.element();
                if (element) {
                  const box = await element.boundingBox().catch(() => null);
                  if (box) {
                    probedEl = await RecCapSvc.probeForRecording(
                      page,
                      box.x + box.width / 2,
                      box.y + box.height / 2,
                    );
                  }
                }
              } catch (probeErr) {
                probeError = probeErr instanceof Error ? probeErr.message : String(probeErr);
                logger.debug('[RECORDING] File chooser probe failed (non-fatal)', {
                  previewSessionId,
                  error: probeError,
                });
              }

              // Generate the placeholder step id. Frontend renders a pending
              // step with this id and echoes it back on resolve/cancel.
              const stepId = `rec_${require('crypto').randomUUID().slice(0, 8)}`;

              // Park the chooser with an auto-cancel timer. If the user
              // ignores the prompt we dismiss the native dialog cleanly
              // instead of leaking the handle.
              const timeout = setTimeout(() => {
                const pending = pendingUploadPrompts.get(stepId);
                if (!pending) return;
                pendingUploadPrompts.delete(stepId);
                pending.fileChooser.setFiles([]).catch(() => { /* page closed */ });
                // Pass stepId so the UI clears both pendingUploads[stepId]
                // and the placeholder row (server also emits step:remove).
                emitUploadWarning('no_file_selected', 'Inline picker timed out', stepId);
                logger.debug('[RECORDING] Upload prompt timed out', {
                  previewSessionId,
                  stepId,
                });
              }, UPLOAD_PROMPT_TIMEOUT_MS);
              timeout.unref?.();

              pendingUploadPrompts.set(stepId, {
                previewSessionId,
                userId: ensuredUserId,
                fileChooser,
                probedEl,
                pageUrl: page.url(),
                timeout,
                createdAt: Date.now(),
              });

              // Tell the UI to show its inline picker.
              const promptRoom = createRoomName('preview', previewSessionId);
              const bindingHints = probedEl ? RecCapSvc.buildBindingHints(probedEl) : undefined;
              socket.nsp.to(promptRoom).emit('preview:recording:upload:prompt', {
                previewSessionId,
                stepId,
                multiple: typeof fileChooser.isMultiple === 'function'
                  ? Boolean(fileChooser.isMultiple())
                  : false,
                bindingHints,
                pageUrl: page.url(),
                timeoutMs: UPLOAD_PROMPT_TIMEOUT_MS,
                timestamp: new Date().toISOString(),
              } as any);

              // Editor trace: note that we prompted the user. The final
              // captured step is logged in the resolve handler.
              const fcTrace = EditorTraceService.get(previewSessionId);
              if (fcTrace) {
                try {
                  fcTrace.writeFileUpload({ fileNames: ['(pending)'], probedElement: probedEl });
                } catch { /* trace is best-effort */ }
              }
            } catch (fcErr) {
              const msg = fcErr instanceof Error ? fcErr.message : String(fcErr);
              logger.debug('[RECORDING] File chooser handler failed', { error: msg });
              emitUploadWarning('capture_failed', msg);
            }
          };

          page.on('filechooser', fileChooserHandler);
          (page as any).__qai_recording_filechooser_handler = fileChooserHandler;
        } catch (e) {
          // Listener could not be attached at all — Upload will NOT record
          // anything for this entire session. This is the worst-case silent
          // failure and the most important one to surface.
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn('[RECORDING] File chooser listener setup failed', { error: msg });
          emitUploadWarning('listener_setup_failed', msg);
        }
      }

      // Emit state to all subscribers. Stamp the server-side step cap so the
      // UI can render an `X/N` badge without a separate config fetch.
      const room = createRoomName('preview', previewSessionId);
      socket.nsp.to(room).emit('preview:recording:state', {
        previewSessionId,
        recording: true,
        maxSteps: RECORDING_MAX_STEPS,
        timestamp: new Date().toISOString(),
      });

      logger.info('[RECORDING] Started', { previewSessionId, userId: ensuredUserId });
    } catch (error) {
      logger.error('[RECORDING] Start failed', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Inline upload picker (new flow)
  // ───────────────────────────────────────────────────────────────────────────
  // These two handlers complete the `filechooser → upload:prompt` loop. The
  // frontend uploads the user's pick to /api/v1/preview/upload-file, then
  // emits resolve (or cancel) here with the correlated stepId.
  // ═══════════════════════════════════════════════════════════════════════════

  socket.on('preview:recording:upload:resolve', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, stepId, publicUrl, fileName, storagePath, additionalFiles } = data || ({} as any);
      if (!previewSessionId || !stepId || !publicUrl || !fileName) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) return;

      const pending = pendingUploadPrompts.get(stepId);
      if (!pending || pending.previewSessionId !== previewSessionId || pending.userId !== ensuredUserId) {
        // Stale / unknown — likely arrived after the auto-cancel timer fired.
        // Silent drop is fine; the UI already sees the warning path.
        logger.debug('[RECORDING] Upload resolve: no pending prompt', { previewSessionId, stepId });
        return;
      }
      clearTimeout(pending.timeout);
      pendingUploadPrompts.delete(stepId);

      const emitWarn = (
        reason: 'capture_failed' | 'no_file_selected',
        detail?: string,
        orphanedStepId?: string,
      ) => {
        try {
          const room = createRoomName('preview', previewSessionId);
          socket.nsp.to(room).emit('preview:recording:upload:warning', {
            previewSessionId,
            reason,
            ...(detail ? { detail } : {}),
            ...(orphanedStepId ? { stepId: orphanedStepId } : {}),
            timestamp: new Date().toISOString(),
          });
          // Mirror the cancel handler: when we abort a resolve mid-flight the
          // UI still shows a "Choose file…" placeholder. Drop it so the user
          // can re-trigger the upload instead of being stuck.
          if (orphanedStepId) {
            socket.nsp.to(room).emit('preview:recording:step:remove', {
              previewSessionId,
              stepId: orphanedStepId,
              timestamp: new Date().toISOString(),
            } as any);
          }
        } catch { /* non-critical */ }
      };

      // Download every file the user picked (primary + additional) to tmp
      // and drive setFiles() on the held chooser. We keep the tmp paths so
      // a best-effort cleanup can run after the page reads them.
      const allFiles = [
        { publicUrl, fileName, storagePath },
        ...((additionalFiles as Array<{ publicUrl: string; fileName: string; storagePath?: string }>) || []),
      ];
      const { downloadFileForUpload, cleanupUploadTempFile } = await import(
        '@/agent/execution/file-download.service'
      );
      const tmpPaths: string[] = [];
      try {
        for (const f of allFiles) {
          const dl = await downloadFileForUpload(f.publicUrl, { filename: f.fileName });
          tmpPaths.push(dl.localPath);
        }
      } catch (dlErr) {
        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
        logger.warn('[RECORDING] Upload resolve: download failed', { previewSessionId, stepId, error: msg });
        // Dismiss the native dialog so the page isn't stuck.
        pending.fileChooser.setFiles([]).catch(() => { /* page closed */ });
        // Clean up any partials.
        await Promise.all(tmpPaths.map((p) => cleanupUploadTempFile(p)));
        emitWarn('capture_failed', `download_failed: ${msg}`, stepId);
        return;
      }

      // Set the files on the live page. This is the "real upload happens"
      // moment — the page receives the files as if the user had picked
      // them via the native dialog.
      try {
        await pending.fileChooser.setFiles(tmpPaths.length === 1 ? tmpPaths[0] : tmpPaths);
      } catch (sfErr) {
        const msg = sfErr instanceof Error ? sfErr.message : String(sfErr);
        logger.warn('[RECORDING] Upload resolve: setFiles failed', { previewSessionId, stepId, error: msg });
        await Promise.all(tmpPaths.map((p) => cleanupUploadTempFile(p)));
        emitWarn('capture_failed', `setFiles_failed: ${msg}`, stepId);
        return;
      }

      // Build the final captured step. `value` is the publicUrl so replay
      // can re-download from storage. `fileName` is included separately for
      // display and for replay when multiple files were attached.
      const { RecordingCaptureService: RecCapSvcResolve } = await import(
        '@/services/testing/ui/preview/recording-capture.service'
      );
      const fileNames = allFiles.map((f) => f.fileName);
      const uploadStep = RecCapSvcResolve.captureFileUpload(fileNames, pending.probedEl, pending.pageUrl);
      if (!uploadStep) {
        await Promise.all(tmpPaths.map((p) => cleanupUploadTempFile(p)));
        emitWarn('capture_failed', 'captureFileUpload returned null', stepId);
        return;
      }
      // Override the auto-generated id so the frontend can reconcile this
      // final step against the placeholder it already rendered.
      uploadStep.id = stepId;
      // Replace the placeholder `value` (just the filename) with the public
      // URL; replay re-downloads from here. Also stamp the storagePath for
      // future teardown.
      (uploadStep as any).value = publicUrl;
      if (!(uploadStep as any).options) (uploadStep as any).options = {};
      (uploadStep as any).options.fileName = fileNames[0];
      if (storagePath) (uploadStep as any).options.storagePath = storagePath;
      if (allFiles.length > 1) {
        (uploadStep as any).options.additionalFiles = allFiles.slice(1).map((f) => ({
          publicUrl: f.publicUrl,
          fileName: f.fileName,
          ...(f.storagePath ? { storagePath: f.storagePath } : {}),
        }));
      }

      const recordRoom = createRoomName('preview', previewSessionId);
      emitRecordingStep(
        socket,
        recordRoom,
        sessionService,
        previewSessionId,
        ensuredUserId,
        { step: uploadStep },
      );
      const fuTrace = EditorTraceService.get(previewSessionId);
      if (fuTrace) {
        try {
          fuTrace.writeStepCaptured(uploadStep, 'file_upload');
        } catch { /* trace is best-effort */ }
      }

      // Best-effort tmp cleanup on a delay so the page has time to read the
      // files. Playwright copies the file contents eagerly in most cases,
      // but a short grace period protects against async reads.
      setTimeout(() => {
        Promise.all(tmpPaths.map((p) => cleanupUploadTempFile(p))).catch(() => {});
      }, 30_000).unref?.();
    } catch (error) {
      logger.error('[RECORDING] Upload resolve failed', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on('preview:recording:upload:cancel', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, stepId } = data || ({} as any);
      if (!previewSessionId || !stepId) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) return;

      const pending = pendingUploadPrompts.get(stepId);
      if (!pending || pending.previewSessionId !== previewSessionId || pending.userId !== ensuredUserId) return;
      clearTimeout(pending.timeout);
      pendingUploadPrompts.delete(stepId);

      // Dismiss the native dialog cleanly.
      pending.fileChooser.setFiles([]).catch(() => { /* page closed */ });

      // Tell the UI to remove its placeholder step.
      const room = createRoomName('preview', previewSessionId);
      socket.nsp.to(room).emit('preview:recording:step:remove', {
        previewSessionId,
        stepId,
        timestamp: new Date().toISOString(),
      } as any);
    } catch (error) {
      logger.error('[RECORDING] Upload cancel failed', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on('preview:recording:stop', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId } = data;
      if (!previewSessionId) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) return;

      // Drop any dangling inline upload prompts — we don't want the native
      // dialog to stay open after recording stops, and the placeholder step
      // must be cleaned up on the UI.
      cancelPendingUploadsForSession(previewSessionId, (stepId) => {
        const room = createRoomName('preview', previewSessionId);
        socket.nsp.to(room).emit('preview:recording:step:remove', {
          previewSessionId,
          stepId,
          timestamp: new Date().toISOString(),
        } as any);
      });

      // Delegate to shared finalizer (also used by auto-stop timer).
      // Idempotent guard inside finalizeRecording handles the
      // "already stopped" case (e.g., race with auto-stop firing).
      await finalizeRecording(socket, previewSessionId, ensuredUserId, 'user');
    } catch (error) {
      logger.error('[RECORDING] Stop failed', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V13: Dialog recording — frontend sends user's accept/dismiss choice
  // ═══════════════════════════════════════════════════════════════════════════
  socket.on('preview:dialog:response' as any, async (data: {
    previewSessionId: string;
    action: 'accept' | 'dismiss';
    promptText?: string;
  }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, action, promptText } = data;
      if (!previewSessionId || !action) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) return;
      if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;

      // Set the pending dialog action — the dialog handler in preview-session.service.ts
      // is polling for this and will consume it, then emit preview:dialog:handled
      sessionService.setPendingDialogAction(previewSessionId, ensuredUserId, {
        action,
        promptText,
      });

      logger.info('[RECORDING] Dialog response received from frontend', {
        previewSessionId, action, promptText: promptText?.slice(0, 50),
      });
    } catch (error) {
      logger.error('[RECORDING] Dialog response handler error', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test Resources — Phase 4 live preview wiring
  //
  //   preview:apply-resource — inject a saved Login (cookies + localStorage)
  //     into the live preview context. Drives the LoginRequiredOverlay's
  //     "Apply existing" button so the user can keep authoring from an
  //     authenticated state without re-typing credentials.
  //
  //   preview:save-login — snapshot the preview's current storageState as
  //     a Login resource. Creates when no `resourceId` is sent, updates
  //     (re-captures) otherwise. This is the backend half of the overlay's
  //     "I logged in — save this" workflow.
  //
  // Both guards:
  //   • session must be owned by the socket user
  //   • no active test run on the session (would race with replay)
  // Both emit an ack (`:result` event) so the frontend can toast success
  // or show a specific error instead of hanging on a spinner.
  // ═══════════════════════════════════════════════════════════════════════════

  // Frontend signals "user clicked Skip on the login overlay" — silence
  // the auth-detector on that hostname for 30 minutes. Without this,
  // any navigation back to the same host would re-fire the overlay and
  // the user would feel harassed. Missing session / ownership = no-op:
  // the detector is best-effort UX, not a security boundary.
  socket.on('preview:auth:dismiss' as any, async (data: {
    previewSessionId: string;
    hostname?: string;
    url?: string;
  }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;
      if (!data?.previewSessionId) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(data.previewSessionId, ensuredUserId)) return;

      let host = (data.hostname || '').toLowerCase();
      if (!host && data.url) {
        try { host = new URL(data.url).hostname.toLowerCase(); } catch { /* ignore */ }
      }
      if (!host) return;

      const { markDismissed } = await import('@/services/testing/ui/preview/auth-detector');
      markDismissed(data.previewSessionId, host);
      logger.info('[WebSocket] preview:auth:dismiss recorded', {
        previewSessionId: data.previewSessionId,
        hostname: host,
        userId: ensuredUserId,
      });
    } catch (err) {
      logger.debug('[WebSocket] preview:auth:dismiss handler threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  socket.on('preview:apply-resource' as any, async (data: {
    previewSessionId: string;
    resourceId: string;
  }) => {
    const emitResult = (payload: {
      success: boolean;
      resourceId: string;
      resourceName?: string;
      error?: string;
    }): void => {
      try {
        socket.emit('preview:apply-resource:result', {
          previewSessionId: data?.previewSessionId,
          ...payload,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    };

    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) {
        emitResult({ success: false, resourceId: data?.resourceId, error: 'Unauthorized' });
        return;
      }

      const { previewSessionId, resourceId } = data || {};
      if (!previewSessionId || !resourceId) {
        emitResult({ success: false, resourceId: resourceId || '', error: 'Missing previewSessionId or resourceId' });
        return;
      }

      if (!checkRateLimit(socket.id, 'apply')) {
        emitResult({ success: false, resourceId, error: 'Rate limited' });
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        emitResult({ success: false, resourceId, error: 'Session not owned by user' });
        return;
      }

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
      if (PreviewRunService.isRunning(previewSessionId)) {
        emitResult({ success: false, resourceId, error: 'Cannot apply a resource while a run is in progress' });
        return;
      }

      const page = sessionService.getPage(previewSessionId, ensuredUserId);
      const context = sessionService.getContext(previewSessionId, ensuredUserId);
      const sessionMeta = sessionService.getSession(previewSessionId);
      if (!page || !context || !sessionMeta) {
        emitResult({ success: false, resourceId, error: 'Preview session has no active page/context' });
        return;
      }

      const [{ loadDecrypted }, { requireResourceAdapter }] = await Promise.all([
        import('@/services/test-resource/test-resource.service'),
        import('@/services/test-resource/adapter-registry'),
      ]);

      const resource = await loadDecrypted(resourceId, ensuredUserId);
      if (!resource) {
        emitResult({ success: false, resourceId, error: 'Resource not found or not owned by user' });
        return;
      }
      if (resource.kind !== 'auth') {
        // Phase 4 only ships auth; other kinds can't be live-applied to a
        // preview because they need a test-execution context (env vars,
        // device emulation, scenario setup, etc.).
        emitResult({
          success: false,
          resourceId,
          resourceName: resource.name,
          error: `Only auth resources can be applied to a preview (got "${resource.kind}")`,
        });
        return;
      }
      if (resource.status === 'broken') {
        emitResult({
          success: false,
          resourceId,
          resourceName: resource.name,
          error: `Login "${resource.name}" is marked broken — re-record it first`,
        });
        return;
      }

      // Cookies arrive cross-origin (Login scope may differ from preview's
      // current page). The external-nav trap would otherwise revert the
      // post-apply reload — tell it this next navigation is user-intended.
      try {
        const { markIntentionalGoto } = await import('@/services/testing/ui/preview/external-nav-trap');
        markIntentionalGoto(previewSessionId, page.url());
      } catch { /* non-fatal */ }

      const adapter = requireResourceAdapter('auth');
      try {
        await adapter.apply(
          {
            userId: ensuredUserId,
            projectId: sessionMeta.projectId,
            page,
            context,
            runVariables: new Map(),
          },
          resource,
        );
      } catch (err) {
        emitResult({
          success: false,
          resourceId,
          resourceName: resource.name,
          error: `Failed to apply login: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      // Silence the auth-detector for 10s. The upcoming reload fires
      // framenavigated + load, and cookies aren't visible to the first
      // render — without this cooldown the detector would re-fire the
      // overlay in the gap between "reload starts" and "app re-auths".
      try {
        const { markApplyCooldown } = await import('@/services/testing/ui/preview/auth-detector');
        markApplyCooldown(previewSessionId);
      } catch { /* non-fatal */ }

      // Reload the current page so the app re-reads cookies/localStorage and
      // renders in the authenticated state. Skip the reload if we're still
      // on about:blank — nothing to re-render.
      try {
        if (page.url() && page.url() !== 'about:blank') {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        }
      } catch (err) {
        // Apply succeeded, reload failed — still report success so the user
        // can manually navigate. Cookies are injected either way.
        logger.warn('[WebSocket] apply-resource reload failed (non-fatal)', {
          previewSessionId,
          resourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      emitResult({ success: true, resourceId, resourceName: resource.name });
      logger.info('[WebSocket] Applied login to preview', {
        previewSessionId,
        resourceId,
        resourceName: resource.name,
      });
    } catch (error) {
      logger.error('[WebSocket] preview:apply-resource handler error', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      emitResult({
        success: false,
        resourceId: data?.resourceId || '',
        error: 'Internal error',
      });
    }
  });

  socket.on('preview:save-login' as any, async (data: {
    previewSessionId: string;
    resourceId?: string;
    name?: string;
    description?: string;
    domain?: string;
    ttlSeconds?: number;
    setAsDefault?: boolean;
    /**
     * Optional IntentStep[] captured during the "Record New Login" flow.
     * When present, the handler walks the steps, moves any password-typed
     * `value` into the encrypted resource envelope under a generated
     * `_secret_<id>` key, and replaces the in-step value with a
     * `{{_secret_<id>}}` placeholder. RecipeExecutor interpolates it back
     * at heal time. Steps with no sensitive content pass through unchanged.
     * Empty / missing array = no recipe stored (heal won't be possible).
     */
    recipe?: Array<Record<string, unknown>>;
  }) => {
    const emitResult = (payload: {
      success: boolean;
      resource?: {
        id: string;
        name: string;
        kind: 'auth';
        status: 'active' | 'stale' | 'broken';
        capturedAt?: string;
        expiresAt?: string;
        scope?: Record<string, unknown>;
      };
      updated?: boolean;
      error?: string;
    }): void => {
      try {
        socket.emit('preview:save-login:result', {
          previewSessionId: data?.previewSessionId,
          ...payload,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    };

    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) {
        emitResult({ success: false, error: 'Unauthorized' });
        return;
      }

      const { previewSessionId, resourceId, name, description, domain, ttlSeconds, setAsDefault, recipe: rawRecipe } = data || {};
      if (!previewSessionId) {
        emitResult({ success: false, error: 'Missing previewSessionId' });
        return;
      }
      if (!resourceId && !name) {
        emitResult({ success: false, error: 'A new login needs a name; pass resourceId to update an existing one' });
        return;
      }

      if (!checkRateLimit(socket.id, 'apply')) {
        emitResult({ success: false, error: 'Rate limited' });
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        emitResult({ success: false, error: 'Session not owned by user' });
        return;
      }

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
      if (PreviewRunService.isRunning(previewSessionId)) {
        emitResult({ success: false, error: 'Cannot save a login while a run is in progress' });
        return;
      }

      const page = sessionService.getPage(previewSessionId, ensuredUserId);
      const context = sessionService.getContext(previewSessionId, ensuredUserId);
      const sessionMeta = sessionService.getSession(previewSessionId);
      if (!page || !context || !sessionMeta) {
        emitResult({ success: false, error: 'Preview session has no active page/context' });
        return;
      }

      const projectId = sessionMeta.projectId;
      if (!projectId) {
        emitResult({ success: false, error: 'Preview session is not bound to a project' });
        return;
      }

      const previewUrl = page.url();
      if (!previewUrl || previewUrl === 'about:blank') {
        emitResult({ success: false, error: 'Navigate to the logged-in page first — blank previews have no session to save' });
        return;
      }

      // Derive the scope default from the current preview URL. The caller
      // can override via `domain` when the login host differs from the
      // page host (e.g. subdomain SSO).
      let fallbackDomain: string | undefined;
      try { fallbackDomain = new URL(previewUrl).hostname; } catch { /* ignore */ }

      const adapter = (await import('@/services/test-resource/adapter-registry')).requireResourceAdapter('auth');
      if (!adapter.capture) {
        emitResult({ success: false, error: 'Auth adapter does not support capture — update the backend' });
        return;
      }
      let captured: { config: Record<string, unknown>; sensitive: Record<string, unknown> };
      try {
        const raw = await adapter.capture({
          userId: ensuredUserId,
          projectId,
          page,
          context,
          runVariables: new Map(),
        });
        captured = {
          config: (raw.config ?? {}) as Record<string, unknown>,
          sensitive: (raw.sensitive ?? {}) as Record<string, unknown>,
        };
      } catch (err) {
        emitResult({
          success: false,
          error: `Failed to capture login state: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      // ─────────────────────────────────────────────────────────────────────
      // Recipe redaction (Step A of recipe-active heal).
      //
      // The FE passes the user-recorded `editorSteps` as `recipe` so heal can
      // replay the login flow. Type-steps targeting `<input type="password">`
      // (and other secret-kind inputs the recorder tagged via
      // `recordedInputType`) carry plaintext in `step.value` — the helper
      // below moves those values into the encrypted resource envelope and
      // leaves a `{{_secret_<key>}}` placeholder in the step. RecipeExecutor
      // interpolates back at replay (Step D).
      //
      // Single source of truth: `redactRecipeForResource` lives in
      // `runtime/recipe-redaction.ts` so the regex / key shape stays in
      // sync with `interpolateRecipeSecrets` on the read side.
      // ─────────────────────────────────────────────────────────────────────
      const { redactRecipeForResource } = await import(
        '@/services/test-resource/runtime/recipe-redaction'
      );
      const { recipe: redactedRecipe, sensitive: recipeSensitive } =
        redactRecipeForResource(rawRecipe);
      // Merge any redacted secrets into the captured sensitive envelope.
      // createResource / captureState encrypts the merged map field-by-field.
      if (Object.keys(recipeSensitive).length > 0) {
        captured.sensitive = { ...captured.sensitive, ...recipeSensitive };
      }

      const testResourceService = await import('@/services/test-resource/test-resource.service');
      try {
        if (resourceId) {
          // Update path: re-capture into an existing resource. The service
          // helper takes positional args and returns void — we re-read
          // through loadDecrypted to echo the updated row to the caller.
          // Note: when the caller supplies a recipe we ALSO call updateResource
          // to persist the new recipe array — captureState only touches
          // config/sensitive/freshness, never `recipe`.
          if (redactedRecipe.length > 0) {
            await testResourceService.updateResource(resourceId, ensuredUserId, {
              recipe: redactedRecipe,
              refreshMethod: 'ui_recipe',
            });
          }
          await testResourceService.captureState(
            resourceId,
            ensuredUserId,
            { config: captured.config, sensitive: captured.sensitive },
            { heal: false },
          );
          const refreshed = await testResourceService.loadDecrypted(resourceId, ensuredUserId);
          if (!refreshed) {
            emitResult({ success: false, error: 'Resource disappeared after capture' });
            return;
          }
          emitResult({
            success: true,
            updated: true,
            resource: {
              id: refreshed.id,
              name: refreshed.name,
              kind: 'auth',
              status: refreshed.status,
              capturedAt: refreshed.expiresAt && refreshed.ttlSeconds
                ? new Date(refreshed.expiresAt.getTime() - refreshed.ttlSeconds * 1000).toISOString()
                : undefined,
              expiresAt: refreshed.expiresAt?.toISOString(),
              scope: refreshed.scope as unknown as Record<string, unknown>,
            },
          });
          logger.info('[WebSocket] Re-captured login', {
            previewSessionId, resourceId, name: refreshed.name,
          });
        } else {
          // Create path: brand-new Login scoped to the current hostname
          // (or the caller's override). TTL defaults to 7 days if omitted
          // — mirrors the LoginsSettings "new login" default.
          const created = await testResourceService.createResource({
            userId: ensuredUserId,
            projectId,
            kind: 'auth',
            name: name!,
            description,
            scope: {
              platform: 'web',
              domain: domain || fallbackDomain,
            },
            config: captured.config,
            sensitive: captured.sensitive,
            ttlSeconds: ttlSeconds ?? 7 * 24 * 60 * 60,
            // When a recipe was recorded, refresh_method is `ui_recipe` so
            // the supervisor will replay it on auth loss; otherwise stay on
            // `manual` (legacy: user re-records via preview).
            refreshMethod: redactedRecipe.length > 0 ? 'ui_recipe' : 'manual',
            recipe: redactedRecipe.length > 0 ? redactedRecipe : undefined,
          });

          // Optional default upsert — mirrors the REST controller's logic
          // so the "Set as default" checkbox in the overlay works without
          // a second round-trip.
          if (setAsDefault === true) {
            try {
              await testResourceService.setDefaultResource({
                userId: ensuredUserId,
                projectId,
                resourceId: created.id,
                kind: 'auth',
                platform: 'web',
                url: domain || fallbackDomain || null,
                appPackage: null,
                urlPattern: null,
              });
            } catch (err) {
              // Non-fatal: creation succeeded, default wiring is separate.
              logger.warn('[WebSocket] save-login setAsDefault failed', {
                previewSessionId, id: created.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          emitResult({
            success: true,
            updated: false,
            resource: {
              id: created.id,
              name: created.name,
              kind: 'auth',
              status: created.status,
              capturedAt: created.capturedAt,
              expiresAt: created.expiresAt,
              scope: created.scope as unknown as Record<string, unknown>,
            },
          });
          logger.info('[WebSocket] Saved new login from preview', {
            previewSessionId, resourceId: created.id, name: created.name,
          });
        }
      } catch (err) {
        emitResult({
          success: false,
          error: `Failed to persist login: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } catch (error) {
      logger.error('[WebSocket] preview:save-login handler error', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      emitResult({ success: false, error: 'Internal error' });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', async () => {
    const trimmedUserId = typeof userId === 'string' ? userId.trim() : '';
    const canCleanupRecording = trimmedUserId.length > 0;
    let sessionService: Awaited<ReturnType<typeof import('@/services/testing/ui/preview')['getPreviewSessionService']>> | null = null;
    let recordingCaptureService: (typeof import('@/services/testing/ui/preview/recording-capture.service'))['RecordingCaptureService'] | null = null;

    if (canCleanupRecording) {
      try {
        const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
        sessionService = getPreviewSessionService();
      } catch (error) {
        logger.debug('[WebSocket] Failed to initialize session service for disconnect cleanup', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // V7: Cleanup all streams for all rooms the socket was subscribed to
    const subs = previewSubscriptions.get(socket.id);
    if (subs) {
      for (const room of subs) {
        // Decrement refcount for this room
        const currentCount = previewRoomRefCount.get(room) || 0;
        const newCount = Math.max(0, currentCount - 1);

        if (newCount === 0) {
          // Extract previewSessionId from room name (format: "preview:<sessionId>")
          const previewSessionId = room.replace('preview:', '');
          stopPreviewStreams(previewSessionId).catch(() => {});
          previewRoomRefCount.delete(room);

          // Cleanup recording timers
          const typingTimer = recordingTypingTimers.get(previewSessionId);
          if (typingTimer) { clearTimeout(typingTimer); recordingTypingTimers.delete(previewSessionId); }
          const scrollState = recordingScrollTimers.get(previewSessionId);
          if (scrollState) { clearTimeout(scrollState.timer); recordingScrollTimers.delete(previewSessionId); }
          // Drop any inline upload prompts — the native dialog (if still
          // open) gets dismissed and the FileChooser handle is released.
          // No need to emit step:remove here: the socket is gone anyway.
          cancelPendingUploadsForSession(previewSessionId, null);
          // Clear the auto-stop timer; the disconnect path does its own cleanup
          // below and must not race with a finalizeRecording() fire while the
          // socket is already gone.
          const autoStopTimer = recordingAutoStopTimers.get(previewSessionId);
          if (autoStopTimer) { clearTimeout(autoStopTimer); recordingAutoStopTimers.delete(previewSessionId); }

          if (
            canCleanupRecording
            && sessionService
            && sessionService.isSessionOwned(previewSessionId, trimmedUserId)
            && sessionService.isRecording(previewSessionId, trimmedUserId)
          ) {
            try {
              const page = sessionService.getPage(previewSessionId, trimmedUserId);
              if (page) {
                if (!recordingCaptureService) {
                  const mod = await import('@/services/testing/ui/preview/recording-capture.service');
                  recordingCaptureService = mod.RecordingCaptureService;
                }
                await recordingCaptureService.removeSelectChangeListener(page).catch(() => {});

                const loadHandler = (page as any).__qai_recording_load_handler;
                if (loadHandler) {
                  page.off('load', loadHandler);
                  delete (page as any).__qai_recording_load_handler;
                }

                const fcHandler = (page as any).__qai_recording_filechooser_handler;
                if (fcHandler) {
                  page.off('filechooser', fcHandler);
                  delete (page as any).__qai_recording_filechooser_handler;
                }
              }

              sessionService.setRecordingBuffer(previewSessionId, trimmedUserId, null);
              sessionService.setRecordingLastTypeStep(previewSessionId, trimmedUserId, null);
              sessionService.setRecordingLastScrollStep(previewSessionId, trimmedUserId, null);
              sessionService.setRecordingDragState(previewSessionId, trimmedUserId, null);
              sessionService.setRecording(previewSessionId, trimmedUserId, false);

              // Editor trace: log disconnect stop and close writer
              const dcTrace = EditorTraceService.get(previewSessionId);
              if (dcTrace) {
                dcTrace.writeRecordingStop('disconnect');
                EditorTraceService.close(previewSessionId).then((meta) => {
                  if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor' })
                    .catch((err) => logger.error('[EDITOR_TRACE] Upload failed on disconnect', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
                }).catch((err) => logger.error('[EDITOR_TRACE] Close failed on disconnect', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
              }
            } catch (error) {
              logger.debug('[WebSocket] Recording cleanup failed on disconnect', {
                socketId: socket.id,
                previewSessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // Always close editor trace writer on disconnect (may have been created by Apply, not just recording)
          try {
            const traceOnDisconnect = EditorTraceService.get(previewSessionId);
            if (traceOnDisconnect) {
              EditorTraceService.close(previewSessionId).then((meta) => {
                if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor' })
                  .catch((err) => logger.error('[EDITOR_TRACE] Upload failed on disconnect (apply trace)', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
              }).catch((err) => logger.error('[EDITOR_TRACE] Close failed on disconnect (apply trace)', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
            }
          } catch { /* non-fatal */ }

          logger.debug('[WebSocket] Stopped streams on disconnect', {
            socketId: socket.id,
            room,
            previewSessionId,
          });
        } else {
          previewRoomRefCount.set(room, newCount);
        }
      }
    }

    cleanupPreviewSubscriptions(socket.id);
    cleanupRateLimits(socket.id); // V2: Cleanup rate limit data
    // V18: Cleanup all hover probe entries for this socket (keyed as socketId:sessionId)
    for (const key of hoverProbeState.keys()) {
      if (key.startsWith(`${socket.id}:`)) hoverProbeState.delete(key);
    }
    // V20: Cleanup all move/wheel coalesce entries for this socket
    for (const key of moveCoalesceState.keys()) {
      if (key.startsWith(`${socket.id}:`)) moveCoalesceState.delete(key);
    }
    for (const key of wheelCoalesceState.keys()) {
      if (key.startsWith(`${socket.id}:`)) wheelCoalesceState.delete(key);
    }
  });
};

/**
 * Emit page update to preview subscribers
 */
export const emitPreviewPage = (
  io: any, // Socket.IO server instance
  previewSessionId: string,
  payload: Omit<PreviewPagePayload, 'previewSessionId' | 'timestamp'>
): void => {
  const room = createRoomName('preview', previewSessionId);
  io.to(room).emit('preview:page', {
    previewSessionId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
};
