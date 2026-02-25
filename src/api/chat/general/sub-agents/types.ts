import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SkillResult } from '@/services/skills/types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-AGENT PIPELINE TYPES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Type definitions for the chat sub-agent pipeline.
 * Router → [Planner] → Executor → Responder
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
  totalMs: number;
  routerClassification: string;
  routerConfidence: number;
  toolCategories: ToolCategory[];
  toolsProvided: number;
  toolRounds: number;
  toolsExecuted: string[];
}

/**
 * Full pipeline result — returned to handler.ts
 */
export interface SubAgentPipelineResult {
  success: boolean;
  content: string;
  path: 'simple_chat' | 'single_tool' | 'multi_tool' | 'fallback';
  metrics: PipelineMetrics;
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
}

/**
 * Context passed through the pipeline
 */
export interface PipelineContext {
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
  projectId?: string;
  previewSessionId?: string; // Active editor preview session
  mode?: 'lite' | 'pro' | 'editor';
}

/**
 * Configuration for the sub-agent pipeline
 */
export interface SubAgentConfig {
  enabled: boolean;
  routerConfidenceThreshold: number;
  maxToolRounds: number;
  circuitBreakerWindowSize: number;
  circuitBreakerFailThreshold: number;
  circuitBreakerRetryInterval: number;
  agentTimeoutMs: number;
}
