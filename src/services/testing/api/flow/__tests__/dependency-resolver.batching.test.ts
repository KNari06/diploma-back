/**
 * BATCHING MEASUREMENT — what gets lost when spec exceeds MAX_ENDPOINTS_PER_BATCH?
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Purpose: specifically probe the cross-batch dependency loss when
 * a spec has more than MAX_ENDPOINTS_PER_BATCH (=20) endpoints.
 *
 * Experimental setup:
 *   - Fixture: 25-endpoint e-commerce API with realistic cross-resource deps.
 *   - Mock AI per-batch: each Architect call sees only its chunk and returns
 *     only dependencies that exist WITHIN that chunk. Cross-batch deps are
 *     dropped — simulating what a real LLM does (it can only wire what it sees).
 *   - Merger mock: we simulate both outcomes — merger SUCCEEDS (reconnects
 *     cross-batch deps) and merger SKIPPED (> 4 batches, concat only).
 *
 * What we measure:
 *   - How many cross-batch dependencies does AI alone lose? (baseline)
 *   - How many does the merger recover?
 *   - How many does deterministic autoWireCrudDependencies recover?
 *   - Final violations count.
 */

jest.mock('@/services/ai/core/openai.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { DependencyResolverService } from '../dependency-resolver.service';
import { batchingEcommerceFixture } from '../__fixtures__/batching-ecommerce.fixture';
import type { ParsedEndpoint } from '../flow.types';

/**
 * Parse the Architect user-message content to figure out which endpoints are
 * in this particular batch. The prompt builder writes them as "  METHOD /path"
 * inside the "FULL ENDPOINT SPECIFICATIONS" section.
 */
function extractBatchEndpoints(userContent: string): Set<string> {
  const key = new Set<string>();
  // Each endpoint gets "── ENDPOINT [n] ──\n  METHOD /path\n" in serializeEndpoint.
  const regex = /──\s*ENDPOINT\s*\[\d+\]\s*──\n\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(userContent)) !== null) {
    key.add(`${match[1]}:${match[2]}`);
  }
  return key;
}

/**
 * Build an Architect mock that returns per-batch nodes with cross-batch deps
 * stripped. Each call inspects its messages, figures out which endpoints are
 * in the batch, pulls the matching nodes from the fixture's ideal output,
 * and removes any dependsOn IDs that are not in the batch.
 */
