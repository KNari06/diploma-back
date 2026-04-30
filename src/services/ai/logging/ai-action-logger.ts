/**
 * AI Action Logger
 *
 * Records every LLM call into the in-memory `aiLogBuffer` and broadcasts the
 * new row to the owning user over WebSocket so the frontend FAB / modal can
 * live-tail it. Entries are NOT persisted to a database — they live only as
 * long as the API process runs.
 *
 * Hook point: called from openai.service.ts and gemini.service.ts adjacent to
 * `AIUsageTracker.record()` — the canonical observability seam in this codebase.
 *
 * Logging MUST NEVER break AI flow: every code path here swallows errors and
 * reports them via Winston only.
 */

import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import {
  type AILogEntityType,
  type AILogSource,
  type AITrackingContext,
  deriveLogEntity,
  deriveLogSource,
  getAIContext,
} from '../tracking/ai-context';
import { aiLogBuffer, type AIActionEntry } from './ai-log-buffer';

/** Hard truncation cap for any string we store in `detail` to keep rows light. */
const MAX_FIELD_CHARS = 4_000;

interface RecordAILogInput {
  status: 'succeeded' | 'failed';
  provider: 'openai' | 'gemini';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs?: number;
  /** Free-form structured detail. Strings >MAX_FIELD_CHARS are truncated. */
  detail?: Record<string, unknown>;
  /** Error message when status === 'failed'. */
  error?: string;
  /** Override summary; otherwise we synthesise one from source/action/model. */
  summary?: string;
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return value.slice(0, MAX_FIELD_CHARS) + '…[truncated]';
  }
  return value;
}

function sanitiseDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    out[k] = truncate(v);
  }
  return out;
}

function synthesiseSummary(
  source: AILogSource,
  actionType: string,
  ctx: AITrackingContext | undefined,
  model: string,
  status: 'succeeded' | 'failed'
): string {
  const entityFragment = ctx?.logEntityId ? ` ${ctx.logEntityType ?? 'entity'}=${ctx.logEntityId}` : '';
  const iterFragment = typeof ctx?.logIteration === 'number' ? ` iter=${ctx.logIteration}` : '';
  const statusFragment = status === 'failed' ? ' ✗' : '';
  return `${source} :: ${actionType}${iterFragment}${entityFragment}${statusFragment} (${model})`;
}

let _skipCount = 0;
let _successCount = 0;

/**
 * Record one AI call. Reads source/action/entity/iteration from the active
 * AITrackingContext (set via withAIContext + withAILogFields).
 *
 * Synchronous: pushes to the buffer immediately and fires-and-forgets the WS
 * emit. Never throws.
 */
export function recordAILog(input: RecordAILogInput): void {
  const ctx = getAIContext();
  if (!ctx?.userId) {
    _skipCount += 1;
    const level = _skipCount <= 10 ? 'info' : 'debug';
    logger[level]('[AI_LOG] Skipping AI log (no userId in AITrackingContext)', {
      provider: input.provider,
      model: input.model,
      hint: 'Wrap the AI call site in withAIContext({ workspaceId, userId, ... }) so the call is attributable.',
      totalSkipped: _skipCount,
    });
    return;
  }

  const source = deriveLogSource(ctx);
  const actionType = ctx.logActionType ?? 'call';
  const { entityType, entityId } = deriveLogEntity(ctx);
  const iteration = typeof ctx.logIteration === 'number' ? ctx.logIteration : null;

  const summary = input.summary
    ? input.summary.slice(0, 500)
    : synthesiseSummary(source, actionType, ctx, input.model, input.status);

  let stored: AIActionEntry;
  try {
    stored = aiLogBuffer.push({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId ?? null,
      source,
      action_type: actionType,
      status: input.status,
      summary,
      detail: sanitiseDetail(input.detail),
      entity_type: (entityType as AILogEntityType | undefined) ?? null,
      entity_id: entityId ?? null,
      iteration,
      duration_ms: input.durationMs ?? null,
      model: input.model,
      provider: input.provider,
      tokens_in: input.inputTokens,
      tokens_out: input.outputTokens,
      cost_usd: input.costUSD,
      error: input.error ?? null,
    });
  } catch (err) {
    logger.error('[AI_LOG] Buffer push threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  _successCount += 1;
  if (_successCount <= 5 || _successCount % 50 === 0) {
    logger.info('[AI_LOG] Recorded', {
      id: stored.id,
      source: stored.source,
      action_type: stored.action_type,
      status: stored.status,
      totalRecorded: _successCount,
    });
  }

  // Broadcast to the owning user. emitToUser falls back to Redis pub/sub
  // when called from a worker process — handled transparently.
  try {
    webSocketService.emitToUser(stored.user_id, 'ai:log:new', stored);
  } catch (err) {
    logger.warn('[AI_LOG] WebSocket publish failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
