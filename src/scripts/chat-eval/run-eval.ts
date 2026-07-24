/**
 * Chat authoring eval harness (Tier-2a, deterministic) — the baseline runner.
 *
 * Replays each bootstrap scenario N times through the REAL
 * Planner→Executor→Reviewer pipeline (headless) and scores the authored steps
 * structurally: produced steps? right write tool (edit-in-place vs create)? no
 * duplicate? well-formed? Prints a per-scenario scorecard + an overall pass-rate
 * baseline, and flags agent flakiness (passed some runs, not all).
 *
 * ⚠️ Hits the live LLM — costs tokens, non-deterministic. MANUAL tool, not CI
 * (lives in src/scripts/). Needs OPENAI_API_KEY (+ Gemini key if the pipeline
 * routes there) in qai-backend/.env. No DB writes (single-shot confirm-gate),
 * no app run (that's Tier-2b). Scores off a BIASED bootstrap corpus — see
 * scenarios.ts.
 *
 * Run:
 *   npm run chat-eval                    # all scenarios, N=3
 *   npm run chat-eval -- --runs=5        # N=5
 *   npm run chat-eval -- --scope=edit    # only edit scenarios
 *   npm run chat-eval -- --only=login    # substring match on scenario id/name
 */

// Load env before any '@/' import pulls in a module that reads it (mirrors
// eval-kb.ts) — keeps the harness runnable standalone via ts-node.
import * as dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });
if (!process.env.LOG_LEVEL && !process.env.EVAL_VERBOSE) {
  process.env.LOG_LEVEL = 'warn'; // keep the scorecard readable
}

import { BOOTSTRAP_SCENARIOS } from './scenarios';
import { replayScenario } from './replay';
import { aggregate, scoreCapturedRun } from './scoring';
import type { Scenario, ScenarioScore } from './types';

interface Args {
  runs: number;
  scope?: 'add' | 'edit';
  only?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 3 };
  for (const arg of argv) {
    if (arg.startsWith('--runs=')) args.runs = Math.max(1, parseInt(arg.slice(7), 10) || 3);
    else if (arg === '--scope=add') args.scope = 'add';
    else if (arg === '--scope=edit') args.scope = 'edit';
    else if (arg.startsWith('--only=')) args.only = arg.slice(7).toLowerCase();
  }
  return args;
}

function selectScenarios(args: Args): Scenario[] {
  return BOOTSTRAP_SCENARIOS.filter((s) => {
    if (args.scope && s.scope !== args.scope) return false;
    if (args.only && !`${s.id} ${s.name}`.toLowerCase().includes(args.only)) return false;
    return true;
  });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = selectScenarios(args);

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.');
    process.exit(1);
  }

  console.log(`\nChat authoring eval (Tier-2a, deterministic) — ${scenarios.length} scenario(s) × ${args.runs} run(s)\n`);
  console.log('⚠️  BIASED bootstrap corpus + live non-deterministic LLM. Directional, not ground truth.\n');

  const scored: Array<{ scenarioId: string; score: ScenarioScore }> = [];

  // Sequential — keeps LLM rate-limits + log output readable (as eval-intent).
  for (const scenario of scenarios) {
    process.stdout.write(`▶ ${scenario.id} (${scenario.scope}) `);
    for (let i = 0; i < args.runs; i++) {
      const run = await replayScenario(scenario);
      const score = scoreCapturedRun(scenario, run);
      scored.push({ scenarioId: scenario.id, score });
      // ○ = uncapturable (uninstrumented tool, excluded from the rate), not a fail.
      process.stdout.write(score.uncapturable ? '○' : score.passed ? '✓' : '✗');
    }
    process.stdout.write('\n');
  }

  const summary = aggregate(scored);

  console.log('\n─── Per-scenario ───');
  for (const s of summary.perScenario) {
    const flag = s.flaky ? '  ⚠ flaky' : '';
    const unc = s.uncapturableRuns > 0 ? `  ○${s.uncapturableRuns} uncapturable` : '';
    const rate = s.runs > 0 ? `${pct(s.passRate).padStart(4)}  (${s.passes}/${s.runs})` : ' n/a  (0 capturable)';
    console.log(`  ${s.scenarioId.padEnd(24)} ${rate}${flag}${unc}`);
    if (s.sampleReasons.length > 0) {
      console.log(`      ↳ ${s.sampleReasons.join('; ')}`);
    }
  }

  console.log('\n─── Baseline ───');
  if (summary.totalRuns > 0) {
    console.log(`  Overall pass-rate: ${pct(summary.passRate)} (${summary.totalPasses}/${summary.totalRuns} capturable)`);
  } else {
    console.log('  Overall pass-rate: n/a — every run was uncapturable (see below)');
  }
  if (summary.totalUncapturable > 0) {
    console.log(`  Uncapturable:      ${summary.totalUncapturable} run(s) authored via qa_author_test_iteratively — excluded (needs Tier-2b).`);
  }
  if (summary.flakyScenarioIds.length > 0) {
    console.log(`  Flaky scenarios:   ${summary.flakyScenarioIds.join(', ')}`);
  }
  console.log(
    '\n  Note: deterministic (Tier-2a) only — no first-run-pass-rate / false-green yet.\n' +
    '  Those need the run-on-fixture tier (2b). See the plan §3-4.\n',
  );

  // Non-zero exit only on a real failure (a capturable run that didn't pass).
  // Uncapturable runs are excluded, so an all-uncapturable batch exits 0 (nothing
  // was measured to fail) rather than false-red-ing CI.
  process.exit(summary.totalPasses === summary.totalRuns ? 0 : 1);
}

main().catch((err) => {
  console.error('[chat-eval] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