function buildPerBatchArchitectMock(options: {
  forceMergerFail?: boolean;
  /** 'success' → merger returns the full ideal DAG. 'fail' → merger returns empty (triggers concat fallback). */
  mergerOutcome?: 'success' | 'fail';
}) {
  const idealNodes = batchingEcommerceFixture.idealArchitectOutput.nodes;
  const idealById = new Map(idealNodes.map((n: any) => [n.id, n]));

  // Build spec→node lookup by "METHOD:/path" so we can match the batch.
  const idealByKey = new Map<string, any>();
  for (const n of idealNodes) {
    idealByKey.set(`${n.method}:${n.path}`, n);
  }

  // Also index which ID each endpoint produces, so we can tell if a dep is
  // in-batch or out-of-batch.
  const idToKey = new Map<string, string>();
  for (const n of idealNodes) {
    idToKey.set(n.id, `${n.method}:${n.path}`);
  }

  let callIndex = 0;

  return jest.fn().mockImplementation(async (messages: any[]) => {
    const userMsg = messages.find(m => m.role === 'user')?.content ?? '';
    const isMergerCall = userMsg.includes('Merge') && userMsg.includes('partial DAG');

    callIndex++;

    // Analyst call (first call, has no batching)
    if (callIndex === 1) {
      return {
        content: JSON.stringify(batchingEcommerceFixture.idealAnalystOutput),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    // Merger call
    if (isMergerCall) {
      if (options.mergerOutcome === 'success') {
        // Merger succeeds → return the full ideal DAG
        return {
          content: JSON.stringify(batchingEcommerceFixture.idealArchitectOutput),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
      // Merger fails → return 0 nodes → resolver falls back to concatenation
      return {
        content: JSON.stringify({ nodes: [], executionOrder: [], summary: 'failed' }),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    // Architect batch call — figure out which endpoints are in THIS batch
    const batchKeys = extractBatchEndpoints(userMsg);
    const batchNodes = idealNodes
      .filter((n: any) => batchKeys.has(`${n.method}:${n.path}`))
      .map((n: any) => ({
        ...n,
        // Strip cross-batch dependsOn — AI in this batch can only see its own endpoints
        dependsOn: n.dependsOn.filter((depId: string) => {
          const depKey = idToKey.get(depId);
          return depKey ? batchKeys.has(depKey) : false;
        }),
      }));

    return {
      content: JSON.stringify({
        nodes: batchNodes,
        executionOrder: batchNodes.map((n: any) => n.id),
        summary: `Batch of ${batchNodes.length} nodes`,
        totalEndpoints: batchNodes.length,
        unsupportedEndpoints: [],
      }),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  });
}

function countEdges(nodes: Array<{ dependsOn: string[] }>): number {
  return nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
}

function analyzeResult(
  finalOrder: string[],
  finalNodes: Array<{ dependsOn: string[] }>,
  idealEdges: number,
) {
  const idx = new Map(finalOrder.map((id, i) => [id, i]));
  const violations: Array<[string, string]> = [];

  for (const [before, after] of batchingEcommerceFixture.orderingConstraints) {
    const bi = idx.get(before);
    const ai = idx.get(after);
    if (bi === undefined || ai === undefined) continue;
    if (bi >= ai) violations.push([before, after]);
  }

  const presentNodes = new Set(finalOrder);
  const missing = batchingEcommerceFixture.expectedNodeIds.filter(id => !presentNodes.has(id));

  return {
    finalEdges: countEdges(finalNodes),
    idealEdges,
    edgesDelta: countEdges(finalNodes) - idealEdges,
    violations,
    missing,
    finalOrder,
  };
}

function extractStageCounters() {
  const info = (logger.info as unknown as jest.Mock).mock.calls;
  const warn = (logger.warn as unknown as jest.Mock).mock.calls;
  const all = [...info, ...warn];

  const counters = {
    phantomsRemoved: 0,
    authEdgesAdded: 0,
    crudEdgesAdded: 0,
    orphansAppended: 0,
    mergerSkipped: false,
    mergerSucceeded: false,
    mergerFailed: false,
    brokenInjectionsRemoved: 0,
    batchCount: 0,
  };

  for (const call of all) {
    const msg = String(call[0] ?? '');
    const meta = call[1] ?? {};
    if (msg.includes('Phantom nodes removed')) counters.phantomsRemoved += Number(meta.count ?? 0);
    if (msg.includes('Auto-wired auth dependencies')) counters.authEdgesAdded += Number(meta.nodesWired ?? 0);
    if (msg.includes('Auto-wired CRUD dependencies')) counters.crudEdgesAdded += Number(meta.edgesAdded ?? 0);
    if (msg.includes('Orphan nodes not in topological order')) counters.orphansAppended += Number(meta.orphanCount ?? 0);
    if (msg.includes('Skipping AI merge for large spec')) counters.mergerSkipped = true;
    if (msg.includes('Merger succeeded')) counters.mergerSucceeded = true;
    if (msg.includes('Merger failed') || msg.includes('Merger returned 0 nodes')) counters.mergerFailed = true;
    if (msg.includes('Removed broken variable injections')) counters.brokenInjectionsRemoved += Number(meta.count ?? 0);
    if (msg.includes('Batching')) counters.batchCount = Number(meta.chunks ?? 0);
  }

  return counters;
}

describe('batching measurement experiment', () => {
  const idealEdges = countEdges(batchingEcommerceFixture.idealArchitectOutput.nodes);

  beforeEach(() => {
    (logger.info as unknown as jest.Mock).mockClear();
    (logger.warn as unknown as jest.Mock).mockClear();
    (logger.error as unknown as jest.Mock).mockClear();
  });

  test('scenario 1: 2 batches, merger succeeds', async () => {
    const mock = buildPerBatchArchitectMock({ mergerOutcome: 'success' });
    (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mock);

    const result = await DependencyResolverService.resolve(batchingEcommerceFixture.spec);
    expect(result.dag).toBeDefined();

    const r = analyzeResult(result.dag!.executionOrder, result.dag!.nodes, idealEdges);
    const stages = extractStageCounters();

    // eslint-disable-next-line no-console
    console.log('\n═══ SCENARIO 1: 2 batches, merger SUCCEEDS ═══');
    // eslint-disable-next-line no-console
    console.log(`  Batch count:              ${stages.batchCount}`);
    // eslint-disable-next-line no-console
    console.log(`  Merger succeeded:         ${stages.mergerSucceeded}`);
    // eslint-disable-next-line no-console
    console.log(`  Merger skipped:           ${stages.mergerSkipped}`);
    // eslint-disable-next-line no-console
    console.log(`  Edges: ideal=${r.idealEdges}, final=${r.finalEdges}, delta=${r.edgesDelta}`);
    // eslint-disable-next-line no-console
    console.log(`  CRUD auto-wire added:     ${stages.crudEdgesAdded}`);
    // eslint-disable-next-line no-console
    console.log(`  Orphans appended:         ${stages.orphansAppended}`);
    // eslint-disable-next-line no-console
    console.log(`  Missing nodes:            ${r.missing.length === 0 ? 'none' : r.missing.join(', ')}`);
    // eslint-disable-next-line no-console
    console.log(`  Ordering violations:      ${r.violations.length}`);
    for (const [b, a] of r.violations) {
      // eslint-disable-next-line no-console
      console.log(`    ✗ ${b} must be before ${a}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  Final order (first 10):   ${r.finalOrder.slice(0, 10).join(' → ')}`);

    expect(r.missing).toEqual([]);
  }, 30_000);

  test('scenario 2: 2 batches, merger fails → concatenation fallback', async () => {
    const mock = buildPerBatchArchitectMock({ mergerOutcome: 'fail' });
    (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mock);

    const result = await DependencyResolverService.resolve(batchingEcommerceFixture.spec);
    expect(result.dag).toBeDefined();

    const r = analyzeResult(result.dag!.executionOrder, result.dag!.nodes, idealEdges);
    const stages = extractStageCounters();

    // eslint-disable-next-line no-console
    console.log('\n═══ SCENARIO 2: 2 batches, merger FAILS ═══');
    // eslint-disable-next-line no-console
    console.log(`  Batch count:              ${stages.batchCount}`);
    // eslint-disable-next-line no-console
    console.log(`  Merger succeeded:         ${stages.mergerSucceeded}`);
    // eslint-disable-next-line no-console
    console.log(`  Merger failed/empty:      ${stages.mergerFailed}`);
    // eslint-disable-next-line no-console
    console.log(`  Edges: ideal=${r.idealEdges}, final=${r.finalEdges}, delta=${r.edgesDelta}`);
    // eslint-disable-next-line no-console
    console.log(`  CRUD auto-wire added:     ${stages.crudEdgesAdded}`);
    // eslint-disable-next-line no-console
    console.log(`  Orphans appended:         ${stages.orphansAppended}`);
    // eslint-disable-next-line no-console
    console.log(`  Missing nodes:            ${r.missing.length === 0 ? 'none' : r.missing.join(', ')}`);
    // eslint-disable-next-line no-console
    console.log(`  Ordering violations:      ${r.violations.length}`);
    for (const [b, a] of r.violations) {
      // eslint-disable-next-line no-console
      console.log(`    ✗ ${b} must be before ${a}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  Final order (first 10):   ${r.finalOrder.slice(0, 10).join(' → ')}`);

    expect(r.missing).toEqual([]);
  }, 30_000);

  test('scenario 3: simulates >4 batches (merger skipped entirely)', async () => {
    // Temporarily shrink MAX_ENDPOINTS_PER_BATCH by creating a bigger spec
    // 25 endpoints / 5-per-batch = 5 batches → merger skipped
    // We can't change the const, but we can inflate the spec by duplicating
    // endpoints under different paths so we force >4 batches.
    const base = batchingEcommerceFixture.spec;
    const extraEndpoints: ParsedEndpoint[] = [];
    // 25 → need > 80 endpoints (> 4 batches of 20) to trigger merger skip
    // Create harmless filler endpoints with no cross-refs
    for (let i = 0; i < 60; i++) {
      extraEndpoints.push({
        operationId: `filler${i}`,
        method: 'GET',
        path: `/filler/group${Math.floor(i / 10)}/item${i}`,
        summary: `filler ${i}`,
        tags: ['filler'],
        parameters: [],
        responses: { '200': { description: 'ok' } },
        security: [],
      });
    }

    const inflatedSpec = {
      ...base,
      endpoints: [...base.endpoints, ...extraEndpoints],
    };

    // Extend ideal nodes with filler nodes so the mock can return them
    const fillerNodes = extraEndpoints.map(e => ({
      id: e.operationId,
      method: e.method,
      path: e.path,
      operationId: e.operationId,
      summary: e.summary,
      tags: e.tags,
      dependsOn: [],
      variableExtractions: [],
      variableInjections: [],
      priority: 0,
      isAuthEndpoint: false,
      isPagination: false,
      hasFileUpload: false,
      isUnsupported: false,
      canRunParallel: true,
      sampleRequestBody: null,
      expectedStatusCodes: [200],
    }));

    // Patch the fixture temporarily so the mock knows about filler nodes
    const originalIdeal = batchingEcommerceFixture.idealArchitectOutput.nodes;
    (batchingEcommerceFixture.idealArchitectOutput.nodes as any) = [
      ...originalIdeal,
      ...fillerNodes,
    ];

    try {
      const mock = buildPerBatchArchitectMock({ mergerOutcome: 'success' /* won't be called */ });
      (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mock);

      const result = await DependencyResolverService.resolve(inflatedSpec);
      expect(result.dag).toBeDefined();

      // Filter the analysis to only the ORIGINAL 25 nodes so we compare apples to apples
      const idToKeep = new Set(batchingEcommerceFixture.expectedNodeIds);
      const filteredOrder = result.dag!.executionOrder.filter(id => idToKeep.has(id));
      const filteredNodes = result.dag!.nodes.filter(n => idToKeep.has(n.id));
      const r = analyzeResult(filteredOrder, filteredNodes, idealEdges);
      const stages = extractStageCounters();

      // eslint-disable-next-line no-console
      console.log('\n═══ SCENARIO 3: >4 batches, MERGER SKIPPED (concat only) ═══');
      // eslint-disable-next-line no-console
      console.log(`  Batch count:              ${stages.batchCount}`);
      // eslint-disable-next-line no-console
      console.log(`  Merger skipped:           ${stages.mergerSkipped}`);
      // eslint-disable-next-line no-console
      console.log(`  Edges (core 25): ideal=${r.idealEdges}, final=${r.finalEdges}, delta=${r.edgesDelta}`);
      // eslint-disable-next-line no-console
      console.log(`  CRUD auto-wire added:     ${stages.crudEdgesAdded}`);
      // eslint-disable-next-line no-console
      console.log(`  Orphans appended:         ${stages.orphansAppended}`);
      // eslint-disable-next-line no-console
      console.log(`  Missing nodes:            ${r.missing.length === 0 ? 'none' : r.missing.join(', ')}`);
      // eslint-disable-next-line no-console
      console.log(`  Ordering violations:      ${r.violations.length}`);
      for (const [b, a] of r.violations) {
        // eslint-disable-next-line no-console
        console.log(`    ✗ ${b} must be before ${a}`);
      }

      expect(r.missing).toEqual([]);
    } finally {
      // Restore the fixture
      (batchingEcommerceFixture.idealArchitectOutput.nodes as any) = originalIdeal;
    }
  }, 30_000);
});
