# AI Services Reorganization Plan

## Current Structure (flat)

```
/services/ai/
├── ai-cost-manager.service.ts     # Cost management
├── chat-embeddings.service.ts     # Chat embeddings (uses embedding.service)
├── ai-helpers.service.ts          # Helper functions (uses openai.service)
├── ai.service.ts                  # Test results analysis
├── embedding.service.ts           # Base embeddings (uses openai)
├── intentParser.service.ts        # Intent parsing (uses ai-helpers, openai)
├── openai.service.ts              # Base OpenAI client
└── vision-analyzer.service.ts     # Vision API analysis
```

## Proposed Structure (organized by purpose)

```
/services/ai/
├── core/                          # Core infrastructure
│   ├── openai.service.ts         # OpenAI client, getChatCompletionWithMessages
│   └── embedding.service.ts      # Base embedding generation
├── embeddings/                    # Specialized embeddings
│   └── chat-embeddings.service.ts # Chat message embeddings (uses core/embedding)
├── intent/                        # Intent parsing
│   └── intent-parser.service.ts  # User intent detection (uses helpers, core/openai)
├── helpers/                       # Helper functions
│   └── ai-helpers.service.ts     # detectUserApproval, extractUrlWithGPT, etc (uses core/openai)
├── analysis/                      # Data analysis
│   ├── test-results.service.ts   # Test results analysis (renamed from ai.service.ts)
│   └── vision-analyzer.service.ts # Screenshot analysis
└── cost/                          # Cost management
    └── ai-cost-manager.service.ts # Cost tracking and budget control
```

## File Mappings

1. `openai.service.ts` → `core/openai.service.ts`
2. `embedding.service.ts` → `core/embedding.service.ts`
3. `chat-embeddings.service.ts` → `embeddings/chat-embeddings.service.ts`
4. `intentParser.service.ts` → `intent/intent-parser.service.ts`
5. `ai-helpers.service.ts` → `helpers/ai-helpers.service.ts`
6. `ai.service.ts` → `analysis/test-results.service.ts` (rename for clarity)
7. `vision-analyzer.service.ts` → `analysis/vision-analyzer.service.ts`
8. `ai-cost-manager.service.ts` → `cost/ai-cost-manager.service.ts`

## Import Updates Required

- All files importing from `@/services/ai/*` need to be updated to new paths
- chat-embeddings imports embedding.service → update to `@/services/ai/core/embedding.service`
- intentParser imports ai-helpers → update to `@/services/ai/helpers/ai-helpers.service`
- ai-helpers imports openai.service → update to `@/services/ai/core/openai.service`
- Many files import openai.service → update to `@/services/ai/core/openai.service`
