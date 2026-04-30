/**
 * In-memory ring buffer for AI action log entries.
 *
 * Replaces the previous Supabase `ai_action_logs` storage — entries now live
 * only in this buffer and are broadcast to the user over WebSocket. They
 * survive only as long as the API process runs.
 *
 * Cap: MAX_BUFFER_SIZE entries. Oldest evicted first.
 *
 * Cross-process: worker processes call `recordAILog` too; their entries
 * arrive at the API process via the existing `ai:log:new` WebSocket event
 * routed through Redis pub/sub. The API's redis-subscriber ingests those
 * into this same buffer (`pushExisting`) so the GET endpoint backfill
 * sees a unified view.
 */

import { randomUUID } from 'node:crypto';

const MAX_BUFFER_SIZE = 500;

export type AILogSource =
  | 'chat'
  | 'analysis'
  | 'explorer-web'
  | 'explorer-mobile'
  | 'ai-selector'
  | 'ai-check'
  | 'form-filler';

export type AILogEntityType =
  | 'regression_run'
  | 'test_execution'
  | 'chat_session'
  | 'exploration_run'
  | 'mobile_run';

export interface AIActionEntry {
  id: string;
  created_at: string;
  user_id: string;
  workspace_id: string | null;
  source: AILogSource | string;
  action_type: string;
  status: 'succeeded' | 'failed';
  summary: string;
  detail: Record<string, unknown>;
  entity_type: AILogEntityType | string | null;
  entity_id: string | null;
  iteration: number | null;
  duration_ms: number | null;
  model: string | null;
  provider: 'openai' | 'gemini' | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  error: string | null;
}

class AILogBuffer {
  private entries: AIActionEntry[] = [];
  private seen = new Set<string>(); // dedupe across cross-process redelivery

  /** Push a freshly-created entry; assigns id + created_at and returns the stored row. */
  push(input: Omit<AIActionEntry, 'id' | 'created_at'>): AIActionEntry {
    const stored: AIActionEntry = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      ...input,
    };
    this.commit(stored);
    return stored;
  }

  /**
   * Push an entry that already has its `id` / `created_at` set — used when
   * the API process ingests a row produced by another process via Redis
   * pub/sub. Idempotent: redelivered messages are dropped.
   */
  pushExisting(entry: AIActionEntry): void {
    if (this.seen.has(entry.id)) return;
    this.commit(entry);
  }

  private commit(entry: AIActionEntry): void {
    this.seen.add(entry.id);
    this.entries.push(entry);
    if (this.entries.length > MAX_BUFFER_SIZE) {
      const dropped = this.entries.splice(0, this.entries.length - MAX_BUFFER_SIZE);
      for (const d of dropped) this.seen.delete(d.id);
    }
  }

  /**
   * Newest-first scan, returning rows that match `userId` + optional filters.
   */
  query(opts: {
    userId: string;
    source?: string;
    status?: string;
    entityType?: string;
    entityId?: string;
    q?: string;
    limit?: number;
  }): AIActionEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const search = opts.q?.toLowerCase();
    const out: AIActionEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.user_id !== opts.userId) continue;
      if (opts.source && e.source !== opts.source) continue;
      if (opts.status && e.status !== opts.status) continue;
      if (opts.entityType && e.entity_type !== opts.entityType) continue;
      if (opts.entityId && e.entity_id !== opts.entityId) continue;
      if (search && !e.summary.toLowerCase().includes(search)) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  size(): number {
    return this.entries.length;
  }
}

export const aiLogBuffer = new AILogBuffer();
