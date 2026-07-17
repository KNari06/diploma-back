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
 * Scope of this module: per-node seeding only (no cross-node edges, no ordering).
 * It produces bare `DAGNode`s with:
 *  - auth producers: login/register/verify endpoints get an auth-token extraction
 *    (Bearer when the 2xx body carries a token field, else cookie via Set-Cookie)
 *    and `isAuthEndpoint = true`.
 *  - reference producers: create (`$.id`) and list (`$[0].id`) endpoints get an
 *    `<entity>_id` extraction so downstream consumers can inject it.
 *  - consumers: path params, required `*Id` query params and `*Id` body fields
 *    become injections named in canonical `<field>_id` snake form.
 */

import type { DAGNode, HttpMethod, ParsedApiSpec, ParsedEndpoint } from '../flow.types';
import { isAuthEstablishPath, isReferenceIdField, isTokenField, lastPathSegment, singularize, toSnakeCase } from './wiring-policy';

/** camelCase / snake `*Id` → canonical `<name>_id` variable name (cityId → city_id). */
export function refVarName(field: string): string {
  const snake = toSnakeCase(field);
  return /_id$/.test(snake) ? snake : `${snake}_id`;
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
  const props = topLevelProps(twoxx.schema);
  const entity = singularize(lastPathSegment(ep.path)).toLowerCase();
  if (!entity) return;

  const isList = isArraySchema(twoxx.schema) || node.method === 'GET';
  // Prefer a plain `id`, else an `<entity>Id`-style field in the response.
  const idField = props.find(p => /^id$/i.test(p)) || props.find(p => isReferenceIdField(p));
  if (!idField) return;

  const varName = `${entity}_id`;
  const jsonPath = isList ? `$[0].${idField}` : `$.${idField}`;
  if (!node.variableExtractions.some(e => e.variableName === varName)) {
    node.variableExtractions.push({ variableName: varName, jsonPath });
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
    if (p.in === 'path') add(refVarName(p.name), 'path_param', p.name);
    else if (p.in === 'query' && p.required && isReferenceIdField(p.name)) add(refVarName(p.name), 'query_param', p.name);
  }

  for (const field of topLevelProps(ep.requestBody?.schema)) {
    if (isReferenceIdField(field)) add(refVarName(field), 'body_field', field);
  }
}

/** Build bare, deterministically-seeded nodes — one per spec endpoint. */
export function seedNodesFromSpec(spec: ParsedApiSpec): DAGNode[] {
  return spec.endpoints.map(ep => {
    const node = bareNode(ep);
    seedAuthProducer(node, ep);
    seedReferenceProducer(node, ep);
    seedConsumers(node, ep);
    return node;
  });
}
