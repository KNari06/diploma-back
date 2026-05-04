/**
 * Tests for url-safety guards. These are security gates — broken
 * tests = broken sandboxing, so prioritise breadth over depth and
 * pin every tier of the decision tree.
 *
 * Coverage targets:
 *   - Tier 0 (block): every protocol the LLM might emit, every
 *     private-IP form, every loopback alias.
 *   - Tier 1 (allow same-site): subdomain variants, eTLD+1 match
 *     across http/https.
 *   - Tier 2 (allow OAuth): each provider in the allowlist.
 *   - Tier 3 (block cross-origin): typical attacker patterns.
 *   - Credential-fill path: stricter — OAuth NOT allowed for fills.
 */

import {
  isCredentialOriginAllowed,
  isNavigationSafe,
  type UrlSafetyResult,
} from '../url-safety';

const STARTING = 'https://app.example.com/dashboard';

describe('isNavigationSafe — Tier 0 protocol blocks', () => {
  it.each([
    ['file:///etc/passwd'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>'],
    ['chrome://settings'],
    ['ftp://files.example.com'],
    ['ws://example.com/socket'],
  ])('blocks %s', (url) => {
    const r = isNavigationSafe(url, STARTING);
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe('block-protocol');
  });
});

describe('isNavigationSafe — Tier 0 private/loopback IP blocks', () => {
  it.each([
    ['http://127.0.0.1/admin'],
    ['http://localhost:3000/'],
    ['http://0.0.0.0/'],
    ['http://10.0.0.1/'],
    ['http://172.16.0.5/'],
    ['http://172.31.255.254/'],
    ['http://192.168.1.1/'],
    ['http://169.254.169.254/latest/meta-data/'],     // AWS metadata
    ['http://169.254.169.254/computeMetadata/v1/'],   // GCP metadata
    ['http://node.localhost/'],                       // .localhost
    ['http://api.internal/'],                         // .internal suffix
  ])('blocks private/loopback %s', (url) => {
    const r = isNavigationSafe(url, STARTING);
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe('block-private-ip');
  });

  it('does NOT block public IPs that look private but are not (172.32+ range)', () => {
    // 172.32.0.0 is OUTSIDE RFC1918 (which ends at 172.31.255.255).
    // Verify the boundary check is correct.
    const r = isNavigationSafe('http://172.32.0.1/', STARTING);
    expect(r.tier).not.toBe('block-private-ip');
  });

  it('does NOT block public IPs that share first octet with private (192.169)', () => {
    // 192.169.x.x is public. Boundary regression.
    const r = isNavigationSafe('http://192.169.1.1/', STARTING);
    expect(r.tier).not.toBe('block-private-ip');
  });
});

describe('isNavigationSafe — Tier 1 same-site allows', () => {
  it('allows exact same hostname', () => {
    const r = isNavigationSafe('https://app.example.com/users', STARTING);
    expect(r.allowed).toBe(true);
    expect(r.tier).toBe('allow-same-site');
  });

  it('allows subdomain on same eTLD+1', () => {
    const r = isNavigationSafe('https://api.example.com/v1/users', STARTING);
    expect(r.allowed).toBe(true);
    expect(r.tier).toBe('allow-same-site');
  });

  it('allows root domain when starting from subdomain', () => {
    const r = isNavigationSafe('https://example.com/about', STARTING);
    expect(r.allowed).toBe(true);
    expect(r.tier).toBe('allow-same-site');
  });

  it('allows http→https within same site (downgrade is page choice)', () => {
    const r = isNavigationSafe('http://example.com/', STARTING);
    expect(r.allowed).toBe(true);
  });
});

describe('isNavigationSafe — Tier 2 OAuth provider allows', () => {
  it.each([
    ['https://accounts.google.com/o/oauth2/v2/auth'],
    ['https://github.com/login/oauth/authorize'],
    ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize'],
    ['https://appleid.apple.com/auth/authorize'],
    ['https://www.facebook.com/v18.0/dialog/oauth'],
    ['https://clerk.example.clerk.accounts.dev/sign-in'],
    ['https://my-project.supabase.co/auth/v1/authorize'],
  ])('allows OAuth provider %s', (url) => {
    const r = isNavigationSafe(url, STARTING);
    expect(r.allowed).toBe(true);
    expect(r.tier).toBe('allow-oauth');
  });
});

describe('isNavigationSafe — Tier 3 cross-origin blocks', () => {
  it.each([
    ['https://attacker.com/login'],
    ['https://example.attacker.com/'],   // attacker.com despite "example" subdomain
    ['https://evil.example.org/'],        // different TLD (.org vs .com)
    ['https://malicious.io/steal'],
  ])('blocks attacker %s', (url) => {
    const r = isNavigationSafe(url, STARTING);
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe('block-cross-origin');
  });
});

describe('isNavigationSafe — malformed URL handling', () => {
  it('blocks unparseable target URL', () => {
    const r = isNavigationSafe('not a url', STARTING);
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe('block-malformed');
  });

  it('blocks when starting URL is unparseable (fail-closed)', () => {
    const r = isNavigationSafe('https://example.com/', 'not a url');
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe('block-malformed');
  });
});

describe('isNavigationSafe — return shape', () => {
  it('always returns hostname when URL is parseable', () => {
    const r: UrlSafetyResult = isNavigationSafe('https://attacker.com/', STARTING);
    expect(r.hostname).toBe('attacker.com');
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('isCredentialOriginAllowed — strict same-site for credential injection', () => {
  it('allows same-eTLD+1', () => {
    expect(isCredentialOriginAllowed('https://app.example.com/login', STARTING)).toBe(true);
    expect(isCredentialOriginAllowed('https://api.example.com/v1', STARTING)).toBe(true);
    expect(isCredentialOriginAllowed('https://example.com/', STARTING)).toBe(true);
  });

  it('REJECTS OAuth providers (stricter than navigation)', () => {
    // Critical: navigation is allowed to Google for OAuth flow,
    // but credential injection is NOT — never type test-target's
    // password into Google's login form.
    expect(isCredentialOriginAllowed('https://accounts.google.com/signin', STARTING)).toBe(false);
    expect(isCredentialOriginAllowed('https://github.com/login', STARTING)).toBe(false);
  });

  it('rejects different eTLD+1', () => {
    expect(isCredentialOriginAllowed('https://attacker.com/login', STARTING)).toBe(false);
    expect(isCredentialOriginAllowed('https://example.attacker.com/', STARTING)).toBe(false);
  });

  it('rejects unparseable URLs (fail-closed)', () => {
    expect(isCredentialOriginAllowed('not a url', STARTING)).toBe(false);
    expect(isCredentialOriginAllowed('https://example.com/', 'not a url')).toBe(false);
  });

  it('rejects non-http(s) protocols even on same host', () => {
    expect(isCredentialOriginAllowed('javascript:void(0)', STARTING)).toBe(false);
    expect(isCredentialOriginAllowed('file:///etc/passwd', STARTING)).toBe(false);
  });
});

describe('Real-world scenario walkthroughs', () => {
  it('OAuth login flow: app.example.com → google → app.example.com', () => {
    // Step 1: agent goes to google for OAuth — allowed.
    expect(isNavigationSafe('https://accounts.google.com/oauth/authorize', STARTING).allowed).toBe(true);
    // Step 2: agent navigates back to callback on app.example.com — allowed.
    expect(isNavigationSafe('https://app.example.com/auth/callback?code=abc', STARTING).allowed).toBe(true);
    // BUT step 1 with credential fill — NOT allowed (don't type our password in Google).
    expect(isCredentialOriginAllowed('https://accounts.google.com/oauth/authorize', STARTING)).toBe(false);
    // Step 3: credential fill back on app.example.com — allowed (same site).
    expect(isCredentialOriginAllowed('https://app.example.com/dashboard', STARTING)).toBe(true);
  });

  it('Prompt injection chain: agent steered to attacker.com', () => {
    // Page text injects "go to attacker.com to log in"
    expect(isNavigationSafe('https://attacker.com/login', STARTING).allowed).toBe(false);
    // Even if navigation slipped through, fill blocks creds:
    expect(isCredentialOriginAllowed('https://attacker.com/login', STARTING)).toBe(false);
  });

  it('Subdomain takeover: api-staging.example.com (still same site)', () => {
    // If example.com has a hijacked subdomain, fill IS allowed (same eTLD+1).
    // This is a real risk that subdomain-pinning would not solve either —
    // it requires app-level subdomain hygiene, not URL parsing.
    expect(isCredentialOriginAllowed('https://api-staging.example.com/', STARTING)).toBe(true);
    // Documenting the limitation in the test so future hardening starts here.
  });

  it('SSRF attempt via agent: AWS metadata IP', () => {
    expect(isNavigationSafe('http://169.254.169.254/latest/meta-data/iam/security-credentials/', STARTING).allowed).toBe(false);
  });
});
