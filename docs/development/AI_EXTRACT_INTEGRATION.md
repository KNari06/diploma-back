# AI Extract Service - Integration Status

## ✅ Status: Integrated with Cost Manager

`AIExtractService` теперь интегрирован с `AICostManager` для контроля бюджета AI операций.

---

## 🔄 Integration Points

### 1. CommandExecutor → AIExtractService

**File:** `src/agent/command-executor.ts`

**Flow:**
```typescript
// Constructor accepts cost manager
constructor(page: Page, options: {
  costManager?: AICostManager;
  // ... other options
})

// Passes cost manager to AI extraction
const result = await AIExtractService.extract(
  this.page,
  { selector, schema, mode, instructions },
  this.costManager  // ✅ Cost manager passed
);
```

### 2. IntelligentTestOrchestrator → CommandExecutor

**File:** `src/agent/intelligent-test-orchestrator.ts`

**Flow:**
```typescript
// Create CommandExecutor with cost manager
this.commandExecutor = new CommandExecutor(page, {
  abortSignal: this.abortController.signal,
  costManager: this.costManager,  // ✅ Cost manager passed
  metadata: { url, projectId, userId },
});
```

### 3. AIExtractService Signature

**File:** `src/services/ai-extract/ai-extract.service.ts`

**Signature:**
```typescript
static async extract(
  page: Page,
  request: AIExtractRequest,
  costManager?: AICostManager  // ✅ NEW: Optional cost manager
): Promise<AIExtractResponse>
```

---

## 📋 Next Steps (TODO)

### ✅ Completed:
1. Added `costManager` parameter to `AIExtractService.extract()`
2. Updated `CommandExecutor` to accept and pass cost manager
3. Updated `IntelligentTestOrchestrator` to pass cost manager to `CommandExecutor`

### ⏳ Pending (Critical):
1. **Implement cost tracking in `AIExtractService.extract()`**
   - Check budget before AI calls
   - Record costs after AI calls
   - Use adaptive model selection

2. **Add robust JSON parsing**
   - Replace all `JSON.parse()` with `parseRobustJSON()`

3. **Add PII masking**
   - Mask sensitive data before sending to OpenAI

4. **Fix empty selector issue**
   - Add `extractFromLocator()` method OR make selector optional

---

## 🎯 Implementation Plan

### Priority 1: Cost Tracking in extract()

```typescript
// In extract() method:

// 1. Check budget before extraction
if (costManager && !costManager.canContinue()) {
  logger.warn('[AI_EXTRACT] Budget exceeded');
  return {
    success: false,
    error: 'Budget exceeded',
    metadata: { tokensUsed: 0, duration: 0, model: AI_EXTRACT_CONFIG.MODEL, mode: 'text' },
  };
}

// 2. Get recommended model (adaptive)
const model = costManager
  ? costManager.getRecommendedModel(AI_EXTRACT_CONFIG.MODEL)
  : AI_EXTRACT_CONFIG.MODEL;

// 3. Call OpenAI with adaptive model
const response = await openai.chat.completions.create({
  model,  // ✅ Adaptive model
  // ... rest
});

// 4. Record cost
if (costManager) {
  costManager.recordOperation({
    operation: 'ai_extraction',
    model,
    inputTokens: response.usage?.prompt_tokens || 0,
    outputTokens: response.usage?.completion_tokens || 0,
  });
}
```

### Priority 2: Robust JSON Parsing

```typescript
import { parseRobustJSON } from '@/ai/prompts/prompt-utils';

// Replace all JSON.parse():
const result = parseRobustJSON(response.choices[0]?.message?.content || '{}');
```

### Priority 3: PII Masking

```typescript
import { maskPII } from '@/ai/prompts/prompt-utils';

// Before sending content:
const safeContent = maskPII(content);
```

---

## 📊 Current Status

- ✅ **Signature updated** - `costManager` parameter added
- ✅ **Integration complete** - Cost manager flows from Orchestrator → CommandExecutor → AIExtractService
- ⏳ **Implementation pending** - Actual cost tracking logic needs to be implemented
- ⏳ **Robust parsing pending** - JSON parsing improvements needed
- ⏳ **PII masking pending** - Privacy improvements needed

---

## 🔍 Testing

После реализации проверить:
1. AI extraction с budget limit → должен остановиться при превышении
2. AI extraction с adaptive mode → должен переключиться на gpt-4o-mini
3. AI extraction с invalid JSON → должен использовать robust parsing
4. AI extraction с PII data → должен замаскировать данные

---

## 📝 Notes

- AIExtractService делает **4-5 AI вызовов** на одну extraction:
  - `determineModeWithAI()` - ~500 tokens
  - `generateAdaptivePrompt()` - ~1000 tokens
  - Main extraction - ~2000-5000 tokens
  - `validateAgainstSchemaWithAI()` - ~500 tokens
  - Optional: `generateTableSchema()` / `generatePricingSchema()` - ~1000 tokens

- **Total cost per extraction: $0.10-0.25** (без cost manager)
- **Target cost per extraction: $0.03-0.08** (с cost manager + adaptive mode)

**Savings potential: 60-70%**
