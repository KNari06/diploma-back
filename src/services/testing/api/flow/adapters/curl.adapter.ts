/**
 * cURL Adapter
 * Parses one or more curl command strings into a unified ParsedApiSpec.
 * Does NOT require external dependencies — pure string parsing.
 */

import { logger } from '@/utils/core/logger';
import type { HttpMethod, ParsedApiSpec, ParsedEndpoint, ParsedParameter } from '../flow.types';

const VALID_HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

interface ParsedCurlCommand {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: any;
  queryParams: ParsedParameter[];
}

/**
 * Tokenize a curl command respecting quotes
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if ((ch === ' ' || ch === '\t' || ch === '\n') && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else if (ch === '\\' && !inSingle) {
      // Escape: skip next char (consume backslash-newline for line continuation)
      i++;
      if (i < cmd.length && cmd[i] !== '\n') {
        current += cmd[i];
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseCurlCommand(raw: string): ParsedCurlCommand | null {
  // Normalize line continuations (backslash-newline)
  const cmd = raw.replace(/\\\n/g, ' ').replace(/\\\r\n/g, ' ').trim();

  if (!cmd.toLowerCase().startsWith('curl')) return null;

  const tokens = tokenize(cmd);
  if (tokens.length < 2) return null;

  let method: HttpMethod = 'GET';
  let url = '';
  const headers: Record<string, string> = {};
  let bodyRaw: string | undefined;
  let hasBodyFlag = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === '-X' || t === '--request') {
      const m = (tokens[++i] || '').toUpperCase() as HttpMethod;
      if (VALID_HTTP_METHODS.includes(m)) method = m;
    } else if (t === '-H' || t === '--header') {
      const header = tokens[++i] || '';
      const colonIdx = header.indexOf(':');
      if (colonIdx > 0) {
        const k = header.slice(0, colonIdx).trim().toLowerCase();
        const v = header.slice(colonIdx + 1).trim();
        headers[k] = v;
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      bodyRaw = tokens[++i] || '';
      hasBodyFlag = true;
    } else if (t === '--json') {
      // curl --json (newer curl)
      bodyRaw = tokens[++i] || '';
      headers['content-type'] = headers['content-type'] || 'application/json';
      hasBodyFlag = true;
    } else if (t === '-u' || t === '--user') {
      const creds = tokens[++i] || '';
      headers['authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    } else if (t === '--oauth2-bearer') {
      const token = tokens[++i] || '';
      headers['authorization'] = `Bearer ${token}`;
    } else if (!t.startsWith('-') && !url) {
      // First non-flag token is the URL
      url = t;
    }
  }

  if (!url) return null;

  // Infer method from body presence
  if (hasBodyFlag && method === 'GET') method = 'POST';

  // Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    // Try adding https:// prefix
    try {
      parsedUrl = new URL(`https://${url}`);
    } catch {
      return null;
    }
  }

  // Extract query params
  const queryParams: ParsedParameter[] = [];
  parsedUrl.searchParams.forEach((value, key) => {
    queryParams.push({ name: key, in: 'query', required: false, example: value });
  });

  // Parse body
  let parsedBody: any;
  if (bodyRaw) {
    try {
      parsedBody = JSON.parse(bodyRaw);
    } catch {
      parsedBody = bodyRaw;
    }
  }

  return { method, url, headers, body: parsedBody, queryParams };
}

/**
 * Split multiple curl commands from a block of text
 */
function splitCurlCommands(text: string): string[] {
  // Split on newlines that start a new 'curl' command
  const lines = text.split('\n');
  const commands: string[] = [];
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('curl ') && current) {
      commands.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) commands.push(current.trim());

  return commands.filter(c => c.toLowerCase().startsWith('curl'));
}

export function parseCurlCommands(content: string): ParsedApiSpec {
  const rawCommands = splitCurlCommands(content);
  if (rawCommands.length === 0) {
    throw new Error('No valid curl commands found in input');
  }

  const endpoints: ParsedEndpoint[] = [];
  let baseUrl = '';
  const seenOperations = new Set<string>();

  for (const rawCmd of rawCommands) {
    const parsed = parseCurlCommand(rawCmd);
    if (!parsed) continue;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(parsed.url);
    } catch {
      continue;
    }

    if (!baseUrl) {
      baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    }

    const path = parsedUrl.pathname || '/';
    const opKey = `${parsed.method}:${path}`;

    // Deduplicate identical method+path
    if (seenOperations.has(opKey)) continue;
    seenOperations.add(opKey);

    const operationId = `${parsed.method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

    // Detect path params (e.g. /users/123 or /users/:id)
    const pathParams: ParsedParameter[] = [];
    const pathSegments = path.split('/').filter(Boolean);
    for (const seg of pathSegments) {
      if (/^\d+$/.test(seg)) {
        // Numeric segment — likely an ID, replace with {id}
        pathParams.push({ name: 'id', in: 'path', required: true, example: seg });
      } else if (seg.startsWith(':')) {
        pathParams.push({ name: seg.slice(1), in: 'path', required: true });
      } else if (seg.startsWith('{') && seg.endsWith('}')) {
        pathParams.push({ name: seg.slice(1, -1), in: 'path', required: true });
      }
    }

    const security: string[] = parsed.headers['authorization'] ? ['bearerAuth'] : [];

    endpoints.push({
      operationId,
      method: parsed.method,
      path,
      summary: `${parsed.method} ${path}`,
      tags: [],
      parameters: [...pathParams, ...parsed.queryParams],
      requestBody: parsed.body ? {
        contentType: parsed.headers['content-type'] || 'application/json',
        schema: parsed.body,
        required: true,
        example: parsed.body,
      } : undefined,
      responses: { '200': { description: 'OK' } },
      security,
    });
  }

  if (endpoints.length === 0) {
    throw new Error('Could not parse any valid API endpoints from curl commands');
  }

  logger.info('[CURL_ADAPTER] Parsed curl commands', {
    total: rawCommands.length,
    endpoints: endpoints.length,
  });

  return {
    title: 'API (from cURL)',
    version: '1.0.0',
    specVersion: 'curl',
    baseUrl,
    authSchemes: endpoints.some(e => e.security.length > 0)
      ? [{ name: 'bearerAuth', type: 'bearer' }]
      : [],
    endpoints,
    unsupportedEndpoints: [],
    sourceType: 'curl',
  };
}
