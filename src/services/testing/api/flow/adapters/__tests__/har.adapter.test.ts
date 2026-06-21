import { parseHarFile } from '../har.adapter';

type Header = { name: string; value: string };

function entry(opts: {
  method?: string;
  url?: string;
  reqHeaders?: Header[];
  queryString?: Header[];
  postData?: { mimeType?: string; text?: string };
  status?: number;
  respHeaders?: Header[];
  respText?: string;
}) {
  return {
    request: {
      method: opts.method ?? 'GET',
      url: opts.url ?? 'https://api.example.com/users',
      headers: opts.reqHeaders ?? [],
      queryString: opts.queryString ?? [],
      postData: opts.postData,
    },
    response: {
      status: opts.status ?? 200,
      headers: opts.respHeaders ?? [{ name: 'content-type', value: 'application/json' }],
      content: opts.respText !== undefined ? { mimeType: 'application/json', text: opts.respText } : undefined,
    },
  };
}

const har = (entries: unknown[]) =>
  JSON.stringify({ log: { version: '1.2', creator: { name: 'Chrome' }, entries } });

describe('parseHarFile validation', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseHarFile('{not json')).toThrow('not valid JSON');
  });

  it('throws when log.entries is missing', () => {
    expect(() => parseHarFile(JSON.stringify({ log: {} }))).toThrow('missing log.entries');
  });

  it('throws when no API requests remain after filtering', () => {
    expect(() => parseHarFile(har([entry({ url: 'https://x.com/app.js' })]))).toThrow(
      'No API requests found',
    );
  });
});

describe('parseHarFile filtering', () => {
  it('keeps a JSON GET request and derives the base URL', () => {
    const spec = parseHarFile(har([entry({ url: 'https://api.example.com/users' })]));
    expect(spec.baseUrl).toBe('https://api.example.com');
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0]).toMatchObject({ method: 'GET', path: '/users' });
    expect(spec.sourceType).toBe('har');
  });

  it('filters out static assets by extension', () => {
    const spec = parseHarFile(
      har([entry({ url: 'https://api.example.com/app.css' }), entry({ url: 'https://api.example.com/data' })]),
    );
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0].path).toBe('/data');
  });

  it('filters out a GET with an HTML response', () => {
    expect(() =>
      parseHarFile(har([entry({ respHeaders: [{ name: 'content-type', value: 'text/html' }] })])),
    ).toThrow('No API requests found');
  });

  it('keeps a mutating request even with a non-API (octet-stream) response', () => {
    const spec = parseHarFile(
      har([
        entry({
          method: 'POST',
          url: 'https://api.example.com/upload',
          respHeaders: [{ name: 'content-type', value: 'application/octet-stream' }],
        }),
      ]),
    );
    expect(spec.endpoints[0].method).toBe('POST');
  });
});

describe('parseHarFile path templating + dedup', () => {
  it('templates numeric and UUID path segments to {id}', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const spec = parseHarFile(
      har([
        entry({ url: 'https://api.example.com/users/42' }),
        entry({ url: `https://api.example.com/orders/${uuid}` }),
      ]),
    );
    const paths = spec.endpoints.map((e) => e.path).sort();
    expect(paths).toEqual(['/orders/{id}', '/users/{id}']);
  });

  it('deduplicates same method+template and merges query params', () => {
    const spec = parseHarFile(
      har([
        entry({ url: 'https://api.example.com/users/1', queryString: [{ name: 'a', value: '1' }] }),
        entry({ url: 'https://api.example.com/users/2', queryString: [{ name: 'b', value: '2' }] }),
      ]),
    );
    expect(spec.endpoints).toHaveLength(1);
    const qNames = spec.endpoints[0].parameters.filter((p) => p.in === 'query').map((p) => p.name).sort();
    expect(qNames).toEqual(['a', 'b']);
    expect(spec.endpoints[0].parameters.some((p) => p.in === 'path' && p.name === 'id')).toBe(true);
  });
});

describe('parseHarFile body + auth', () => {
  it('parses a JSON request body', () => {
    const spec = parseHarFile(
      har([
        entry({
          method: 'POST',
          url: 'https://api.example.com/users',
          reqHeaders: [{ name: 'content-type', value: 'application/json' }],
          postData: { mimeType: 'application/json', text: '{"name":"ann"}' },
        }),
      ]),
    );
    expect(spec.endpoints[0].requestBody?.schema).toEqual({ name: 'ann' });
  });

  it('flags a multipart request as a file upload', () => {
    const spec = parseHarFile(
      har([
        entry({
          method: 'POST',
          url: 'https://api.example.com/files',
          postData: { mimeType: 'multipart/form-data; boundary=x', text: '' },
        }),
      ]),
    );
    expect(spec.endpoints[0].hasFileUpload).toBe(true);
  });

  it('marks endpoints with an Authorization header as secured', () => {
    const spec = parseHarFile(
      har([entry({ reqHeaders: [{ name: 'Authorization', value: 'Bearer xyz' }] })]),
    );
    expect(spec.endpoints[0].security).toEqual(['bearerAuth']);
    expect(spec.authSchemes).toEqual([{ name: 'bearerAuth', type: 'bearer' }]);
  });
});
