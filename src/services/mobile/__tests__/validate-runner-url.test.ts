import {
  validateRunnerUrl,
  parseAllowedHosts,
} from '../validate-runner-url';

describe('parseAllowedHosts', () => {
  it('returns empty set for empty / undefined', () => {
    expect(parseAllowedHosts(undefined).size).toBe(0);
    expect(parseAllowedHosts('').size).toBe(0);
  });

  it('parses CSV, lowercases, trims whitespace', () => {
    const set = parseAllowedHosts(' Runner.Example.COM , 10.0.5.20 ');
    expect(set.has('runner.example.com')).toBe(true);
    expect(set.has('10.0.5.20')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('drops empty entries from extra commas', () => {
    const set = parseAllowedHosts('a.com,,b.com,');
    expect(set.size).toBe(2);
  });
});

describe('validateRunnerUrl — legacy mode (no allowlist)', () => {
  const noAllow = new Set<string>();

  it('accepts an external https URL', () => {
    const r = validateRunnerUrl('https://runner.example.com:4100', noAllow);
    expect(r.ok).toBe(true);
  });

  it('rejects loopback when allowlist is empty', () => {
    const r = validateRunnerUrl('http://localhost:4100', noAllow);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('internal_address');
  });

  it('rejects 127.0.0.1', () => {
    const r = validateRunnerUrl('http://127.0.0.1:4100', noAllow);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('internal_address');
  });

  it('rejects RFC1918 class A (10/8)', () => {
    expect(validateRunnerUrl('http://10.0.5.20', noAllow).ok).toBe(false);
  });

  it('rejects RFC1918 class B middle (172.20.x.x)', () => {
    expect(validateRunnerUrl('http://172.20.1.1', noAllow).ok).toBe(false);
  });

  it('accepts 172.x.x.x OUTSIDE the 172.16-31 range (e.g. 172.15)', () => {
    // 172.15.x.x is technically public — RFC1918 class B is 172.16.0.0/12.
    expect(validateRunnerUrl('http://172.15.1.1', noAllow).ok).toBe(true);
    expect(validateRunnerUrl('http://172.32.1.1', noAllow).ok).toBe(true);
  });

  it('rejects 192.168.x.x', () => {
    expect(validateRunnerUrl('http://192.168.1.1', noAllow).ok).toBe(false);
  });

  it('rejects link-local 169.254.169.254 (AWS/GCP metadata)', () => {
    // Critical — this is the cloud metadata service that token-leaking
    // SSRF attacks target most often.
    const r = validateRunnerUrl('http://169.254.169.254/latest/meta-data/', noAllow);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('internal_address');
  });

  it('rejects IPv6 loopback', () => {
    expect(validateRunnerUrl('http://[::1]:4100', noAllow).ok).toBe(false);
  });
});

describe('validateRunnerUrl — explicit allowlist', () => {
  const allow = new Set(['runner.example.com', '10.0.5.20']);

  it('accepts hostname on the allowlist', () => {
    expect(validateRunnerUrl('http://runner.example.com:4100', allow).ok).toBe(true);
  });

  it('case-insensitive hostname match', () => {
    expect(validateRunnerUrl('http://RUNNER.example.COM:4100', allow).ok).toBe(true);
  });

  it('accepts internal address WHEN explicitly allowlisted (VPC deployments)', () => {
    // Operator's deliberate choice — they put 10.0.5.20 in the
    // allowlist meaning "yes, this is my runner, please reach it".
    expect(validateRunnerUrl('http://10.0.5.20:4100', allow).ok).toBe(true);
  });

  it('rejects a hostname NOT on the allowlist', () => {
    const r = validateRunnerUrl('http://attacker.example.com:4100', allow);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('host_not_allowed');
  });

  it('rejects a non-allowlisted internal address even with non-empty allowlist', () => {
    // 169.254.169.254 not in allowlist → host_not_allowed (allowlist check
    // runs first; we don't need to fall through to internal-address).
    const r = validateRunnerUrl('http://169.254.169.254', allow);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('host_not_allowed');
  });
});

describe('validateRunnerUrl — scheme + parse errors', () => {
  it('rejects file:// scheme', () => {
    const r = validateRunnerUrl('file:///etc/passwd', new Set());
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('scheme_not_http');
  });

  it('rejects ftp:// scheme', () => {
    expect(validateRunnerUrl('ftp://runner.example.com', new Set()).ok).toBe(false);
  });

  it('rejects javascript: URI', () => {
    const r = validateRunnerUrl('javascript:alert(1)', new Set());
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('scheme_not_http');
  });

  it('rejects un-parseable garbage', () => {
    expect(validateRunnerUrl('not a url', new Set()).ok).toBe(false);
    expect(validateRunnerUrl('', new Set()).ok).toBe(false);
  });
});

describe('validateRunnerUrl — return shape', () => {
  it('returns normalised URL on success (URL.toString form)', () => {
    const r = validateRunnerUrl('https://runner.example.com:4100/api', new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      // URL normalises path; expect at minimum that hostname survives
      expect(r.normalised).toContain('runner.example.com');
    }
  });

  it('reject detail field is human-readable', () => {
    const r = validateRunnerUrl('http://127.0.0.1', new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(typeof r.detail).toBe('string');
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});
