---
description: AI prompt design rules — context-first approach, no keyword matching
globs:
  - "src/ai/prompts/**"
  - "src/services/ai/**"
  - "src/api/chat/**"
  - "src/agent/core/lite/prompt/**"
---

# AI Prompt Optimization Rules

## Core Principle: Context-First

```
1. CONTEXT & INTENT (what does the user want to do?)
2. SENTENCE STRUCTURE (question vs command)
3. KEYWORDS (only for refinement)
```

## NEVER do keyword-based matching

```typescript
// BAD
if (message.includes("API")) → api_test
const keywords = ['API', 'test', 'endpoint'];

// GOOD — understand intent
"Did you test API?" → ASKING about past → general_chat
"Test this API" → REQUESTING action → api_test
```

## Critical prompt files

1. **`buildIntentPrompt`** — `src/ai/prompts/intent-and-chat-prompts.ts`
   - Routes: platform_test vs api_test vs general_chat
   - Must distinguish questions from commands

2. **`buildChatSystemPrompt`** — `src/ai/prompts/intent-and-chat-prompts.ts`
   - AI behavior in general chat
   - Must reference history, not create new tests

3. **Other prompts** — `src/ai/prompts/`:
   - `intelligent-testing-prompts.ts` — page analysis, action generation
   - `test-plan-prompts.ts` — API test plans, URL analysis
   - `editor-resolver-prompts.ts` — editor element resolution
   - `prompt-utils.ts` — shared utilities, retry prompts

## Related services

- `src/services/ai/intent/intent-parser.service.ts` — intent parsing logic
- `src/services/ai/helpers/ai-helpers.service.ts` — AI helper functions
- `src/api/chat/chat.controller.ts` — chat routing

## Prompt design template

```typescript
export function buildXxxPrompt(params): string {
  return `You are [role]. Think like ChatGPT understanding natural language.

  YOUR TASK: Understand [what], not just match keywords.

  When user is [SCENARIO 1]:
     Signal: [How to detect]
     Examples: [Concrete examples]
     → Action: [What to do]

  --- EXAMPLES ---

  Ex1: "[User input]"
  CONTEXT: [Reasoning about what user wants]
  → [Expected output]
  `;
}
```

## Performance guidelines

- +10% tokens for +50% accuracy = GOOD
- +50% tokens for +10% accuracy = BAD
- -20% tokens with same accuracy = EXCELLENT

## After ANY prompt change

Test these scenarios:
- "Test this API https://..." → api_test
- "Did you run API test?" → general_chat
- "Test this API again" → api_test
- "yes, execute it" → approved=true
- "no, cancel" → approved=false
