# Полный анализ handlePendingTestPlanApproval

## Обзор

Функция `handlePendingTestPlanApproval` - критически важный компонент системы, который обрабатывает подтверждения/отклонения тест-планов от пользователей. Она вызывается **ДО** парсинга интента, чтобы предотвратить создание нового тест-плана, когда пользователь просто подтверждает существующий.

**Расположение:** `src/api/chat/chat.controller.ts:503-649`

**Возвращает:** `Promise<boolean>`

- `true` - approval обработан, ответ отправлен, дальнейшая обработка не нужна
- `false` - approval не найден, продолжать нормальный flow

---

## Детальная логика по шагам

### STEP 1: Инициализация и логирование (строки 512-520)

```typescript
const {
  req,
  res,
  message,
  conversationId,
  userId,
  chatSessionId,
  workspace_id,
} = params;

logger.info("🔍 [APPROVAL_CHECK] Checking for pending test plan approval", {
  userId: userId.substring(0, 8) + "...",
  message: message.substring(0, 50),
  hasConversationId: !!conversationId,
  conversationId: conversationId || "NOT PROVIDED",
  chatSessionId: chatSessionId?.substring(0, 8) + "..." || "none",
});
```

**Что происходит:**

- Извлекаются параметры из объекта `params`
- Логируется начало проверки (с маскированием чувствительных данных)

**Безопасность:** ✅ userId и chatSessionId обрезаются до 8 символов для логирования

---

### STEP 2: Проверка последнего AI сообщения (строки 522-556)

```typescript
let lastAiMessageWasTestPlan = false;

if (chatSessionId) {
  try {
    const recentMessages = await ChatService.getRecentMessages(
      chatSessionId,
      userId,
      5
    );

    const lastAiMessage = recentMessages
      .slice()
      .reverse()
      .find((msg: any) => msg.role === "ai");

    if (lastAiMessage?.metadata) {
      lastAiMessageWasTestPlan =
        lastAiMessage.metadata.requiresApproval === true ||
        !!lastAiMessage.metadata.testPlan ||
        !!lastAiMessage.metadata.conversationId;
    }
  } catch (error) {
    logger.warn("[APPROVAL_CHECK] Failed to check last AI message", { error });
    // Continue without this check (fallback to plan search)
  }
}
```

**Цель:** Убедиться, что последнее AI сообщение было тест-планом

**Логика:**

1. Получает последние 5 сообщений из сессии
2. Находит последнее сообщение с `role === 'ai'`
3. Проверяет метаданные на наличие признаков тест-плана:
   - `metadata.requiresApproval === true`
   - `metadata.testPlan` существует
   - `metadata.conversationId` существует

**Критическая проверка:** Если последнее AI сообщение НЕ было тест-планом → возвращает `false` (строки 558-564)

```typescript
if (!lastAiMessageWasTestPlan) {
  logger.info(
    "[APPROVAL_CHECK] Last AI message was not a test plan, no approval to handle"
  );
  return false; // No pending approval, continue with intent parsing
}
```

**Зачем это нужно:** Предотвращает ложные срабатывания, когда пользователь говорит "yes" в ответ на обычное сообщение AI (не тест-план)

**Graceful degradation:** Если проверка провалилась (ошибка БД) → продолжает без этой проверки (fallback к поиску плана)

---

### STEP 3: Поиск pending тест-плана (строка 567)

```typescript
const pendingPlan = await findPendingTestPlan(conversationId, userId);
```

**Функция `findPendingTestPlan()` (строки 654-710):**

#### 3.1. Валидация conversationId (строки 663-671)

```typescript
const isValidConversationId = conversationId && isValidUUID(conversationId);

if (conversationId && !isValidConversationId) {
  logger.warn(
    "⚠️ [PENDING_PLAN_SEARCH] Invalid conversationId format, ignoring",
    {
      conversationId,
      userId,
    }
  );
}
```

**Что проверяется:** Если `conversationId` передан, он должен быть валидным UUID

