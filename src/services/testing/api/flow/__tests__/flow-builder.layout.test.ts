/**
 * LAYOUT MEASUREMENT — flow-builder.service.ts:buildVisualization
 * ─────────────────────────────────────────────────────────────────
 *
 * Tests the three layout PRs:
 *   Layout-1: stable sort + auth force-to-level-0 + row wrap
 *   Layout-2: tag-based column grouping (secondary sort key)
 *   Layout-3: barycenter pass for crossing reduction
 *
 * This is a PURE visual test — no AI, no DB, no network. We build a
 * synthetic ExecutionDAG, run buildVisualization, and assert on node
 * positions and invariants.
 *
 * Invariants that MUST hold after every layout pass:
 *   - Every node in dag.nodes has exactly one position
 *   - Every dependsOn edge is present in the output edges
 *   - stepNumber equals its index in executionOrder + 1
 *   - Two runs on the same input give identical output (determinism)
 */

import { buildVisualization } from '../flow-builder.service';
import type { DAGNode, ExecutionDAG, HttpMethod } from '../flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// Tiny node builder
// ─────────────────────────────────────────────────────────────────────────────

function makeNode(params: {
  id: string;
  method: HttpMethod;
  path: string;
  tags?: string[];
  isAuthEndpoint?: boolean;
  dependsOn?: string[];
}): DAGNode {
  return {
    id: params.id,
    method: params.method,
    path: params.path,
    operationId: params.id,
    summary: params.id,
    tags: params.tags ?? [],
    dependsOn: params.dependsOn ?? [],
    variableExtractions: [],
    variableInjections: [],
    priority: 0,
    isAuthEndpoint: !!params.isAuthEndpoint,
    isPagination: false,
    hasFileUpload: false,
    isUnsupported: false,
    canRunParallel: true,
    sampleRequestBody: null,
    expectedStatusCodes: [200],
  };
}

/**
 * Build an ExecutionDAG from a flat list of nodes + parallelGroups.
 * executionOrder is derived as a flattening of parallelGroups so
 * stepNumber checks have a stable ground-truth.
 */
