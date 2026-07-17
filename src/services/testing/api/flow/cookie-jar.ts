/**
 * Per-run cookie jar for API-flow execution.
 *
 * Many APIs authenticate with a session COOKIE (Set-Cookie on login) rather than
 * a Bearer token. The flow executor is otherwise stateless per request, so those
 * sessions were lost between steps — the login succeeded but every authenticated
 * follow-up got 401. This jar captures Set-Cookie from each response and replays
 * the matching cookies as a `Cookie` header on later requests, scoped to the run.
 *
 * Scope is deliberately modest: domain + path + expiry matching, no Secure/
 * HttpOnly/SameSite enforcement (irrelevant for a server-side test client).
 */

interface StoredCookie {
  name: string;
  value: string;
  domain: string; // host that owns the cookie (no leading dot)
  path: string;
  expires?: number; // epoch ms; undefined = session cookie (kept for the run)
  hostOnly: boolean; // true = no Domain attr → exact-host match only (RFC 6265)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainMatch(requestHost: string, cookie: StoredCookie): boolean {
  if (requestHost === cookie.domain) return true;
  // Host-only cookies (no Domain attribute) match the exact host ONLY.
  if (cookie.hostOnly) return false;
  return requestHost.endsWith(`.${cookie.domain}`);
}

function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '/' || requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
  }
  return false;
}

/**
 * Split a combined `Set-Cookie` string (what the Fetch `Headers` API produces
 * when it folds multiple cookies into one value) back into individual cookies.
 * Only a fallback — the primary path receives an already-split array via
 * `Headers.getSetCookie()`. The lookahead avoids splitting on the comma inside
 * an `Expires=Wed, 21 Oct ...` date, since that comma is followed by a space +
 * digit, not a `token=` pair.
 */
function splitCombinedSetCookie(combined: string): string[] {
  return combined.split(/,(?=\s*[^=;,\s]+=)/);
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  /** Ingest the `Set-Cookie` header(s) from a response for `requestUrl`. */
  storeFromSetCookie(requestUrl: string, setCookie: string[] | string | undefined | null): void {
    if (!setCookie) return;
    const host = hostOf(requestUrl);
    if (!host) return;
    const list = Array.isArray(setCookie) ? setCookie : splitCombinedSetCookie(setCookie);
    for (const raw of list) this.storeOne(raw, host);
  }

  private storeOne(raw: string, host: string): void {
    const segments = raw.split(';');
    const pair = segments.shift();
    if (!pair) return;
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;

    let domain = host;
    let hostOnly = true;
    let path = '/';
    let expires: number | undefined;
    let expired = false;

    for (const seg of segments) {
      const sepIdx = seg.indexOf('=');
      const key = (sepIdx < 0 ? seg : seg.slice(0, sepIdx)).trim().toLowerCase();
      const val = sepIdx < 0 ? '' : seg.slice(sepIdx + 1).trim();
      if (key === 'domain' && val) {
        domain = val.replace(/^\./, '').toLowerCase();
        hostOnly = false;
      } else if (key === 'path' && val) {
        path = val;
      } else if (key === 'max-age') {
        const secs = parseInt(val, 10);
        if (!isNaN(secs)) {
          if (secs <= 0) expired = true;
          else expires = Date.now() + secs * 1000;
        }
      } else if (key === 'expires' && val && expires === undefined) {
        const t = Date.parse(val);
        if (!isNaN(t)) {
          if (t <= Date.now()) expired = true;
          else expires = t;
        }
      }
    }

    // Reject a Set-Cookie whose Domain the responding host doesn't belong to
    // (RFC 6265 §5.3.6) — prevents a response setting a cookie for an unrelated
    // host that a later same-run request would then replay.
    if (!hostOnly && host !== domain && !host.endsWith(`.${domain}`)) return;

    const mapKey = `${domain}\n${path}\n${name}`;
    if (expired) {
      this.cookies.delete(mapKey);
      return;
    }
    this.cookies.set(mapKey, { name, value, domain, path, expires, hostOnly });
  }

  /**
   * Build the `Cookie` header value for a request to `requestUrl`, or undefined
   * if no stored cookie applies. On duplicate names the more specific path wins.
   */
  cookieHeaderFor(requestUrl: string): string | undefined {
    const host = hostOf(requestUrl);
    if (!host) return undefined;
    let requestPath = '/';
    try {
      requestPath = new URL(requestUrl).pathname || '/';
    } catch {
      return undefined;
    }

    const now = Date.now();
    const chosen = new Map<string, { value: string; pathLen: number }>();
    for (const c of this.cookies.values()) {
      if (c.expires !== undefined && c.expires <= now) continue;
      if (!domainMatch(host, c)) continue;
      if (!pathMatch(requestPath, c.path)) continue;
      const prev = chosen.get(c.name);
      if (!prev || c.path.length > prev.pathLen) {
        chosen.set(c.name, { value: c.value, pathLen: c.path.length });
      }
    }

    if (chosen.size === 0) return undefined;
    return [...chosen.entries()].map(([name, c]) => `${name}=${c.value}`).join('; ');
  }

  /** Number of live cookies — for logging/tests. */
  size(): number {
    return this.cookies.size;
  }
}
