/**
 * TaskTrackerProvider — the seam that lets any task tracker plug into QAIT.
 *
 * Each tracker (Jira, Linear, …) implements this; consumers (Bug board, QA
 * orchestrator, feedback, webhook) call the interface via TrackerRegistry
 * instead of Jira-specific services. The AI/assessment core stays untouched —
 * it already works on neutral inputs.
 *
 * Every method is auth-scoped by an opaque `TrackerAuth` the caller resolves
 * from the stored token (provider decides how to use accessToken/externalId).
 * Methods that a provider can't support are gated by `capabilities` — callers
 * check the flag before calling (graceful degradation, audit cases 22/23).
 */

import type {
  Board,
  Column,
  Task,
  TaskRelatedContext,
  TaskStatus,
  TrackerAuthResult,
  TrackerCapabilities,
  TrackerProvider,
  TrackerWebhookEvent,
} from '@/types/tracker.types';

/** Opaque auth context a provider needs for API calls (resolved from the stored token). */
export interface TrackerAuth {
  accessToken: string;
  externalId?: string;   // cloud_id / workspace / team — provider-native
  externalUrl?: string;
}

export interface TaskTrackerProvider {
  readonly provider: TrackerProvider;
  readonly capabilities: TrackerCapabilities;

  // ── OAuth ────────────────────────────────────────────────────────────────
  /** Build the provider's OAuth authorize URL for the given state. */
  buildAuthUrl(state: string): string;
  /** Exchange an OAuth code for tokens + the provider-native workspace/site id(s). */
  exchangeCode(code: string): Promise<TrackerAuthResult[]>;

  // ── Board / tasks (read) ───────────────────────────────────────────────────
  listBoards(auth: TrackerAuth): Promise<Board[]>;
  listColumns(auth: TrackerAuth, boardRef: string): Promise<Column[]>;
  listTasks(auth: TrackerAuth, opts: { boardRef?: string; projectRef?: string; limit?: number; offset?: number }):
    Promise<{ tasks: Task[]; columns: Column[]; total: number }>;
  getTask(auth: TrackerAuth, taskKey: string): Promise<Task>;
  getRelatedContext(auth: TrackerAuth, taskKey: string): Promise<TaskRelatedContext>;
  /** The project/team's statuses (id+name+category) for the trigger-status picker. */
  listStatuses(auth: TrackerAuth, projectRef: string): Promise<TaskStatus[]>;

  // ── Write-back ─────────────────────────────────────────────────────────────
  /** Post a comment (no-op-safe if !capabilities.hasComments). */
  addComment(auth: TrackerAuth, taskKey: string, body: string): Promise<void>;
  /** Move a task to a status by id or name (no-op-safe if !capabilities.hasStatusWrite). */
  setStatus(auth: TrackerAuth, taskKey: string, status: { id?: string; name?: string }): Promise<void>;

  // ── Webhook ────────────────────────────────────────────────────────────────
  /** Verify an inbound webhook is authentic (URL secret / header HMAC — provider-specific). */
  verifyWebhook(input: { rawBody: string; headers: Record<string, string | undefined>; query: Record<string, unknown>; expectedSecret?: string }): boolean;
  /** Parse a raw webhook payload into a neutral event (null if not a relevant event). */
  parseWebhook(payload: unknown): TrackerWebhookEvent | null;
}
