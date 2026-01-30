/**
 * Schema Consistency Service
 * Infers response schema and validates consistency across multiple requests.
 * Used for detecting schema drift, pagination issues, and non-deterministic behavior.
 */

import type { ApiAgentFinding, ApiAgentFindingType } from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inferred field type from JSON response
 */
export type InferredFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'mixed';

/**
 * Inferred schema for a JSON response
 */
export interface InferredSchema {
  type: InferredFieldType;
  fields?: Record<string, InferredFieldType>;
  arrayItemType?: InferredFieldType;
  arrayItemFields?: Record<string, InferredFieldType>;
  nullable?: boolean;
}

/**
 * Consistency check result
 */
export interface ConsistencyCheckResult {
  isConsistent: boolean;
  issues: Array<{
    type: 'schema_drift' | 'field_type_change' | 'missing_field' | 'extra_field' | 'value_fluctuation';
    field: string;
    expected: string;
    actual: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}

/**
 * Pagination invariant check result
 */
export interface PaginationCheckResult {
  hasPagination: boolean;
  issues: Array<{
    type: 'duplicate_items' | 'missing_items' | 'inconsistent_total' | 'unstable_order';
    description: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class SchemaConsistencyService {
  /**
   * Infer schema from a JSON response body.
   * @param body - Response body (parsed JSON)
   * @returns Inferred schema structure
   */
  static inferSchema(body: any): InferredSchema {
    if (body === null) {
      return { type: 'null', nullable: true };
    }

    if (Array.isArray(body)) {
      const schema: InferredSchema = { type: 'array' };

      if (body.length > 0) {
        const firstItem = body[0];
        schema.arrayItemType = this.getFieldType(firstItem);

        if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
          schema.arrayItemFields = this.extractFields(firstItem);
        }
      }

      return schema;
    }

    if (typeof body === 'object') {
      return {
        type: 'object',
        fields: this.extractFields(body),
      };
    }

    return { type: this.getFieldType(body) };
  }

  /**
   * Extract fields and their types from an object.
   * @param obj - Object to extract fields from
   * @returns Map of field names to types
   */
  private static extractFields(obj: Record<string, any>): Record<string, InferredFieldType> {
    const fields: Record<string, InferredFieldType> = {};

    for (const [key, value] of Object.entries(obj)) {
      fields[key] = this.getFieldType(value);
    }

    return fields;
  }

  /**
   * Get the type of a value.
   * @param value - Value to check type of
   * @returns Inferred field type
   */
  private static getFieldType(value: any): InferredFieldType {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'mixed';
  }

  /**
   * Compare two schemas for consistency.
   * @param baseline - Baseline schema (from first response)
   * @param current - Current schema (from new response)
   * @returns Consistency check result with any issues found
   */
  static compareSchemas(baseline: InferredSchema, current: InferredSchema): ConsistencyCheckResult {
    const issues: ConsistencyCheckResult['issues'] = [];

    // Check top-level type
    if (baseline.type !== current.type) {
      issues.push({
        type: 'schema_drift',
        field: 'root',
        expected: baseline.type,
        actual: current.type,
        severity: 'high',
      });
      return { isConsistent: false, issues };
    }

    // Compare object fields
    if (baseline.type === 'object' && baseline.fields && current.fields) {
      this.compareFields(baseline.fields, current.fields, '', issues);
    }

    // Compare array item fields
    if (baseline.type === 'array') {
      if (baseline.arrayItemType !== current.arrayItemType) {
        issues.push({
          type: 'field_type_change',
          field: 'array[]',
          expected: baseline.arrayItemType || 'unknown',
          actual: current.arrayItemType || 'unknown',
          severity: 'medium',
        });
      }

      if (baseline.arrayItemFields && current.arrayItemFields) {
        this.compareFields(baseline.arrayItemFields, current.arrayItemFields, 'array[].', issues);
      }
    }

    return {
      isConsistent: issues.length === 0,
      issues,
    };
  }

  /**
   * Compare field maps and report differences.
   * @param baseline - Baseline fields
   * @param current - Current fields
   * @param prefix - Field path prefix
   * @param issues - Issues array to append to
   */
  private static compareFields(
    baseline: Record<string, InferredFieldType>,
    current: Record<string, InferredFieldType>,
    prefix: string,
    issues: ConsistencyCheckResult['issues']
  ): void {
    const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

    for (const key of allKeys) {
      const fieldPath = `${prefix}${key}`;
      const baselineType = baseline[key];
      const currentType = current[key];

      if (baselineType && !currentType) {
        issues.push({
          type: 'missing_field',
          field: fieldPath,
          expected: baselineType,
          actual: 'undefined',
          severity: 'medium',
        });
      } else if (!baselineType && currentType) {
        issues.push({
          type: 'extra_field',
          field: fieldPath,
          expected: 'undefined',
          actual: currentType,
          severity: 'low',
        });
      } else if (baselineType !== currentType) {
        issues.push({
          type: 'field_type_change',
          field: fieldPath,
          expected: baselineType,
          actual: currentType,
          severity: 'high',
        });
      }
    }
  }

  /**
   * Check pagination invariants across multiple page responses.
   * @param responses - Array of paginated responses
   * @param options - Pagination options (id field, total field, etc.)
   * @returns Pagination check result
   */
  static checkPaginationInvariants(
    responses: Array<{ body: any; page: number }>,
    options: {
      idField?: string;
      totalField?: string;
      itemsField?: string;
    } = {}
  ): PaginationCheckResult {
    const idField = options.idField || 'id';
    const itemsField = options.itemsField || 'data';
    const issues: PaginationCheckResult['issues'] = [];

    if (responses.length === 0) {
      return { hasPagination: false, issues: [] };
    }

    // Extract items from all pages
    const allItems: Array<{ id: string; page: number }> = [];
    const seenIds = new Set<string>();

    for (const { body, page } of responses) {
      const items = this.extractItems(body, itemsField);

      for (const item of items) {
        const id = item[idField];
        if (id !== undefined) {
          const idStr = String(id);

          // Check for duplicates across pages
          if (seenIds.has(idStr)) {
            issues.push({
              type: 'duplicate_items',
              description: `Item with ${idField}=${idStr} appears on multiple pages`,
              severity: 'medium',
            });
          } else {
            seenIds.add(idStr);
            allItems.push({ id: idStr, page });
          }
        }
      }
    }

    // Check for consistent total (if provided)
    if (options.totalField) {
      const totals = responses.map(r => this.extractTotal(r.body, options.totalField!));
      const uniqueTotals = [...new Set(totals.filter(t => t !== null))];

      if (uniqueTotals.length > 1) {
        issues.push({
          type: 'inconsistent_total',
          description: `Total count varies across pages: ${uniqueTotals.join(', ')}`,
          severity: 'low',
        });
      }
    }

    return {
      hasPagination: responses.length > 1,
      issues,
    };
  }

  /**
   * Extract items array from response body.
   * @param body - Response body
   * @param itemsField - Field name containing items
   * @returns Array of items
   */
  private static extractItems(body: any, itemsField: string): any[] {
    if (Array.isArray(body)) {
      return body;
    }

    if (body && typeof body === 'object') {
      // Try direct field
      if (Array.isArray(body[itemsField])) {
        return body[itemsField];
      }

      // Try common field names
      for (const field of ['data', 'items', 'results', 'records', 'list']) {
        if (Array.isArray(body[field])) {
          return body[field];
        }
      }
    }

    return [];
  }

  /**
   * Extract total count from response body.
   * @param body - Response body
   * @param totalField - Field name for total
   * @returns Total count or null
   */
  private static extractTotal(body: any, totalField: string): number | null {
    if (body && typeof body === 'object') {
      const value = body[totalField];
      if (typeof value === 'number') {
        return value;
      }

      // Try common field names
      for (const field of ['total', 'totalCount', 'count', 'total_count']) {
        if (typeof body[field] === 'number') {
          return body[field];
        }
      }
    }

    return null;
  }

  /**
   * Check response consistency by comparing two identical requests.
   * @param response1 - First response body
   * @param response2 - Second response body
   * @returns Consistency check for non-determinism
   */
  static checkResponseConsistency(response1: any, response2: any): ConsistencyCheckResult {
    const issues: ConsistencyCheckResult['issues'] = [];

    // Quick equality check for primitives
    if (typeof response1 !== typeof response2) {
      issues.push({
        type: 'schema_drift',
        field: 'root',
        expected: typeof response1,
        actual: typeof response2,
        severity: 'high',
      });
      return { isConsistent: false, issues };
    }

    // For arrays, check length consistency
    if (Array.isArray(response1) && Array.isArray(response2)) {
      if (response1.length !== response2.length) {
        issues.push({
          type: 'value_fluctuation',
          field: 'array.length',
          expected: String(response1.length),
          actual: String(response2.length),
          severity: 'medium',
        });
      }
    }

    // For objects, compare key counts and specific stable fields
    if (typeof response1 === 'object' && response1 !== null &&
        typeof response2 === 'object' && response2 !== null) {
      const keys1 = Object.keys(response1);
      const keys2 = Object.keys(response2);

      if (keys1.length !== keys2.length) {
        issues.push({
          type: 'value_fluctuation',
          field: 'object.keys',
          expected: String(keys1.length),
          actual: String(keys2.length),
          severity: 'low',
        });
      }

      // Check if any new keys appeared
      for (const key of keys2) {
        if (!keys1.includes(key)) {
          issues.push({
            type: 'extra_field',
            field: key,
            expected: 'undefined',
            actual: typeof response2[key],
            severity: 'low',
          });
        }
      }
    }

    return {
      isConsistent: issues.length === 0,
      issues,
    };
  }

  /**
   * Convert consistency issues to API agent findings.
   * @param result - Consistency check result
   * @param context - Context for the finding (step description, etc.)
   * @returns Array of API agent findings
   */
  static toFindings(
    result: ConsistencyCheckResult | PaginationCheckResult,
    // context: { stepDescription: string }
  ): ApiAgentFinding[] {
    const findings: ApiAgentFinding[] = [];

    if ('issues' in result) {
      for (const issue of result.issues) {
        const findingType: ApiAgentFindingType = 'type' in issue && issue.type === 'duplicate_items'
          ? 'consistency_error'
          : 'schema_mismatch';

        findings.push({
          id: `finding_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          type: findingType,
          severity: issue.severity,
          title: 'description' in issue
            ? issue.description.substring(0, 50)
            : `${issue.type}: ${issue.field}`,
          description: 'description' in issue
            ? issue.description
            : `Field ${issue.field}: expected ${issue.expected}, got ${issue.actual}`,
          recommendation: 'Ensure consistent API response structure and stable data',
        });
      }
    }

    return findings;
  }
}
