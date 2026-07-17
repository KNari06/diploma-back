/**
 * API-flow DAG quality metrics — the eval harness scorer.
 *
 * Phase 0 of the Architect-stage refactor: before we can safely change HOW the
 * DAG is built (invert the LLM's role, deterministic candidate graph, …), we
 * need to MEASURE the quality of whatever a build produces. This module scores a
 * built `{ spec, dag }` against the structural invariants a runnable flow must
 * satisfy — INDEPENDENTLY of the pipeline that produced it, so it is a neutral
 * yardstick for comparing the current pipeline vs a future one (never import the
 * resolver's own passes here — that would make the measurement circular).
 *
 * A flow is "runnable" iff:
 *  - no ordering violations   (a consumer never runs before its producer),
 *  - no unresolved injections (every injected var is produced OR user-provided),
 *  - full auth coverage       (every security-required endpoint runs after an
 *                              auth producer),
 *  - no dependency cycle,
 * and, as a soft quality signal, few fabricated reference ids (a `*Id` body/query
 * field left as an invented literal the API would reject).
 */

import type { DAGNode, ParsedApiSpec } from '../flow.types';
// isAuthTokenSuffix: an extracted variable is treated as an auth credential when
// its name ends in "token"/"jwt" (auth_token, admin_token, session_token, …) —
// broader than the resolver's exact-name sets so it catches per-realm tokens.
import { isAuthTokenSuffix } from '../wiring/wiring-policy';

/** Build the `${METHOD}:${path}` → security-scheme-names map the scorer needs. */
export function securityMapFromSpec(spec: ParsedApiSpec): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const ep of spec.endpoints) map.set(`${ep.method}:${ep.path}`, ep.security || []);
  return map;
}

export interface EvalInput {
  name: string;
  nodes: DAGNode[];
  executionOrder: string[];
  /** endpoint `${METHOD}:${path}` → declared security scheme names. */
  securityByEndpoint: Map<string, string[]>;
  /** Variable names the run provides (variableChain / initialVariables keys). */
  providedVars?: string[];
}

export interface EvalScore {
  name: string;
  nodeCount: number;
  totalDeps: number;
  orderingViolations: number;
  unresolvedInjections: number;
  authCoverage: { required: number; covered: number; pct: number };
  hasCycle: boolean;
  fabricatedReferenceIds: number;
  /** True iff all HARD invariants hold (fabricated ids are a soft signal). */
  passed: boolean;
}

/** Earliest execution-order index at which each variable is produced. */
function producedAt(nodes: DAGNode[], order: string[]): Map<string, number> {
  const idx = (id: string) => order.indexOf(id);
  const out = new Map<string, number>();
  for (const n of nodes) {
    for (const e of n.variableExtractions || []) {
      const i = idx(n.id);
      if (!out.has(e.variableName) || i < out.get(e.variableName)!) out.set(e.variableName, i);
    }
  }
  return out;
}

/**
 * A consumer that injects a produced var but runs at or before its producer.
 * User-provided vars are exempt — they hold a seed value from the start, so a
 * consumer scheduled before a later extractor of the same var is not a failure.
 */
export function countOrderingViolations(nodes: DAGNode[], order: string[], providedVars: string[] = []): number {
  const prod = producedAt(nodes, order);
  const provided = new Set(providedVars);
  const idx = (id: string) => order.indexOf(id);
  let violations = 0;
  for (const n of nodes) {
    const ci = idx(n.id);
    for (const inj of n.variableInjections || []) {
      if (provided.has(inj.variableName)) continue;
      const pi = prod.get(inj.variableName);
      if (pi !== undefined && pi >= ci) violations++;
    }
  }
  return violations;
}

/** Injected vars that are neither produced by a step nor user-provided. */
export function countUnresolvedInjections(nodes: DAGNode[], providedVars: string[] = []): number {
  const produced = new Set<string>();
  for (const n of nodes) for (const e of n.variableExtractions || []) produced.add(e.variableName);
  const provided = new Set(providedVars);
  let unresolved = 0;
  for (const n of nodes) {
    for (const inj of n.variableInjections || []) {
      if (!produced.has(inj.variableName) && !provided.has(inj.variableName)) unresolved++;
    }
  }
  return unresolved;
}

