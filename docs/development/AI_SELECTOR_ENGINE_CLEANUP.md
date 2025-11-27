# AI Selector Engine: Код который нужно почистить

**Дата:** 2024-11-27
**Файл:** `src/services/ai-selector/ai-selector-engine.service.ts`

---

## 🔍 Найденные проблемы

### 1. ❌ Неиспользуемый import: `Page` from Playwright

**Строка 9:**
```typescript
import { Page } from 'playwright';
```

**Проблема:** Нигде в файле `Page` не используется.

**Решение:** Удалить import.

```diff
- import { Page } from 'playwright';
```

---

### 2. ❌ Неиспользуемый import: `openai`

**Строки 8, 23-27:**
```typescript
import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 60000,
  maxRetries: 2,
});
```

**Проблема:**
- Импортируем `OpenAI`
- Создаём `openai` инстанс
- Но **нигде не используем** его в коде

**Причина:** Vision AI scoring (метод `scoreWithAI`) **не реализован** - только TODO.

**Решение:**
- **Вариант A:** Удалить `openai` (если Vision scoring не планируется скоро)
- **Вариант B:** Оставить закомментированным для будущей реализации

**Рекомендация:** Удалить сейчас, добавить когда будет реализовано Vision scoring.

```diff
- import { OpenAI } from 'openai';
-
- const openai = new OpenAI({
-   apiKey: env.OPENAI_API_KEY,
-   timeout: 60000,
-   maxRetries: 2,
- });
```

---

### 3. ⚠️ Не реализованный метод: `scoreWithAI()`

**Строки 311-320:**
```typescript
private static async scoreWithAI(
  candidates: DOMNode[],
  parsedIntent: ParsedIntent,
  request: SelectorResolveRequest
): Promise<Array<{ node: DOMNode; score: number; reasoning: string }>> {
  // TODO: Implement Vision AI scoring
  // For now, fallback to heuristics
  logger.debug('[AI_SELECTOR_ENGINE] Vision AI scoring not implemented yet, using heuristics');
  return this.scoreWithHeuristics(candidates, parsedIntent);
}
```

**Проблема:**
- Метод существует, но **не реализован**
- Всегда фоллбэчит на `scoreWithHeuristics()`
- При `mode: 'accurate'` пользователь ожидает Vision AI, но получает heuristics

**Решение:**

**Вариант A (сейчас):** Удалить метод, всегда использовать heuristics

```typescript
private static async scoreCandidates(
  candidates: DOMNode[],
  parsedIntent: ParsedIntent,
  request: SelectorResolveRequest,
  mode: 'fast' | 'accurate'
): Promise<Array<{ node: DOMNode; score: number; reasoning: string }>> {
  if (candidates.length === 0) {
    return [];
  }

  // Always use heuristic scoring (Vision AI not implemented yet)
  return this.scoreWithHeuristics(candidates, parsedIntent);
}
```

**Вариант B (будущее):** Реализовать Vision AI scoring с GPT-4o-vision

```typescript
private static async scoreWithAI(
  candidates: DOMNode[],
  parsedIntent: ParsedIntent,
  request: SelectorResolveRequest
): Promise<Array<{ node: DOMNode; score: number; reasoning: string }>> {
  if (!request.screenshot) {
    return this.scoreWithHeuristics(candidates, parsedIntent);
  }

  const prompt = `
  Analyze the screenshot and rank these ${candidates.length} elements by how well they match the intent: "${parsedIntent.target.description}".

  Candidates:
  ${candidates.map((c, i) => `${i+1}. ${c.tag} "${c.text}" at (${c.boundingBox.x}, ${c.boundingBox.y})`).join('\n')}

  Return JSON: [{ nodeId: "...", score: 0.0-1.0, reasoning: "..." }]
  `;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a UI element selector expert.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${request.screenshot}` } }
        ]
      }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const scores = JSON.parse(response.choices[0].message.content);

  return candidates.map(c => {
    const scoreData = scores.find(s => s.nodeId === c.nodeId);
    return {
      node: c,
      score: scoreData?.score || 0.5,
      reasoning: scoreData?.reasoning || 'No AI scoring available'
    };
  });
}
```

**Рекомендация:** Вариант A (удалить сейчас), реализовать Vision AI позже.

---

### 4. ⚠️ TODO комментарии

**Найдены 3 TODO:**

#### TODO #1: Pass goal from context
```typescript
// Line 65
goal: undefined, // TODO: Pass goal from context if available
```

**Проблема:** Goal не передаётся в IntentParser, хотя может улучшить accuracy.

**Решение:**
```typescript
goal: request.metadata.goal, // Pass goal if available
```

И обновить тип:
```typescript
// types.ts
export interface SelectorResolveRequest {
  // ...
  metadata: {
    url: string;
    viewport: { width: number; height: number };
    projectId?: string;
    userId?: string;
    goal?: string; // ← ADD THIS
  };
}
```

---

#### TODO #2: Implement Vision AI scoring
```typescript
// Line 316
// TODO: Implement Vision AI scoring
```

**Решение:** См. пункт 3 выше.

---

#### TODO #3: Track AI time
```typescript
// Line 561
aiDuration: 0, // TODO: Track AI time
```

**Проблема:** Не отслеживается время AI вызовов.

**Решение:**
```typescript
// In resolve():
const aiStartTime = Date.now();
const scoredCandidates = await this.scoreCandidates(...);
const aiDuration = Date.now() - aiStartTime;

