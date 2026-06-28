import { Request, Response } from 'express';
import { ClientLogService, type ClientLogEntry } from '@/services/observability/client-log.service';

/**
 * POST /api/v1/client-logs — ingest a small batch of client-reported failures
 * and re-emit them through the backend logger (→ Loki). HTTP only: parse, force
 * the server-derived identity, delegate to the service, respond. The service
 * owns validation / capping / namespacing.
 */
export async function ingestClientLogs(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const body = req.body as { logs?: unknown } | undefined;
  const entries: ClientLogEntry[] = Array.isArray(body?.logs) ? (body!.logs as ClientLogEntry[]) : [];

  const requestIdHeader = req.headers['x-request-id'];
  const { accepted } = ClientLogService.record(entries, {
    userId,
    requestId: typeof requestIdHeader === 'string' ? requestIdHeader : undefined,
  });

  res.status(202).json({ success: true, accepted });
}
