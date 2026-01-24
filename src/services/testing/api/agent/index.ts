/**
 * API Agent Module
 * Central export for LIGHT/MEDIUM/HARD API testing agent
 */

// Types
export * from './api-agent.types';

// Policy
export {
  getPolicy,
  getPolicyWithOverrides,
  isValidLevel,
  checkSafetyGate,
  getAllowedStepTypes,
  getBaselineCredits,
} from './api-agent-policy';

// State
export {
  createInitialState,
  addStepResult,
  updateConsumedTime,
  addAiTokens,
  addKnownId,
  addDiscoveredMethod,
  updateInferredSchema,
  addErrorSignature,
  updateNovelty,
  incrementEndpointsConsidered,
  markCompleted,
  markStopped,
  markFailed,
  getDurationMs,
  getFindingsCounts,
  getTopFindings,
  hasSuccessfulHappyPath,
  hasCriticalFindings,
  computeErrorSignature,
} from './api-agent-state';

// Services
export { ApiAgentOrchestratorService } from './api-agent-orchestrator.service';
export { ApiAgentStepExecutorService } from './api-agent-step-executor.service';
export { ApiAgentEvaluatorService } from './api-agent-evaluator.service';
export { ApiAgentPlannerService } from './api-agent-planner.service';
export { ApiAgentTraceService } from './api-agent-trace.service';
export { ApiAgentCreditsService } from './api-agent-credits.service';
