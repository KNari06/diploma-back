import { openApiAdapter } from '../openapi.adapter';

const detect = (raw: string) => openApiAdapter.detect('spec.json', raw);
const extract = (raw: string) => openApiAdapter.extract('spec.json', raw);

/** Build an OpenAPI 3 spec JSON string. */
const v3 = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ openapi: '3.0.0', info: { title: 'API' }, paths: {}, ...over });

describe('openApiAdapter.detect', () => {
  it('recognizes an OpenAPI 3 JSON spec', () => {
    expect(detect(v3())).toBe(true);
  });

  it('recognizes a Swagger 2 JSON spec', () => {
    expect(detect(JSON.stringify({ swagger: '2.0', paths: {} }))).toBe(true);
  });

  it('rejects JSON without openapi/swagger markers', () => {
    expect(detect(JSON.stringify({ paths: {} }))).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(detect('{ not valid')).toBe(false);
  });

  it('recognizes a YAML spec by its marker', () => {
    expect(detect('openapi: 3.0.0\ninfo:\n  title: API\npaths: {}')).toBe(true);
  });

  it('rejects YAML without an openapi/swagger marker', () => {
    expect(detect('foo: bar\nbaz: 1')).toBe(false);
  });

  it('rejects content with a YAML marker but invalid YAML', () => {
    expect(detect('openapi: 3.0.0\nfoo: [unclosed')).toBe(false);
  });

  it('rejects empty or non-string input', () => {
    expect(detect('')).toBe(false);
    expect(openApiAdapter.detect('f', null as unknown as string)).toBe(false);
  });
});

describe('openApiAdapter.extract — parsing & summary', () => {
  it('returns a parse-failure result for malformed input', () => {
    expect(extract('{ broken')).toEqual({ format: 'openapi', chunks: [], summary: 'OpenAPI: failed to parse' });
  });

  it('parses a YAML spec', () => {
    const res = extract('openapi: 3.0.1\npaths:\n  /ping:\n    get:\n      summary: Ping');
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].sectionTitle).toBe('GET /ping');
  });

  it('reflects the swagger version and "unknown" when neither marker is present', () => {
    // A spec object that parses but lacks version markers still extracts.
    const res = extract(JSON.stringify({ paths: { '/x': { get: {} } } }));
    expect(res.summary).toContain('OpenAPI unknown');
  });

  it('pluralizes operations, schemas and servers', () => {
    const res = extract(
      v3({
        servers: [{ url: 'https://a.test' }],
        paths: { '/a': { get: {}, post: {} } },
        components: { schemas: { One: { type: 'object' } } },
      }),
    );
    expect(res.summary).toBe('OpenAPI 3.0.0 · 2 operations · 1 schema · 1 server');
  });

  it('omits the server segment when there are no servers', () => {
    const res = extract(v3({ paths: { '/a': { get: {} } } }));
    expect(res.summary).toBe('OpenAPI 3.0.0 · 1 operation · 0 schemas');
  });
});

describe('openApiAdapter.extract — operations', () => {
  it('emits one chunk per HTTP method with core metadata', () => {
    const res = extract(v3({ paths: { '/users': { get: {}, post: {} } } }));
    expect(res.chunks.map((c) => c.sectionTitle).sort()).toEqual(['GET /users', 'POST /users']);
    const get = res.chunks.find((c) => c.sectionTitle === 'GET /users')!;
    expect(get.metadata).toMatchObject({ format: 'openapi', http_method: 'GET', path: '/users', has_request_body: false });
  });

  it('includes summary, operationId, tags and description', () => {
    const res = extract(
      v3({
        paths: {
          '/users': {
            get: { summary: 'List users', operationId: 'listUsers', tags: ['users'], description: 'Returns all users' },
          },
        },
      }),
    );
    const content = res.chunks[0].content;
    expect(content).toContain('List users');
    expect(content).toContain('operationId: listUsers');
    expect(content).toContain('tags: users');
    expect(content).toContain('Returns all users');
  });

  it('merges path-level and operation-level parameters and marks required ones', () => {
    const res = extract(
      v3({
        paths: {
          '/users/{id}': {
            parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
            get: { parameters: [{ in: 'query', name: 'verbose', schema: { type: 'boolean' } }] },
          },
        },
      }),
    );
    const content = res.chunks[0].content;
    expect(content).toContain('- path: id (required) [string]');
    expect(content).toContain('- query: verbose [boolean]');
  });

  it('renders a parameter that is itself a $ref', () => {
    const res = extract(
      v3({ paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/PageParam' }] } } } }),
    );
    expect(res.chunks[0].content).toContain('- $ref: PageParam');
  });

  it('describes the request body and flags has_request_body', () => {
    const res = extract(
      v3({
        paths: {
          '/users': {
            post: {
              requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
            },
          },
        },
      }),
    );
    const chunk = res.chunks[0];
    expect(chunk.content).toContain('Request body (required): application/json');
    expect(chunk.content).toContain('application/json: $ref:User');
    expect(chunk.metadata!.has_request_body).toBe(true);
    expect(chunk.metadata!.referenced_schemas).toContain('User');
  });

  it('describes responses with status codes and schema shapes', () => {
    const res = extract(
      v3({
        paths: {
          '/users': {
            get: {
              responses: {
                '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } },
                '404': { description: 'not found' },
              },
            },
          },
        },
      }),
    );
    const chunk = res.chunks[0];
    expect(chunk.content).toContain('200: ok (application/json) → array<$ref:User>');
    expect(chunk.content).toContain('404: not found');
    expect(chunk.metadata!.status_codes).toEqual(['200', '404']);
  });

  it('renders a security requirement line', () => {
    const res = extract(
      v3({ paths: { '/x': { get: { security: [{ apiKey: [] }, { oauth2: ['read'] }] } } } }),
    );
    expect(res.chunks[0].content).toContain('Security: apiKey OR oauth2');
  });

  it('lists referenced schemas collected across the operation', () => {
    const res = extract(
      v3({
        paths: {
          '/x': {
            post: {
              parameters: [{ in: 'query', name: 'f', schema: { $ref: '#/components/schemas/Filter' } }],
              requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } } },
            },
          },
        },
      }),
    );
    expect(res.chunks[0].content).toContain('References schemas:');
    expect(res.chunks[0].metadata!.referenced_schemas).toEqual(expect.arrayContaining(['Filter', 'Body']));
  });
});

