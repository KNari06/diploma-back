/**
 * Validate + repair Enricher request bodies against the endpoint's own JSON schema
 * (Phase 2). The Enricher fabricates fake test data via an LLM, which routinely
 * emits schema-violating shapes — a number as a string ("42"), a boolean as
 * "true", or a required field omitted. Left unchecked these are rejected by the
 * API at run time (400), so we coerce what we can and report what we can't.
 *
 * Deterministic (no ajv): a targeted schema-guided walk. `{{placeholder}}` string
 * values are LEFT UNTOUCHED — they hold an injected variable resolved at run time,
 * so their build-time type must not be "fixed".
 */

const PLACEHOLDER = /\{\{.+?\}\}/;

function schemaType(schema: any): string | undefined {
  return Array.isArray(schema?.type) ? schema.type.find((t: string) => t !== 'null') : schema?.type;
}

/**
 * Coerce scalar values in `body` to the types declared by `schema`. Recurses
 * objects (via `properties`) and arrays (via `items`). Only safe, lossless
 * coercions are applied (numeric strings → numbers, "true"/"false" → booleans).
 */
export function coerceBodyToSchema(body: any, schema: any): any {
  if (!schema || body === null || body === undefined) return body;
  if (typeof body === 'string' && PLACEHOLDER.test(body)) return body; // runtime-resolved injection

  if (schema.properties && body && typeof body === 'object' && !Array.isArray(body)) {
    const out: Record<string, any> = { ...body };
    for (const [k, v] of Object.entries(body)) {
      if (schema.properties[k]) out[k] = coerceBodyToSchema(v, schema.properties[k]);
    }
    return out;
  }

  const type = schemaType(schema);
  if (type === 'array' && Array.isArray(body) && schema.items) {
    return body.map(item => coerceBodyToSchema(item, schema.items));
  }

  if ((type === 'number' || type === 'integer') && typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
      return type === 'integer' ? parseInt(trimmed, 10) : Number(trimmed);
    }
  }
  if (type === 'boolean' && typeof body === 'string' && /^(true|false)$/i.test(body.trim())) {
    return /^true$/i.test(body.trim());
  }
  return body;
}

/**
 * Names of `required` object properties that are absent (or explicitly null) from
 * the body — an Enricher omission the API would reject. Only inspects the top
 * object level (nested required is rare in test payloads and noisier than useful).
 */
export function missingRequiredFields(body: any, schema: any): string[] {
  if (!schema || !Array.isArray(schema.required) || !body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }
  return schema.required.filter((k: string) => body[k] === undefined || body[k] === null);
}
