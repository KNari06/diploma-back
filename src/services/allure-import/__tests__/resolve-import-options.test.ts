/**
 * Tests for resolveImportOptions — specifically the `platform` field added so
 * imports respect the user-selected target platform instead of hardcoding web.
 *
 * The platform arrives as an unvalidated multipart string, so the resolver
 * must accept the four known values, reject anything else, and never throw.
 */

import { resolveImportOptions } from '../allure-import.types';

describe('resolveImportOptions — platform', () => {
  it('defaults to web when platform is omitted', () => {
    expect(resolveImportOptions({}).platform).toBe('web');
    expect(resolveImportOptions().platform).toBe('web');
  });

  it.each(['web', 'mobile_android', 'mobile_ios', 'mobile_flutter'] as const)(
    'passes through the valid platform %s',
    (platform) => {
      expect(resolveImportOptions({ platform }).platform).toBe(platform);
    },
  );

  it('falls back to web for an unrecognised platform string', () => {
    // Stale client / typo / future enum value the backend doesn't know yet.
    expect(resolveImportOptions({ platform: 'android' as never }).platform).toBe('web');
    expect(resolveImportOptions({ platform: 'mobile' as never }).platform).toBe('web');
    expect(resolveImportOptions({ platform: '' as never }).platform).toBe('web');
  });

  it('falls back to web for non-string platform values', () => {
    expect(resolveImportOptions({ platform: undefined }).platform).toBe('web');
    expect(resolveImportOptions({ platform: 42 as never }).platform).toBe('web');
    expect(resolveImportOptions({ platform: null as never }).platform).toBe('web');
  });

  it('leaves the other resolved options at their defaults', () => {
    const resolved = resolveImportOptions({ platform: 'mobile_ios' });
    expect(resolved).toMatchObject({
      importTestCases: true,
      autoCreateModules: true,
      autoCreateFlows: true,
      deduplicateTests: true,
      saveDocsToKB: true,
      defaultStartUrl: null,
      platform: 'mobile_ios',
    });
  });
});
