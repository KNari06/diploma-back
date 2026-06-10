/**
 * Python Adapter
 * Converts a Python API automation script (requests / httpx / aiohttp / urllib /
 * pytest) into the unified ParsedApiSpec.
 *
 * Python is not regex-parseable, so this adapter delegates the "reading" to the
 * LLM (same client + JSON-extraction + retry pattern as the dependency-resolver
 * pipeline). The script is never executed.
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import {
  buildPythonImportPrompt,
  buildPythonImportSystemPrompt,
} from '@/ai/prompts/python-import-prompts';
import type {
  AuthScheme,
  HttpMethod,
  ParsedApiSpec,
  ParsedEndpoint,
  ParsedParameter,
  ParsedRequestBody,
  ParsedResponse,
} from '../flow.types';
import { callAiWithRetry, extractJson } from '../ai-json.util';

const VALID_HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const VALID_PARAM_LOCATIONS = new Set(['path', 'query', 'header', 'cookie']);
const VALID_AUTH_TYPES = new Set(['bearer', 'apiKey', 'basic', 'oauth2', 'openIdConnect', 'none']);

// Guardrail: cap input so a huge repo dump can't blow the token budget.
const MAX_SOURCE_BYTES = 100_000;

function coerceMethod(method: unknown): HttpMethod | null {
  if (typeof method !== 'string') return null;
  const upper = method.toUpperCase() as HttpMethod;
  return VALID_HTTP_METHODS.includes(upper) ? upper : null;
}

function normalizeParameters(raw: unknown): ParsedParameter[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedParameter[] = [];
  for (const p of raw) {
    if (!p || typeof p.name !== 'string') continue;
    const location = VALID_PARAM_LOCATIONS.has(p.in) ? p.in : 'query';
    out.push({
      name: p.name,
      in: location,
      required: p.in === 'path' ? true : Boolean(p.required),
      schema: p.schema,
      description: typeof p.description === 'string' ? p.description : undefined,
      example: p.example,
    });
  }
  return out;
}

/**
 * Safety net: every `{token}` in the path must have a matching path parameter.
 * The LLM occasionally emits a templated path but forgets to list the param,
 * which would leave an unbound placeholder at flow-execution time. We backfill
 * any missing ones (deduping against what the model already provided).
 */
function backfillPathParams(path: string, params: ParsedParameter[]): ParsedParameter[] {
  const tokens = path.match(/\{([^}]+)\}/g);
  if (!tokens) return params;

  const existing = new Set(params.filter((p) => p.in === 'path').map((p) => p.name));
  const out = [...params];
  for (const token of tokens) {
    const name = token.slice(1, -1).trim();
    if (!name || existing.has(name)) continue;
    existing.add(name);
    out.push({ name, in: 'path', required: true });
  }
  return out;
}

function normalizeRequestBody(raw: any): ParsedRequestBody | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.schema === undefined && raw.example === undefined) return undefined;
  return {
    contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/json',
    schema: raw.schema ?? raw.example,
    required: raw.required !== false,
    example: raw.example ?? raw.schema,
  };
}

function normalizeResponses(raw: any): Record<string, ParsedResponse> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, ParsedResponse> = {};
    for (const [code, val] of Object.entries(raw)) {
      if (!/^\d{3}$/.test(code)) continue;
      const v = val as any;
      out[code] = { description: typeof v?.description === 'string' ? v.description : 'OK' };
    }
    if (Object.keys(out).length > 0) return out;
  }
  return { '200': { description: 'OK' } };
}

function normalizeAuthSchemes(raw: unknown): AuthScheme[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthScheme[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a.name !== 'string') continue;
    if (seen.has(a.name)) continue;
    const type = VALID_AUTH_TYPES.has(a.type) ? a.type : 'bearer';
    seen.add(a.name);
    out.push({
      name: a.name,
      type,
      in: a.in === 'header' || a.in === 'query' || a.in === 'cookie' ? a.in : undefined,
      headerName: typeof a.headerName === 'string' ? a.headerName : undefined,
    });
  }
  return out;
}

function deriveBaseUrl(explicit: unknown): string {
  if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) {
    try {
      const u = new URL(explicit);
      return `${u.protocol}//${u.host}`;
    } catch {
      // fall through
    }
  }
  return '';
}

/**
 * Parse a Python script into a ParsedApiSpec via the LLM.
 * @throws if the input is empty or the model finds no HTTP calls.
 */
export async function parsePythonScript(content: string): Promise<ParsedApiSpec> {
  const source = (content || '').trim();
  if (!source) {
    throw new Error('Empty Python script — nothing to import.');
  }

  let code = source;
  if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) {
    logger.warn('[PYTHON_ADAPTER] Script exceeds size cap, truncating', {
      bytes: Buffer.byteLength(code, 'utf8'),
      cap: MAX_SOURCE_BYTES,
    });
    code = code.slice(0, MAX_SOURCE_BYTES);
  }

  const raw = await callAiWithRetry(
    [
      { role: 'system', content: buildPythonImportSystemPrompt() },
      { role: 'user', content: buildPythonImportPrompt(code) },
    ],
    {
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_tokens: 8000,
      model: AI_TASK_MODELS.apiFlowAnalyst,
      timeout: 180000,
    } as any,
    'PythonImport',
  );

  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.endpoints)) {
    throw new Error('Could not extract API endpoints from the Python script (no valid response).');
  }

  const endpoints: ParsedEndpoint[] = [];
  const seenOperations = new Set<string>();

  for (const e of parsed.endpoints) {
    const method = coerceMethod(e?.method);
    if (!method || typeof e?.path !== 'string' || !e.path) continue;

    const path = e.path.startsWith('/') ? e.path : `/${e.path}`;
    const opKey = `${method}:${path}`;
    if (seenOperations.has(opKey)) continue;
    seenOperations.add(opKey);

    const operationId =
      typeof e.operationId === 'string' && e.operationId.trim()
        ? e.operationId.trim()
        : `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

    const security = Array.isArray(e.security)
      ? e.security.filter((s: unknown): s is string => typeof s === 'string')
      : [];

    endpoints.push({
      operationId,
      method,
      path,
      summary: typeof e.summary === 'string' && e.summary ? e.summary : `${method} ${path}`,
      description: typeof e.description === 'string' ? e.description : undefined,
      tags: Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === 'string') : [],
      parameters: backfillPathParams(path, normalizeParameters(e.parameters)),
      requestBody:
        method === 'GET' || method === 'HEAD' ? undefined : normalizeRequestBody(e.requestBody),
      responses: normalizeResponses(e.responses),
      security,
    });
  }

  if (endpoints.length === 0) {
    throw new Error(
      'No HTTP API calls were found in the Python script. ' +
        'Supported styles: requests, httpx, aiohttp, urllib, and pytest test files.',
    );
  }

  const authSchemes = normalizeAuthSchemes(parsed.authSchemes);
  const baseUrl = deriveBaseUrl(parsed.baseUrl);

  logger.info('[PYTHON_ADAPTER] Parsed Python script', {
    endpoints: endpoints.length,
    authSchemes: authSchemes.length,
    hasBaseUrl: !!baseUrl,
  });

  return {
    title: typeof parsed.title === 'string' && parsed.title ? parsed.title : 'API (from Python)',
    version: '1.0.0',
    specVersion: 'python',
    baseUrl,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    authSchemes,
    endpoints,
    unsupportedEndpoints: [],
    sourceType: 'python',
  };
}