**Поведение:** Если невалидный → игнорируется, но поиск продолжается через fallback

#### 3.2. Параллельный поиск (строки 673-677)

```typescript
const [planByConversation, latestPlan] = await Promise.all([
  isValidConversationId
    ? getTestPlan(conversationId, userId)
    : Promise.resolve(null),
  getLatestPendingTestPlan(userId),
]);
```

**Оптимизация:** Два запроса выполняются параллельно (50ms вместо 100ms)

**Запрос 1:** `getTestPlan(conversationId, userId)`

- Ищет план по точному `conversationId` (если он валидный)
- Фильтрует по `user_id` для безопасности

**Запрос 2:** `getLatestPendingTestPlan(userId)`

- Ищет последний pending план пользователя
- Фильтры: `status = 'pending_confirmation'`, `expires_at > NOW()`, `user_id = userId`
- Сортировка: `created_at DESC`, лимит: 1

#### 3.3. Приоритизация результата (строка 680)

```typescript
const pendingPlan = planByConversation || latestPlan;
```

**Логика:** Предпочтение отдается плану по `conversationId`, если не найден → используется fallback (последний pending план)

**Почему fallback важен:** Если `conversationId` не передан или не найден, система все равно найдет последний pending план

---

### STEP 4: Валидация найденного плана (строки 569-583)

```typescript
if (!pendingPlan) {
  logger.info("[CHAT] No pending test plan found", {
    userId: userId.substring(0, 8) + "...",
    conversationId: conversationId || "none",
  });
  return false; // No approval to handle
}

if (pendingPlan.status !== "pending_confirmation") {
  logger.info("[CHAT] Found plan but not pending confirmation", {
    planId: pendingPlan.id,
    status: pendingPlan.status,
  });
  return false; // Plan exists but not awaiting approval
}
```

**Проверки:**

1. План существует
2. Статус плана = `'pending_confirmation'`

**Если не проходит:** Возвращает `false`, продолжает нормальный flow

---

### STEP 5: Детекция approval/rejection (строки 585-613)

```typescript
logger.info(
  "🔍 [CHAT] Found pending test plan, checking for approval/rejection",
  {
    planId: pendingPlan.id,
    scope: pendingPlan.scope,
    createdAt: pendingPlan.createdAt,
    userMessage: message,
  }
);

const approvalResult = await detectUserApproval(message);

logger.info("[CHAT] Test plan response detected", {
  planId: pendingPlan.id,
  approved: approvalResult.approved,
  confidence: approvalResult.confidence,
});
```

**Функция `detectUserApproval()` (`src/services/ai/ai-helpers.service.ts`):**

#### 5.1. Валидация входных данных (строки 23-33)

```typescript
if (!userMessage || typeof userMessage !== "string") {
  return { approved: null, confidence: 0.0, reasoning: "Invalid input" };
}

const trimmedMessage = userMessage.trim();
if (trimmedMessage.length === 0) {
  return { approved: null, confidence: 0.0, reasoning: "Empty message" };
}
```

#### 5.2. AI-детекция (строки 35-97)

```typescript
const prompt = buildApprovalDetectionPrompt(trimmedMessage);

const response = await getChatCompletionWithMessages(
  [
    {
      role: "system",
      content:
        "You are an intent detection expert. Detect approval/rejection from ANY natural language input. Return ONLY valid JSON.",
    },
    {
      role: "user",
      content: prompt,
    },
  ],
  {
    model: "gpt-3.5-turbo", // Cost-effective
    temperature: 0.2, // Low temp for consistency
    max_tokens: 100,
  }
);
```

**Промпт `buildApprovalDetectionPrompt()`:**

- Объясняет контекст (проверка approval для тест-плана)
- Просит определить: approve, reject, или что-то другое
- Приводит примеры (yes/давай = approve, no/cancel = reject, вопросы = null)
- Требует JSON: `{ approved: true|false|null, confidence: 0.0-1.0, reasoning: string }`

