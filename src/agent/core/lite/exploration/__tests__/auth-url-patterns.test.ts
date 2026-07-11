import { isLoginUrl } from '../auth-url-patterns';

describe('isLoginUrl — path patterns', () => {
  it('matches common login/auth paths', () => {
    for (const u of [
      'https://app.test/login',
      'https://app.test/signin',
      'https://app.test/sign-in',
      'https://app.test/auth/callback',
      'https://app.test/sso',
    ]) {
      expect(isLoginUrl(u)).toBe(true);
    }
  });

  it('works on a bare pathname (survey inferPageType passes a path, not a URL)', () => {
    expect(isLoginUrl('/login')).toBe(true);
    expect(isLoginUrl('/dashboard')).toBe(false);
  });

  it('does not match ordinary app pages', () => {
    for (const u of [
      'https://app.test/',
      'https://app.test/ru/compare',
      'https://app.test/mortgage',
    ]) {
      expect(isLoginUrl(u)).toBe(false);
    }
  });
});

describe('isLoginUrl — auth host subdomains (path is just "/")', () => {
  it('matches a dedicated auth subdomain even with a non-auth path', () => {
    // The real bug: a flow redirected to account.bi.group/?backUrl=… was NOT
    // flagged as a login URL because the path is "/". Host-based check fixes it.
    expect(isLoginUrl('https://account.bi.group/?backUrl=https://bi.group/ru/compare')).toBe(true);
    expect(isLoginUrl('https://auth.example.com/')).toBe(true);
    expect(isLoginUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true);
    expect(isLoginUrl('https://id.example.com/')).toBe(true);
    expect(isLoginUrl('https://sso.example.com/')).toBe(true);
  });

  it('does NOT match a normal subdomain that merely contains the prefix mid-host', () => {
    // "myaccount.example.com" does NOT start with "account." → not auth.
    expect(isLoginUrl('https://myaccount-help.example.com/')).toBe(false);
    expect(isLoginUrl('https://content-sales.bi.group/x')).toBe(false);
  });
});
