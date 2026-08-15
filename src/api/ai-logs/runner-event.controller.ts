import { env } from '@/config/environment/env';
import { aiLogBuffer } from '@/services/ai/logging/ai-log-buffer';
import { normaliseRunnerEvent } from '@/services/ai/logging/runner-ai-log.service';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { Request, Response } from 'express';

/**
 * POST /api/v1/ai-logs/runner-event
 *
 * Mobile runner ingest endpoint. The runner POSTs one record per LLM call it
 * makes (explorer plan, form-filler, screen-understander, ai-check). Auth via
 * the shared MOBILE_RUNNER_API_KEY header — keeping any DB credentials off
 * the runner.
 *
 * Storage: in-memory ring buffer + WebSocket broadcast, and (via the buffer)
 * the durable per-session cost ledger.
 *
 * Cost is NOT taken from the request. The runner never sent it, and this
 * endpoint authenticates with one shared key, so body-supplied numbers are not
 * a trustworthy basis for accounting. `normaliseRunnerEvent` derives cost from
 * (provider, model, tokens) using the backend's own pricing table and clamps
 * the numerics.
 *
 * KNOWN GAP: `user_id` / `workspace_id` are still taken verbatim and not checked
 * against real membership. A per-event membership lookup would add a DB read to
 * a per-LLM-call hot path, so it needs a cache rather than a naive query — see
 * Gap C in .claude/plans/20260813-cost-attribution-instrumentation.md.
 */
export const ingestRunnerEvent = async (req: Request, res: Response): Promise<void> => {
  const provided = (req.headers['x-runner-key'] || req.headers['authorization'] || '') as string;
  const expected = env.MOBILE_RUNNER_API_KEY;

  if (!expected) {
    logger.warn('[AI_LOGS_RUNNER] MOBILE_RUNNER_API_KEY not configured — rejecting');
    res.status(503).json({ success: false, error: 'Runner ingest not configured' });
    return;
  }
  // Authorization header may be `Bearer xxx`; tolerate both forms.
  const presented = provided.replace(/^Bearer\s+/i, '');
  if (presented !== expected) {
    res.status(401).json({ success: false, error: 'Invalid runner key' });
    return;
  }

  const body = req.body ?? {};
  const required = ['user_id', 'source', 'action_type', 'status', 'summary'] as const;
  for (const k of required) {
    if (!body[k] || typeof body[k] !== 'string') {
      res.status(400).json({ success: false, error: `Missing or invalid field: ${k}` });
      return;
    }
  }
  if (body.status !== 'succeeded' && body.status !== 'failed') {
    res.status(400).json({ success: false, error: 'status must be succeeded|failed' });
    return;
  }

  const stored = aiLogBuffer.push({
    user_id: body.user_id,
    workspace_id: body.workspace_id ?? null,
    source: body.source,
    action_type: body.action_type,
    status: body.status,
    summary: String(body.summary).slice(0, 500),
    detail: body.detail ?? {},
    entity_type: body.entity_type ?? null,
    entity_id: body.entity_id ?? null,
    iteration: typeof body.iteration === 'number' ? body.iteration : null,
    // Cost, tokens and duration are derived and clamped server-side rather than
    // taken from the body — the runner does not send cost at all, and a shared
    // API key means the numbers are not trustworthy input for an accounting
    // ledger. See runner-ai-log.service.ts.
    ...normaliseRunnerEvent(body),
    error: body.error ?? null,
  });

  try {
    webSocketService.emitToUser(stored.user_id, 'ai:log:new', stored);
  } catch (wsErr) {
    logger.warn('[AI_LOGS_RUNNER] WS publish failed', {
      error: wsErr instanceof Error ? wsErr.message : String(wsErr),
    });
  }

  res.json({ success: true, id: stored.id });
};
