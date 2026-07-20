/**
 * HAR (HTTP Archive) Adapter
 * Converts browser-captured HAR files to unified ParsedApiSpec.
 * Filters out static assets and deduplicates requests.
 */

import { logger } from '@/utils/core/logger';
import type { HttpMethod, ParsedApiSpec, ParsedEndpoint, ParsedParameter } from '../flow.types';
import { ensureUniqueOperationIds } from './adapter-utils';

// Static asset extensions to filter out
const STATIC_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.map',
];

// Content types to skip (non-API responses)
const SKIP_CONTENT_TYPES = [
  'text/html', 'text/css', 'application/javascript', 'text/javascript',
  'image/', 'font/', 'audio/', 'video/',
];

const VALID_HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: {
      mimeType?: string;
      text?: string;
    };
  };
  response: {
    status: number;
    headers: Array<{ name: string; value: string }>;
    content?: {
      mimeType?: string;
      text?: string;
    };
  };
  timings?: {
    send?: number;
    wait?: number;
    receive?: number;
  };
}

interface HarFile {
  log: {
    version?: string;
    creator?: { name?: string };
    entries: HarEntry[];
  };
}

function isStaticAsset(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function isApiRequest(entry: HarEntry): boolean {
  const url = entry.request.url;

  // Skip static assets
  if (isStaticAsset(url)) return false;

  // Skip non-API content types in response
  const responseContentType = entry.response.headers
    .find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  if (SKIP_CONTENT_TYPES.some(ct => responseContentType.toLowerCase().includes(ct))) {
    return false;
  }

  // Keep if response is JSON, XML, or has no content type (raw API)
  const isApiContentType =
    responseContentType.includes('application/json') ||
    responseContentType.includes('application/xml') ||
    responseContentType.includes('text/plain') ||
    responseContentType === '' ||
    entry.response.status === 0; // failed requests

  // Also keep POST/PUT/PATCH regardless of response type
  const method = entry.request.method.toUpperCase();
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  return isApiContentType || isMutating;
}

function extractPathTemplate(url: string): string {
  try {
    const parsed = new URL(url);
    // Replace UUID-like segments with {id}
    const path = parsed.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
      // Replace numeric IDs
      .replace(/\/\d+(?=\/|$)/g, '/{id}')
      // Replace slug-like IDs (alphanumeric, 8+ chars that look like IDs)
      .replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, '/{id}');
    return path || '/';
  } catch {
    return '/';
  }
}

function parseHarBody(postData?: HarEntry['request']['postData']): any {
  if (!postData?.text) return undefined;
  try {
    return JSON.parse(postData.text);
  } catch {
    return postData.text;
  }
}

export function parseHarFile(content: string): ParsedApiSpec {
  let har: HarFile;
  try {
    har = JSON.parse(content);
  } catch {
    throw new Error('Invalid HAR file: not valid JSON');
  }

  if (!har.log || !Array.isArray(har.log.entries)) {
    throw new Error('Invalid HAR file: missing log.entries');
  }

  const apiEntries = har.log.entries.filter(isApiRequest);

  if (apiEntries.length === 0) {
    throw new Error('No API requests found in HAR file (all requests appear to be static assets)');
  }

  let baseUrl = '';
  const endpoints: ParsedEndpoint[] = [];
  const seenOperations = new Map<string, number>(); // opKey → endpoint index

  for (const entry of apiEntries) {
    const req = entry.request;
    const method = req.method.toUpperCase() as HttpMethod;
    if (!VALID_HTTP_METHODS.includes(method)) continue;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url);
    } catch {
      continue;
    }

    if (!baseUrl) {
      baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    }

    const pathTemplate = extractPathTemplate(req.url);
    const opKey = `${method}:${pathTemplate}`;

    // Deduplicate: if we've seen this method+path, merge query params
    if (seenOperations.has(opKey)) {
      const existingIdx = seenOperations.get(opKey)!;
      const existing = endpoints[existingIdx];
      // Merge query params (add new ones not already present)
      for (const qs of req.queryString) {
        if (!existing.parameters.some(p => p.in === 'query' && p.name === qs.name)) {
          existing.parameters.push({
            name: qs.name,
            in: 'query',
            required: false,
            example: qs.value,
          });
        }
      }
      continue;
    }

    // Extract auth header
    const authHeader = req.headers.find(h => h.name.toLowerCase() === 'authorization');
    const security = authHeader ? ['bearerAuth'] : [];

    // Query params
    const queryParams: ParsedParameter[] = req.queryString.map(qs => ({
      name: qs.name,
      in: 'query' as const,
      required: false,
      example: qs.value,
    }));

    // Path params from template
    const pathParamNames = [...(pathTemplate.match(/\{([^}]+)\}/g) || [])].map(p => p.slice(1, -1));
    const pathParams: ParsedParameter[] = pathParamNames.map(name => ({
      name,
      in: 'path' as const,
      required: true,
    }));

    const parsedBody = parseHarBody(req.postData);
    const hasFileUpload = req.postData?.mimeType?.includes('multipart/form-data') ?? false;

    const contentType = req.headers.find(h => h.name.toLowerCase() === 'content-type')?.value || 'application/json';

    const operationId = `${method.toLowerCase()}_${pathTemplate.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

    const endpointIndex = endpoints.length;
    seenOperations.set(opKey, endpointIndex);

    // Try to infer response schema from HAR response
    let responseBody: any;
    if (entry.response.content?.text) {
      try {
        responseBody = JSON.parse(entry.response.content.text);
      } catch {
        responseBody = undefined;
      }
    }

    endpoints.push({
      operationId,
      method,
      path: pathTemplate,
      summary: `${method} ${pathTemplate}`,
      tags: [],
      parameters: [...pathParams, ...queryParams],
      requestBody: parsedBody ? {
        contentType,
        schema: parsedBody,
        required: true,
        example: parsedBody,
      } : undefined,
      responses: {
        [String(entry.response.status || 200)]: {
          description: 'OK',
          schema: responseBody,
        },
      },
      security,
      hasFileUpload,
    });
  }

  // Detect base URL from most common host
  if (!baseUrl && apiEntries.length > 0) {
    try {
      baseUrl = new URL(apiEntries[0].request.url).origin;
    } catch {
      baseUrl = '';
    }
  }

  ensureUniqueOperationIds(endpoints);

  logger.info('[HAR_ADAPTER] Parsed HAR file', {
    totalEntries: har.log.entries.length,
    apiEntries: apiEntries.length,
    uniqueEndpoints: endpoints.length,
  });

  return {
    title: `API (from HAR - ${har.log.creator?.name || 'Browser'})`,
    version: '1.0.0',
    specVersion: `har-${har.log.version || '1.2'}`,
    baseUrl,
    authSchemes: endpoints.some(e => e.security.length > 0)
      ? [{ name: 'bearerAuth', type: 'bearer' }]
      : [],
    endpoints,
    unsupportedEndpoints: [],
    sourceType: 'har',
  };
}
