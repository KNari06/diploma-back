/**
 * Shared SSRF host guard.
 *
 * Extracted from `entry-preflight.service.ts` when Phase 0's evidence collector
 * needed the identical check — it fetches ~8 URLs derived from the target site, a
 * much wider surface than one probe. Two copies of an SSRF guard is how one of
 * them silently falls behind, so this is the single implementation and these are
 * its tests.
 *
 * `isBlockedSsrfHostname` alone is a STRING check (its own docblock says it does
 * not resolve DNS), so `evil.example.com -> 10.0.0.5` passes it. Closing that gap
 * is the whole point of this module.
 */

jest.mock('dns/promises');

import { lookup } from 'dns/promises';
import { checkSsrfHost } from '../ssrf-host-guard';

const mockedLookup = lookup as jest.MockedFunction<any>;
const transportError = (code: string) => Object.assign(new Error(code), { code });

describe('checkSsrfHost', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('allows a normal public host', async () => {
    expect((await checkSsrfHost('acme.com', 'T')).verdict).toBe('allowed');
  });

  describe('the DNS-resolution gap this module exists to close', () => {
    it('blocks a public hostname that RESOLVES to a private address', async () => {
      mockedLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      expect((await checkSsrfHost('evil.example.com', 'T')).verdict).toBe('blocked');
    });

    it('blocks when ANY resolved address is private, not just the first', async () => {
      mockedLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
      expect((await checkSsrfHost('rebind.example.com', 'T')).verdict).toBe('blocked');
    });

    it('never leaks the resolved internal address in the user-facing message', async () => {
      mockedLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      const result = await checkSsrfHost('evil.example.com', 'T');
      expect(result.message).not.toContain('10.1.2.3');
    });
  });

  describe('literal hosts — caught without touching DNS', () => {
    it.each(['localhost', '127.0.0.1', '0.0.0.0', '10.0.0.5', '192.168.1.1', '169.254.169.254'])(
      'blocks %s',
      async (host) => {
        expect((await checkSsrfHost(host, 'T')).verdict).toBe('blocked');
        // No resolution needed — the string check is decisive.
        expect(mockedLookup).not.toHaveBeenCalled();
      },
    );
  });

  describe('resolver errors', () => {
    it.each(['ENOTFOUND', 'EAI_AGAIN'])('reports %s as dns_failure (the typo case)', async (code) => {
      mockedLookup.mockRejectedValue(transportError(code));
      const result = await checkSsrfHost('gogle', 'T');
      expect(result.verdict).toBe('dns_failure');
      expect(result.message).toMatch(/typo/i);
    });

    it('fails OPEN on an inconclusive resolver error', async () => {
      // A flaky resolver must not block a legitimate run; the caller's own HTTP
      // attempt is the backstop.
      mockedLookup.mockRejectedValue(transportError('ESERVFAIL'));
      expect((await checkSsrfHost('acme.com', 'T')).verdict).toBe('allowed');
    });

    it('never throws, whatever the resolver does', async () => {
      mockedLookup.mockRejectedValue('not even an Error');
      await expect(checkSsrfHost('acme.com', 'T')).resolves.toBeDefined();
    });
  });

  describe('local development carve-out', () => {
    it('skips the check entirely so devs can explore localhost apps', async () => {
      process.env.NODE_ENV = 'development';
      expect((await checkSsrfHost('localhost', 'T')).verdict).toBe('allowed');
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('still enforces in test/production', async () => {
      process.env.NODE_ENV = 'test';
      expect((await checkSsrfHost('localhost', 'T')).verdict).toBe('blocked');
    });
  });
});
