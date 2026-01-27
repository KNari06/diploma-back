/**
 * API Agent Expectation Validator
 * Deterministic expectation/contract checks + invariants baseline checks.
 *
 * Note: severity/type are assigned by code (AI must not downgrade severity).
 */

import type {
  ApiAgentExpectationModel,
  ApiAgentFinding,
  ApiAgentPlannedStep,
  ApiAgentStepResult,
} from './api-agent.types';

type Severity = ApiAgentFinding['severity'];

function findingId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

type InferredResponseType = ApiAgentExpectationModel['responseType'];

function clampSeverityFloor(sev: Severity, floor: Severity): Severity {
  const order: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
  return order.indexOf(sev) < order.indexOf(floor) ? floor : sev;
}

function isServerOrCrash(status: number, error?: string): boolean {
  if (error && error.toLowerCase().includes('timeout')) return true;
  return status >= 500 || status === 0;
}

function isNetworkUnreachable(error?: string): boolean {
  const e = (error || '').toLowerCase();
  if (!e) return false;
  if (e.includes('timeout')) return false;

  const patterns = [
    'network error',
    'unable to reach server',
    'getaddrinfo enotfound',
    'enotfound',
    'econnrefused',
    'econnreset',
    'socket hang up',
    'fetch failed',
    'failed to fetch',
    'connection refused',
    'connection reset',
    'dns',
  ];
  return patterns.some((p) => e.includes(p));
}

function hasExpectedBehavior(expectationModel?: ApiAgentExpectationModel, expectedBehaviorRaw?: string): boolean {
  return !!(expectedBehaviorRaw && expectedBehaviorRaw.trim().length > 0) || !!expectationModel;
}

function checkInvariantNonEmptyList(body: any): boolean | null {
  if (!Array.isArray(body)) return null;
  return body.length > 0;
}

function checkInvariantUniqueId(body: any): boolean | null {
  if (!Array.isArray(body)) return null;
  const ids: string[] = [];
  for (const item of body) {
    if (item && typeof item === 'object' && 'id' in item) {
      const v = (item as any).id;
      if (typeof v === 'string' || typeof v === 'number') ids.push(String(v));
    }
  }
  if (ids.length === 0) return null; // cannot evaluate
  return new Set(ids).size === ids.length;
}

function requiresFields(body: any, fields: string[]): boolean | null {
  if (!fields || fields.length === 0) return null;
  if (Array.isArray(body)) {
    const sample = body[0];
    if (!sample || typeof sample !== 'object') return false;
    return fields.every((f) => f in (sample as any));
  }
  if (body && typeof body === 'object') {
    return fields.every((f) => f in (body as any));
  }
  return false;
}

function inferResponseTypeFromText(text?: string): InferredResponseType | undefined {
  const raw = (text || '').trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();

  // List/array signals (EN+RU)
  if (
    lower.includes('list') ||
    lower.includes('array') ||
    lower.includes('спис') ||
    lower.includes('массив')
  ) {
    return 'list';
  }

  // Object signals (EN+RU)
  if (lower.includes('object') || lower.includes('объект')) {
    return 'object';
  }

  // JSON signal without explicit shape
  if (lower.includes('json')) {
    return 'unknown';
  }

  return undefined;
}

function looksLikeHtml(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  const t = body.trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html') || t.includes('<head') || t.includes('<body');
}

