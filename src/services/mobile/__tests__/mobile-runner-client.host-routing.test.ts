/**
 * Host-lane runner routing (ADR-0019 deferred half): MOBILE_RUNNER_IOS_URL
 * selection + SSRF allowlist seeding from BOTH runner URLs.
 */

jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_RUNNER_URL: 'http://localhost:4100',
    MOBILE_RUNNER_IOS_URL: '',
    MOBILE_RUNNER_API_KEY: '',
    MOBILE_RUNNER_ALLOWED_HOSTS: '',
    GEMINI_API_KEY: '',
  },
}));

import { MobileRunnerClient, resolveRunnerUrlForHost } from '../mobile-runner-client';

const { env } = jest.requireMock('@/config/environment/env');

afterEach(() => {
  env.MOBILE_RUNNER_URL = 'http://localhost:4100';
  env.MOBILE_RUNNER_IOS_URL = '';
});

describe('resolveRunnerUrlForHost', () => {
  it('returns the default runner when the iOS URL is unset (local dev — one runner, both pools)', () => {
    expect(resolveRunnerUrlForHost('ios')).toBe('http://localhost:4100');
    expect(resolveRunnerUrlForHost('android')).toBe('http://localhost:4100');
    expect(resolveRunnerUrlForHost(undefined)).toBe('http://localhost:4100');
  });

  it('routes ios to MOBILE_RUNNER_IOS_URL when configured; android stays on the default', () => {
    env.MOBILE_RUNNER_IOS_URL = 'https://ios-runner.qait.dev';
    expect(resolveRunnerUrlForHost('ios')).toBe('https://ios-runner.qait.dev');
    expect(resolveRunnerUrlForHost('android')).toBe('http://localhost:4100');
    expect(resolveRunnerUrlForHost(undefined)).toBe('http://localhost:4100');
  });
});

describe('SSRF allowlist seeds from BOTH runner URLs', () => {
  it('constructing a client for the distinct iOS host does not throw (host is a trust anchor)', () => {
    env.MOBILE_RUNNER_IOS_URL = 'https://ios-runner.qait.dev';
    expect(() => new MobileRunnerClient({ baseUrl: 'https://ios-runner.qait.dev' })).not.toThrow();
  });

  it('a non-anchored host still throws at construct time', () => {
    expect(() => new MobileRunnerClient({ baseUrl: 'https://evil.example.com' })).toThrow(/refusing to construct/);
  });
});
