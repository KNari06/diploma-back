/**
 * Chat-Test Trace Service
 *
 * JSONL trace logging for the PER-TEST-CASE chat ("AI Agent inside a test
 * case"). Captures the full request → reasoning → tool → response cycle so a
 * post-hoc analysis can answer: what the user asked, what page context the
 * agent saw, what it classified, which tools it ran with what args/results,
 * and what it finally replied. Mirrors EditorTraceService but is scoped to the
 * chat surface, not the preview-session recorder.
 *
 * Writes to test_logs/chat_test/ (one file per chat session).
 *
 * Usage:
 *   const trace = ChatTestTraceService.getOrCreate(chatSessionId, userId, testCaseId);
 *   trace.writeRequest({ message, mode, ... });
 *   trace.writeIntent({ intent, confidence });
 *   trace.writePageContext({ url, elementCount, ... });
 *   trace.writeToolCall({ toolName, args, result });
 *   trace.writeResponse({ content, ... });
 *   await ChatTestTraceService.close(chatSessionId);
 *
 * Reading:
 *   cat test_logs/chat_test/*.jsonl | jq 'select(.eventType == "tool_call")'
 */

import { LiteTraceWriter } from '@/agent/core/lite/trace/lite-trace-writer';
import { logger } from '@/utils/core/logger';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const CHAT_TEST_LOGS_DIR = path.join(process.cwd(), 'test_logs', 'chat_test');
const CHAT_TEST_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per chat session
const CHAT_TEST_MAX_PAYLOAD_CHARS = 12_000;

/** Active writers keyed by chatSessionId — one trace file per chat session. */
const activeWriters = new Map<string, ChatTestTraceService>();

/**
 * Idle TTL after which an inactive session's writer is evicted + closed.
 * The chat path has no explicit "session end" hook, so we sweep lazily on
 * each getOrCreate to bound the Map (and open writers) instead of leaking
 * one entry per chatSessionId for the lifetime of the process.
 */
