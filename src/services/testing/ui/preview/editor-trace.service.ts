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

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const EDITOR_LOGS_DIR = path.join(process.cwd(), 'test_logs', 'editor');
const EDITOR_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per editor session
const EDITOR_MAX_PAYLOAD_CHARS = 10_000;

/** Active writers indexed by previewSessionId */
const activeWriters = new Map<string, EditorTraceService>();

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

  /** Close and remove writer for a session */
  static async close(previewSessionId: string): Promise<void> {
    const instance = activeWriters.get(previewSessionId);
    if (instance) {
      activeWriters.delete(previewSessionId);
      await instance.writer.close();
    }
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
  // ERROR
  // ─────────────────────────────────────────────────────────────────────────

  writeError(error: string, context?: Record<string, any>): void {
    this.writer.write({
      stage: 'error',
      eventType: 'error',
      payload: { error, ...context },
    });
  }
}
