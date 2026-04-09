/**
 * JSON REPAIR MEASUREMENT — probes dependency-resolver.service.ts:332-391
 * ──────────────────────────────────────────────────────────────────────
 *
 * The resolver has a "JSON repair" path that kicks in when Gemini returns
 * truncated JSON (a real failure mode when output exceeds max_tokens or
 * thinking-mode output gets cut). The repair path scans for balanced {}
 * pairs and salvages whole nodes.
 *
 * This test probes 4 failure modes:
 *
 *   1. CLEAN TRUNCATION: valid JSON stops cleanly at end of N-th node.
 *      Expected: all N nodes recovered.
 *
 *   2. MID-NODE TRUNCATION: last node is half-written.
 *      Expected: first N-1 nodes recovered, last one lost.
 *
 *   3. BRACE IN STRING LITERAL: a node has "summary": "Create a { pet }"
 *      — the depth-balance scanner will misinterpret the inner { and }
 *      as structural braces.
 *      Expected (before fix): nodes corrupted or lost
 *      Expected (after fix):  all nodes recovered
 *
 *   4. TRUNCATION INSIDE dependsOn ARRAY: the spec cuts off in the middle
 *      of a dependsOn array value. Previous complete nodes should still
 *      be recovered, and the half-written one is lost.
 *
 * No production code is modified by this test. It directly exercises
 * runArchitect (private) indirectly via DependencyResolverService.resolve
 * by mocking the AI to return the truncated strings.
 */

