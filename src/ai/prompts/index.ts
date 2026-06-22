/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CENTRALIZED PROMPTS FOR QAIT PLATFORM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All prompts are organized into logical files:
 * - intent-and-chat-prompts.ts: Intent parsing, chat
 * - test-plan-prompts.ts: API test plans, fuzzing, questions, URL analysis
 * - intelligent-testing-prompts.ts: Intelligent mode (page analysis, actions, etc.)
 *
 * This file re-exports all prompts for backward compatibility.
 */

// Re-export from intent-and-chat-prompts.ts
export {
  buildChatSystemPrompt, buildIntentPrompt, type IntentParserContext
} from './intent-and-chat-prompts';

// Re-export from request-understanding-prompts.ts (ANALYZE / ENRICH / IMPROVE)
export {
  buildUnderstandingExtension,
  buildEnrichPrompt,
  type AnalyzeResult,
  type EnrichResult,
  type EnrichInputCandidate,
  type EnrichSessionContext,
  type ExecutionModifiers,
  type TargetSelectorType,
} from './request-understanding-prompts';

// Re-export from test-plan-prompts.ts
export {
  buildApiFuzzingPrompt,
  buildApiTestPlanPrompt,
  buildCustomScopeStrategyPrompt,
  buildCustomScopeStrategySystemPrompt,
  buildDynamicQuestionPrompt,
  buildPageNavigationPrompt,
  buildPageNavigationSystemPrompt,
  buildUrlAnalysisPrompt,
  buildUrlAnalysisSystemPrompt,
} from './test-plan-prompts';

// Re-export from intelligent-testing-prompts.ts
export {
  buildActionGenerationPrompt, buildLogicAnalysisPrompt, buildNextStepPrompt, buildPageAnalysisPrompt, buildVisionPrompt
} from './intelligent-testing-prompts';

// Re-export from api-flow-prompts.ts
export {
  buildAnalystSystemPrompt,
  buildAnalystPrompt,
  buildArchitectSystemPrompt,
  buildArchitectPrompt,
  buildEnricherSystemPrompt,
  buildEnricherPrompt,
  buildSwaggerDependencyPrompt,
  buildSwaggerDependencySystemPrompt,
  buildSwaggerDagMergePrompt,
  buildSwaggerFlowSummaryPrompt,
} from './api-flow-prompts';

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════
