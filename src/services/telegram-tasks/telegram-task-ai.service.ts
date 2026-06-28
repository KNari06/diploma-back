/**
 * QAIT Tasker — the AI understanding layer (ported from the standalone bot).
 *
 * Context-aware reconcile: instead of parsing each message in isolation, the
 * model gets the FULL picture — the new message, who sent it, who they replied
 * to, whether they're the manager, and the currently-open tasks — and returns
 * one coherent set of actions. This is what lets the agent dedupe re-stated
 * tasks, resolve "done" to the right task via reply context, respect authority,
 * tell tasks from questions, and track activity.
 *
 * The only change from the standalone version: the LLM call goes through the
 * repo's `getChatCompletionWithMessages` (provider routing + cost tracking +
 * tool-use) instead of a bespoke client. Task ids are Supabase uuid strings.
 */
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { aliasHint } from './owner-aliases';

export type ProgressState = 'in_progress' | 'blocked' | 'needs_investigation';

/** Minimal task shape the AI layer needs (subset of the DB row). */
export interface AiTaskView {
  id: string;
  project: string | null;
  title: string;
  owner: string | null;
  progress: 'none' | ProgressState;
  progress_note: string | null;
}

export type Action =
  | { kind: 'create'; project: string | null; title: string; owner: string | null; initialState?: ProgressState; initialNote?: string }
  | { kind: 'close'; task_id: string; reason: string }
  | { kind: 'reopen'; task_id: string }
  | { kind: 'update'; task_id: string; project?: string | null; title?: string; owner?: string | null }
  | { kind: 'progress'; task_id: string; state: ProgressState; note: string }
  | { kind: 'touch'; task_id: string };

export interface ReconcileContext {
  text: string;
  author: string | undefined;
  isManager: boolean;
  replyToTaskIds: string[];
  openTasks: AiTaskView[]; // BOUNDED: most-recently-active open tasks only
  hiddenOpenCount: number;
  recentMessages: Array<{ author: string | null; text: string }>;
}

const RECONCILE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'apply_actions',
    description: 'Apply the task-state changes implied by this chat message, given the open tasks.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Ordered list of changes. Empty array if the message implies no change.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['create', 'close', 'reopen', 'update', 'progress', 'touch'] },
              task_id: { type: ['string', 'null'], description: 'Existing task id (uuid), for close/reopen/update/progress/touch.' },
              project: { type: ['string', 'null'], description: 'For create/update.' },
              title: { type: ['string', 'null'], description: 'For create/update.' },
              owner: { type: ['string', 'null'], description: 'For create/update: @username verbatim.' },
              reason: { type: ['string', 'null'], description: 'For close: the phrase that signalled done.' },
              state: { type: ['string', 'null'], enum: ['in_progress', 'blocked', 'needs_investigation', null], description: 'For progress (required) OR create (optional initial status).' },
              note: { type: ['string', 'null'], description: 'Status note for progress/create, e.g. "turns out hard, 1-2 days".' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['actions'],
    },
  },
};