function allowsHtmlResponseFromText(text?: string): boolean {
  const raw = (text || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  // Explicitly allow HTML/page responses when user expects it.
  return (
    lower.includes('text/html') ||
    lower.includes('html') ||
    lower.includes('web page') ||
    lower.includes('webpage') ||
    lower.includes('landing') ||
    lower.includes('страниц') || // matches "страница/страницы/страницу"
    lower.includes('лендинг')
  );
}

export class ApiAgentExpectationValidatorService {
  static validateStep(params: {
    plannedStep: ApiAgentPlannedStep;
    stepResult: ApiAgentStepResult;
    expectationModel?: ApiAgentExpectationModel;
    expectedBehaviorRaw?: string;
  }): { findings: ApiAgentFinding[] } {
    const { plannedStep, stepResult, expectationModel, expectedBehaviorRaw } = params;
    const findings: ApiAgentFinding[] = [];

    const status = stepResult.response?.status ?? 0;
    const body = stepResult.response?.body;
    const hasExp = hasExpectedBehavior(expectationModel, expectedBehaviorRaw);

    // 1) invalid method handling: on method_contract, disallowed methods should NOT crash
    if (plannedStep.stepType === 'method_contract') {
      const alreadyHasNetworkFinding = stepResult.findings.some((f) => f.type === 'network_error');

      // Classify unreachable/network failures as network_error (not invalid_method_handling).
      if (!alreadyHasNetworkFinding && status === 0 && isNetworkUnreachable(stepResult.error)) {
        findings.push({
          id: findingId('network_error'),
          type: 'network_error',
          severity: clampSeverityFloor('high', 'medium'),
          title: 'Network error',
          description: stepResult.error || 'Network error - unable to reach server',
          evidence: {
            request: plannedStep.request,
          },
          recommendation: 'Verify host availability, DNS, firewall rules, and request routing',
        });
      } else if (isServerOrCrash(status, stepResult.error)) {
        const sev: Severity = hasExp ? 'high' : 'medium';
        findings.push({
          id: findingId('invalid_method_handling'),
          type: 'invalid_method_handling',
          severity: hasExp ? clampSeverityFloor(sev, 'medium') : sev,
          title: 'Invalid method handling',
          description: `Unexpected server error for disallowed method ${plannedStep.request.method}: expected 405/4xx, got ${status || 'no response'}`,
          evidence: {
            request: plannedStep.request,
            response: stepResult.response ? { status, body: stepResult.response.body } : undefined,
          },
          recommendation: 'Return 405 Method Not Allowed (or controlled 4xx) instead of crashing',
        });
      }
    }

    // 2) invalid input handling (negative/probing): invalid params should fail controlled (4xx), not crash (5xx/timeout)
    if (plannedStep.stepType === 'negative_case') {
      if (isServerOrCrash(status, stepResult.error)) {
        const sev: Severity = hasExp ? 'high' : 'medium';
        findings.push({
          id: findingId('invalid_input_handling'),
          type: 'invalid_input_handling',
          severity: hasExp ? clampSeverityFloor(sev, 'medium') : sev,
          title: 'Invalid input handling',
          description: `Invalid input caused server error: expected controlled 4xx, got ${status || 'no response'}`,
          evidence: {
            request: plannedStep.request,
            response: stepResult.response ? { status, body: stepResult.response.body } : undefined,
          },
          recommendation: 'Validate inputs and return controlled 4xx with a clear error',
        });
      }
    }

    // 3) happy-path expectation validation (structure + required fields + invariants)
    if (plannedStep.stepType === 'happy_path' && hasExp && stepResult.response) {
      const violations: string[] = [];

      if (status < 200 || status >= 300) {
        violations.push(`Expected 2xx, got ${status}`);
      }

      const expectedType = expectationModel?.responseType ?? inferResponseTypeFromText(expectedBehaviorRaw);
      if (expectedType === 'list' && !Array.isArray(body)) {
        violations.push('Expected responseType=list (array)');
      }
      if (expectedType === 'object' && (body === null || typeof body !== 'object' || Array.isArray(body))) {
        violations.push('Expected responseType=object');
      }

      const reqFields = expectationModel?.requiredFields;
      const fieldsOk = reqFields ? requiresFields(body, reqFields) : null;
      if (fieldsOk === false && reqFields && reqFields.length > 0) {
        violations.push(`Missing required fields: ${reqFields.join(', ')}`);
      }

      const invariants = expectationModel?.invariants || [];
      for (const inv of invariants) {
        if (inv === 'non_empty_list') {
          const ok = checkInvariantNonEmptyList(body);
          if (ok === false) violations.push('Invariant failed: non_empty_list');
        }
        if (inv === 'unique_id') {
          const ok = checkInvariantUniqueId(body);
          if (ok === false) violations.push('Invariant failed: unique_id');
        }
      }

      // JSON integrity: if response body is a string but we expected structured JSON, treat as violation
      if ((expectedType === 'list' || expectedType === 'object') && typeof body === 'string') {
        violations.push('Expected JSON body but got text');
      }

      // HTML detection (common: website HTML returned instead of API JSON)
      const contentType =
        stepResult.response.headers?.['content-type'] ||
        stepResult.response.headers?.['Content-Type'] ||
        '';
      const contentTypeLower = String(contentType).toLowerCase();
      const isHtmlResponse = contentTypeLower.includes('text/html') || looksLikeHtml(body);
      const allowsHtml = allowsHtmlResponseFromText(expectedBehaviorRaw);

      // For API agent happy-path, treat HTML as a violation by default (even if user didn't specify JSON explicitly),
      // unless the expectation text explicitly allows HTML/page responses.
      const expectedStructured =
        expectedType === 'list' ||
        expectedType === 'object' ||
        expectedType === 'unknown' ||
        (plannedStep.stepType === 'happy_path' && !allowsHtml);

      if (expectedStructured && isHtmlResponse && !allowsHtml) {
        violations.push('Expected JSON response but got HTML');
      }

      if (violations.length > 0) {
        findings.push({
          id: findingId('expectation_violation'),
          type: 'expectation_violation',
          severity: clampSeverityFloor('high', 'medium'),
          title: 'Expectation violation',
          description: violations.join('; '),
          evidence: {
            response: {
              status,
              body,
              contentType: contentType || undefined,
            },
          },
          recommendation: 'Align API behavior with expected contract/behavior',
        });
      }
    }

    // Controlled errors are not findings here; other findings are still produced by the base analyzer.
    // We keep this validator focused on expectation-driven semantics.

    return { findings };
  }
}

