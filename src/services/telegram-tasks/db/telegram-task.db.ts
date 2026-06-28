import { supabaseAdmin } from '@/db/supabase';
import type { ProgressState } from '../telegram-task-ai.service';

/**
 * db/ sublayer for QAIT Tasker (telegram_tasks / telegram_messages).
 * Pure Supabase reads/writes — no business logic. The service builds the
 * intent; this maps it to queries and rows. Service-role client → bypasses RLS.
 */

export interface TelegramTaskRow {
  id: string;
  chat_id: number;
  project: string | null;
  title: string;
  owner: string | null;
  status: 'open' | 'closed' | 'expired';
  progress: 'none' | ProgressState;
  progress_note: string | null;
  source_msg_id: number | null;
  created_at: string;
  last_activity_at: string;
  last_batch_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  due_at: string | null;
  due_text: string | null;
  awaiting_deadline_msg_id: number | null;
}

const TASK_COLS =
  'id, chat_id, project, title, owner, status, progress, progress_note, source_msg_id, created_at, last_activity_at, last_batch_at, closed_at, closed_reason, due_at, due_text, awaiting_deadline_msg_id';

// ── messages ─────────────────────────────────────────────────────────────────

/** Insert a logged message; returns its row id (for the strictly-before window). */
export async function logMessage(
  chatId: number,
  tgMsgId: number | undefined,
  author: string | undefined,
  text: string,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from('telegram_messages')
    // Defensive cap: Telegram messages top out ~4096 chars, but never trust the
    // wire — keep one fat payload from bloating a row.
    .insert({ chat_id: chatId, tg_msg_id: tgMsgId ?? null, author: author ?? null, text: text.slice(0, 8000) })
    .select('id')
    .single();
  if (error) return null;
  return (data as { id: number }).id;
}

/** Last N messages in a chat with id < beforeId, returned oldest-first. */
export async function recentMessages(
  chatId: number,
  limit: number,
  beforeId: number,
): Promise<Array<{ author: string | null; text: string }>> {
  const { data, error } = await supabaseAdmin
    .from('telegram_messages')
    .select('author, text')
    .eq('chat_id', chatId)
    .lt('id', beforeId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as Array<{ author: string | null; text: string }>).reverse();
}

/** Messages in a chat since an ISO timestamp, oldest-first (batch lookback). */
export async function messagesSince(
  chatId: number,
  sinceIso: string,
): Promise<Array<{ author: string | null; text: string }>> {
  const { data, error } = await supabaseAdmin
    .from('telegram_messages')
    .select('author, text')
    .eq('chat_id', chatId)
    .gte('created_at', sinceIso)
    .order('id', { ascending: true });
  if (error || !data) return [];
  return data as Array<{ author: string | null; text: string }>;
}

/** Delete message rows older than the cutoff. Returns rows removed. */
export async function pruneMessages(cutoffIso: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('telegram_messages')
    .delete()
    .lt('created_at', cutoffIso)
    .select('id');
  if (error || !data) return 0;
  return data.length;
}

// ── tasks ────────────────────────────────────────────────────────────────────

export async function createTask(t: {
  chatId: number;
  project: string | null;
  title: string;
  owner: string | null;
  sourceMsgId: number | undefined;
}): Promise<TelegramTaskRow | null> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .insert({
      chat_id: t.chatId,
      project: t.project,
      title: t.title,
      owner: t.owner,
      source_msg_id: t.sourceMsgId ?? null,
    })
    .select(TASK_COLS)
    .single();
  if (error || !data) return null;
  return data as TelegramTaskRow;
}

export async function getTask(id: string): Promise<TelegramTaskRow | null> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select(TASK_COLS)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return data as TelegramTaskRow;
}

export async function openTasks(chatId: number): Promise<TelegramTaskRow[]> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select(TASK_COLS)
    .eq('chat_id', chatId)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return data as TelegramTaskRow[];
}

