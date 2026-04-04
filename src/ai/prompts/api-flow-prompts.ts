/**
 * ═══════════════════════════════════════════════════════════════════════════
 * API FLOW PROMPTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AI prompts for:
 * - Dependency resolution (building execution DAG from parsed spec)
 * - Flow summary generation
 * - Large spec batching (30-endpoint chunks → merged DAG)
 */

import type { ParsedApiSpec, ParsedEndpoint, ExecutionDAG } from '@/services/testing/api/flow/flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function serializeEndpointCompact(ep: ParsedEndpoint, index: number): string {
  const params = ep.parameters
    .map(p => `${p.name}(${p.in}${p.required ? ',req' : ''})`)
    .join(', ');

  const reqBody = ep.requestBody
    ? `Body[${ep.requestBody.contentType}]: ${JSON.stringify(ep.requestBody.schema || ep.requestBody.example || {}).slice(0, 200)}`
    : '';

  const resp200 = ep.responses['200'] || ep.responses['201'] || ep.responses['2xx'];
  const respSchema = resp200?.schema
    ? `Resp: ${JSON.stringify(resp200.schema).slice(0, 200)}`
    : '';

  const flags = [
    ep.hasFileUpload ? 'FILE_UPLOAD' : '',
    ep.isPagination ? 'PAGINATION' : '',
    ep.deprecated ? 'DEPRECATED' : '',
  ].filter(Boolean).join('|');

  return [
    `[${index}] ${ep.method} ${ep.path}`,
    `  operationId: ${ep.operationId}`,
    ep.summary ? `  summary: ${ep.summary}` : '',
    ep.tags.length ? `  tags: ${ep.tags.join(',')}` : '',
    params ? `  params: ${params}` : '',
    reqBody ? `  ${reqBody}` : '',
    respSchema ? `  ${respSchema}` : '',
    ep.security.length ? `  security: ${ep.security.join(',')}` : '',
    flags ? `  flags: ${flags}` : '',
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwaggerDependencySystemPrompt(): string {
  return `You are an expert API architect and QA engineer with deep knowledge of REST API design patterns.
Your task: analyze OpenAPI specifications and build execution DAGs for API flow testing.
Output ONLY valid JSON. Never include markdown, code blocks, or explanations outside the JSON.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DAG PROMPT
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwaggerDependencyPrompt(
  spec: ParsedApiSpec,
  chunkEndpoints?: ParsedEndpoint[], // if batching large specs
): string {
  const endpoints = chunkEndpoints || spec.endpoints;
  const endpointList = endpoints.map(serializeEndpointCompact).join('\n\n');

  const authSchemesStr = spec.authSchemes.length
    ? spec.authSchemes.map(s => `${s.name}(${s.type}${s.in ? ',in:' + s.in : ''})`).join(', ')
    : 'none detected';

  return `Analyze these API endpoints and build an execution DAG for sequential testing.

=== API INFO ===
Title: ${spec.title}
Base URL: ${spec.baseUrl}
Auth Schemes: ${authSchemesStr}

=== ENDPOINTS (${endpoints.length} total) ===
${endpointList}

=== ANALYSIS RULES ===

1. AUTH ENDPOINTS FIRST
   - Endpoints with "login", "signin", "token", "auth", "oauth" in path → isAuthEndpoint: true
   - They must have priority 0 and be in executionOrder first
   - Extract token from their response (look for: access_token, token, jwt, id_token, auth_token fields)

2. DEPENDENCY DETECTION
   - If endpoint B's path has {userId} and endpoint A (POST /users) returns { id: "..." } → B depends on A
   - Match response field names to path params: id → {id}, userId → {userId}, orderId → {orderId}
   - If endpoint requires Authorization header and there's an auth endpoint → inject auth_token
   - POST/create before GET/read of the same resource
   - POST/create before PUT/update of the same resource
   - POST/create before DELETE of the same resource

3. VARIABLE EXTRACTION (from responses)
   - Look at response schema fields. Common patterns:
     * { access_token, token, jwt } → variableName: "auth_token", jsonPath: "$.access_token" (or $.token etc.)
     * { id, _id } → variableName: "<resource>_id" where resource = path segment before /id
     * { refresh_token } → variableName: "refresh_token"
     * { data: { id } } → jsonPath: "$.data.id"
   - Extract IDs from newly created resources (POST responses)

4. VARIABLE INJECTION (into requests)
   - Authorization header: injectAs: "header", targetKey: "Authorization", prefix: "Bearer "
   - Path params: injectAs: "path_param", targetKey: "userId" (must match param name exactly)
   - Query params: injectAs: "query_param", targetKey: "filter"
   - Body fields: injectAs: "body_field", targetKey: "userId"

5. PARALLEL EXECUTION
   - Endpoints at the same dependency level (no interdependencies) → canRunParallel: true
   - Group them in parallelGroups

6. SAMPLE DATA
   - Generate realistic fake data for sampleRequestBody
   - Emails: test_${Date.now()}@example.com pattern
   - Names: "Test User", "John Doe"
   - Passwords: "TestPass123!"
   - Numbers: realistic for context (age: 25, quantity: 1, price: 9.99)

7. SPECIAL CASES
   - PAGINATION endpoints: isPagination: true, execute once with page=1/limit=10
   - FILE UPLOAD: hasFileUpload: true — still include but mark it
   - DEPRECATED: still include but add to sampleRequestBody a note
   - If endpoint has no clear dependencies and doesn't need auth → canRunParallel: true at priority level after auth

=== OUTPUT FORMAT ===
Return ONLY this JSON structure (no markdown):
{
  "nodes": [
    {
      "id": "string — use operationId, or METHOD_path_sanitized if no operationId",
      "method": "GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS",
      "path": "/path/to/endpoint",
      "operationId": "string",
      "summary": "string",
      "tags": ["string"],
      "dependsOn": ["node_id_1"],
      "variableExtractions": [
        {
          "variableName": "auth_token",
          "jsonPath": "$.access_token",
          "headerSource": null
        }
      ],
      "variableInjections": [
        {
          "variableName": "auth_token",
          "injectAs": "header",
          "targetKey": "Authorization",
          "prefix": "Bearer "
        }
      ],
      "priority": 0,
      "isAuthEndpoint": false,
      "isPagination": false,
      "hasFileUpload": false,
      "isUnsupported": false,
      "unsupportedReason": null,
      "canRunParallel": false,
      "sampleRequestBody": {},
      "sampleQueryParams": {},
      "expectedStatusCodes": [200, 201]
    }
  ],
  "executionOrder": ["node_id_1", "node_id_2"],
  "parallelGroups": [["auth_login"], ["get_users", "get_products"], ["post_order"]],
  "summary": "One sentence describing the API flow",
  "totalEndpoints": ${endpoints.length},
  "unsupportedEndpoints": []
}

=== CRITICAL CONSTRAINTS ===
- executionOrder MUST be a valid topological sort (no node before its dependencies)
- Every variableName in variableInjections MUST be produced by a prior node's variableExtractions
- If an endpoint needs multiple prior values, list ALL in dependsOn and ALL in variableInjections
- Nodes with no dependencies and no dependents: canRunParallel: true, put in parallelGroups together
- Auth endpoints: priority 0, dependsOn: [], always first in executionOrder`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE PROMPT (for batching large specs)
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwaggerDagMergePrompt(
  partialDags: Array<{ nodes: any[]; executionOrder: string[] }>,
  spec: ParsedApiSpec,
): string {
  const allNodes = partialDags.flatMap(d => d.nodes);
  const nodesSummary = allNodes.map(n =>
    `${n.id}: ${n.method} ${n.path} | dependsOn: [${n.dependsOn?.join(', ') || ''}] | extracts: [${(n.variableExtractions || []).map((e: any) => e.variableName).join(', ')}]`
  ).join('\n');

  return `You have ${partialDags.length} partial DAGs from a large API spec (${allNodes.length} total nodes).
Merge them into one coherent execution DAG. Ensure cross-batch dependencies are correctly linked.

=== ALL NODES ===
${nodesSummary}

=== BASE URL ===
${spec.baseUrl}

Produce a merged DAG in the same JSON format as before. The executionOrder must be a valid topological sort across ALL nodes combined.
Return ONLY valid JSON.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOW SUMMARY PROMPT
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwaggerFlowSummaryPrompt(dag: ExecutionDAG, title: string): string {
  const authNodes = dag.nodes.filter(n => n.isAuthEndpoint).map(n => `${n.method} ${n.path}`).join(', ');
  const criticalPath = dag.executionOrder.slice(0, 5).join(' → ');

  return `Given this API flow execution plan, write a 2-3 sentence human-readable summary for a QA engineer.

API: ${title}
Total endpoints: ${dag.totalEndpoints}
Auth endpoints: ${authNodes || 'none'}
Critical path (first 5 steps): ${criticalPath}
Parallel groups: ${dag.parallelGroups.length}

Write a brief summary explaining what this flow tests. Include: authentication method, main resources/flows tested, any notable patterns.
Return ONLY the summary text, no JSON.`;
}
