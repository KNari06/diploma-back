/**
 * Postman Collection Adapter (v2.0 / v2.1)
 * Converts Postman collections to unified ParsedApiSpec
 */

import { logger } from '@/utils/core/logger';
import type { HttpMethod, ParsedApiSpec, ParsedEndpoint, ParsedParameter } from '../flow.types';

interface PostmanVariable {
  key: string;
  value?: string;
  type?: string;
}

interface PostmanHeader {
  key: string;
  value: string;
  disabled?: boolean;
}

interface PostmanUrlQuery {
  key: string;
  value?: string;
  disabled?: boolean;
}

interface PostmanUrl {
  raw?: string;
  host?: string[];
  path?: string[];
  query?: PostmanUrlQuery[];
  variable?: PostmanVariable[];
  protocol?: string;
  port?: string;
}

interface PostmanBody {
  mode?: string;
  raw?: string;
  urlencoded?: Array<{ key: string; value: string; disabled?: boolean }>;
  formdata?: Array<{ key: string; value: string; type?: string; disabled?: boolean }>;
  options?: { raw?: { language?: string } };
}

interface PostmanRequest {
  method?: string;
  url?: string | PostmanUrl;
  header?: PostmanHeader[];
  body?: PostmanBody;
  description?: string;
}

interface PostmanItem {
  name?: string;
  request?: PostmanRequest;
  item?: PostmanItem[]; // folder
  id?: string;
}

interface PostmanCollection {
  info?: {
    name?: string;
    schema?: string;
    description?: string;
    version?: string;
  };
  item?: PostmanItem[];
  variable?: PostmanVariable[];
}

const VALID_HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

function resolvePostmanUrl(url: string | PostmanUrl | undefined): { baseUrl: string; path: string } {
  if (!url) return { baseUrl: '', path: '/' };

  if (typeof url === 'string') {
    try {
      const parsed = new URL(url);
      return { baseUrl: `${parsed.protocol}//${parsed.host}`, path: parsed.pathname || '/' };
    } catch {
      return { baseUrl: '', path: url };
    }
  }

  // PostmanUrl object
  const protocol = url.protocol || 'https';
  const host = url.host ? url.host.join('.') : '';
  const port = url.port ? `:${url.port}` : '';
  const baseUrl = host ? `${protocol}://${host}${port}` : '';
  const path = url.path ? `/${url.path.join('/')}` : '/';

  return { baseUrl, path };
}

function extractQueryParams(url: string | PostmanUrl | undefined): ParsedParameter[] {
  if (!url || typeof url === 'string') return [];

  const postmanUrl = url as PostmanUrl;
  return (postmanUrl.query || [])
    .filter(q => !q.disabled)
    .map(q => ({
      name: q.key,
      in: 'query' as const,
      required: false,
      example: q.value,
    }));
}

function extractPathParams(url: string | PostmanUrl | undefined): ParsedParameter[] {
  if (!url || typeof url === 'string') return [];

  const postmanUrl = url as PostmanUrl;
  const pathParams: ParsedParameter[] = [];

  // Extract from path segments like :userId or {{userId}}
  const pathStr = (postmanUrl.path || []).join('/');
  const colonMatches = pathStr.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
  const bracketMatches = pathStr.match(/\{\{([^}]+)\}\}/g) || [];

  for (const match of colonMatches) {
    pathParams.push({ name: match.slice(1), in: 'path', required: true });
  }
  for (const match of bracketMatches) {
    const name = match.slice(2, -2);
    if (!pathParams.some(p => p.name === name)) {
      pathParams.push({ name, in: 'path', required: true });
    }
  }

  // Also from url.variable
  for (const v of postmanUrl.variable || []) {
    if (!pathParams.some(p => p.name === v.key)) {
      pathParams.push({ name: v.key, in: 'path', required: true, example: v.value });
    }
  }

  return pathParams;
}

