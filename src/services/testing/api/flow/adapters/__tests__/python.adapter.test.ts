/**
 * Python adapter — converts a Python API script (via LLM) into ParsedApiSpec.
 *
 * Mocks at the AI boundary (openai.service) so the real callAiWithRetry +
 * extractJson + normalization run, exactly as the dependency-resolver tests do.
 */

jest.mock('@/services/ai/core/openai.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { parsePythonScript } from '../python.adapter';

const mockAi = getChatCompletionWithMessages as unknown as jest.Mock;

function aiReturns(obj: any) {
  mockAi.mockResolvedValue({ content: JSON.stringify(obj), usage: {} });
}

describe('parsePythonScript', () => {
  beforeEach(() => mockAi.mockReset());

  test('normalizes a requests script into a ParsedApiSpec', async () => {
    aiReturns({
      title: 'Users API client',
      baseUrl: 'https://api.example.com',
      authSchemes: [{ name: 'bearerAuth', type: 'bearer', in: 'header', headerName: 'Authorization' }],
      endpoints: [
        {
          operationId: 'post_auth_login',
          method: 'post',
          path: '/auth/login',
          summary: 'Log in',
          parameters: [],
          requestBody: { contentType: 'application/json', schema: { username: '{{username}}', password: '{{password}}' }, required: true },
          responses: { '200': { description: 'OK' } },
          security: [],
        },
        {
          operationId: 'get_user',
          method: 'GET',
          path: '/users/{user_id}',
          summary: 'Get user',
          parameters: [{ name: 'user_id', in: 'path', required: true }],
          responses: { '200': { description: 'OK' } },
          security: ['bearerAuth'],
        },
      ],
    });

    const spec = await parsePythonScript('import requests\nrequests.post("https://api.example.com/auth/login", json={...})');

    expect(spec.sourceType).toBe('python');
    expect(spec.specVersion).toBe('python');
    expect(spec.baseUrl).toBe('https://api.example.com');
    expect(spec.endpoints).toHaveLength(2);
    expect(spec.endpoints[0].method).toBe('POST'); // coerced upper
    expect(spec.endpoints[1].parameters[0]).toMatchObject({ name: 'user_id', in: 'path', required: true });
    expect(spec.authSchemes[0]).toMatchObject({ name: 'bearerAuth', type: 'bearer' });
  });

  test('drops request body on GET and dedupes identical method+path', async () => {
    aiReturns({
      endpoints: [
        { method: 'GET', path: '/items', responses: {}, requestBody: { schema: { junk: true } } },
        { method: 'get', path: '/items' }, // duplicate after coercion
      ],
    });

    const spec = await parsePythonScript('import httpx\nhttpx.get("https://x/items")');
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0].requestBody).toBeUndefined();
    expect(spec.endpoints[0].responses).toEqual({ '200': { description: 'OK' } });
  });

  test('keeps a pytest assert status code as the response key', async () => {
    aiReturns({
      endpoints: [
        { method: 'POST', path: '/orders', responses: { '201': { description: 'Created' } } },
      ],
    });
    const spec = await parsePythonScript('def test_create():\n  assert r.status_code == 201');
    expect(Object.keys(spec.endpoints[0].responses)).toContain('201');
  });

  test('backfills a missing path parameter from a templated path', async () => {
    aiReturns({
      endpoints: [
        { method: 'GET', path: '/users/{user_id}/posts/{post_id}', parameters: [], responses: {} },
      ],
    });
    const spec = await parsePythonScript('import requests\nrequests.get(f"https://x/users/{u}/posts/{p}")');
    const pathParams = spec.endpoints[0].parameters.filter((p) => p.in === 'path');
    expect(pathParams.map((p) => p.name).sort()).toEqual(['post_id', 'user_id']);
    expect(pathParams.every((p) => p.required)).toBe(true);
  });

  test('does not duplicate a path param the model already provided', async () => {
    aiReturns({
      endpoints: [
        {
          method: 'GET',
          path: '/users/{user_id}',
          parameters: [{ name: 'user_id', in: 'path', required: true, example: '42' }],
          responses: {},
        },
      ],
    });
    const spec = await parsePythonScript('import requests\nrequests.get(f"https://x/users/{u}")');
    const userIdParams = spec.endpoints[0].parameters.filter((p) => p.name === 'user_id');
    expect(userIdParams).toHaveLength(1);
    expect(userIdParams[0].example).toBe('42'); // model-provided one kept, not overwritten
  });

  test('preserves a non-json request body contentType', async () => {
    aiReturns({
      endpoints: [
        {
          method: 'POST',
          path: '/upload',
          requestBody: { contentType: 'multipart/form-data', schema: { file: '{{file}}' }, required: true },
          responses: {},
        },
      ],
    });
    const spec = await parsePythonScript('import requests\nrequests.post("https://x/upload", files={})');
    expect(spec.endpoints[0].requestBody?.contentType).toBe('multipart/form-data');
  });

  test('throws when the model returns no endpoints', async () => {
    aiReturns({ endpoints: [] });
    await expect(parsePythonScript('print("hello")')).rejects.toThrow(/No HTTP API calls/);
  });

  test('throws on empty input without calling the model', async () => {
    await expect(parsePythonScript('   ')).rejects.toThrow(/Empty Python script/);
    expect(mockAi).not.toHaveBeenCalled();
  });

  test('throws when the response is unparseable', async () => {
    mockAi.mockResolvedValue({ content: 'not json at all', usage: {} });
    await expect(parsePythonScript('import requests')).rejects.toThrow(/Could not extract/);
  });
});
