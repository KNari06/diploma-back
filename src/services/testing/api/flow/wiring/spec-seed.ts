/**
 * Deterministically seed DAG nodes from a parsed spec (Phase 1, increment 1a).
 *
 * The Architect LLM used to invent every node's variableExtractions /
 * variableInjections, then deterministic safety-net passes patched the result.
 * This module derives that wiring metadata DIRECTLY from the spec's own schemas —
 * response fields (what an endpoint PRODUCES) and path/query/body params (what it
 * CONSUMES) — so the candidate-graph builder (increment 1b) can wire edges
 * without asking the LLM to hallucinate them.
 *
 * Scope of this module: seeding only (no cross-node edges, no ordering).
 * It produces bare `DAGNode`s with:
 *  - auth producers: login/register/verify endpoints get an auth-token extraction
 *    (Bearer when the 2xx body carries a token field, else cookie via Set-Cookie)
 *    and `isAuthEndpoint = true`.
 *  - reference producers: create (`$.id`) and list (`$[0].id`) endpoints get an
 *    `<entity>_id` extraction so downstream consumers can inject it. Arbitrated so
 *    each `<entity>_id` has exactly ONE producer (see `arbitrateReferenceProducers`).
 *  - consumers: path params, required `*Id` query params and `*Id` body fields
 *    become injections named in canonical `<field>_id` snake form.
 *
 * Producer and consumer names must AGREE for a value to flow, so both derive the
 * entity from the same place — the path — whenever the field name doesn't carry
 * one itself (`{id}` → `user_id` under `/users`, never the nonexistent `id_id`).
 */

import type { DAGNode, HttpMethod, ParsedApiSpec, ParsedEndpoint } from '../flow.types';
import {
  isAuthEstablishPath,
  isGenericIdParam,
  isItemPath,
  isReferenceIdField,
  isSnakeIdVar,
  isTokenField,
  lastPathSegment,
  pathEntityFor,
  singularize,
  toSnakeCase,
} from './wiring-policy';

/** camelCase / snake `*Id` → canonical `<name>_id` variable name (cityId → city_id). */
export function refVarName(field: string): string {
  const snake = toSnakeCase(field);
  return /_id$/.test(snake) ? snake : `${snake}_id`;
}

/**
 * The variable a path param consumes. A param that names its own entity is
 * authoritative (`{userId}` → `user_id`, even under `/projects/`); a generic
 * `{id}` means whatever its path says it means (`/users/{id}` → `user_id`).
 */
export function pathParamVarName(path: string, paramName: string): string {
  if (isGenericIdParam(paramName)) {
    const entity = pathEntityFor(path, paramName);
    if (entity) return `${entity}_id`;
  }
  return refVarName(paramName);
}

function twoxxResponse(ep: ParsedEndpoint): { status: string; schema?: any } | null {
  for (const status of Object.keys(ep.responses)) {
    if (/^2\d\d$/.test(status)) return { status, schema: ep.responses[status]?.schema };
  }
  return null;
}

/** Top-level property names of an object schema, or of an array's item schema. */
function topLevelProps(schema: any): string[] {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.type === 'array' && schema.items?.properties) return Object.keys(schema.items.properties);
  if (schema.properties) return Object.keys(schema.properties);
  return [];
}

function isArraySchema(schema: any): boolean {
  return !!schema && schema.type === 'array';
}

function bareNode(ep: ParsedEndpoint): DAGNode {
  const twoxx = Object.keys(ep.responses)
    .filter(s => /^2\d\d$/.test(s))
    .map(Number);
  return {
    id: ep.operationId,
    method: ep.method as HttpMethod,
    path: ep.path,
    operationId: ep.operationId,
    summary: ep.summary || undefined,
    tags: ep.tags || [],
    dependsOn: [],
    variableExtractions: [],
    variableInjections: [],
    priority: 0,
    isAuthEndpoint: false,
    isPagination: !!ep.isPagination,
    hasFileUpload: !!ep.hasFileUpload,
    isUnsupported: false,
    canRunParallel: false,
    expectedStatusCodes: twoxx.length ? twoxx : [200, 201],
  };
}

/**
 * An endpoint produces an auth credential when EITHER signal holds:
 *  - its 2xx response body carries a token field (accessToken/token/jwt/…) — the
 *    strongest, path-independent signal. This catches domain-specific issuers
 *    like `POST /student/proctoring/jwt` that no login-path heuristic would find.
 *  - it is a session-ESTABLISHING path (login/register/verify/refresh) that
 *    returns no body token → the credential is a Set-Cookie session.
 * Only POST/PUT qualify (a GET never establishes a session).
 */
