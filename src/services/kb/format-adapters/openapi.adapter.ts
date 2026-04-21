/**
 * OpenAPI / Swagger adapter
 *
 * Turns an OpenAPI 2/3 spec into one chunk per (method, path) operation, plus
 * one chunk per named schema. Each operation chunk packs the concrete facts a
 * test-authoring AI needs: HTTP method, full path, servers/base URL, summary,
 * description, params, request body shape, response shapes, auth scheme names.
 * This maps directly to the "generate an API test for POST /users" use case
 * without forcing the LLM to hunt through a 10k-line spec.
 */

import yaml from 'js-yaml';
import { AdapterChunk, AdapterResult, FormatAdapter } from './types';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function looksLikeOpenAPIJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    return typeof obj === 'object' && obj !== null && (
      typeof obj.openapi === 'string' ||
      typeof obj.swagger === 'string'
    );
  } catch {
    return false;
  }
}

function looksLikeOpenAPIYaml(raw: string): boolean {
  // Cheap prefix check to avoid yaml.load on non-yaml files
  const head = raw.slice(0, 4000).toLowerCase();
  if (!/^\s*(openapi|swagger)\s*:/m.test(head)) return false;
  try {
    const doc = yaml.load(raw);
    return typeof doc === 'object' && doc !== null && (
      typeof (doc as Record<string, unknown>).openapi === 'string' ||
      typeof (doc as Record<string, unknown>).swagger === 'string'
    );
  } catch {
    return false;
  }
}

function parseSpec(raw: string): Record<string, unknown> | null {
  try {
    if (raw.trimStart().startsWith('{')) {
      return JSON.parse(raw) as Record<string, unknown>;
    }
    const doc = yaml.load(raw);
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function short(s: unknown, max = 240): string {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/**
 * Extract the final component of a `$ref` without resolving it.
 * "#/components/schemas/User" → "User" ; "#/definitions/Pet" → "Pet"
 * Returns null if not a ref.
 */
function refName(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const ref = (v as Record<string, unknown>).$ref;
  if (typeof ref !== 'string') return null;
  const tail = ref.split('/').pop();
  return tail ? tail : null;
}

/**
 * One-line summary of a schema node. Handles $ref, arrays, composition
 * (allOf/oneOf/anyOf), enums, and primitives. Returns a *readable* string —
 * not a full resolved schema. The point is to give the LLM enough hint to
 * know what shape it's dealing with.
 */
function describeSchemaInline(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any';
  if (depth > 3) return '…';

  const s = schema as Record<string, unknown>;

  const ref = refName(s);
  if (ref) return `$ref:${ref}`;

  // Composition: allOf / oneOf / anyOf
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) {
    const v = s[k];
    if (Array.isArray(v) && v.length > 0) {
      const parts = v.slice(0, 5).map((n) => describeSchemaInline(n, depth + 1));
      return `${k}(${parts.join(' | ')})`;
    }
  }

  // Array
  if (s.type === 'array') {
    return `array<${describeSchemaInline(s.items, depth + 1)}>`;
  }

  // Enum
  if (Array.isArray(s.enum)) {
    const values = (s.enum as unknown[])
      .slice(0, 8)
      .map((e) => (typeof e === 'string' ? `"${e}"` : String(e)))
      .join(' | ');
    const suffix = (s.enum as unknown[]).length > 8 ? ' | …' : '';
    return `enum(${values}${suffix})`;
  }

  // Object with inline properties
  if (s.type === 'object' || s.properties) {
    const props = s.properties && typeof s.properties === 'object'
      ? Object.keys(s.properties as Record<string, unknown>)
      : [];
    if (props.length === 0) return 'object';
    return `object{${props.slice(0, 6).join(', ')}${props.length > 6 ? ', …' : ''}}`;
  }

  // Primitive
  if (typeof s.type === 'string') {
    const fmt = typeof s.format === 'string' ? `:${s.format}` : '';
    return `${s.type}${fmt}`;
  }

  return 'any';
}

function listServers(spec: Record<string, unknown>): string[] {
  // OpenAPI 3: servers[] with .url
  if (Array.isArray(spec.servers)) {
    return (spec.servers as unknown[])
      .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>).url : null))
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
  }
  // Swagger 2: host + basePath + schemes
  const host = typeof spec.host === 'string' ? spec.host : '';
  const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
  const schemes = Array.isArray(spec.schemes)
    ? (spec.schemes as unknown[]).filter((x) => typeof x === 'string') as string[]
    : [];
  if (host && schemes.length > 0) {
    return schemes.map((s) => `${s}://${host}${basePath}`);
  }
  if (host) {
    return [`https://${host}${basePath}`];
  }
  return [];
}

