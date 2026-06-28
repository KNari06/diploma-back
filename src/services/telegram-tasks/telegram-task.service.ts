/**
 * QAIT Tasker — orchestration. Ingests a Telegram chat message, reconciles it
 * against open tasks (AI), applies the resulting actions through the db/ layer,
 * and runs the daily morning batch that resolves statuses + asks owners about
 * unknown tasks. No direct Supabase access (goes through ./db) and no HTTP
 * concerns (the controller owns those).
 */
import { env } from '@/config/environment/env';
import { getFileBase64, sendMessage } from '@/services/api/telegram.service';
import { logger } from '@/utils/core/logger';
import {
  type Action,
  type AiTaskView,
  batchAnalyze,
  describeImage,
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

/**
 * A deep link to the message a task was created from, as an HTML <a>. Telegram
 * `t.me/c/<id>/<msg>` links resolve only inside supergroups/channels, whose
 * chat_id is the large negative `-100…` form; the internal id drops that prefix.
 * For a normal group / DM (no -100 prefix) or a missing source message we can't
 * build a working link, so we return the plain (escaped) label unlinked.
 */
export function taskLink(chatId: number, sourceMsgId: number | null, label: string): string {
  const safe = escapeHtml(label);
  const s = String(chatId);
  if (sourceMsgId && s.startsWith('-100')) {
    const internal = s.slice(4); // strip "-100"
    return `<a href="https://t.me/c/${internal}/${sourceMsgId}">${safe}</a>`;
  }
  return safe;
}

/** Best-effort outbound post to the group (never throws into the caller). */
// Telegram hard-limits a message to 4096 chars; an over-limit send is rejected
// (400) and would otherwise be silently dropped. Cap with headroom.
const TG_MAX_CHARS = 3900;

async function send(chatId: number, text: string, replyTo?: number): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const safe = text.length > TG_MAX_CHARS ? `${text.slice(0, TG_MAX_CHARS)}…` : text;
  try {
    // replyTo threads the bot's message under the user's, so the answer/ack links
    // back to what it's about. allow_sending_without_reply (in sendMessage) keeps
    // it from failing if the original was deleted.
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, safe, 'HTML', replyTo ? { replyToMessageId: replyTo } : undefined);
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
 *  is the inbound message id a `claim` question should reply to. `deadlineReplyMsgId`
 *  is the bot-question id this message replied to (if any) — used to make a
 *  set_deadline write conditional, so racing replies can't both win. */
async function applyActions(
  chatId: number,
  actions: Action[],
  sourceMsgId: number | undefined,
  askReplyTo?: number,
  deadlineReplyMsgId?: number,
): Promise<{ created: string[]; closed: string[]; closedLinks: string[]; progressed: string[]; asked: boolean; deadlines: string[]; notes: string[] }> {
  const created: string[] = [];
  const closed: string[] = [];
  const closedLinks: string[] = []; // HTML labels (linked to source msg) for the ack
  const progressed: string[] = [];
  // Human-readable per-change labels for an informative ack (vs "noted status
  // on 1 task"). Filled for status/deadline changes where the task name helps.
  const notes: string[] = [];
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
      case 'close': {
        await db.closeTask(a.task_id, a.reason);
        closed.push(a.task_id);
        const t = await db.getTask(a.task_id);
        if (t) closedLinks.push(taskLink(t.chat_id, t.source_msg_id, `${t.project ? `[${t.project}] ` : ''}${t.title}`));
        break;
      }
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
      case 'progress': {
        await db.setProgress(a.task_id, a.state, a.note);
        progressed.push(a.task_id);
        const t = await db.getTask(a.task_id);
        const label = t ? `${t.project ? `[${t.project}] ` : ''}${t.title}` : 'task';
        // The task title links to the message it was created from.
        const linked = t ? taskLink(t.chat_id, t.source_msg_id, label) : escapeHtml(label);
        const STATUS_LABEL = { in_progress: 'in progress', blocked: 'blocked', needs_investigation: 'needs investigation' } as const;
        notes.push(`📌 ${linked} — ${STATUS_LABEL[a.state]}`);
        break;
      }
      case 'claim': {
        // Someone took a task with no deadline → ask "when?", as a reply to the
        // claim message, and remember the question id so their answer links back.
        const task = await db.getTask(a.task_id);
        const label = task ? `${task.project ? `[${task.project}] ` : ''}${task.title}` : 'this task';
        const qId = await sendReturningId(chatId, `🕒 When will it be ready? — ${escapeHtml(label)}`, askReplyTo);
        if (qId) {
          await db.setAwaitingDeadline(a.task_id, qId);
          asked = true;
        } else {
          // Question couldn't be posted (Telegram error). Don't mark in_progress
          // with no deadline (that would hide it from the morning batch). Just
          // touch so it's not chased as silent, and the batch still asks later.
          await db.touchActivity(a.task_id);
        }
        break;
      }
      case 'set_deadline':
        await db.setDeadline(a.task_id, a.due_text, a.due_at, deadlineReplyMsgId);
        deadlines.push(a.task_id);
        break;
      case 'clarify': {
        // Ambiguous which task — ask the user to reply to the specific one rather
        // than guess. List the candidates so they can pick. The user's reply to a
        // task line then resolves deterministically via source_msg_id.
        const tasks = await Promise.all(a.candidate_ids.map((id) => db.getTask(id)));
        const lines = tasks
          .filter((t): t is NonNullable<typeof t> => !!t)
          .map((t) => `• ${t.project ? `[${escapeHtml(t.project)}] ` : ''}${escapeHtml(t.title)}`);
        if (lines.length >= 2) {
          await send(
            chatId,
            `🤔 Which task did you mean? Reply to the specific one:\n${lines.join('\n')}`,
            askReplyTo,
          );
          asked = true;
        }
        break;
      }
      case 'touch': await db.touchActivity(a.task_id); break;
    }
  }
  return { created, closed, closedLinks, progressed, asked, deadlines, notes };
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
  imageFileId: string | undefined; // attached photo/image-doc → read via vision
}

