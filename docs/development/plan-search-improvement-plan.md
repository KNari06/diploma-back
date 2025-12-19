# План исправления минусов поиска тест-планов

## Приоритеты

**P0 (Критично):** Исправления безопасности и корректности
**P1 (Важно):** Улучшения точности и UX
**P2 (Желательно):** Оптимизации и улучшения

---

## Этап 1: Быстрые фиксы (P0) - 1-2 дня

### Задача 1.1: Добавить проверку expires_at для плана по conversationId

**Проблема:** План по `conversationId` может быть истекшим

**Решение:**
```typescript
// В findPendingTestPlan() после получения плана
if (planByConversation) {
  // Проверить expires_at
  if (new Date(planByConversation.expiresAt) <= new Date()) {
    logger.warn('[PENDING_PLAN_SEARCH] Plan by conversationId expired', {
      planId: planByConversation.id,
      expiresAt: planByConversation.expiresAt,
    });
    planByConversation = null; // Использовать fallback
  }
}
```

**Файлы:**
- `src/api/chat/chat.controller.ts` (функция `findPendingTestPlan`)

**Оценка:** 30 минут

---

### Задача 1.2: Улучшить проверку lastAiMessage

**Проблема:** Ограничение 5 сообщениями может пропустить тест-план

**Решение:**
```typescript
// Вместо поиска последнего AI сообщения, искать последнее с requiresApproval
const lastTestPlanMessage = recentMessages
  .slice()
  .reverse()
  .find((msg: any) =>
    msg.role === 'ai' &&
    (msg.metadata?.requiresApproval === true ||
     msg.metadata?.testPlan ||
     msg.metadata?.conversationId)
  );

lastAiMessageWasTestPlan = !!lastTestPlanMessage;
```

**Файлы:**
- `src/api/chat/chat.controller.ts` (функция `handlePendingTestPlanApproval`)

**Оценка:** 20 минут

---

### Задача 1.3: Добавить базовую проверку контекста (URL, keywords)

**Проблема:** Не учитывается содержание сообщения пользователя

**Решение:**
```typescript
// После получения pendingPlan, проверить контекст
function matchesUserContext(plan: TestPlan, userMessage: string): boolean {
  const messageLower = userMessage.toLowerCase();
  const planUrl = plan.url.toLowerCase();
  const planScope = plan.scope.toLowerCase();

  // Проверка 1: URL упомянут в сообщении
  const urlInMessage = extractUrl(userMessage);
  if (urlInMessage && !planUrl.includes(urlInMessage)) {
    return false; // URL не совпадает
  }

  // Проверка 2: Ключевые слова из scope
  const scopeKeywords = planScope.split(/\s+/).filter(kw => kw.length > 3);
  const hasMatchingKeyword = scopeKeywords.some(kw => messageLower.includes(kw));

  // Если URL не упомянут, но есть keywords - OK
  // Если URL упомянут и не совпадает - NOT OK
  if (urlInMessage) {
    return planUrl.includes(urlInMessage); // Строгая проверка URL
  }

  return hasMatchingKeyword; // Мягкая проверка keywords
}

// Использование
if (pendingPlan && !matchesUserContext(pendingPlan, message)) {
  logger.warn('[APPROVAL_CHECK] Plan context mismatch', {
    planId: pendingPlan.id,
    planUrl: pendingPlan.url,
    planScope: pendingPlan.scope,
    userMessage: message,
  });
  return false; // Не обрабатывать approval
}
```

**Файлы:**
- `src/api/chat/chat.controller.ts` (новая функция `matchesUserContext`)
- `src/utils/url-resolver.service.ts` (функция `extractUrl`)

**Оценка:** 1 час

---

## Этап 2: Семантический поиск (P1) - 3-5 дней

### Задача 2.1: Создать таблицу для embeddings тест-планов

**Решение:**
```sql
-- supabase-migrations/features/test-plan-embeddings.sql
CREATE TABLE IF NOT EXISTS test_plan_embeddings (
  plan_id TEXT PRIMARY KEY REFERENCES test_plans(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  model_version TEXT DEFAULT 'text-embedding-3-small',
  metadata JSONB DEFAULT '{}'
);

-- Индекс для векторного поиска
CREATE INDEX idx_test_plan_embeddings_vector
ON test_plan_embeddings USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Комментарии
COMMENT ON TABLE test_plan_embeddings IS 'Vector embeddings for semantic search of test plans';
COMMENT ON COLUMN test_plan_embeddings.embedding IS '1536-dimensional vector from OpenAI text-embedding-3-small';
```

**Файлы:**
- `supabase-migrations/features/test-plan-embeddings.sql`

**Оценка:** 30 минут

---

### Задача 2.2: Создать сервис для работы с embeddings планов

