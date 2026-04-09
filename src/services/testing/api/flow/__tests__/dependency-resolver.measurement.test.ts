/**
 * MEASUREMENT EXPERIMENT — dependency-resolver.service.ts
 * ──────────────────────────────────────────────────────────
 *
 * Purpose: answer the question "where does our pipeline break the order?"
 * by feeding the resolver a *perfect* AI output and observing whether any
 * of the deterministic post-processing stages (removePhantomNodes,
 * deduplicateNodes, autoWireAuthDependencies, autoWireCrudDependencies,
 * topologicalSort, orphan-append, buildParallelGroups) alter that perfect
 * output.
 *
 * Experimental setup:
 *   - Mock getChatCompletionWithMessages to return fixture.idealAnalystOutput
 *     for the Analyst call, fixture.idealArchitectOutput for the Architect
 *     call, and empty samples for Enricher calls.
 *   - Run DependencyResolverService.resolve(fixture.spec).
 *   - Compare the final ExecutionDAG to the fixture's idealArchitectOutput
 *     and to the fixture's human-readable orderingConstraints.
 *   - Read logger.info / logger.warn spy calls to count how many edges
 *     each post-processing stage added or removed.
 *
 * What we measure (per fixture):
 *   1. Did all expected nodes survive? (phantom removal false positives)
 *   2. Did all ordering constraints hold? (pairs [A,B] where A must be before B)
 *   3. How many edges did auto-wire add? (PROMPT_GAP signal)
 *   4. Did any stage drop edges or append orphans? (signal of over-aggression)
 *
 * This is a READ-ONLY experiment — no production code is modified.
 */

