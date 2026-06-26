import { requireDocsAuth, docsLogin, docsLogout } from '../docs-auth.middleware';

const PW = 'secret123';

function mockRes(): any {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
    cookie: jest.fn(),
    setHeader: jest.fn(),
    redirect: jest.fn(),
  };
}
const mockReq = (over: any = {}): any => ({ headers: {}, query: {}, body: {}, ip: '1.1.1.1', ...over });

beforeEach(() => {
  process.env.DOCS_PASSWORD = PW;
});
afterEach(() => {
  delete process.env.DOCS_PASSWORD;
});

describe('requireDocsAuth', () => {
  it('passes through when authenticated via session', () => {
    const next = jest.fn();
    requireDocsAuth(mockReq({ session: { docsAuthenticated: true } }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('passes through when the auth cookie is present', () => {
    const next = jest.fn();
    requireDocsAuth(mockReq({ headers: { cookie: 'foo=1; docs_authenticated=true' } }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('accepts the correct password from query or body (whitespace tolerant) and sets a cookie', () => {
    const res = mockRes();
    const next = jest.fn();
    requireDocsAuth(mockReq({ query: { password: `  ${PW}  ` } }), res, next);
    expect(res.cookie).toHaveBeenCalledWith('docs_authenticated', 'true', expect.objectContaining({ httpOnly: true }));
    expect(next).toHaveBeenCalled();

    const next2 = jest.fn();
    requireDocsAuth(mockReq({ body: { password: PW } }), mockRes(), next2);
    expect(next2).toHaveBeenCalled();
  });

  it('returns 401 JSON for an API request with a wrong password', () => {
    const res = mockRes();
    const next = jest.fn();
    requireDocsAuth(mockReq({ headers: { accept: 'application/json' }, query: { password: 'nope' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(next).not.toHaveBeenCalled();
  });

  it('renders the 401 login page for a browser request without a password', () => {
    const res = mockRes();
    requireDocsAuth(mockReq({ headers: { accept: 'text/html' }, originalUrl: '/api/features/x' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalled();
    expect(res.send.mock.calls[0][0]).toContain('/api/features/x');
  });

  it('blocks an open-redirect / XSS attempt in the requested path (falls back to a safe path)', () => {
    const res = mockRes();
    requireDocsAuth(mockReq({ headers: { accept: 'text/html' }, originalUrl: '/api/evil"><script>' }), res, jest.fn());
    const html = res.send.mock.calls[0][0];
    // The disallowed path is dropped entirely (validateRedirectPath → null → safe fallback),
    // so neither the attacker path nor its injected markup is reflected into the page.
    expect(html).not.toContain('/api/evil');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('/api/features');
  });
});

describe('docsLogin', () => {
  it('grants access on the correct password: sets cookie header and redirects', () => {
    const res = mockRes();
    docsLogin(mockReq({ body: { password: PW, redirect: '/api/architecture/overview' } }), res);
    const cookie = res.setHeader.mock.calls[0];
    expect(cookie[0]).toBe('Set-Cookie');
    expect(cookie[1]).toContain('docs_authenticated=true');
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/api/architecture/overview'));
  });

  it('redirects to an error path on a wrong password', () => {
    const res = mockRes();
    docsLogin(mockReq({ body: { password: 'wrong', redirect: '/api/features' } }), res);
    expect(res.redirect).toHaveBeenCalledWith('/api/features?error=invalid');
  });

  it('redirects to error when no password is provided', () => {
    const res = mockRes();
    docsLogin(mockReq({ body: {} }), res);
    expect(res.redirect).toHaveBeenCalledWith('/api/features?error=invalid');
  });

  it('sanitizes a malicious redirect to the safe fallback', () => {
    const res = mockRes();
    docsLogin(mockReq({ body: { password: PW, redirect: 'https://evil.com/steal' } }), res);
    const target = res.redirect.mock.calls[0][0];
    expect(target).not.toContain('evil.com');
    expect(target).toContain('/api/features');
  });
});

describe('docsLogout', () => {
  it('clears the session flag and redirects to a validated path', () => {
    const res = mockRes();
    const session: any = { docsAuthenticated: true };
    docsLogout(mockReq({ session, query: { redirect: '/api/architecture' } }), res);
    expect(session.docsAuthenticated).toBeUndefined();
    expect(res.redirect).toHaveBeenCalledWith('/api/architecture');
  });

  it('falls back to a safe path for a disallowed redirect', () => {
    const res = mockRes();
    docsLogout(mockReq({ query: { redirect: '//evil.com' } }), res);
    expect(res.redirect).toHaveBeenCalledWith('/api/features');
  });
});
