/**
 * One-run token instrumentation for the chat authoring pipeline.
 *
 * Patches getChatCompletionWithMessages to record every LLM call's tokens +
 * cost (attributed to the calling sub-agent via the stack), replays ONE
 * scenario, and prints a per-call breakdown + total. Answers "where do the
 * tokens go, and what does one authoring turn really cost".
 *
 * ⚠️ One live LLM run (~$0.10-0.20). Manual. Needs OPENAI_API_KEY.
 * Run: npm run chat-eval:instrument            # default: add-login-happy
 *      npm run chat-eval:instrument -- edit-add-step
 */

import * as dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });
if (!process.env.LOG_LEVEL && !process.env.EVAL_VERBOSE) process.env.LOG_LEVEL = 'warn';

import * as openaiService from '@/services/ai/core/openai.service';
import { calculateOpenAICost } from '@/services/ai/tracking/ai-usage-tracker';
import { BOOTSTRAP_SCENARIOS } from './scenarios';
import { replayScenario } from './replay';
import { scoreCapturedRun } from './scoring';

interface CallRecord {
  seq: number;
  agent: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUSD: number;      // actual, cache-discounted
  fullCostUSD: number;  // hypothetical, as if nothing was cached
}

const calls: CallRecord[] = [];

/** Attribute a call to the sub-agent that made it, from the stack trace. */
function detectAgent(stack: string): string {
  const known = [
    'router-agent', 'planner-agent', 'executor-agent', 'sub-executor',
    'reviewer-agent', 'step-validator-agent', 'responder', 'quick-actions',
  ];
  for (const name of known) {
    if (stack.includes(name)) return name.replace(/-agent$/, '');
  }
  return 'other';
}

// ── Patch the LLM client (CommonJS module property → agents pick this up) ────
const original = openaiService.getChatCompletionWithMessages;
(openaiService as any).getChatCompletionWithMessages = async function instrumented(
  ...args: Parameters<typeof original>
): ReturnType<typeof original> {
  const agent = detectAgent(new Error().stack || '');
  const res = await original(...args);
  const { inputTokens, outputTokens, model, cachedInputTokens } = res.usage;
  const cached = cachedInputTokens ?? 0;
  calls.push({
    seq: calls.length + 1,
    agent,
    model,
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    costUSD: calculateOpenAICost(model, inputTokens, outputTokens, cached),
    fullCostUSD: calculateOpenAICost(model, inputTokens, outputTokens, 0),
  });
  return res;
};

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}
function padL(s: string | number, n: number): string {
  return String(s).padStart(n);
}

