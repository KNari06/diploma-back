/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UNIVERSAL SPEC PARSER SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Detects the format of an API specification (OpenAPI, Postman, cURL, HAR,
 * Insomnia) and delegates to the appropriate adapter.
 *
 * All adapters output the same unified ParsedApiSpec interface.
 */

import { logger } from '@/utils/core/logger';
import type { ApiSpecSourceType, ParsedApiSpec } from './flow.types';
import { parseOpenApiSpec } from './adapters/openapi.adapter';
import { parsePostmanCollection } from './adapters/postman.adapter';
import { parseCurlCommands } from './adapters/curl.adapter';
import { parseHarFile } from './adapters/har.adapter';
import { parseInsomniaExport } from './adapters/insomnia.adapter';

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function detectFormat(content: string, fileName?: string): ApiSpecSourceType {
  const lower = (fileName || '').toLowerCase();

  // File extension hints
  if (lower.endsWith('.har')) return 'har';
  if (lower.endsWith('.raml')) return 'raml';

  // Try JSON parse for structural detection
  try {
    const parsed = JSON.parse(content);

    // HAR: { log: { entries: [...] } }
    if (parsed.log?.entries && Array.isArray(parsed.log.entries)) {
      return 'har';
    }

    // Postman Collection v2.x: { info: { schema: "..." }, item: [...] }
    if (parsed.info?.schema && parsed.item) {
      return 'postman';
    }

    // Insomnia export: { resources: [...], __export_format: 4 }
    if (Array.isArray(parsed.resources) && parsed.__export_format !== undefined) {
      return 'insomnia';
    }
    if (Array.isArray(parsed.resources) && parsed.resources.some((r: any) => r._type === 'request')) {
      return 'insomnia';
    }

    // OpenAPI 3.x: { openapi: "3.x.x", ... }
    if (typeof parsed.openapi === 'string' && parsed.openapi.startsWith('3')) {
      return 'openapi_file';
    }

    // Swagger 2.0: { swagger: "2.0", ... }
    if (parsed.swagger === '2.0') {
      return 'openapi_file';
    }

    // GraphQL introspection: { data: { __schema: { ... } } }
    if (parsed.data?.__schema || parsed.__schema) {
      return 'graphql';
    }
  } catch {
    // Not JSON — could be YAML or curl commands
  }

  // YAML OpenAPI detection (starts with "openapi:" or "swagger:")
  const trimmed = content.trim();
  if (trimmed.startsWith('openapi:') || trimmed.startsWith('swagger:')) {
    return 'openapi_file';
  }
  if (trimmed.startsWith('%YAML') || trimmed.includes('\nopenapi:') || trimmed.includes('\nswagger:')) {
    return 'openapi_file';
  }

  // RAML: starts with #%RAML
  if (trimmed.startsWith('#%RAML')) {
    return 'raml';
  }

  // cURL commands
  if (trimmed.toLowerCase().startsWith('curl ') || trimmed.toLowerCase().includes('\ncurl ')) {
    return 'curl';
  }

  // Fallback: try to parse as OpenAPI
  return 'openapi_file';
}

function detectUrlFormat(url: string): ApiSpecSourceType {
  const lower = url.toLowerCase();

  if (lower.endsWith('.json') || lower.includes('swagger') || lower.includes('openapi') || lower.includes('api-docs')) {
    return 'openapi_url';
  }

  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'openapi_url';
  }

  if (lower.includes('graphql') && (lower.includes('introspect') || lower.includes('schema'))) {
    return 'graphql';
  }

  // Default: try to fetch and parse as OpenAPI
  return 'openapi_url';
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PARSER SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class SpecParserService {
  /**
   * Parse an API spec from a URL.
   * Auto-detects format based on URL pattern.
   */
  static async parseFromUrl(url: string): Promise<ParsedApiSpec> {
    logger.info('[SPEC_PARSER] Parsing from URL', { url });

    const sourceType = detectUrlFormat(url);

    if (sourceType === 'openapi_url') {
      return parseOpenApiSpec({ url }, 'openapi_url');
    }

    // For GraphQL: fetch the schema introspection
    if (sourceType === 'graphql') {
      throw new Error('GraphQL spec parsing from URL is not yet supported. Please export the schema as JSON and upload it.');
    }

    // Fallback: fetch and try to detect format from content
    logger.info('[SPEC_PARSER] Fetching spec content from URL for format detection', { url });
    const response = await fetch(url, {
      headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch spec from URL: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    const detectedFormat = detectFormat(content, url.split('/').pop());

    return SpecParserService.parseFromContent(content, detectedFormat, url.split('/').pop());
  }

  /**
   * Parse an API spec from raw string content (file upload).
   * Auto-detects format if not specified.
   */
  static async parseFromContent(
    content: string,
    formatHint?: ApiSpecSourceType,
    fileName?: string,
  ): Promise<ParsedApiSpec> {
    const format = formatHint || detectFormat(content, fileName);
    logger.info('[SPEC_PARSER] Parsing from content', { format, fileName, contentLength: content.length });

    switch (format) {
      case 'openapi_file':
        return parseOpenApiSpec({ content, fileName }, 'openapi_file');

      case 'openapi_url':
        // Content was fetched from URL but passed here — treat as file
        return parseOpenApiSpec({ content, fileName }, 'openapi_file');

      case 'postman':
        return parsePostmanCollection(content);

      case 'curl':
        return parseCurlCommands(content);

      case 'har':
        return parseHarFile(content);

      case 'insomnia':
        return parseInsomniaExport(content);

      case 'raml':
        throw new Error('RAML format is not yet supported. Please convert to OpenAPI using https://www.mulesoft.com/platform/api/api-designer');

      case 'graphql':
        throw new Error('GraphQL spec format is not yet fully supported. Export your schema as introspection JSON and try again.');

      default:
        throw new Error(`Unsupported API spec format: ${format}`);
    }
  }

  /**
   * Auto-detect format of content string.
   * Useful for frontend to display detected format before parsing.
   */
  static detectFormat(content: string, fileName?: string): ApiSpecSourceType {
    return detectFormat(content, fileName);
  }
}
