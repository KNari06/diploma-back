/**
 * ═══════════════════════════════════════════════════════════════════════════
 * API FLOW PROMPTS — 3-Agent Pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Agent 1 (ANALYST):  Reads spec → outputs structured domain analysis
 * Agent 2 (ARCHITECT): Uses analysis + spec → outputs DAG with dependencies
 * Agent 3 (ENRICHER):  Uses DAG + analysis → fills in realistic test data
 *
 * Each agent has a strict output contract consumed by the next agent.
 */

import type { ParsedApiSpec, ParsedEndpoint, ExecutionDAG, DAGNode } from '@/services/testing/api/flow/flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// SERIALIZATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a single endpoint with maximum context.
 * Every field matters — the AI needs to understand what this endpoint does,
 * what data it accepts, and what it returns.
 */
function serializeEndpoint(ep: ParsedEndpoint, index: number): string {
  const params = ep.parameters.map(p => {
    const parts = [`${p.name}(${p.in}${p.required ? ',required' : ',optional'})`];
    if (p.schema?.type) parts.push(p.schema.type);
    if (p.schema?.enum) parts.push(`enum:[${p.schema.enum.join('|')}]`);
    if (p.schema?.format) parts.push(`format=${p.schema.format}`);
    if (p.example !== undefined) parts.push(`example=${JSON.stringify(p.example).slice(0, 60)}`);
    if (p.description) parts.push(`"${p.description.slice(0, 80)}"`);
    return parts.join(' ');
  }).join('\n    ');

  const reqBody = ep.requestBody
    ? `  RequestBody[${ep.requestBody.contentType}${ep.requestBody.required ? ', required' : ''}]:\n    ${JSON.stringify(ep.requestBody.schema || ep.requestBody.example || {}, null, 1).slice(0, 500)}`
    : '';

  const responseLines: string[] = [];
  for (const [code, resp] of Object.entries(ep.responses)) {
    const schema = resp.schema ? JSON.stringify(resp.schema).slice(0, 400) : '';
    responseLines.push(`  Response[${code}]: ${resp.description || ''}${schema ? '\n    Schema: ' + schema : ''}`);
  }

  const flags: string[] = [];
  if (ep.hasFileUpload) flags.push('FILE_UPLOAD');
  if (ep.isPagination) flags.push('PAGINATION');
  if (ep.deprecated) flags.push('DEPRECATED');

  const securityStr = ep.security.length > 0
    ? `  auth_required: [${ep.security.join(', ')}]`
    : '  auth_required: NONE (public endpoint)';

  return [
    `── ENDPOINT [${index}] ──`,
    `  ${ep.method} ${ep.path}`,
    `  operationId: ${ep.operationId}`,
    ep.summary ? `  summary: "${ep.summary}"` : '',
    ep.description ? `  description: "${ep.description.slice(0, 200)}"` : '',
    ep.tags.length ? `  tags: [${ep.tags.join(', ')}]` : '',
    params ? `  parameters:\n    ${params}` : '',
    reqBody,
    ...responseLines,
    securityStr,
    flags.length ? `  flags: [${flags.join(', ')}]` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Compact endpoint summary for the Analyst (doesn't need full schemas).
 */
function serializeEndpointCompact(ep: ParsedEndpoint, index: number): string {
  const resp = ep.responses['200'] || ep.responses['201'];
  const respFields = resp?.schema ? Object.keys(resp.schema.properties || resp.schema || {}).slice(0, 8).join(', ') : '';
  const bodyFields = ep.requestBody?.schema
    ? Object.keys(ep.requestBody.schema.properties || ep.requestBody.schema || {}).slice(0, 8).join(', ')
    : '';
  const pathParams = ep.parameters.filter(p => p.in === 'path').map(p => `{${p.name}}`).join(', ');

  return [
    `[${index}] ${ep.method} ${ep.path}`,
    ep.summary ? `  "${ep.summary}"` : '',
    ep.description ? `  desc: "${ep.description.slice(0, 100)}"` : '',
    ep.tags.length ? `  tags: [${ep.tags.join(', ')}]` : '',
    pathParams ? `  path_params: ${pathParams}` : '',
    bodyFields ? `  accepts: {${bodyFields}}` : '',
    respFields ? `  returns: {${respFields}}` : '',
    ep.security.length > 0 ? `  auth: [${ep.security.join(',')}]` : '  auth: public',
  ].filter(Boolean).join('\n');
}

function serializeAuthSchemes(schemes: import('@/services/testing/api/flow/flow.types').AuthScheme[]): string {
  if (schemes.length === 0) return '  (none detected — API may be public or use inline auth)';
  return schemes.map(s => {
    const lines = [`  ${s.name}:`];
    lines.push(`    type: ${s.type}`);
    if (s.in) lines.push(`    location: ${s.in}`);
    if (s.headerName) lines.push(`    headerName: "${s.headerName}"`);
    if (s.description) lines.push(`    description: "${s.description.slice(0, 100)}"`);
    // Injection mapping for downstream agents
    if (s.type === 'bearer') {
      lines.push(`    injection: { injectAs: "header", targetKey: "Authorization", prefix: "Bearer " }`);
    } else if (s.type === 'apiKey' && s.in === 'header') {
      lines.push(`    injection: { injectAs: "header", targetKey: "${s.headerName || 'X-API-Key'}" }`);
    } else if (s.type === 'apiKey' && s.in === 'query') {
      lines.push(`    injection: { injectAs: "query_param", targetKey: "${s.headerName || 'api_key'}" }`);
    } else if (s.type === 'basic') {
      lines.push(`    injection: { injectAs: "header", targetKey: "Authorization", prefix: "Basic " }`);
    } else if (s.type === 'oauth2') {
      lines.push(`    injection: typically Bearer token after OAuth flow`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 1: ANALYST
// ─────────────────────────────────────────────────────────────────────────────

export function buildAnalystSystemPrompt(): string {
  return `You are an API domain analyst. Your job is to read an API specification and produce a structured analysis that helps a downstream system build a correct test execution plan.

You are an expert at:
- Reverse-engineering business domains from API structure (paths, field names, response shapes)
- Understanding entity relationships (one-to-many, parent-child, ownership)
- Detecting authentication flows (simple login, multi-step OAuth, API keys, signup-first)
- Identifying data dependencies between endpoints
- Recognizing patterns across any industry: e-commerce, healthcare, fintech, SaaS, IoT, social, DevOps, etc.

Your analysis will be consumed by another AI agent that builds the execution DAG.
Be precise, structured, and thorough. Don't assume — derive everything from the spec.

Output ONLY valid JSON matching the exact schema specified.`;
}

export function buildAnalystPrompt(spec: ParsedApiSpec): string {
  const endpointList = spec.endpoints.map(serializeEndpointCompact).join('\n\n');

  const tagGroups = new Map<string, string[]>();
  for (const ep of spec.endpoints) {
    const tag = ep.tags[0] || 'untagged';
    if (!tagGroups.has(tag)) tagGroups.set(tag, []);
    tagGroups.get(tag)!.push(`${ep.method} ${ep.path}`);
  }
  const tagSummary = Array.from(tagGroups.entries())
    .map(([tag, eps]) => `  ${tag}: ${eps.join(', ')}`)
    .join('\n');

  const authInfo = serializeAuthSchemes(spec.authSchemes);

  return `Analyze this API specification and produce a domain analysis.

═══ API ═══
Title: ${spec.title}${spec.description ? `\nDescription: "${spec.description.slice(0, 300)}"` : ''}
Base URL: ${spec.baseUrl}
Spec version: ${spec.specVersion}
Total endpoints: ${spec.endpoints.length}

═══ AUTHENTICATION SCHEMES ═══
${authInfo}

═══ RESOURCE GROUPS ═══
${tagSummary || '  (no tags)'}

═══ ALL ENDPOINTS ═══
${endpointList}

═══ ANALYSIS REQUIRED ═══

Produce this EXACT JSON structure:

{
  "domain": {
    "name": "short domain name (e.g., 'E-commerce platform', 'Healthcare records API', 'DevOps pipeline manager')",
    "description": "2-3 sentences describing what this API does as a product and who uses it"
  },

  "entities": [
    {
      "name": "entity name (e.g., 'User', 'Order', 'Patient')",
      "description": "what this entity represents in the business domain",
      "createEndpoint": "POST /path (operationId) — which endpoint creates this entity, or null if none",
      "readEndpoints": ["GET /path/{id}", "GET /path — list"],
      "updateEndpoints": ["PUT /path/{id}", "PATCH /path/{id}"],
      "deleteEndpoints": ["DELETE /path/{id}"],
      "idField": {
        "fieldName": "the field name in the create response that contains the new ID (e.g., 'id', 'userId', 'data.id')",
        "jsonPath": "exact JSONPath to extract the ID from the create response (e.g., '$.id', '$.data.user.id')"
      },
      "dependsOnEntities": ["other entity names that must exist before this one can be created"]
    }
  ],

  "authFlow": {
    "type": "none | simple_login | signup_then_login | api_key_static | oauth2_flow | multi_step | basic_auth",
    "description": "explain how auth works in this specific API",
    "steps": [
      "step 1: what must happen first (e.g., 'register user via POST /auth/register')",
      "step 2: next step (e.g., 'login via POST /auth/login')",
      "step 3: etc."
    ],
    "tokenExtraction": {
      "endpoint": "which endpoint produces the auth token (operationId or method path)",
      "responsePath": "exact JSONPath to the token in that endpoint's response (e.g., '$.access_token', '$.data.tokens.jwt')",
      "variableName": "what to name this variable (e.g., 'auth_token', 'api_key', 'jwt')"
    },
    "additionalTokens": [
      {
        "name": "variable name (e.g., 'refresh_token', 'session_id')",
        "endpoint": "which endpoint produces it",
        "responsePath": "JSONPath"
      }
    ]
  },

  "dataFlows": [
    {
      "producer": "endpoint that produces the value (operationId or method path)",
      "field": "response field name",
      "jsonPath": "exact JSONPath in the producer's response (e.g., '$.data.id')",
      "variableName": "descriptive variable name (e.g., 'user_id', 'order_id', 'workspace_id')",
      "consumers": [
        {
          "endpoint": "endpoint that needs this value (operationId or method path)",
          "injectionType": "path_param | body_field | query_param | header",
          "targetField": "exact field/param name where the value goes (e.g., 'userId' for path param {userId})"
        }
      ]
    }
  ],

  "publicEndpoints": ["list of endpoints with auth_required: NONE that need no authentication"],

  "executionPhases": [
    {
      "phase": 1,
      "name": "descriptive name (e.g., 'Setup', 'Authentication', 'Core CRUD', 'Cleanup')",
      "description": "why these endpoints run in this phase",
      "endpoints": ["operationId or method path"],
      "parallelizable": false
    }
  ],

  "edgeCases": [
    "any notable patterns: circular references, optional auth, multi-tenant, versioned endpoints, webhook callbacks, etc."
  ]
}

═══ IMPORTANT RULES ═══
- Analyze EVERY endpoint, don't skip any
- For jsonPath: trace the EXACT nesting from the response schema. If schema shows {data: {user: {id}}} → jsonPath is "$.data.user.id", NOT "$.id"
- For entities: only list endpoints that actually exist in the spec
- For authFlow: if there's no explicit auth endpoint but endpoints require auth, note that (e.g., "API key must be provided externally")
- For dataFlows: capture ALL data dependencies, not just auth tokens — entity IDs, parent references, foreign keys
- For executionPhases: group by business logic, NOT by HTTP method. "Create workspace" and "create user" may be in different phases even though both are POST
- If the API has no clear auth flow, set authFlow.type to "none" or "api_key_static"
- If you can't determine a jsonPath because the response schema is missing, write "UNKNOWN — schema not provided" and the downstream agent will handle it`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2: ARCHITECT
// ─────────────────────────────────────────────────────────────────────────────

export function buildArchitectSystemPrompt(): string {
  return `You are an API test architect. You receive:
1. A domain analysis from an analyst (entities, auth flow, data dependencies, execution phases)
2. Full endpoint specifications (methods, paths, schemas, parameters, responses)

Your job: build a precise execution DAG — a directed acyclic graph of API calls with exact variable extraction and injection mappings.

You are precise about:
- JSONPath expressions: always match the EXACT schema nesting, never guess
- Variable naming: use descriptive names (user_id, auth_token, order_id) not generic (id, token)
- Injection targets: use the EXACT header name, path param name, or body field name from the spec
- Dependencies: only add dependsOn when there's a real data dependency, not just "logical order"
- Public endpoints: NEVER inject auth variables into endpoints marked auth_required: NONE
- Parallel execution: endpoints with no shared data dependency CAN run in parallel

Output ONLY valid JSON matching the exact schema specified.`;
}

export function buildArchitectPrompt(
  spec: ParsedApiSpec,
  endpoints: ParsedEndpoint[],
  analysisJson: string,
): string {
  const endpointList = endpoints.map(serializeEndpoint).join('\n\n');
  const authSchemesStr = serializeAuthSchemes(spec.authSchemes);

  return `Build an execution DAG for this API using the domain analysis below.

═══ DOMAIN ANALYSIS (from analyst agent) ═══
${analysisJson}

═══ API ═══
Title: ${spec.title}
Base URL: ${spec.baseUrl}

═══ AUTH SCHEMES ═══
${authSchemesStr}

═══ FULL ENDPOINT SPECIFICATIONS ═══
${endpointList}

═══ YOUR OUTPUT ═══

Using the domain analysis as your guide, produce this EXACT JSON:

{
  "nodes": [
    {
      "id": "use operationId from the spec. If missing, use method_path_sanitized (e.g., 'get_users_id')",
      "method": "GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS",
      "path": "/exact/path/from/spec",
      "operationId": "from spec",
      "summary": "what this step does in the test flow (e.g., 'Create a new pet to test CRUD operations')",
      "tags": ["from spec"],
      "dependsOn": ["IDs of nodes that MUST complete before this one — based on data dependencies from the analysis, NOT arbitrary ordering"],
      "variableExtractions": [
        {
          "variableName": "descriptive_name matching the analysis (e.g., 'pet_id', 'auth_token')",
          "jsonPath": "EXACT path from response schema (e.g., '$.data.id'). MUST match the schema structure. If schema is unknown, use the best guess from field names",
          "headerSource": "response header name if extracting from header (e.g., 'Set-Cookie', 'X-Request-Id'), or null",
          "regex": "regex with capture group if extracting from text response, or null"
        }
      ],
      "variableInjections": [
        {
          "variableName": "must match a variableExtractions.variableName from a PRIOR node",
          "injectAs": "header | path_param | query_param | body_field",
          "targetKey": "EXACT target: header name (e.g., 'Authorization'), path param name (e.g., 'userId'), body field (e.g., 'organizationId')",
          "prefix": "only for auth headers: 'Bearer ' or 'Basic '. null/omit for everything else"
        }
      ],
      "priority": 0,
      "isAuthEndpoint": true,
      "isPagination": false,
      "hasFileUpload": false,
      "isUnsupported": false,
      "unsupportedReason": null,
      "canRunParallel": false,
      "sampleRequestBody": null,
      "sampleQueryParams": null,
      "expectedStatusCodes": [200, 201]
    }
  ],
  "executionOrder": ["node IDs in valid topological sort order"],
  "parallelGroups": [["level0_ids"], ["level1_ids"], ["level2_ids"]],
  "summary": "2-3 sentences: what domain, what test flow covers, how many phases",
  "totalEndpoints": ${endpoints.length},
  "unsupportedEndpoints": []
}

═══ CRITICAL RULES ═══

1. EVERY node ID in dependsOn MUST exist in the nodes array. Don't reference non-existent nodes.
2. EVERY variableName in variableInjections MUST be extracted by a node that appears EARLIER in executionOrder.
3. executionOrder MUST be a valid topological sort: no node appears before any of its dependencies.
4. Set sampleRequestBody to null for now — Agent 3 will fill it in. But DO set sampleQueryParams if the endpoint has query parameters.
5. isAuthEndpoint = true ONLY for endpoints whose PURPOSE is producing auth credentials (login, token exchange). NOT for endpoints that merely require auth.
6. Public endpoints (auth_required: NONE from spec) → NO auth variableInjections.
7. canRunParallel = true for nodes at the same dependency level with no shared state.
8. expectedStatusCodes: use the success codes from the response schemas (200, 201, 204, etc.)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 3: ENRICHER
// ─────────────────────────────────────────────────────────────────────────────

export function buildEnricherSystemPrompt(): string {
  return `You are a test data generator. You create realistic, domain-appropriate test data for API endpoints.

Your expertise:
- You understand business domains and generate contextually correct values
- E-commerce: product names, prices, SKUs, addresses
- Healthcare: patient names, medical record numbers, appointment times
- Social: usernames, post content, comment text
- Fintech: transaction amounts, account numbers, currency codes
- SaaS: workspace names, project titles, role names
- IoT: device IDs, sensor readings, firmware versions

Rules:
- Read the request schema carefully — match field names, types, formats, enums
- For fields that receive injected variables from prior steps, use {{variable_name}} placeholder
- For email fields: use "testuser@example.com" or "qa+test@example.com"
- For password fields: use "TestPass123!"
- For enum fields: pick the first valid enum value
- For date fields: use ISO 8601 format relative to "today" (e.g., "2026-04-05")
- For arrays: provide 1-2 items
- For nested objects: fill all required fields
- NEVER leave required fields empty

Output ONLY valid JSON.`;
}

export function buildEnricherPrompt(
  nodes: DAGNode[],
  spec: ParsedApiSpec,
  analysisJson: string,
): string {
  const endpointMap = new Map(spec.endpoints.map(e => [`${e.method}:${e.path}`, e]));

  const needsData = nodes.filter(n =>
    ['POST', 'PUT', 'PATCH'].includes(n.method) && !n.sampleRequestBody
  );

  if (needsData.length === 0) return ''; // No data needed

  const nodeDescriptions = needsData.map(n => {
    const ep = endpointMap.get(`${n.method}:${n.path}`);
    const schema = ep?.requestBody?.schema
      ? JSON.stringify(ep.requestBody.schema, null, 1).slice(0, 600)
      : '(no schema — infer from endpoint path and summary)';
    const injectedVars = n.variableInjections
      .filter(i => i.injectAs === 'body_field')
      .map(i => `{{${i.variableName}}} → field "${i.targetKey}"`).join(', ');

    return [
      `── ${n.id} (${n.method} ${n.path}) ──`,
      n.summary ? `  purpose: "${n.summary}"` : '',
      `  content_type: ${ep?.requestBody?.contentType || 'application/json'}`,
      `  schema: ${schema}`,
      injectedVars ? `  injected_variables (use {{name}} placeholder): ${injectedVars}` : '',
      ep?.requestBody?.required ? '  body_required: true' : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  // Extract domain info for context
  let domainHint = '';
  try {
    const analysis = JSON.parse(analysisJson);
    domainHint = `Domain: ${analysis.domain?.name || 'unknown'}\nDescription: ${analysis.domain?.description || ''}`;
  } catch {
    domainHint = 'Domain: infer from endpoint names';
  }

  return `Generate realistic test data for the following API endpoints.

═══ DOMAIN CONTEXT ═══
${domainHint}

═══ ENDPOINTS NEEDING REQUEST BODIES ═══

${nodeDescriptions}

═══ OUTPUT FORMAT ═══

Return EXACTLY this JSON:

{
  "samples": {
    "node_id_1": {
      "field1": "realistic value matching the schema type",
      "field2": 42,
      "injectedField": "{{variable_name}}",
      "nestedObject": {
        "subField": "value"
      }
    },
    "node_id_2": { ... }
  }
}

═══ RULES ═══
- Include a key in "samples" for EVERY endpoint listed above
- Match the schema structure exactly (field names, nesting, types)
- For injected variables: use the exact {{variable_name}} from the injected_variables line
- For required fields without schema: infer reasonable field names from the endpoint path and summary
- For enum fields: pick the first valid option
- Keep arrays short (1-2 items)
- Use realistic values for the domain, not generic "test" or "string123"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE PROMPT (for batching large specs — 30+ endpoints)
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwaggerDagMergePrompt(
  partialDags: Array<{ nodes: any[]; executionOrder: string[] }>,
  spec: ParsedApiSpec,
): string {
  const allNodes = partialDags.flatMap(d => d.nodes);

  const nodesSummary = allNodes.map(n => {
    const deps = n.dependsOn?.length ? `depends:[${n.dependsOn.join(',')}]` : 'no deps';
    const extracts = (n.variableExtractions || []).map((e: any) => e.variableName).join(',');
    const injects = (n.variableInjections || []).map((i: any) => i.variableName).join(',');
    return `  ${n.id}: ${n.method} ${n.path} | ${deps} | extracts:[${extracts}] | needs:[${injects}]${n.isAuthEndpoint ? ' | AUTH' : ''}`;
  }).join('\n');

  // Variable flow analysis
  const allExtractions = new Map<string, string>();
  const allInjections = new Map<string, string[]>();
  for (const n of allNodes) {
    for (const e of (n.variableExtractions || [])) allExtractions.set(e.variableName, n.id);
    for (const i of (n.variableInjections || [])) {
      if (!allInjections.has(i.variableName)) allInjections.set(i.variableName, []);
      allInjections.get(i.variableName)!.push(n.id);
    }
  }

  // Find broken references
  const brokenVars: string[] = [];
  for (const [varName, consumers] of allInjections) {
    if (!allExtractions.has(varName)) {
      brokenVars.push(`{{${varName}}} needed by [${consumers.join(', ')}] but no producer found`);
    }
  }

  const variableFlow = Array.from(allExtractions.entries()).map(([varName, producer]) => {
    const consumers = allInjections.get(varName) || [];
    return `  {{${varName}}}: ${producer} → [${consumers.join(', ')}]`;
  }).join('\n');

  return `Merge ${partialDags.length} partial DAGs (${allNodes.length} total nodes) from API "${spec.title}".

═══ ALL NODES ═══
${nodesSummary}

═══ VARIABLE FLOW ═══
${variableFlow || '  (none)'}

${brokenVars.length > 0 ? `═══ BROKEN REFERENCES (fix these!) ═══\n${brokenVars.map(b => `  ⚠ ${b}`).join('\n')}\n` : ''}
═══ TASK ═══
1. Add missing cross-batch dependencies (if node Y needs {{user_id}} and node X in another batch extracts it, add X to Y's dependsOn)
2. Fix any broken variable references listed above
3. Produce ONE merged DAG with a valid topological executionOrder
4. Group independent nodes into parallelGroups

Return the merged DAG in the standard JSON format. Return ONLY valid JSON.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOW SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

export function buildSwaggerFlowSummaryPrompt(dag: ExecutionDAG, title: string): string {
  const authNodes = dag.nodes.filter(n => n.isAuthEndpoint).map(n => `${n.method} ${n.path}`).join(', ');
  const criticalPath = dag.executionOrder.slice(0, 5).join(' → ');

  return `Write a 2-3 sentence summary of this API test flow for a QA engineer.

API: ${title}
Total endpoints: ${dag.totalEndpoints}
Auth endpoints: ${authNodes || 'none'}
Critical path: ${criticalPath}
Parallel groups: ${dag.parallelGroups.length}

Include: business domain, auth method, main test coverage, any notable patterns.
Return ONLY the summary text, no JSON.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKWARD COMPAT EXPORTS (used by dependency-resolver.service.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const buildSwaggerDependencySystemPrompt = buildArchitectSystemPrompt;
export const buildSwaggerDependencyPrompt = (spec: ParsedApiSpec, chunkEndpoints?: ParsedEndpoint[]) =>
  buildArchitectPrompt(spec, chunkEndpoints || spec.endpoints, '(no prior analysis available — analyze endpoints directly)');
