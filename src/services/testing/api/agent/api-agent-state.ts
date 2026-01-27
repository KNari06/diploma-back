/**
 * API Agent State
 * Manages persistent run state for the agent (IDs, schema, timings, error signatures)
 */

import { randomUUID } from 'crypto';
import type {
  ApiAgentLevel,
  ApiAgentRunState,
  ApiAgentStepResult,
  ApiAgentFinding,
  ApiAgentStopReason,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// STATE FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create initial run state
 */
export function createInitialState(
  testId: string,
  level: ApiAgentLevel,
  runId?: string
): ApiAgentRunState {
  return {
    runId: runId || randomUUID(),
    testId,
    level,
    status: 'running',
    startedAt: new Date().toISOString(),
    currentStep: 0,
    steps: [],
    findings: [],
    inferredSchema: null,
    knownIds: [],
    discoveredMethods: [],
    errorSignatures: new Set<string>(),
    novelty: 1.0, // Start with max novelty
    consumed: {
      steps: 0,
      seconds: 0,
      aiTokens: 0,
      endpointsConsidered: 0,
    },
    expectationModel: undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE MUTATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a step result to state
 */
export function addStepResult(
  state: ApiAgentRunState,
  step: ApiAgentStepResult
): void {
  state.steps.push(step);
  state.currentStep = state.steps.length;
  state.consumed.steps++;
  state.consumed.aiTokens += step.aiTokensUsed;

  // Add findings to aggregated list
  for (const finding of step.findings) {
    state.findings.push(finding);
  }
}

/**
 * Update consumed time
 */
export function updateConsumedTime(
  state: ApiAgentRunState,
  elapsedMs: number
): void {
  state.consumed.seconds = Math.floor(elapsedMs / 1000);
}

/**
 * Add AI tokens consumed
 */
export function addAiTokens(state: ApiAgentRunState, tokens: number): void {
  state.consumed.aiTokens += tokens;
}

/**
 * Add a discovered resource ID
 */
export function addKnownId(state: ApiAgentRunState, id: string): void {
  if (!state.knownIds.includes(id)) {
    state.knownIds.push(id);
  }
}

/**
 * Add a discovered HTTP method capability
 */
export function addDiscoveredMethod(
  state: ApiAgentRunState,
  method: string
): void {
  const upper = method.toUpperCase();
  if (!state.discoveredMethods.includes(upper)) {
    state.discoveredMethods.push(upper);
  }
}

/**
 * Update inferred schema
 */
export function updateInferredSchema(
  state: ApiAgentRunState,
  schema: Record<string, any>
): void {
  if (!state.inferredSchema) {
    state.inferredSchema = schema;
  } else {
    // Merge schemas (simple: just overwrite for now)
    state.inferredSchema = { ...state.inferredSchema, ...schema };
  }
}

/**
 * Add error signature for deduplication
 */
export function addErrorSignature(
  state: ApiAgentRunState,
  signature: string
): boolean {
  if (state.errorSignatures.has(signature)) {
    return false; // Already seen
  }
  state.errorSignatures.add(signature);
  return true; // New error
}

/**
 * Update novelty score
 */
export function updateNovelty(state: ApiAgentRunState, novelty: number): void {
  state.novelty = Math.max(0, Math.min(1, novelty)); // Clamp 0..1
}

/**
 * Increment endpoints considered
 */
export function incrementEndpointsConsidered(state: ApiAgentRunState): void {
  state.consumed.endpointsConsidered++;
}

/**
 * Mark state as completed
 */
export function markCompleted(
  state: ApiAgentRunState,
  stopReason: ApiAgentStopReason
): void {
  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  state.stopReason = stopReason;
}

/**
 * Mark state as stopped (early termination)
 */
export function markStopped(
  state: ApiAgentRunState,
  stopReason: ApiAgentStopReason
): void {
  state.status = 'stopped';
  state.completedAt = new Date().toISOString();
  state.stopReason = stopReason;
}

/**
 * Mark state as failed
 */
export function markFailed(
  state: ApiAgentRunState,
  errorMessage: string
): void {
  state.status = 'failed';
  state.completedAt = new Date().toISOString();
  state.stopReason = 'error';
  // Add error as finding
  state.findings.push({
    id: `err_${Date.now()}`,
    type: 'server_error',
    severity: 'critical',
    title: 'Agent execution failed',
    description: errorMessage,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE QUERIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get total duration in milliseconds
 */
export function getDurationMs(state: ApiAgentRunState): number {
  const start = new Date(state.startedAt).getTime();
  const end = state.completedAt
    ? new Date(state.completedAt).getTime()
    : Date.now();
  return end - start;
}

/**
 * Get findings by severity
 */
export function getFindingsCounts(state: ApiAgentRunState): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
} {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of state.findings) {
    counts[finding.severity]++;
  }
  return counts;
}

/**
 * Get top N findings by severity (critical > high > medium > low > info)
 */
export function getTopFindings(
  state: ApiAgentRunState,
  n: number = 5
): ApiAgentFinding[] {
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const sorted = [...state.findings].sort((a, b) => {
    return severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
  });
  return sorted.slice(0, n);
}

/**
 * Check if happy path succeeded
 */
export function hasSuccessfulHappyPath(state: ApiAgentRunState): boolean {
  const happyPathStep = state.steps.find((s) => s.stepType === 'happy_path');
  return happyPathStep?.success === true;
}

/**
 * Check if there are critical findings
 */
export function hasCriticalFindings(state: ApiAgentRunState): boolean {
  return state.findings.some((f) => f.severity === 'critical');
}

/**
 * Compute error signature from response
 */
export function computeErrorSignature(
  status: number,
  body: any
): string {
  // Simple signature: status + first 100 chars of body stringified
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const preview = bodyStr?.substring(0, 100) || '';
  return `${status}:${preview}`;
}
