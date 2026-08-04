import axios from 'axios';
import { lookup } from 'dns/promises';
import { preflightEntryUrl } from '../entry-preflight.service';

jest.mock('axios');
jest.mock('dns/promises');

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;
const mockedLookup = lookup as jest.MockedFunction<any>;

/** Minimal axios-shaped response. */
const httpResponse = (status: number, body = '', finalUrl?: string) => ({
  status,
  data: body,
  headers: {},
  request: finalUrl ? { res: { responseUrl: finalUrl } } : undefined,
});

/** A 3xx with a Location header — redirects are followed manually now. */
const redirect = (location: string, status = 302) => ({
  status,
  data: '',
  headers: { location },
});

/** An axios/Node transport error carrying a `code`. */
const transportError = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('preflightEntryUrl', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    // Default: hostname resolves to a public address.
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns reachable for a healthy 200', async () => {
    mockedGet.mockResolvedValue(httpResponse(200, '<html><body>Welcome</body></html>'));

    const result = await preflightEntryUrl('https://acme.com/');

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('reachable');
    expect(result.status).toBe(200);
  });

  // ── The security boundary: isBlockedSsrfHostname does NOT resolve DNS ──
  it('blocks a public hostname that resolves to a private address', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    const result = await preflightEntryUrl('https://evil.example.com/');

    expect(result.ok).toBe(false);
    expect(result.verdict).toBe('ssrf_blocked');
    // Must not even attempt the request.
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('blocks when any resolved address is private, not just the first', async () => {
    mockedLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);

    const result = await preflightEntryUrl('https://rebind.example.com/');

    expect(result.verdict).toBe('ssrf_blocked');
  });

  it('skips the DNS SSRF check in development so localhost works', async () => {
    process.env.NODE_ENV = 'development';
    mockedGet.mockResolvedValue(httpResponse(200, 'dev app'));

    const result = await preflightEntryUrl('http://localhost:3000/');

    expect(result.ok).toBe(true);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  // ── The typo case that used to cost 10 credits ──
  it('reports dns_failure when the host does not resolve', async () => {
    mockedLookup.mockRejectedValue(transportError('ENOTFOUND'));

    const result = await preflightEntryUrl('https://gogle/');

    expect(result.ok).toBe(false);
    expect(result.verdict).toBe('dns_failure');
    expect(result.message).toMatch(/typo/i);
  });

  it('falls through to the HTTP probe when the resolver errors for another reason', async () => {
    mockedLookup.mockRejectedValue(transportError('ESERVFAIL'));
    mockedGet.mockResolvedValue(httpResponse(200, 'ok'));

    const result = await preflightEntryUrl('https://acme.com/');

    expect(result.ok).toBe(true);
    expect(mockedGet).toHaveBeenCalled();
  });

  describe('transport failures', () => {
    it.each([
      ['ECONNREFUSED', 'connection_refused'],
      ['ECONNRESET', 'connection_refused'],
      ['EHOSTUNREACH', 'connection_refused'],
      ['ETIMEDOUT', 'timeout'],
      ['ECONNABORTED', 'timeout'],
      ['ENOTFOUND', 'dns_failure'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'],
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_error'],
      ['EPROTO', 'tls_error'],
    ])('classifies %s as %s', async (code, expected) => {
      mockedGet.mockRejectedValue(transportError(code));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.verdict).toBe(expected);
      expect(result.ok).toBe(false);
    });

    it('fails OPEN on an unclassifiable error so our probe never blocks a real run', async () => {
      mockedGet.mockRejectedValue(new Error('something weird'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.ok).toBe(true);
      expect(result.verdict).toBe('reachable');
    });
  });

  describe('HTTP status classification', () => {
    it('treats 401 as auth_required, not a broken site', async () => {
      mockedGet.mockResolvedValue(httpResponse(401, 'Unauthorized'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.verdict).toBe('auth_required');
      expect(result.message).toMatch(/credentials/i);
    });

    it('treats 403 as auth_required', async () => {
      mockedGet.mockResolvedValue(httpResponse(403, 'Forbidden'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('auth_required');
    });

    it('treats 500 as http_error', async () => {
      mockedGet.mockResolvedValue(httpResponse(500, 'oops'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('http_error');
    });

    it('treats 404 as http_error', async () => {
      mockedGet.mockResolvedValue(httpResponse(404, 'Not found'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('http_error');
    });
  });

  describe('bot challenge detection', () => {
    it('detects a Cloudflare interstitial served with 200', async () => {
      mockedGet.mockResolvedValue(
        httpResponse(200, '<html><title>Just a moment...</title><div id="cf-browser-verification">'),
      );

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.verdict).toBe('bot_challenge');
      expect(result.ok).toBe(false);
    });

    it('detects "Checking your browser" regardless of case', async () => {
      mockedGet.mockResolvedValue(httpResponse(200, 'CHECKING YOUR BROWSER before access'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('bot_challenge');
    });

    it('does not flag a normal page that merely mentions a moment', async () => {
      mockedGet.mockResolvedValue(httpResponse(200, '<h1>Book an appointment in a moment</h1>'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('reachable');
    });
  });

  // ── SSRF via redirect ──
  // The original implementation used axios `maxRedirects: 5`, so the DNS
  // resolve-then-check applied ONLY to the first hop: a public host could 302 to
  // http://169.254.169.254/ and the metadata body came back (verified live
  // against loopback servers before this guard existed). Redirects are now
  // followed manually with every hop re-validated.
  describe('SSRF via redirect', () => {
    it('blocks a redirect to a literal cloud-metadata address', async () => {
      mockedGet.mockResolvedValueOnce(redirect('http://169.254.169.254/latest/meta-data'));

      const result = await preflightEntryUrl('https://attacker.example.com/');

      expect(result.verdict).toBe('ssrf_blocked');
      expect(result.ok).toBe(false);
      // Exactly one request: the redirect target was never fetched.
      expect(mockedGet).toHaveBeenCalledTimes(1);
    });

    it('blocks a redirect to a private RFC1918 address', async () => {
      mockedGet.mockResolvedValueOnce(redirect('http://10.0.0.5/admin'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('ssrf_blocked');
      expect(mockedGet).toHaveBeenCalledTimes(1);
    });

    it('blocks a redirect to a public host that RESOLVES to a private address', async () => {
      mockedGet.mockResolvedValueOnce(redirect('https://rebind.example.com/'));
      // First lookup (entry host) public, second (hop) private.
      mockedLookup
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('ssrf_blocked');
    });

    it('blocks a redirect to a non-http scheme', async () => {
      mockedGet.mockResolvedValueOnce(redirect('file:///etc/passwd'));
      expect((await preflightEntryUrl('https://acme.com/')).verdict).toBe('ssrf_blocked');
    });

    it('resolves a RELATIVE Location against the current url and keeps probing', async () => {
      mockedGet
        .mockResolvedValueOnce(redirect('/app/dashboard'))
        .mockResolvedValueOnce(httpResponse(200, 'the app'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.ok).toBe(true);
      expect(mockedGet).toHaveBeenLastCalledWith('https://acme.com/app/dashboard', expect.anything());
    });

    it('follows a legitimate cross-origin redirect and reports it', async () => {
      mockedGet
        .mockResolvedValueOnce(redirect('https://acme.io/welcome'))
        .mockResolvedValueOnce(httpResponse(200, 'marketing'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.ok).toBe(true);
      expect(result.redirectedOffOrigin).toBe(true);
      expect(result.finalUrl).toBe('https://acme.io/welcome');
    });

    it('gives up on a redirect loop instead of hanging', async () => {
      mockedGet.mockResolvedValue(redirect('https://acme.com/loop'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.ok).toBe(false);
      expect(result.verdict).toBe('http_error');
      // Bounded by MAX_REDIRECT_HOPS (5) + the initial request.
      expect(mockedGet.mock.calls.length).toBeLessThanOrEqual(6);
    });
  });

  describe('redirect reporting', () => {
    it('does not flag a same-origin redirect', async () => {
      mockedGet
        .mockResolvedValueOnce(redirect('https://acme.com/dashboard'))
        .mockResolvedValueOnce(httpResponse(200, 'app'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.redirectedOffOrigin).toBe(false);
      expect(result.ok).toBe(true);
    });

    it('does not flag anything when there was no redirect', async () => {
      mockedGet.mockResolvedValue(httpResponse(200, 'app'));

      const result = await preflightEntryUrl('https://acme.com/');

      expect(result.redirectedOffOrigin).toBe(false);
    });
  });

  it('never throws on an unparseable url', async () => {
    const result = await preflightEntryUrl('::::');
    expect(result.ok).toBe(false);
  });
});
