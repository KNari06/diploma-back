import { parseInsomniaExport } from '../insomnia.adapter';

const exportWith = (resources: any[], extra: any = {}) =>
  JSON.stringify({ __export_format: 4, resources, ...extra });

const request = (over: any = {}) => ({
  _type: 'request',
  _id: 'req_1',
  name: 'Get Users',
  url: 'https://api.example.com/v1/users',
  method: 'GET',
  ...over,
});

describe('parseInsomniaExport — error cases', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseInsomniaExport('{not json')).toThrow('not valid JSON');
  });

  it('throws when the resources array is missing', () => {
    expect(() => parseInsomniaExport(JSON.stringify({ __export_format: 4 }))).toThrow('missing resources array');
  });

  it('throws when there are no request resources', () => {
    expect(() => parseInsomniaExport(exportWith([{ _type: 'folder', _id: 'f1' }]))).toThrow(
      'No requests found',
    );
  });
});

describe('parseInsomniaExport — endpoint extraction', () => {
  it('parses a basic request and extracts the base URL + path', () => {
    const spec = parseInsomniaExport(exportWith([request()]));
    expect(spec.baseUrl).toBe('https://api.example.com');
    expect(spec.sourceType).toBe('insomnia');
    expect(spec.specVersion).toBe('insomnia-v4');
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0]).toMatchObject({ method: 'GET', path: '/v1/users', summary: 'Get Users' });
  });

  it('ignores non-request resources and requests missing url/method', () => {
    const spec = parseInsomniaExport(
      exportWith([
        { _type: 'folder', _id: 'f1' },
        request({ _id: 'r1' }),
        { _type: 'request', _id: 'r2', name: 'no url' },
      ]),
    );
    expect(spec.endpoints).toHaveLength(1);
  });

  it('uppercases the method and skips unsupported HTTP methods', () => {
    const spec = parseInsomniaExport(
      exportWith([
        request({ _id: 'r1', method: 'post' }),
        request({ _id: 'r2', method: 'PROPFIND', url: 'https://api.example.com/x' }),
      ]),
    );
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0].method).toBe('POST');
  });

  it('collects enabled query parameters and drops disabled ones', () => {
    const spec = parseInsomniaExport(
      exportWith([
        request({
          parameters: [
            { name: 'page', value: '2' },
            { name: 'secret', value: 'x', disabled: true },
          ],
        }),
      ]),
    );
    const query = spec.endpoints[0].parameters.filter(p => p.in === 'query');
    expect(query).toEqual([{ name: 'page', in: 'query', required: false, example: '2' }]);
  });

  it('parses a JSON body and marks multipart bodies as file uploads', () => {
    const json = parseInsomniaExport(
      exportWith([request({ body: { mimeType: 'application/json', text: '{"a":1}' } })]),
    );
    expect(json.endpoints[0].requestBody?.schema).toEqual({ a: 1 });
    expect(json.endpoints[0].hasFileUpload).toBe(false);

    const multipart = parseInsomniaExport(
      exportWith([request({ body: { mimeType: 'multipart/form-data', text: 'x' } })]),
    );
    expect(multipart.endpoints[0].hasFileUpload).toBe(true);
  });

  it('falls back to the raw text when a JSON body fails to parse', () => {
    const spec = parseInsomniaExport(
      exportWith([request({ body: { mimeType: 'application/json', text: 'not-json' } })]),
    );
    expect(spec.endpoints[0].requestBody?.schema).toBe('not-json');
  });

  it('detects bearer auth from an Authorization header', () => {
    const spec = parseInsomniaExport(
      exportWith([request({ headers: [{ name: 'Authorization', value: 'Bearer x' }] })]),
    );
    expect(spec.endpoints[0].security).toEqual(['bearerAuth']);
    expect(spec.authSchemes).toEqual([{ name: 'bearerAuth', type: 'bearer' }]);
  });

  it('ignores a disabled Authorization header', () => {
    const spec = parseInsomniaExport(
      exportWith([request({ headers: [{ name: 'Authorization', value: 'Bearer x', disabled: true }] })]),
    );
    expect(spec.endpoints[0].security).toEqual([]);
    expect(spec.authSchemes).toEqual([]);
  });

  it('sanitizes the operationId from the request name', () => {
    const spec = parseInsomniaExport(exportWith([request({ name: 'Get Users!' })]));
    expect(spec.endpoints[0].operationId).toBe('Get_Users');
  });
});
