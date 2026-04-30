/**
 * Editor Trace Service
 * JSONL trace logging for editor/recording events during manual test step creation.
 * Writes to test_logs/editor/ for future analysis and debugging.
 *
 * Wraps LiteTraceWriter with editor-specific convenience methods
 * and per-session lifecycle management (one trace file per editor session).
 *
 * Usage:
 *   const trace = EditorTraceService.getOrCreate(sessionId, userId);
 *   trace.writeClick({ x, y, button: 'left' });
 *   // ... later
 *   await EditorTraceService.close(sessionId);
 *
 * Reading trace files:
 *   cat test_logs/editor/*.jsonl | jq 'select(.eventType == "step_captured")'
 */

import { LiteTraceWriter } from '@/agent/core/lite/trace/lite-trace-writer';
import * as path from 'path';
import type { PreviewIntentStep } from '@/websocket/types/types';
import type { InteractiveNode, LintResult } from './preview.types';
import type { RuleTraceEntry } from './element-resolver.service';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const EDITOR_LOGS_DIR = path.join(process.cwd(), 'test_logs', 'editor');
const EDITOR_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per editor session
const EDITOR_MAX_PAYLOAD_CHARS = 10_000;

/**
 * String.slice cuts at UTF-16 code unit boundaries, which splits
 * surrogate pairs when an emoji (🤝, U+1F91D = 🤝) sits
 * astride the slice index. The resulting JSON contains a lone high
 * surrogate that breaks every JSON parser downstream (jq, json.loads).
 * This helper trims one extra code unit when the boundary lands on
 * a high surrogate so the pair stays intact (or both halves get cut).
 *
 * Bug reproduction (2026-04-27): a 14-line trace turned unreadable
 * because writeElementResolution sliced an LLM prompt containing 🤝
 * exactly on the surrogate boundary — `\uD83E` survived alone.
 */
function safeSlice(s: string, max: number): string {
  if (typeof s !== 'string' || s.length <= max) return s;
  let end = max;
  // If we'd cut between surrogates, drop the orphan high surrogate too.
  const code = s.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return s.slice(0, end);
}

/** Active writers indexed by previewSessionId */
const activeWriters = new Map<string, EditorTraceService>();

/**
 * Compact rule trace summary — group by ruleId with affected refs.
 * Keeps trace readable: instead of 47 individual entries,
 * produces ~5-10 grouped entries.
 */
