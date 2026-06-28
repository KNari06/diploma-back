/**
 * QAIT Tasker — orchestration. Ingests a Telegram chat message, reconciles it
 * against open tasks (AI), applies the resulting actions through the db/ layer,
 * and runs the daily morning batch that resolves statuses + asks owners about
 * unknown tasks. No direct Supabase access (goes through ./db) and no HTTP
 * concerns (the controller owns those).
 */
import { env } from '@/config/environment/env';
import { sendMessage } from '@/services/api/telegram.service';
import { logger } from '@/utils/core/logger';
import {
  type Action,
  type AiTaskView,
  batchAnalyze,
  reconcile,
} from './telegram-task-ai.service';
import { canonicalOwner, isManagerUsername } from './owner-aliases';
import * as db from './db/telegram-task.db';
import type { TelegramTaskRow } from './db/telegram-task.db';

const MAX_CONTEXT_TASKS = 40;
const RECENT_MSG_WINDOW = 10;
const BATCH_LOOKBACK_HOURS = 26;
const EXPIRE_AFTER_DAYS = 14;
const MSG_RETENTION_DAYS = Math.ceil(BATCH_LOOKBACK_HOURS / 24) + 1;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toAiView(t: TelegramTaskRow): AiTaskView {
  return {
    id: t.id,
    project: t.project,
    title: t.title,
    owner: t.owner,
    progress: t.progress,
    progress_note: t.progress_note,
    has_deadline: !!t.due_text || !!t.due_at,
  };
}

/** Best-effort outbound post to the group (never throws into the caller). */
// Telegram hard-limits a message to 4096 chars; an over-limit send is rejected
// (400) and would otherwise be silently dropped. Cap with headroom.
const TG_MAX_CHARS = 3900;

