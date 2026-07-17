import { CookieJar } from '../cookie-jar';

const URL_A = 'https://api.example.com/api/v1/admin/auth/login';
const URL_B = 'https://api.example.com/api/v1/users';

describe('CookieJar', () => {
  it('replays a session cookie captured from Set-Cookie on a later same-host request', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, ['sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax']);

    expect(jar.cookieHeaderFor(URL_B)).toBe('sid=abc123');
  });

  it('accepts the folded (comma-joined) Set-Cookie string as a fallback', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, 'sid=abc; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT, theme=dark; Path=/');

    const header = jar.cookieHeaderFor(URL_B);
    expect(header).toContain('sid=abc');
    expect(header).toContain('theme=dark');
  });

  it('sends multiple cookies joined by "; "', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, ['a=1; Path=/', 'b=2; Path=/']);

    const header = jar.cookieHeaderFor(URL_B) || '';
    expect(header.split('; ').sort()).toEqual(['a=1', 'b=2']);
  });

  it('does not leak cookies to a different host', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, ['sid=abc; Path=/']);

    expect(jar.cookieHeaderFor('https://other.test/api')).toBeUndefined();
  });

  it('honors the Domain attribute for subdomain requests', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://example.com/login', ['sid=abc; Domain=example.com; Path=/']);

    expect(jar.cookieHeaderFor('https://api.example.com/data')).toBe('sid=abc');
  });

  it('does NOT leak a host-only cookie (no Domain attr) to a subdomain', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://api.example.com/login', ['sid=abc; Path=/']);

    expect(jar.cookieHeaderFor('https://api.example.com/x')).toBe('sid=abc'); // exact host
    expect(jar.cookieHeaderFor('https://cdn.api.example.com/x')).toBeUndefined(); // subdomain
  });

  it('rejects a Set-Cookie whose Domain the responding host does not belong to', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://a.test.com/x', ['x=1; Domain=evil.com; Path=/']);

    expect(jar.cookieHeaderFor('https://evil.com/x')).toBeUndefined();
    expect(jar.size()).toBe(0);
  });

  it('preserves a cookie name containing a "|" character', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://api.example.com/x', ['a|b=secret; Path=/']);

    expect(jar.cookieHeaderFor('https://api.example.com/y')).toBe('a|b=secret');
  });

  it('scopes by path — a cookie set for /admin is not sent to /public', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://api.example.com/admin/login', ['sid=abc; Path=/admin']);

    expect(jar.cookieHeaderFor('https://api.example.com/admin/users')).toBe('sid=abc');
    expect(jar.cookieHeaderFor('https://api.example.com/public/list')).toBeUndefined();
  });

  it('deletes a cookie when re-set with Max-Age=0', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, ['sid=abc; Path=/']);
    jar.storeFromSetCookie(URL_A, ['sid=; Path=/; Max-Age=0']);

    expect(jar.cookieHeaderFor(URL_B)).toBeUndefined();
  });

  it('drops an already-expired cookie', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, ['sid=abc; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);

    expect(jar.cookieHeaderFor(URL_B)).toBeUndefined();
  });

  it('overwrites a cookie value when re-set on the same domain/path', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, ['sid=old; Path=/']);
    jar.storeFromSetCookie(URL_A, ['sid=new; Path=/']);

    expect(jar.cookieHeaderFor(URL_B)).toBe('sid=new');
  });

  it('ignores empty / malformed Set-Cookie input', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie(URL_A, undefined);
    jar.storeFromSetCookie(URL_A, ['', '   ', 'novalue']);

    expect(jar.cookieHeaderFor(URL_B)).toBeUndefined();
    expect(jar.size()).toBe(0);
  });
});
