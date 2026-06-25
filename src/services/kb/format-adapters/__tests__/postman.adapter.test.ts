import { postmanAdapter } from '../postman.adapter';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Wrap items in a minimal valid Postman v2 collection JSON string. */
function collection(items: unknown[], info: Record<string, unknown> = {}): string {
  return JSON.stringify({ info: { name: 'My API', schema: SCHEMA, ...info }, item: items });
}

/** Shorthand for a request item. */
function request(name: string, request: Record<string, unknown>, event?: unknown[]): Record<string, unknown> {
  return { name, request, ...(event ? { event } : {}) };
}

const extract = (raw: string) => postmanAdapter.extract('c.json', raw);

describe('postmanAdapter.detect', () => {
  it('recognizes a v2 collection by its schema URL', () => {
    expect(postmanAdapter.detect('c.json', collection([]))).toBe(true);
  });

  it('rejects content that does not start with {', () => {
    expect(postmanAdapter.detect('c.json', 'not json')).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(postmanAdapter.detect('c.json', '{ broken')).toBe(false);
  });

  it('rejects JSON without the Postman schema marker', () => {
    expect(postmanAdapter.detect('c.json', JSON.stringify({ info: { name: 'x' } }))).toBe(false);
  });

  it('tolerates leading whitespace', () => {
    expect(postmanAdapter.detect('c.json', '   ' + collection([]))).toBe(true);
  });
});

describe('postmanAdapter.extract — collection-level', () => {
  it('returns an empty result with a parse-failure summary on invalid JSON', () => {
    expect(extract('{ broken')).toEqual({ format: 'postman', chunks: [], summary: 'Postman: failed to parse' });
  });

  it('summarizes an empty collection with the collection name', () => {
    const res = extract(collection([]));
    expect(res.chunks).toEqual([]);
    expect(res.summary).toBe('Postman · My API · 0 requests');
  });

  it('pluralizes the request count correctly', () => {
    const one = extract(collection([request('A', { method: 'get', url: '/a' })]));
    expect(one.summary).toBe('Postman · My API · 1 request');
    const two = extract(
      collection([request('A', { method: 'get', url: '/a' }), request('B', { method: 'get', url: '/b' })]),
    );
    expect(two.summary).toBe('Postman · My API · 2 requests');
  });

  it('falls back to a default name when info is missing', () => {
    const raw = JSON.stringify({ item: [] }); // no info
    expect(extract(raw).summary).toBe('Postman · Postman collection · 0 requests');
  });
});

describe('postmanAdapter.extract — requests', () => {
  it('builds one chunk per request with method, path, name and metadata', () => {
    const res = extract(collection([request('Get user', { method: 'get', url: '/users/1' })]));
    expect(res.chunks).toHaveLength(1);
    const chunk = res.chunks[0];
    expect(chunk.sectionTitle).toBe('GET Get user');
    expect(chunk.content).toContain('GET /users/1');
    expect(chunk.content).toContain('Name: Get user');
    expect(chunk.metadata).toMatchObject({ format: 'postman', http_method: 'GET', path: '/users/1', has_tests: false });
  });

  it('defaults the method to GET when absent', () => {
    const res = extract(collection([request('No method', { url: '/x' })]));
    expect(res.chunks[0].metadata!.http_method).toBe('GET');
  });

  it('renders "(no url)" when the request has no url', () => {
    const res = extract(collection([request('Bare', { method: 'post' })]));
    expect(res.chunks[0].content).toContain('POST (no url)');
  });

  it('includes a truncated description', () => {
    const res = extract(collection([request('D', { method: 'get', url: '/d', description: '  multi   space  ' })]));
    expect(res.chunks[0].content).toContain('multi space');
  });
});

describe('postmanAdapter.extract — URL shapes', () => {
  it('handles an object url with a path-segment array', () => {
    const res = extract(
      collection([
        request('Obj', { method: 'get', url: { raw: 'https://api.test/v1/users', path: ['v1', 'users'] } }),
      ]),
    );
    expect(res.chunks[0].metadata!.path).toBe('/v1/users');
    expect(res.chunks[0].content).toContain('Full URL: https://api.test/v1/users');
  });

  it('derives the path from a full string url', () => {
    const res = extract(collection([request('Str', { method: 'get', url: 'https://api.test/orders' })]));
    expect(res.chunks[0].metadata!.path).toBe('/orders');
  });

  it('keeps a relative string url verbatim when it is not a valid absolute URL', () => {
    const res = extract(collection([request('Rel', { method: 'get', url: '/just/a/path' })]));
    expect(res.chunks[0].metadata!.path).toBe('/just/a/path');
  });

  it('renders "(no url)" for an object url with neither raw nor path', () => {
    const res = extract(collection([request('Empty', { method: 'get', url: {} })]));
    expect(res.chunks[0].content).toContain('GET (no url)');
  });
});

