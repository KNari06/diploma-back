// ApiConfigService is only used by the async resolveApiUrl (not under test) and
// pulls the DB layer at import — stub it so importing the resolver stays light.
jest.mock('../../api/api-config.service', () => ({ ApiConfigService: class {} }));

import { UrlResolverService } from '../url-resolver.service';

describe('UrlResolverService.isRelativeUrl', () => {
  it('treats empty / nullish as relative', () => {
    expect(UrlResolverService.isRelativeUrl('')).toBe(true);
    expect(UrlResolverService.isRelativeUrl(undefined as any)).toBe(true);
  });
  it('treats a path as relative and an absolute URL as not', () => {
    expect(UrlResolverService.isRelativeUrl('/api/users')).toBe(true);
    expect(UrlResolverService.isRelativeUrl('https://api.com/x')).toBe(false);
    expect(UrlResolverService.isRelativeUrl('http://localhost:3000/a')).toBe(false);
  });
});

describe('UrlResolverService.extractBaseUrl', () => {
  it('returns the protocol+host of a full URL', () => {
    expect(UrlResolverService.extractBaseUrl('https://api.com/v1/users?q=1')).toBe('https://api.com');
    expect(UrlResolverService.extractBaseUrl('http://localhost:3000/a')).toBe('http://localhost:3000');
  });
  it('returns empty string for invalid input', () => {
    expect(UrlResolverService.extractBaseUrl('')).toBe('');
    expect(UrlResolverService.extractBaseUrl('not a url')).toBe('');
  });
});

describe('UrlResolverService.extractPath', () => {
  it('extracts the pathname from a full URL', () => {
    expect(UrlResolverService.extractPath('https://api.com/v1/users')).toBe('/v1/users');
  });
  it('normalizes a bare path and defaults empties to /', () => {
    expect(UrlResolverService.extractPath('already/slashed')).toBe('/already/slashed');
    expect(UrlResolverService.extractPath('/keeps')).toBe('/keeps');
    expect(UrlResolverService.extractPath('')).toBe('/');
  });
});

describe('UrlResolverService.generateEnvironmentName', () => {
  it('defaults for empty / invalid', () => {
    expect(UrlResolverService.generateEnvironmentName('')).toBe('Default');
    expect(UrlResolverService.generateEnvironmentName('garbage')).toBe('Default');
  });
  it('names by host keywords', () => {
    expect(UrlResolverService.generateEnvironmentName('http://localhost:3000')).toBe('Local (3000)');
    expect(UrlResolverService.generateEnvironmentName('https://staging.acme.com')).toBe('Staging');
    expect(UrlResolverService.generateEnvironmentName('https://dev.acme.com')).toBe('Development');
    expect(UrlResolverService.generateEnvironmentName('https://test.acme.com')).toBe('Testing');
    expect(UrlResolverService.generateEnvironmentName('https://api.acme.com')).toBe('Production');
  });
  it('falls back to a capitalized domain name', () => {
    expect(UrlResolverService.generateEnvironmentName('https://acme.io')).toBe('Acme');
  });
});

describe('UrlResolverService.generateBaseUrlSuggestions', () => {
  it('returns defaults for invalid input', () => {
    expect(UrlResolverService.generateBaseUrlSuggestions(null as any)).toEqual([
      'https://api.example.com',
      'http://localhost:3000',
    ]);
  });
  it('tailors suggestions to the path shape', () => {
    expect(UrlResolverService.generateBaseUrlSuggestions('/api/v1/users')[0]).toBe('https://api.example.com');
    expect(UrlResolverService.generateBaseUrlSuggestions('/api/users')).toContain('http://localhost:8080');
    expect(UrlResolverService.generateBaseUrlSuggestions('/widgets')).toContain('https://api.example.com/api');
  });
});

describe('UrlResolverService.smartCompleteUrl', () => {
  it('returns nothing for empty input', () => {
    expect(UrlResolverService.smartCompleteUrl('')).toEqual([]);
  });
  it('prefixes a bare domain with both protocols (https first)', () => {
    expect(UrlResolverService.smartCompleteUrl('example.com')).toEqual(['https://example.com', 'http://example.com']);
  });
  it('prefers http for localhost', () => {
    expect(UrlResolverService.smartCompleteUrl('localhost:3000')[0]).toBe('http://localhost:3000');
  });
  it('completes a bare port to localhost', () => {
    expect(UrlResolverService.smartCompleteUrl(':8080')).toContain('http://localhost:8080');
  });
});

describe('UrlResolverService.parseUserResponse', () => {
  it('errors on invalid path or empty response', () => {
    expect(UrlResolverService.parseUserResponse('', 'https://x.com').error).toBeDefined();
    expect(UrlResolverService.parseUserResponse('/users', '   ').error).toBeDefined();
  });
  it('builds a full URL from a response containing a base URL', () => {
    const r = UrlResolverService.parseUserResponse('/users', 'use https://api.com/');
    expect(r.baseUrl).toBe('https://api.com');
    expect(r.fullUrl).toBe('https://api.com/users');
  });
  it('extracts a bearer token and an api key into headers', () => {
    const r = UrlResolverService.parseUserResponse('/users', 'https://api.com token: abc123 api_key: KEY9');
    expect(r.headers).toMatchObject({ Authorization: 'Bearer abc123', 'X-API-Key': 'KEY9' });
  });
  it('errors when no URL is present in the response', () => {
    expect(UrlResolverService.parseUserResponse('/users', 'no url here').error).toBeDefined();
  });
});

describe('UrlResolverService.generateMissingInfoPrompt', () => {
  it('returns a message and the base_url/auth/headers questions', () => {
    const out = UrlResolverService.generateMissingInfoPrompt('/users', 'GET', ['https://api.example.com']);
    expect(out.message).toContain('/users');
    const ids = out.questions.map((q) => q.id);
    expect(ids).toEqual(['base_url', 'auth_token', 'additional_headers']);
    expect(out.questions[0]).toMatchObject({ required: true, suggestions: ['https://api.example.com'] });
  });
});