/** Most-recently-active open tasks (bounds the per-message prompt). */
export async function recentOpenTasks(chatId: number, limit: number): Promise<TelegramTaskRow[]> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select(TASK_COLS)
    .eq('chat_id', chatId)
    .eq('status', 'open')
    .order('last_activity_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as TelegramTaskRow[];
}

export async function countOpenTasks(chatId: number): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId)
    .eq('status', 'open');
  if (error || count == null) return 0;
  return count;
}

/** Open task ids whose source message is the given Telegram message id. */
export async function openTaskIdsBySourceMsg(chatId: number, tgMsgId: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select('id')
    .eq('chat_id', chatId)
    .eq('source_msg_id', tgMsgId)
    .eq('status', 'open');
  if (error || !data) return [];
  return (data as Array<{ id: string }>).map((r) => r.id);
}

export async function updateTask(
  id: string,
  patch: { project?: string | null; title?: string; owner?: string | null },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.project !== undefined) set.project = patch.project;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.owner !== undefined) set.owner = patch.owner;
  if (Object.keys(set).length === 0) return;
  await supabaseAdmin.from('telegram_tasks').update(set).eq('id', id);
}

export async function touchActivity(id: string): Promise<void> {
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', id);
}

export async function setProgress(id: string, progress: ProgressState, note: string | null): Promise<void> {
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ progress, progress_note: note ? note.slice(0, 500) : null, last_activity_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'open');
}

/** Mark a task as awaiting a deadline answer (the bot's "when?" question id). */
export async function setAwaitingDeadline(id: string, questionMsgId: number): Promise<void> {
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ awaiting_deadline_msg_id: questionMsgId, progress: 'in_progress', last_activity_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'open');
}

/** Record a deadline (parsed + original words); clears the awaiting flag and
 *  marks in_progress (a stated deadline implies work is underway). */
export async function setDeadline(id: string, dueText: string, dueAt: string | null): Promise<void> {
  await supabaseAdmin
    .from('telegram_tasks')
    .update({
      due_text: dueText.slice(0, 200),
      due_at: dueAt,
      awaiting_deadline_msg_id: null,
      progress: 'in_progress',
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'open');
}

/** Find an open task in this chat whose pending "when?" question is `questionMsgId`
 *  — i.e. the user replied to the bot's deadline question. Deterministic link. */
export async function findTaskAwaitingDeadline(chatId: number, questionMsgId: number): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select('id')
    .eq('chat_id', chatId)
    .eq('awaiting_deadline_msg_id', questionMsgId)
    .eq('status', 'open')
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

export async function closeTask(id: string, reason: string): Promise<void> {
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ status: 'closed', closed_at: new Date().toISOString(), closed_reason: reason.slice(0, 500) })
    .eq('id', id)
    .eq('status', 'open');
}

export async function reopenTask(id: string): Promise<void> {
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ status: 'open', closed_at: null, closed_reason: null, last_activity_at: new Date().toISOString() })
    .eq('id', id);
}

export async function markBatched(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ last_batch_at: new Date().toISOString() })
    .in('id', ids);
}

/** Auto-archive open tasks with no activity since the cutoff. Returns count. */
export async function expireStaleOpenTasks(cutoffIso: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .update({ status: 'expired', closed_at: new Date().toISOString(), closed_reason: 'auto-expired (no activity)' })
    .eq('status', 'open')
    .lte('last_activity_at', cutoffIso)
    .select('id');
  if (error || !data) return 0;
  return data.length;
}

/** Distinct chat ids that have any tasks OR messages — what the batch sweeps. */
export async function allKnownChats(): Promise<number[]> {
  const [tasks, msgs] = await Promise.all([
    supabaseAdmin.from('telegram_tasks').select('chat_id'),
    supabaseAdmin.from('telegram_messages').select('chat_id'),
  ]);
  const set = new Set<number>();
  for (const r of (tasks.data as Array<{ chat_id: number }> | null) ?? []) set.add(r.chat_id);
  for (const r of (msgs.data as Array<{ chat_id: number }> | null) ?? []) set.add(r.chat_id);
  return [...set];
}
