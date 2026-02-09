# AI Provider Guide

Universal AI infrastructure for QAI-BackEnd with support for **Google Gemini** and **OpenAI GPT**.

---

## 📋 Quick Start

### 1. **Environment Configuration**

Add to `.env`:

```bash
# Google Gemini
GEMINI_API_KEY=your_gemini_api_key_here

# AI Provider Selection
AI_PROVIDER_FAST=gemini    # For fast tasks (keyword extraction, classification)
AI_PROVIDER_SMART=openai   # For complex tasks (analysis, code generation)
```

### 2. **Usage Examples**

#### **Simple Text Generation (Fast Tasks)**

```typescript
import { generateText } from '@/services/ai/core/ai-provider.service';

// Extract keywords (uses Gemini Flash by default)
const response = await generateText({
  prompt: "Extract keywords from: 'Click on the login button'",
  task: 'fast',
  temperature: 0,
  maxTokens: 50,
});

console.log(response.content); // "login"
console.log(response.usage.provider); // "gemini"
console.log(response.usage.model); // "gemini-1.5-flash"
```

#### **Chat Completion (Smart Tasks)**

```typescript
import { generateChatCompletion } from '@/services/ai/core/ai-provider.service';

// Complex analysis (uses GPT-4o by default)
const response = await generateChatCompletion({
  messages: [
    { role: 'system', content: 'You are a test automation expert' },
    { role: 'user', content: 'How do I test a login form?' },
  ],
  task: 'smart',
  temperature: 0.7,
});

console.log(response.content);
console.log(response.usage.provider); // "openai"
console.log(response.usage.model); // "gpt-4o"
```

#### **Override Provider**

```typescript
// Force Gemini for a smart task
const response = await generateChatCompletion({
  messages: [...],
  task: 'smart',
  provider: 'gemini', // Override default (openai)
});
```

---

## 🎯 When to Use Which

| Task Type | Default Provider | Model | Speed | Cost (1K calls) |
|-----------|------------------|-------|-------|-----------------|
| **Fast** (keyword extraction, classification) | Gemini | gemini-1.5-flash | 100-200ms | $0.01 |
| **Smart** (analysis, code generation) | OpenAI | gpt-4o | 500-1500ms | $0.50 |

---

## 🏗️ Architecture

### **Files**

```
src/
├── services/ai/core/
│   ├── ai-provider.service.ts    # 🎯 Main entry point (unified API)
│   ├── gemini.service.ts          # Google Gemini implementation
│   └── openai.service.ts          # OpenAI GPT implementation
├── utils/text-processing/
│   └── ai-keyword-extractor.ts    # AI-powered keyword extraction (multilingual)
└── config/environment/
    └── env.ts                      # Environment configuration
```

### **Data Flow**

```
Your Code
    ↓
ai-provider.service.ts
    ↓
 ┌──────────────────┐
 │ Task = 'fast'?   │
 └────┬─────────┬───┘
      │         │
   YES│         │NO
      ↓         ↓
   Gemini    OpenAI
  (Flash)    (GPT-4o)
```

---

## 🔧 Configuration Options

### **Task Types**

- **`fast`**: Quick tasks that need speed over complexity
  - Keyword extraction
  - Text classification
  - Simple transformations
  - Default: Gemini 1.5 Flash

- **`smart`**: Complex tasks that need advanced reasoning
  - Code analysis
  - Test generation
  - Multi-step reasoning
  - Default: GPT-4o

### **Provider Override**

```typescript
{
  provider: 'gemini' | 'openai',  // Override default for task type
  task: 'fast' | 'smart',          // Task complexity level
  model: 'custom-model-name',      // Override specific model
  temperature: 0-1,                // Creativity (0 = deterministic)
  maxTokens: number,               // Max output length
  timeout: number,                 // Request timeout (ms)
}
```

---

## 🚀 Advanced Usage

### **AI Keyword Extraction (Multilingual)**

Automatically works for **any language** (English, Russian, Turkish, Arabic, Chinese, etc.):