describe('postmanAdapter.extract — defensive degradation', () => {
  it('ignores a non-object body', () => {
    const res = extract(collection([request('B', { method: 'post', url: '/b', body: 'oops' })]));
    expect(res.chunks[0].content).not.toContain('Body');
  });

  it('ignores a non-array header field', () => {
    const res = extract(collection([request('H', { method: 'get', url: '/h', header: 'oops' })]));
    expect(res.chunks[0].content).not.toContain('Headers:');
  });

  it('drops a malformed request item (request is not an object)', () => {
    const res = extract(collection([{ name: 'Bad', request: 'nope' }]));
    expect(res.chunks).toHaveLength(0);
  });
});

describe('postmanAdapter.extract — folders and disabled items', () => {
  it('captures the folder path as tags', () => {
    const raw = collection([
      { name: 'auth', item: [request('login', { method: 'post', url: '/login' })] },
    ]);
    const res = extract(raw);
    expect(res.chunks[0].metadata!.folder).toEqual(['auth']);
    expect(res.chunks[0].content).toContain('Folder: auth');
  });

  it('recurses nested folders', () => {
    const raw = collection([
      { name: 'admin', item: [{ name: 'users', item: [request('list', { method: 'get', url: '/admin/users' })] }] },
    ]);
    expect(extract(raw).chunks[0].metadata!.folder).toEqual(['admin', 'users']);
  });

  it('skips disabled items and disabled folders', () => {
    const raw = collection([
      request('kept', { method: 'get', url: '/a' }),
      { name: 'skip me', disabled: true, item: [request('hidden', { method: 'get', url: '/b' })] },
      { ...request('off', { method: 'get', url: '/c' }), disabled: true },
    ]);
    const res = extract(raw);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].content).toContain('Name: kept');
  });
});

describe('postmanAdapter.extract — headers', () => {
  it('lists enabled headers and skips disabled / keyless ones', () => {
    const res = extract(
      collection([
        request('H', {
          method: 'get',
          url: '/h',
          header: [
            { key: 'Authorization', value: 'Bearer x' },
            { key: 'X-Off', value: 'y', disabled: true },
            { value: 'no-key' },
          ],
        }),
      ]),
    );
    const content = res.chunks[0].content;
    expect(content).toContain('Authorization: Bearer x');
    expect(content).not.toContain('X-Off');
    expect(content).not.toContain('no-key');
  });
});

describe('postmanAdapter.extract — body shapes', () => {
  const body = (b: unknown) => extract(collection([request('B', { method: 'post', url: '/b', body: b })])).chunks[0].content;

  it('describes a raw body', () => {
    expect(body({ mode: 'raw', raw: '{"a":1}' })).toContain('Body (raw): {"a":1}');
  });

  it('describes a graphql body with query and variables', () => {
    const out = body({ mode: 'graphql', graphql: { query: 'query { me }', variables: '{"id":1}' } });
    expect(out).toContain('Body (graphql):');
    expect(out).toContain('query: query { me }');
    expect(out).toContain('variables: {"id":1}');
  });

  it('lists urlencoded/formdata keys and skips disabled fields', () => {
    const out = body({
      mode: 'formdata',
      formdata: [{ key: 'file' }, { key: 'off', disabled: true }, { key: 'name' }],
    });
    expect(out).toContain('Body (formdata): file, name');
  });

  it('handles an empty urlencoded body', () => {
    expect(body({ mode: 'urlencoded', urlencoded: [] })).toContain('Body (urlencoded): (empty)');
  });

  it('labels a file upload body', () => {
    expect(body({ mode: 'file' })).toContain('Body (file upload)');
  });

  it('reports an unknown body mode', () => {
    expect(body({ mode: 'weird' })).toContain('Body mode: weird');
  });

  it('omits a disabled body envelope', () => {
    const out = body({ mode: 'raw', raw: 'x', disabled: true });
    expect(out).not.toContain('Body');
  });
});

describe('postmanAdapter.extract — scripts/events', () => {
  it('captures test and pre-request scripts and flags has_tests', () => {
    const res = extract(
      collection([
        request('S', { method: 'get', url: '/s' }, [
          { listen: 'test', script: { exec: ['pm.test("ok", () => {});'] } },
          { listen: 'prerequest', script: { exec: ['pm.environment.set("t", 1);'] } },
        ]),
      ]),
    );
    const chunk = res.chunks[0];
    expect(chunk.content).toContain('Tests:');
    expect(chunk.content).toContain('pm.test("ok"');
    expect(chunk.content).toContain('Pre-request script:');
    expect(chunk.metadata!.has_tests).toBe(true);
  });

  it('ignores events with an empty exec', () => {
    const res = extract(
      collection([request('S', { method: 'get', url: '/s' }, [{ listen: 'test', script: { exec: [] } }])]),
    );
    expect(res.chunks[0].content).not.toContain('Tests:');
    expect(res.chunks[0].metadata!.has_tests).toBe(false);
  });
});