jest.mock('@/services/ai/core/openai.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { DependencyResolverService } from '../dependency-resolver.service';
import type { ResolverFixture } from '../__fixtures__/types';
import { petstoreFixture } from '../__fixtures__/petstore.fixture';
import { nestedSchoolFixture } from '../__fixtures__/nested-school.fixture';
import { authFirstFixture } from '../__fixtures__/auth-first.fixture';
import { irregularPluralsFixture } from '../__fixtures__/irregular-plurals.fixture';
import { crossResourceFixture } from '../__fixtures__/cross-resource.fixture';
import { nestedBodySchemasFixture } from '../__fixtures__/nested-body-schemas.fixture';
import {
  petstoreBrokenFixture,
  nestedSchoolBrokenFixture,
  authFirstBrokenFixture,
} from '../__fixtures__/broken-ai.fixture';

type MockFn = jest.Mock;

function buildAiMock(fixture: ResolverFixture): MockFn {
  // Sequence: 1st call → Analyst, 2nd call → Architect, 3rd+ → Enricher.
  // We return strings because the resolver expects `{ content: string }`.
  // For small specs (<= 20 endpoints) there's exactly 1 Architect batch.
  // Enricher sends 0..N batches depending on how many POST/PUT/PATCH there are.
  let callIndex = 0;
  const sequence: string[] = [
    JSON.stringify(fixture.idealAnalystOutput),
    JSON.stringify(fixture.idealArchitectOutput),
  ];
  return jest.fn().mockImplementation(async () => {
    const idx = callIndex++;
    const payload = sequence[idx] ?? JSON.stringify({ samples: {} });
    return { content: payload, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  });
}

interface StageCounters {
  phantomsRemoved: number;
  duplicatesRemoved: number;
  authEdgesAdded: number;
  crudEdgesAdded: number;
  orphansAppended: number;
  cycleBreaks: number;
  brokenInjectionsRemoved: number;
}

/**
 * Parse the logger.info / logger.warn mock calls to count per-stage activity.
 * The resolver logs structured messages we can pattern-match.
 */
function extractStageCounters(): StageCounters {
  const infoMock = logger.info as unknown as jest.Mock;
  const warnMock = logger.warn as unknown as jest.Mock;
  const allCalls = [...infoMock.mock.calls, ...warnMock.mock.calls];

  const counters: StageCounters = {
    phantomsRemoved: 0,
    duplicatesRemoved: 0,
    authEdgesAdded: 0,
    crudEdgesAdded: 0,
    orphansAppended: 0,
    cycleBreaks: 0,
    brokenInjectionsRemoved: 0,
  };

  for (const call of allCalls) {
    const msg = String(call[0] ?? '');
    const meta = call[1] ?? {};

    if (msg.includes('Phantom nodes removed')) {
      counters.phantomsRemoved += Number(meta.count ?? 0);
    }
    if (msg.includes('Duplicate node IDs removed')) {
      counters.duplicatesRemoved += Array.isArray(meta.duplicates) ? meta.duplicates.length : 0;
    }
    if (msg.includes('Auto-wired auth dependencies')) {
      counters.authEdgesAdded += Number(meta.nodesWired ?? 0);
    }
    if (msg.includes('Auto-wired CRUD dependencies')) {
      counters.crudEdgesAdded += Number(meta.edgesAdded ?? 0);
    }
    if (msg.includes('Orphan nodes not in topological order')) {
      counters.orphansAppended += Number(meta.orphanCount ?? 0);
    }
    if (msg.includes('Cycle detected')) {
      counters.cycleBreaks += 1;
    }
    if (msg.includes('Removed broken variable injections')) {
      counters.brokenInjectionsRemoved += Number(meta.count ?? 0);
    }
  }

  return counters;
}

interface MeasurementReport {
  fixture: string;
  finalOrder: string[];
  expectedNodes: string[];
  missingNodes: string[];
  unexpectedNodes: string[];
  violatedConstraints: Array<{ must: [string, string]; actualIndices: [number, number] }>;
  stages: StageCounters;
  totalEdgesInFinalDag: number;
  totalEdgesInIdealAi: number;
}

function countEdges(nodes: Array<{ dependsOn: string[] }>): number {
  return nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
}

async function runExperiment(fixture: ResolverFixture): Promise<MeasurementReport> {
  const mock = buildAiMock(fixture);
  (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mock);

  // Reset logger spies so each run's counters are isolated.
  (logger.info as unknown as jest.Mock).mockClear();
  (logger.warn as unknown as jest.Mock).mockClear();
  (logger.error as unknown as jest.Mock).mockClear();

  const result = await DependencyResolverService.resolve(fixture.spec);
  if (!result.dag) {
    throw new Error(`Resolver returned no DAG for fixture ${fixture.name}: ${JSON.stringify(result)}`);
  }

  const finalOrder = result.dag.executionOrder;
  const idxOf = new Map(finalOrder.map((id, i) => [id, i]));

  const missingNodes = fixture.expectedNodeIds.filter(id => !idxOf.has(id));
  const unexpectedNodes = finalOrder.filter(id => !fixture.expectedNodeIds.includes(id));

  const violatedConstraints: MeasurementReport['violatedConstraints'] = [];
  for (const [before, after] of fixture.orderingConstraints) {
    const bi = idxOf.get(before);
    const ai = idxOf.get(after);
    if (bi === undefined || ai === undefined) continue; // missing-node case already captured
    if (bi >= ai) {
      violatedConstraints.push({ must: [before, after], actualIndices: [bi, ai] });
    }
  }

  return {
    fixture: fixture.name,
    finalOrder,
    expectedNodes: fixture.expectedNodeIds,
    missingNodes,
    unexpectedNodes,
    violatedConstraints,
    stages: extractStageCounters(),
    totalEdgesInFinalDag: countEdges(result.dag.nodes),
    totalEdgesInIdealAi: countEdges(fixture.idealArchitectOutput.nodes),
  };
}

function formatReport(r: MeasurementReport): string {
  const lines: string[] = [];
  lines.push(`\n═══ FIXTURE: ${r.fixture} ═══`);
  lines.push(`  Final order: ${r.finalOrder.join(' → ')}`);
  lines.push(`  Expected nodes (${r.expectedNodes.length}): all present? ${r.missingNodes.length === 0 ? 'YES' : `NO (missing: ${r.missingNodes.join(', ')})`}`);
  lines.push(`  Unexpected nodes: ${r.unexpectedNodes.length === 0 ? 'none' : r.unexpectedNodes.join(', ')}`);
  lines.push(`  Ordering constraints: ${r.violatedConstraints.length === 0 ? 'ALL OK' : `${r.violatedConstraints.length} VIOLATED`}`);
  for (const v of r.violatedConstraints) {
    lines.push(`    ✗ ${v.must[0]} (idx ${v.actualIndices[0]}) should be before ${v.must[1]} (idx ${v.actualIndices[1]})`);
  }
  lines.push(`  Edges: ideal AI = ${r.totalEdgesInIdealAi}, final DAG = ${r.totalEdgesInFinalDag}, delta = ${r.totalEdgesInFinalDag - r.totalEdgesInIdealAi}`);
  lines.push(`  Stage activity:`);
  lines.push(`    phantoms removed:            ${r.stages.phantomsRemoved}`);
  lines.push(`    duplicates removed:          ${r.stages.duplicatesRemoved}`);
  lines.push(`    auth edges auto-wired:       ${r.stages.authEdgesAdded}`);
  lines.push(`    CRUD edges auto-wired:       ${r.stages.crudEdgesAdded}`);
  lines.push(`    orphans appended:            ${r.stages.orphansAppended}`);
  lines.push(`    cycle breaks:                ${r.stages.cycleBreaks}`);
  lines.push(`    broken injections removed:   ${r.stages.brokenInjectionsRemoved}`);
  return lines.join('\n');
}

describe('dependency-resolver measurement experiment', () => {
  // Each experiment is an independent probe — we use the reports, not
  // hard assertions, to surface which stages misbehave. But we still use
  // `expect` so the test run fails loudly if something catastrophic breaks.

  const fixtures: ResolverFixture[] = [
    petstoreFixture,
    nestedSchoolFixture,
    authFirstFixture,
    irregularPluralsFixture,
    crossResourceFixture,
    nestedBodySchemasFixture,
    petstoreBrokenFixture,
    nestedSchoolBrokenFixture,
    authFirstBrokenFixture,
  ];

  const reports: MeasurementReport[] = [];

  afterAll(() => {
    // Always print the aggregated report at the end of the run.
    // eslint-disable-next-line no-console
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    // eslint-disable-next-line no-console
    console.log('║  DEPENDENCY-RESOLVER MEASUREMENT REPORT                    ║');
    // eslint-disable-next-line no-console
    console.log('╚════════════════════════════════════════════════════════════╝');
    for (const r of reports) {
      // eslint-disable-next-line no-console
      console.log(formatReport(r));
    }

    const totalViolations = reports.reduce((s, r) => s + r.violatedConstraints.length, 0);
    const fixturesWithViolations = reports.filter(r => r.violatedConstraints.length > 0).length;
    // eslint-disable-next-line no-console
    console.log(`\n─── SUMMARY ───`);
    // eslint-disable-next-line no-console
    console.log(`  Fixtures tested:             ${reports.length}`);
    // eslint-disable-next-line no-console
    console.log(`  Fixtures with violations:    ${fixturesWithViolations}/${reports.length}`);
    // eslint-disable-next-line no-console
    console.log(`  Total ordering violations:   ${totalViolations}`);
  });

  for (const fx of fixtures) {
    test(`measures ${fx.name}`, async () => {
      const report = await runExperiment(fx);
      reports.push(report);

      // Minimum correctness gate: every expected node must survive.
      // Phantom-removal false positives are a hard failure even in
      // a pure measurement run.
      expect(report.missingNodes).toEqual([]);

      // We do NOT assert on ordering constraints here — the whole
      // point is to measure them. The summary in afterAll reports them.
    }, 30_000);
  }
});