/** Fraction of security-required endpoints that transitively depend on an auth producer. */
export function computeAuthCoverage(
  nodes: DAGNode[],
  securityByEndpoint: Map<string, string[]>,
): { required: number; covered: number; pct: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const authProducerIds = new Set(
    nodes.filter(n => (n.variableExtractions || []).some(e => isAuthTokenSuffix(e.variableName))).map(n => n.id),
  );
  const dependsOnAuth = (start: DAGNode): boolean => {
    const seen = new Set<string>();
    const stack = [...start.dependsOn];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (authProducerIds.has(id)) return true;
      const dep = byId.get(id);
      if (dep) stack.push(...dep.dependsOn);
    }
    return false;
  };
  let required = 0;
  let covered = 0;
  for (const n of nodes) {
    if (authProducerIds.has(n.id)) continue; // producers don't need coverage
    const security = securityByEndpoint.get(`${n.method}:${n.path}`) || [];
    if (security.length === 0) continue;
    required++;
    if (dependsOnAuth(n)) covered++;
  }
  return { required, covered, pct: required === 0 ? 100 : Math.round((covered / required) * 100) };
}

/** True if the dependsOn graph contains a cycle (Kahn's algorithm). */
export function hasDependencyCycle(nodes: DAGNode[]): boolean {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, inDegree.get(n.id) ?? 0);
    for (const dep of n.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), n.id]);
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const dep of dependents.get(id) ?? []) {
      const d = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }
  return visited < nodes.length;
}

/** Body/query `*Id` fields left as an invented literal (not a {{placeholder}}). */
export function countFabricatedReferenceIds(nodes: DAGNode[]): number {
  const isLiteralId = (key: string, val: unknown): boolean =>
    /id$/i.test(key) && typeof val === 'string' && !/\{\{.+?\}\}/.test(val);
  const walk = (obj: any): number => {
    if (!obj || typeof obj !== 'object') return 0;
    let count = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === 'object') count += walk(v);
      else if (isLiteralId(k, v)) count++;
    }
    return count;
  };
  let total = 0;
  for (const n of nodes) {
    total += walk(n.sampleRequestBody);
    if (n.sampleQueryParams) for (const [k, v] of Object.entries(n.sampleQueryParams)) if (isLiteralId(k, v)) total++;
  }
  return total;
}

export function scoreDag(input: EvalInput): EvalScore {
  const { name, nodes, executionOrder, securityByEndpoint, providedVars = [] } = input;
  const orderingViolations = countOrderingViolations(nodes, executionOrder, providedVars);
  const unresolvedInjections = countUnresolvedInjections(nodes, providedVars);
  const authCoverage = computeAuthCoverage(nodes, securityByEndpoint);
  const hasCycle = hasDependencyCycle(nodes);
  const fabricatedReferenceIds = countFabricatedReferenceIds(nodes);
  const passed =
    orderingViolations === 0 &&
    unresolvedInjections === 0 &&
    !hasCycle &&
    authCoverage.pct === 100;
  return {
    name,
    nodeCount: nodes.length,
    totalDeps: nodes.reduce((s, n) => s + n.dependsOn.length, 0),
    orderingViolations,
    unresolvedInjections,
    authCoverage,
    hasCycle,
    fabricatedReferenceIds,
    passed,
  };
}

/** Render a set of scores as a fixed-width scorecard table (for the CLI runner). */
export function formatScorecard(scores: EvalScore[]): string {
  const rows = scores.map(s => [
    s.passed ? 'PASS' : 'FAIL',
    s.name,
    String(s.nodeCount),
    String(s.orderingViolations),
    String(s.unresolvedInjections),
    `${s.authCoverage.covered}/${s.authCoverage.required}`,
    s.hasCycle ? 'yes' : 'no',
    String(s.fabricatedReferenceIds),
  ]);
  const header = ['', 'spec', 'nodes', 'ord.viol', 'unres.inj', 'authCov', 'cycle', 'fab.ids'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}