**Решение:**
```typescript
// src/services/testing/plans/test-plan-embeddings.service.ts

import { generateEmbedding } from '@/services/ai/embedding.service';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

export class TestPlanEmbeddingsService {
  /**
   * Generate and store embedding for test plan
   */
  static async embedTestPlan(planId: string, plan: {
    url: string;
    scope: string;
    summary: string;
  }): Promise<boolean> {
    try {
      // Combine plan fields for embedding
      const planText = `${plan.url} ${plan.scope} ${plan.summary}`;

      // Generate embedding
      const embedding = await generateEmbedding(planText);

      // Store in database
      const { error } = await supabaseAdmin
        .from('test_plan_embeddings')
        .upsert({
          plan_id: planId,
          embedding,
          model_version: 'text-embedding-3-small',
          metadata: {
            url: plan.url,
            scope: plan.scope,
            embedded_at: new Date().toISOString(),
          },
        }, {
          onConflict: 'plan_id',
        });

      if (error) {
        logger.error('[TEST_PLAN_EMBEDDINGS] Failed to store embedding', { error, planId });
        return false;
      }

      logger.info('[TEST_PLAN_EMBEDDINGS] Embedding stored', { planId });
      return true;
    } catch (error) {
      logger.error('[TEST_PLAN_EMBEDDINGS] Error generating embedding', { error, planId });
      return false;
    }
  }

  /**
   * Search test plans semantically
   */
  static async searchPlansBySemantic(
    query: string,
    userId: string,
    options: {
      limit?: number;
      threshold?: number;
    } = {}
  ): Promise<Array<{ plan: any; similarity: number }>> {
    const { limit = 5, threshold = 0.5 } = options;

    try {
      // Generate query embedding
      const queryEmbedding = await generateEmbedding(query);

      // Search using Supabase RPC (нужно создать функцию в БД)
      const { data, error } = await supabaseAdmin.rpc('search_test_plans', {
        p_user_id: userId,
        p_query_embedding: queryEmbedding,
        p_match_count: limit,
        p_match_threshold: threshold,
      });

      if (error) {
        logger.error('[TEST_PLAN_EMBEDDINGS] Search failed', { error });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[TEST_PLAN_EMBEDDINGS] Error searching', { error });
      return [];
    }
  }
}
```

**Файлы:**
- `src/services/testing/plans/test-plan-embeddings.service.ts` (новый)

**Оценка:** 2 часа

---

### Задача 2.3: Создать SQL функцию для векторного поиска

**Решение:**
```sql
-- supabase-migrations/features/test-plan-embeddings-search.sql
CREATE OR REPLACE FUNCTION search_test_plans(
  p_user_id TEXT,
  p_query_embedding vector(1536),
  p_match_count INT DEFAULT 5,
  p_match_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  plan_id TEXT,
  similarity FLOAT,
  url TEXT,
  scope TEXT,
  summary TEXT,
  status TEXT,
  expires_at TIMESTAMP
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    tp.id AS plan_id,
    1 - (tpe.embedding <=> p_query_embedding) AS similarity,
    tp.url,
    tp.scope,
    tp.summary,
    tp.status,
    tp.expires_at
  FROM test_plans tp
  INNER JOIN test_plan_embeddings tpe ON tp.id = tpe.plan_id
  WHERE
    tp.user_id = p_user_id
    AND tp.status = 'pending_confirmation'
    AND tp.expires_at > NOW()
    AND (1 - (tpe.embedding <=> p_query_embedding)) >= p_match_threshold
  ORDER BY tpe.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$ LANGUAGE plpgsql;
```

**Файлы:**
- `supabase-migrations/features/test-plan-embeddings-search.sql` (новый)

**Оценка:** 1 час

---

### Задача 2.4: Автоматически создавать embeddings при сохранении плана

**Решение:**
```typescript
// В src/services/testing/plans/exploration-cache.service.ts
// В функции saveTestPlan() после успешного сохранения:

import { TestPlanEmbeddingsService } from './test-plan-embeddings.service';

export async function saveTestPlan(...) {
  // ... существующий код сохранения ...

  // После успешного сохранения - создать embedding (не блокируя ответ)
  TestPlanEmbeddingsService.embedTestPlan(testPlan.id, {
    url: testPlan.url,
    scope: testPlan.scope,
    summary: testPlan.summary,
  }).catch(error => {
    logger.warn('[SAVE_TEST_PLAN] Failed to create embedding', { error, planId: testPlan.id });
    // Не критично - можно создать позже
  });

  return { success: true };
}
```

**Файлы:**
- `src/services/testing/plans/exploration-cache.service.ts`

**Оценка:** 30 минут

---

### Задача 2.5: Интегрировать семантический поиск в findPendingTestPlan

