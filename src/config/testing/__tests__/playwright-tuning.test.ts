import { BROWSER_EXTRA_HEADERS } from '../playwright-tuning';

/**
 * Guard for the CORS invariant: `BROWSER_EXTRA_HEADERS` is spread into Playwright
 * `extraHTTPHeaders`, which applies to EVERY request. A non-CORS-safelisted
 * header here forces a preflight on cross-origin XHR and can break the app under
 * test (documentolog incident). Keep the list to CORS-safelisted headers only.
 */
describe('BROWSER_EXTRA_HEADERS', () => {
  const keys = Object.keys(BROWSER_EXTRA_HEADERS).map((k) => k.toLowerCase());

  it('contains only CORS-safelisted request headers', () => {
    const SAFELISTED = new Set(['accept', 'accept-language', 'content-language']);
    for (const key of keys) {
      expect(SAFELISTED.has(key)).toBe(true);
    }
  });

  it('does not inject preflight-triggering / navigation-only headers', () => {
    const FORBIDDEN = [
      'cache-control',
      'pragma',
      'upgrade-insecure-requests',
      'connection',
      'accept-encoding',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user',
    ];
    for (const bad of FORBIDDEN) {
      expect(keys).not.toContain(bad);
    }
  });
});