**Модель:** `gpt-3.5-turbo` (дешевле, чем gpt-4, достаточно для простой классификации)

**Парсинг ответа:**

```typescript
let parsed: any;
try {
  parsed = JSON.parse(response.content);
} catch (parseError) {
  throw new Error("Invalid JSON response from AI");
}

// Validate structure
if (typeof parsed !== "object" || parsed === null) {
  throw new Error("AI response is not a valid object");
}

return {
  approved: parsed.approved,
  confidence: parsed.confidence || 0,
  reasoning: parsed.reasoning,
};
```

**Fallback:** Если AI провалился → возвращает `{ approved: null, confidence: 0.0 }` (безопаснее, чем угадывать)

#### 5.3. Проверка confidence (строки 601-613)

```typescript
if (approvalResult.confidence < 0.5) {
  logger.info(
    "[CHAT] Approval detection unclear, continuing with normal chat flow",
    {
      planId: pendingPlan.id,
      message: message.substring(0, 50),
      confidence: approvalResult.confidence,
      reasoning:
        "User message might be a question or modification request, not approval/rejection",
    }
  );
  return false; // Continue with normal intent parsing flow
}
```

**Критическая проверка:** Если confidence < 0.5 → возвращает `false`

**Зачем:** Позволяет пользователю задавать вопросы или просить изменения плана, не создавая новый тест

**Примеры:**

- "Can you explain this test?" → confidence низкий → продолжает как general_chat
- "Modify the test to include login" → confidence низкий → продолжает как platform_test

---

### STEP 6: Обработка approval (строки 615-632)

```typescript
if (approvalResult.approved === true) {
  logger.info("🟢 [APPROVAL] Test approved, executing now...", {
    planId: pendingPlan.id,
    userId,
    chatSessionId,
    scope: pendingPlan.scope,
  });

  await executeApprovedTestPlan(req, res, {
    planId: pendingPlan.id,
    userId,
    chatSessionId,
    workspace_id,
    userMessage: message,
  });
  return true;
}
```

**Что происходит:**

1. Логируется approval
2. Вызывается `executeApprovedTestPlan()` - запускает тест
3. Возвращает `true` (обработка завершена, ответ уже отправлен)

**Функция `executeApprovedTestPlan()` (строки 2826-2881):**

- Валидирует тест-план
- Определяет тип теста (API или UI)
- Проверяет кредиты
- Роутит к соответствующему flow (`executeApiTestFlow` или `executeUiTestFlow`)

---

### STEP 7: Обработка rejection (строки 634-645)

```typescript
if (approvalResult.approved === false) {
  logger.info("[CHAT] Test plan rejected", { planId: pendingPlan.id });

  await saveAndRespond(chatSessionId, res, message, MESSAGES.TEST_REJECTED);
  return true;
}
```

**Что происходит:**

1. Логируется rejection
2. Сохраняет сообщения в БД
3. Отправляет ответ: `"❌ Test plan canceled. Feel free to request a different test or ask any questions!"`
4. Возвращает `true`

**Функция `saveAndRespond()` (строки 713-732):**

```typescript
async function saveAndRespond(
  chatSessionId: string | undefined,
  res: Response,
  userMessage: string,
  aiMessage: string
): Promise<void> {
  if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: "user", content: userMessage },
      { role: "ai", content: aiMessage },
    ]);
  }

  res.json({
    success: true,
    reply: aiMessage,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}
```

---

### STEP 8: Fallback (строка 648)

```typescript
// Shouldn't reach here, but handle gracefully
return false;
```

**Когда достигается:** Если `approvalResult.approved` не `true` и не `false` (т.е. `null`), но confidence >= 0.5 (что странно)

**Поведение:** Возвращает `false`, продолжает нормальный flow

---

## Критические риски и проблемы

### 🔴 РИСК #1: Race Condition при параллельном поиске

**Проблема:**