function buildSystem(): string {
  return [
    'You maintain a software QA team\'s task list from their Telegram group chat.',
    'Messages are English, Russian, or Kazakh, often mixed. One manager posts',
    'free-form daily "Priorities" digests grouped under project headers (JP,',
    'Documentolog, Klara, B2C, Hustle, …); teammates reply about progress.',
    '',
    'Think about INTENT, not keywords. The same words mean different things as a',
    'statement vs a question: "this is done" (a report → close) vs "this is done?"',
    'or "is this actual?" (the manager ASKING → touch, never close).',
    '',
    'You are given: RECENT CHAT (context, do not act on it), the NEW message, its',
    'AUTHOR, whether the author is the MANAGER, which open task(s) a replied-to',
    'message created, and the currently-open tasks with ids. Act ONLY on the NEW',
    'message. Output a list of actions (one message can yield MANY actions).',
    '',
    'ACTIONS:',
    'create  — a genuinely NEW unit of work is assigned. A single digest message',
    '          typically creates MANY tasks — emit one create per actionable line,',
    '          carrying its project header into "project". The leading list number',
    '          ("1.", "10.") is NOT a task id — ignore it. A "#task ..." message is',
    '          a strong create signal. Do NOT create for a task already in the open',
    '          list (match by MEANING, not exact words) — use update/touch instead.',
    '          Do NOT create for questions, status-checks, or chatter.',
    'close   — the message REPORTS a specific task DONE ("done","merged","fixed",',
    '          "deployed","готово","сделал","залил","закрыл","бітті"). A promise',
    '          about the future, a question ("done?"), or a vague "ok"/"+" is NOT',
    '          closure. Authority: a teammate may close only a task they OWN; the',
    '          MANAGER may close anyone\'s task.',
    'reopen  — an explicit statement that a closed/assumed-done task is NOT done.',
    'update  — same task, but its owner, project, or wording changed.',
    'progress — the owner reports a real STATUS that is not "done": state =',
    '          in_progress ("working on it","in progress","1-2 days","делаю"),',
    '          blocked ("waiting on X","depends on","заблокирован"), or',
    '          needs_investigation ("turns out hard","need more investigation",',
    '          "не понятно почему"). Put their own words in "note". A digest line',
    '          can BOTH create a task AND state its status (e.g. "Pointer -',
    '          @user - in Progress, 1-2 days") → emit ONE create with state+note',
    '          set on it. Records status AND resets the staleness clock.',
    'touch   — the message mentions/asks about an existing task with NO real status',
    '          ("is this actual?","what is the plan?","this is done?"). Resets the',
    '          staleness clock only — so a discussed task is not chased as silent.',
    '',
    'OWNER: copy the @username verbatim (with @) when present. If only a plain name',
    'is given ("Marketing doc - Serzhan", "... - Bauka"), use that name as owner. If',
    'a line names several people ("@a and me have to test ..."), pick the primary',
    'owner (the first / the one being asked) for owner; "me" means the AUTHOR.',
    '',
    'PRIORITY when unsure: prefer reusing an existing task_id over create; prefer',
    'touch/progress over close; never close on a question. If a message clearly does',
    'nothing task-related (pure chatter: "тут почему?", "Хотя да", "ok"), emit no',
    'actions.',
    '',
    'EXAMPLES (input → actions):',
    '• "JP\\n1. Video not playing - @gipardb - what is the plan?\\n2. AI check bugs',
    '  - @ndarkhans - today"  →  create{project:JP,title:"Video not playing",',
    '  owner:@gipardb}; create{project:JP,title:"AI check bugs",owner:@ndarkhans}',
    '• "Pointer - @YerassylOspan - when? - in Progress, it takes 1-2 days"  →',
    '  create{title:"Pointer",owner:@YerassylOspan,state:in_progress,note:"1-2 days"}',
    '• owner @gipardb replies "merged, deployed"  → close{the video task}',
    '• manager: "@ndarkhans is this actual?"  → touch{that task}  (a QUESTION)',
    '• "turns out hard, need to investigate more"  → progress{state:',
    '  needs_investigation, note:"turns out hard, need to investigate more"}',
    '• "#task add the switcher to git"  → create{title:"add the switcher to git"}',
    '• "как будто выглядит избыточным" / "Хотя да"  → (no actions)',
    ...(aliasHint() ? ['', aliasHint()] : []),
  ].join('\n');
}

function renderOpenTasks(openTasks: AiTaskView[]): string {
  if (openTasks.length === 0) return '(none)';
  return openTasks
    .map(
      (t) =>
        `- id=${t.id}: ${t.project ? `[${t.project}] ` : ''}${t.title}` +
        `${t.owner ? ` (owner ${t.owner})` : ' (unassigned)'}` +
        `${t.progress !== 'none' ? ` [last status: ${t.progress}${t.progress_note ? ` — ${t.progress_note}` : ''}]` : ''}`,
    )
    .join('\n');
}

function renderRecent(msgs: Array<{ author: string | null; text: string }>): string {
  if (msgs.length === 0) return '(none)';
  return msgs
    .map((m) => `${m.author ?? '?'}: ${m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text}`)
    .join('\n');
}

