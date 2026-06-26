import { parseOpenApiSpec } from '../openapi.adapter';

const V3_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Pet API', version: '2.1.0' },
  servers: [{ url: 'https://api.pet.com/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createPet',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'created' } },
      },
    },
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
};

const parse = (content: string) => parseOpenApiSpec({ content }, 'openapi' as any);

describe('parseOpenApiSpec — OpenAPI v3 (JSON)', () => {
  it('extracts title, version, and base URL', async () => {
    const spec = await parse(JSON.stringify(V3_SPEC));
    expect(spec.title).toBe('Pet API');
    expect(spec.version).toBe('2.1.0');
    expect(spec.baseUrl).toBe('https://api.pet.com/v1');
  });

  it('extracts every operation across paths and methods', async () => {
    const spec = await parse(JSON.stringify(V3_SPEC));
    const sigs = spec.endpoints.map(e => `${e.method} ${e.path}`).sort();
    expect(sigs).toEqual(['GET /pets', 'GET /pets/{id}', 'POST /pets']);
  });

  it('captures path and query parameters', async () => {
    const spec = await parse(JSON.stringify(V3_SPEC));
    const getById = spec.endpoints.find(e => e.path === '/pets/{id}' && e.method === 'GET');
    const pathParam = getById?.parameters.find(p => p.in === 'path');
    expect(pathParam).toMatchObject({ name: 'id', in: 'path' });

    const list = spec.endpoints.find(e => e.path === '/pets' && e.method === 'GET');
    expect(list?.parameters.some(p => p.name === 'limit' && p.in === 'query')).toBe(true);
  });

  it('surfaces declared security schemes', async () => {
    const spec = await parse(JSON.stringify(V3_SPEC));
    expect(spec.authSchemes.some(s => s.name === 'bearerAuth')).toBe(true);
  });

  it('records a request body on the POST operation', async () => {
    const spec = await parse(JSON.stringify(V3_SPEC));
    const post = spec.endpoints.find(e => e.method === 'POST' && e.path === '/pets');
    expect(post?.requestBody).toBeTruthy();
  });
});

describe('parseOpenApiSpec — YAML input', () => {
  it('parses an equivalent YAML document', async () => {
    const yaml = [
      'openapi: 3.0.0',
      'info:',
      '  title: YAML API',
      '  version: 1.0.0',
      'servers:',
      '  - url: https://yaml.example.com',
      'paths:',
      '  /ping:',
      '    get:',
      '      operationId: ping',
      '      responses:',
      "        '200':",
      '          description: ok',
    ].join('\n');
    const spec = await parse(yaml);
    expect(spec.title).toBe('YAML API');
    expect(spec.baseUrl).toBe('https://yaml.example.com');
    expect(spec.endpoints.map(e => `${e.method} ${e.path}`)).toEqual(['GET /ping']);
  });
});

describe('parseOpenApiSpec — invalid input', () => {
  it('throws when the content is not a YAML/JSON object', async () => {
    await expect(parse('just a bare string')).rejects.toThrow(/Failed to parse OpenAPI spec/);
  });
});
