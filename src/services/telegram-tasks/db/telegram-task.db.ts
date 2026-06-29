import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { Lifecycle } from '../telegram-task-ai.service';

/**
 * db/ sublayer for QAIT Tasker (telegram_tasks / telegram_messages).
 * Pure Supabase reads/writes — no business logic. The service builds the
 * intent; this maps it to queries and rows. Service-role client → bypasses RLS.
 */

/** Apply a forum-topic filter to a query: an exact topic id, or IS NULL for the
 *  General topic. Centralizes the eq-vs-is split so every topic-scoped read is
 *  consistent. `q` is a Supabase filter builder (typed `any` — its generic type
 *  is too deep for the compiler; call sites stay typed). */
function byThread(q: any, threadId: number | null): any {
  return threadId == null ? q.is('thread_id', null) : q.eq('thread_id', threadId);
}

export interface TelegramTaskRow {
  id: string;
  chat_id: number;
  thread_id: number | null;
  project: string | null;
  title: string;
  owner_handle: string | null; // canonical @handle (normalized) — used for @mention / "tasks for X"
  owner_display: string | null; // raw owner words as written (e.g. a bare name "Serzhan")
  lifecycle: Lifecycle; // single state — replaces the old status+progress pair
  progress_note: string | null;
  source_msg_id: number | null;
  digest_line_index: number | null; // which line of source_msg created this task (per-line anchor)
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
  'id, chat_id, thread_id, project, title, owner_handle, owner_display, lifecycle, progress_note, source_msg_id, digest_line_index, created_at, last_activity_at, last_batch_at, closed_at, closed_reason, due_at, due_text, awaiting_deadline_msg_id';

/** Lifecycle states a task is in (exactly one). `done`/`expired` are terminal.
 *  `expired` = auto-archived for inactivity; `done` = genuinely completed. */
const ACTIVE_LIFECYCLES = ['open', 'in_progress', 'blocked'] as const;

/** Old status/progress columns still exist during the deploy dual-write window.
 *  Derive them from `lifecycle` so an overlapping old-code instance stays sane.
 *  Dropped in a follow-up migration once new code is fully rolled out. */
function legacyStatusProgress(lifecycle: Lifecycle): { status: string; progress: string } {
  if (lifecycle === 'done') return { status: 'closed', progress: 'none' };
  if (lifecycle === 'expired') return { status: 'expired', progress: 'none' };
  if (lifecycle === 'in_progress') return { status: 'open', progress: 'in_progress' };
  if (lifecycle === 'blocked') return { status: 'open', progress: 'blocked' };
  return { status: 'open', progress: 'none' }; // open
}

// ── messages ─────────────────────────────────────────────────────────────────

/** Insert a logged message; returns its row id (for the strictly-before window). */
export async function logMessage(
  chatId: number,
  tgMsgId: number | undefined,
  author: string | undefined,
  text: string,
  threadId: number | null,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from('telegram_messages')
    // Defensive cap: Telegram messages top out ~4096 chars, but never trust the
    // wire — keep one fat payload from bloating a row.
    .insert({ chat_id: chatId, thread_id: threadId, tg_msg_id: tgMsgId ?? null, author: author ?? null, text: text.slice(0, 8000) })
    .select('id')
    .single();
  if (error) return null;
  return (data as { id: number }).id;
}

/** Last N messages in a chat+topic with id < beforeId, returned oldest-first. */
export async function recentMessages(
  chatId: number,
  limit: number,
  beforeId: number,
  threadId: number | null,
): Promise<Array<{ author: string | null; text: string }>> {
  const { data, error } = await byThread(
    supabaseAdmin.from('telegram_messages').select('author, text').eq('chat_id', chatId),
    threadId,
  )
    .lt('id', beforeId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as Array<{ author: string | null; text: string }>).reverse();
}

/** Messages in a chat+topic since an ISO timestamp, oldest-first (batch lookback). */
export async function messagesSince(
  chatId: number,
  sinceIso: string,
  threadId: number | null,
): Promise<Array<{ author: string | null; text: string }>> {
  const { data, error } = await byThread(
    supabaseAdmin.from('telegram_messages').select('author, text').eq('chat_id', chatId),
    threadId,
  )
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
  threadId: number | null;
  project: string | null;
  title: string;
  owner: string | null;
  sourceMsgId: number | undefined;
}): Promise<TelegramTaskRow | null> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .insert({
      chat_id: t.chatId,
      thread_id: t.threadId,
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

/** All open tasks in a chat+topic, oldest-first. (Morning batch is per-topic.) */
export async function openTasks(chatId: number, threadId: number | null): Promise<TelegramTaskRow[]> {
  const { data, error } = await byThread(
    supabaseAdmin.from('telegram_tasks').select(TASK_COLS).eq('chat_id', chatId).eq('status', 'open'),
    threadId,
  ).order('created_at', { ascending: true });
  if (error || !data) return [];
  return data as TelegramTaskRow[];
}

/** Most-recently-active open tasks in a chat+topic (bounds the per-message prompt). */
export async function recentOpenTasks(chatId: number, limit: number, threadId: number | null): Promise<TelegramTaskRow[]> {
  const { data, error } = await byThread(
    supabaseAdmin.from('telegram_tasks').select(TASK_COLS).eq('chat_id', chatId).eq('status', 'open'),
    threadId,
  )
    .order('last_activity_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as TelegramTaskRow[];
}

export async function countOpenTasks(chatId: number, threadId: number | null): Promise<number> {
  const { count, error } = await byThread(
    supabaseAdmin.from('telegram_tasks').select('id', { count: 'exact', head: true }).eq('chat_id', chatId).eq('status', 'open'),
    threadId,
  );
  if (error || count == null) return 0;
  return count;
}

/** Distinct topic thread ids (incl. null=General) that have OPEN tasks in this
 *  chat — the per-topic units the morning batch iterates. */
export async function openTaskThreads(chatId: number): Promise<Array<number | null>> {
  const { data, error } = await supabaseAdmin
    .from('telegram_tasks')
    .select('thread_id')
    .eq('chat_id', chatId)
    .eq('status', 'open');
  if (error || !data) return [];
  const set = new Set<number | null>();
  for (const r of data as Array<{ thread_id: number | null }>) set.add(r.thread_id ?? null);
  return [...set];
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
  const trimmed = note ? note.slice(0, 500) : null;
  // Skip a true no-op (same state AND same note) so a re-run of the batch over an
  // overlapping window doesn't churn last_activity_at / progress_note with nothing
  // new. A genuine note change or state change still writes.
  const current = await getTask(id);
  if (current && current.progress === progress && (current.progress_note ?? null) === trimmed) return;
  await supabaseAdmin
    .from('telegram_tasks')
    .update({ progress, progress_note: trimmed, last_activity_at: new Date().toISOString() })
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
 *  marks in_progress (a stated deadline implies work is underway). The
 *  model-supplied `dueAt` is validated to a real timestamp first — a garbage ISO
 *  string would otherwise make Postgres reject the whole write (and we'd lose
 *  due_text too). On a bad date we keep due_text and store due_at=null. Errors
 *  are logged, not swallowed. `expectAwaitingMsgId`, when given, makes the write
 *  conditional on the task still awaiting THAT question — so two racing replies
 *  can't both win (the second updates 0 rows). */
export async function setDeadline(
  id: string,
  dueText: string,
  dueAt: string | null,
  expectAwaitingMsgId?: number,
): Promise<void> {
  let safeDueAt: string | null = null;
  if (dueAt) {
    const t = Date.parse(dueAt);
    if (Number.isFinite(t)) safeDueAt = new Date(t).toISOString();
    else logger.warn('[TELEGRAM_TASKS] unparseable due_at from model, storing null', { id, dueAt });
  }
  let q = supabaseAdmin
    .from('telegram_tasks')
    .update({
      due_text: dueText.slice(0, 200),
      due_at: safeDueAt,
      awaiting_deadline_msg_id: null,
      progress: 'in_progress',
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'open');
  if (expectAwaitingMsgId !== undefined) q = q.eq('awaiting_deadline_msg_id', expectAwaitingMsgId);
  const { error } = await q;
  if (error) logger.error('[TELEGRAM_TASKS] setDeadline failed', { id, error: error.message });
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

/** Record that a bot message (`botMsgId`) was ABOUT these task(s), so a later
 *  user reply to that bot message resolves deterministically to them. Best-effort
 *  — a failure just degrades to LLM matching, never breaks the send path. */
export async function recordBotMsgRefs(chatId: number, botMsgId: number, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const rows = [...new Set(taskIds)].map((task_id) => ({ chat_id: chatId, bot_msg_id: botMsgId, task_id }));
  const { error } = await supabaseAdmin.from('telegram_bot_msg_refs').insert(rows);
  if (error) logger.warn('[TELEGRAM_TASKS] recordBotMsgRefs failed', { chatId, botMsgId, error: error.message });
}

/** Task id(s) a bot message was about — i.e. the user replied to one of the bot's
 *  own messages (ack / answer). Deterministic reply-chain link, generalizing the
 *  source-message and deadline-question links. */
export async function taskIdsByBotMsg(chatId: number, botMsgId: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('telegram_bot_msg_refs')
    .select('task_id')
    .eq('chat_id', chatId)
    .eq('bot_msg_id', botMsgId);
  if (error || !data) return [];
  return (data as Array<{ task_id: string }>).map((r) => r.task_id);
}

/** Delete bot-msg-ref rows older than the cutoff (pruned with messages). */
export async function pruneBotMsgRefs(cutoffIso: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('telegram_bot_msg_refs')
    .delete()
    .lt('created_at', cutoffIso)
    .select('id');
  if (error || !data) return 0;
  return data.length;
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