function summarizeRuleTrace(trace: RuleTraceEntry[]): Array<{
  ruleId: string;
  action: string;
  count: number;
  refs: string[];
  sample?: string;
}> {
  const grouped = new Map<string, { action: string; refs: string[]; sample?: string }>();
  for (const entry of trace) {
    const key = `${entry.ruleId}|${entry.action}`;
    const group = grouped.get(key);
    if (group) {
      group.refs.push(...entry.affectedRefs);
    } else {
      grouped.set(key, {
        action: entry.action,
        refs: [...entry.affectedRefs],
        sample: safeSlice(entry.evidence, 120),
      });
    }
  }
  return Array.from(grouped.entries()).map(([key, val]) => ({
    ruleId: key.split('|')[0],
    action: val.action,
    count: val.refs.length,
    refs: val.refs.slice(0, 15), // cap to avoid huge payloads
    sample: val.sample,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class EditorTraceService {
  private writer: LiteTraceWriter;
  private previewSessionId: string;
  private userId: string;

  private constructor(previewSessionId: string, userId: string) {
    this.previewSessionId = previewSessionId;
    this.userId = userId;
    this.writer = new LiteTraceWriter({
      testId: `editor_${previewSessionId}`,
      logsDir: EDITOR_LOGS_DIR,
      maxFileSizeBytes: EDITOR_MAX_FILE_SIZE,
      maxPayloadChars: EDITOR_MAX_PAYLOAD_CHARS,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATIC LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  /** Get or create a trace writer for a preview session */
  static getOrCreate(previewSessionId: string, userId: string): EditorTraceService {
    let instance = activeWriters.get(previewSessionId);
    if (!instance) {
      instance = new EditorTraceService(previewSessionId, userId);
      activeWriters.set(previewSessionId, instance);
    }
    return instance;
  }

  /** Get existing writer (returns null if none active) */
  static get(previewSessionId: string): EditorTraceService | null {
    return activeWriters.get(previewSessionId) ?? null;
  }

  /** Close and remove writer for a session. Returns metadata for upload, or null if no active writer. */
  static async close(previewSessionId: string): Promise<{ filePath: string; userId: string } | null> {
    const instance = activeWriters.get(previewSessionId);
    if (instance) {
      activeWriters.delete(previewSessionId);
      const filePath = instance.writer.getFilePath();
      const userId = instance.userId;
      await instance.writer.close();
      return { filePath, userId };
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LIFECYCLE EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeRecordingStart(pageUrl?: string): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'recording_start',
      payload: { previewSessionId: this.previewSessionId, userId: this.userId, pageUrl },
    });
  }

  writeRecordingStop(reason: 'user' | 'disconnect' | 'max_time' | 'max_steps'): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'recording_stop',
      payload: { previewSessionId: this.previewSessionId, reason },
    });
  }

  writeSessionStart(data: { startUrl: string; viewport?: { width: number; height: number } }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'session_start',
      payload: { previewSessionId: this.previewSessionId, userId: this.userId, ...data },
    });
  }

  writeSessionStop(reason: string): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'session_stop',
      payload: { previewSessionId: this.previewSessionId, reason },
    });
  }

  writeNavigation(data: { fromUrl: string; toUrl: string; trigger: 'goto' | 'reload' | 'click' | 'back' | 'forward' | 'auto' }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'navigation',
      payload: data,
    });
  }

  /**
   * Session reset — user clicked the "Reset" button. Emitted at entry
   * (phase='start') and exit (phase='end'). The `end` event carries
   * success/error so a failed reset shows up without greping the server
   * log. Makes regressions like the V-Phase4 video-freeze-after-reset
   * discoverable from the editor trace alone.
   */
  writeSessionReset(data: {
    phase: 'start' | 'end';
    fromUrl?: string;
    toUrl?: string;
    success?: boolean;
    error?: string;
    durationMs?: number;
  }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'session_reset',
      payload: { previewSessionId: this.previewSessionId, ...data },
    });
  }

  /**
   * Video screencast lifecycle. Four transitions worth recording:
   *   attach   — CDP Page.startScreencast succeeded for a given page
   *   detach   — CDP listener removed (page close, explicit stop)
   *   restart  — replacement stream created for a new page; `inheritedSeq`
   *              tells us whether frame numbering continues or resets
   *              (resetting is a common regression — see the double-stop
   *              bug where `inheritedSeq` came back undefined).
   *   first_frame — first actual CDP frame received after attach/restart
   *              (so we can see exactly how long users stared at a blank
   *              preview before the video pipeline came alive).
   */
  writeVideoStreamEvent(data: {
    phase: 'attach' | 'detach' | 'restart' | 'first_frame';
    reason?: string;
    seq?: number;
    inheritedSeq?: number | null;
    pageUrl?: string;
    durationMs?: number;
  }): void {
    this.writer.write({
      stage: 'video',
      eventType: 'stream_' + data.phase,
      payload: { previewSessionId: this.previewSessionId, ...data },
    });
  }

  /**
   * Main-frame navigation detected (Playwright `framenavigated`). Mirrors
   * what the browser itself saw, independent of the `navigation` event
   * above (which is fired by OUR goto wrappers). Useful when the page
   * JS-navigates on its own and we want to correlate that with snapshot
   * results / action outcomes.
   */
  writeFrameNavigated(data: {
    url: string;
    isMainFrame: boolean;
    trigger?: 'unknown' | 'page_load' | 'spa' | 'redirect';
  }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'frame_navigated',
      payload: data,
    });
  }

  /**
   * External-nav trap fired — a cross-origin navigation was reverted
   * (payment link, window.open, form submit, etc.). `action` distinguishes
   * a real revert from a suppressed-during-run pass-through.
   */
  writeExternalNavTrap(data: {
    action: 'reverted' | 'allowed_intent' | 'allowed_same_app' | 'suppressed_during_run';
    fromUrl: string;
    toUrl: string;
    recoveredTo?: string;
    reason?: string;
  }): void {
    this.writer.write({
      stage: 'safety',
      eventType: 'external_nav_trap',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SNAPSHOT EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeSnapshotResult(data: {
    url: string;
    nodeCount: number;
    durationMs: number;
    source: 'lint' | 'interval' | 'after_input' | 'force';
    debugStats?: Record<string, any>;
  }): void {
    this.writer.write({
      stage: 'snapshot',
      eventType: 'snapshot_collected',
      payload: data,
    });
  }

  writeSnapshotError(data: {
    url: string;
    source: string;
    error: string;
    isNavigationInProgress?: boolean;
    debugStats?: Record<string, any>;
  }): void {
    this.writer.write({
      stage: 'snapshot',
      eventType: 'snapshot_error',
      payload: data,
    });
  }

  writeSnapshotEmpty(data: {
    url: string;
    isNavigationInProgress: boolean;
    keptPreviousState: boolean;
    debugStats?: Record<string, any>;
  }): void {
    this.writer.write({
      stage: 'snapshot',
      eventType: 'snapshot_empty',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RAW INPUT EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeClick(data: {
    x: number; y: number; button?: string; clickCount?: number;
    preClickElement?: Record<string, any> | null; isRecording: boolean;
  }): void {
    this.writer.write({ stage: 'input', eventType: 'input_click', payload: data });
  }

  writeMouseDown(data: { x: number; y: number; button?: string }): void {
    this.writer.write({ stage: 'input', eventType: 'input_mouse_down', payload: data });
  }

  writeMouseUp(data: { x: number; y: number; button?: string }): void {
    this.writer.write({ stage: 'input', eventType: 'input_mouse_up', payload: data });
  }

  writeScroll(data: { deltaX: number; deltaY: number }): void {
    this.writer.write({ stage: 'input', eventType: 'input_scroll', payload: data });
  }

  writeType(data: { text: string; elementRef?: string; elementLabel?: string }): void {
    this.writer.write({ stage: 'input', eventType: 'input_type', payload: data });
  }

  writePress(data: { key: string; modifiers?: string[]; isRecording: boolean }): void {
    this.writer.write({ stage: 'input', eventType: 'input_press', payload: data });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RECORDING STEP EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeStepCaptured(step: PreviewIntentStep, source: string): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_captured',
      payload: { step, source },
    });
  }

  writeStepUpdated(step: PreviewIntentStep, reason: string): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_updated',
      payload: { stepId: step.id, step, reason },
    });
  }

  writeStepRemoved(stepId: string, reason: string): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_removed',
      payload: { stepId, reason },
    });
  }

  writeNavDetected(data: { fromUrl: string; toUrl: string }): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_nav_detected',
      payload: data,
    });
  }

  writeSelectChange(data: { label: string; selectedText: string; selectedValue: string }): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_select_change',
      payload: data,
    });
  }

  writeFileUpload(data: { fileNames: string[]; probedElement?: Record<string, any> | null }): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_file_upload',
      payload: data,
    });
  }

  writeDragDrop(data: {
    startX: number; startY: number; endX: number; endY: number;
    startElement?: Record<string, any> | null; endElement?: Record<string, any> | null;
  }): void {
    this.writer.write({
      stage: 'recording',
      eventType: 'step_drag_drop',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP APPLY EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeStepApplyRequest(stepDraft: PreviewIntentStep): void {
    this.writer.write({
      stage: 'apply',
      eventType: 'step_apply_request',
      payload: { stepId: stepDraft.id, type: stepDraft.type, description: stepDraft.description },
    });
  }

  writeStepApplyResult(result: {
    success: boolean; error?: string; appliedStep?: PreviewIntentStep;
  }): void {
    this.writer.write({
      stage: 'apply',
      eventType: 'step_apply_result',
      payload: result,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EDITOR ACTION (AI) EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeEditorActionRequest(data: { message: string; previewSessionId: string }): void {
    this.writer.write({
      stage: 'editor_action',
      eventType: 'editor_action_request',
      payload: data,
    });
  }

  writeEditorActionExtract(data: { type: string; description: string; value?: string } | null): void {
    this.writer.write({
      stage: 'editor_action',
      eventType: 'editor_action_extract',
      payload: { extracted: data },
    });
  }

  writeEditorActionResult(data: {
    success: boolean; error?: string; actionType: string; stepId: string;
  }): void {
    this.writer.write({
      stage: 'editor_action',
      eventType: 'editor_action_result',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ELEMENT RESOLUTION DIAGNOSTICS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write full element resolution trace — the single most important event for debugging
   * "why did the resolver not find my element?"
   *
   * Includes: intent, action, DOM snapshot summary, rule trace, modal state,
   * allowed/excluded sets, LLM decision, and final result.
   *
   * Usage from intent-step-lint.service.ts after resolveElement() returns.
   */
  writeElementResolution(data: {
    /** Step description (user intent) */
    description: string;
    /** Action type (click, type, select, etc.) */
    actionType: string;
    /** Current page URL */
    pageUrl: string;
    /** Final result status */
    result: LintResult;
    /** Total DOM nodes on page before filtering */
    domNodesTotal: number;
    /** Full DOM node list — compact summary per node for debugging */
    domNodes: InteractiveNode[];
    /** Rule trace from buildAllowedSets */
    ruleTrace?: RuleTraceEntry[];
    /** Hard allowed element count */
    hardAllowedCount?: number;
    /** Soft allowed element count */
    softAllowedCount?: number;
    /** Whether evidence shortcut was used (cache hit) */
    evidenceShortcut?: boolean;
    /** Evidence shortcut ref if used */
    evidenceRef?: string;
    /** Total resolution time in ms */
    latencyMs: number;
  }): void {
    // Build compact DOM snapshot — only fields useful for debugging
    const domSnapshot = data.domNodes.slice(0, 100).map((n) => ({
      ref: n.ref,
      tag: n.tag,
      role: n.role || undefined,
      type: n.type || undefined,
      label: n.labelText || undefined,
      ariaLabel: n.ariaLabel || undefined,
      text: n.text ? safeSlice(n.text, 60) : undefined,
      placeholder: n.placeholder || undefined,
      isVisible: n.isVisible,
      isDisabled: n.isDisabled || undefined,
      isInsideActiveModal: n.isInsideActiveModal || undefined,
      isTopMostAtCenter: n.isTopMostAtCenter,
      containerTitles: n.containerTitles?.length ? n.containerTitles : undefined,
    }));

    // Build compact rule trace — group by ruleId for readability
    const rulesSummary = data.ruleTrace
      ? summarizeRuleTrace(data.ruleTrace)
      : undefined;

    // Compact result
    const resultSummary: Record<string, any> = {
      status: data.result.status,
      confidence: data.result.confidence,
      message: data.result.message,
      candidateCount: data.result.candidates?.length ?? 0,
      degradedMode: data.result.degradedMode || undefined,
      degradedReason: (data.result as any).degradedReason || undefined,
      needsAiFallback: data.result.needsAiFallback || undefined,
      cacheHit: data.result.cacheHit || undefined,
    };

    // Include chosen element detail
    if (data.result.candidates?.length) {
      resultSummary.chosen = {
        ref: data.result.candidates[0].ref,
        label: data.result.candidates[0].label,
        reason: data.result.candidates[0].reason,
        confidence: data.result.candidates[0].confidence,
      };
    }

    // LLM trace (prompt + response) — only when LLM was called
    const llmTrace = data.result._llmTrace
      ? {
          model: data.result._llmTrace.model,
          path: data.result._llmTrace.path,
          latencyMs: data.result._llmTrace.latencyMs,
          prompt: safeSlice(data.result._llmTrace.prompt, 2000),
          response: safeSlice(data.result._llmTrace.response, 500),
        }
      : undefined;

    this.writer.write({
      stage: 'resolution',
      eventType: 'element_resolution',
      payload: {
        description: data.description,
        actionType: data.actionType,
        pageUrl: data.pageUrl,
        domNodesTotal: data.domNodesTotal,
        hardAllowedCount: data.hardAllowedCount ?? 0,
        softAllowedCount: data.softAllowedCount ?? 0,
        evidenceShortcut: data.evidenceShortcut || undefined,
        evidenceRef: data.evidenceRef || undefined,
        latencyMs: data.latencyMs,
        result: resultSummary,
        rules: rulesSummary,
        domSnapshot,
        llm: llmTrace,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V15: LOOKAHEAD / STEP READINESS EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  // These make the inter-step gap observable. Before V15 there was a black hole
  // between "step N passed" and "step N+1 started" — if a phase stalled (e.g.
  // Playwright's default 30s actionTimeout firing twice), the only signal was
  // total elapsed time. Now each phase emits its own event so regressions like
  // the 60s stall we debugged can be identified in <5 seconds.
  // ─────────────────────────────────────────────────────────────────────────

  /** Lookahead started for the next step. */
  writeLookaheadStart(data: {
    nextStepId: string;
    nextActionType: string;
    prevActionType?: string;
    prevUrl?: string;
    maxWaitMs: number;
    settleMs: number;
    recordedDelayMs?: number;
    /** Strategies present in nextStep.compiled.locatorPlan (for diagnosing plan quality). */
    plannedLocatorStrategies?: string[];
  }): void {
    this.writer.write({
      stage: 'lookahead',
      eventType: 'lookahead_start',
      payload: data,
    });
  }

  /**
   * A single lookahead phase finished. `phase` names the stage (challenge_detection,
   * spa_nav_detection, loading_indicators, iframe_ready, shadow_dom_probe,
   * element_attached_gate, animation_wait, disabled_wait, overlay_wait, retry_loop,
   * blind_settle). `durationMs` is the wall time this phase took. `hardCapHit` is
   * set when one of the withHardCap()'d evaluates fell back to its fail-open default
   * — this is the most important signal when diagnosing stalls.
   */
  writeLookaheadPhase(data: {
    phase: string;
    durationMs: number;
    /** Phase-specific details. Keep small — this is per-step per-phase overhead. */
    details?: Record<string, any>;
    hardCapHit?: boolean;
  }): void {
    this.writer.write({
      stage: 'lookahead',
      eventType: 'lookahead_phase',
      payload: data,
    });
  }

  /** Lookahead finished — emits the aggregate result and XHR observer snapshot. */
  writeLookaheadEnd(data: {
    nextStepId: string;
    ready: boolean;
    totalDurationMs: number;
    autoWaitApplied: boolean;
    skipReason?: string;
    navigationDetected?: boolean;
    urlChanged?: boolean;
    /** XHR requests still in flight at handoff — pure diagnostic, we did not wait for them. */
    xhrInflightAtHandoff?: { count: number; urls: string[] };
  }): void {
    this.writer.write({
      stage: 'lookahead',
      eventType: 'lookahead_end',
      payload: data,
    });
  }

  /**
   * V15.1: Per-attempt detail inside the retry_loop. Previously we only saw the
   * aggregate `retry_loop: durationMs=30011, attempts=1` — which hides WHICH
   * locator burned the time and on WHICH sub-check (isVisible/isEnabled/count).
   * With this we can pinpoint whether a stale compiled label/placeholder is
   * blocking Playwright's actionability wait (dominant cause of the 30s stall).
   */
  writeRetryAttempt(data: {
    nextStepId: string;
    attempt: number;
    locatorCount: number;
    /** Per-locator diagnostic: index in the plan, which sub-checks ran, ms cost, result. */
    perLocator: Array<{
      index: number;
      strategy?: string;
      value?: string;
      isVisible?: boolean;
      isVisibleMs?: number;
      isEnabled?: boolean;
      isEnabledMs?: number;
      count?: number;
      countMs?: number;
      hardCapHit?: boolean;
      ready: boolean;
    }>;
    totalMs: number;
    ready: boolean;
  }): void {
    this.writer.write({
      stage: 'lookahead',
      eventType: 'retry_attempt',
      payload: data,
    });
  }

  /**
   * V15.1: `pageSettle` (MutationObserver DOM-stability wait) between retry
   * attempts. A runaway SPA that never stops mutating will eat the whole budget
   * here silently. Emit per-settle ms so we can see if settle itself is the
   * stall rather than the precondition checks.
   */
  writePageSettle(data: {
    context: 'retry_loop' | 'blind_settle' | 'post_nav';
    budgetMs: number;
    actualMs: number;
    domStableThresholdMs: number;
    /** True when the observer never saw the page go quiet — we hit the budget cap. */
    budgetExhausted: boolean;
  }): void {
    this.writer.write({
      stage: 'lookahead',
      eventType: 'page_settle',
      payload: data,
    });
  }

  /**
   * V15.1: The gap between `action_result` of step N and `lookahead_start` of
   * step N+1. When lookahead runs inside the step loop this is ~0, but we've
   * seen ~200-400ms gaps on some kazakh/angular pages that are otherwise
   * unaccounted for (likely post-action settle + snapshot cache invalidation).
   */
  writeInterStepGap(data: {
    prevStepId: string;
    nextStepId: string;
    /** ms between step N's action_result and the start of lookahead for step N+1. */
    gapMs: number;
    /** Anything the caller knows the gap was spent on (e.g. `post_action_settle`, `snapshot_invalidate`). */
    accountedFor?: string[];
  }): void {
    this.writer.write({
      stage: 'step_execution',
      eventType: 'inter_step_gap',
      payload: data,
    });
  }

  /**
   * V15.1: Sub-timing INSIDE executeAction. Playwright's `.click()` / `.fill()`
   * runs its own actionability wait sequence: visible → stable → enabled →
   * receives events → scrolls into view → action. When a click takes 15s we
   * can't currently tell which sub-wait was the culprit. This event surfaces
   * pre/post timings we measure from the caller side.
   */
  writeActionTiming(data: {
    stepId: string;
    stepType: string;
    /** Time from "we called locator.click/fill" until Playwright returned. */
    totalMs: number;
    /**
     * Cost of our pre-action visibility probe (not a real wait). Capped at
     * ~200ms by Promise.race. When small (<200ms) and `wasAlreadyVisible=true`,
     * the element was ready before executeAction — any slowness inside
     * `totalMs` was post-wait (stability/navigation). When `wasAlreadyVisible`
     * is false, executeAction had to wait for rendering internally — that's
     * usually where 15s+ clicks come from.
     */
    preWaitVisibleMs?: number;
    /** Diagnostic from the non-blocking isVisible probe. */
    wasAlreadyVisible?: boolean;
    /** Whether Playwright threw (even if we recovered) — useful for distinguishing real hang vs long wait. */
    playwrightThrew?: boolean;
    /** Kind of action dispatched (`click` / `fill` / `type` / `press` / etc). */
    method?: string;
  }): void {
    this.writer.write({
      stage: 'action',
      eventType: 'action_timing',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V15: COMPILED LOCATOR PER-ATTEMPT EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  // The compiled executor tries each strategy in the plan sequentially. Before V15
  // only the winner was traced — losers and their error modes were lost to stdout.
  // Now each attempt emits an event so "why did label='Логин' fail but placeholder
  // succeeded?" is answerable from the trace alone.
  // ─────────────────────────────────────────────────────────────────────────

  writeCompiledAttempt(data: {
    stepId: string;
    attempt: number;
    strategy: string;
    value: string;
    confidence?: number;
    timeoutMs: number;
    success: boolean;
    durationMs: number;
    failureKind?: 'not_found' | 'ambiguous' | 'fingerprint_mismatch' | 'timeout' | 'error';
    matchCount?: number;
    fingerprintScore?: number;
    error?: string;
  }): void {
    this.writer.write({
      stage: 'resolution',
      eventType: 'compiled_attempt',
      payload: data,
    });
  }

  /** Fired when compiled plan entries were reordered (e.g. shadow-DOM-aware priority). */
  writeCompiledReorder(data: {
    stepId: string;
    reason: string;
    before: string[];
    after: string[];
  }): void {
    this.writer.write({
      stage: 'resolution',
      eventType: 'compiled_reorder',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V15: ACTION EXECUTION EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  // What the Playwright call itself did: how long it waited on each actionability
  // subcheck (visible / enabled / stable), whether post-action settle fired, and
  // whether state verification matched expectations.
  // ─────────────────────────────────────────────────────────────────────────

  writeActionAttempt(data: {
    stepId: string;
    stepType: string;
    locatorSource: 'compiled' | 'resolver' | 'evidence' | 'manual';
    selector?: string;
    /** The candidate ref used (when resolver path). */
    ref?: string;
    attempt: number;
  }): void {
    this.writer.write({
      stage: 'action',
      eventType: 'action_attempt',
      payload: data,
    });
  }

  writeActionResult(data: {
    stepId: string;
    stepType: string;
    success: boolean;
    durationMs: number;
    /** Total wait time attributable to Playwright actionability (when measurable). */
    actionabilityWaitMs?: number;
    error?: string;
    /** Whether post-action waitForLoadState('domcontentloaded') fired within budget. */
    postActionSettleMs?: number;
    postActionSettleFired?: boolean;
  }): void {
    this.writer.write({
      stage: 'action',
      eventType: 'action_result',
      payload: data,
    });
  }

  writeActionVerify(data: {
    stepId: string;
    stepType: string;
    verificationMethod: 'aria-expanded' | 'aria-pressed' | 'aria-checked' | 'checked' | 'isVisible' | 'permissive' | 'click-effect' | 'none';
    verified: boolean;
    durationMs: number;
    beforeState?: Record<string, any>;
    afterState?: Record<string, any>;
    signal?: 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'download' | 'none';
  }): void {
    this.writer.write({
      stage: 'action',
      eventType: 'action_verify',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V15: PAGE STATE SNAPSHOT (context for why things hung)
  // ─────────────────────────────────────────────────────────────────────────
  // Captured at step_start and whenever a step takes longer than expected.
  // Answers "what state was the page in when this happened?" without needing
  // to reproduce the session.
  // ─────────────────────────────────────────────────────────────────────────

  writePageState(data: {
    stepId: string;
    when: 'step_start' | 'slow_step' | 'step_fail';
    url: string;
    title?: string;
    readyState?: string;
    bodyTextLength?: number;
    interactiveElementCount?: number;
    frameworks?: {
      react?: boolean; angular?: boolean; vue?: boolean;
      alpine?: boolean; htmx?: boolean; svelte?: boolean;
    };
    hasServiceWorker?: boolean;
    consoleErrorCount?: number;
    consoleErrorSamples?: string[];
  }): void {
    this.writer.write({
      stage: 'page_state',
      eventType: 'page_state_snapshot',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENRICHED DIAGNOSTIC EVENTS
  // ─────────────────────────────────────────────────────────────────────────
  // Added April 2026 to make logs answer "what did the user want?" / "where
  // did applyStep hang?" / "what did the LLM see?" without code spelunking.
  // Each event is small (under ~500 bytes) and bounded; truncations applied
  // to user-supplied strings so a 10MB description can't bloat the trace.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * One-time snapshot of who/what/where for this run. Emitted once when a Run
   * starts. Lets a reader reconstruct the full context without correlating
   * events. Sensitive fields (userId truncated, no auth headers, no cookies).
   */
  writeSessionContext(data: {
    previewSessionId: string;
    userId: string;
    intentTestCaseId?: string;
    isMobile: boolean;
    isRecording: boolean;
    viewport?: { width: number; height: number };
    startUrl?: string;
    currentUrl?: string;
    stepCount: number;
    hasAuthBinding: boolean;
    authReset?: 'always' | 'never';
    runMode: 'single_apply' | 'run_all' | 'apply_all' | 'editor_action';
  }): void {
    this.writer.write({
      stage: 'context',
      eventType: 'session_context',
      payload: data,
    });
  }

  /**
   * What this step is supposed to do. Emitted at step_start so we never have
   * to ask "what did the user want?" — the answer is in the trace. Truncates
   * `value` and `description` to 200 chars each to bound payload size.
   */
  writeStepMeta(data: {
    stepId: string;
    type: string;
    kind?: string;
    description: string;
    value?: string;
    targetText?: string;
    cssSelector?: string;
    iframeSelector?: string;
    /** Prompt for ai_check — surfaces "what was the AI asked to verify?" */
    assertionText?: string;
    hasCompiled: boolean;
    hasEvidence: boolean;
    isManual: boolean; // step added in editor (not from recording) — UUID id, no `rec_` prefix
    options?: Record<string, unknown>;
  }): void {
    // Redact `value` for `type` actions. We can't reliably tell whether the
    // recorded field is a password from this layer (no DOM access here), so
    // we err on the side of safety: type-action values are surfaced as
    // length+head only. For non-type actions value is usually a key name
    // ('Enter') or option text, safe to keep with a 200-char cap.
    let safeValue: string | undefined;
    if (typeof data.value === 'string') {
      if (data.type === 'type' || data.type === 'fill') {
        safeValue = `[redacted len=${data.value.length}]`;
      } else {
        safeValue = safeSlice(data.value, 200);
      }
    }
    // Same redaction policy for any value that crept into options.
    let safeOptions: Record<string, unknown> | undefined = data.options;
    if (safeOptions && typeof (safeOptions as { value?: unknown }).value === 'string'
        && (data.type === 'type' || data.type === 'fill')) {
      const v = (safeOptions as { value: string }).value;
      safeOptions = { ...safeOptions, value: `[redacted len=${v.length}]` };
    }
    this.writer.write({
      stage: 'step_meta',
      eventType: 'step_meta',
      payload: {
        ...data,
        description: typeof data.description === 'string' ? safeSlice(data.description, 200) : '',
        value: safeValue,
        targetText: typeof data.targetText === 'string' ? safeSlice(data.targetText, 200) : data.targetText,
        assertionText: typeof data.assertionText === 'string' ? safeSlice(data.assertionText, 500) : data.assertionText,
        options: safeOptions,
      },
    });
  }

  /**
   * Active modal / dialog / drawer currently mounted on the page when the
   * step starts. Without this we can't tell whether the click was supposed
   * to land on a backdrop or whether the step was added against a context
   * where the target is now obscured.
   */
  writePageModalState(data: {
    stepId?: string;
    activeModalRef?: string;
    activeModalText?: string;
    dialogCount: number;
    bodyChildCount: number;
    topZIndex?: number;
    hasOverlay?: boolean;
  }): void {
    this.writer.write({
      stage: 'page_state',
      eventType: 'page_modal_state',
      payload: {
        ...data,
        activeModalText: typeof data.activeModalText === 'string'
          ? safeSlice(data.activeModalText, 150) : data.activeModalText,
      },
    });
  }

  /**
   * Apply phase entry. Pair with writeApplyPhaseExit. Phases are nested
   * fine-grained checkpoints inside applyStep — answers "where did we hang?"
   * by showing the last entered phase that never exited.
   */
  writeApplyPhaseEntry(data: {
    stepId: string;
    phase: 'pre_wait' | 'compiled_resolve' | 'lint_resolve' | 'llm_call' | 'action_execute' | 'verify' | 'post_wait';
    note?: string;
  }): void {
    this.writer.write({
      stage: 'apply_phase',
      eventType: 'apply_phase_entry',
      payload: data,
    });
  }

  writeApplyPhaseExit(data: {
    stepId: string;
    phase: 'pre_wait' | 'compiled_resolve' | 'lint_resolve' | 'llm_call' | 'action_execute' | 'verify' | 'post_wait';
    durationMs: number;
    success: boolean;
    skipped?: boolean;
    skipReason?: string;
    note?: string;
  }): void {
    this.writer.write({
      stage: 'apply_phase',
      eventType: 'apply_phase_exit',
      payload: data,
    });
  }

  /**
   * LLM round-trip diagnostics. We never log prompt/response text (privacy +
   * size) — only the metadata that tells us "did the model time out, error,
   * or actually return something useful?".
   */
  writeLlmRequestStart(data: {
    stepId?: string;
    purpose: 'element_resolve' | 'diagnosis' | 'editor_action' | 'plan_repair' | 'other';
    model?: string;
    timeoutMs?: number;
    domNodesCount?: number;
    candidatesCount?: number;
  }): void {
    this.writer.write({
      stage: 'llm',
      eventType: 'llm_request_start',
      payload: data,
    });
  }

  writeLlmRequestEnd(data: {
    stepId?: string;
    purpose: 'element_resolve' | 'diagnosis' | 'editor_action' | 'plan_repair' | 'other';
    durationMs: number;
    success: boolean;
    timedOut?: boolean;
    promptTokens?: number;
    responseTokens?: number;
    chosenRef?: string;
    confidence?: number;
    errorReason?: string;
    cacheHit?: boolean;
    circuitOpen?: boolean;
    model?: string;
  }): void {
    this.writer.write({
      stage: 'llm',
      eventType: 'llm_request_end',
      payload: data,
    });
  }

  /**
   * Top-N resolver candidates emitted right before action_attempt. Lets us
   * see "weak step" cases — e.g. only 1 candidate at score 0.3 means the
   * step description doesn't match anything well, even if the action runs.
   */
  writeResolverCandidates(data: {
    stepId: string;
    source: 'compiled' | 'evidence' | 'lint' | 'clarification';
    totalCount: number;
    chosenRef?: string;
    chosenScore?: number;
    top3?: Array<{ ref: string; score?: number; role?: string; text?: string }>;
  }): void {
    this.writer.write({
      stage: 'resolution',
      eventType: 'resolver_candidates',
      payload: {
        ...data,
        top3: Array.isArray(data.top3)
          ? data.top3.slice(0, 3).map((c) => ({
              ref: c.ref,
              score: c.score,
              role: c.role,
              text: typeof c.text === 'string' ? safeSlice(c.text, 80) : c.text,
            }))
          : undefined,
      },
    });
  }

  /**
   * Evidence-cache shortcut audit. Today the cache hit/miss is invisible
   * — we don't know if a step ran via cache or via fresh resolution.
   */
  writeEvidenceShortcut(data: {
    stepId: string;
    hit: boolean;
    cachedRef?: string;
    reason?: string; // 'ttl_expired' | 'url_mismatch' | 'semantic_mismatch' | 'no_evidence' | 'ok' | ...
    detail?: Record<string, unknown>;
  }): void {
    this.writer.write({
      stage: 'resolution',
      eventType: 'evidence_shortcut',
      payload: data,
    });
  }

  /**
   * Compiled fast-path postcondition outcome. Today fingerprint_mismatch is
   * the only failure event — we can't tell whether expectsNavigation,
   * dom-mutation, or click-effect was the failing condition.
   */
  writeCompiledPostcondition(data: {
    stepId: string;
    expectsNavigation: boolean;
    urlChanged: boolean;
    domChanged?: boolean;
    clickEffectSignal?: 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'download' | 'none';
    accepted: boolean;
    reason?: string;
  }): void {
    this.writer.write({
      stage: 'resolution',
      eventType: 'compiled_postcondition',
      payload: data,
    });
  }

  /**
   * A swallowed exception in a hot path. Critical for diagnosing "everything
   * looks fine but step never executed" — silent catches are now visible.
   * Caller must keep `where` short and stable for grep-ability.
   */
  writeCaughtError(data: {
    where: string; // 'snapshot_collect.forEach' | 'verify.click_effect' | 'apply.lint' | ...
    stepId?: string;
    message: string;
    stack?: string;
    fatal?: boolean; // true = step failed because of this; false = retried/recovered
  }): void {
    this.writer.write({
      stage: 'error',
      eventType: 'caught_error',
      payload: {
        ...data,
        message: typeof data.message === 'string' ? safeSlice(data.message, 500) : '',
        stack: typeof data.stack === 'string' ? safeSlice(data.stack, 800) : data.stack,
      },
    });
  }

  /**
   * One-shot summary at end of Run. Replaces having to grep through 500
   * events to count passes / failures / LLM cost. Fields cumulative.
   */
  writeRunSummary(data: {
    previewSessionId: string;
    intentTestCaseId?: string;
    totalSteps: number;
    passed: number;
    failed: number;
    skipped: number;
    cancelled: boolean;
    timedOut: boolean;
    totalDurationMs: number;
    /** Aggregated by reader from compiled_postcondition events; emit only when measured. */
    compiledHits?: number;
    compiledMisses?: number;
    /** Aggregated by reader from llm_request_end events; emit only when measured. */
    llmCalls?: number;
    llmTotalDurationMs?: number;
    failedStepIds?: string[];
    failedStepReasons?: string[];
  }): void {
    this.writer.write({
      stage: 'run',
      eventType: 'run_summary',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HOVER HIGHLIGHT EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeHoverProbe(data: {
    x: number; y: number;
    /** Coordinates originally from mouse:move event (before latestX/Y update) */
    originalX?: number; originalY?: number;
    latencyMs: number;
    result: { tag: string; label: string; resolvedVia: string } | null;
    skipped?: string; // reason for skip (e.g. 'run_active', 'page_navigated', 'no_element', 'direct_hit', 'cross_origin_iframe', 'no_bbox')
    /** Number of mouse:move events skipped while probe was in-flight */
    skippedMoves?: number;
  }): void {
    this.writer.write({ stage: 'hover', eventType: 'hover_probe', payload: data });
  }

  writeHoverEmit(data: {
    element: { tag: string; label: string; boundingBox: Record<string, number> } | null;
    deduped: boolean; // true if emission was skipped due to same element
    /** WebSocket room the event was emitted to */
    room?: string;
  }): void {
    this.writer.write({ stage: 'hover', eventType: 'hover_emit', payload: data });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ERROR
  // ─────────────────────────────────────────────────────────────────────────

  writeError(error: string, context?: Record<string, any>): void {
    this.writer.write({
      stage: 'error',
      eventType: 'error',
      payload: { error, ...context },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MOBILE EDITOR EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Log a mobile lint request (user clicked "Find" in mobile editor).
   */
  writeMobileLintRequest(data: {
    description: string;
    actionType: string;
    sessionId: string;
  }): void {
    this.writer.write({
      stage: 'mobile_lint',
      eventType: 'mobile_lint_request',
      payload: data,
    });
  }

  /**
   * Log a mobile lint result — the most important event for debugging
   * "why didn't it find my element on the mobile screen?"
   *
   * Includes: description, resolution strategy, confidence, A11y candidates,
   * LLM usage, and final result.
   */
  writeMobileLintResult(data: {
    description: string;
    actionType: string;
    sessionId: string;
    latencyMs: number;
    result: {
      status: string;
      confidence?: number;
      resolvedVia?: string;
      elementText?: string;
      elementType?: string;
      boundingBox?: Record<string, number>;
      message?: string;
    };
  }): void {
    this.writer.write({
      stage: 'mobile_lint',
      eventType: 'mobile_lint_result',
      payload: data,
    });
  }

  /**
   * Log a mobile apply request (user clicked "Apply"/"Run step" in mobile editor).
   */
  writeMobileApplyRequest(data: {
    stepId: string;
    stepType: string;
    description: string;
    value?: string;
    sessionId: string;
  }): void {
    this.writer.write({
      stage: 'mobile_apply',
      eventType: 'mobile_apply_request',
      payload: data,
    });
  }

  /**
   * Log a mobile apply result.
   */
  writeMobileApplyResult(data: {
    stepId: string;
    sessionId: string;
    latencyMs: number;
    result: {
      success: boolean;
      error?: string;
      resolvedVia?: string;
      durationMs?: number;
    };
  }): void {
    this.writer.write({
      stage: 'mobile_apply',
      eventType: 'mobile_apply_result',
      payload: data,
    });
  }
}
