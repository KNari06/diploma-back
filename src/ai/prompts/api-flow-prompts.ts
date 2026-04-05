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

/** Safe JSON.stringify that handles circular references */
function safeStringify(obj: any, maxLen = 500): string {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(obj, (_, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }, 1);
    return (json || '{}').slice(0, maxLen);
  } catch {
    return '{}';
  }
}

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
    if (p.example !== undefined) parts.push(`example=${safeStringify(p.example, 60)}`);
    if (p.description) parts.push(`"${p.description.slice(0, 80)}"`);
    return parts.join(' ');
  }).join('\n    ');

  const reqBody = ep.requestBody
    ? `  RequestBody[${ep.requestBody.contentType}${ep.requestBody.required ? ', required' : ''}]:\n    ${safeStringify(ep.requestBody.schema || ep.requestBody.example || {})}`
    : '';

  const responseLines: string[] = [];
  for (const [code, resp] of Object.entries(ep.responses)) {
    const schema = resp.schema ? safeStringify(resp.schema, 400) : '';
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
  const isLargeSpec = spec.endpoints.length > 80;

  // For large specs: show tag summary + sample endpoints per tag (max ~100 total)
  // For small specs: show all endpoints
  let endpointList: string;
  if (isLargeSpec) {
    // Group by tag, show up to 5 endpoints per tag for context
    const byTag = new Map<string, ParsedEndpoint[]>();
    for (const ep of spec.endpoints) {
      const tag = ep.tags[0] || 'untagged';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(ep);
    }

    const sampled: string[] = [];
    let idx = 0;
    for (const [tag, eps] of byTag) {
      sampled.push(`\n── ${tag} (${eps.length} endpoints) ──`);
      // Show up to 5 per tag: prioritize POST, then GET with path params, then others
      const sorted = [...eps].sort((a, b) => {
        const methodPriority: Record<string, number> = { POST: 0, PUT: 1, PATCH: 2, DELETE: 3, GET: 4, HEAD: 5, OPTIONS: 6 };
        return (methodPriority[a.method] ?? 9) - (methodPriority[b.method] ?? 9);
      });
      for (const ep of sorted.slice(0, 5)) {
        sampled.push(serializeEndpointCompact(ep, idx++));
      }
      if (eps.length > 5) {
        sampled.push(`  ... and ${eps.length - 5} more ${tag} endpoints`);
      }
    }
    endpointList = sampled.join('\n');
  } else {
    endpointList = spec.endpoints.map(serializeEndpointCompact).join('\n\n');
  }

  const tagGroups = new Map<string, string[]>();
  for (const ep of spec.endpoints) {
    const tag = ep.tags[0] || 'untagged';
    if (!tagGroups.has(tag)) tagGroups.set(tag, []);
    tagGroups.get(tag)!.push(`${ep.method} ${ep.path}`);
  }
  const tagSummary = Array.from(tagGroups.entries())
    .map(([tag, eps]) => `  ${tag} (${eps.length}): ${eps.slice(0, 10).join(', ')}${eps.length > 10 ? `, ... +${eps.length - 10} more` : ''}`)
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
  ],

  "questions": [
    {
      "id": "unique_question_id (e.g., 'auth_token', 'api_key', 'base_url', 'test_password')",
      "question": "clear human-readable question for the user",
      "context": "why you need this information — what you couldn't determine from the spec",
      "type": "text | select | confirm | secret",
      "options": ["option1", "option2"],
      "defaultValue": "suggested default if you have a guess",
      "variableName": "if this answer should be injected as a variable at runtime, set the variable name here (e.g., 'auth_token', 'api_key'). The executor will inject this into the variable context so {{variableName}} works in headers/body/path."
    }
  ],

  "confidence": {
    "overall": 0.85,
    "auth": 0.9,
    "dependencies": 0.8,
    "dataFlow": 0.7
  }
}

═══ AUTONOMOUS vs ASK-USER DECISION TREE ═══

CRITICAL: Before asking the user a question, check if the system can handle it autonomously.

The execution engine CAN do these things automatically:
  ✅ Call a login/token endpoint to get a Bearer token (if the spec has one)
  ✅ Call a registration endpoint to create a test user (if the spec has one)
  ✅ Call a create endpoint to generate entity IDs needed by other endpoints
  ✅ Call an OAuth token endpoint with client credentials (if user provides client_id/secret)
  ✅ Chain multiple auth steps: register → verify → login → get token
  ✅ Refresh tokens when they expire (401 auto-refresh)
  ✅ Generate realistic fake test data (emails, names, passwords)

