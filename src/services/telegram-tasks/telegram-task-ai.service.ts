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
import { aliasHint, canonicalOwner } from './owner-aliases';

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
  /** True when the message is addressed to the bot (@mention / reply-to-bot).
   *  The model then decides itself whether it's a question (answer via `reply`)
   *  or an action (emit actions) — no keyword routing on our side. */
  addressedToBot: boolean;
}

export interface ReconcileResult {
  actions: Action[];
  /** Natural-language message to post back, if the model produced one. */
  reply: string | null;
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
        reply: {
          type: ['string', 'null'],
          description:
            'Optional natural-language message to post back to the group. Use ONLY when the message is addressed to the bot (a question to answer, or a confirmation). Leave null/empty for ordinary digest/status messages — those get a separate system ack.',
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
    'progress — use ONLY when the message is the task OWNER explicitly reporting',
    '          the state of THEIR OWN work on a specific open task. The sentence',
    '          must be ABOUT doing the work, in first person:',
    '            in_progress — "I\'m working on it", "почти готово", "1-2 days left"',
    '            blocked — "I\'m blocked on X", "жду Y, не могу продолжить"',
    '            needs_investigation — "I dug in, turns out it\'s hard", "I need to',
    '              investigate more"',
    '          This is a HIGH BAR. If you are not clearly seeing the owner narrate',
    '          their own progress, do NOT emit progress. In particular these are',
    '          NEVER progress (they are facts/opinions/instructions/questions, not',
    '          a work status) — emit touch if they clearly point at one open task,',
    '          otherwise emit NOTHING:',
    '            • how-to / instructions / opinions: "надо писать в точ точ как в',
    '              логе", "we should do X", "лучше через Y", a pasted log/screenshot',
    '            • facts or observations: "Chat session not found", "типа", an error',
    '              text, a quote',
    '            • "I didn\'t check / не проверял / не знаю", answering or asking a',
    '              question, or anyone who is NOT the owner commenting',
    '          When in doubt between progress and touch, choose touch. When in',
    '          doubt between touch and nothing, choose nothing.',
    'touch   — the message refers to a SPECIFIC open task but carries no real',
    '          owner-status ("is this actual?", "what is the plan?", "this is',
    '          done?", a discussion of how to do it). Resets the staleness clock',
    '          only. If the message does not clearly point at one specific open',
    '          task, emit NOTHING instead of touch.',
    '',
    'OWNER: copy the @username verbatim (with @) when present. If only a plain name',
    'is given ("Marketing doc - Serzhan", "... - Bauka"), use that name as owner. If',
    'a line names several people ("@a and me have to test ..."), pick the primary',
    'owner (the first / the one being asked) for owner; "me" means the AUTHOR.',
    '',
    'PRIORITY when unsure: prefer reusing an existing task_id over create; prefer',
    'touch over progress/close when the message is vague; never close on a',
    'question; never set progress on "I don\'t know / didn\'t check". If a message',
    'does nothing task-related (chatter "тут почему?", "Хотя да", "ok"; or just',
    'answering someone\'s question like "I didn\'t check"), emit NO actions at all',
    'unless it clearly references a specific open task (then at most touch).',
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
    '• reply "I didnot check" (answering "do deps work in JP?")  → (no actions —',
    '  not knowing is NOT a status)',
    '• "надо прям в точ точ как в логе писать" + a log screenshot  → (no actions —',
    '  an instruction about HOW to do it, not a work status)',
    '• "Chat session not found" / "типа"  → (no actions — a fact/observation)',
    '',
    'IF SOMEONE ASKS WHAT YOU CAN DO (your capabilities), put this in `reply`:',
    'You track the group\'s tasks automatically — you read daily "Priorities"',
    'digests into tracked tasks (project + owner + status), close them when',
    'someone reports done, record status updates (in progress / blocked / needs',
    'investigation), ask owners each morning about unclear tasks, and answer',
    'questions about the tasks when @mentioned or replied to.',
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

/** One forced tool call → parsed `{actions, reply}` (or empty on any failure). */
async function callReconcileTool(
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ actions: unknown[]; reply: string | null }> {
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
    if (!argStr) return { actions: [], reply: null };
    const parsed = JSON.parse(argStr) as { actions?: unknown; reply?: unknown };
    return {
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : null,
    };
  } catch (err) {
    logger.error('[TELEGRAM_TASKS] reconcile LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { actions: [], reply: null };
  }
}

export async function reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
  const openHeader =
    ctx.hiddenOpenCount > 0
      ? `OPEN TASKS (most recent ${ctx.openTasks.length}; ${ctx.hiddenOpenCount} older open tasks not shown):`
      : 'OPEN TASKS:';

  const addressedBlock = ctx.addressedToBot
    ? [
        '',
        'THE USER ADDRESSED YOU DIRECTLY (@mention or reply to your message).',
        'Decide what they want — you, not a keyword rule:',
        '  • A QUESTION about the tasks ("what is open?", "what does @dara have',
        '    left?", "what can you do?") → put a concise, grounded answer in',
        '    `reply` and emit NO actions. Answer ONLY from the open tasks above;',
        '    if the data does not contain it, say so. Reply in the user\'s language.',
        '  • An ACTION ("done", "close the video task", "in progress 2 days") →',
        '    emit the actions as usual; `reply` may be a short confirmation or null.',
      ].join('\n')
    : '';

  const userBlock = [
    'RECENT CHAT (oldest first, for resolving references like "the first one"):',
    renderRecent(ctx.recentMessages),
    '',
    `AUTHOR: ${ctx.author ?? 'unknown'}${ctx.isManager ? ' (MANAGER)' : ''}`,
    ctx.replyToTaskIds.length ? `REPLYING TO TASK(S): ${ctx.replyToTaskIds.join(', ')}` : 'REPLYING TO: (not a reply / unknown)',
    '',
    openHeader,
    renderOpenTasks(ctx.openTasks),
    addressedBlock,
    '',
    'NEW MESSAGE (act only on THIS message; the recent chat is context):',
    `"""${ctx.text}"""`,
  ].join('\n');

  const raw = await callReconcileTool(buildSystem(), userBlock, 1500);
  return {
    actions: validateActions(raw.actions as Array<Record<string, unknown>>, ctx.openTasks, ctx.text, {
      owner: canonicalOwner(ctx.author) ?? undefined,
      isManager: ctx.isManager,
    }),
    reply: raw.reply,
  };
}

const PROGRESS_STATES = new Set<ProgressState>(['in_progress', 'blocked', 'needs_investigation']);

/** Narrow raw model output to safe, known-task actions. Reused by reconcile()
 *  and the overnight batch. Drops anything malformed or referencing an
 *  out-of-context task id.
 *
 *  `actor` (per-message path only) enforces authority deterministically, so a
 *  prompt slip can't let a non-owner mutate a task: close/reopen/progress on a
 *  task survive ONLY if the actor owns that task or is a manager. Omitted on the
 *  batch path (it reasons over the whole day, not one author). */
export function validateActions(
  raw: Array<Record<string, unknown>>,
  openTasks: AiTaskView[],
  fallbackReason: string,
  actor?: { owner: string | undefined; isManager: boolean },
): Action[] {
  const openIds = new Set(openTasks.map((t) => t.id));
  const ownerById = new Map(openTasks.map((t) => [t.id, t.owner] as const));
  /** Can `actor` change the status of this task? Owner of it, or a manager.
   *  No actor (batch) → allowed. Unowned task → allowed (anyone can advance it). */
  const mayMutate = (taskId: string): boolean => {
    if (!actor) return true;
    if (actor.isManager) return true;
    const owner = ownerById.get(taskId);
    if (!owner) return true;
    return !!actor.owner && owner.toLowerCase() === actor.owner.toLowerCase();
  };
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
      // Status-changing → authority-gated. A non-owner non-manager close is
      // downgraded to touch (the task is clearly being discussed) rather than
      // dropped, so it still resets the staleness clock.
      if (mayMutate(a.task_id)) {
        out.push({ kind: 'close', task_id: a.task_id, reason: typeof a.reason === 'string' ? a.reason : fallbackReason });
      } else {
        out.push({ kind: 'touch', task_id: a.task_id });
      }
    } else if (kind === 'reopen') {
      if (mayMutate(a.task_id)) out.push({ kind: 'reopen', task_id: a.task_id });
      else out.push({ kind: 'touch', task_id: a.task_id });
    } else if (kind === 'touch') {
      out.push({ kind: 'touch', task_id: a.task_id });
    } else if (kind === 'progress' && PROGRESS_STATES.has(a.state as ProgressState)) {
      if (mayMutate(a.task_id)) {
        out.push({
          kind: 'progress',
          task_id: a.task_id,
          state: a.state as ProgressState,
          note: typeof a.note === 'string' ? a.note : fallbackReason,
        });
      } else {
        out.push({ kind: 'touch', task_id: a.task_id });
      }
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
  // Batch mode never produces a `reply` — it only resolves statuses.
  return validateActions(raw.actions as Array<Record<string, unknown>>, openTasks, 'batch analysis');
}
