/**
 * Eval harness — Jira readiness assessment prompt quality.
 *
 * Runs sample tickets through the readiness prompt (and optionally the query
 * planner) against a REAL LLM, then scores the output vs expectations:
 *   - readiness accuracy   (readyToTest predicted == expected)
 *   - gap-type recall/precision (did it surface the expected gap types?)
 *   - planner term coverage (did planned terms cover the expected areas?)
 *
 * Pure prompt eval — NO database. This is the "Phase 0" that turns prompt
 * quality from opinion into a measured number, before we invest in fancier
 * retrieval.
 *
 * Usage:
 *   npx tsx src/scripts/eval-jira-readiness.ts [fixtures.json] [--planner]
 * Default fixtures: src/scripts/fixtures/jira-readiness-cases.json
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildJiraAnalysisMessages } from '@/ai/prompts/jira-readiness-prompts';
import { TaskReadinessService } from '@/services/testing/analysis/task-readiness.service';
import { RetrievalPlannerService } from '@/services/integrations/retrieval-planner.service';
import type { JiraQaOutcome, ReadinessGapType } from '@/types/testing.types';

interface EvalCase {
  name: string;
  summary: string;
  description?: string;
  expected: {
    readyToTest: boolean;
    gapTypes?: ReadinessGapType[]; // expected forgotten-case types
    areas?: string[];              // expected retrieval areas (for planner coverage)
  };
}

interface CaseResult {
  name: string;
  readyOk: boolean;
  gapRecall: number;
  gapPrecision: number;
  plannerCoverage: number | null;
}

async function runCase(c: EvalCase, usePlanner: boolean): Promise<CaseResult> {
  // Optional planner pass.
  let plannerCoverage: number | null = null;
  if (usePlanner) {
    const plan = await RetrievalPlannerService.plan({ summary: c.summary, description: c.description });
    if (c.expected.areas?.length) {
      const terms = [...plan.searchTerms, ...plan.entities].map((t) => t.toLowerCase());
      const hit = c.expected.areas.filter((a) => terms.some((t) => t.includes(a.toLowerCase()) || a.toLowerCase().includes(t)));
      plannerCoverage = hit.length / c.expected.areas.length;
    }
  }

  // Readiness assessment (context-free — measures the prompt itself).
  const { system, user } = buildJiraAnalysisMessages({
    issueSummary: c.summary,
    issueDescription: c.description ?? null,
    kbContext: '', testCaseContext: '', pastBugsContext: '',
    memoryContext: '', integrationContext: '', relatedTicketsContext: '', coverageContext: '',
  });
  const completion = await getChatCompletionWithMessages(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.2, max_tokens: 1400, response_format: { type: 'json_object' } },
  );

  let outcome: JiraQaOutcome = 'PREPARE_MANUAL';
  let raw: any = {};
  try { raw = JSON.parse(completion.content); outcome = (raw.outcome as JiraQaOutcome) || outcome; } catch { /* keep defaults */ }
  const readiness = TaskReadinessService.sanitizeReadiness(raw.readiness, outcome);

  const readyOk = readiness.readyToTest === c.expected.readyToTest;

  const predictedTypes = new Set(readiness.coverageGaps.map((g) => g.type));
  const expectedTypes = c.expected.gapTypes ?? [];
  const recallHits = expectedTypes.filter((t) => predictedTypes.has(t)).length;
  const gapRecall = expectedTypes.length ? recallHits / expectedTypes.length : 1;
  const gapPrecision = predictedTypes.size
    ? [...predictedTypes].filter((t) => expectedTypes.includes(t)).length / predictedTypes.size
    : 1;

  return { name: c.name, readyOk, gapRecall, gapPrecision, plannerCoverage };
}

async function main() {
  const args = process.argv.slice(2);
  const usePlanner = args.includes('--planner');
  const fixturesPath = args.find((a) => !a.startsWith('--'))
    || join(__dirname, 'fixtures', 'jira-readiness-cases.json');

  const cases = JSON.parse(readFileSync(fixturesPath, 'utf8')) as EvalCase[];
  // eslint-disable-next-line no-console
  console.log(`\nEval: ${cases.length} cases · planner=${usePlanner ? 'ON' : 'off'} · ${fixturesPath}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    try {
      const r = await runCase(c, usePlanner);
      results.push(r);
      const pc = r.plannerCoverage == null ? '—' : `${Math.round(r.plannerCoverage * 100)}%`;
      // eslint-disable-next-line no-console
      console.log(
        `${r.readyOk ? '✓' : '✗'} ready  gapR=${(r.gapRecall * 100).toFixed(0)}%  gapP=${(r.gapPrecision * 100).toFixed(0)}%  plan=${pc}  ${c.name}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`! ERROR  ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const n = results.length || 1;
  const avg = (f: (r: CaseResult) => number) => results.reduce((s, r) => s + f(r), 0) / n;
  const readyAcc = results.filter((r) => r.readyOk).length / n;
  // eslint-disable-next-line no-console
  console.log(
    `\n── Scorecard ──\n` +
    `readiness accuracy : ${(readyAcc * 100).toFixed(0)}%\n` +
    `gap recall (avg)   : ${(avg((r) => r.gapRecall) * 100).toFixed(0)}%\n` +
    `gap precision (avg): ${(avg((r) => r.gapPrecision) * 100).toFixed(0)}%\n` +
    (usePlanner ? `planner coverage   : ${(avg((r) => r.plannerCoverage ?? 0) * 100).toFixed(0)}%\n` : ''),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