The execution engine CANNOT do these things — user must provide:
  ❌ Static API keys that aren't generated by any endpoint in the spec
  ❌ OAuth client_id / client_secret (these are provisioned outside the API)
  ❌ External service credentials (third-party tokens, webhook URLs)
  ❌ Existing entity IDs when no create endpoint exists
  ❌ Tenant/org IDs for multi-tenant APIs without a tenant creation endpoint

═══ DECISION LOGIC ═══

For AUTHENTICATION:
  IF spec has a login/signin/token endpoint with clear request schema (email+password, username+password):
    → DO NOT ask for a token. Mark this endpoint as isAuthEndpoint: true.
    → The Enricher agent will generate test credentials for the login body.
    → The executor will call login first, extract the token, and inject it everywhere.
    → ONLY ask for credentials if the login endpoint requires REAL accounts that can't be auto-created
      (e.g., no registration endpoint AND login body hints at existing accounts).

  IF spec has a registration/signup endpoint:
    → Include it BEFORE login in the execution order.
    → Generate test data for registration. Extract user_id from response.
    → Then login with the registered credentials. Extract auth_token.
    → Fully autonomous — no questions needed.

  IF spec has NO login/token endpoint but endpoints require bearerAuth:
    → ASK: id: "auth_token", type: "secret", variableName: "auth_token"
    → question: "No login endpoint found. Enter a Bearer token to use for authenticated requests."

  IF spec uses apiKey auth with no key generation endpoint:
    → ASK: id: "api_key", type: "secret", variableName: "api_key"
    → question: "Enter your API key (header: [exact headerName from scheme])"

  IF spec has OAuth2 flow:
    → ASK for client_id and client_secret (these are always external)
    → id: "oauth_client_id", type: "text", variableName: "oauth_client_id"
    → id: "oauth_client_secret", type: "secret", variableName: "oauth_client_secret"
    → Mark the token endpoint as isAuthEndpoint. Architect will use client credentials in the request body.

For DATA:
  IF an endpoint needs an entity ID and the spec has a create endpoint for that entity:
    → DO NOT ask. Include the create endpoint in dependsOn. Extract the ID automatically.

  IF an endpoint needs an entity ID but NO create endpoint exists:
    → ASK: id: "existing_[entity]_id", type: "text", variableName: "[entity]_id"
    → question: "Enter an existing [entity] ID (no create endpoint found for this resource)"

For ENVIRONMENT:
  IF multiple server URLs are defined:
    → ASK: id: "base_url", type: "select", options: [URLs], variableName: "base_url"

  IF base URL has template variables (e.g., {region}.api.example.com):
    → ASK: id: "server_variable_[name]", type: "text", variableName: "server_[name]"

═══ QUESTION FORMAT ═══

{
  "id": "unique_id",
  "question": "clear question for the user",
  "context": "why you need this — what you tried to handle autonomously and couldn't",
  "type": "text | select | confirm | secret",
  "options": ["for select type only"],
  "defaultValue": "suggested default",
  "variableName": "if this value should be injectable as {{variableName}} at runtime"
}

RULES:
- type: "secret" for tokens, keys, passwords, secrets — frontend will mask input
- variableName: ONLY set when the answer is a runtime value used in API requests
  NOT for informational answers ("what does this endpoint do?")
- Maximum 5 questions. Prioritize: auth > entity IDs > environment > informational
- If the spec is clear and everything can be handled autonomously → questions: []

═══ CONFIDENCE SCORING ═══
Rate 0.0-1.0:
- overall: complete analysis confidence
- auth: authentication flow understanding
- dependencies: entity relationship confidence
- dataFlow: jsonPath and variable mapping confidence
If any < 0.5, add a relevant question.

═══ IMPORTANT RULES ═══
- Analyze EVERY endpoint
- For jsonPath: trace EXACT nesting from response schema
- For entities: only list endpoints that exist in the spec
- For authFlow: if you can build it autonomously (login endpoint exists), DO IT — don't ask
- For dataFlows: capture ALL dependencies, not just auth
- For executionPhases: group by business logic, NOT by HTTP method
- If jsonPath is unknown due to missing schema, write "UNKNOWN — schema not provided" and add a question`;
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
      ? safeStringify(ep.requestBody.schema, 600)
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
