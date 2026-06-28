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
  return { id: t.id, project: t.project, title: t.title, owner: t.owner, progress: t.progress, progress_note: t.progress_note };
}

/** Best-effort outbound post to the group (never throws into the caller). */
async function send(chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, 'HTML');
  } catch (err) {
    logger.warn('[TELEGRAM_TASKS] send failed', { chatId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Apply a validated action list to the db. Returns what changed. */
async function applyActions(
  chatId: number,
  actions: Action[],
  sourceMsgId: number | undefined,
): Promise<{ created: string[]; closed: string[]; progressed: string[] }> {
  const created: string[] = [];
  const closed: string[] = [];
  const progressed: string[] = [];
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
      case 'touch': await db.touchActivity(a.task_id); break;
    }
  }
  return { created, closed, progressed };
}

export interface InboundMessage {
  chatId: number;
  msgId: number;
  text: string;
  authorUsername: string | undefined; // bare username without @, from Telegram
  authorName: string | undefined; // display/first name fallback
  isEdit: boolean;
  replyToMsgId: number | undefined;
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
    const [contextTasks, totalOpen, recent, replyTaskIds] = await Promise.all([
      db.recentOpenTasks(m.chatId, MAX_CONTEXT_TASKS),
      db.countOpenTasks(m.chatId),
      msgRowId ? db.recentMessages(m.chatId, RECENT_MSG_WINDOW, msgRowId) : Promise.resolve([]),
      m.replyToMsgId ? db.openTaskIdsBySourceMsg(m.chatId, m.replyToMsgId) : Promise.resolve([]),
    ]);

    // Cheap cost guard: with NO open tasks in the chat, the only action the model
    // could take is `create`. A short, single-line, non-#task message is almost
    // never a real task assignment (digests are long + multi-line), so skip the
    // LLM call entirely — this drops the dominant chatter case in a quiet chat
    // without risking a missed closure (there's nothing open to close). The
    // message is still logged above, so it joins the next batch's context.
    const looksActionable = m.text.includes('\n') || m.text.trim().length > 15 || /#task/i.test(m.text);
    if (totalOpen === 0 && !looksActionable) return;

    const actions = await reconcile({
      text,
      author,
      isManager: isManagerUsername(m.authorUsername),
      replyToTaskIds: replyTaskIds,
      openTasks: contextTasks.map(toAiView),
      hiddenOpenCount: Math.max(0, totalOpen - contextTasks.length),
      recentMessages: recent,
    });

    const r = await applyActions(m.chatId, actions, m.msgId);

    const bits: string[] = [];
    if (r.created.length) bits.push(`📝 tracking ${r.created.length} new task${r.created.length > 1 ? 's' : ''}`);
    if (r.closed.length) bits.push(`✅ closed ${r.closed.length} task${r.closed.length > 1 ? 's' : ''}`);
    if (r.progressed.length) bits.push(`📌 noted status on ${r.progressed.length} task${r.progressed.length > 1 ? 's' : ''}`);
    if (bits.length) await send(m.chatId, bits.join(' · '));
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