/**
 * Ingest one inbound Telegram message: log it, reconcile against open tasks, and
 * apply the actions. Best-effort acknowledgement back to the group. Never
 * throws — the webhook must always 200.
 */
export async function ingestMessage(m: InboundMessage): Promise<void> {
  // If a photo/image is attached, read it with vision and weave the description
  // into the message text as plain prose (no "[attached image: …]" tag), so a
  // caption-less screenshot reads as if the sender wrote what's in it. The model
  // treats the image content seamlessly alongside any caption. Fail-open: a
  // vision error leaves the text as-is.
  let baseText = m.text;
  if (m.imageFileId && env.TELEGRAM_BOT_TOKEN) {
    try {
      const file = await getFileBase64(env.TELEGRAM_BOT_TOKEN, m.imageFileId);
      const desc = file ? await describeImage(file.base64, file.mime) : '';
      if (desc) baseText = baseText ? `${baseText}\n${desc}` : desc;
    } catch {
      /* vision failed — keep whatever text we have (may be empty) */
    }
  }

  const text = m.isEdit
    ? `[EDITED MESSAGE — reconcile against existing tasks, do not duplicate]\n${baseText}`
    : baseText;
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
    // Use the enriched `text` (includes any image description) and never skip a
    // message that carried an image — a screenshot can assign/clarify work.
    const isSingleToken = !/\s/.test(text.trim());
    if (totalOpen === 0 && !m.addressedToBot && !m.imageFileId && isSingleToken) return;

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

    // deadlineReplyMsgId is set only when this message replied to a bot "when?"
    // question — makes the set_deadline write conditional (race-safe).
    const r = await applyActions(m.chatId, actions, m.msgId, m.msgId, deadlineTaskId ? m.replyToMsgId : undefined);

    // Always surface what CHANGED (don't let a chatty reply hide a create/close).
    // A `claim` already posted its own "when?" question, so it's not in `bits`.
    const bits: string[] = [];
    // "tracking N tasks" links to the digest message they came from (m.msgId).
    if (r.created.length) {
      const n = r.created.length;
      bits.push(`📝 ${taskLink(m.chatId, m.msgId, `tracking ${n} new task${n > 1 ? 's' : ''}`)}`);
    }
    // closed: link each task title to its source message (up to 3, else count).
    if (r.closed.length) {
      if (r.closedLinks.length && r.closedLinks.length <= 3) bits.push(`✅ closed ${r.closedLinks.join(', ')}`);
      else bits.push(`✅ closed ${r.closed.length} task${r.closed.length > 1 ? 's' : ''}`);
    }
    // Prefer the detailed per-task status labels (already linked) over a bare count.
    if (r.notes.length) bits.push(...r.notes);
    else if (r.progressed.length) bits.push(`📌 noted status on ${r.progressed.length} task${r.progressed.length > 1 ? 's' : ''}`);
    if (r.deadlines.length) bits.push(`📅 set deadline on ${r.deadlines.length} task${r.deadlines.length > 1 ? 's' : ''}`);

    // Honor the model's reply ONLY when the user actually addressed the bot — a
    // hard code-side guard so a chatty model can't spam the group on ordinary
    // digests (the schema asks for this, but we don't trust the model to obey).
    const wantsReply = reply && m.addressedToBot;

    // Link the bot's message back to the user's so it's clear what it answers.
    if (wantsReply && bits.length) {
      // Both an answer AND changes: post the answer, then the change ack.
      await send(m.chatId, escapeHtml(reply!), m.msgId);
      await send(m.chatId, bits.join(' · '), m.msgId);
    } else if (wantsReply) {
      await send(m.chatId, escapeHtml(reply!), m.msgId);
    } else if (bits.length) {
      await send(m.chatId, bits.join(' · '), m.msgId);
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
