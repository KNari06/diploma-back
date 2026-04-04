/**
 * OpenAPI / Swagger Adapter
 * Parses OpenAPI 2.0, 3.0.x, 3.1.x specs from URL or raw JSON/YAML content
 * Uses @apidevtools/swagger-parser for $ref resolution and validation
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV2, OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import { logger } from '@/utils/core/logger';
import type {
  ApiSpecSourceType,
  AuthScheme,
  HttpMethod,
  ParsedApiSpec,
  ParsedEndpoint,
  ParsedParameter,
  ParsedRequestBody,
  ParsedResponse,
  UnsupportedEndpoint,
} from '../flow.types';

// Content types that indicate non-REST endpoints we can't test
const UNSUPPORTED_CONTENT_TYPES = ['text/event-stream', 'application/octet-stream'];
const FILE_UPLOAD_CONTENT_TYPES = ['multipart/form-data', 'application/octet-stream'];

function detectSpecVersion(doc: any): string {
  if (doc.openapi) return doc.openapi; // 3.0.x or 3.1.x
  if (doc.swagger) return doc.swagger; // 2.0
  return 'unknown';
}

function detectUnsupportedEndpoint(
  method: string,
  path: string,
  operation: any
): UnsupportedEndpoint | null {
  // Check x-websocket extension
  if (operation['x-websocket'] || operation['x-ws']) {
    return { method, path, reason: 'websocket' };
  }

  // Check response content types for SSE
  const responses = operation.responses || {};
  for (const [, resp] of Object.entries(responses)) {
    const r = resp as any;
    const content = r?.content || {};
    for (const contentType of Object.keys(content)) {
      if (contentType.includes('text/event-stream')) {
        return { method, path, reason: 'sse' };
      }
      if (UNSUPPORTED_CONTENT_TYPES.some(t => contentType.includes(t))) {
        return { method, path, reason: 'unsupported_content_type' };
      }
    }
  }

  return null;
}

function isFileUploadEndpoint(operation: any): boolean {
  const requestBody = operation.requestBody || {};
  const content = requestBody.content || {};
  return FILE_UPLOAD_CONTENT_TYPES.some(t => t in content);
}

function isPaginationEndpoint(operation: any): boolean {
  const params: any[] = operation.parameters || [];
  const paginationParams = ['page', 'limit', 'offset', 'cursor', 'per_page', 'pageSize', 'skip', 'take'];
  return params.some((p: any) =>
    p.in === 'query' && paginationParams.includes((p.name || '').toLowerCase())
  );
}

function extractAuthSchemes(doc: any, specVersion: string): AuthScheme[] {
  const schemes: AuthScheme[] = [];

  if (specVersion.startsWith('2')) {
    // Swagger 2.0
    const secDefs = doc.securityDefinitions || {};
    for (const [name, def] of Object.entries(secDefs)) {
      const d = def as any;
      if (d.type === 'apiKey') {
        schemes.push({ name, type: 'apiKey', in: d.in, headerName: d.name, description: d.description });
      } else if (d.type === 'basic') {
        schemes.push({ name, type: 'basic', description: d.description });
      } else if (d.type === 'oauth2') {
        schemes.push({ name, type: 'oauth2', description: d.description });
      }
    }
  } else {
    // OpenAPI 3.x
    const secSchemes = doc.components?.securitySchemes || {};
    for (const [name, def] of Object.entries(secSchemes)) {
      const d = def as any;
      if (d.type === 'http') {
        const t = d.scheme === 'bearer' ? 'bearer' : 'basic';
        schemes.push({ name, type: t, description: d.description });
      } else if (d.type === 'apiKey') {
        schemes.push({ name, type: 'apiKey', in: d.in, headerName: d.name, description: d.description });
      } else if (d.type === 'oauth2') {
        schemes.push({ name, type: 'oauth2', description: d.description });
      } else if (d.type === 'openIdConnect') {
        schemes.push({ name, type: 'openIdConnect', description: d.description });
      }
    }
  }

  return schemes;
}

function extractBaseUrl(doc: any, specVersion: string): string {
  if (specVersion.startsWith('2')) {
    const scheme = (doc.schemes || ['https'])[0];
    const host = doc.host || 'localhost';
    const basePath = doc.basePath || '';
    return `${scheme}://${host}${basePath}`;
  } else {
    // OpenAPI 3.x — use first server
    const servers: any[] = doc.servers || [];
    if (servers.length > 0) {
      // Replace server variables with defaults
      let url: string = servers[0].url || '';
      const vars = servers[0].variables || {};
      for (const [varName, varDef] of Object.entries(vars)) {
        const v = varDef as any;
        url = url.replace(`{${varName}}`, v.default || varName);
      }
      return url;
    }
    return '';
  }
}

function parseParameters(params: any[]): ParsedParameter[] {
  return (params || []).map((p: any) => ({
    name: p.name || '',
    in: p.in as ParsedParameter['in'],
    required: !!p.required,
    schema: p.schema || (p.type ? { type: p.type } : undefined),
    description: p.description,
    example: p.example,
  }));
}

function parseRequestBody(operation: any, specVersion: string): ParsedRequestBody | undefined {
  if (specVersion.startsWith('2')) {
    // Swagger 2.0: body parameter
    const bodyParam = (operation.parameters || []).find((p: any) => p.in === 'body');
    if (!bodyParam) return undefined;
    return {
      contentType: 'application/json',
      schema: bodyParam.schema,
      required: !!bodyParam.required,
      example: bodyParam.example,
    };
  } else {
    // OpenAPI 3.x
    const rb = operation.requestBody;
    if (!rb) return undefined;
    const content = rb.content || {};
    // Prefer application/json over other content types
    const contentType = content['application/json']
      ? 'application/json'
      : (Object.keys(content)[0] || 'application/json');
    const mediaType = content[contentType] || {};
    return {
      contentType,
      schema: mediaType.schema,
      required: !!rb.required,
      example: mediaType.example,
    };
  }
}

function parseResponses(responses: Record<string, any>): Record<string, ParsedResponse> {
  const result: Record<string, ParsedResponse> = {};
  for (const [statusCode, resp] of Object.entries(responses || {})) {
    const r = resp as any;
    // Try to extract schema from content (OAS3) or schema (Swagger 2)
    let schema: any;
    let example: any;
    if (r.content) {
      const firstContent = Object.values(r.content)[0] as any;
      schema = firstContent?.schema;
      example = firstContent?.example;
    } else if (r.schema) {
      schema = r.schema;
    }
    result[statusCode] = {
      description: r.description || '',
      schema,
      example,
    };
  }
  return result;
}

function getOperationSecurity(operation: any, docSecurity: any[]): string[] {
  const security = operation.security !== undefined ? operation.security : (docSecurity || []);
  const names: string[] = [];
  for (const s of security) {
    names.push(...Object.keys(s));
  }
  return [...new Set(names)];
}

/**
 * Parse OpenAPI/Swagger spec from URL or raw content string
 */
