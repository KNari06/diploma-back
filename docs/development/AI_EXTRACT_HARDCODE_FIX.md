# AI Extract: Hardcode Removal ✅

**Дата:** 2024-11-27
**Статус:** ✅ Завершено

---

## 🎯 Задача

Убрать все хардкоды из `src/services/ai-extract/ai-extract.service.ts` и вынести их в константы.

---

## 🔍 Найденные хардкоды

### 1. **OpenAI Client Settings**

**Было:**
```typescript
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 30000, // ❌ Хардкод
  maxRetries: 2,  // ❌ Хардкод
});
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  OPENAI_TIMEOUT: 30000,
  OPENAI_MAX_RETRIES: 2,
  // ...
} as const;

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: AI_EXTRACT_CONFIG.OPENAI_TIMEOUT,
  maxRetries: AI_EXTRACT_CONFIG.OPENAI_MAX_RETRIES,
});
```

---

### 2. **Model Name** (3 места)

**Было:**
```typescript
model: 'gpt-4o-mini', // ❌ Хардкод (3 раза в коде)
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  MODEL: 'gpt-4o-mini',
  // ...
} as const;

model: AI_EXTRACT_CONFIG.MODEL,
```

---

### 3. **Temperature**

**Было:**
```typescript
temperature: 0.1, // ❌ Хардкод
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  TEMPERATURE: 0.1,
  // ...
} as const;

temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
```

---

### 4. **Element Wait Timeout**

**Было:**
```typescript
await element.first().waitFor({ state: 'visible', timeout: 5000 }); // ❌ Хардкод
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  ELEMENT_WAIT_TIMEOUT: 5000,
  // ...
} as const;

await element.first().waitFor({
  state: 'visible',
  timeout: AI_EXTRACT_CONFIG.ELEMENT_WAIT_TIMEOUT
});
```

---

### 5. **Content Length Limit**

**Было:**
```typescript
content.substring(0, 10000) // ❌ Хардкод
if (content.length > 10000) // ❌ Хардкод
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  MAX_CONTENT_LENGTH: 10000,
  // ...
} as const;

content.substring(0, AI_EXTRACT_CONFIG.MAX_CONTENT_LENGTH)
if (content.length > AI_EXTRACT_CONFIG.MAX_CONTENT_LENGTH)
```

---

### 6. **Confidence Scores**

**Было:**
```typescript
confidence: isValid ? 0.9 : 0.6, // ❌ Хардкод
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  CONFIDENCE_HIGH: 0.9,
  CONFIDENCE_LOW: 0.6,
  // ...
} as const;

confidence: isValid
  ? AI_EXTRACT_CONFIG.CONFIDENCE_HIGH
  : AI_EXTRACT_CONFIG.CONFIDENCE_LOW,
```

---

### 7. **HTML Mode Tags**

**Было:**
```typescript
const htmlTags = ['TABLE', 'UL', 'OL', 'DL', 'FORM', 'SECTION', 'ARTICLE']; // ❌ Хардкод
if (htmlTags.includes(tagName)) {
```

**Стало:**
```typescript
const AI_EXTRACT_CONFIG = {
  HTML_MODE_TAGS: ['TABLE', 'UL', 'OL', 'DL', 'FORM', 'SECTION', 'ARTICLE'] as const,
  // ...
} as const;

if ((AI_EXTRACT_CONFIG.HTML_MODE_TAGS as readonly string[]).includes(tagName)) {
```

---

### 8. **System Prompt**

**Было:**
```typescript
content: `You are a data extraction expert. Extract structured data...`, // ❌ Хардкод (многострочный)
```

**Стало:**
```typescript
const EXTRACTION_SYSTEM_PROMPT = `You are a data extraction expert. Extract structured data...`;

content: EXTRACTION_SYSTEM_PROMPT,
```

---

### 9. **Helper Instructions** (3 места)