```typescript
const [planByConversation, latestPlan] = await Promise.all([
  isValidConversationId
    ? getTestPlan(conversationId, userId)
    : Promise.resolve(null),
  getLatestPendingTestPlan(userId),
]);
```

**Сценарий:**

1. Пользователь создает тест-план A (conversationId = "abc")
2. Пользователь создает тест-план B (без conversationId)
3. Пользователь отправляет "yes" с conversationId = "abc"
4. Параллельно выполняются:
   - `getTestPlan("abc")` → находит план A
   - `getLatestPendingTestPlan()` → находит план B (более новый)
5. Результат: `planByConversation || latestPlan` → выбирает план A ✅

**Но если:**

- План A уже истек (`expires_at < NOW()`)
- План B еще активен
- `getTestPlan("abc")` возвращает план A (но он истек)
- `getLatestPendingTestPlan()` возвращает план B

**Проблема:** Выбирается план A (истекший), хотя должен быть план B

**Решение:**

```typescript
// Добавить проверку expires_at в getTestPlan или после получения
const [planByConversation, latestPlan] = await Promise.all([...]);

// Фильтровать истекшие планы
const validPlanByConversation = planByConversation &&
  new Date(planByConversation.expiresAt) > new Date()
  ? planByConversation
  : null;

const pendingPlan = validPlanByConversation || latestPlan;
```

---

### 🔴 РИСК #2: Ложные срабатывания при отсутствии сессии

**Проблема:**

```typescript
if (!chatSessionId) {
  // lastAiMessageWasTestPlan остается false
}

if (!lastAiMessageWasTestPlan) {
  return false; // Пропускает проверку approval
}
```

**Сценарий:**

1. Пользователь создает тест-план (сессия создана)
2. Сессия теряется (ошибка БД, таймаут)
3. Пользователь отправляет "yes" без `sessionId`
4. `chatSessionId = undefined` → проверка последнего сообщения пропускается
5. `lastAiMessageWasTestPlan = false` → возвращает `false`
6. Система создает НОВЫЙ тест-план вместо подтверждения старого

**Решение:**

```typescript
// Если нет сессии, но есть conversationId - все равно искать план
if (!chatSessionId && conversationId) {
  // Пропустить проверку lastAiMessage, но продолжить поиск плана
  logger.info(
    "[APPROVAL_CHECK] No session, but conversationId provided, searching for plan"
  );
}
```

---

### 🟡 РИСК #3: Низкий confidence блокирует явные approval

**Проблема:**

```typescript
if (approvalResult.confidence < 0.5) {
  return false; // Продолжает как обычный чат
}
```

**Сценарий:**

1. Пользователь говорит "давай" (русский)
2. AI возвращает `{ approved: true, confidence: 0.4 }` (низкий confidence из-за неоднозначности)
3. Система возвращает `false` → создает новый тест-план

**Решение:**

```typescript
// Если approved === true, но confidence низкий - все равно обработать
if (approvalResult.approved === true && approvalResult.confidence >= 0.3) {
  // Обработать approval, но залогировать низкий confidence
  logger.warn('[APPROVAL] Low confidence approval', { confidence: approvalResult.confidence });
  await executeApprovedTestPlan(...);
  return true;
}

if (approvalResult.approved === false && approvalResult.confidence >= 0.3) {
  // Обработать rejection
  await saveAndRespond(...);
  return true;
}

// Только если approved === null или confidence < 0.3 - продолжать
if (approvalResult.confidence < 0.5) {
  return false;
}
```

---

### 🟡 РИСК #4: AI детекция может вернуть невалидный JSON

**Проблема:**

```typescript
try {
  parsed = JSON.parse(response.content);
} catch (parseError) {
  throw new Error("Invalid JSON response from AI");
}
```

**Сценарий:**

1. AI возвращает: `"Here's the JSON: { approved: true }"` (текст + JSON)
2. `JSON.parse()` падает
3. Функция возвращает `{ approved: null, confidence: 0.0 }`
4. Система продолжает как обычный чат, хотя пользователь явно сказал "yes"

