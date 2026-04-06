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
import type { ApiSpecSourceType, FlowQuestion, ParsedApiSpec } from './flow.types';
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

  // Detect HTML (Swagger UI page uploaded instead of spec file)
  const trimmedContent = content.trim();
  if (trimmedContent.startsWith('<!') || trimmedContent.startsWith('<html') || trimmedContent.startsWith('<HTML')) {
    throw new Error(
      'This appears to be an HTML page (likely Swagger UI), not an API spec file. ' +
      'Please provide the actual spec URL (usually ends with .json or .yaml) or download and upload the spec file.'
    );
  }

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

/**
 * Detect if URL points to Swagger UI (HTML page) instead of the actual spec file.
 * If so, try to discover the real spec URL.
 */
function isSwaggerUiUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('swagger-ui') ||
    lower.includes('swaggerui') ||
    (lower.includes('swagger') && lower.endsWith('.html')) ||
    (lower.includes('swagger') && lower.includes('index.html')) ||
    lower.endsWith('/swagger/') ||
    lower.endsWith('/swagger')
  );
}

/**
 * Given a Swagger UI URL, try common spec file paths to find the actual spec.
 */
export interface SpecGroup {
  url: string;
  name: string;
}

async function discoverSpecUrl(swaggerUiUrl: string): Promise<string | SpecGroup[]> {
  // Extract base URL (strip /swagger-ui/index.html or similar suffixes)
  let baseUrl: string;
  try {
    const parsed = new URL(swaggerUiUrl);
    // Try stripping various swagger-ui paths
    const pathParts = parsed.pathname.split('/');
    const swaggerIdx = pathParts.findIndex(p => /swagger-?ui/i.test(p) || p === 'swagger');
    if (swaggerIdx > 0) {
      baseUrl = `${parsed.origin}${pathParts.slice(0, swaggerIdx).join('/')}`;
    } else {
      baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/?(index\.html|swagger-ui\.html).*/, '')}`;
    }
  } catch {
    throw new Error('Invalid URL');
  }

  // Common spec paths to try (ordered by likelihood)
  const candidates = [
    `${baseUrl}/v3/api-docs`,
    `${baseUrl}/swagger.json`,
    `${baseUrl}/openapi.json`,
    `${baseUrl}/v2/api-docs`,
    `${baseUrl}/api-docs`,
    `${baseUrl}/openapi.yaml`,
    `${baseUrl}/swagger.yaml`,
    `${baseUrl}/v3/api-docs.yaml`,
  ];

  logger.info('[SPEC_PARSER] Swagger UI detected, discovering spec URL', {
    swaggerUiUrl,
    baseUrl,
  });

  const origin = new URL(swaggerUiUrl).origin;

  // ── Step 1: Try to find configUrl from swagger-initializer.js (multi-spec support) ──
  try {
    // Resolve the swagger-initializer.js URL relative to the Swagger UI HTML
    const uiBase = swaggerUiUrl.replace(/\/?(index\.html)?(\?.*)?(\#.*)?$/, '');
    const initRes = await fetch(`${uiBase}/swagger-initializer.js`, { signal: AbortSignal.timeout(5000) });
    if (initRes.ok) {
      const initJs = await initRes.text();
      const configUrlMatch = initJs.match(/["']?configUrl["']?\s*:\s*["']([^"']+)["']/);
      if (configUrlMatch?.[1]) {
        let configUrl = configUrlMatch[1];
        if (configUrl.startsWith('/')) configUrl = `${origin}${configUrl}`;
        else if (!configUrl.startsWith('http')) configUrl = `${baseUrl}/${configUrl}`;

        const configRes = await fetch(configUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (configRes.ok) {
          const config: any = await configRes.json();
          // Multi-spec: config has urls[] array
          if (Array.isArray(config.urls) && config.urls.length > 0) {
            const groups: SpecGroup[] = config.urls.map((u: any) => ({
              name: u.name || u.url,
              url: u.url?.startsWith('/') ? `${origin}${u.url}` : u.url,
            }));
            logger.info('[SPEC_PARSER] Multi-spec Swagger UI found', {
              groupCount: groups.length,
              groups: groups.map(g => g.name),
            });
            // If only one spec, use it directly. Otherwise let user choose.
            // Don't auto-select "All API" — it's often too large (1000+ endpoints)
            if (groups.length === 1) return groups[0].url;
            return groups; // Return list for user to choose
          }
          // Single spec: config has url field
          if (config.url) {
            const specUrl = config.url.startsWith('/') ? `${origin}${config.url}` : config.url;
            return specUrl;
          }
        }
      }

      // Also check if initializer has a direct url: "..." (single spec)
      const directUrlMatch = initJs.match(/\burl\s*:\s*["']([^"']+\.(?:json|yaml|yml))["']/);
      if (directUrlMatch?.[1]) {
        const specUrl = directUrlMatch[1].startsWith('/') ? `${origin}${directUrlMatch[1]}` : directUrlMatch[1];
        return specUrl;
      }
    }
  } catch {
    // swagger-initializer.js not found or parse error — continue
  }

  // ── Step 2: Try common config endpoints directly ──
  for (const configPath of [`${baseUrl}/api-docs/swagger-config`, `${baseUrl}/v3/api-docs/swagger-config`]) {
    try {
      const res = await fetch(configPath, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const config: any = await res.json();
        if (Array.isArray(config.urls) && config.urls.length > 0) {
          const groups: SpecGroup[] = config.urls.map((u: any) => ({
            name: u.name || u.url,
            url: u.url?.startsWith('/') ? `${origin}${u.url}` : u.url,
          }));
          if (groups.length === 1) return groups[0].url;
          return groups;
        }
      }
    } catch { /* continue */ }
  }

  // ── Step 3: Try standard single-spec endpoints ──

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        headers: { Accept: 'application/json, application/yaml, */*' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        const text = await res.text();
        // Verify it's not HTML
        if (!text.trim().startsWith('<!') && !text.trim().startsWith('<html')) {
          logger.info('[SPEC_PARSER] Found spec at', { candidate });
          return candidate;
        }
      }
    } catch {
      // Try next candidate
    }
  }

  // Also try to parse the Swagger UI HTML to find the spec URL
  try {
    const htmlRes = await fetch(swaggerUiUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      // Look for configUrl or url in SwaggerUI initialization
      const urlMatch = html.match(/url\s*[:=]\s*["']([^"']+\.(?:json|yaml|yml))['"]/i)
        || html.match(/["']([^"']*\/(?:api-docs|swagger|openapi)[^"']*)['"]/i)
        || html.match(/configUrl\s*[:=]\s*["']([^"']+)['"]/i);
      if (urlMatch?.[1]) {
        let specPath = urlMatch[1];
        if (specPath.startsWith('/')) {
          const parsed = new URL(swaggerUiUrl);
          specPath = `${parsed.origin}${specPath}`;
        } else if (!specPath.startsWith('http')) {
          specPath = `${baseUrl}/${specPath}`;
        }
        logger.info('[SPEC_PARSER] Extracted spec URL from HTML', { specPath });
        return specPath;
      }
    }
  } catch {
    // HTML parsing failed
  }

  throw new Error(
    `This URL points to Swagger UI (the visual interface), not the API spec file. ` +
    `Tried: ${candidates.slice(0, 4).join(', ')} — none responded. ` +
    `Please provide the direct URL to the spec file (usually ends with .json or .yaml), ` +
    `or open Swagger UI in your browser, find the spec URL in the top bar, and paste that instead.`
  );
}

export class SpecParserService {
  /**
   * Parse an API spec from a URL.
   * Auto-detects Swagger UI pages and discovers the actual spec URL.
   */
  static async parseFromUrl(url: string): Promise<ParsedApiSpec> {
    logger.info('[SPEC_PARSER] Parsing from URL', { url });

    // If URL points to Swagger UI page, discover the actual spec URL first
    if (isSwaggerUiUrl(url)) {
      const discovered = await discoverSpecUrl(url);

      // Multi-spec: return choices as a special error that the caller handles
      if (Array.isArray(discovered)) {
        const error: any = new Error('MULTI_SPEC');
        error.specGroups = discovered;
        throw error;
      }

      logger.info('[SPEC_PARSER] Resolved Swagger UI to spec URL', { from: url, to: discovered });
      return parseOpenApiSpec({ url: discovered }, 'openapi_url');
    }

    const sourceType = detectUrlFormat(url);

    if (sourceType === 'openapi_url') {
      // Fetch first to check if it's HTML (another Swagger UI variant)
      try {
        const probe = await fetch(url, {
          headers: { Accept: 'application/json, application/yaml, */*' },
          signal: AbortSignal.timeout(10000),
        });
        if (probe.ok) {
          const text = await probe.text();
          if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
            // Got HTML instead of spec — try to discover
            logger.warn('[SPEC_PARSER] URL returned HTML, attempting spec discovery', { url });
            const discovered = await discoverSpecUrl(url);
            if (Array.isArray(discovered)) {
              const error: any = new Error('MULTI_SPEC');
              error.specGroups = discovered;
              throw error;
            }
            return parseOpenApiSpec({ url: discovered }, 'openapi_url');
          }
          // Got JSON/YAML — parse it
          return SpecParserService.parseFromContent(text, 'openapi_file', url.split('/').pop());
        }
      } catch {
        // Probe failed — try direct parse as fallback
      }
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
