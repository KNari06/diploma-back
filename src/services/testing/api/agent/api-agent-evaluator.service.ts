/**
 * API Agent Evaluator
 * Evaluates step results, computes diffs, novelty, and risk signals
 */

import { logger } from '@/utils/core/logger';
import {
  addDiscoveredMethod,
  addErrorSignature,
  addKnownId,
  computeErrorSignature,
  updateInferredSchema,
  updateNovelty,
} from './api-agent-state';
import type {
  ApiAgentLevelPolicy,
  ApiAgentRunState,
  ApiAgentStepResult,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// NOVELTY WEIGHTS
// ═══════════════════════════════════════════════════════════════════════════

const NOVELTY_WEIGHTS = {
  newFinding: 0.2,
  newErrorSignature: 0.15,
  schemaChange: 0.1,
  perfAnomaly: 0.05,
  discoveredMethod: 0.1,
  discoveredId: 0.05,
};

const NOVELTY_DECAY = 0.1; // Decay per step with no new findings

// ═══════════════════════════════════════════════════════════════════════════
// EVALUATOR SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ApiAgentEvaluatorService {
  /**
   * Evaluate a step result and update state accordingly
   * Returns the updated novelty score
   */
  static evaluateStep(
    state: ApiAgentRunState,
    step: ApiAgentStepResult,
  ): number {
    let noveltyDelta = 0;

    // 1. Check for new findings
    const newFindingsCount = step.findings.length;
    if (newFindingsCount > 0) {
      noveltyDelta += NOVELTY_WEIGHTS.newFinding * Math.min(newFindingsCount, 3);
    }

    // 2. Check for new error signatures
    if (step.response && step.response.status >= 400) {
      const signature = computeErrorSignature(step.response.status, step.response.body);
      const isNew = addErrorSignature(state, signature);
      if (isNew) {
        noveltyDelta += NOVELTY_WEIGHTS.newErrorSignature;
      }
    }

    // 3. Check for discovered methods
    if (step.stepType === 'method_contract' && step.success) {
      const method = step.request.method.toUpperCase();
      if (!state.discoveredMethods.includes(method)) {
        addDiscoveredMethod(state, method);
        noveltyDelta += NOVELTY_WEIGHTS.discoveredMethod;
      }
    }

    // 4. Infer schema from successful response
    if (step.success && step.response?.body) {
      const schema = this.inferSchemaFromResponse(step.response.body);
      if (schema && !state.inferredSchema) {
        updateInferredSchema(state, schema);
        noveltyDelta += NOVELTY_WEIGHTS.schemaChange;
      } else if (schema && state.inferredSchema) {
        // Check if schema differs
        const differs = this.schemasDiffer(state.inferredSchema, schema);
        if (differs) {
          updateInferredSchema(state, schema);
          noveltyDelta += NOVELTY_WEIGHTS.schemaChange * 0.5; // Smaller weight for updates
        }
      }
    }

    // 5. Extract and store discovered IDs
    const ids = this.extractIdsFromResponse(step.response?.body);
    for (const id of ids) {
      if (!state.knownIds.includes(id)) {
        addKnownId(state, id);
        noveltyDelta += NOVELTY_WEIGHTS.discoveredId;
      }
    }

    // 6. Check for performance anomalies
    if (step.response && step.response.durationMs > 5000) {
      noveltyDelta += NOVELTY_WEIGHTS.perfAnomaly;
    }

    // Apply decay if no new novelty
    let newNovelty: number;
    if (noveltyDelta > 0) {
      // Cap novelty at 1.0
      newNovelty = Math.min(1.0, state.novelty + noveltyDelta * 0.5);
    } else {
      // Decay novelty
      newNovelty = Math.max(0, state.novelty - NOVELTY_DECAY);
    }

    updateNovelty(state, newNovelty);

    logger.debug('[API_AGENT_EVALUATOR] Step evaluated', {
      stepId: step.stepId,
      noveltyDelta,
      newNovelty,
      findingsCount: newFindingsCount,
    });

    return newNovelty;
  }

  /**
   * Check if agent should stop based on current state and policy
   */
  static shouldStop(
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    elapsedMs: number
  ): { shouldStop: boolean; reason?: string } {
    // Budget: steps
    if (state.consumed.steps >= policy.budget.maxSteps) {
      return { shouldStop: true, reason: 'budget_steps' };
    }

    // Budget: time
    if (elapsedMs >= policy.budget.maxSeconds * 1000) {
      return { shouldStop: true, reason: 'budget_time' };
    }

    // Budget: AI tokens
    if (state.consumed.aiTokens >= policy.budget.maxAiTokens) {
      return { shouldStop: true, reason: 'budget_tokens' };
    }

    // Novelty threshold
    if (state.novelty < policy.noveltyStopThreshold && state.consumed.steps >= 3) {
      return { shouldStop: true, reason: 'novelty_threshold' };
    }

    // Contract broken (critical finding in happy path)
    const happyPathStep = state.steps.find((s) => s.stepType === 'happy_path');
    if (happyPathStep && !happyPathStep.success) {
      // Only stop for LIGHT level; MEDIUM/HARD can continue exploring errors
      if (policy.level === 'light') {
        return { shouldStop: true, reason: 'contract_broken' };
      }
    }

    return { shouldStop: false };
  }

  /**
   * Compute security score (0-10) based on findings
   */
  static computeSecurityScore(state: ApiAgentRunState): number {
    let score = 10;

    for (const finding of state.findings) {
      switch (finding.severity) {
        case 'critical':
          score -= 3;
          break;
        case 'high':
          score -= 2;
          break;
        case 'medium':
          score -= 1;
          break;
        case 'low':
          score -= 0.5;
          break;
        // 'info' doesn't reduce score
      }
    }

    return Math.max(0, Math.min(10, score));
  }

  /**
   * Infer a simple schema from response body
   */
  private static inferSchemaFromResponse(body: any): Record<string, any> | null {
    if (body === null || body === undefined) return null;
    if (typeof body !== 'object') return { type: typeof body };

    if (Array.isArray(body)) {
      if (body.length === 0) return { type: 'array', items: null };
      return { type: 'array', items: this.inferSchemaFromResponse(body[0]) };
    }

    const schema: Record<string, any> = { type: 'object', properties: {} };
    for (const [key, value] of Object.entries(body)) {
      if (value === null) {
        schema.properties[key] = { type: 'null' };
      } else if (Array.isArray(value)) {
        schema.properties[key] = { type: 'array' };
      } else {
        schema.properties[key] = { type: typeof value };
      }
    }
    return schema;
  }

  /**
   * Check if two schemas differ
   */
  private static schemasDiffer(
    schema1: Record<string, any>,
    schema2: Record<string, any>
  ): boolean {
    // Simple comparison: check if properties differ
    const props1 = Object.keys(schema1.properties || {}).sort().join(',');
    const props2 = Object.keys(schema2.properties || {}).sort().join(',');
    return props1 !== props2;
  }

  /**
   * Extract potential resource IDs from response
   */
  private static extractIdsFromResponse(body: any): string[] {
    const ids: string[] = [];
    if (!body || typeof body !== 'object') return ids;

    const idPatterns = ['id', '_id', 'uuid', 'resourceId', 'userId', 'itemId'];

    const extract = (obj: any) => {
      if (Array.isArray(obj)) {
        for (const item of obj) extract(item);
        return;
      }
      if (typeof obj !== 'object' || obj === null) return;

      for (const [key, value] of Object.entries(obj)) {
        if (idPatterns.some((p) => key.toLowerCase().includes(p.toLowerCase()))) {
          if (typeof value === 'string' || typeof value === 'number') {
            ids.push(String(value));
          }
        }
        if (typeof value === 'object') {
          extract(value);
        }
      }
    };

    extract(body);
    return ids.slice(0, 10); // Limit to 10 IDs
  }
}
