/**
 * Unit tests for the screenshot origin pin.
 *
 * The env module is stubbed rather than read from the environment: these
 * assertions are about the comparison, and under jest `SUPABASE_URL` is unset
 * (see .claude/deferred/20260726-jest-suites-fail-without-env.md), which would
 * make the positive case untestable.
 */

jest.mock('@/config/environment/env', () => ({
  env: { SUPABASE_URL: 'https://hzfcvwqjvdmynpqyjhls.supabase.co' },
}));

import { __testing } from '../screenshot-inline';

const { isOwnStorageUrl } = __testing;

describe('isOwnStorageUrl', () => {
  it('accepts an artefact on our own storage host', () => {
    expect(
      isOwnStorageUrl(
        'https://hzfcvwqjvdmynpqyjhls.supabase.co/storage/v1/object/public/qai-assets/u/step-screenshots/t/step-1.webp',
      ),
    ).toBe(true);
  });

  it('refuses a URL on any other host', () => {
    // `uploadMobileStepScreenshots` leaves a runner-supplied http(s) value
    // untouched, so these strings can reach us from a remote runner. Fetching
    // one would make the backend the runner's HTTP client, against its own
    // network, with the response shipped to a third-party model.
    expect(isOwnStorageUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isOwnStorageUrl('http://localhost:6379/')).toBe(false);
    expect(isOwnStorageUrl('https://evil.example.com/pixel.png')).toBe(false);
  });

  it('refuses a look-alike host', () => {
    expect(isOwnStorageUrl('https://hzfcvwqjvdmynpqyjhls.supabase.co.evil.com/x.webp')).toBe(false);
  });

  it('refuses anything that is not an http(s) URL', () => {
    expect(isOwnStorageUrl('file:///etc/passwd')).toBe(false);
    expect(isOwnStorageUrl('not a url')).toBe(false);
    expect(isOwnStorageUrl(undefined)).toBe(false);
  });
});