export async function parseOpenApiSpec(
  input: { url: string } | { content: string; fileName?: string },
  sourceType: ApiSpecSourceType
): Promise<ParsedApiSpec> {
  let doc: OpenAPI.Document;

  try {
    if ('url' in input) {
      logger.info('[OPENAPI_ADAPTER] Fetching and parsing spec from URL', { url: input.url });
      doc = await SwaggerParser.dereference(input.url) as OpenAPI.Document;
    } else {
      // Parse raw content (JSON or YAML)
      logger.info('[OPENAPI_ADAPTER] Parsing spec from file content', {
        fileName: input.fileName,
        contentLength: input.content.length,
      });
      // SwaggerParser.parse() expects a file path, not a raw string.
      // Parse JSON/YAML to object first, then dereference.
      let rawObj: any;
      const trimmed = input.content.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        rawObj = JSON.parse(trimmed);
      } else {
        // YAML content — use js-yaml (bundled with swagger-parser)
        const yaml = await import('js-yaml');
        rawObj = yaml.load(trimmed);
        if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
          throw new Error('Invalid API spec: expected a YAML/JSON object with OpenAPI structure');
        }
      }
      doc = await SwaggerParser.dereference(rawObj) as OpenAPI.Document;
    }
  } catch (error: any) {
    throw new Error(`Failed to parse OpenAPI spec: ${error.message}`);
  }

  const anyDoc = doc as any;
  const specVersion = detectSpecVersion(anyDoc);
  const baseUrl = extractBaseUrl(anyDoc, specVersion);
  const authSchemes = extractAuthSchemes(anyDoc, specVersion);
  const docSecurity: any[] = anyDoc.security || [];

  const endpoints: ParsedEndpoint[] = [];
  const unsupportedEndpoints: UnsupportedEndpoint[] = [];

  const paths = anyDoc.paths || {};
  for (const [path, pathItem] of Object.entries(paths)) {
    const pi = pathItem as any;
    const httpMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

    for (const method of httpMethods) {
      const operation = pi[method.toLowerCase()];
      if (!operation) continue;

      const unsupported = detectUnsupportedEndpoint(method, path, operation);
      if (unsupported) {
        unsupportedEndpoints.push(unsupported);
        continue;
      }

      // Merge path-level parameters with operation-level
      const pathParams = pi.parameters || [];
      const opParams = operation.parameters || [];
      const allParams = [...pathParams, ...opParams];

      // Deduplicate params by (name + in)
      const seenParams = new Set<string>();
      const dedupedParams = allParams.filter((p: any) => {
        const key = `${p.name}:${p.in}`;
        if (seenParams.has(key)) return false;
        seenParams.add(key);
        return true;
      });

      // Filter out body params from OAS2 (they'll be in requestBody)
      const nonBodyParams = specVersion.startsWith('2')
        ? dedupedParams.filter((p: any) => p.in !== 'body')
        : dedupedParams;

      // Generate unique operationId: use spec's operationId if available,
      // otherwise method_path (sanitized). Append _N suffix if collision detected.
      let operationId = operation.operationId
        || `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
      const seenOpIds = new Set(endpoints.map(e => e.operationId));
      if (seenOpIds.has(operationId)) {
        let suffix = 2;
        while (seenOpIds.has(`${operationId}_${suffix}`)) suffix++;
        operationId = `${operationId}_${suffix}`;
      }

      endpoints.push({
        operationId,
        method,
        path,
        summary: operation.summary || `${method} ${path}`,
        description: operation.description,
        tags: operation.tags || [],
        parameters: parseParameters(nonBodyParams),
        requestBody: parseRequestBody(operation, specVersion),
        responses: parseResponses(operation.responses),
        security: getOperationSecurity(operation, docSecurity),
        deprecated: !!operation.deprecated,
        hasFileUpload: isFileUploadEndpoint(operation),
        isPagination: isPaginationEndpoint(operation),
      });
    }
  }

  const title = anyDoc.info?.title || 'API';
  const version = anyDoc.info?.version || '1.0.0';

  if (endpoints.length === 0 && unsupportedEndpoints.length === 0) {
    throw new Error('No API endpoints found in spec. The spec may be empty or all endpoints are unsupported.');
  }

  logger.info('[OPENAPI_ADAPTER] Parsed spec successfully', {
    title,
    specVersion,
    totalEndpoints: endpoints.length + unsupportedEndpoints.length,
    supported: endpoints.length,
    unsupported: unsupportedEndpoints.length,
  });

  return {
    title,
    version,
    specVersion,
    baseUrl,
    description: anyDoc.info?.description,
    authSchemes,
    endpoints,
    unsupportedEndpoints,
    sourceType,
    rawSpec: anyDoc,
  };
}
