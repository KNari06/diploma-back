/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CENTRALIZED PROMPTS FOR QAIT PLATFORM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All prompts are organized into logical files:
 * - intent-and-chat-prompts.ts: Intent parsing, chat, approval detection
 * - test-plan-prompts.ts: API test plans, UI test plans, fuzzing, questions
 * - intelligent-testing-prompts.ts: Intelligent mode (page analysis, actions, etc.)
 *
 * This file re-exports all prompts for backward compatibility.
 */

// Re-export from intent-and-chat-prompts.ts
export {
  buildApprovalDetectionPrompt, buildChatSystemPrompt, buildIntentPrompt, type IntentParserContext
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
  buildTestPlanPrompt,
  buildUrlAnalysisPrompt,
  buildUrlAnalysisSystemPrompt,
} from './test-plan-prompts';

// Re-export from intelligent-testing-prompts.ts
export {
  buildActionGenerationPrompt, buildLogicAnalysisPrompt, buildNextStepPrompt, buildPageAnalysisPrompt, buildVisionPrompt
} from './intelligent-testing-prompts';

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// TODO: KB Search temporarily disabled - will be re-enabled later
// /**
//  * Build context string for prompts
//  * Formats context (documentation, traces, projectInfo) into a readable string for AI prompts
//  */
// export function buildContextString(context?: {
//   documentation?: string[];
//   traces?: string;
//   projectInfo?: string;
// }): string {
//   if (!context) return '';

//   let contextStr = '\nAVAILABLE CONTEXT:\n';

//   if (context.documentation && context.documentation.length > 0) {
//     contextStr += `\nDocumentation:\n${context.documentation.join('\n')}`;
//   }

//   if (context.traces) {
//     contextStr += `\nPrevious Test Traces:\n${context.traces}`;
//   }

//   if (context.projectInfo) {
//     contextStr += `\nProject Information:\n${context.projectInfo}`;
//   }

//   return contextStr;
// }

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT ALL PROMPT BUILDERS (for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

import { buildActionGenerationPrompt, buildLogicAnalysisPrompt, buildNextStepPrompt, buildPageAnalysisPrompt, buildVisionPrompt } from './intelligent-testing-prompts';
import { buildApprovalDetectionPrompt, buildChatSystemPrompt, buildIntentPrompt } from './intent-and-chat-prompts';
import {
  buildApiFuzzingPrompt,
  buildApiTestPlanPrompt,
  buildCustomScopeStrategyPrompt,
  buildCustomScopeStrategySystemPrompt,
  buildDynamicQuestionPrompt,
  buildTestPlanPrompt,
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

  // 4. User interaction
  buildApprovalDetectionPrompt,

  // 5. API Fuzzing
  buildApiFuzzingPrompt,

  // 6. Intelligent testing
  buildPageAnalysisPrompt,
  buildActionGenerationPrompt,
  buildNextStepPrompt,
  buildLogicAnalysisPrompt,

  // 7. Vision analysis
  buildVisionPrompt,

  // 8. Test plan generator
  buildTestPlanPrompt,

  // 9. Dynamic questions
  buildDynamicQuestionPrompt,

  // 10. URL analysis
  buildUrlAnalysisPrompt,
  buildUrlAnalysisSystemPrompt,

  // 11. Custom scope strategy
  buildCustomScopeStrategyPrompt,
  buildCustomScopeStrategySystemPrompt,

  // 12. Utilities
  // buildContextString, // TODO: Temporarily disabled (KB disabled)
};
