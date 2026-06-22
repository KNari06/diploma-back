import { parsePostmanCollection } from '../postman.adapter';

function postman(opts: { name?: string; schema?: string; item?: unknown[]; auth?: unknown; variable?: unknown[] }) {
  return JSON.stringify({
    info: {
      name: opts.name ?? 'Test API',
      schema: opts.schema ?? 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: opts.item ?? [],
    auth: opts.auth,
    variable: opts.variable,
  });
}

const item = (request: unknown, name = 'Req') => ({ name, request });

describe('parsePostmanCollection validation', () => {
  it('throws on invalid JSON', () => {
    expect(() => parsePostmanCollection('{bad')).toThrow('not valid JSON');
  });

  it('throws when info or item is missing', () => {
    expect(() => parsePostmanCollection(JSON.stringify({ info: { name: 'x' } }))).toThrow(
      'missing info or item',
    );
  });

  it('detects the schema version', () => {
    const v21 = parsePostmanCollection(
      postman({ item: [item({ method: 'GET', url: 'https://api.x.com/a' })] }),
    );
    expect(v21.specVersion).toBe('2.1');
    const v20 = parsePostmanCollection(
      postman({
        schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json',
        item: [item({ method: 'GET', url: 'https://api.x.com/a' })],
      }),
    );
    expect(v20.specVersion).toBe('2.0');
  });
});

describe('parsePostmanCollection URL resolution', () => {
  it('parses a string URL', () => {
    const spec = parsePostmanCollection(
      postman({ item: [item({ method: 'GET', url: 'https://api.example.com/users' })] }),
    );
    expect(spec.baseUrl).toBe('https://api.example.com');
    expect(spec.endpoints[0].path).toBe('/users');
  });

  it('parses a structured PostmanUrl object with host/port/path', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [
          item({
            method: 'GET',
            url: { protocol: 'https', host: ['api', 'example', 'com'], port: '8080', path: ['v1', 'users'] },
          }),
        ],
      }),
    );
    expect(spec.baseUrl).toBe('https://api.example.com:8080');
    expect(spec.endpoints[0].path).toBe('/v1/users');
  });

  it('normalizes :param path segments to {param}', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [item({ method: 'GET', url: { host: ['api', 'x', 'com'], path: ['users', ':userId'] } })],
      }),
    );
    expect(spec.endpoints[0].path).toBe('/users/{userId}');
    expect(spec.endpoints[0].parameters.some((p) => p.in === 'path' && p.name === 'userId')).toBe(true);
  });
});

describe('parsePostmanCollection params + body', () => {
  it('extracts query params, skips disabled, and flags pagination', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [
          item({
            method: 'GET',
            url: {
              host: ['api', 'x', 'com'],
              path: ['list'],
              query: [
                { key: 'page', value: '1' },
                { key: 'old', value: 'x', disabled: true },
              ],
            },
          }),
        ],
      }),
    );
    const q = spec.endpoints[0].parameters.filter((p) => p.in === 'query').map((p) => p.name);
    expect(q).toEqual(['page']);
    expect(spec.endpoints[0].isPagination).toBe(true);
  });

  it('parses a raw JSON body', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [
          item({
            method: 'POST',
            url: 'https://api.x.com/users',
            body: { mode: 'raw', raw: '{"name":"ann"}', options: { raw: { language: 'json' } } },
          }),
        ],
      }),
    );
    expect(spec.endpoints[0].requestBody?.schema).toEqual({ name: 'ann' });
    expect(spec.endpoints[0].requestBody?.contentType).toBe('application/json');
  });

  it('parses a urlencoded body into an object', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [
          item({
            method: 'POST',
            url: 'https://api.x.com/form',
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'a', value: '1' },
                { key: 'b', value: '2', disabled: true },
              ],
            },
          }),
        ],
      }),
    );
    expect(spec.endpoints[0].requestBody?.schema).toEqual({ a: '1' });
    expect(spec.endpoints[0].requestBody?.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('flags a formdata file upload', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [
          item({
            method: 'POST',
            url: 'https://api.x.com/upload',
            body: { mode: 'formdata', formdata: [{ key: 'file', value: '', type: 'file' }] },
          }),
        ],
      }),
    );
    expect(spec.endpoints[0].hasFileUpload).toBe(true);
    expect(spec.endpoints[0].requestBody?.contentType).toBe('multipart/form-data');
  });
});

describe('parsePostmanCollection folders + auth', () => {
  it('flattens nested folders into endpoints', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [
          { name: 'Users', item: [item({ method: 'GET', url: 'https://api.x.com/users' }, 'List')] },
        ],
      }),
    );
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0].operationId).toBe('Users_List');
  });

  it('applies collection-level bearer auth to all endpoints', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [item({ method: 'GET', url: 'https://api.x.com/a' })],
        auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] },
      }),
    );
    expect(spec.authSchemes).toEqual([{ name: 'bearerAuth', type: 'bearer' }]);
    expect(spec.endpoints[0].security).toEqual(['bearerAuth']);
  });

  it('parses apiKey auth with a custom header name', () => {
    const spec = parsePostmanCollection(
      postman({
        item: [item({ method: 'GET', url: 'https://api.x.com/a' })],
        auth: {
          type: 'apikey',
          apikey: [
            { key: 'key', value: 'X-Custom-Key' },
            { key: 'in', value: 'header' },
          ],
        },
      }),
    );
    expect(spec.authSchemes[0]).toMatchObject({ name: 'apiKey', type: 'apiKey', in: 'header', headerName: 'X-Custom-Key' });
    expect(spec.endpoints[0].security).toEqual(['apiKey']);
  });
});