**Решение:**
```typescript
// В src/api/chat/chat.controller.ts
async function findPendingTestPlan(
  conversationId: string | undefined,
  userId: string,
  userMessage?: string // NEW: для семантического поиска
): Promise<{ plan: any | null; method: string; confidence?: number }> {

  // Шаг 1: По conversationId (как сейчас)
  const isValidConversationId = conversationId && isValidUUID(conversationId);
  let planByConversation = null;

  if (isValidConversationId) {
    planByConversation = await getTestPlan(conversationId, userId);

    // Проверка expires_at
    if (planByConversation && new Date(planByConversation.expiresAt) <= new Date()) {
      logger.warn('[PENDING_PLAN_SEARCH] Plan by conversationId expired');
      planByConversation = null;
    }
  }

  if (planByConversation) {
    return { plan: planByConversation, method: 'conversationId', confidence: 1.0 };
  }

  // Шаг 2: Семантический поиск (если есть userMessage)
  if (userMessage && userMessage.trim().length > 0) {
    const semanticResults = await TestPlanEmbeddingsService.searchPlansBySemantic(
      userMessage,
      userId,
      { limit: 3, threshold: 0.6 }
    );

    if (semanticResults.length > 0) {
      const bestMatch = semanticResults[0];

      // Проверка gap между первым и вторым результатом
      const secondMatch = semanticResults[1];
      const gap = bestMatch.similarity - (secondMatch?.similarity || 0);

      if (gap >= 0.15 && bestMatch.similarity >= 0.7) {
        // Четкий результат
        logger.info('[PENDING_PLAN_SEARCH] Found plan via semantic search', {
          planId: bestMatch.plan.plan_id,
          similarity: bestMatch.similarity,
          gap,
        });
        return {
          plan: await getTestPlan(bestMatch.plan.plan_id, userId),
          method: 'semantic',
          confidence: bestMatch.similarity,
        };
      }

      // Неоднозначность - вернуть несколько вариантов
      if (semanticResults.length >= 2 && gap < 0.15) {
        return {
          plan: null,
          method: 'semantic_ambiguous',
          confidence: bestMatch.similarity,
          options: semanticResults.slice(0, 3), // Для handleAmbiguousPlans
        };
      }
    }
  }

  // Шаг 3: Fallback к последнему плану (как сейчас)
  const latestPlan = await getLatestPendingTestPlan(userId);
  if (latestPlan) {
    return { plan: latestPlan, method: 'fallback', confidence: 0.5 };
  }

  return { plan: null, method: 'none' };
}
```

**Файлы:**
- `src/api/chat/chat.controller.ts` (функция `findPendingTestPlan`)

**Оценка:** 2 часа

---

## Этап 3: Обработка неоднозначности (P1) - 2-3 дня

### Задача 3.1: Создать функцию handleAmbiguousPlans

**Решение:**
```typescript
// В src/api/chat/chat.controller.ts
async function handleAmbiguousPlans(
  req: Request,
  res: Response,
  options: Array<{ plan: any; similarity: number }>,
  userMessage: string,
  chatSessionId?: string
): Promise<boolean> {

  // Форматируем варианты
  const optionsText = options.map((item, idx) => {
    const plan = item.plan;
    return `${idx + 1}. **${plan.scope}** на ${plan.url}\n   ${plan.summary.substring(0, 100)}...`;
  }).join('\n\n');

  const clarificationMessage = `Я нашел несколько тест-планов, которые подходят под ваш запрос. Какой вы хотите запустить?\n\n${optionsText}\n\nОтветьте номером (1, 2, 3) или опишите более детально.`;

  // Сохраняем варианты в metadata
  await ChatService.saveChatMessages(chatSessionId, [
    { role: 'user', content: userMessage },
    {
      role: 'ai',
      content: clarificationMessage,
      metadata: {
        type: 'plan_selection',
        options: options.map(item => ({
          planId: item.plan.plan_id,
          scope: item.plan.scope,
          url: item.plan.url,
          similarity: item.similarity,
        })),
      },
    },
  ]);

  res.json({
    success: true,
    reply: clarificationMessage,
    sessionId: chatSessionId,
    requiresClarification: true,
  });

  return true;
}
```

**Файлы:**
- `src/api/chat/chat.controller.ts` (новая функция)

**Оценка:** 1 час

---

### Задача 3.2: Обработать ответ пользователя на уточнение

