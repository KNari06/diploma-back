/**
 * Enricher prompt — user-provided variables wiring.
 *
 * Regression guard for the "platform asks for values but uses random data" bug:
 * when the analysis carries `_providedVariables` (metadata for values the user
 * supplied while answering clarification questions), the Enricher must be told
 * to reuse them as {{placeholder}} in request bodies instead of fabricating
 * credentials — and it must NEVER receive the secret values themselves.
 */

import { buildEnricherPrompt } from '../api-flow-prompts';
import type { DAGNode, ParsedApiSpec } from '@/services/testing/api/flow/flow.types';

function loginNode(): DAGNode {
  return {
    id: 'post_login',
    method: 'POST',
    path: '/login',
    operationId: 'post_login',
    summary: 'Authenticate an existing account',
    tags: [],
    dependsOn: [],
    variableExtractions: [],
    variableInjections: [],
    priority: 0,
    isAuthEndpoint: true,
    isPagination: false,
    hasFileUpload: false,
    isUnsupported: false,
    canRunParallel: false,
    expectedStatusCodes: [200],
    sampleRequestBody: undefined,
  } as unknown as DAGNode;
}

function spec(): ParsedApiSpec {
  return {
    title: 'Demo API',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://api.demo.test',
    authSchemes: [],
    unsupportedEndpoints: [],
    sourceType: 'openapi' as any,
    endpoints: [
      {
        operationId: 'post_login',
        method: 'POST',
        path: '/login',
        summary: 'Authenticate an existing account',
        tags: [],
        parameters: [],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } } },
        } as any,
        responses: {},
        security: [],
      },
    ],
  } as ParsedApiSpec;
}

describe('buildEnricherPrompt — user-provided variables', () => {
  it('instructs the enricher to reuse provided variables as placeholders', () => {
    const analysisJson = JSON.stringify({
      domain: { name: 'Auth', description: 'login demo' },
      _providedVariables: [
        { name: 'admin_email', type: 'text', context: 'The admin login needs a real account' },
        { name: 'admin_password', type: 'secret', context: 'Password for the admin login' },
      ],
    });

    const prompt = buildEnricherPrompt([loginNode()], spec(), analysisJson);

    expect(prompt).toContain('USER-PROVIDED VARIABLES (available as');
    expect(prompt).toContain('{{admin_email}}');
    expect(prompt).toContain('{{admin_password}}');
    // The guidance must steer body fields to the placeholder, not fake data.
    expect(prompt).toMatch(/placeholder as the field VALUE instead of inventing/i);
  });

  it('never leaks the secret answer values into the prompt', () => {
    const analysisJson = JSON.stringify({
      domain: { name: 'Auth', description: 'login demo' },
      _providedVariables: [{ name: 'admin_password', type: 'secret', context: 'Password for the admin login' }],
      _userAnswers: { admin_password: 'SuperSecret123!' },
    });

    const prompt = buildEnricherPrompt([loginNode()], spec(), analysisJson);

    expect(prompt).toContain('{{admin_password}}');
    expect(prompt).not.toContain('SuperSecret123!');
  });

  it('omits the provided-variables section when none were supplied', () => {
    const analysisJson = JSON.stringify({ domain: { name: 'Auth', description: 'login demo' } });

    const prompt = buildEnricherPrompt([loginNode()], spec(), analysisJson);

    expect(prompt).not.toContain('USER-PROVIDED VARIABLES (available as');
  });
});
