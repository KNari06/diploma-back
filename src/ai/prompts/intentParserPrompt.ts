/**
 * Intent Parser Prompt
 * DEPRECATED: Use src/ai/prompts/index.ts instead
 * This file is kept for backward compatibility
 */

import { buildIntentPrompt as buildIntentPromptNew, IntentParserContext as IntentParserContextNew } from './index';

// Re-export from centralized prompts
export type IntentParserContext = IntentParserContextNew;
export const buildIntentPrompt = buildIntentPromptNew;
