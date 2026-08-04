/**
 * Phase 0 evidence collection.
 *
 * Runs against REAL loopback HTTP servers rather than a mocked axios. Earlier in
 * this feature a wholesale axios mock hid a genuine SSRF hole (the redirect path
 * was invisible by construction), so the security-relevant behaviour here is
 * exercised against live sockets.
 *
 * `NODE_ENV` is forced to `development` for the happy-path tests because the SSRF
 * guard blocks loopback everywhere else — that carve-out exists precisely so devs
 * can point the tooling at localhost. The block itself is covered in
 * `ssrf-host-guard.test.ts` and in the dedicated case below.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { collectProductEvidence, MAX_EVIDENCE_CHARS } from '../evidence-collector';

type Routes = Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;

function startServer(routes: Routes): Promise<{ origin: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = (req.url || '/').split('?')[0];
      const handler = routes[path];
      if (handler) return handler(req, res);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
    });
  });
}

const html = (body: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(body);
};

const text = (body: string, status = 200) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
};

const originalEnv = process.env.NODE_ENV;
beforeEach(() => { process.env.NODE_ENV = 'development'; });
afterEach(() => { process.env.NODE_ENV = originalEnv; });

describe('collectProductEvidence — what it gathers', () => {
  let server: { origin: string; close: () => void };

  afterEach(() => server?.close());

  it('records which targets succeeded and which 404d', async () => {
    server = await startServer({
      '/': html('<html lang="en"><h1>Acme Shop</h1></html>'),
      '/robots.txt': text('User-agent: *\nDisallow: /admin\nDisallow: /internal\n'),
      // no /pricing, /about, /docs, /login, /signup, /sitemap.xml
    });

    const ev = await collectProductEvidence(server.origin);

    expect(ev.sources).toEqual(expect.arrayContaining(['/', '/robots.txt']));
    expect(ev.sources).not.toContain('/pricing');
    // A 404 is a SIGNAL, not an error — it must be recorded, not dropped.
    const pricing = ev.documents.find((d) => d.path === '/pricing');
    expect(pricing).toMatchObject({ ok: false, status: 404, failure: 'not_found' });
  });

  it('parses robots.txt disallow paths', async () => {
    server = await startServer({
      '/': html('<html></html>'),
      '/robots.txt': text('User-agent: *\nDisallow: /admin\nDisallow: /careers\n# a comment\n'),
    });

    const ev = await collectProductEvidence(server.origin);

    expect(ev.disallowedPaths).toEqual(expect.arrayContaining(['/admin', '/careers']));
    expect(ev.robotsDisallowsAll).toBe(false);
  });

  it('detects a blanket Disallow: / — the internal-admin tell', async () => {
    server = await startServer({
      '/': html('<html></html>'),
      '/robots.txt': text('User-agent: *\nDisallow: /\n'),
    });

    const ev = await collectProductEvidence(server.origin);

    expect(ev.robotsDisallowsAll).toBe(true);
  });

  it('histograms sitemap path segments instead of pasting URLs', async () => {
    const urls = [
      ...Array.from({ length: 40 }, (_, i) => `<loc>http://x/products/${i}</loc>`),
      ...Array.from({ length: 5 }, (_, i) => `<loc>http://x/blog/${i}</loc>`),
      '<loc>http://x/cart</loc>',
    ].join('');
    server = await startServer({
      '/': html('<html></html>'),
      '/sitemap.xml': text(`<urlset>${urls}</urlset>`),
    });

    const ev = await collectProductEvidence(server.origin);

    expect(ev.sitemapUrlCount).toBe(46);
    const top = ev.pathSegments[0];
    expect(top.segment).toBe('products');
    expect(top.count).toBe(40);
    // Numeric id segments are NOT entities.
    expect(ev.pathSegments.some((s) => /^\d+$/.test(s.segment))).toBe(false);
  });

  it('follows a sitemap INDEX one level to reach real URLs', async () => {
    // The index must point at ITSELF, so the child URL has to be built from the
    // live port. Resolve it inside the handler, which runs after listen().
    let origin = '';
    server = await startServer({
      '/': html('<html></html>'),
      '/sitemap.xml': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<sitemapindex><loc>${origin}sitemap-1.xml</loc></sitemapindex>`);
      },
      '/sitemap-1.xml': text('<urlset><loc>http://x/invoices/1</loc><loc>http://x/invoices/2</loc></urlset>'),
    });
    origin = server.origin;

    const ev = await collectProductEvidence(server.origin);

    expect(ev.pathSegments.some((s) => s.segment === 'invoices')).toBe(true);
  });

  it('extracts third-party hosts — the payment/captcha tell', async () => {
    server = await startServer({
      '/': html(`<html><head>
        <script src="https://js.stripe.com/v3"></script>
        <script src="https://www.google.com/recaptcha/api.js"></script>
        <script src="/local/app.js"></script>
      </head></html>`),
    });

    const ev = await collectProductEvidence(server.origin);

    expect(ev.thirdPartyHosts).toEqual(expect.arrayContaining(['js.stripe.com', 'www.google.com']));
    // Same-origin assets are not "third party".
    expect(ev.thirdPartyHosts).not.toContain('127.0.0.1');
  });

  it('extracts locale hints from lang / hreflang / og:locale', async () => {
    server = await startServer({
      '/': html(`<html lang="kk"><head>
        <meta property="og:locale" content="kk_KZ">
        <link rel="alternate" hreflang="ru" href="/ru">
      </head></html>`),
    });

    const ev = await collectProductEvidence(server.origin);

    expect(ev.localeHints).toEqual(expect.arrayContaining(['kk', 'kk_KZ', 'ru']));
  });
});

describe('safety', () => {
  let server: { origin: string; close: () => void };
  afterEach(() => server?.close());

  it('redacts credentials that a /docs page printed verbatim', async () => {
    server = await startServer({
      '/': html('<html></html>'),
      '/docs': html('<p>Log in as demo@acme.com with password s3cret-pw</p>'),
    });

    const ev = await collectProductEvidence(server.origin, {
      email: 'demo@acme.com',
      password: 's3cret-pw',
    });

    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('s3cret-pw');
    expect(serialized).not.toContain('demo@acme.com');
  });

  it('blocks loopback targets outside development', async () => {
    server = await startServer({ '/': html('<html>secret internal app</html>') });
    process.env.NODE_ENV = 'production';

    const ev = await collectProductEvidence(server.origin);

    expect(ev.sources).toEqual([]);
    expect(ev.documents.every((d) => d.failure === 'blocked')).toBe(true);
    expect(JSON.stringify(ev)).not.toContain('secret internal app');
  });

  it('enforces the total character budget across documents', async () => {
    const huge = 'x'.repeat(59_000);
    server = await startServer({
      '/': html(huge),
      '/pricing': html(huge),
      '/about': html(huge),
      '/docs': html(huge),
    });

    const ev = await collectProductEvidence(server.origin);

    const total = ev.documents.reduce((n, d) => n + d.body.length, 0);
    // Without enforcement this would be ~4 x 59k. The cap is not advisory.
    expect(total).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    // The highest-priority document still got its share.
    expect(ev.documents.find((d) => d.path === '/')!.body.length).toBeGreaterThan(0);
  });

  it('returns a degraded result for an unparseable origin instead of throwing', async () => {
    const ev = await collectProductEvidence('::::not a url');

    expect(ev.sources).toEqual([]);
    expect(ev.documents).toEqual([]);
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not report budgetExhausted when everything simply succeeded', async () => {
    server = await startServer({ '/': html('<html></html>') });

    const ev = await collectProductEvidence(server.origin);

    // Would be a false "degraded" signal if it keyed on the clock alone.
    expect(ev.budgetExhausted).toBe(false);
  });

  it('survives a server that closes the connection mid-flight', async () => {
    server = await startServer({
      '/': (_req, res) => { res.destroy(); },
      '/robots.txt': text('User-agent: *\n'),
    });

    const ev = await collectProductEvidence(server.origin);

    // Phase 0 is an enhancement — a broken target degrades the brief, not the run.
    expect(ev.documents.find((d) => d.path === '/')!.ok).toBe(false);
    expect(ev.sources).toContain('/robots.txt');
  });
});
