/**
 * Prompt/logic eval for QAIT Tasker — runs REAL reconcile() calls against the
 * live model and checks the produced actions against expectations.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/eval-telegram-tasks.ts
 *
 * Needs OPENAI_API_KEY in env/.env (same key the bot uses). Read-only: no DB
 * writes, no Telegram — it only exercises the AI layer.
 *
 * Each case asserts on the SET of action kinds (+ a few field checks). The model
 * is non-deterministic, so a single fail isn't necessarily a prompt bug — but a
 * consistent fail across runs is. Re-run a couple of times.
 */
import 'dotenv/config';
import { reconcile, type AiTaskView, type Action } from '@/services/telegram-tasks/telegram-task-ai.service';

// ── fixture tasks (the open board the model reasons against) ─────────────────
const T = (id: string, over: Partial<AiTaskView> = {}): AiTaskView => ({
  id, project: null, title: 't', owner: null, progress: 'none',
  progress_note: null, has_deadline: false, due_text: null, due_at: null, link: null, ...over,
});

const VIDEO = T('11111111-1111-1111-1111-111111111111', { project: 'JP', title: 'Video not playing', owner: '@gipardb' });
const AICHECK = T('22222222-2222-2222-2222-222222222222', { project: 'JP', title: 'AI check bugs', owner: '@ndarkhans' });
const POINTER = T('33333333-3333-3333-3333-333333333333', { project: 'JP', title: 'Pointer', owner: '@YerassylOspan' });

interface Case {
  name: string;
  text: string;
  author?: string;
  isManager?: boolean;
  open?: AiTaskView[];
  replyToTaskIds?: string[];
  addressedToBot?: boolean;
  // assertion over the resulting action kinds (sorted, deduped) + optional extra check
  expectKinds: string[]; // exact set expected (sorted)
  check?: (actions: Action[]) => string | null; // return error string or null
}

const CASES: Case[] = [
  {
    name: 'digest creates many tasks (question in line is still a create)',
    text: 'JP\n1. Video not playing - @gipardb - what is the plan?\n2. AI check bugs - @ndarkhans - today',
    isManager: true,
    open: [],
    expectKinds: ['create', 'create'],
    check: (a) => (a.every((x) => x.kind === 'create') ? null : 'expected only creates'),
  },
  {
    name: 'owner reports done → close',
    text: 'merged and deployed',
    author: '@gipardb',
    open: [VIDEO, AICHECK],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['close'],
  },
  {
    name: '"I didn\'t check" is NOT a status',
    text: 'I didnot check',
    author: '@YerassylOspan',
    open: [VIDEO, AICHECK],
    expectKinds: [], // no actions (or at most touch — see check)
    check: (a) => (a.every((x) => x.kind === 'touch') ? null : 'expected no progress/close'),
  },
  {
    name: 'fact/instruction is NOT a status (manager)',
    text: 'надо прям в точ точ как в логе писать',
    author: '@bauyrzhan',
    isManager: true,
    open: [VIDEO],
    expectKinds: [],
    check: (a) => (a.some((x) => x.kind === 'progress') ? 'wrongly set progress' : null),
  },
  {
    name: 'owner narrates blocked → progress(blocked)',
    text: "I'm blocked on the API, can't continue",
    author: '@gipardb',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['progress'],
    check: (a) => (a[0]?.kind === 'progress' && a[0].state === 'blocked' ? null : 'expected blocked'),
  },
  {
    name: 'claim with no deadline → claim',
    text: 'беру это на себя',
    author: '@gipardb',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['claim'],
  },
  {
    name: 'deadline + blocker in one reply → set_deadline + progress(blocked)',
    text: 'by Friday, blocked on the API',
    author: '@gipardb',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['progress', 'set_deadline'],
  },
  {
    name: 'pure chatter → no actions',
    text: 'Хотя да',
    author: '@x',
    open: [VIDEO],
    expectKinds: [],
  },
  {
    name: 'non-owner "done" → downgraded to touch (authority guard)',
    text: 'this is done',
    author: '@stranger',
    open: [VIDEO],
    expectKinds: ['touch'],
  },
  {
    name: 'Q&A: addressed question → reply, no actions',
    text: '@qait_task_bot what tasks does @gipardb have?',
    author: '@YerassylOspan',
    addressedToBot: true,
    open: [VIDEO, POINTER],
    expectKinds: [],
  },
];

function kinds(actions: Action[]): string[] {
  return actions.map((a) => a.kind).sort();
}

async function run(): Promise<void> {
  let pass = 0;
  for (const c of CASES) {
    let actions: Action[] = [];
    let reply: string | null = null;
    let err: string | null = null;
    try {
      const r = await reconcile({
        text: c.text,
        author: c.author,
        isManager: c.isManager ?? false,
        replyToTaskIds: c.replyToTaskIds ?? [],
        openTasks: c.open ?? [],
        hiddenOpenCount: 0,
        recentMessages: [],
        addressedToBot: c.addressedToBot ?? false,
      });
      actions = r.actions;
      reply = r.reply;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    const got = kinds(actions);
    const want = [...c.expectKinds].sort();
    const kindsOk = JSON.stringify(got) === JSON.stringify(want);
    const checkErr = !err && c.check ? c.check(actions) : null;
    const ok = !err && kindsOk && !checkErr;
    if (ok) pass++;

    console.log(`${ok ? '✅' : '❌'} ${c.name}`);
    if (!ok) {
      if (err) console.log(`     ERROR: ${err}`);
      else {
        if (!kindsOk) console.log(`     kinds: got [${got}] want [${want}]`);
        if (checkErr) console.log(`     check: ${checkErr}`);
        console.log(`     actions: ${JSON.stringify(actions)}`);
        if (reply) console.log(`     reply: ${reply.slice(0, 120)}`);
      }
    }
  }
  console.log(`\n${pass}/${CASES.length} passed`);
}

void run();