function seedAuthProducer(node: DAGNode, ep: ParsedEndpoint): void {
  if (!['POST', 'PUT'].includes(node.method)) return;

  const twoxx = twoxxResponse(ep);
  const tokenField = topLevelProps(twoxx?.schema).find(p => isTokenField(p));
  if (tokenField) {
    // Bearer: token is in the JSON body (any path — the body is ground truth).
    node.variableExtractions.push({ variableName: 'auth_token', jsonPath: `$.${tokenField}` });
    node.isAuthEndpoint = true;
  } else if (isAuthEstablishPath(ep.path)) {
    // Auth path with no body token → session cookie (from the Set-Cookie header).
    node.variableExtractions.push({ variableName: 'session_token', headerSource: 'Set-Cookie' });
    node.isAuthEndpoint = true;
  }
}

/** Create (`$.id`) and list (`$[0].id`) endpoints produce an `<entity>_id`. */
function seedReferenceProducer(node: DAGNode, ep: ParsedEndpoint): void {
  if (node.isAuthEndpoint) return; // auth endpoints aren't reference producers
  const twoxx = twoxxResponse(ep);
  if (!twoxx?.schema) return;
  // An item fetch (`GET /users/{id}`) produces nothing reusable: its response is a
  // single object, so `$[0].id` reads nothing, and the id it echoes had to come
  // from a producer upstream anyway.
  if (node.method === 'GET' && isItemPath(ep.path)) return;
  const props = topLevelProps(twoxx.schema);
  const entity = singularize(lastPathSegment(ep.path)).toLowerCase();
  if (!entity) return;

  const isList = isArraySchema(twoxx.schema);
  // Prefer a plain `id`, else an `<entity>Id`-style field in the response.
  const idField = props.find(p => /^id$/i.test(p)) || props.find(p => isReferenceIdField(p));
  if (!idField) return;

  const varName = `${entity}_id`;
  const jsonPath = isList ? `$[0].${idField}` : `$.${idField}`;
  if (!node.variableExtractions.some(e => e.variableName === varName)) {
    node.variableExtractions.push({ variableName: varName, jsonPath });
  }
}

/**
 * Leave exactly ONE producer per `<entity>_id` — a create beats a list.
 *
 * `POST /users` and `GET /users` both produce `user_id` and have no data edge
 * between them, so they land in the same parallel group and both write the run
 * context: whichever responds last wins. A downstream `DELETE /users/{userId}`
 * would then delete a PRE-EXISTING user roughly half the time. Prefer the entity
 * this run created; keep a list producer only when nothing creates that entity
 * (`autoResolveReferenceIds` still promotes one on demand if a gap remains).
 *
 * Auth vars are out of scope — realms legitimately share `auth_token` today, and
 * separating them needs per-realm names, not arbitration.
 */
function arbitrateReferenceProducers(nodes: DAGNode[]): void {
  const byVar = new Map<string, DAGNode[]>();
  for (const node of nodes) {
    for (const e of node.variableExtractions) {
      if (!isSnakeIdVar(e.variableName)) continue;
      byVar.set(e.variableName, [...(byVar.get(e.variableName) || []), node]);
    }
  }

  for (const [varName, producers] of byVar) {
    if (producers.length < 2) continue;
    const creates = producers.filter(n => n.method === 'POST');
    const [keep] = creates.length ? creates : producers; // spec order — deterministic
    for (const node of producers) {
      if (node === keep) continue;
      node.variableExtractions = node.variableExtractions.filter(e => e.variableName !== varName);
    }
  }
}

/** Path params, required `*Id` query params, and `*Id` body fields become injections. */
function seedConsumers(node: DAGNode, ep: ParsedEndpoint): void {
  const add = (variableName: string, injectAs: DAGNode['variableInjections'][number]['injectAs'], targetKey: string) => {
    if (!node.variableInjections.some(i => i.variableName === variableName && i.targetKey === targetKey)) {
      node.variableInjections.push({ variableName, injectAs, targetKey });
    }
  };

  for (const p of ep.parameters || []) {
    if (p.in === 'path') add(pathParamVarName(ep.path, p.name), 'path_param', p.name);
    else if (p.in === 'query' && p.required && isReferenceIdField(p.name)) add(refVarName(p.name), 'query_param', p.name);
  }

  for (const field of topLevelProps(ep.requestBody?.schema)) {
    if (isReferenceIdField(field)) add(refVarName(field), 'body_field', field);
  }
}

/** Build bare, deterministically-seeded nodes — one per spec endpoint. */
export function seedNodesFromSpec(spec: ParsedApiSpec): DAGNode[] {
  const nodes = spec.endpoints.map(ep => {
    const node = bareNode(ep);
    seedAuthProducer(node, ep);
    seedReferenceProducer(node, ep);
    seedConsumers(node, ep);
    return node;
  });
  arbitrateReferenceProducers(nodes);
  return nodes;
}