describe('openApiAdapter.extract — servers', () => {
  it('reads OpenAPI 3 servers[].url', () => {
    const res = extract(v3({ servers: [{ url: 'https://api.test/v1' }], paths: { '/x': { get: {} } } }));
    expect(res.chunks[0].content).toContain('servers: https://api.test/v1');
  });

  it('builds Swagger 2 server URLs from host + basePath + schemes', () => {
    const res = extract(
      JSON.stringify({ swagger: '2.0', host: 'api.test', basePath: '/v1', schemes: ['https', 'http'], paths: { '/x': { get: {} } } }),
    );
    expect(res.chunks[0].metadata!.servers).toEqual(['https://api.test/v1', 'http://api.test/v1']);
  });

  it('defaults to https when only a host is given', () => {
    const res = extract(JSON.stringify({ swagger: '2.0', host: 'api.test', paths: { '/x': { get: {} } } }));
    expect(res.chunks[0].metadata!.servers).toEqual(['https://api.test']);
  });
});

describe('openApiAdapter.extract — schema chunks', () => {
  it('emits a chunk per component schema with properties and required flags', () => {
    const res = extract(
      v3({
        paths: {},
        components: {
          schemas: {
            User: {
              type: 'object',
              required: ['id'],
              description: 'A user',
              properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
            },
          },
        },
      }),
    );
    const chunk = res.chunks[0];
    expect(chunk.sectionTitle).toBe('Schema: User');
    expect(chunk.content).toContain('type: object');
    expect(chunk.content).toContain('- id (required): string:uuid');
    expect(chunk.content).toContain('- name: string');
    expect(chunk.metadata).toMatchObject({ kind: 'schema', schema_name: 'User', type: 'object' });
  });

  it('reads Swagger 2 definitions', () => {
    const res = extract(JSON.stringify({ swagger: '2.0', paths: {}, definitions: { Pet: { type: 'object', properties: { n: { type: 'string' } } } } }));
    expect(res.chunks.find((c) => c.sectionTitle === 'Schema: Pet')).toBeDefined();
  });

  it('captures enum and composition in a schema chunk', () => {
    const res = extract(
      v3({
        paths: {},
        components: {
          schemas: {
            Status: { enum: ['active', 'inactive'] },
            Combined: { allOf: [{ $ref: '#/components/schemas/A' }, { type: 'object' }] },
          },
        },
      }),
    );
    const status = res.chunks.find((c) => c.sectionTitle === 'Schema: Status')!;
    expect(status.content).toContain('enum: "active", "inactive"');
    expect(status.metadata!.has_enum).toBe(true);
    const combined = res.chunks.find((c) => c.sectionTitle === 'Schema: Combined')!;
    expect(combined.content).toContain('allOf: $ref:A | object');
    expect(combined.metadata!.is_composed).toBe(true);
  });

  it('describes array item shapes in a schema chunk', () => {
    const res = extract(
      v3({ paths: {}, components: { schemas: { List: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } } }),
    );
    expect(res.chunks[0].content).toContain('items: $ref:Item');
  });
});

describe('openApiAdapter.extract — inline schema shapes', () => {
  it('renders object{...}, enum and primitives in parameter shapes', () => {
    const res = extract(
      v3({
        paths: {
          '/x': {
            get: {
              parameters: [
                { in: 'query', name: 'obj', schema: { type: 'object', properties: { a: {}, b: {} } } },
                { in: 'query', name: 'choice', schema: { enum: ['x', 'y'] } },
                { in: 'query', name: 'when', schema: { type: 'string', format: 'date-time' } },
              ],
            },
          },
        },
      }),
    );
    const content = res.chunks[0].content;
    expect(content).toContain('obj [object{a, b}]');
    expect(content).toContain('choice [enum("x" | "y")]');
    expect(content).toContain('when [string:date-time]');
  });

  it('renders inline oneOf composition and an empty/typeless schema as "any"', () => {
    const res = extract(
      v3({
        paths: {
          '/x': {
            get: {
              parameters: [
                { in: 'query', name: 'u', schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
                { in: 'query', name: 'bare' }, // no schema → describes the param object → "any"
              ],
            },
          },
        },
      }),
    );
    const content = res.chunks[0].content;
    expect(content).toContain('u [oneOf(string | integer)]');
    expect(content).toContain('bare [any]');
  });
});