**Решение:**
```typescript
// В handlePendingTestPlanApproval, перед поиском плана:
if (chatSessionId) {
  const recentMessages = await ChatService.getRecentMessages(chatSessionId, userId, 5);
  const lastAiMessage = recentMessages
    .slice()
    .reverse()
    .find((msg: any) => msg.role === 'ai');

  // Проверка: пользователь отвечает на вопрос о выборе плана?
  if (lastAiMessage?.metadata?.type === 'plan_selection') {
    const selectedPlanId = parsePlanSelection(message, lastAiMessage.metadata.options);

    if (selectedPlanId) {
      const plan = await getTestPlan(selectedPlanId, userId);
      if (plan && !isExpired(plan) && plan.status === 'pending_confirmation') {
        // Запускаем выбранный план
        await executeApprovedTestPlan(req, res, {
          planId: plan.id,
          userId,
          chatSessionId,
          workspace_id,
          userMessage: message,
        });
        return true;
      }
    }
  }
}

// Новая функция для парсинга выбора
function parsePlanSelection(
  message: string,
  options: Array<{ planId: string; scope: string; url: string }>
): string | null {
  // Вариант 1: Номер (1, 2, 3)
  const numberMatch = message.match(/\b([1-3])\b/);
  if (numberMatch) {
    const index = parseInt(numberMatch[1]) - 1;
    return options[index]?.planId || null;
  }

  // Вариант 2: URL
  const urlInMessage = extractUrl(message);
  if (urlInMessage) {
    const matching = options.find(opt => opt.url.includes(urlInMessage));
    return matching?.planId || null;
  }

  // Вариант 3: Scope keywords
  const messageLower = message.toLowerCase();
  for (const opt of options) {
    const scopeWords = opt.scope.toLowerCase().split(/\s+/);
    if (scopeWords.some(word => messageLower.includes(word) && word.length > 3)) {
      return opt.planId;
    }
  }

  return null;
}
```

**Файлы:**
- `src/api/chat/chat.controller.ts` (функция `handlePendingTestPlanApproval`)

**Оценка:** 1.5 часа

---

## Этап 4: Улучшения и оптимизации (P2) - 1-2 дня

### Задача 4.1: Добавить детальное логирование

**Решение:**
```typescript
// В findPendingTestPlan добавить логирование reasoning
logger.info('[PENDING_PLAN_SEARCH] Selection reasoning', {
  method: result.method,
  planId: result.plan?.id,
  confidence: result.confidence,
  userMessage: userMessage?.substring(0, 100),
  alternatives: semanticResults?.slice(1, 3).map(r => ({
    planId: r.plan.plan_id,
    similarity: r.similarity,
  })),
});
```

**Оценка:** 30 минут

---

### Задача 4.2: Добавить метрики

**Решение:**
```typescript
// Отслеживать успешность разных методов поиска
metrics.increment('plan_search.method', {
  method: result.method, // conversationId | semantic | fallback
  success: result.plan ? 'found' : 'not_found',
  confidence: result.confidence ? (result.confidence >= 0.7 ? 'high' : 'low') : 'none',
});
```

**Оценка:** 30 минут

---

### Задача 4.3: Batch создание embeddings для существующих планов

**Решение:**
```typescript
// Скрипт для миграции существующих планов
// scripts/backfill-test-plan-embeddings.ts

async function backfillEmbeddings() {
  const { data: plans } = await supabaseAdmin
    .from('test_plans')
    .select('id, url, scope, summary')
    .eq('status', 'pending_confirmation')
    .gt('expires_at', new Date().toISOString());

  for (const plan of plans || []) {
    await TestPlanEmbeddingsService.embedTestPlan(plan.id, {
      url: plan.url,
      scope: plan.scope,
      summary: plan.summary,
    });
    await new Promise(resolve => setTimeout(resolve, 600)); // Rate limit
  }
}
```

**Оценка:** 1 час

---

## Порядок реализации

### Неделя 1: Быстрые фиксы
- День 1: Задачи 1.1, 1.2, 1.3 (проверки и валидация)
- День 2: Тестирование и деплой

### Неделя 2: Семантический поиск
- День 1: Задачи 2.1, 2.2, 2.3 (инфраструктура)
- День 2: Задачи 2.4, 2.5 (интеграция)
- День 3: Тестирование и деплой

### Неделя 3: Обработка неоднозначности
- День 1: Задачи 3.1, 3.2
- День 2: Тестирование и деплой

### Неделя 4: Оптимизации
- День 1: Задачи 4.1, 4.2, 4.3
- День 2: Финальное тестирование

---

## Критерии успеха

**Метрики:**
- Точность выбора плана: 60-70% → 85-95%
- Время поиска: < 200ms (с кэшированием embeddings)
- Покрытие: 100% планов имеют embeddings

**Тесты:**
- Unit тесты для всех новых функций
- Integration тесты для семантического поиска
- E2E тесты для flow с неоднозначностью

---

## Риски и митигация

**Риск 1:** Производительность векторного поиска
**Митигация:** Использовать ivfflat индекс, кэшировать результаты

**Риск 2:** OpenAI API rate limits
**Митигация:** Batch создание embeddings с задержками, retry логика

**Риск 3:** Неоднозначность все еще возникает
**Митигация:** Улучшить промпты для AI детекции, добавить больше валидаций