async function main(): Promise<void> {
  const id = process.argv[2] || 'add-login-happy';
  const scenario = BOOTSTRAP_SCENARIOS.find((s) => s.id === id);
  if (!scenario) {
    console.error(`Unknown scenario "${id}". Options: ${BOOTSTRAP_SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`\nInstrumenting one replay: ${scenario.id} (${scenario.scope})\n  "${scenario.userMessage}"\n`);

  const run = await replayScenario(scenario);

  console.log('─── Per-call token breakdown ───');
  console.log(`  ${pad('#', 3)} ${pad('agent', 16)} ${pad('model', 16)} ${padL('in', 8)} ${padL('cached', 7)} ${padL('out', 7)} ${padL('cost $', 9)}`);
  for (const c of calls) {
    console.log(`  ${pad(c.seq, 3)} ${pad(c.agent, 16)} ${pad(c.model, 16)} ${padL(c.inputTokens, 8)} ${padL(c.cachedInputTokens, 7)} ${padL(c.outputTokens, 7)} ${padL(c.costUSD.toFixed(4), 9)}`);
  }

  const inTot = calls.reduce((a, c) => a + c.inputTokens, 0);
  const cachedTot = calls.reduce((a, c) => a + c.cachedInputTokens, 0);
  const outTot = calls.reduce((a, c) => a + c.outputTokens, 0);
  const costTot = calls.reduce((a, c) => a + c.costUSD, 0);
  const fullCostTot = calls.reduce((a, c) => a + c.fullCostUSD, 0);

  // Per-agent rollup.
  const byAgent = new Map<string, { calls: number; in: number; cached: number; out: number; cost: number }>();
  for (const c of calls) {
    const e = byAgent.get(c.agent) ?? { calls: 0, in: 0, cached: 0, out: 0, cost: 0 };
    e.calls++; e.in += c.inputTokens; e.cached += c.cachedInputTokens; e.out += c.outputTokens; e.cost += c.costUSD;
    byAgent.set(c.agent, e);
  }

  console.log('\n─── Per-agent rollup ───');
  for (const [agent, e] of [...byAgent.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    const share = costTot > 0 ? ((e.cost / costTot) * 100).toFixed(0) : '0';
    console.log(`  ${pad(agent, 16)} ${e.calls} call(s)  in=${e.in}  cached=${e.cached}  out=${e.out}  $${e.cost.toFixed(4)}  (${share}%)`);
  }

  console.log('\n─── Request ───');
  console.log(`  ${scenario.userMessage}`);

  console.log('\n─── Authored steps (the response payload) ───');
  if (run.steps.length === 0) {
    console.log('  (none)');
  } else {
    run.steps.forEach((s, i) => {
      console.log(`  ${padL(i + 1, 2)}. [${pad(s.type ?? '?', 9)}] value:${pad(s.valueShape ?? '-', 11)} ${s.description ?? ''}`);
    });
  }

  console.log('\n─── Agent reply (responder text) ───');
  console.log(`  ${(run.content ?? '(empty)').replace(/\n/g, '\n  ')}`);

  const score = scoreCapturedRun(scenario, run);
  console.log('\n─── Deterministic score (Tier-2a) ───');
  console.log(`  passed=${score.passed}  produced=${score.producedSteps} toolChoice=${score.toolChoiceCorrect} noDup=${score.noDuplicate} wellFormed=${score.stepsWellFormed} grounded=${score.grounded}`);
  if (score.reasons.length > 0) console.log(`  reasons: ${score.reasons.join('; ')}`);

  const cacheHitPct = inTot > 0 ? ((cachedTot / inTot) * 100).toFixed(0) : '0';
  const savedUSD = fullCostTot - costTot;
  const savedPct = fullCostTot > 0 ? ((savedUSD / fullCostTot) * 100).toFixed(0) : '0';

  console.log('\n─── Totals ───');
  console.log(`  LLM calls:      ${calls.length}`);
  console.log(`  Input tokens:   ${inTot}  (cached: ${cachedTot}, ${cacheHitPct}% of input)`);
  console.log(`  Output tokens:  ${outTot}`);
  console.log(`  Cost (1 run):   $${costTot.toFixed(4)}  (no-cache would be $${fullCostTot.toFixed(4)} → saved $${savedUSD.toFixed(4)}, ${savedPct}%)`);
  console.log(`  Extrapolated 8×1: ~$${(costTot * 8).toFixed(2)}   |   8×3: ~$${(costTot * 24).toFixed(2)}`);
  console.log(`\n  Replay outcome: ok=${run.ok} path=${run.pipelinePath ?? '-'} authoredVia=[${run.authoredVia.join(',')}] steps=${run.steps.length}${run.error ? ` error=${run.error}` : ''}`);
  if (cachedTot === 0) {
    console.log('\n  Note: cached=0 across all calls. OpenAI auto-caches identical ≥1024-token\n  prefixes seen within ~5-10 min; a single cold replay may show no hit on the\n  first executor call. Re-run back-to-back, or check the 2nd executor call.\n');
  } else {
    console.log('\n  Note: "cached" is OpenAI automatic prompt caching on the repeated executor\n  prefix (tool schemas + system prompt). Cost above already applies the\n  cache-hit discount (cachedInput rate in ai-cost-manager.service.ts).\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[instrument] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