function describeOperation(
  specVersion: string,
  servers: string[],
  path: string,
  method: HttpMethod,
  op: Record<string, unknown>,
  pathLevelParams: unknown
): AdapterChunk {
  const METHOD = method.toUpperCase();
  const summary = short(op.summary);
  const description = short(op.description, 1200);
  const operationId = typeof op.operationId === 'string' ? op.operationId : undefined;
  const tags = Array.isArray(op.tags) ? (op.tags as unknown[]).filter((t) => typeof t === 'string') as string[] : [];

  // Params: merge path-level + operation-level
  const params: unknown[] = [];
  if (Array.isArray(pathLevelParams)) params.push(...(pathLevelParams as unknown[]));
  if (Array.isArray(op.parameters)) params.push(...(op.parameters as unknown[]));

  const paramLines: string[] = [];
  const referencedSchemas = new Set<string>();
  for (const p of params) {
    if (!p || typeof p !== 'object') continue;
    const pp = p as Record<string, unknown>;
    // Parameter can itself be a $ref to #/components/parameters/X
    const paramRef = refName(pp);
    if (paramRef) {
      paramLines.push(`  - $ref: ${paramRef}`);
      continue;
    }
    const loc = typeof pp.in === 'string' ? pp.in : '?';
    const name = typeof pp.name === 'string' ? pp.name : '?';
    const required = pp.required === true ? ' (required)' : '';
    const desc = short(pp.description, 120);
    const shape = describeSchemaInline(pp.schema ?? pp);
    const sref = refName(pp.schema);
    if (sref) referencedSchemas.add(sref);
    paramLines.push(`  - ${loc}: ${name}${required} [${shape}]${desc ? ` — ${desc}` : ''}`);
  }

  // Request body
  let requestBody: string | null = null;
  if (op.requestBody && typeof op.requestBody === 'object') {
    const rb = op.requestBody as Record<string, unknown>;
    const required = rb.required === true ? ' (required)' : '';
    const content = rb.content as Record<string, unknown> | undefined;
    const mediaTypes = content && typeof content === 'object' ? Object.keys(content) : [];
    requestBody = `Request body${required}: ${mediaTypes.join(', ') || '(unspecified)'}`;
    // Inline description of each media type's schema
    if (content) {
      for (const mt of mediaTypes) {
        const cm = content[mt] as Record<string, unknown> | undefined;
        const schema = cm?.schema;
        const shape = describeSchemaInline(schema);
        const sref = refName(schema);
        if (sref) referencedSchemas.add(sref);
        requestBody += `\n  ${mt}: ${shape}`;
      }
    }
  }

  // Responses
  const responses: string[] = [];
  if (op.responses && typeof op.responses === 'object') {
    for (const [status, resp] of Object.entries(op.responses as Record<string, unknown>)) {
      if (!resp || typeof resp !== 'object') continue;
      const rr = resp as Record<string, unknown>;
      const rdesc = short(rr.description, 160) || '';
      const content = rr.content as Record<string, unknown> | undefined;
      const mediaTypes = content && typeof content === 'object' ? Object.keys(content) : [];
      let line = `  ${status}: ${rdesc}`;
      if (mediaTypes.length > 0) {
        line += ` (${mediaTypes.join(', ')})`;
        // Add schema shape for the first media type
        const first = content![mediaTypes[0]] as Record<string, unknown> | undefined;
        const shape = describeSchemaInline(first?.schema);
        const sref = refName(first?.schema);
        if (sref) referencedSchemas.add(sref);
        if (shape && shape !== 'any') line += ` → ${shape}`;
      }
      responses.push(line);
    }
  }

  // Security
  const security = Array.isArray(op.security) ? op.security : null;
  const securityLine = security && security.length > 0
    ? `Security: ${security.map((s) => Object.keys(s || {}).join(' + ')).join(' OR ') || '(none)'}`
    : null;

  // Assemble chunk — order matters for retrieval (path+method first)
  const parts: string[] = [];
  parts.push(`${METHOD} ${path}`);
  if (summary) parts.push(summary);
  if (operationId) parts.push(`operationId: ${operationId}`);
  if (tags.length > 0) parts.push(`tags: ${tags.join(', ')}`);
  if (servers.length > 0) parts.push(`servers: ${servers.slice(0, 3).join(', ')}`);
  if (description) parts.push('', description);
  if (paramLines.length > 0) parts.push('', 'Parameters:', ...paramLines);
  if (requestBody) parts.push('', requestBody);
  if (responses.length > 0) parts.push('', 'Responses:', ...responses);
  if (securityLine) parts.push('', securityLine);
  if (referencedSchemas.size > 0) {
    parts.push('', `References schemas: ${Array.from(referencedSchemas).join(', ')}`);
  }
  parts.push('', `OpenAPI ${specVersion}`);

  return {
    content: parts.join('\n'),
    sectionTitle: `${METHOD} ${path}`,
    metadata: {
      format: 'openapi',
      http_method: METHOD,
      path,
      operation_id: operationId,
      tags,
      servers,
      has_request_body: !!op.requestBody,
      referenced_schemas: Array.from(referencedSchemas),
      status_codes: op.responses && typeof op.responses === 'object'
        ? Object.keys(op.responses as Record<string, unknown>)
        : [],
    },
  };
}

