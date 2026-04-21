/**
 * KB retrieval telemetry
 *
 * Fire-and-forget logger: every call to `searchKB` emits an event here, we
 * async-insert it into `kb_retrieval_events`, and **we never block the user
 * request path**. If Supabase is slow or down, retrieval still returns
 * normally — we just drop the telemetry.
 *
 * Later, when the user reacts (👍 / 👎) on the assistant message that was
 * produced with these chunks, the feedback service calls `linkMessageToLastRetrieval`
 * to stamp the retrieval event with the message_id. That back-link is what
 * makes the `kb_dead_files` RPC work.
 */

import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

const MAX_QUERY_LEN = 500;
const MAX_CALL_SITE_LEN = 64;

export type RetrievalCallSite =
  | 'chat-general'
  | 'chat-command-enrich'
  | 'kb-skill'
  | 'kb-api-query'
  | 'jira-qa'
  | 'regression-doctor'
  | 'other';

export interface RetrievalEventInput {
  userId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  query: string;
  callSite: RetrievalCallSite;
  chunkIds: string[];
  sourceFiles: string[];
  globalCount: number;
  projectCount: number;
  latencyMs: number;
}

/**
 * In-process "last retrieval per session" cache. When the user later reacts
 * on a message, the feedback path can call `linkMessageToLastRetrieval` to
 * stamp the retrieval event with the message_id even if we didn't know the
 * message_id at search time.
 *
 * Entries auto-expire after 10 minutes to bound memory. Key = session_id.
 */
interface LastRetrievalEntry {
  eventId: string;
  createdAt: number;
}

const LAST_RETRIEVAL_TTL_MS = 10 * 60 * 1000;
const lastRetrievalBySession = new Map<string, LastRetrievalEntry>();

function pruneExpired(): void {
  const cutoff = Date.now() - LAST_RETRIEVAL_TTL_MS;
  for (const [sid, entry] of lastRetrievalBySession) {
    if (entry.createdAt < cutoff) {
      lastRetrievalBySession.delete(sid);
    }
  }
}

/**
 * Insert a retrieval event. Never throws — errors are logged and swallowed.
 * Returns the event_id synchronously (we generate client-side UUID so the
 * caller can tie it to a message later without awaiting the DB write).
 */
export function logRetrievalEvent(input: RetrievalEventInput): string {
  const eventId = randomUUID();

  // Validate and clamp inputs. Never throw — we must not break retrieval.
  const record = {
    event_id: eventId,
    user_id: sanitizeUuid(input.userId),
    session_id: sanitizeUuid(input.sessionId),
    project_id: sanitizeUuid(input.projectId),
    query: truncate(String(input.query ?? ''), MAX_QUERY_LEN),
    call_site: truncate(String(input.callSite ?? 'other'), MAX_CALL_SITE_LEN),
    chunk_ids: Array.isArray(input.chunkIds) ? input.chunkIds.filter((s) => typeof s === 'string') : [],
    source_files: Array.isArray(input.sourceFiles) ? input.sourceFiles.filter((s) => typeof s === 'string') : [],
    global_count: finiteIntOr0(input.globalCount),
    project_count: finiteIntOr0(input.projectCount),
    latency_ms: finiteIntOr0(input.latencyMs),
  };

  // Cache for late message_id binding
  if (record.session_id) {
    lastRetrievalBySession.set(record.session_id, {
      eventId,
      createdAt: Date.now(),
    });
    // Opportunistic cleanup — only walk the map occasionally
    if (Math.random() < 0.05) pruneExpired();
  }

  // Fire and forget — never await, never propagate errors.
  // Wrap in Promise.resolve() because Supabase builders return PromiseLike,
  // which has `.then` but not `.catch`.
  Promise.resolve(
    supabaseAdmin
      .from('kb_retrieval_events')
      .insert(record)
      .then((res) => {
        if (res.error) {
          logger.debug('[KB_TELEMETRY] insert failed (non-fatal)', {
            error: res.error.message,
            code: res.error.code,
          });
        }
      })
  ).catch((err: unknown) => {
    logger.debug('[KB_TELEMETRY] insert threw (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return eventId;
}

/**
 * Link an assistant message to the most recent retrieval event for a session.
 * Called from the chat path *after* the assistant message row is saved,
 * so feedback on that message can later be attributed to these chunks.
 */
export async function linkMessageToLastRetrieval(
  sessionId: string,
  messageId: string
): Promise<void> {
  if (!sessionId || !messageId) return;

  const entry = lastRetrievalBySession.get(sessionId);
  if (!entry) return;

  // One-shot: consume the entry so later messages don't re-link to the same event
  lastRetrievalBySession.delete(sessionId);

  try {
    const { error } = await supabaseAdmin
      .from('kb_retrieval_events')
      .update({ message_id: messageId })
      .eq('event_id', entry.eventId)
      .is('message_id', null); // only link if still unlinked

    if (error) {
      logger.debug('[KB_TELEMETRY] link update failed (non-fatal)', {
        error: error.message,
        code: error.code,
      });
    }
  } catch (err) {
    logger.debug('[KB_TELEMETRY] link threw (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeUuid(v: string | null | undefined): string | null {
  if (typeof v !== 'string' || !UUID_REGEX.test(v)) return null;
  return v;
}

function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

function finiteIntOr0(n: unknown): number {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}