**Решение:**

````typescript
// Попробовать извлечь JSON из текста
function extractJSON(text: string): any | null {
  // Strategy 1: Direct parse
  try {
    return JSON.parse(text);
  } catch {}

  // Strategy 2: Find JSON block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  // Strategy 3: Find JSON in code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {}
  }

  return null;
}
````

---

### 🟡 РИСК #5: Fallback к latestPlan может выбрать не тот план

**Проблема:**

```typescript
const pendingPlan = planByConversation || latestPlan;
```

**Сценарий:**

1. Пользователь создает тест-план A для URL1
2. Пользователь создает тест-план B для URL2 (более новый)
3. Пользователь отправляет "yes" с conversationId для плана A
4. `getTestPlan(conversationId)` не находит план (ошибка БД или план удален)
5. `getLatestPendingTestPlan()` возвращает план B
6. Система подтверждает план B вместо плана A

**Решение:**

```typescript
// Если conversationId передан, но план не найден - не использовать fallback
if (conversationId && isValidConversationId && !planByConversation) {
  logger.warn(
    "[APPROVAL_CHECK] Plan with conversationId not found, not using fallback",
    {
      conversationId,
    }
  );
  return false; // Не подтверждать другой план
}

const pendingPlan = planByConversation || (conversationId ? null : latestPlan);
```

---

### 🟡 РИСК #6: Проверка lastAiMessage может быть неточной

**Проблема:**

```typescript
const lastAiMessage = recentMessages
  .slice()
  .reverse()
  .find((msg: any) => msg.role === "ai");
```

**Сценарий:**

1. AI отправляет тест-план (role = 'ai', metadata.requiresApproval = true)
2. Пользователь задает вопрос (role = 'user')
3. AI отвечает на вопрос (role = 'ai', обычное сообщение)
4. Пользователь отправляет "yes"
5. `lastAiMessage` = последнее AI сообщение (ответ на вопрос), а не тест-план
6. `lastAiMessageWasTestPlan = false` → возвращает `false`

**Решение:**

```typescript
// Искать последнее AI сообщение с requiresApproval, а не просто последнее AI
const lastTestPlanMessage = recentMessages
  .slice()
  .reverse()
  .find(
    (msg: any) =>
      msg.role === "ai" &&
      (msg.metadata?.requiresApproval === true ||
        msg.metadata?.testPlan ||
        msg.metadata?.conversationId)
  );

lastAiMessageWasTestPlan = !!lastTestPlanMessage;
```

---

### 🟢 РИСК #7: Отсутствие проверки expires_at перед обработкой

**Проблема:**

```typescript
if (pendingPlan.status !== "pending_confirmation") {
  return false;
}
// Нет проверки expires_at!
```

**Сценарий:**

1. Тест-план создан 25 часов назад (expires_at = 24 часа)
2. План все еще имеет статус `pending_confirmation` (не обновлен)
3. Пользователь отправляет "yes"
4. Система подтверждает истекший план

**Решение:**

```typescript
if (pendingPlan.status !== "pending_confirmation") {
  return false;
}

// Проверить expires_at
if (new Date(pendingPlan.expiresAt) <= new Date()) {
  logger.info("[APPROVAL_CHECK] Plan expired", {
    planId: pendingPlan.id,
    expiresAt: pendingPlan.expiresAt,
  });
  return false;
}
```

---

### 🟢 РИСК #8: Нет проверки ownership при использовании fallback

**Проблема:**

```typescript
const latestPlan = await getLatestPendingTestPlan(userId);
```

**Хорошо:** `getLatestPendingTestPlan()` уже фильтрует по `user_id`, но стоит проверить еще раз:

```typescript
if (pendingPlan && pendingPlan.userId !== userId) {
  logger.error("[APPROVAL_CHECK] Plan ownership mismatch", {
    planId: pendingPlan.id,
    planUserId: pendingPlan.userId,
    requestUserId: userId,
  });
  return false;
}
```

