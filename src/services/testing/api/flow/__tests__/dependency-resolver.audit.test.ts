/**
 * Audit test cases for the deterministic wiring passes and the topological
 * sort / level assignment, from a July 2026 audit.
 *
 *   ✅ CORRECT — desired behavior.
 *   🐛 PINS CURRENT BEHAVIOR — confirmed defect; assertion matches today's
 *      (buggy) output with a comment on what correct behavior would be.
 */
import { __testables } from '../dependency-resolver.service';

const { autoWireRequiredAuth, autoWireVariableDependencies, autoResolveReferenceIds } = __testables;

function node(p: any): any {
  return {
    id: p.id, method: p.method || 'GET', path: p.path || '/', operationId: p.id,
    tags: [], dependsOn: p.dependsOn || [],
    variableExtractions: p.variableExtractions || [],
    variableInjections: p.variableInjections || [],
    priority: 0, isAuthEndpoint: !!p.isAuthEndpoint, isPagination: false,
    hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    sampleRequestBody: p.sampleRequestBody, sampleQueryParams: p.sampleQueryParams,
    expectedStatusCodes: [200],
  };
}

describe('autoWireVariableDependencies', () => {
  it('✅ orders a consumer after the producer of the value it injects', () => {
    const producer = node({ id: 'upload', method: 'POST', path: '/files',
      variableExtractions: [{ variableName: 'file_id', jsonPath: '$.id' }] });
    const consumer = node({ id: 'delete', method: 'DELETE', path: '/files/{id}',
      variableInjections: [{ variableName: 'file_id', injectAs: 'path_param', targetKey: 'id' }] });
    const out = autoWireVariableDependencies([consumer, producer]);
    expect(out.find(n => n.id === 'delete')!.dependsOn).toContain('upload');
  });

  it('✅ does not create a 3-node cycle A→B→C→A (transitive guard)', () => {
    // Each node injects a var the next produces. wouldCreateCycle walks the live
    // dependency map, so the ring-closing edge C→A is refused — no cycle forms.
    const A = node({ id: 'A', variableExtractions: [{ variableName: 'vA', jsonPath: '$.a' }],
      variableInjections: [{ variableName: 'vB', injectAs: 'body_field', targetKey: 'b' }] });
    const B = node({ id: 'B', variableExtractions: [{ variableName: 'vB', jsonPath: '$.b' }],
      variableInjections: [{ variableName: 'vC', injectAs: 'body_field', targetKey: 'c' }] });
    const C = node({ id: 'C', variableExtractions: [{ variableName: 'vC', jsonPath: '$.c' }],
      variableInjections: [{ variableName: 'vA', injectAs: 'body_field', targetKey: 'a' }] });
    const out = autoWireVariableDependencies([A, B, C]);
    const deps = Object.fromEntries(out.map(n => [n.id, n.dependsOn]));
    expect(deps.A).toContain('B');
    expect(deps.B).toContain('C');
    expect(deps.C).not.toContain('A'); // ring-closing edge refused
  });
});

