/**
 * Tier-2b runner — run authored web tests on the fixture and score first-run-
 * pass-rate + false-green-rate.
 *
 *   npm run chat-eval:fixture                 # Stage 1: hand-seeded golden steps,
 *                                             #   DETERMINISTIC, zero LLM spend
 *   npm run chat-eval:fixture -- --author     # Stage 2: agent authors on the live
 *                                             #   fixture (LLM — costs tokens)
 *   npm run chat-eval:fixture -- --only=checkout
 *
 * Stage 1 proves the rig (fixture + run primitive + scoring discriminate clean vs
 * broken) with a pinned-selector golden step set — no authoring loop, no LLM.
 * Stage 2 measures the real agent. See claude-plans/tier2b-run-on-fixture-web-20260724.md.
 *
 * Manual tool (src/scripts). Not CI. Boots the fixture in-process and MUST
 * process.exit() at the end — inherited Redis/BullMQ/browserPool keep the loop alive.
 */

import * as dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });
// Eval hygiene: no per-step screenshot uploads to Supabase (default is ON).
process.env.SCREENSHOT_EACH_STEP_ENABLED = 'false';
if (!process.env.LOG_LEVEL && !process.env.EVAL_VERBOSE) process.env.LOG_LEVEL = 'warn';

import type { Server } from 'http';
import { FIXTURE_SCENARIOS } from './fixture-scenarios';
import { resetFixtureFlags, setFixtureFlag, runStepsOnFixture } from './fixture-runner';
import { authorOnFixture } from './author-on-fixture';
import { scoreFixtureRun, aggregateFixture } from './fixture-scoring';
import type { FixtureScenario, FixtureScore } from './fixture-types';
import { registerBuiltinResourceAdapters } from '@/services/test-resource';
import {
  seedEvalCredential,
  deleteEvalCredential,
  cleanupEvalUserBilling,
  type SeededCredential,
} from './seed-eval-credential';

const fixtureServer = require('./fixture/server') as {
  start: (port?: number) => Promise<Server>;
  PORT: number;
  HOST: string;
};

