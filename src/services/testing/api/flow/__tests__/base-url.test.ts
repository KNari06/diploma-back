/**
 * BASE URL RESOLUTION — deriving where a flow's requests are actually sent,
 * and honoring a run-time override. Guards the "Invalid URL format" (status 0)
 * failure that happens when a spec has no absolute server and nothing supplies one.
 */

import { deriveSpecBaseUrl, resolveRunBaseUrl } from '../base-url';

describe('deriveSpecBaseUrl', () => {
  it('uses an absolute OpenAPI 3 server url, trailing slash stripped', () => {
    expect(deriveSpecBaseUrl({ servers: [{ url: 'https://api.example.com/' }] })).toBe('https://api.example.com');
  });

  it('builds a Swagger 2 base from host + schemes + basePath', () => {
    expect(deriveSpecBaseUrl({ host: 'api.example.com', schemes: ['https'], basePath: '/v2' }))
      .toBe('https://api.example.com/v2');
  });

  it('defaults Swagger 2 scheme to https when none given', () => {
    expect(deriveSpecBaseUrl({ host: 'api.example.com' })).toBe('https://api.example.com');
  });

  it('falls back to the source URL origin when the spec has no server', () => {
    expect(deriveSpecBaseUrl({ paths: {} }, 'http://localhost:3000/api-docs-json'))
      .toBe('http://localhost:3000');
  });

  it('appends a relative server path onto the source origin', () => {
    expect(deriveSpecBaseUrl({ servers: [{ url: '/api' }] }, 'https://host.dev/swagger'))
      .toBe('https://host.dev/api');
  });

  it('returns empty when nothing absolute is derivable (file import, no servers)', () => {
    expect(deriveSpecBaseUrl({ info: { title: 'NestJS API' }, paths: {} })).toBe('');
    expect(deriveSpecBaseUrl({ info: {} }, undefined)).toBe('');
  });

  it('ignores a malformed source URL rather than throwing', () => {
    expect(deriveSpecBaseUrl({ paths: {} }, 'not a url')).toBe('');
  });

  it('tolerates a null/undefined rawSpec', () => {
    expect(deriveSpecBaseUrl(null)).toBe('');
    expect(deriveSpecBaseUrl(undefined, 'http://h:3000/x')).toBe('http://h:3000');
  });
});

describe('resolveRunBaseUrl', () => {
  const spec = { servers: [{ url: 'https://from-spec.example.com' }] };

  it('prefers an absolute override over the spec value', () => {
    expect(resolveRunBaseUrl(spec, null, 'https://override.example.com/')).toBe('https://override.example.com');
  });

  it('ignores a non-absolute override and falls back to the spec', () => {
    expect(resolveRunBaseUrl(spec, null, 'override.example.com')).toBe('https://from-spec.example.com');
    expect(resolveRunBaseUrl(spec, null, '')).toBe('https://from-spec.example.com');
    expect(resolveRunBaseUrl(spec, null, undefined)).toBe('https://from-spec.example.com');
  });

  it('returns empty when neither override nor spec yields an absolute URL', () => {
    expect(resolveRunBaseUrl({ paths: {} }, null, undefined)).toBe('');
    expect(resolveRunBaseUrl({ paths: {} }, null, '/relative')).toBe('');
  });
});
