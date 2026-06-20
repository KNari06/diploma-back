import { parseCurlCommands } from '../curl.adapter';

describe('parseCurlCommands', () => {
  it('parses a simple GET and derives the base URL', () => {
    const spec = parseCurlCommands('curl https://api.example.com/users');
    expect(spec.baseUrl).toBe('https://api.example.com');
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0]).toMatchObject({ method: 'GET', path: '/users', operationId: 'get_users' });
  });

  it('parses method, JSON header, and JSON body for a POST', () => {
    const spec = parseCurlCommands(
      `curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"name":"ann"}'`,
    );
    const ep = spec.endpoints[0];
    expect(ep.method).toBe('POST');
    expect(ep.requestBody).toMatchObject({
      contentType: 'application/json',
      schema: { name: 'ann' },
    });
  });

  it('infers POST when a body is present without an explicit method', () => {
    const spec = parseCurlCommands(`curl https://api.example.com/items -d 'x=1'`);
    expect(spec.endpoints[0].method).toBe('POST');
    // Non-JSON body is kept as a raw string
    expect(spec.endpoints[0].requestBody?.schema).toBe('x=1');
  });

  it('records bearer auth from --oauth2-bearer', () => {
    const spec = parseCurlCommands('curl https://api.example.com/me --oauth2-bearer abc123');
    expect(spec.endpoints[0].security).toEqual(['bearerAuth']);
    expect(spec.authSchemes).toEqual([{ name: 'bearerAuth', type: 'bearer' }]);
  });

  it('encodes basic auth from -u into an Authorization header', () => {
    const spec = parseCurlCommands('curl -u user:pass https://api.example.com/secure');
    // -u sets an Authorization header → endpoint is flagged secured
    expect(spec.endpoints[0].security).toEqual(['bearerAuth']);
  });

  it('extracts query parameters from the URL', () => {
    const spec = parseCurlCommands(`curl 'https://api.example.com/search?q=test&page=2'`);
    const names = spec.endpoints[0].parameters.map((p) => p.name).sort();
    expect(names).toEqual(['page', 'q']);
    expect(spec.endpoints[0].parameters.every((p) => p.in === 'query')).toBe(true);
  });

  it('detects a numeric path segment as an id path parameter', () => {
    const spec = parseCurlCommands('curl https://api.example.com/users/123');
    const idParam = spec.endpoints[0].parameters.find((p) => p.in === 'path');
    expect(idParam).toMatchObject({ name: 'id', in: 'path', required: true, example: '123' });
  });

  it('detects a :named path segment as a path parameter', () => {
    const spec = parseCurlCommands('curl https://api.example.com/users/:userId');
    expect(spec.endpoints[0].parameters.find((p) => p.in === 'path')).toMatchObject({
      name: 'userId',
      in: 'path',
    });
  });

  it('deduplicates identical method + path commands', () => {
    const spec = parseCurlCommands(
      ['curl https://api.example.com/users', 'curl https://api.example.com/users'].join('\n'),
    );
    expect(spec.endpoints).toHaveLength(1);
  });

  it('parses multiple distinct curl commands into separate endpoints', () => {
    const spec = parseCurlCommands(
      ['curl https://api.example.com/users', 'curl -X POST https://api.example.com/orders'].join('\n'),
    );
    expect(spec.endpoints).toHaveLength(2);
    expect(spec.endpoints.map((e) => e.method).sort()).toEqual(['GET', 'POST']);
  });

  it('drops a protocol-less URL (documents current limitation)', () => {
    // NOTE: parseCurlCommand() adds an https:// prefix only for its internal
    // URL parsing but returns the ORIGINAL token, so the outer re-parse in
    // parseCurlCommands (new URL(parsed.url)) fails and the endpoint is skipped.
    // Net effect: a protocol-less curl yields no endpoints and throws.
    expect(() => parseCurlCommands('curl api.example.com/ping')).toThrow(
      'Could not parse any valid API endpoints',
    );
  });

  it('throws when there is no curl command in the input', () => {
    expect(() => parseCurlCommands('not a curl command')).toThrow('No valid curl commands found');
  });
});
