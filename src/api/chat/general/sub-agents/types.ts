import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SkillResult } from '@/services/skills/types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-AGENT PIPELINE TYPES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Type definitions for the cooperative multi-agent chat pipeline.
 * Router → [Planner] → Executor(s) → Reviewer → Responder
 * All agents read/write a shared Blackboard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Tool category identifier — dynamic string derived from SkillRegistry at runtime.
 *
 * Categories are auto-generated from registered skills:
 * - Each skill becomes a category (e.g., 'jira', 'github', 'slack')
 * - Skills with mixed read/write tools are split into '{id}_read' and '{id}_write'
 * - Memory tools become the 'memory' category
 *
 * No hardcoded union — new skills are picked up automatically.
 */
export type ToolCategory = string;

/**
 * Router agent output — classifies user request and selects tool categories
 */
export interface RouterResult {
  classification: 'simple_chat' | 'single_tool' | 'multi_tool';
  confidence: number;
  toolCategories: ToolCategory[];
  reasoning: string;
  requiresMemory: boolean;
  /** When confidence is low (clarification band), router may provide a question to ask the user */
  clarificationQuestion?: string;
}

/**
 * Planner agent output — execution plan for multi_tool tasks
 */
export interface PlannerResult {
  steps: PlanStep[];
  summary: string;
}

export interface PlanStep {
  stepNumber: number;
  description: string;
  category: ToolCategory;
  expectedTool?: string;
  dependsOn: number[];
}

/**
 * Record of a single tool execution
 */
export interface ToolExecutionRecord {
  toolName: string;
  args: Record<string, any>;
  result: SkillResult;
  durationMs: number;
}

/**
 * Executor agent result
 */
export interface ExecutorResult {
  success: boolean;
  toolResults: ToolExecutionRecord[];
  assistantContent: string;
  toolRounds: number;
}

/**
 * Responder agent result
 */
export interface ResponderResult {
  content: string;
}

/**
 * Pipeline execution metrics for logging/debugging
 */
export interface PipelineMetrics {
  routerMs: number;
  plannerMs: number;
  executorMs: number;
  responderMs: number;
  reviewerMs: number;
  stepValidatorMs: number;
  totalMs: number;
  routerClassification: string;
  routerConfidence: number;
  toolCategories: ToolCategory[];
  toolsProvided: number;
  toolRounds: number;
  toolsExecuted: string[];
  subExecutorsSpawned: number;
  reviewerVerdict: string;
  stepValidatorVerdict: string;
  retryCount: number;
}

/**
 * Full pipeline result — returned to handler.ts
 */
export interface SubAgentPipelineResult {
  success: boolean;
  content: string;
  path: 'simple_chat' | 'single_tool' | 'multi_tool' | 'fallback';
  metrics: PipelineMetrics;
  /** True when the pipeline is returning a clarification question, not a real answer */
  needsClarification?: boolean;
  /** Tools already executed before fallback — used to seed monolithic loop tracker */
  executedTools?: Array<{ toolName: string; args: Record<string, any> }>;
  /**
   * Quick action descriptors synthesized from tool results.
   * Attached to AI message metadata so the frontend renders inline buttons.
   * Empty array when no actions apply (most non-editor cases).
   */
  quickActions?: import('@/api/chat/shared/quick-action.types').QuickAction[];
}

/**
 * Tool group definition for routing
 */
export interface ToolGroup {
  category: ToolCategory;
  description: string;
  keywords: string[];
  readOnly: boolean;
  toolNames: string[];
}

/**
 * Input to the pipeline from handler.ts
 */
export interface PipelineInput {
  userMessage: string;
  /** Full user content for the OpenAI message (string or multimodal content array with images). Falls back to userMessage if not set. */
  userContent?: string | ChatCompletionMessageParam['content'];
  messages: ChatCompletionMessageParam[];
  availableTools: ChatCompletionTool[];
  skillDescriptions: string;
  abortSignal?: AbortSignal;
  /**
   * Signal from Intent Parser: does this message need tool execution?
   * - false → skip Router, go directly to Responder (saves ~600ms)
   * - true / undefined → normal Router flow (backward compatible)
   */
  needsTools?: boolean;
}

/**
 * Context passed through the pipeline
 */
export interface PipelineContext {
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
  projectId?: string;
  projectName?: string; // Human-readable project name for AI responses
  previewSessionId?: string; // Active editor preview session
  mode?: 'lite' | 'pro' | 'editor';
  /**
   * Per-test-case chat scope marker. When set, the pipeline's
   * `emitStep` and any sub-agent emits dual-broadcast to the
   * `chat:tc:<testCaseId>` room so the frontend (which subscribed
   * by testCaseId before the session was lazy-created) receives
   * progress updates during the first request.
   */
  testCaseId?: string;
}