describe('autoWireRequiredAuth — multi-realm', () => {
  it('✅ an admin endpoint is wired to the ADMIN login and bound to its token', () => {
    // Two independent auth realms both extracting `auth_token`. autoWireRequiredAuth
    // partitions producers by realm prefix, so GET /admin/users depends on adminLogin
    // and its Authorization injection is bound (sourceNodeId) to adminLogin — the
    // admin token, not the user's.
    const userLogin = node({ id: 'userLogin', method: 'POST', path: '/auth/login', isAuthEndpoint: true,
      variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.token' }] });
    const adminLogin = node({ id: 'adminLogin', method: 'POST', path: '/admin/login', isAuthEndpoint: true,
      variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.token' }] });
    const adminEp = node({ id: 'adminEp', method: 'GET', path: '/admin/users' });
    const spec: any = { endpoints: [
      { method: 'POST', path: '/auth/login', security: [] },
      { method: 'POST', path: '/admin/login', security: [] },
      { method: 'GET', path: '/admin/users', security: ['bearerAuth'] },
    ] };
    const out = autoWireRequiredAuth([userLogin, adminLogin, adminEp], spec);
    const ae = out.find(n => n.id === 'adminEp')!;
    expect(ae.dependsOn).toEqual(['adminLogin']);
    const authInj = ae.variableInjections.find(i => i.targetKey === 'Authorization')!;
    expect(authInj).toBeDefined();
    expect(authInj.sourceNodeId).toBe('adminLogin');
  });
});

describe('autoResolveReferenceIds', () => {
  it('✅ rewrites a fabricated countryId to {{country_id}} sourced from a /countries list', () => {
    const consumer = node({ id: 'create', method: 'POST', path: '/addresses',
      sampleRequestBody: { countryId: 'zz-fake' } });
    const list = node({ id: 'countries', method: 'GET', path: '/geo/countries' });
    const { nodes } = autoResolveReferenceIds([consumer, list]);
    const c = nodes.find(n => n.id === 'create')!;
    expect(c.sampleRequestBody.countryId).toBe('{{country_id}}');
    // the list endpoint is promoted to a producer of country_id
    expect(nodes.find(n => n.id === 'countries')!.variableExtractions
      .some(e => e.variableName === 'country_id')).toBe(true);
  });

  it('✅ does NOT rewrite id-like fields that have no matching list/producer (androidId, gridId)', () => {
    // Confirms the pass is precise: only fields with a real producer/list are
    // touched; unrelated *Id fields pass through as fabricated data.
    const consumer = node({ id: 'c', method: 'POST', path: '/devices',
      sampleRequestBody: { androidId: 'abc', gridId: 'g1', countryId: 'zz' } });
    const list = node({ id: 'countries', method: 'GET', path: '/geo/countries' });
    const { nodes } = autoResolveReferenceIds([consumer, list]);
    const c = nodes.find(n => n.id === 'c')!;
    expect(c.sampleRequestBody.androidId).toBe('abc');
    expect(c.sampleRequestBody.gridId).toBe('g1');
    expect(c.sampleRequestBody.countryId).toBe('{{country_id}}');
  });

  it('🐛 mis-singularizes uncountable/irregular collection names → id silently NOT linked', () => {
    // `/status` → entity "statu", `/news` → "new": neither matches statusId/newsId,
    // so the fabricated ids are left as-is (a silent miss, not a wrong link).
    // CORRECT: a robust singularizer (or explicit mapping) would link them.
    const consumer = node({ id: 'c', method: 'POST', path: '/things',
      sampleRequestBody: { statusId: '1', newsId: '2' } });
    const listStatus = node({ id: 'st', method: 'GET', path: '/status' });
    const listNews = node({ id: 'nw', method: 'GET', path: '/news' });
    const { nodes } = autoResolveReferenceIds([consumer, listStatus, listNews]);
    const c = nodes.find(n => n.id === 'c')!;
    expect(c.sampleRequestBody).toEqual({ statusId: '1', newsId: '2' }); // unchanged
  });
});

/**
 * Topological level assignment (buildParallelGroups → getLevel) is module-private
 * and not exported. This mirrors the exact implementation to pin the crash a
 * SURVIVING cycle causes: the "persistent cycle → force flat order" fallback in
 * resolve() does NOT re-run breakCycles, so node.dependsOn can still be cyclic
 * when buildParallelGroups runs. getLevel recurses with no on-stack guard.
 */
describe('buildParallelGroups.getLevel (mirrored private impl)', () => {
  function getLevelGroups(nodes: any[], executionOrder: string[]): string[][] {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const levelCache = new Map<string, number>();
    function getLevel(nodeId: string): number {
      if (levelCache.has(nodeId)) return levelCache.get(nodeId)!;
      const nd = nodeMap.get(nodeId);
      if (!nd || nd.dependsOn.length === 0) { levelCache.set(nodeId, 0); return 0; }
      const maxParent = Math.max(...nd.dependsOn.map((d: string) => getLevel(d)));
      const level = maxParent + 1;
      levelCache.set(nodeId, level);
      return level;
    }
    const levelMap = new Map<number, string[]>();
    for (const id of executionOrder) {
      const level = getLevel(id);
      if (!levelMap.has(level)) levelMap.set(level, []);
      levelMap.get(level)!.push(id);
    }
    return Array.from(levelMap.entries()).sort(([a], [b]) => a - b).map(([, ids]) => ids);
  }

  it('✅ assigns levels correctly for an acyclic chain', () => {
    const nodes = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    expect(getLevelGroups(nodes, ['A', 'B', 'C'])).toEqual([['A'], ['B'], ['C']]);
  });

  it('🐛 STACK-OVERFLOWS on a cycle that survived to level assignment', () => {
    // A→C→B→A. Reachable because the persistent-cycle fallback forces a flat
    // order WITHOUT breaking edges, handing cyclic dependsOn to this function.
    // CORRECT: getLevel needs an on-stack visited guard (return a bounded level
    // for a node currently on the recursion stack).
    const nodes = [
      { id: 'A', dependsOn: ['C'] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    expect(() => getLevelGroups(nodes, ['A', 'B', 'C'])).toThrow(RangeError);
  });
});