function makeDag(nodes: DAGNode[], parallelGroups: string[][]): ExecutionDAG {
  return {
    nodes,
    executionOrder: parallelGroups.flat(),
    parallelGroups,
    summary: 'test',
    totalEndpoints: nodes.length,
    unsupportedEndpoints: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function nodeByIdFromVis(vis: ReturnType<typeof buildVisualization>, id: string) {
  const n = vis.nodes.find(n => n.id === id);
  if (!n) throw new Error(`Node ${id} not found in vis output`);
  return n;
}

function xOf(vis: ReturnType<typeof buildVisualization>, id: string): number {
  return nodeByIdFromVis(vis, id).position.x;
}

function yOf(vis: ReturnType<typeof buildVisualization>, id: string): number {
  return nodeByIdFromVis(vis, id).position.y;
}

function allYs(vis: ReturnType<typeof buildVisualization>): number[] {
  return Array.from(new Set(vis.nodes.map(n => n.position.y))).sort((a, b) => a - b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('buildVisualization — Layout-1 (sort / auth-force / row-wrap)', () => {
  // ── Invariants ─────────────────────────────────────────────────────────────

  test('every node in dag has a unique position', () => {
    const nodes = [
      makeNode({ id: 'a', method: 'POST', path: '/a' }),
      makeNode({ id: 'b', method: 'GET', path: '/b' }),
      makeNode({ id: 'c', method: 'DELETE', path: '/c' }),
    ];
    const vis = buildVisualization(makeDag(nodes, [['a', 'b', 'c']]));
    expect(vis.nodes).toHaveLength(3);
    const positions = vis.nodes.map(n => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(3); // all unique
  });

  test('every dependsOn edge appears in output edges', () => {
    const nodes = [
      makeNode({ id: 'a', method: 'POST', path: '/a' }),
      makeNode({ id: 'b', method: 'GET', path: '/a/{id}', dependsOn: ['a'] }),
      makeNode({ id: 'c', method: 'DELETE', path: '/a/{id}', dependsOn: ['a', 'b'] }),
    ];
    const vis = buildVisualization(makeDag(nodes, [['a'], ['b'], ['c']]));
    expect(vis.edges.find(e => e.source === 'a' && e.target === 'b')).toBeDefined();
    expect(vis.edges.find(e => e.source === 'a' && e.target === 'c')).toBeDefined();
    expect(vis.edges.find(e => e.source === 'b' && e.target === 'c')).toBeDefined();
    expect(vis.edges).toHaveLength(3);
  });

  test('stepNumber matches executionOrder index + 1', () => {
    const nodes = [
      makeNode({ id: 'a', method: 'POST', path: '/a' }),
      makeNode({ id: 'b', method: 'GET', path: '/a/{id}' }),
      makeNode({ id: 'c', method: 'DELETE', path: '/a/{id}' }),
    ];
    const dag: ExecutionDAG = {
      nodes,
      executionOrder: ['c', 'a', 'b'], // deliberately weird order
      parallelGroups: [['a', 'b', 'c']],
      summary: '',
      totalEndpoints: 3,
      unsupportedEndpoints: [],
    };
    const vis = buildVisualization(dag);
    expect(nodeByIdFromVis(vis, 'c').data.stepNumber).toBe(1);
    expect(nodeByIdFromVis(vis, 'a').data.stepNumber).toBe(2);
    expect(nodeByIdFromVis(vis, 'b').data.stepNumber).toBe(3);
  });

  test('determinism — two runs produce identical positions', () => {
    const makeNodes = () => [
      makeNode({ id: 'getFoo', method: 'GET', path: '/foo' }),
      makeNode({ id: 'postBar', method: 'POST', path: '/bar' }),
      makeNode({ id: 'delBaz', method: 'DELETE', path: '/baz' }),
      makeNode({ id: 'putQux', method: 'PUT', path: '/qux/{id}' }),
    ];
    const dagA = makeDag(makeNodes(), [['getFoo', 'postBar', 'delBaz', 'putQux']]);
    const dagB = makeDag(makeNodes(), [['putQux', 'delBaz', 'postBar', 'getFoo']]); // reversed input
    const visA = buildVisualization(dagA);
    const visB = buildVisualization(dagB);
    // Sort both results by id and compare positions.
    const posMapA = new Map(visA.nodes.map(n => [n.id, n.position]));
    const posMapB = new Map(visB.nodes.map(n => [n.id, n.position]));
    for (const id of ['getFoo', 'postBar', 'delBaz', 'putQux']) {
      expect(posMapA.get(id)).toEqual(posMapB.get(id));
    }
  });

  // ── Stable sort inside level ───────────────────────────────────────────────

  test('POST sorts before GET/{id}, DELETE sorts last', () => {
    const nodes = [
      makeNode({ id: 'delUser', method: 'DELETE', path: '/users/{id}' }),
      makeNode({ id: 'getUser', method: 'GET', path: '/users/{id}' }),
      makeNode({ id: 'postUser', method: 'POST', path: '/users' }),
      makeNode({ id: 'listUsers', method: 'GET', path: '/users' }),
      makeNode({ id: 'putUser', method: 'PUT', path: '/users/{id}' }),
    ];
    const vis = buildVisualization(
      makeDag(nodes, [['delUser', 'getUser', 'postUser', 'listUsers', 'putUser']]),
    );

    // All on same level → same Y
    const ys = new Set(vis.nodes.map(n => n.position.y));
    expect(ys.size).toBe(1);

    // X order: POST < GET-list < GET-item < PUT < DELETE
    const xPost = xOf(vis, 'postUser');
    const xList = xOf(vis, 'listUsers');
    const xGet = xOf(vis, 'getUser');
    const xPut = xOf(vis, 'putUser');
    const xDel = xOf(vis, 'delUser');
    expect(xPost).toBeLessThan(xList);
    expect(xList).toBeLessThan(xGet);
    expect(xGet).toBeLessThan(xPut);
    expect(xPut).toBeLessThan(xDel);
  });

  test('alphabetic tie-breaker when method priority is equal', () => {
    const nodes = [
      makeNode({ id: 'getZebra', method: 'GET', path: '/zebra' }),
      makeNode({ id: 'getApple', method: 'GET', path: '/apple' }),
      makeNode({ id: 'getMango', method: 'GET', path: '/mango' }),
    ];
    const vis = buildVisualization(makeDag(nodes, [['getZebra', 'getApple', 'getMango']]));
    expect(xOf(vis, 'getApple')).toBeLessThan(xOf(vis, 'getMango'));
    expect(xOf(vis, 'getMango')).toBeLessThan(xOf(vis, 'getZebra'));
  });

  // ── Auth force-to-level-0 ──────────────────────────────────────────────────

  test('root auth node gets lifted to visual level 0', () => {
    const nodes = [
      makeNode({ id: 'getData', method: 'GET', path: '/data' }),
      makeNode({
        id: 'login',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
        dependsOn: [],
      }),
    ];
    // Naughty parallelGroups: login is on level 2 even though it should be on level 0
    const vis = buildVisualization(makeDag(nodes, [['getData'], [], ['login']]));
    // Auth should now be at y=0
    expect(yOf(vis, 'login')).toBe(0);
  });

  test('multi-step auth chain keeps its topological order', () => {
    const nodes = [
      makeNode({
        id: 'register',
        method: 'POST',
        path: '/auth/register',
        isAuthEndpoint: true,
        dependsOn: [],
      }),
      makeNode({
        id: 'verify',
        method: 'POST',
        path: '/auth/verify',
        isAuthEndpoint: true,
        dependsOn: ['register'],
      }),
      makeNode({
        id: 'login',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
        dependsOn: ['verify'],
      }),
    ];
    const vis = buildVisualization(
      makeDag(nodes, [['register'], ['verify'], ['login']]),
    );
    // register at 0, verify below, login below verify — all because each depends on the previous
    const ys = allYs(vis);
    expect(ys).toHaveLength(3);
    expect(yOf(vis, 'register')).toBe(ys[0]);
    expect(yOf(vis, 'verify')).toBe(ys[1]);
    expect(yOf(vis, 'login')).toBe(ys[2]);
  });

  test('auth node that depends on non-auth is NOT lifted', () => {
    const nodes = [
      makeNode({ id: 'createUser', method: 'POST', path: '/users' }),
      makeNode({
        id: 'login',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
        dependsOn: ['createUser'], // non-auth dependency
      }),
    ];
    const vis = buildVisualization(makeDag(nodes, [['createUser'], ['login']]));
    // login should stay on level 1 because it depends on a non-auth node
    expect(yOf(vis, 'login')).toBeGreaterThan(yOf(vis, 'createUser'));
  });

  // ── Row wrap ───────────────────────────────────────────────────────────────

  test('level with > 6 nodes wraps into multiple sub-rows', () => {
    const nodes: DAGNode[] = [];
    for (let i = 0; i < 13; i++) {
      nodes.push(makeNode({ id: `n${i}`, method: 'GET', path: `/r${i}` }));
    }
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    // Should produce 3 sub-rows (6 + 6 + 1)
    const ys = allYs(vis);
    expect(ys.length).toBe(3);
    // Each sub-row should have at most 6 nodes
    for (const y of ys) {
      const cnt = vis.nodes.filter(n => n.position.y === y).length;
      expect(cnt).toBeLessThanOrEqual(6);
    }
  });

  test('level with exactly 6 nodes is a single row', () => {
    const nodes: DAGNode[] = [];
    for (let i = 0; i < 6; i++) {
      nodes.push(makeNode({ id: `n${i}`, method: 'GET', path: `/r${i}` }));
    }
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    const ys = allYs(vis);
    expect(ys.length).toBe(1); // single row
  });

  test('row wrap centers each sub-row horizontally', () => {
    // 8 nodes → 6 + 2. The 2-node row should be centered (narrower than the 6-row).
    const nodes: DAGNode[] = [];
    for (let i = 0; i < 8; i++) {
      nodes.push(makeNode({ id: `n${i}`, method: 'GET', path: `/r${String(i).padStart(2, '0')}` }));
    }
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    const ys = allYs(vis);
    expect(ys.length).toBe(2);
    // First row has 6 nodes, second row has 2
    const row1 = vis.nodes.filter(n => n.position.y === ys[0]);
    const row2 = vis.nodes.filter(n => n.position.y === ys[1]);
    expect(row1).toHaveLength(6);
    expect(row2).toHaveLength(2);
    // Row 2 should be centered — mean of node CENTERS (position.x is top-left,
    // so the center of each node is position.x + NODE_WIDTH / 2 = position.x + 110).
    const NODE_WIDTH_HALF = 110;
    const meanCenter2 = row2.reduce((s, n) => s + n.position.x + NODE_WIDTH_HALF, 0) / row2.length;
    expect(Math.abs(meanCenter2)).toBeLessThan(1); // essentially 0
  });

  // ── Regression cases ──────────────────────────────────────────────────────

  // ── Layout-2: tag-based column grouping ───────────────────────────────────

  test('Layout-2: nodes with the same tag cluster together', () => {
    const nodes = [
      makeNode({ id: 'orderPost', method: 'POST', path: '/orders', tags: ['order'] }),
      makeNode({ id: 'orderGet', method: 'GET', path: '/orders', tags: ['order'] }),
      makeNode({ id: 'userPost', method: 'POST', path: '/users', tags: ['user'] }),
      makeNode({ id: 'userGet', method: 'GET', path: '/users', tags: ['user'] }),
    ];
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    // All four share one level → same Y
    expect(new Set(vis.nodes.map(n => n.position.y)).size).toBe(1);
    // Tags alphabetic: 'order' < 'user' → order* leftmost
    expect(xOf(vis, 'orderPost')).toBeLessThan(xOf(vis, 'userPost'));
    expect(xOf(vis, 'orderGet')).toBeLessThan(xOf(vis, 'userPost'));
    // Within a tag, method priority: POST < GET
    expect(xOf(vis, 'orderPost')).toBeLessThan(xOf(vis, 'orderGet'));
    expect(xOf(vis, 'userPost')).toBeLessThan(xOf(vis, 'userGet'));
  });

  test('Layout-2: untagged nodes appear after tagged ones', () => {
    const nodes = [
      makeNode({ id: 'healthCheck', method: 'GET', path: '/health' /* no tags */ }),
      makeNode({ id: 'userGet', method: 'GET', path: '/users', tags: ['user'] }),
      makeNode({ id: 'metricsGet', method: 'GET', path: '/metrics' /* no tags */ }),
    ];
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    // tagged 'user' node should be left of untagged nodes
    expect(xOf(vis, 'userGet')).toBeLessThan(xOf(vis, 'healthCheck'));
    expect(xOf(vis, 'userGet')).toBeLessThan(xOf(vis, 'metricsGet'));
  });

  test('Layout-2: primary tag (tags[0]) is used for grouping', () => {
    const nodes = [
      makeNode({ id: 'n1', method: 'GET', path: '/a', tags: ['alpha', 'beta'] }),
      makeNode({ id: 'n2', method: 'GET', path: '/b', tags: ['beta', 'alpha'] }),
      makeNode({ id: 'n3', method: 'GET', path: '/c', tags: ['alpha', 'gamma'] }),
    ];
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    // n1 and n3 share primary tag 'alpha' → adjacent; n2 primary 'beta' → separate
    expect(xOf(vis, 'n1')).toBeLessThan(xOf(vis, 'n2'));
    expect(xOf(vis, 'n3')).toBeLessThan(xOf(vis, 'n2'));
  });

  test('Layout-2: auth flag still dominates over tag grouping', () => {
    const nodes = [
      makeNode({ id: 'zAuth', method: 'POST', path: '/z', tags: ['zzz-last-tag'], isAuthEndpoint: true }),
      makeNode({ id: 'aUser', method: 'POST', path: '/users', tags: ['aaa-first-tag'] }),
    ];
    const vis = buildVisualization(makeDag(nodes, [nodes.map(n => n.id)]));
    // Even though 'zzz-last-tag' > 'aaa-first-tag', auth comes first
    expect(xOf(vis, 'zAuth')).toBeLessThan(xOf(vis, 'aUser'));
  });

  // ── Layout-3: barycenter crossing reduction ───────────────────────────────

  // Helper: count edge crossings in the visualization output.
  // Two edges cross if, on adjacent Y levels, their X ordering inverts.
  function countVisualCrossings(vis: ReturnType<typeof buildVisualization>): number {
    // Group nodes by Y
    const byY = new Map<number, { id: string; x: number }[]>();
    for (const n of vis.nodes) {
      if (!byY.has(n.position.y)) byY.set(n.position.y, []);
      byY.get(n.position.y)!.push({ id: n.id, x: n.position.x });
    }
    for (const list of byY.values()) list.sort((a, b) => a.x - b.x);

    // For each edge find source Y and target Y
    const ys = Array.from(byY.keys()).sort((a, b) => a - b);
    let crossings = 0;
    for (let i = 0; i < ys.length - 1; i++) {
      const upY = ys[i];
      const loY = ys[i + 1];
      const upList = byY.get(upY)!;
      const loList = byY.get(loY)!;
      const upIdx = new Map(upList.map((x, i) => [x.id, i]));
      const loIdx = new Map(loList.map((x, i) => [x.id, i]));
      const relevantEdges = vis.edges.filter(e => upIdx.has(e.source) && loIdx.has(e.target));
      for (let a = 0; a < relevantEdges.length; a++) {
        for (let b = a + 1; b < relevantEdges.length; b++) {
          const e1 = relevantEdges[a];
          const e2 = relevantEdges[b];
          const s1 = upIdx.get(e1.source)!;
          const s2 = upIdx.get(e2.source)!;
          const t1 = loIdx.get(e1.target)!;
          const t2 = loIdx.get(e2.target)!;
          if ((s1 - s2) * (t1 - t2) < 0) crossings++;
        }
      }
    }
    return crossings;
  }

  test('Layout-3: resolves classic X-crossing between two levels', () => {
    // Level 0: [A, B]
    // Level 1: [X, Y]
    // Edges: A→Y, B→X   — one crossing
    // After barycenter: level 1 reorders to [Y, X], crossings = 0
    const nodes = [
      makeNode({ id: 'A', method: 'POST', path: '/a' }),
      makeNode({ id: 'B', method: 'POST', path: '/b' }),
      makeNode({ id: 'X', method: 'GET', path: '/x', dependsOn: ['B'] }),
      makeNode({ id: 'Y', method: 'GET', path: '/y', dependsOn: ['A'] }),
    ];
    const dag = makeDag(nodes, [['A', 'B'], ['X', 'Y']]);
    const vis = buildVisualization(dag);
    const crossings = countVisualCrossings(vis);
    expect(crossings).toBe(0);
  });

  test('Layout-3: reduces crossings on a complex 3-level graph', () => {
    // Level 0: A, B, C
    // Level 1: P, Q, R
    // Level 2: X, Y, Z
    // Intentionally deranged edges to produce initial crossings
    const nodes = [
      makeNode({ id: 'A', method: 'POST', path: '/A' }),
      makeNode({ id: 'B', method: 'POST', path: '/B' }),
      makeNode({ id: 'C', method: 'POST', path: '/C' }),
      makeNode({ id: 'P', method: 'GET', path: '/P', dependsOn: ['C'] }),
      makeNode({ id: 'Q', method: 'GET', path: '/Q', dependsOn: ['B'] }),
      makeNode({ id: 'R', method: 'GET', path: '/R', dependsOn: ['A'] }),
      makeNode({ id: 'X', method: 'DELETE', path: '/X', dependsOn: ['R'] }),
      makeNode({ id: 'Y', method: 'DELETE', path: '/Y', dependsOn: ['Q'] }),
      makeNode({ id: 'Z', method: 'DELETE', path: '/Z', dependsOn: ['P'] }),
    ];
    const dag = makeDag(nodes, [
      ['A', 'B', 'C'],
      ['P', 'Q', 'R'],
      ['X', 'Y', 'Z'],
    ]);
    const vis = buildVisualization(dag);
    const crossings = countVisualCrossings(vis);
    // Barycenter should resolve all cross-level inversions in this symmetric case
    expect(crossings).toBe(0);
  });

  test('Layout-3: is deterministic (same input → same output)', () => {
    const mkNodes = () => [
      makeNode({ id: 'A', method: 'POST', path: '/a' }),
      makeNode({ id: 'B', method: 'POST', path: '/b' }),
      makeNode({ id: 'X', method: 'GET', path: '/x', dependsOn: ['B'] }),
      makeNode({ id: 'Y', method: 'GET', path: '/y', dependsOn: ['A'] }),
    ];
    const vis1 = buildVisualization(makeDag(mkNodes(), [['A', 'B'], ['X', 'Y']]));
    const vis2 = buildVisualization(makeDag(mkNodes(), [['B', 'A'], ['Y', 'X']])); // input order reversed
    const pos1 = new Map(vis1.nodes.map(n => [n.id, n.position]));
    const pos2 = new Map(vis2.nodes.map(n => [n.id, n.position]));
    for (const id of ['A', 'B', 'X', 'Y']) {
      expect(pos1.get(id)).toEqual(pos2.get(id));
    }
  });

  test('Layout-3: preserves Layout-1 invariants (no orphans, all edges kept)', () => {
    const nodes = [
      makeNode({ id: 'A', method: 'POST', path: '/a' }),
      makeNode({ id: 'B', method: 'POST', path: '/b' }),
      makeNode({ id: 'C', method: 'POST', path: '/c' }),
      makeNode({ id: 'X', method: 'GET', path: '/x', dependsOn: ['C'] }),
      makeNode({ id: 'Y', method: 'GET', path: '/y', dependsOn: ['A'] }),
      makeNode({ id: 'Z', method: 'GET', path: '/z', dependsOn: ['B'] }),
    ];
    const vis = buildVisualization(makeDag(nodes, [['A', 'B', 'C'], ['X', 'Y', 'Z']]));
    // All 6 nodes + 3 edges present
    expect(vis.nodes).toHaveLength(6);
    expect(vis.edges).toHaveLength(3);
    // All positions finite
    for (const n of vis.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  test('Layout-3: does not break pinned auth node (auth always at Y=0)', () => {
    // Even if barycenter would pull an auth node, it must stay at level 0.
    const nodes = [
      makeNode({
        id: 'authLogin',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
        dependsOn: [],
      }),
      makeNode({ id: 'getA', method: 'GET', path: '/a', dependsOn: ['authLogin'] }),
      makeNode({ id: 'getB', method: 'GET', path: '/b', dependsOn: ['authLogin'] }),
      makeNode({ id: 'getC', method: 'GET', path: '/c', dependsOn: ['authLogin'] }),
    ];
    const vis = buildVisualization(makeDag(nodes, [['authLogin'], ['getA', 'getB', 'getC']]));
    // Auth must be at the topmost Y
    const ys = allYs(vis);
    expect(yOf(vis, 'authLogin')).toBe(ys[0]);
  });

  test('Layout-3: ADVERSARIAL auth pin — auth children on far right must not drag auth right', () => {
    // Level 0: [auth, A, B] after Layout-1 initial sort
    // Level 1: [X, Y, Z]
    // Edges: A→X, B→Y, auth→Z
    // Upward barycenter of L0:
    //   A  → children [X] idx 0 → bary 0
    //   B  → children [Y] idx 1 → bary 1
    //   auth → children [Z] idx 2 → bary 2
    // Without pinning, auth would migrate to the RIGHTMOST position.
    // With pinning, auth must stay at idx 0.
    const nodes = [
      makeNode({
        id: 'authLogin',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
      }),
      makeNode({ id: 'rootA', method: 'POST', path: '/rootA' }),
      makeNode({ id: 'rootB', method: 'POST', path: '/rootB' }),
      makeNode({ id: 'nodeX', method: 'GET', path: '/x', dependsOn: ['rootA'] }),
      makeNode({ id: 'nodeY', method: 'GET', path: '/y', dependsOn: ['rootB'] }),
      makeNode({ id: 'nodeZ', method: 'GET', path: '/z', dependsOn: ['authLogin'] }),
    ];
    const vis = buildVisualization(
      makeDag(nodes, [['authLogin', 'rootA', 'rootB'], ['nodeX', 'nodeY', 'nodeZ']]),
    );
    // authLogin must still be the leftmost node at Y=0
    const level0 = vis.nodes
      .filter(n => n.position.y === yOf(vis, 'authLogin'))
      .sort((a, b) => a.position.x - b.position.x);
    expect(level0[0].id).toBe('authLogin');
  });

  test('Layout-3: auth stays leftmost on level 0 even with other root nodes', () => {
    // Level 0: [auth, A, B]  (auth isAuth=true, A/B regular)
    // Level 1: [X, Y, Z]
    // Edges: A→Z, B→Y, auth→X
    // Classic barycenter would want to put auth between A and B based on
    // X's bary. Our Layout-1 rule says auth is always leftmost. Test that
    // stays true after Layout-3.
    const nodes = [
      makeNode({
        id: 'authLogin',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
      }),
      makeNode({ id: 'rootA', method: 'POST', path: '/rootA' }),
      makeNode({ id: 'rootB', method: 'POST', path: '/rootB' }),
      makeNode({ id: 'nodeX', method: 'GET', path: '/x', dependsOn: ['authLogin'] }),
      makeNode({ id: 'nodeY', method: 'GET', path: '/y', dependsOn: ['rootB'] }),
      makeNode({ id: 'nodeZ', method: 'GET', path: '/z', dependsOn: ['rootA'] }),
    ];
    const vis = buildVisualization(
      makeDag(nodes, [['authLogin', 'rootA', 'rootB'], ['nodeX', 'nodeY', 'nodeZ']]),
    );
    // authLogin must be the leftmost node at Y=0
    const level0 = vis.nodes
      .filter(n => n.position.y === yOf(vis, 'authLogin'))
      .sort((a, b) => a.position.x - b.position.x);
    expect(level0[0].id).toBe('authLogin');
  });

  // ── Regression cases ──────────────────────────────────────────────────────

  test('empty parallelGroups → all nodes go into orphan row', () => {
    const nodes = [
      makeNode({ id: 'a', method: 'GET', path: '/a' }),
      makeNode({ id: 'b', method: 'POST', path: '/b' }),
    ];
    // Empty parallelGroups — forces orphan path
    const vis = buildVisualization({
      nodes,
      executionOrder: ['a', 'b'],
      parallelGroups: [],
      summary: '',
      totalEndpoints: 2,
      unsupportedEndpoints: [],
    });
    expect(vis.nodes).toHaveLength(2);
    // Both should have valid (non-NaN) positions
    for (const n of vis.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });
});
