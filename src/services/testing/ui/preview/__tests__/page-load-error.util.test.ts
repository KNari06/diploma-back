/**
 * Tests for detectPageLoadError — the single source of truth for
 * "is this URL a browser load-failure page?" Pure function, fast tests.
 *
 * Covers the documented contract:
 *   - matches: chrome-error://chromewebdata/, chrome-error://* paths,
 *     data:text/html,chromewebdata (exact + with trailing fragment)
 *   - rejects: about:blank, http(s) URLs, legitimate data:* URLs,
 *     unrelated chrome-* schemes (e.g. chrome-extension://, chrome://),
 *     empty / null / undefined inputs
 */

import { detectPageLoadError } from '../page-load-error.util';

describe('detectPageLoadError', () => {
  describe('matches Chrome load-failure schemes', () => {
    it('canonical chrome-error://chromewebdata/', () => {
      const r = detectPageLoadError('chrome-error://chromewebdata/');
      expect(r.isLoadError).toBe(true);
      expect(r.url).toBe('chrome-error://chromewebdata/');
      expect(r.message.length).toBeGreaterThan(20);
    });

    it('chrome-error://* with any path', () => {
      expect(detectPageLoadError('chrome-error://').isLoadError).toBe(true);
      expect(detectPageLoadError('chrome-error://other/path').isLoadError).toBe(true);
    });

    it('data:text/html,chromewebdata exact sentinel', () => {
      expect(detectPageLoadError('data:text/html,chromewebdata').isLoadError).toBe(true);
    });

    it('data:text/html,chromewebdata with trailing fragment / query', () => {
      expect(detectPageLoadError('data:text/html,chromewebdata#fail').isLoadError).toBe(true);
      expect(detectPageLoadError('data:text/html,chromewebdata?x=1').isLoadError).toBe(true);
    });
  });

  describe('rejects unrelated schemes', () => {
    it('http / https sites', () => {
      expect(detectPageLoadError('https://bi.group/').isLoadError).toBe(false);
      expect(detectPageLoadError('http://example.com/path').isLoadError).toBe(false);
    });

    it('about:blank (transitional, not an error)', () => {
      expect(detectPageLoadError('about:blank').isLoadError).toBe(false);
    });

    it('legitimate data: URLs that are NOT the chromewebdata sentinel', () => {
      expect(detectPageLoadError('data:text/html,<h1>hi</h1>').isLoadError).toBe(false);
      expect(detectPageLoadError('data:image/png;base64,iVBORw0KGgo=').isLoadError).toBe(false);
    });

    it('data: URL whose body starts with chromewebdata but has extra chars (false-positive guard)', () => {
      // Regression: previous implementation used startsWith() which
      // matched 'data:text/html,chromewebdataExtra'. The exact-sentinel
      // regex now rejects it.
      expect(detectPageLoadError('data:text/html,chromewebdataExtra').isLoadError).toBe(false);
      expect(detectPageLoadError('data:text/html,chromewebdatahello').isLoadError).toBe(false);
    });

    it('chrome-extension:// is NOT a load error', () => {
      expect(detectPageLoadError('chrome-extension://abcdef/popup.html').isLoadError).toBe(false);
    });

    it('chrome:// (settings, version, etc.) is NOT a load error', () => {
      expect(detectPageLoadError('chrome://settings').isLoadError).toBe(false);
      expect(detectPageLoadError('chrome://version').isLoadError).toBe(false);
    });
  });

  describe('edge inputs', () => {
    it('empty string', () => {
      const r = detectPageLoadError('');
      expect(r.isLoadError).toBe(false);
      expect(r.url).toBe('');
    });

    it('null', () => {
      const r = detectPageLoadError(null);
      expect(r.isLoadError).toBe(false);
      expect(r.url).toBe('');
    });

    it('undefined', () => {
      const r = detectPageLoadError(undefined);
      expect(r.isLoadError).toBe(false);
      expect(r.url).toBe('');
    });

    it('non-string defensively returns false (runtime contract guard)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detectPageLoadError(123 as any).isLoadError).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detectPageLoadError({} as any).isLoadError).toBe(false);
    });
  });

  describe('message stability', () => {
    it('always returns the same message string for load-error cases', () => {
      // Don't tweak this without checking frontend copy / WS contract.
      const a = detectPageLoadError('chrome-error://chromewebdata/').message;
      const b = detectPageLoadError('data:text/html,chromewebdata').message;
      expect(a).toBe(b);
    });

    it('empty message for non-error URLs', () => {
      expect(detectPageLoadError('https://example.com').message).toBe('');
    });
  });
});