interface Args {
  author: boolean;
  only?: string;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { author: false };
  for (const a of argv) {
    if (a === '--author') args.author = true;
    else if (a.startsWith('--only=')) args.only = a.slice(7).toLowerCase();
  }
  return args;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Score one scenario in Stage 1 (golden) or Stage 2 (authored) mode. */
async function scoreScenario(
  scenario: FixtureScenario,
  baseUrl: string,
  author: boolean,
  seededCredential?: SeededCredential,
): Promise<FixtureScore> {
  const startUrl = `${baseUrl}${scenario.startPath}`;
  const hasFlagPairing = !!scenario.breaksUnderFlag;

  // Obtain the step set (golden = deterministic; authored = live agent).
  let steps = scenario.goldenSteps;
  let authoredAssertion: string | null | undefined;
  let assertKind: import('./author-on-fixture').AuthoredAssertKind | undefined;
  // Rung-4: replay must apply the bound credential secret, or `{{secrets.*}}`
  // resolves to nothing and a login test 401s.
  let resourceBindings: import('@/types').TestJobData['resourceBindings'];
  if (author) {
    process.stdout.write(' authoring…');
    const authored = await authorOnFixture(scenario, baseUrl, seededCredential);
    authoredAssertion = authored.authoredAssertion;
    assertKind = authored.assertKind;
    if (!authored.ok) {
      // Authoring failed → a red first-run (counted), false-green N/A.
      return scoreFixtureRun({
        scenarioId: scenario.id, source: 'authored',
        cleanOutcome: { passed: false, status: 'author-failed', stepsRun: 0, errorSummary: authored.error ?? authored.reason },
        hasFlagPairing, authoredAssertion, assertKind,
      });
    }
    steps = authored.steps;
    resourceBindings = authored.resourceBindings;
  }

  // Clean run.
  await resetFixtureFlags(baseUrl);
  process.stdout.write(' clean…');
  const cleanOutcome = await runStepsOnFixture(steps, startUrl, { resourceBindings });

  // Broken run (only if paired and the clean run passed — a red-on-clean test
  // isn't false-green-measurable, so don't spend a broken run on it).
  let brokenOutcome;
  if (scenario.breaksUnderFlag && cleanOutcome.passed) {
    await setFixtureFlag(baseUrl, scenario.breaksUnderFlag.flagId, true);
    process.stdout.write(' broken…');
    brokenOutcome = await runStepsOnFixture(steps, startUrl, { resourceBindings });
    await resetFixtureFlags(baseUrl);
  }

  const score = scoreFixtureRun({
    scenarioId: scenario.id,
    source: author ? 'authored' : 'golden',
    cleanOutcome,
    brokenOutcome,
    hasFlagPairing,
    authoredAssertion,
    assertKind,
  });

  // Honesty label for credential flows. Rung 4 closed the substrate gap: a
  // credential fill is now frozen as `{{secrets.*}}` against a stored secret and
  // resolved at replay. So the note is only warranted when the binding is
  // ABSENT — with a binding present, a red run is a genuine authoring/flow
  // result and must NOT be excused as "substrate missing".
  if (author && scenario.credentials && !score.firstRunPass) {
    // A binding being EMITTED is not proof it RESOLVED. If the run errored
    // before/while applying it (missing resource, empty secret, FK cascade),
    // that is still a substrate failure and must not be labelled a genuine
    // authoring result — that mislabelling is the thing this note exists to
    // prevent.
    const bindingApplied = !!resourceBindings?.length && cleanOutcome.status !== 'error';
    score.notes.push(
      bindingApplied
        ? 'credential-bearing flow WITH a bound credential secret that applied cleanly — this '
          + 'red is a real authoring/flow result, not the substrate gap.'
        : resourceBindings?.length
          ? 'credential-bearing flow: a binding was emitted but the run ERRORED — the secret may '
            + 'not have applied (missing/empty resource). Treat as a substrate failure, not an '
            + 'authoring result.'
          : 'credential-bearing flow: the agent froze NO credential placeholder, so the authored '
            + 'test is not self-contained (no binding emitted). Credential-store gap — check that '
            + 'the login fields classify as credentials and that a secret was seeded.',
    );
  }
  return score;
}

async function main(): Promise<void> {
  // Boot wiring the API/worker entrypoints do for us. A standalone script gets
  // an EMPTY adapter registry, so seeding or applying a `secret` dies with
  // "No adapter registered for resource kind 'secret'". Same class of bug as the
  // empty skill registry that bit rung 1 — see LESSONS.
  registerBuiltinResourceAdapters();

  const args = parseArgs(process.argv.slice(2));
  const scenarios = FIXTURE_SCENARIOS.filter((s) => !args.only || `${s.id} ${s.name}`.toLowerCase().includes(args.only));
  if (scenarios.length === 0) {
    console.error('No fixture scenarios matched the filter.');
    process.exit(1);
  }

  const server = await fixtureServer.start();
  const baseUrl = `http://${fixtureServer.HOST}:${fixtureServer.PORT}`;
  const stage = args.author ? 'Stage 2 (agent authors on the live fixture — LLM)' : 'Stage 1 (hand-seeded golden steps — deterministic, no LLM)';

  console.log(`\nTier-2b run-on-fixture — ${stage}`);
  console.log(`Fixture: ${baseUrl}   Scenarios: ${scenarios.length}\n`);

  // Rung-4: put the fixture's demo login into the REAL encrypted credential
  // store so authored login steps can bind to it and resolve at replay. Seeded
  // once per run, only when a scenario actually needs credentials, and always
  // deleted in the `finally` below.
  const needsCredential = args.author && scenarios.some((s) => s.credentials);
  let seededCredential: SeededCredential | undefined;
  if (needsCredential) {
    const withCreds = scenarios.find((s) => s.credentials)!;
    seededCredential = await seedEvalCredential(withCreds.credentials!);
    console.log(`Credential store: seeded secret ${seededCredential.resourceId} `
      + `(keys: ${seededCredential.emailKey}, ${seededCredential.passwordKey})\n`);
  }

  const scores: FixtureScore[] = [];
  try {
    for (const scenario of scenarios) {
      process.stdout.write(`▶ ${scenario.id.padEnd(22)}`);
      // Only credential-bearing scenarios get the binding.
      const score = await scoreScenario(
        scenario, baseUrl, args.author,
        scenario.credentials ? seededCredential : undefined,
      );
      scores.push(score);
      const clean = score.firstRunPass ? 'PASS' : 'FAIL';
      const broken = score.falseGreenEligible ? (score.falseGreen ? ' ⚠ FALSE-GREEN' : ' ✓ caught') : '';
      process.stdout.write(`  → clean:${clean}${broken}\n`);
    }
  } finally {
    if (seededCredential) {
      await deleteEvalCredential(seededCredential.resourceId);
      // A bound run bills per step, which provisions credit rows for the
      // synthetic user. Drop them so repeat runs don't accrete billing debris.
      await cleanupEvalUserBilling();
    }
    await resetFixtureFlags(baseUrl).catch(() => { /* ignore */ });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const summary = aggregateFixture(scores);

  console.log('\n─── Per-scenario ───');
  for (const s of summary.perScenario) {
    console.log(`  ${s.scenarioId.padEnd(22)} first-run:${s.firstRunPass ? 'PASS' : 'FAIL'}`
      + `${s.falseGreenEligible ? `  false-green:${s.falseGreen ? 'YES ⚠' : 'no'}` : ''}`);
    for (const n of s.notes) console.log(`      ↳ ${n}`);
  }

  console.log('\n─── Tier-2b baseline ───');
  console.log(`  first-run-pass-rate: ${pct(summary.firstRunPassRate)}  (${summary.firstRunPasses}/${summary.firstRunDenom})`);
  if (summary.falseGreenDenom > 0) {
    console.log(`  false-green-rate:    ${pct(summary.falseGreenRate)}  (${summary.falseGreens}/${summary.falseGreenDenom} eligible)`);
  } else {
    console.log('  false-green-rate:    n/a — no scenario was false-green-eligible this run');
  }
  console.log(
    args.author
      ? '\n  Stage 2: numbers reflect the LIVE agent. Read the per-scenario "authored assertion"\n  notes — a null assertion is itself the finding (plan §5), not a clean pass.\n'
      : '\n  Stage 1: deterministic rig proof (no LLM). Run with --author for the live agent.\n',
  );

  // Inherited Redis/BullMQ/browserPool keep the event loop alive — exit explicitly.
  // Stage 1 (golden) is the deterministic rig-proof: a false-green there is a rig
  // REGRESSION → non-zero exit. Stage-2 false-greens are agent findings, not rig
  // faults, so they don't hard-fail.
  const rigClean = args.author || summary.falseGreens === 0;
  process.exit(summary.firstRunPasses === summary.firstRunDenom && rigClean ? 0 : 1);
}

main().catch((err) => {
  console.error('[chat-eval:fixture] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
