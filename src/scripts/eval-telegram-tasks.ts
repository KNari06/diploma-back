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
  id, project: null, title: 't', owner: null, lifecycle: 'open',
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
  allowTouch?: boolean; // ignore a harmless `touch` when matching expectKinds
  check?: (actions: Action[]) => string | null; // return error string or null
}

const CASES: Case[] = [
  // 1 — digest creates many tasks (a question inside a line is still a create)
  {
    name: '1. digest → many creates',
    text: 'JP\n1. Video not playing - @gipardb - what is the plan?\n2. AI check bugs - @ndarkhans - today',
    isManager: true,
    open: [],
    expectKinds: ['create', 'create'],
    check: (a) => (a.every((x) => x.kind === 'create') ? null : 'expected only creates'),
  },
  // 2 — owner reports done, REPLYING to that task → close (allowed: reply-linked)
  {
    name: '2. owner "merged" replying to task → close',
    text: 'merged and deployed',
    author: '@gipardb',
    open: [VIDEO, AICHECK],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['close'],
  },
  // 3 — THE BUG: "merged" with NO reply, naming unrelated work → must NOT close
  {
    name: '3. "merged MR about runner" no reply → NO close (guess-close guard)',
    text: 'falsely successful steps fix in regressions: merged',
    author: '@ndarkhans',
    open: [VIDEO, AICHECK, POINTER],
    replyToTaskIds: [],
    expectKinds: [],
    check: (a) => (a.some((x) => x.kind === 'close') ? 'WRONGLY closed a task from a bare merged' : null),
  },
  // 4 — bare "fixed" no reply → no close
  {
    name: '4. bare "fixed" no reply → no close',
    text: 'fixed',
    author: '@ndarkhans',
    open: [VIDEO, AICHECK],
    replyToTaskIds: [],
    expectKinds: [],
    check: (a) => (a.some((x) => x.kind === 'close') ? 'WRONGLY closed on bare fixed' : null),
  },
  // 5 — THE BUG: status remark must NOT become a phantom new task. A harmless
  //     `touch` (resets staleness on the referenced task) is acceptable — only a
  //     phantom create/progress is wrong.
  {
    name: '5. "I\'m doing the USB run" → NOT a new task (touch ok)',
    text: "I'm doing the USB run now",
    author: '@ndarkhans',
    open: [VIDEO],
    expectKinds: [],
    allowTouch: true,
    check: (a) => (a.some((x) => x.kind === 'create' || x.kind === 'progress') ? 'WRONGLY created/progressed a phantom task' : null),
  },
  // 6 — imperative to someone is not a new standalone task (touch ok)
  {
    name: '6. "@bekn проверь JP апк" imperative → not a create (touch ok)',
    text: '@bekn_ur проверь JP апк на проде через свой аккаунт',
    author: '@YerassylOspan',
    isManager: true,
    open: [VIDEO],
    expectKinds: [],
    allowTouch: true,
    check: (a) => (a.some((x) => x.kind === 'create') ? 'created from an imperative aside' : null),
  },
  // 7 — "I didn't check" is not a status
  {
    name: '7. "не проверял" → no status',
    text: 'я ещё не проверял честно говоря',
    author: '@YerassylOspan',
    open: [VIDEO, AICHECK],
    expectKinds: [],
    check: (a) => (a.every((x) => x.kind === 'touch') ? null : 'expected no progress/close'),
  },
  // 8 — instruction/opinion is not progress (touch ok)
  {
    name: '8. instruction "надо как в логе" → not progress (touch ok)',
    text: 'надо прям в точ точ как в логе писать',
    author: '@bauyrzhan',
    isManager: true,
    open: [VIDEO],
    expectKinds: [],
    allowTouch: true,
    check: (a) => (a.some((x) => x.kind === 'progress' || x.kind === 'close') ? 'wrongly set progress/close' : null),
  },
  // 9 — owner narrates blocked (reply) → progress(blocked)
  {
    name: '9. owner blocked (reply) → progress blocked',
    text: "I'm blocked on the API, can't continue",
    author: '@gipardb',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['progress'],
    check: (a) => (a[0]?.kind === 'progress' && a[0].state === 'blocked' ? null : 'expected blocked'),
  },
  // 10 — claim with no deadline (reply) → claim (bot will ask "when?")
  {
    name: '10. "беру на себя" (reply) → claim',
    text: 'беру это на себя',
    author: '@gipardb',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['claim'],
  },
  // 11 — "this task on me" replying to a DIGEST (many tasks) → must ASK, not guess
  {
    name: '11. "this task on me" on digest (2+ tasks) → clarify, not claim',
    text: 'this task on me for today',
    author: '@YerassylOspan',
    open: [VIDEO, AICHECK],
    replyToTaskIds: [VIDEO.id, AICHECK.id],
    expectKinds: ['clarify'],
    check: (a) => (a.some((x) => x.kind === 'claim') ? 'guessed a claim instead of asking' : null),
  },
  // 12 — deadline + blocker in one reply → set_deadline + progress(blocked)
  {
    name: '12. "by Friday, blocked on API" → set_deadline + progress',
    text: 'by Friday, but blocked on the API',
    author: '@gipardb',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['progress', 'set_deadline'],
  },
  // 13 — pure chatter → nothing
  {
    name: '13. chatter "Хотя да" → no actions',
    text: 'Хотя да',
    author: '@x',
    open: [VIDEO],
    expectKinds: [],
  },
  // 14 — non-owner "done" (reply) → downgraded to touch (authority guard)
  {
    name: '14. non-owner "done" (reply) → touch, not close',
    text: 'this is done',
    author: '@stranger',
    open: [VIDEO],
    replyToTaskIds: [VIDEO.id],
    expectKinds: ['touch'],
  },
  // 15 — Q&A addressed to bot → reply, no actions
  {
    name: '15. "@bot what does @gipardb have?" → reply only',
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

    // A harmless `touch` is allowed to be ignored when the case opts in.
    const got = kinds(c.allowTouch ? actions.filter((a) => a.kind !== 'touch') : actions);
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