**Было:**
```typescript
instructions: 'Extract table data. First row contains column headers.', // ❌ Хардкод
instructions: 'Extract all list items.', // ❌ Хардкод
instructions: 'Extract pricing information for all plans.', // ❌ Хардкод
```

**Стало:**
```typescript
const HELPER_INSTRUCTIONS = {
  TABLE_WITH_HEADER: 'Extract table data. First row contains column headers.',
  TABLE_WITH_COLUMNS: (columns: string[]) => `Extract table data. Use these column names: ${columns.join(', ')}`,
  TABLE_AUTO: 'Extract table data. Infer column names from content.',
  LIST: 'Extract all list items.',
  PRICING: 'Extract pricing information for all plans.',
} as const;

instructions: HELPER_INSTRUCTIONS.TABLE_WITH_HEADER,
instructions: HELPER_INSTRUCTIONS.LIST,
instructions: HELPER_INSTRUCTIONS.PRICING,
```

---

## 📊 Итоговая структура констант

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const AI_EXTRACT_CONFIG = {
  // OpenAI client settings
  OPENAI_TIMEOUT: 30000,
  OPENAI_MAX_RETRIES: 2,

  // Model settings
  MODEL: 'gpt-4o-mini',
  TEMPERATURE: 0.1,

  // Element wait settings
  ELEMENT_WAIT_TIMEOUT: 5000,

  // Content limits
  MAX_CONTENT_LENGTH: 10000,

  // Confidence thresholds
  CONFIDENCE_HIGH: 0.9,
  CONFIDENCE_LOW: 0.6,

  // HTML tags that require HTML mode extraction
  HTML_MODE_TAGS: ['TABLE', 'UL', 'OL', 'DL', 'FORM', 'SECTION', 'ARTICLE'] as const,
} as const;

const EXTRACTION_SYSTEM_PROMPT = `...`;

const HELPER_INSTRUCTIONS = {
  TABLE_WITH_HEADER: '...',
  TABLE_WITH_COLUMNS: (columns: string[]) => `...`,
  TABLE_AUTO: '...',
  LIST: '...',
  PRICING: '...',
} as const;
```

---

## ✅ Результат

### Удалено хардкодов:

| Тип | Количество | Статус |
|-----|------------|--------|
| Числовые константы | 5 | ✅ Вынесены |
| Строковые константы | 3 | ✅ Вынесены |
| Массивы | 1 | ✅ Вынесены |
| Многострочные строки | 2 | ✅ Вынесены |
| **ИТОГО** | **11** | ✅ **Все исправлены** |

---

### Преимущества:

1. ✅ **Легко изменять** - все константы в одном месте
2. ✅ **Читаемость** - понятные имена вместо магических чисел
3. ✅ **Maintainability** - проще обновлять значения
4. ✅ **Type safety** - `as const` для иммутабельности
5. ✅ **Consistency** - единый стиль с другими сервисами

---

## 🔍 Проверки

- ✅ TypeScript компиляция - 0 errors
- ✅ Linter - 0 errors
- ✅ Все хардкоды вынесены
- ✅ Константы используются везде

---

## 📝 Сравнение с другими сервисами

### Паттерн соответствует:

```typescript
// src/services/ai/ai.service.ts
const AI_TIMEOUT = 30000;
const MAX_DOM_LENGTH = 10000;
const ANALYSIS_TEMPERATURE = 0.3;

// src/services/ai/intentParser.service.ts
const RAG_TIMEOUT = 5000;
const GPT_TIMEOUT = 10000;
const CACHE_TTL = 60000;

// src/services/ai-extract/ai-extract.service.ts
const AI_EXTRACT_CONFIG = {
  OPENAI_TIMEOUT: 30000,
  ELEMENT_WAIT_TIMEOUT: 5000,
  // ...
} as const;
```

**Вердикт:** ✅ Следуем единому паттерну проекта

---

## ✅ Готово!

**Все хардкоды удалены и вынесены в константы!** 🎉

---

**Дата:** 2024-11-27
**Файл:** `src/services/ai-extract/ai-extract.service.ts`