// In buildResponse():
metrics: {
  totalDuration: Date.now() - startTime,
  aiDuration: aiDuration, // ← Use tracked time
  cacheHit,
}
```

---

### 5. ⚠️ Неиспользуемый тип: `SelectedNode`

**Строка 16:**
```typescript
import type {
  SelectorResolveRequest,
  SelectorResolveResponse,
  SelectedNode, // ← Не используется в файле
  SelectorCandidate,
  ParsedIntent,
  DOMNode,
  SelectorType,
} from './types';
```

**Проверка:** `SelectedNode` используется только в `buildResponse()` как часть `SelectorResolveResponse`.

**Решение:** Можно оставить (косвенно используется через response type).

---

### 6. ⚠️ Неиспользуемый тип: `SelectorType`

**Строка 20:**
```typescript
import type {
  // ...
  SelectorType, // ← Не используется напрямую
} from './types';
```

**Проверка:** `SelectorType` используется в selector generation методах.

**Решение:** Оставить (используется косвенно).

---

## 📝 Итоговый список изменений

### Критичные (нужно удалить):

1. ✅ **Удалить:** `import { Page } from 'playwright';` (не используется)
2. ✅ **Удалить:** `import { OpenAI } from 'openai';` (не используется)
3. ✅ **Удалить:** `const openai = new OpenAI(...)` (не используется)
4. ✅ **Удалить или упростить:** `scoreWithAI()` метод (не реализован)

### Не критичные (можно оставить):

5. ⚠️ **TODO:** Передавать goal в IntentParser
6. ⚠️ **TODO:** Трекать AI duration
7. ⚠️ **Оставить:** `SelectedNode` и `SelectorType` imports (косвенно используются)

---

## 🔧 Предлагаемые изменения

### Минимальная версия (удалить неиспользуемое):

```diff
- import { Page } from 'playwright';
- import { OpenAI } from 'openai';
  import type {
    SelectorResolveRequest,
    SelectorResolveResponse,
    SelectedNode,
    SelectorCandidate,
    ParsedIntent,
    DOMNode,
    SelectorType,
  } from './types';

- const openai = new OpenAI({
-   apiKey: env.OPENAI_API_KEY,
-   timeout: 60000,
-   maxRetries: 2,
- });

  // ... в scoreCandidates():

  private static async scoreCandidates(
    candidates: DOMNode[],
    parsedIntent: ParsedIntent,
    request: SelectorResolveRequest,
    mode: 'fast' | 'accurate'
  ): Promise<Array<{ node: DOMNode; score: number; reasoning: string }>> {
    if (candidates.length === 0) {
      return [];
    }

-   // Fast mode: Use heuristic scoring
-   if (mode === 'fast' || !request.screenshot) {
-     return this.scoreWithHeuristics(candidates, parsedIntent);
-   }
-
-   // Accurate mode: Use AI with Vision
-   return this.scoreWithAI(candidates, parsedIntent, request);
+   // Always use heuristic scoring (Vision AI not implemented yet)
+   // TODO: Implement Vision AI scoring for accurate mode
+   return this.scoreWithHeuristics(candidates, parsedIntent);
  }

- /**
-  * Score candidates using AI with Vision (accurate)
-  */
- private static async scoreWithAI(
-   candidates: DOMNode[],
-   parsedIntent: ParsedIntent,
-   request: SelectorResolveRequest
- ): Promise<Array<{ node: DOMNode; score: number; reasoning: string }>> {
-   // TODO: Implement Vision AI scoring
-   // For now, fallback to heuristics
-   logger.debug('[AI_SELECTOR_ENGINE] Vision AI scoring not implemented yet, using heuristics');
-   return this.scoreWithHeuristics(candidates, parsedIntent);
- }
```

---

### Расширенная версия (с улучшениями):

Добавить:
1. Goal в metadata
2. AI duration tracking
3. Комментарии для будущей Vision AI реализации

---

## ✅ Рекомендации

### Сейчас (приоритет):
1. ✅ Удалить `Page` import
2. ✅ Удалить `OpenAI` import и `openai` инстанс
3. ✅ Упростить `scoreCandidates()` - убрать проверку mode
4. ✅ Удалить `scoreWithAI()` метод

### Позже (optional):
5. ⚠️ Добавить goal в metadata
6. ⚠️ Трекать AI duration
7. ⚠️ Реализовать Vision AI scoring (когда понадобится)

---

**Итого:**
- **Удалить:** ~30 строк неиспользуемого кода
- **Упростить:** 1 метод (scoreCandidates)
- **Выигрыш:** Более чистый и понятный код

---

**Дата:** 2024-11-27