/**
 * Configuration for the sub-agent pipeline
 */
export interface SubAgentConfig {
  enabled: boolean;
  routerConfidenceThreshold: number;
  /** Below this → fallback to monolithic. Between this and routerConfidenceThreshold → ask clarification. */
  routerClarificationThreshold: number;
  maxToolRounds: number;
  circuitBreakerWindowSize: number;
  circuitBreakerFailThreshold: number;
  circuitBreakerRetryInterval: number;
  agentTimeoutMs: number;

  // ── Cooperative Multi-Agent Features ──────────────────────────────────

  /** Maximum concurrent sub-executors for parallel plan steps */
  maxSubExecutors: number;
  /** Hard cap on concurrency regardless of maxSubExecutors */
  absoluteMaxConcurrency: number;
  /** Maximum tool rounds per sub-executor (lighter than main executor) */
  maxSubExecutorRounds: number;
  /** Maximum reviewer retry attempts */
  maxReviewRetries: number;
  /** Reviewer agent timeout (ms) */
  reviewerTimeoutMs: number;
  /** Responder agent timeout (ms) — higher than router because it generates longer responses */
  responderTimeoutMs: number;
  /** Enable reviewer agent (feature flag) */
  enableReviewer: boolean;
  /** Enable parallel sub-executor spawning */
  enableParallelExecution: boolean;
  /** Minimum plan steps to trigger parallel execution */
  minStepsForParallel: number;
  /** Maximum insights stored on blackboard */
  maxBlackboardInsights: number;
  /** Max characters for tool result truncation in reviewer summary */
  reviewerResultTruncateChars: number;
  /** Max characters for tool result truncation in responder summary */
  responderResultTruncateChars: number;

  // ── LLM Parameters (per-agent temperature & max_tokens) ─────────────

  /** Executor agent temperature (tool-calling precision) */
  executorTemperature: number;
  /** Executor agent max output tokens */
  executorMaxTokens: number;
  /** Sub-executor agent temperature */
  subExecutorTemperature: number;
  /** Sub-executor agent max output tokens */
  subExecutorMaxTokens: number;
  /** Reviewer agent temperature (low for consistent judgments) */
  reviewerTemperature: number;
  /** Reviewer agent max output tokens */
  reviewerMaxTokens: number;
  /** Responder agent temperature (higher for natural prose) */
  responderTemperature: number;
  /** Responder agent max output tokens */
  responderMaxTokens: number;
  /** Router agent temperature */
  routerTemperature: number;
  /** Router agent max output tokens */
  routerMaxTokens: number;
  /** Planner agent temperature */
  plannerTemperature: number;
  /** Planner agent max output tokens */
  plannerMaxTokens: number;

  // ── Reviewer Thresholds ─────────────────────────────────────────────

  /** goalAlignment for fast-approve (no plan, all tools succeeded) */
  reviewerFastApproveAlignment: number;
  /** goalAlignment for fast-approve (all plan steps completed) */
  reviewerFullPlanApproveAlignment: number;
  /** goalAlignment fallback when reviewer times out or errors */
  reviewerFallbackAlignment: number;

  // ── Context Window Limits ───────────────────────────────────────────

  /** Number of recent messages sent to the router for context */
  routerRecentMessagesLimit: number;
  /** Number of recent user/assistant messages for responder history */
  responderHistoryLimit: number;

  // ── Loop Detection ────────────────────────────────────────────────

  /** Loop detection thresholds for tool call deduplication */
  loopDetection: {
    /** Warn after N identical calls (tool+args match) */
    exactRepeatWarn: number;
    /** Block after N identical calls */
    exactRepeatBlock: number;
    /** Window size for A→B→A→B oscillation detection */
    oscillationWindow: number;
  };

  // ── Step Validator (Editor Mode) ────────────────────────────────