function describeSchema(name: string, schema: Record<string, unknown>): AdapterChunk {
  const description = short(schema.description, 600);
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((r) => typeof r === 'string') as string[]
    : [];

  const parts: string[] = [];
  parts.push(`Schema: ${name}`);
  if (type) parts.push(`type: ${type}`);
  if (description) parts.push('', description);

  // Composition: allOf/oneOf/anyOf
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) {
    const v = schema[k];
    if (Array.isArray(v) && v.length > 0) {
      const parts2 = (v as unknown[]).slice(0, 8).map((n) => describeSchemaInline(n));
      parts.push('', `${k}: ${parts2.join(' | ')}`);
    }
  }

  // Enum values (printable)
  if (Array.isArray(schema.enum)) {
    const values = (schema.enum as unknown[])
      .slice(0, 16)
      .map((e) => (typeof e === 'string' ? `"${e}"` : String(e)));
    parts.push('', `enum: ${values.join(', ')}`);
  }

  // Array items
  if (type === 'array' && schema.items) {
    parts.push('', `items: ${describeSchemaInline(schema.items)}`);
  }

  // Object properties
  const props: string[] = [];
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [pname, pdef] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (!pdef || typeof pdef !== 'object') continue;
      const pp = pdef as Record<string, unknown>;
      const shape = describeSchemaInline(pp);
      const pdesc = short(pp.description, 80);
      const req = required.includes(pname) ? ' (required)' : '';
      props.push(`  - ${pname}${req}: ${shape}${pdesc ? ` — ${pdesc}` : ''}`);
    }
  }
  if (props.length > 0) parts.push('', 'Properties:', ...props);

  return {
    content: parts.join('\n'),
    sectionTitle: `Schema: ${name}`,
    metadata: {
      format: 'openapi',
      kind: 'schema',
      schema_name: name,
      type,
      has_enum: Array.isArray(schema.enum),
      is_composed: !!(schema.allOf || schema.oneOf || schema.anyOf),
    },
  };
}

export const openApiAdapter: FormatAdapter = {
  name: 'openapi',

  detect(_fileName: string, raw: string): boolean {
    if (typeof raw !== 'string' || raw.length === 0) return false;
    return looksLikeOpenAPIJson(raw) || looksLikeOpenAPIYaml(raw);
  },

  extract(fileName: string, raw: string): AdapterResult {
    const spec = parseSpec(raw);
    if (!spec) {
      return { format: 'openapi', chunks: [], summary: 'OpenAPI: failed to parse' };
    }

    const version = typeof spec.openapi === 'string'
      ? spec.openapi
      : typeof spec.swagger === 'string'
        ? spec.swagger
        : 'unknown';

    const servers = listServers(spec);
    const chunks: AdapterChunk[] = [];

    // One chunk per operation
    const paths = (spec.paths && typeof spec.paths === 'object')
      ? spec.paths as Record<string, unknown>
      : {};

    let operationCount = 0;
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      const pi = pathItem as Record<string, unknown>;
      const pathLevelParams = pi.parameters;

      for (const method of HTTP_METHODS) {
        const op = pi[method];
        if (!op || typeof op !== 'object') continue;
        chunks.push(describeOperation(version, servers, path, method, op as Record<string, unknown>, pathLevelParams));
        operationCount++;
      }
    }

    // One chunk per schema (OpenAPI 3 uses components.schemas; Swagger 2 uses definitions)
    let schemaCount = 0;
    const schemas =
      (spec.components && typeof spec.components === 'object'
        ? (spec.components as Record<string, unknown>).schemas
        : null)
      ?? spec.definitions
      ?? null;

    if (schemas && typeof schemas === 'object') {
      for (const [name, schema] of Object.entries(schemas as Record<string, unknown>)) {
        if (!schema || typeof schema !== 'object') continue;
        chunks.push(describeSchema(name, schema as Record<string, unknown>));
        schemaCount++;
      }
    }

    const summary = `OpenAPI ${version} · ${operationCount} operation${operationCount === 1 ? '' : 's'} · ${schemaCount} schema${schemaCount === 1 ? '' : 's'}${servers.length > 0 ? ` · ${servers.length} server${servers.length === 1 ? '' : 's'}` : ''}`;

    return { format: 'openapi', chunks, summary };
  },
};
