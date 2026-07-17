/**
 * Probe-phase core (Phase 4): correct a node's extraction jsonPaths from a REAL
 * observed response instead of trusting the spec's schema (which often lies).
 *
 * OpenAPI response schemas are frequently wrong or shallow, so `seedNodesFromSpec`
 * guesses extraction paths (`$.accessToken`, `$[0].id`). When we are allowed to
 * actually CALL a safe endpoint during build, we observe where the value really
 * lives and rewrite the path. This module is the PURE core (observation → path
 * correction + the "safe to call" gate); the network driver lives separately.
 *
 * Safety: only GET reads and session-establishing LOGIN endpoints are probeable —
 * never register/signup/otp-send (they create state) and never generic mutations.
 */

import { JSONPath } from 'jsonpath-plus';
import type { DAGNode, VariableExtraction } from '../flow.types';
import { isReferenceIdField, isTokenField, isSnakeIdVar } from './wiring-policy';

// Login-family segments only — a strict subset of auth endpoints. register /
// signup / otp/send establish state or send messages, so they are NOT probeable.
const SAFE_LOGIN_SEGMENT = /^(login|signin|sign-in|authenticate)$/i;

/** True when calling this node during build has no side effects. */
export function isSafeToProbe(node: DAGNode): boolean {
  if (node.method === 'GET') return true;
  const loginish = node.path.split('/').filter(Boolean).some(s => SAFE_LOGIN_SEGMENT.test(s));
  return (node.method === 'POST' || node.method === 'PUT') && node.isAuthEndpoint && loginish;
}

/** Depth-first search for the JSONPath of the first field whose key matches `pred`. */
export function findValuePath(obj: any, pred: (key: string, val: unknown) => boolean, base = '$'): string | null {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = findValuePath(obj[i], pred, `${base}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (pred(k, v)) return `${base}.${k}`;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') {
        const r = findValuePath(v, pred, `${base}.${k}`);
        if (r) return r;
      }
    }
  }
  return null;
}

function pathResolves(responseBody: any, jsonPath: string): boolean {
  try {
    const r = JSONPath({ path: jsonPath, json: responseBody, wrap: false });
    return r !== undefined && r !== null && r !== false && !(Array.isArray(r) && r.length === 0);
  } catch {
    return false;
  }
}

/** Predicate for the field an extraction is looking for, inferred from its variable name. */
function fieldPredicate(variableName: string): ((key: string, val: unknown) => boolean) | null {
  if (isTokenField(variableName) || /(token|jwt)$/i.test(variableName)) {
    return (k, v) => isTokenField(k) && (typeof v === 'string' || typeof v === 'number');
  }
  if (isSnakeIdVar(variableName)) {
    return (k, v) => (/^id$/i.test(k) || isReferenceIdField(k)) && (typeof v === 'string' || typeof v === 'number');
  }
  return null;
}

export interface ExtractionCorrection {
  variableName: string;
  from: string | undefined;
  to: string;
}

/**
 * Given a real response, return a corrected extraction when the seeded jsonPath
 * yields nothing but the value is discoverable elsewhere; otherwise null (the
 * path already resolves, or the value isn't found — leave it alone).
 */
export function correctExtraction(
  responseBody: any,
  extraction: VariableExtraction,
): { extraction: VariableExtraction; correction: ExtractionCorrection } | null {
  if (extraction.headerSource || !extraction.jsonPath) return null; // header/cookie extractions aren't body paths
  if (pathResolves(responseBody, extraction.jsonPath)) return null; // already correct

  const pred = fieldPredicate(extraction.variableName);
  if (!pred) return null;

  const found = findValuePath(responseBody, pred);
  if (!found || found === extraction.jsonPath) return null;

  return {
    extraction: { ...extraction, jsonPath: found },
    correction: { variableName: extraction.variableName, from: extraction.jsonPath, to: found },
  };
}
