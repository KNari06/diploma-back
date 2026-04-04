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
        sample: entry.evidence.slice(0, 120),
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

  writeRecordingStop(reason: 'user' | 'disconnect'): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'recording_stop',
      payload: { previewSessionId: this.previewSessionId, reason },
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
      text: n.text ? n.text.slice(0, 60) : undefined,
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
          prompt: data.result._llmTrace.prompt.slice(0, 2000),
          response: data.result._llmTrace.response.slice(0, 500),
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