/** One forced tool call → parsed `actions` array (or [] on any failure). */
async function callReconcileTool(system: string, user: string, maxTokens: number): Promise<unknown[]> {
  try {
    const res = await getChatCompletionWithMessages(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        model: AI_TASK_MODELS.telegramTaskReconcile,
        tools: [RECONCILE_TOOL],
        tool_choice: 'required',
        max_tokens: maxTokens,
      },
    );
    const argStr = res.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return [];
    const parsed = JSON.parse(argStr) as { actions?: unknown };
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch (err) {
    logger.error('[TELEGRAM_TASKS] reconcile LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function reconcile(ctx: ReconcileContext): Promise<Action[]> {
  const openHeader =
    ctx.hiddenOpenCount > 0
      ? `OPEN TASKS (most recent ${ctx.openTasks.length}; ${ctx.hiddenOpenCount} older open tasks not shown):`
      : 'OPEN TASKS:';

  const userBlock = [
    'RECENT CHAT (oldest first, for resolving references like "the first one"):',
    renderRecent(ctx.recentMessages),
    '',
    `AUTHOR: ${ctx.author ?? 'unknown'}${ctx.isManager ? ' (MANAGER)' : ''}`,
    ctx.replyToTaskIds.length ? `REPLYING TO TASK(S): ${ctx.replyToTaskIds.join(', ')}` : 'REPLYING TO: (not a reply / unknown)',
    '',
    openHeader,
    renderOpenTasks(ctx.openTasks),
    '',
    'NEW MESSAGE (act only on THIS message; the recent chat is context):',
    `"""${ctx.text}"""`,
  ].join('\n');

  const raw = await callReconcileTool(buildSystem(), userBlock, 1500);
  return validateActions(raw as Array<Record<string, unknown>>, ctx.openTasks, ctx.text);
}

const PROGRESS_STATES = new Set<ProgressState>(['in_progress', 'blocked', 'needs_investigation']);

/** Narrow raw model output to safe, known-task actions. Reused by reconcile()
 *  and the overnight batch. Drops anything malformed or referencing an
 *  out-of-context task id. */
export function validateActions(
  raw: Array<Record<string, unknown>>,
  openTasks: AiTaskView[],
  fallbackReason: string,
): Action[] {
  const openIds = new Set(openTasks.map((t) => t.id));
  const out: Action[] = [];
  for (const a of raw) {
    const kind = a.kind;
    if (kind === 'create' && typeof a.title === 'string' && a.title.trim()) {
      const hasState = PROGRESS_STATES.has(a.state as ProgressState);
      out.push({
        kind: 'create',
        title: a.title.trim(),
        project: typeof a.project === 'string' ? a.project : null,
        owner: typeof a.owner === 'string' ? a.owner : null,
        ...(hasState ? { initialState: a.state as ProgressState } : {}),
        ...(hasState && typeof a.note === 'string' ? { initialNote: a.note } : {}),
      });
      continue;
    }
    if (typeof a.task_id !== 'string' || !openIds.has(a.task_id)) continue;
    if (kind === 'close') {
      out.push({ kind: 'close', task_id: a.task_id, reason: typeof a.reason === 'string' ? a.reason : fallbackReason });
    } else if (kind === 'reopen') {
      out.push({ kind: 'reopen', task_id: a.task_id });
    } else if (kind === 'touch') {
      out.push({ kind: 'touch', task_id: a.task_id });
    } else if (kind === 'progress' && PROGRESS_STATES.has(a.state as ProgressState)) {
      out.push({
        kind: 'progress',
        task_id: a.task_id,
        state: a.state as ProgressState,
        note: typeof a.note === 'string' ? a.note : fallbackReason,
      });
    } else if (kind === 'update') {
      out.push({
        kind: 'update',
        task_id: a.task_id,
        ...(typeof a.project === 'string' || a.project === null ? { project: a.project as string | null } : {}),
        ...(typeof a.title === 'string' ? { title: a.title } : {}),
        ...(typeof a.owner === 'string' || a.owner === null ? { owner: a.owner as string | null } : {}),
      });
    }
  }
  return out;
}

/**
 * Re-read a day's worth of messages against ALL open tasks and decide each
 * task's real status. Runs once before the morning repost. Sees the whole
 * conversation window, so it catches closures/status-updates phrased indirectly
 * or split across messages. Tasks left untouched are "unknown" and get asked
 * about by the caller.
 */
export async function batchAnalyze(
  openTasks: AiTaskView[],
  messages: Array<{ author: string | null; text: string }>,
): Promise<Action[]> {
  if (openTasks.length === 0 || messages.length === 0) return [];

  const taskList = renderOpenTasks(openTasks);
  const convo = messages
    .map((m) => `${m.author ?? '?'}: ${m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text}`)
    .join('\n');

  const system = [
    buildSystem(),
    '',
    'BATCH MODE: you are reviewing a full day of conversation against every open',
    'task at once (not a single message). For EACH open task, decide if the',
    'conversation shows it is: done (close), has a real non-done status',
    '(progress), or is just discussed (touch). Emit NOTHING for a task the',
    'conversation does not clarify — leave it untouched so a human is asked.',
    'Do NOT create new tasks in batch mode unless the conversation clearly',
    'assigns brand-new work that is not already in the open list.',
  ].join('\n');
  const user = `OPEN TASKS:\n${taskList}\n\nCONVERSATION (oldest first):\n${convo}`;

  const raw = await callReconcileTool(system, user, 3000);
  return validateActions(raw as Array<Record<string, unknown>>, openTasks, 'batch analysis');
}
