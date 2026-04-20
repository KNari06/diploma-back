/**
 * Postman collection adapter
 *
 * Turns a Postman v2.x collection into one chunk per request. Each chunk
 * includes the HTTP method, URL, description, headers, body shape, and
 * tests/pre-request scripts. Folders become tags so the LLM can discriminate
 * between e.g. "auth/login" and "admin/login".
 */

import { AdapterChunk, AdapterResult, FormatAdapter } from './types';

interface PostmanInfo {
  name?: string;
  schema?: string;
}

function looksLikePostman(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object') return false;
    const info = (obj as { info?: PostmanInfo }).info;
    const schema = info?.schema ?? '';
    return (
      typeof schema === 'string' &&
      schema.includes('schema.getpostman.com/json/collection/v2')
    );
  } catch {
    return false;
  }
}

function short(s: unknown, max = 240): string {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

function describeUrl(url: unknown): { raw: string; method: string; path: string } {
  // Postman can encode url as a string OR an object with raw/host/path
  if (typeof url === 'string') {
    try {
      const u = new URL(url);
      return { raw: url, method: '', path: u.pathname || url };
    } catch {
      return { raw: url, method: '', path: url };
    }
  }
  if (url && typeof url === 'object') {
    const uu = url as Record<string, unknown>;
    const raw = typeof uu.raw === 'string' ? uu.raw : '';
    const pathSegs = Array.isArray(uu.path)
      ? (uu.path as unknown[]).filter((s) => typeof s === 'string').join('/')
      : '';
    return { raw, method: '', path: pathSegs ? `/${pathSegs}` : raw };
  }
  return { raw: '', method: '', path: '' };
}

function describeBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  // Postman collections can carry `disabled: true` on the body envelope —
  // in Postman UI it is greyed out and not sent; skip it.
  if (b.disabled === true) return null;

  const mode = typeof b.mode === 'string' ? b.mode : '(unknown)';
  if (mode === 'raw' && typeof b.raw === 'string') {
    const preview = short(b.raw, 400);
    return `Body (raw): ${preview}`;
  }
  if (mode === 'graphql' && b.graphql && typeof b.graphql === 'object') {
    const g = b.graphql as Record<string, unknown>;
    const query = typeof g.query === 'string' ? short(g.query, 400) : '';
    const vars = typeof g.variables === 'string' ? short(g.variables, 200) : '';
    const lines = [`Body (graphql):`];
    if (query) lines.push(`  query: ${query}`);
    if (vars) lines.push(`  variables: ${vars}`);
    return lines.join('\n');
  }
  if (mode === 'urlencoded' || mode === 'formdata') {
    const items = Array.isArray(b[mode]) ? (b[mode] as unknown[]) : [];
    const keys = items
      .filter((i) => i && typeof i === 'object' && (i as Record<string, unknown>).disabled !== true)
      .map((i) => (i as Record<string, unknown>).key)
      .filter((k): k is string => typeof k === 'string');
    return `Body (${mode}): ${keys.join(', ') || '(empty)'}`;
  }
  if (mode === 'file') {
    return 'Body (file upload)';
  }
  return `Body mode: ${mode}`;
}

function describeHeaders(header: unknown): string[] {
  if (!Array.isArray(header)) return [];
  return header
    .map((h) => {
      if (!h || typeof h !== 'object') return null;
      const hh = h as Record<string, unknown>;
      // Skip disabled headers — same rendering Postman itself applies
      if (hh.disabled === true) return null;
      const key = typeof hh.key === 'string' ? hh.key : '';
      const value = typeof hh.value === 'string' ? hh.value : '';
      if (!key) return null;
      return `  ${key}: ${short(value, 100)}`;
    })
    .filter((s): s is string => s !== null);
}

function describeRequest(
  name: string,
  folderPath: string[],
  request: unknown,
  events: unknown
): AdapterChunk | null {
  if (!request || typeof request !== 'object') return null;
  const req = request as Record<string, unknown>;

  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
  const { raw: urlRaw, path } = describeUrl(req.url);
  const description = short(req.description, 600);
  const headers = describeHeaders(req.header);
  const body = describeBody(req.body);

  // Tests + pre-request scripts (events[].listen = 'test' | 'prerequest')
  const testScripts: string[] = [];
  const preScripts: string[] = [];
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const e = ev as Record<string, unknown>;
      const listen = typeof e.listen === 'string' ? e.listen : '';
      const script = e.script as Record<string, unknown> | undefined;
      const exec = script && Array.isArray(script.exec)
        ? (script.exec as unknown[]).filter((l) => typeof l === 'string').join('\n')
        : '';
      if (!exec) continue;
      const compact = short(exec, 500);
      if (listen === 'test') testScripts.push(compact);
      else if (listen === 'prerequest') preScripts.push(compact);
    }
  }

  const parts: string[] = [];
  parts.push(`${method} ${path || urlRaw || '(no url)'}`);
  parts.push(`Name: ${name}`);
  if (folderPath.length > 0) parts.push(`Folder: ${folderPath.join(' / ')}`);
  if (urlRaw && urlRaw !== path) parts.push(`Full URL: ${urlRaw}`);
  if (description) parts.push('', description);
  if (headers.length > 0) parts.push('', 'Headers:', ...headers);
  if (body) parts.push('', body);
  if (preScripts.length > 0) parts.push('', 'Pre-request script:', ...preScripts);
  if (testScripts.length > 0) parts.push('', 'Tests:', ...testScripts);

  return {
    content: parts.join('\n'),
    sectionTitle: `${method} ${name}`,
    metadata: {
      format: 'postman',
      http_method: method,
      path,
      url: urlRaw,
      folder: folderPath,
      has_tests: testScripts.length > 0,
    },
  };
}

function walkItems(
  items: unknown,
  folderPath: string[],
  out: AdapterChunk[]
): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    // Skip disabled items entirely — they're not sent in Postman runs and
    // indexing them just adds noise to retrieval.
    if (it.disabled === true) continue;

    const name = typeof it.name === 'string' ? it.name : '(unnamed)';

    // Folder: has .item array — recurse
    if (Array.isArray(it.item)) {
      walkItems(it.item, [...folderPath, name], out);
      continue;
    }

    // Request: has .request
    const chunk = describeRequest(name, folderPath, it.request, it.event);
    if (chunk) out.push(chunk);
  }
}

export const postmanAdapter: FormatAdapter = {
  name: 'postman',

  detect(_fileName: string, raw: string): boolean {
    return looksLikePostman(raw);
  },

  extract(_fileName: string, raw: string): AdapterResult {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { format: 'postman', chunks: [], summary: 'Postman: failed to parse' };
    }

    const chunks: AdapterChunk[] = [];
    walkItems(obj.item, [], chunks);

    const collName = (obj.info && typeof obj.info === 'object')
      ? ((obj.info as PostmanInfo).name ?? 'Postman collection')
      : 'Postman collection';

    const summary = `Postman · ${collName} · ${chunks.length} request${chunks.length === 1 ? '' : 's'}`;

    return { format: 'postman', chunks, summary };
  },
};
