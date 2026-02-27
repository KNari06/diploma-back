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

// Re-export from editor-resolver-prompts.ts
export {
  buildEditorResolverUserPrompt,
  EDITOR_RESOLVER_SYSTEM_PROMPT,
  parseEditorResolverResponse,
  type EditorResolverCandidate,
  type EditorResolverParams,
  type ResolverRankedCandidate,
  type ResolverResponse,
} from './editor-resolver-prompts';

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build context string for prompts
 * Formats context (documentation, traces, projectInfo) into a readable string for AI prompts
 */
export function buildContextString(context?: {
  documentation?: string[];
  traces?: string;
  projectInfo?: string;
}): string {
  if (!context) return '';

  let contextStr = '\nAVAILABLE CONTEXT:\n';

  if (context.documentation && context.documentation.length > 0) {
    contextStr += `\nDocumentation:\n${context.documentation.join('\n')}`;
  }

  if (context.traces) {
    contextStr += `\nPrevious Test Traces:\n${context.traces}`;
  }

  if (context.projectInfo) {
    contextStr += `\nProject Information:\n${context.projectInfo}`;
  }

  return contextStr;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT ALL PROMPT BUILDERS (for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

import { buildEditorResolverUserPrompt, EDITOR_RESOLVER_SYSTEM_PROMPT } from './editor-resolver-prompts';
import { buildActionGenerationPrompt, buildLogicAnalysisPrompt, buildNextStepPrompt, buildPageAnalysisPrompt, buildVisionPrompt } from './intelligent-testing-prompts';
import { buildChatSystemPrompt, buildIntentPrompt } from './intent-and-chat-prompts';
import {
  buildApiFuzzingPrompt,
  buildApiTestPlanPrompt,
  buildCustomScopeStrategyPrompt,
  buildCustomScopeStrategySystemPrompt,
  buildDynamicQuestionPrompt,
  buildUrlAnalysisPrompt,
  buildUrlAnalysisSystemPrompt,
} from './test-plan-prompts';

export const Prompts = {
  // 1. Intent parsing
  buildIntentPrompt,

  // 2. API test plans
  buildApiTestPlanPrompt,

  // 3. Chat/conversation
  buildChatSystemPrompt,

  // 4. API Fuzzing
  buildApiFuzzingPrompt,

  // 5. Intelligent testing
  buildPageAnalysisPrompt,
  buildActionGenerationPrompt,
  buildNextStepPrompt,
  buildLogicAnalysisPrompt,

  // 6. Vision analysis
  buildVisionPrompt,

  // 7. Dynamic questions
  buildDynamicQuestionPrompt,

  // 8. URL analysis
  buildUrlAnalysisPrompt,
  buildUrlAnalysisSystemPrompt,

  // 9. Custom scope strategy
  buildCustomScopeStrategyPrompt,
  buildCustomScopeStrategySystemPrompt,

  // 10. Utilities
  buildContextString,

  // 11. Editor resolver (step editor AI matching)
  buildEditorResolverUserPrompt,
  EDITOR_RESOLVER_SYSTEM_PROMPT,
};