const WRITER_IDLE_TTL_MS = 30 * 60 * 1000; // 30 min

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ChatTestTraceService {
  private writer: LiteTraceWriter;
  private chatSessionId: string;
  private userId: string;
  private testCaseId?: string;
  private lastUsedMs: number = Date.now();

  private constructor(chatSessionId: string, userId: string, testCaseId?: string) {
    this.chatSessionId = chatSessionId;
    this.userId = userId;
    this.testCaseId = testCaseId;
    this.writer = new LiteTraceWriter({
      testId: `chat_test_${chatSessionId}`,
      logsDir: CHAT_TEST_LOGS_DIR,
      maxFileSizeBytes: CHAT_TEST_MAX_FILE_SIZE,
      maxPayloadChars: CHAT_TEST_MAX_PAYLOAD_CHARS,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATIC LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  /** Get or create a trace writer for a test-case chat session. */
  static getOrCreate(
    chatSessionId: string,
    userId: string,
    testCaseId?: string,
  ): ChatTestTraceService {
    ChatTestTraceService.sweepIdle();
    let instance = activeWriters.get(chatSessionId);
    if (!instance) {
      instance = new ChatTestTraceService(chatSessionId, userId, testCaseId);
      activeWriters.set(chatSessionId, instance);
    } else if (testCaseId && !instance.testCaseId) {
      // Late-bind testCaseId if the first event didn't carry it.
      instance.testCaseId = testCaseId;
    }
    instance.lastUsedMs = Date.now();
    return instance;
  }

  /**
   * Lazy eviction: close + drop writers idle longer than the TTL. Called on
   * every getOrCreate so the Map (and open writers) stay bounded without a
   * background timer. Bounded work — the Map is small in practice.
   */
  private static sweepIdle(): void {
    const now = Date.now();
    for (const [sid, inst] of activeWriters) {
      if (now - inst.lastUsedMs > WRITER_IDLE_TTL_MS) {
        activeWriters.delete(sid);
        // Fire-and-forget close — never block or throw the hot path.
        inst.writer.close().catch(() => { /* best-effort */ });
      }
    }
  }

  /** Get existing writer (returns null if none active). */
  static get(chatSessionId: string): ChatTestTraceService | null {
    return activeWriters.get(chatSessionId) ?? null;
  }

  /** Close and remove the writer for a chat session. */
  static async close(chatSessionId: string): Promise<void> {
    const instance = activeWriters.get(chatSessionId);
    if (!instance) return;
    activeWriters.delete(chatSessionId);
    try {
      await instance.writer.close();
    } catch (err) {
      logger.debug('[CHAT_TEST_TRACE] close failed (non-critical)', {
        chatSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EVENTS — every write is best-effort and MUST NOT throw into the chat path.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Self-contained scrub for values the LiteTraceWriter's key-name redactor
   * misses: generic keys like `value` / `message` whose CONTENT may carry a
   * secret. We cannot reach the preview session's runVariables here, so we
   * mask by shape: `{{secrets.*}}` placeholders and obvious inline
   * credential tokens. Defense-in-depth on top of the writer's key redaction.
   */
  private static scrubValue(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    return value
      // Mask resolved/placeholder secret references.
      .replace(/\{\{\s*secrets\.[^}]+\}\}/gi, '[SECRET]')
      // Mask "password: xxx" / "пароль xxx" style inline credentials.
      .replace(/\b(password|passwd|pwd|пароль|secret|token|otp|api[_-]?key)\b\s*[:=]?\s*\S+/gi, '$1 [REDACTED]');
  }

  private static scrubDeep(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = ChatTestTraceService.scrubDeep(v as Record<string, unknown>);
      } else if (Array.isArray(v)) {
        out[k] = v.map((item) =>
          item && typeof item === 'object'
            ? ChatTestTraceService.scrubDeep(item as Record<string, unknown>)
            : ChatTestTraceService.scrubValue(item),
        );
      } else {
        out[k] = ChatTestTraceService.scrubValue(v);
      }
    }
    return out;
  }

  private safeWrite(stage: string, eventType: string, payload: Record<string, unknown>): void {
    try {
      // Scrub secret-shaped content (placeholders / inline credentials) in
      // generic-keyed values BEFORE writing — the writer's redactor only
      // masks by sensitive KEY name, not by value content.
      const scrubbed = ChatTestTraceService.scrubDeep(payload);
      this.writer.write({
        stage,
        eventType,
        payload: { chatSessionId: this.chatSessionId, testCaseId: this.testCaseId, ...scrubbed },
      });
    } catch (err) {
      logger.debug('[CHAT_TEST_TRACE] write failed (non-critical)', {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Inbound chat request — what the user asked and the situational flags. */
  writeRequest(data: {
    message: string;
    mode?: string;
    previewSessionId?: string;
    mobileSessionId?: string;
    projectId?: string;
    projectName?: string;
    testCaseName?: string;
    historyLength?: number;
  }): void {
    this.safeWrite('request', 'chat_request', { userId: this.userId, ...data });
  }

  /** Classified intent (post-guard — the intent that actually routes). */
  writeIntent(data: {
    intent: string;
    confidence?: number;
    rawIntent?: string;
    blockedBy?: string;
    routingSource?: string;
  }): void {
    this.safeWrite('intent', 'intent_classified', data);
  }

  /** Snapshot of the live page/screen context the agent was given. */
  writePageContext(data: {
    available: boolean;
    url?: string;
    elementCount?: number;
    pageTextChars?: number;
    hasConsole?: boolean;
    hasNetwork?: boolean;
    reason?: string;
  }): void {
    this.safeWrite('context', 'page_context', data);
  }

  /** Tools collected for this turn (inventory the model could call). */
  writeToolsAvailable(toolNames: string[]): void {
    this.safeWrite('context', 'tools_available', {
      count: toolNames.length,
      toolNames,
    });
  }

  /** One tool invocation — args in, result out. */
  writeToolCall(data: {
    toolName: string;
    args?: Record<string, unknown>;
    success?: boolean;
    resultSummary?: string;
    error?: string;
    durationMs?: number;
  }): void {
    this.safeWrite('execution', 'tool_call', data);
  }

  /** A generated/edited test step set (the plan shown to / run for the user). */
  writeSteps(data: {
    source: 'generated' | 'run' | 'saved' | 'updated';
    stepCount: number;
    steps?: Array<{ type?: string; description?: string }>;
    startUrl?: string;
  }): void {
    this.safeWrite('execution', 'test_steps', data);
  }

  /** Final assistant reply for this turn. */
  writeResponse(data: {
    content?: string;
    intent?: string;
    needsClarification?: boolean;
    pipelinePath?: string;
    toolsUsed?: number;
    durationMs?: number;
    error?: string;
  }): void {
    this.safeWrite('response', 'chat_response', data);
  }

  /** Catch-all for anything else worth analysing later. */
  writeEvent(eventType: string, payload: Record<string, unknown>): void {
    this.safeWrite('misc', eventType, payload);
  }
}