async function send(chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const safe = text.length > TG_MAX_CHARS ? `${text.slice(0, TG_MAX_CHARS)}…` : text;
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, safe, 'HTML');
  } catch (err) {
    logger.warn('[TELEGRAM_TASKS] send failed', { chatId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Send and return the sent message id (needed so a later reply to THIS message
 *  resolves back to the task). Returns null on failure. */
async function sendReturningId(chatId: number, text: string, replyTo?: number): Promise<number | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const safe = text.length > TG_MAX_CHARS ? `${text.slice(0, TG_MAX_CHARS)}…` : text;
  try {
    const res = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, safe, 'HTML', replyTo ? { replyToMessageId: replyTo } : undefined);
    return res.message_id;
  } catch (err) {
    logger.warn('[TELEGRAM_TASKS] send (with id) failed', { chatId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Q&A / action when addressed to the bot is NOT decided by keywords here — the
 * reconcile LLM call itself decides (question → it returns `reply`; action → it
 * returns actions). This keeps all language understanding in the model.
 */

/** Apply a validated action list to the db. Returns what changed. `askReplyTo`
 *  is the inbound message id a `claim` question should reply to (so the user's
 *  deadline answer threads back to the task). */
async function applyActions(
  chatId: number,
  actions: Action[],
  sourceMsgId: number | undefined,
  askReplyTo?: number,
): Promise<{ created: string[]; closed: string[]; progressed: string[]; asked: boolean; deadlines: string[] }> {
  const created: string[] = [];
  const closed: string[] = [];
  const progressed: string[] = [];
  const deadlines: string[] = [];
  let asked = false;
  for (const a of actions) {
    switch (a.kind) {
      case 'create': {
        const row = await db.createTask({ chatId, project: a.project, title: a.title, owner: canonicalOwner(a.owner), sourceMsgId });
        if (row) {
          created.push(row.id);
          if (a.initialState) await db.setProgress(row.id, a.initialState, a.initialNote ?? null);
        }
        break;
      }
      case 'close': await db.closeTask(a.task_id, a.reason); closed.push(a.task_id); break;
      case 'reopen': await db.reopenTask(a.task_id); break;
      case 'update':
        // Pass ONLY the patchable fields (not kind/task_id) so updateTask can't
        // be polluted by future action properties. owner is alias-canonicalized.
        await db.updateTask(a.task_id, {
          project: a.project,
          title: a.title,
          owner: a.owner !== undefined ? canonicalOwner(a.owner) : undefined,
        });
        await db.touchActivity(a.task_id);
        break;
      case 'progress': await db.setProgress(a.task_id, a.state, a.note); progressed.push(a.task_id); break;
      case 'claim': {
        // Someone took a task with no deadline → ask "when?", as a reply to the
        // claim message, and remember the question id so their answer links back.
        const task = await db.getTask(a.task_id);
        const label = task ? `${task.project ? `[${task.project}] ` : ''}${task.title}` : 'this task';
        const qId = await sendReturningId(chatId, `🕒 When will it be ready? — ${escapeHtml(label)}`, askReplyTo);
        if (qId) {
          await db.setAwaitingDeadline(a.task_id, qId);
          asked = true;
        }
        break;
      }
      case 'set_deadline':
        await db.setDeadline(a.task_id, a.due_text, a.due_at);
        deadlines.push(a.task_id);
        break;
      case 'touch': await db.touchActivity(a.task_id); break;
    }
  }
  return { created, closed, progressed, asked, deadlines };
}

export interface InboundMessage {
  chatId: number;
  msgId: number;
  text: string;
  authorUsername: string | undefined; // bare username without @, from Telegram
  authorName: string | undefined; // display/first name fallback
  isEdit: boolean;
  replyToMsgId: number | undefined;
  addressedToBot: boolean; // @mention of the bot or reply to a bot message — the model decides question vs action
}

/**
 * Ingest one inbound Telegram message: log it, reconcile against open tasks, and
 * apply the actions. Best-effort acknowledgement back to the group. Never
 * throws — the webhook must always 200.
 */
export async function ingestMessage(m: InboundMessage): Promise<void> {
  const text = m.isEdit
    ? `[EDITED MESSAGE — reconcile against existing tasks, do not duplicate]\n${m.text}`
    : m.text;
  const author = m.authorUsername ? `@${m.authorUsername}` : m.authorName;

  const msgRowId = await db.logMessage(m.chatId, m.msgId, author, text);

  try {
    const [contextTasks, totalOpen, recent, replyTaskIds, deadlineTaskId] = await Promise.all([
      db.recentOpenTasks(m.chatId, MAX_CONTEXT_TASKS),
      db.countOpenTasks(m.chatId),
      msgRowId ? db.recentMessages(m.chatId, RECENT_MSG_WINDOW, msgRowId) : Promise.resolve([]),
      m.replyToMsgId ? db.openTaskIdsBySourceMsg(m.chatId, m.replyToMsgId) : Promise.resolve([]),
      // Deterministic deadline link: did this message reply to the bot's "when?"
      // question for a specific task?
      m.replyToMsgId ? db.findTaskAwaitingDeadline(m.chatId, m.replyToMsgId) : Promise.resolve(null),
    ]);

    // Merge the deadline-reply task into the reply hints so the model resolves
    // the deadline answer to exactly that task (no ambiguity across tasks).
    const allReplyTaskIds = deadlineTaskId ? [...new Set([deadlineTaskId, ...replyTaskIds])] : replyTaskIds;

    // Cost guard (structural, not language-keyword based): a one-token message
    // in a chat with NO open tasks that isn't addressed to the bot cannot
    // produce a useful action (nothing to close/update; a real task assignment
    // is never a single bare word). Skip the LLM for that case only. Everything
    // else — any open task present, any multi-word message, or anything aimed at
    // the bot — goes to the model. The message is logged regardless.
    const isSingleToken = !/\s/.test(m.text.trim());
    if (totalOpen === 0 && !m.addressedToBot && isSingleToken) return;

    const { actions, reply } = await reconcile({
      text,
      author,
      isManager: isManagerUsername(m.authorUsername),
      replyToTaskIds: allReplyTaskIds,
      openTasks: contextTasks.map(toAiView),
      hiddenOpenCount: Math.max(0, totalOpen - contextTasks.length),
      recentMessages: recent,
      addressedToBot: m.addressedToBot || deadlineTaskId !== null,
    });

    const r = await applyActions(m.chatId, actions, m.msgId, m.msgId);

    // Always surface what CHANGED (don't let a chatty reply hide a create/close).
    // A `claim` already posted its own "when?" question, so it's not in `bits`.
    const bits: string[] = [];
    if (r.created.length) bits.push(`📝 tracking ${r.created.length} new task${r.created.length > 1 ? 's' : ''}`);
    if (r.closed.length) bits.push(`✅ closed ${r.closed.length} task${r.closed.length > 1 ? 's' : ''}`);
    if (r.progressed.length) bits.push(`📌 noted status on ${r.progressed.length} task${r.progressed.length > 1 ? 's' : ''}`);
    if (r.deadlines.length) bits.push(`📅 set deadline on ${r.deadlines.length} task${r.deadlines.length > 1 ? 's' : ''}`);

    // Honor the model's reply ONLY when the user actually addressed the bot — a
    // hard code-side guard so a chatty model can't spam the group on ordinary
    // digests (the schema asks for this, but we don't trust the model to obey).
    const wantsReply = reply && m.addressedToBot;

    if (wantsReply && bits.length) {
      // Both an answer AND changes: post the answer, then the change ack.
      await send(m.chatId, escapeHtml(reply!));
      await send(m.chatId, bits.join(' · '));
    } else if (wantsReply) {
      await send(m.chatId, escapeHtml(reply!));
    } else if (bits.length) {
      await send(m.chatId, bits.join(' · '));
    }
  } catch (err) {
    logger.error('[TELEGRAM_TASKS] ingest failed', { chatId: m.chatId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Morning batch for one chat: analyze the day's messages against all open tasks,
 * apply resolved statuses, then post ONE grouped status check tagging owners of
 * tasks the conversation did NOT clarify (still open + progress 'none').
 */
export async function runMorningBatch(chatId: number): Promise<void> {
  const open = await db.openTasks(chatId);
  if (open.length === 0) return;

  const sinceIso = new Date(Date.now() - BATCH_LOOKBACK_HOURS * 3600_000).toISOString();
  const msgs = await db.messagesSince(chatId, sinceIso);
  try {
    const actions = await batchAnalyze(open.map(toAiView), msgs);
    await applyActions(chatId, actions, undefined);
  } catch (err) {
    logger.error('[TELEGRAM_TASKS] batch analyze failed', { chatId, error: err instanceof Error ? err.message : String(err) });
  }
  // Mark the pre-analysis snapshot as batched. Tasks that applyActions just
  // closed get a harmless extra last_batch_at write — intentional, simpler than
  // re-querying which survived.
  await db.markBatched(open.map((t) => t.id));

  const remaining = await db.openTasks(chatId);
  const unknown = remaining.filter((t) => t.progress === 'none');
  const known = remaining.filter((t) => t.progress !== 'none');
  if (unknown.length === 0) return;

  const byOwner = new Map<string, TelegramTaskRow[]>();
  for (const t of unknown) {
    const k = t.owner ?? 'unassigned';
    (byOwner.get(k) ?? byOwner.set(k, []).get(k)!).push(t);
  }

  const lines = ['🌅 <b>Morning status check — I couldn\'t tell where these stand:</b>'];
  for (const [owner, list] of byOwner) {
    lines.push('');
    lines.push(owner === 'unassigned' ? '(unassigned)' : escapeHtml(owner));
    for (const t of list) lines.push(`• ${t.project ? `[${escapeHtml(t.project)}] ` : ''}${escapeHtml(t.title)}`);
  }
  if (known.length) {
    lines.push('');
    lines.push(`<i>(${known.length} other task(s) have a known status — not asking about those.)</i>`);
  }
  lines.push('');
  lines.push('Reply with the status: done / in progress / blocked / needs investigation.');
  await send(chatId, lines.join('\n'));
}

/**
 * Daily sweep across every known chat: expire abandoned tasks, prune the message
 * log, then run the morning batch per chat. Called by TelegramTaskSweepJob.
 */
export async function sweepAllChats(): Promise<{ chats: number; expired: number; pruned: number }> {
  const expireCutoff = new Date(Date.now() - EXPIRE_AFTER_DAYS * 86_400_000).toISOString();
  const expired = await db.expireStaleOpenTasks(expireCutoff);
  const pruneCutoff = new Date(Date.now() - MSG_RETENTION_DAYS * 86_400_000).toISOString();
  const pruned = await db.pruneMessages(pruneCutoff);

  const chats = await db.allKnownChats();
  for (const chatId of chats) {
    try {
      await runMorningBatch(chatId);
    } catch (err) {
      logger.error('[TELEGRAM_TASKS] morning batch failed for chat', { chatId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { chats: chats.length, expired, pruned };
}