  /** Enable step validator for editor mode (validates generated IntentSteps before showing to user) */
  enableStepValidator: boolean;
  /** Step validator timeout (ms) */
  stepValidatorTimeoutMs: number;
  /** Step validator temperature (low for consistent validation) */
  stepValidatorTemperature: number;
  /** Step validator max output tokens */
  stepValidatorMaxTokens: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// BLACKBOARD TYPES — Shared pipeline state across all agents
// Inspired by LiteEngine's WorkingMemory + SupervisorBlackboard patterns.
// Scoped to one pipeline.execute() call. NOT shared across requests.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Status of a plan step on the blackboard
 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * Tracked plan step with execution state (extends PlanStep)
 */
export interface TrackedPlanStep extends PlanStep {
  /** Which parallel group this step belongs to (set by identifyParallelGroups) */
  parallelGroup?: number;
  /** Current execution status */
  status: PlanStepStatus;
  /** Tool results produced by this step's execution */
  toolResults?: ToolExecutionRecord[];
  /** Error message if step failed */
  error?: string;
  /** Which sub-executor handled this step (undefined = main executor) */
  executorId?: string;
}

/**
 * Plan section of the blackboard (written by Planner)
 */
export interface BlackboardPlan {
  summary: string;
  steps: TrackedPlanStep[];
  /** Whether the plan has independent steps that can be parallelized */
  canParallelize: boolean;
  /** Groups of step numbers that can run concurrently */
  parallelGroups?: number[][];
}

/**
 * Execution section of the blackboard (written by Executor(s))
 */
export interface BlackboardExecution {
  /** Tool results mapped by step number (for planned execution) */
  stepResults: Map<number, ToolExecutionRecord[]>;
  /** Ungrouped results (for single_tool path with no plan) */
  ungroupedResults: ToolExecutionRecord[];
  /** Executor's assistant content */
  assistantContent: string;
  /** Total tool rounds across all executors */
  totalToolRounds: number;
  /** Sub-executor IDs that participated */
  subExecutorIds: string[];
}

/**
 * The Pipeline Blackboard — shared state across all agents within a single pipeline execution
 */
export interface PipelineBlackboard {
  /** The user's original message/request — the north star */
  userGoal: string;
  /** Timestamp when pipeline started */
  pipelineStartedAt: number;
  /** Router output */
  router?: RouterResult;
  /** Planner output with tracked steps */
  plan?: BlackboardPlan;
  /** Executor output */
  execution?: BlackboardExecution;
  /** Reviewer output */
  review?: ReviewerResult;
  /** Accumulated insights from any agent (bounded to last 10) */
  insights: string[];
}

/**
 * Reviewer agent output — verifies executor results against user goal
 * Modeled after LiteEngine's CriticAgent (double-blind pattern)
 */
export interface ReviewerResult {
  /** Verdict: approved, needs retry, or needs clarification from user */
  verdict: 'approved' | 'needs_retry' | 'needs_clarification';
  /** Fraction of plan steps completed (0-1) */
  planCompletionRate: number;
  /** Step numbers that failed */
  failedSteps: number[];
  /** How well results match the user's goal (0-1, from AI assessment) */
  goalAlignment: number;
  /** Advice for the responder on how to frame the response */
  responseGuidance?: string;
  /** Steps to re-execute if verdict is needs_retry */
  retrySteps?: number[];
  /** What to ask the user if verdict is needs_clarification */
  clarificationNeeded?: string;
  /** Reviewer's reasoning */
  reasoning: string;
}

/**
 * Sub-executor result — returned by parallel sub-agent execution
 */
export interface SubExecutorResult extends ExecutorResult {
  /** Which plan step this sub-executor handled */
  stepNumber: number;
  /** Unique sub-executor ID */
  executorId: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP VALIDATOR TYPES — Editor mode pre-validation of generated IntentSteps
// Validates AI-generated steps against DOM + user goal BEFORE showing to user.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Issue found in a specific generated step
 */
export interface StepValidationIssue {
  /** 0-based index of the step with the issue */
  stepIndex: number;
  /** Severity: error = must fix, warning = acceptable but suboptimal */
  severity: 'error' | 'warning';
  /** Brief description of the problem */
  issue: string;
  /** How to fix it */
  suggestion: string;
}

/**
 * A step that the validator suggests adding
 */
export interface MissingStep {
  /** IntentStep type (navigate, click, type, ai_check, etc.) */
  type: string;
  /** Description of what the step should do */
  description: string;
  /** Insert after this step index (-1 for beginning) */
  insertAfter: number;
}

/**
 * Step validator output — validates generated IntentSteps before showing to user
 */
export interface StepValidationResult {
  /** Verdict: valid = show to user as-is, needs_fix = executor should regenerate or fix */
  verdict: 'valid' | 'needs_fix';
  /** How well the steps cover the user's goal (0-1) */
  goalCoverage: number;
  /** Per-step issues found */
  issues: StepValidationIssue[];
  /** Steps that should be added */
  missingSteps: MissingStep[];
  /** Brief overall assessment */
  reasoning: string;
  /** Duration of validation in ms */
  durationMs: number;
}
