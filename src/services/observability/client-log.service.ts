import { logger } from '@/utils/core/logger';

/**
 * Re-emit client-reported failures (browser / desktop) through the backend
 * logger so they reach Loki — closing the gap where a frontend error (e.g. a
 * session-expiry the browser handled and swallowed) never left the client.
 *
 * The client is UNTRUSTED:
 *  - `userId` is forced from the authenticated request, never the body.
 *  - the event is namespaced `client.*` so it can never impersonate a
 *    server-side event (`session.expired`, `job.failed`, …).
 *  - `severity` / `source` are allowlisted; `event` is shape-validated.
 *  - `message` / `context` are size-capped (Loki ingest + Cloudflare-page guard).
 *  - the batch is capped server-side regardless of what the client sends.
 *
 * The backend cannot redact secrets it never resolved, so the client MUST NOT
 * put `secrets.*` values in `context` — that contract lives on the producer
 * side (frontend). Best-effort: a malformed entry is skipped, never thrown.
 */

const MAX_BATCH = 20;
const MAX_MESSAGE_CHARS = 1000;
const MAX_CONTEXT_BYTES = 4000;
const MAX_URL_CHARS = 500;
const EVENT_RE = /^[a-z0-9_.-]{1,64}$/i;
const ALLOWED_SEVERITY = new Set(['info', 'warning', 'error', 'critical']);
const ALLOWED_SOURCE = new Set(['web', 'desktop']);

export interface ClientLogEntry {
  event?: unknown;
  severity?: unknown;
  message?: unknown;
  context?: unknown;
  source?: unknown;
  url?: unknown;
}

export interface ClientLogContext {
  userId: string;
  requestId?: string;
}

export class ClientLogService {
  /** Validate, cap, and re-emit a batch of client log entries. Returns the
   *  count actually emitted. Never throws — telemetry must not fail the request. */
  static record(entries: ClientLogEntry[], ctx: ClientLogContext): { accepted: number } {
    const batch = Array.isArray(entries) ? entries.slice(0, MAX_BATCH) : [];
    let accepted = 0;

    for (const entry of batch) {
      try {
        const event = typeof entry.event === 'string' && EVENT_RE.test(entry.event)
          ? entry.event
          : 'unknown';
        const severity = typeof entry.severity === 'string' && ALLOWED_SEVERITY.has(entry.severity)
          ? entry.severity
          : 'error';
        const source = typeof entry.source === 'string' && ALLOWED_SOURCE.has(entry.source)
          ? entry.source
          : 'web';
        const message = typeof entry.message === 'string'
          ? entry.message.slice(0, MAX_MESSAGE_CHARS)
          : undefined;
        const url = typeof entry.url === 'string' ? entry.url.slice(0, MAX_URL_CHARS) : undefined;
        const context = capContext(entry.context);

        const payload = {
          event: `client.${event}`,
          severity,
          source,
          userId: ctx.userId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          ...(url ? { url } : {}),
          ...(message ? { message } : {}),
          ...(context ? { context } : {}),
        };

        // Level mirrors severity so error/critical land in error.log + Loki at
        // error; warnings stay at warn. The `severity` field is the queryable
        // discriminator for alerting either way.
        if (severity === 'error' || severity === 'critical') {
          logger.error('[CLIENT] reported failure', payload);
        } else {
          logger.warn('[CLIENT] reported failure', payload);
        }
        accepted++;
      } catch {
        /* best-effort: skip a malformed entry, never throw into the request */
      }
    }

    return { accepted };
  }
}

/** Pass small object contexts through; replace oversized ones with a bounded
 *  preview so one fat payload can't bloat a log line. */
function capContext(context: unknown): Record<string, unknown> | undefined {
  if (!context || typeof context !== 'object') return undefined;
  try {
    const json = JSON.stringify(context);
    if (json.length <= MAX_CONTEXT_BYTES) return context as Record<string, unknown>;
    return { _truncated: true, preview: json.slice(0, MAX_CONTEXT_BYTES) };
  } catch {
    return undefined; // circular / non-serializable
  }
}