function parsePostmanBody(body?: PostmanBody): any {
  if (!body) return undefined;

  if (body.mode === 'raw' && body.raw) {
    const lang = body.options?.raw?.language;
    if (lang === 'json' || !lang) {
      try {
        return JSON.parse(body.raw);
      } catch {
        return body.raw;
      }
    }
    return body.raw;
  }

  if (body.mode === 'urlencoded' && body.urlencoded) {
    return Object.fromEntries(
      (body.urlencoded || [])
        .filter(f => !f.disabled)
        .map(f => [f.key, f.value])
    );
  }

  if (body.mode === 'formdata' && body.formdata) {
    return Object.fromEntries(
      (body.formdata || [])
        .filter(f => !f.disabled)
        .map(f => [f.key, f.value])
    );
  }

  return undefined;
}

function normalizePostmanPath(url: string | PostmanUrl | undefined): string {
  if (!url) return '/';
  const { path } = resolvePostmanUrl(url);
  // Convert :param to {param} for consistency with OpenAPI
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

function flattenPostmanItems(items: PostmanItem[], folderPath = ''): PostmanItem[] {
  const result: PostmanItem[] = [];
  for (const item of items) {
    if (item.item) {
      // It's a folder — recurse
      result.push(...flattenPostmanItems(item.item, `${folderPath}/${item.name || ''}`));
    } else if (item.request) {
      result.push({ ...item, name: `${folderPath}/${item.name || ''}`.replace(/^\//, '') });
    }
  }
  return result;
}

export function parsePostmanCollection(content: string): ParsedApiSpec {
  let collection: PostmanCollection;
  try {
    collection = JSON.parse(content);
  } catch {
    throw new Error('Invalid Postman collection: not valid JSON');
  }

  if (!collection.info || !collection.item) {
    throw new Error('Invalid Postman collection: missing info or item fields');
  }

  const title = collection.info.name || 'Postman Collection';
  const version = collection.info.version || '1.0.0';
  const specVersion = collection.info.schema?.includes('v2.1') ? '2.1' : '2.0';

  // Flatten all requests from nested folders
  const flatItems = flattenPostmanItems(collection.item || []);

  // Determine base URL from first request
  let baseUrl = '';
  const endpoints: ParsedEndpoint[] = [];

  for (const item of flatItems) {
    const req = item.request;
    if (!req) continue;

    const method = (req.method || 'GET').toUpperCase() as HttpMethod;
    if (!VALID_HTTP_METHODS.includes(method)) continue;

    const { baseUrl: itemBase } = resolvePostmanUrl(req.url);
    if (!baseUrl && itemBase) baseUrl = itemBase;

    const path = normalizePostmanPath(req.url);
    const queryParams = extractQueryParams(req.url);
    const pathParams = extractPathParams(req.url);
    const parsedBody = parsePostmanBody(req.body);
    const hasFileUpload = req.body?.mode === 'formdata' &&
      (req.body.formdata || []).some(f => f.type === 'file');

    // Build operationId from name or method+path
    const safeName = (item.name || `${method}_${path}`)
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    endpoints.push({
      operationId: safeName,
      method,
      path,
      summary: item.name || `${method} ${path}`,
      description: typeof req.description === 'string' ? req.description : undefined,
      tags: [],
      parameters: [...pathParams, ...queryParams],
      requestBody: parsedBody ? {
        contentType: req.body?.mode === 'formdata' ? 'multipart/form-data' :
          req.body?.mode === 'urlencoded' ? 'application/x-www-form-urlencoded' :
            'application/json',
        schema: parsedBody,
        required: true,
        example: parsedBody,
      } : undefined,
      responses: { '200': { description: 'OK' } },
      security: [],
      hasFileUpload,
      isPagination: queryParams.some(p =>
        ['page', 'limit', 'offset', 'cursor', 'per_page'].includes(p.name.toLowerCase())
      ),
    });
  }

  logger.info('[POSTMAN_ADAPTER] Parsed collection', {
    title,
    totalEndpoints: endpoints.length,
  });

  return {
    title,
    version,
    specVersion,
    baseUrl,
    authSchemes: [],
    endpoints,
    unsupportedEndpoints: [],
    sourceType: 'postman',
    rawSpec: collection,
  };
}
