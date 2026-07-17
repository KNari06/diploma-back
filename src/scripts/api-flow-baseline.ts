/**
 * API-flow eval baseline — score the CURRENT pipeline's real output.
 *
 * Offline analysis runner (NOT a request-path service). Loads every saved
 * `api_flow_specs` row, re-derives per-endpoint security by re-parsing the
 * stored raw_spec (deterministic, no LLM), and scores each row's saved
 * execution_dag with the independent eval-harness scorer. This is the baseline
 * we compare a future pipeline against.
 *
 * Run: npx ts-node -r tsconfig-paths/register src/scripts/api-flow-baseline.ts
 * Optional: pass flow-spec id prefixes as argv to score only those.
 */

import '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { SpecParserService } from '@/services/testing/api/flow/spec-parser.service';
import { scoreDag, securityMapFromSpec, formatScorecard, type EvalScore } from '@/services/testing/api/flow/eval/metrics';
import type { ExecutionDAG, ParsedApiSpec } from '@/services/testing/api/flow/flow.types';

interface FlowRow {
  id: string;
  name: string;
  execution_dag: ExecutionDAG | null;
  raw_spec: any;
  variable_chain: Record<string, any> | null;
}

async function reparseSecurity(rawSpec: any): Promise<Map<string, string[]>> {
  try {
    const parsed: ParsedApiSpec = await SpecParserService.parseFromContent(JSON.stringify(rawSpec), 'openapi_file');
    return securityMapFromSpec(parsed);
  } catch {
    return new Map(); // can't re-parse → auth coverage is uninformative, not fatal
  }
}

async function main(): Promise<void> {
  const filters = process.argv.slice(2);
  const { data, error } = await supabaseAdmin
    .from('api_flow_specs')
    .select('id,name,execution_dag,raw_spec,variable_chain')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  const rows = (data as FlowRow[]).filter(
    r => r.execution_dag?.nodes?.length && (filters.length === 0 || filters.some(f => r.id.startsWith(f))),
  );

  const scores: EvalScore[] = [];
  const details: { score: EvalScore; unresolved: string[]; ordering: string[] }[] = [];

  for (const r of rows) {
    const dag = r.execution_dag!;
    const securityByEndpoint = await reparseSecurity(r.raw_spec);
    const providedVars = Object.keys(r.variable_chain || {});
    const score = scoreDag({
      name: `${r.id.slice(0, 8)} ${r.name}`.slice(0, 34),
      nodes: dag.nodes,
      executionOrder: dag.executionOrder || dag.nodes.map(n => n.id),
      securityByEndpoint,
      providedVars,
    });
    scores.push(score);

    // Collect a few human-readable offenders for the worst flows.
    const produced = new Set<string>();
    for (const n of dag.nodes) for (const e of n.variableExtractions || []) produced.add(e.variableName);
    const provided = new Set(providedVars);
    const unresolved = [
      ...new Set(
        dag.nodes.flatMap(n =>
          (n.variableInjections || [])
            .map(i => i.variableName)
            .filter(v => !produced.has(v) && !provided.has(v)),
        ),
      ),
    ];
    details.push({ score, unresolved, ordering: [] });
  }

  console.log('\n=== API-FLOW PIPELINE BASELINE ===\n');
  console.log(formatScorecard(scores));
  const passed = scores.filter(s => s.passed).length;
  console.log(`\n${passed}/${scores.length} flows pass all hard invariants.\n`);

  for (const d of details) {
    if (d.score.passed && d.score.fabricatedReferenceIds === 0) continue;
    console.log(`— ${d.score.name}`);
    if (d.score.orderingViolations) console.log(`    ordering violations: ${d.score.orderingViolations}`);
    if (d.score.unresolvedInjections)
      console.log(`    unresolved injections: ${d.score.unresolvedInjections} → ${d.unresolved.slice(0, 12).join(', ')}`);
    if (d.score.authCoverage.required && d.score.authCoverage.pct < 100)
      console.log(`    auth coverage: ${d.score.authCoverage.covered}/${d.score.authCoverage.required} (${d.score.authCoverage.pct}%)`);
    if (d.score.hasCycle) console.log(`    dependency cycle: yes`);
    if (d.score.fabricatedReferenceIds) console.log(`    fabricated reference ids (soft): ${d.score.fabricatedReferenceIds}`);
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