---

## Рекомендации по улучшению

### 1. Добавить транзакционность

```typescript
// При подтверждении плана - атомарно обновить статус
await supabaseAdmin.rpc("confirm_test_plan", {
  plan_id: pendingPlan.id,
  user_id: userId,
});
```

### 2. Добавить rate limiting

```typescript
// Предотвратить множественные подтверждения одного плана
const recentApprovals = await checkRecentApprovals(userId, pendingPlan.id);
if (recentApprovals > 0) {
  logger.warn("[APPROVAL_CHECK] Duplicate approval attempt", {
    planId: pendingPlan.id,
  });
  return false;
}
```

### 3. Улучшить логирование

```typescript
// Добавить trace ID для отслеживания всего flow
const traceId = generateTraceId();
logger.info("[APPROVAL_CHECK] Started", { traceId, planId: pendingPlan?.id });
```

### 4. Добавить метрики

```typescript
// Отслеживать успешность детекции
metrics.increment("approval.detection.success", {
  approved: approvalResult.approved,
  confidence: approvalResult.confidence >= 0.5 ? "high" : "low",
});
```

---

## Диаграмма потока

```
handlePendingTestPlanApproval()
    ↓
[Проверка lastAiMessage]
    ├─→ Нет сессии → Пропустить проверку
    ├─→ Последнее AI сообщение = тест-план → Продолжить
    └─→ Последнее AI сообщение ≠ тест-план → return false
    ↓
[Поиск pending плана]
    ├─→ По conversationId (параллельно)
    └─→ Последний pending план (параллельно)
    ↓
[Валидация плана]
    ├─→ План не найден → return false
    ├─→ Статус ≠ pending_confirmation → return false
    └─→ План валиден → Продолжить
    ↓
[AI детекция approval]
    ├─→ approved = true, confidence >= 0.5 → executeApprovedTestPlan() → return true
    ├─→ approved = false, confidence >= 0.5 → saveAndRespond(rejected) → return true
    ├─→ confidence < 0.5 → return false (продолжить как обычный чат)
    └─→ approved = null → return false
```

---

## Чеклист для тестирования

### Тест 1: Явное подтверждение

- **Вход:** "yes", последнее AI сообщение = тест-план
- **Ожидание:** Тест запускается, `return true`

### Тест 2: Явное отклонение

- **Вход:** "no", последнее AI сообщение = тест-план
- **Ожидание:** План отклонен, отправлено сообщение, `return true`

### Тест 3: Вопрос вместо approval

- **Вход:** "Can you explain?", последнее AI сообщение = тест-план
- **Ожидание:** `return false`, продолжается как general_chat

### Тест 4: "yes" без тест-плана

- **Вход:** "yes", последнее AI сообщение = обычное сообщение
- **Ожидание:** `return false`, продолжается как обычный чат

### Тест 5: Истекший план

- **Вход:** "yes", план с `expires_at < NOW()`
- **Ожидание:** `return false` (после добавления проверки)

### Тест 6: Невалидный conversationId

- **Вход:** "yes", conversationId = "invalid-uuid"
- **Ожидание:** Fallback к latestPlan, если найден

### Тест 7: Нет сессии, но есть conversationId

- **Вход:** "yes", `chatSessionId = undefined`, `conversationId = "valid-uuid"`
- **Ожидание:** План найден по conversationId, approval обработан

---

## Заключение

Функция `handlePendingTestPlanApproval` - критически важный компонент с несколькими потенциальными рисками. Основные проблемы:

1. **Race conditions** при параллельном поиске
2. **Ложные срабатывания** при отсутствии сессии
3. **Низкий confidence** блокирует явные approval
4. **Неточная проверка** lastAiMessage

Рекомендуется:

- Добавить проверку `expires_at`
- Улучшить извлечение JSON из AI ответа
- Добавить транзакционность при подтверждении
- Улучшить логирование и метрики