```typescript
import { extractKeywordsWithAI } from '@/utils/text-processing/ai-keyword-extractor';

// English
const en = await extractKeywordsWithAI("Click on the login button");
// → ["login"]

// Russian
const ru = await extractKeywordsWithAI("Нажми на кнопку входа");
// → ["входа"]

// Turkish
const tr = await extractKeywordsWithAI("Giriş butonuna tıkla");
// → ["giriş"]

// Arabic
const ar = await extractKeywordsWithAI("انقر على زر تسجيل الدخول");
// → ["تسجيل", "الدخول"]
```

**Features:**
- ✅ **Cached**: Subsequent calls are instant (cache TTL: 1 hour)
- ✅ **Fallback**: If AI fails, uses regex-based extraction
- ✅ **Smart**: Understands context (removes stop words, action verbs)

### **Check Provider Availability**

```typescript
import { isProviderAvailable, getAvailableProviders } from '@/services/ai/core/ai-provider.service';

if (isProviderAvailable('gemini')) {
  console.log('Gemini is configured');
}

const providers = getAvailableProviders();
// ['openai', 'gemini']
```

---

## 💰 Cost Comparison

| Provider | Model | Input (1M tokens) | Output (1M tokens) | Typical Task Cost |
|----------|-------|-------------------|-------------------|-------------------|
| **Gemini** | 1.5 Flash | $0.075 | $0.30 | $0.00001/call |
| **Gemini** | 1.5 Pro | $1.25 | $5.00 | $0.0001/call |
| **OpenAI** | GPT-4o-mini | $0.15 | $0.60 | $0.00003/call |
| **OpenAI** | GPT-4o | $2.50 | $10.00 | $0.0005/call |

**With 80% cache hit rate**, effective cost for fast tasks: **~$0.002/1000 calls**

---

## 🔐 Security

- ✅ API keys stored in `.env` (never committed to git)
- ✅ Keys validated on startup (`env.ts` schema)
- ✅ Timeout protection (prevents hanging requests)
- ✅ Rate limit handling (automatic retry with exponential backoff)

---

## 🐛 Troubleshooting

### **"GEMINI_API_KEY is not configured"**

Add to `.env`:
```bash
GEMINI_API_KEY=your_key_here
```

### **Timeout errors**

Increase timeout:
```typescript
await generateText({
  prompt: "...",
  timeout: 10000, // 10 seconds instead of default 5s
});
```

### **"Circuit breaker opened" in embeddings-resolver**

This is normal. The system automatically falls back to regex-based keyword extraction when AI is unavailable.

---

## 📊 Monitoring

All AI calls are logged with metrics:

```json
{
  "provider": "gemini",
  "model": "gemini-1.5-flash",
  "task": "fast",
  "promptLength": 45,
  "tokensUsed": 23,
  "latencyMs": 142
}
```

Search logs for `[AI_PROVIDER]` to track usage.

---

## 🎓 Examples in Codebase

1. **Keyword Extraction**: `src/services/testing/ui/preview/embeddings-resolver.service.ts`
   - `buildAllowedSets()` uses AI to extract keywords for element matching

2. **Fallback Mode**: `src/services/testing/ui/preview/intent-step-lint.service.ts`
   - `scoreCandidate()` uses sync fallback when embeddings unavailable

3. **Cache Management**: `src/utils/text-processing/ai-keyword-extractor.ts`
   - Automatic LRU cache with TTL (1 hour, max 1000 entries)

---

## 🔄 Migration from Hardcoded Stop Words

**Before:**
```typescript
const stopWords = new Set(['the', 'a', 'an', ...]); // English only
return text.split(' ').filter(w => !stopWords.has(w));
```

**After:**
```typescript
import { extractKeywordsWithAI } from '@/utils/text-processing/ai-keyword-extractor';
const keywords = await extractKeywordsWithAI(text); // Works for all languages
```

---

## 📝 Future Enhancements

- [ ] Add Claude support (Anthropic)
- [ ] Add Llama support (local/self-hosted)
- [ ] Token usage tracking dashboard
- [ ] Cost alerts when exceeding budget
- [ ] A/B testing between providers

---

**Questions?** Check the source code or ask in Slack #ai-infrastructure
