/**
 * Insomnia Export Adapter
 * Supports Insomnia v4 (JSON) export format
 */

import { logger } from '@/utils/core/logger';
import type { HttpMethod, ParsedApiSpec, ParsedEndpoint, ParsedParameter } from '../flow.types';
import { ensureUniqueOperationIds } from './adapter-utils';

const VALID_HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

interface InsomniaResource {
  _type: string;
  _id: string;
  name?: string;
  url?: string;
  method?: string;
  headers?: Array<{ name: string; value: string; disabled?: boolean }>;
  parameters?: Array<{ name: string; value: string; disabled?: boolean }>;
  body?: {
    mimeType?: string;
    text?: string;
  };
  parentId?: string;
  description?: string;
}

interface InsomniaExport {
  __export_format?: number;
  __export_source?: string;
  resources: InsomniaResource[];
}

function parseInsomniaBody(body?: InsomniaResource['body']): any {
  if (!body?.text) return undefined;
  const mime = body.mimeType || '';
  if (mime.includes('application/json') || !mime) {
    try {
      return JSON.parse(body.text);
    } catch {
      return body.text;
    }
  }
  return body.text;
}

function normalizeInsomniaUrl(url: string): { baseUrl: string; path: string } {
  // Replace Insomnia variables {{ _.varName }} with {varName}
  const normalized = url.replace(/\{\{_\.([^}]+)\}\}/g, '{$1}').replace(/\{\{([^}]+)\}\}/g, '{$1}');

  try {
    const parsed = new URL(normalized);
    return {
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      path: parsed.pathname || '/',
    };
  } catch {
    // URL might have variable in host, extract path manually
    const match = normalized.match(/^(?:https?:\/\/[^/]+)?(\/.*)?$/);
    return { baseUrl: '', path: match?.[1] || '/' };
  }
}

export function parseInsomniaExport(content: string): ParsedApiSpec {
  let exported: InsomniaExport;
  try {
    exported = JSON.parse(content);
  } catch {
    throw new Error('Invalid Insomnia export: not valid JSON');
  }

  if (!exported.resources || !Array.isArray(exported.resources)) {
    throw new Error('Invalid Insomnia export: missing resources array');
  }

  const requests = exported.resources.filter(r => r._type === 'request');

  if (requests.length === 0) {
    throw new Error('No requests found in Insomnia export');
  }

  let baseUrl = '';
  const endpoints: ParsedEndpoint[] = [];

  for (const req of requests) {
    if (!req.url || !req.method) continue;

    const method = req.method.toUpperCase() as HttpMethod;
    if (!VALID_HTTP_METHODS.includes(method)) continue;

    const { baseUrl: itemBase, path } = normalizeInsomniaUrl(req.url);
    if (!baseUrl && itemBase) baseUrl = itemBase;

    const queryParams: ParsedParameter[] = (req.parameters || [])
      .filter(p => !p.disabled)
      .map(p => ({
        name: p.name,
        in: 'query' as const,
        required: false,
        example: p.value,
      }));

    const pathParamNames = [...(path.match(/\{([^}]+)\}/g) || [])].map(p => p.slice(1, -1));
    const pathParams: ParsedParameter[] = pathParamNames.map(name => ({
      name,
      in: 'path' as const,
      required: true,
    }));

    const parsedBody = parseInsomniaBody(req.body);
    const hasFileUpload = req.body?.mimeType?.includes('multipart/form-data') ?? false;

    const authHeader = (req.headers || []).find(h => h.name.toLowerCase() === 'authorization' && !h.disabled);
    const security: string[] = authHeader ? ['bearerAuth'] : [];

    const operationId = (req.name || `${method}_${path}`)
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    endpoints.push({
      operationId,
      method,
      path,
      summary: req.name || `${method} ${path}`,
      description: req.description,
      tags: [],
      parameters: [...pathParams, ...queryParams],
      requestBody: parsedBody ? {
        contentType: req.body?.mimeType || 'application/json',
        schema: parsedBody,
        required: true,
        example: parsedBody,
      } : undefined,
      responses: { '200': { description: 'OK' } },
      security,
      hasFileUpload,
    });
  }

  ensureUniqueOperationIds(endpoints);

  logger.info('[INSOMNIA_ADAPTER] Parsed export', {
    totalResources: exported.resources.length,
    endpoints: endpoints.length,
  });

  return {
    title: 'API (from Insomnia)',
    version: '1.0.0',
    specVersion: `insomnia-v${exported.__export_format || 4}`,
    baseUrl,
    authSchemes: endpoints.some(e => e.security.length > 0)
      ? [{ name: 'bearerAuth', type: 'bearer' }]
      : [],
    endpoints,
    unsupportedEndpoints: [],
    sourceType: 'insomnia',
  };
}