jest.mock('@/services/ai/core/openai.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { DependencyResolverService } from '../dependency-resolver.service';
import type { ParsedApiSpec } from '../flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// Shared minimal spec — 5 endpoints, enough to generate meaningful DAG
// ─────────────────────────────────────────────────────────────────────────────

const minimalSpec: ParsedApiSpec = {
  title: 'Repair test',
  version: '1.0',
  specVersion: '3.0.0',
  baseUrl: 'https://example.com',
  authSchemes: [],
  sourceType: 'openapi_url',
  unsupportedEndpoints: [],
  endpoints: [
    {
      operationId: 'createUser',
      method: 'POST',
      path: '/users',
      summary: 'Create user',
      tags: ['user'],
      parameters: [],
      requestBody: {
        contentType: 'application/json',
        required: true,
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      },
      responses: { '200': { description: 'ok' } },
      security: [],
    },
    {
      operationId: 'getUser',
      method: 'GET',
      path: '/users/{userId}',
      summary: 'Read user',
      tags: ['user'],
      parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { '200': { description: 'ok' } },
      security: [],
    },
    {
      operationId: 'deleteUser',
      method: 'DELETE',
      path: '/users/{userId}',
      summary: 'Delete user',
      tags: ['user'],
      parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { '204': { description: 'no content' } },
      security: [],
    },
    {
      operationId: 'createPost',
      method: 'POST',
      path: '/posts',
      summary: 'Create post',
      tags: ['post'],
      parameters: [],
      requestBody: {
        contentType: 'application/json',
        required: true,
        schema: { type: 'object', properties: { userId: { type: 'integer' }, title: { type: 'string' } } },
      },
      responses: { '200': { description: 'ok' } },
      security: [],
    },
    {
      operationId: 'getPost',
      method: 'GET',
      path: '/posts/{postId}',
      summary: 'Read post',
      tags: ['post'],
      parameters: [{ name: 'postId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { '200': { description: 'ok' } },
      security: [],
    },
  ],
};

// Good analyst output — reused across scenarios
const analystGood = JSON.stringify({
  domain: { name: 'Test', description: '' },
  entities: [],
  authFlow: { type: 'none', steps: [] },
  dataFlows: [],
  publicEndpoints: [],
  executionPhases: [],
  edgeCases: [],
  questions: [],
  confidence: { overall: 0.9, auth: 1, dependencies: 0.9, dataFlow: 0.9 },
});

// Helper: build an architect output with N nodes (1..5)
function buildFullArchitectJson(nodeCount: number): string {
  const nodes = [];
  if (nodeCount >= 1) {
    nodes.push({
      id: 'createUser',
      method: 'POST',
      path: '/users',
      operationId: 'createUser',
      summary: 'Create user',
      tags: ['user'],
      dependsOn: [],
      variableExtractions: [{ variableName: 'user_id', jsonPath: '$.id' }],
      variableInjections: [],
      priority: 0,
      isAuthEndpoint: false,
      isPagination: false,
      hasFileUpload: false,
      isUnsupported: false,
      canRunParallel: false,
      sampleRequestBody: null,
      expectedStatusCodes: [200],
    });
  }
  if (nodeCount >= 2) {
    nodes.push({
      id: 'getUser',
      method: 'GET',
      path: '/users/{userId}',
      operationId: 'getUser',
      summary: 'Read user',
      tags: ['user'],
      dependsOn: ['createUser'],
      variableExtractions: [],
      variableInjections: [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'userId' }],
      priority: 1,
      isAuthEndpoint: false,
      isPagination: false,
      hasFileUpload: false,
      isUnsupported: false,
      canRunParallel: false,
      sampleRequestBody: null,
      expectedStatusCodes: [200],
    });
  }
  if (nodeCount >= 3) {
    nodes.push({
      id: 'deleteUser',
      method: 'DELETE',
      path: '/users/{userId}',
      operationId: 'deleteUser',
      summary: 'Delete user',
      tags: ['user'],
      dependsOn: ['createUser', 'getUser'],
      variableExtractions: [],
      variableInjections: [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'userId' }],
      priority: 2,
      isAuthEndpoint: false,
      isPagination: false,
      hasFileUpload: false,
      isUnsupported: false,
      canRunParallel: false,
      sampleRequestBody: null,
      expectedStatusCodes: [204],
    });
  }
  if (nodeCount >= 4) {
    nodes.push({
      id: 'createPost',
      method: 'POST',
      path: '/posts',
      operationId: 'createPost',
      summary: 'Create post',
      tags: ['post'],
      dependsOn: ['createUser'],
      variableExtractions: [{ variableName: 'post_id', jsonPath: '$.id' }],
      variableInjections: [{ variableName: 'user_id', injectAs: 'body_field', targetKey: 'userId' }],
      priority: 1,
      isAuthEndpoint: false,
      isPagination: false,
      hasFileUpload: false,
      isUnsupported: false,
      canRunParallel: false,
      sampleRequestBody: null,
      expectedStatusCodes: [200],
    });
  }
  if (nodeCount >= 5) {
    nodes.push({
      id: 'getPost',
      method: 'GET',
      path: '/posts/{postId}',
      operationId: 'getPost',
      summary: 'Read post',
      tags: ['post'],
      dependsOn: ['createPost'],
      variableExtractions: [],
      variableInjections: [{ variableName: 'post_id', injectAs: 'path_param', targetKey: 'postId' }],
      priority: 2,
      isAuthEndpoint: false,
      isPagination: false,
      hasFileUpload: false,
      isUnsupported: false,
      canRunParallel: false,
      sampleRequestBody: null,
      expectedStatusCodes: [200],
    });
  }
  return JSON.stringify({ nodes, executionOrder: nodes.map(n => n.id), summary: 'test', totalEndpoints: nodes.length, unsupportedEndpoints: [] });
}

/**
 * Build an AI mock that returns:
 *   - 1st call (Analyst) → analystGood
 *   - 2nd call (Architect) → the given architectResponse
 *   - remaining → empty enricher output
 */
function mockAi(architectResponse: string) {
  let callIdx = 0;
  return jest.fn().mockImplementation(async () => {
    const i = callIdx++;
    if (i === 0) return { content: analystGood, usage: {} };
    if (i === 1) return { content: architectResponse, usage: {} };
    return { content: JSON.stringify({ samples: {} }), usage: {} };
  });
}

async function runAndGetResult(architectResponse: string): Promise<{
  recovered: number;
  finalOrder: string[];
  error?: string;
}> {
  const mock = mockAi(architectResponse);
  (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mock);

  (logger.info as unknown as jest.Mock).mockClear();
  (logger.warn as unknown as jest.Mock).mockClear();

  try {
    const result = await DependencyResolverService.resolve(minimalSpec);
    if (!result.dag) return { recovered: 0, finalOrder: [], error: 'no DAG' };
    return {
      recovered: result.dag.nodes.length,
      finalOrder: result.dag.executionOrder,
    };
  } catch (err: any) {
    return { recovered: 0, finalOrder: [], error: err.message };
  }
}

function report(scenarioName: string, r: { recovered: number; finalOrder: string[]; error?: string }) {
  // eslint-disable-next-line no-console
  console.log(`\n═══ ${scenarioName} ═══`);
  if (r.error) {
    // eslint-disable-next-line no-console
    console.log(`  ERROR: ${r.error}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`  Nodes recovered:  ${r.recovered}`);
  // eslint-disable-next-line no-console
  console.log(`  Final order:      ${r.finalOrder.join(' → ')}`);
}

describe('JSON repair path measurement', () => {
  test('scenario 1: clean truncation after 3rd node (no closing ] nor })', async () => {
    // Build 5-node JSON, then slice at the position just after the 3rd `}`
    // in the nodes array. We simulate: response was cut mid-transmission.
    const full = buildFullArchitectJson(5);
    // Find the 3rd node-closing brace inside the nodes array.
    // Simple heuristic: find "nodes":[, then count top-level {...} pairs until 3.
    const nodesStart = full.indexOf('"nodes":[');
    const arrStart = full.indexOf('[', nodesStart) + 1;
    let depth = 0;
    let closed = 0;
    let cutPos = -1;
    for (let i = arrStart; i < full.length; i++) {
      const ch = full[i];
      if (ch === '{' && depth === 0) depth = 1;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          closed++;
          if (closed === 3) {
            cutPos = i + 1;
            break;
          }
        }
      }
    }
    const truncated = full.slice(0, cutPos); // no closing ] or } for the outer object
    const r = await runAndGetResult(truncated);
    report('SCENARIO 1: clean truncation after 3 of 5 nodes', r);
    expect(r.recovered).toBeGreaterThanOrEqual(3);
  }, 30_000);

  test('scenario 2: mid-node truncation (4 full + 1 half)', async () => {
    const full = buildFullArchitectJson(5);
    // Cut in the middle of the 5th node — find its start, add ~30 chars
    const nodesStart = full.indexOf('"nodes":[');
    const arrStart = full.indexOf('[', nodesStart) + 1;
    let depth = 0;
    let closed = 0;
    let fifthStart = -1;
    for (let i = arrStart; i < full.length; i++) {
      const ch = full[i];
      if (ch === '{' && depth === 0) {
        if (closed === 4) { fifthStart = i; break; }
        depth = 1;
      } else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) closed++;
      }
    }
    const truncated = full.slice(0, fifthStart + 30); // truncate inside 5th node
    const r = await runAndGetResult(truncated);
    report('SCENARIO 2: mid-node truncation (4 full + 5th half)', r);
    // Expect: 4 nodes recovered. But phantom removal might cull them since
    // the AI output may still not be the spec's exact ops. The minimal-spec
    // mock uses matching IDs so all 4 should survive phantom check.
    expect(r.recovered).toBeGreaterThanOrEqual(4);
  }, 30_000);

  test('scenario 3: brace literal inside string (probes Bug A)', async () => {
    // Take the ideal 5-node output and inject a literal "{" and "}" inside
    // one of the summary strings. This simulates an AI output where the
    // summary describes a JSON-shaped example.
    const fullObj = JSON.parse(buildFullArchitectJson(5));
    fullObj.nodes[1].summary = 'Read user with body like { id: 1 }';
    fullObj.nodes[3].summary = 'Create post with payload { userId, title }';
    const poisoned = JSON.stringify(fullObj);

    const r = await runAndGetResult(poisoned);
    report('SCENARIO 3: brace literals inside string values', r);
    // First try without repair (valid JSON — extractJson should parse it fine)
    // Actually extractJson WILL parse it because it's valid JSON overall!
    // The repair path only triggers on FAILED parse.
    // So this scenario DOESN'T exercise the buggy repair path.
    // All 5 nodes should still be recovered because extractJson succeeds.
    expect(r.recovered).toBe(5);
  }, 30_000);

  test('scenario 4a: balanced brace literals + truncation → repair path', async () => {
    // BALANCED inner braces: { ... } fully closed within a single string.
    // The depth scanner goes up and comes back down, so the outer {} count
    // stays correct. This is actually safe.
    const fullObj = JSON.parse(buildFullArchitectJson(5));
    fullObj.nodes[1].summary = 'Read user with body like { id: 1 }';
    fullObj.nodes[2].summary = 'Delete with payload { force: true }';

    const poisoned = JSON.stringify(fullObj);
    const truncated = poisoned.slice(0, poisoned.length - 1);

    const r = await runAndGetResult(truncated);
    report('SCENARIO 4a: BALANCED brace literals + truncation', r);
  }, 30_000);

  test('scenario 4b: UNBALANCED brace in string (probes Bug A)', async () => {
    // UNBALANCED: a string contains an opening { with no matching }. The
    // depth-balance scanner sees an "extra" depth level that never returns.
    // Result: subsequent nodes are swallowed into what the scanner thinks
    // is still the current node, or the scan never closes at all.
    //
    // This is a REAL failure mode: if the AI generates a summary like
    // "The API uses curly-brace placeholders like {userId" (truncated
    // sentence), the repair path breaks.
    const fullObj = JSON.parse(buildFullArchitectJson(5));
    // Unbalanced: literal "{" with no "}" in the same string
    fullObj.nodes[1].summary = 'Unbalanced example: opening { without close';
    fullObj.nodes[3].summary = 'Another one: }} extras closing';

    const poisoned = JSON.stringify(fullObj);
    // Truncate just before the outer closing brace so the repair path runs
    const truncated = poisoned.slice(0, poisoned.length - 1);

    const r = await runAndGetResult(truncated);
    report('SCENARIO 4b: UNBALANCED braces in strings + truncation', r);
    // Before Bug A fix: some nodes mis-parsed or lost
    // After Bug A fix:  all 5 nodes recovered
    // No strict assertion — we observe.
  }, 30_000);

  test('scenario 5: dependsOn array cut mid-string', async () => {
    // Build 5 nodes and cut inside the 5th node's dependsOn array value.
    const full = buildFullArchitectJson(5);
    // Find "dependsOn":["createPost" (5th node's dependsOn value)
    // and cut just after the opening [ (no closing bracket)
    const lastDependsOn = full.lastIndexOf('"dependsOn":');
    const openBracket = full.indexOf('[', lastDependsOn);
    const cutPos = openBracket + 3; // keep "[ "c" and cut mid-string
    const truncated = full.slice(0, cutPos);
    const r = await runAndGetResult(truncated);
    report('SCENARIO 5: dependsOn value truncated inside string', r);
    // Expect: previous 4 nodes fully recovered, 5th lost
    expect(r.recovered).toBeGreaterThanOrEqual(4);
  }, 30_000);
});
