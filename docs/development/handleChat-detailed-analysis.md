# Детальный анализ метода handleChat

## Обзор

Метод `handleChat` - главный обработчик всех запросов к `/api/v1/chat`. Он координирует весь flow от получения сообщения пользователя до отправки ответа AI.

**Расположение:** `src/api/chat/chat.controller.ts:116-434`

**Таймаут:** 180 секунд (3 минуты) - `CONSTANTS.CHAT_REQUEST_TIMEOUT`

---

## Структура метода

### ИНИЦИАЛИЗАЦИЯ (строки 117-130)

#### 1. Настройка таймаута запроса

```typescript
const requestStartTime = Date.now();
const checkRequestTimeout = () => {
  if (Date.now() - requestStartTime > CONSTANTS.CHAT_REQUEST_TIMEOUT) {
    throw new Error(
      `Request timeout after ${CONSTANTS.CHAT_REQUEST_TIMEOUT / 1000}s`
    );
  }
};
```

**Цель:** Отслеживание общего времени выполнения запроса (макс. 180 секунд)

**Проверки:** Вызывается после каждого длительного шага

---

#### 2. Проверка соединения с клиентом

```typescript
const checkConnection = () => {
  if (req.aborted || req.socket?.destroyed) {
    throw new Error("Client connection closed");
  }
};
```

**Цель:** Прерывание обработки, если клиент закрыл соединение

**Когда вызывается:** Перед началом обработки и после валидации

---

### STEP 0: ВАЛИДАЦИЯ ВХОДНЫХ ДАННЫХ (строки 136-191)

#### 3. Проверка аутентификации (строки 139-151)

```typescript
if (!req.user || !req.user.id) {
  res.status(401).json({
    success: false,
    error: MESSAGES.AUTH_REQUIRED,
    timestamp: new Date().toISOString(),
  });
  return;
}
const userId = req.user.id;
```

**Что проверяется:**

- `req.user` существует (устанавливается middleware `requireAuth`)
- `req.user.id` - UUID пользователя

**Ошибка:** 401 Unauthorized, если пользователь не авторизован

---

#### 4. Валидация тела запроса (строки 155-164)

```typescript
if (!req.body || typeof req.body !== "object") {
  res.status(400).json({
    success: false,
    error: MESSAGES.INVALID_REQUEST,
    timestamp: new Date().toISOString(),
  });
  return;
}
```

**Что проверяется:** `req.body` - объект (не null, не undefined)

---

#### 5. Валидация сообщения (строки 169-180)

```typescript
const { message, context, sessionId, conversationId, answers } =
  req.body as ChatRequest;

if (!message || typeof message !== "string" || message.trim().length === 0) {
  res.status(400).json({
    success: false,
    error: MESSAGES.INVALID_REQUEST,
    timestamp: new Date().toISOString(),
  });
  return;
}
```

**Что проверяется:**

- `message` - строка
- `message` не пустая после `trim()`

**Извлекаемые поля:**

- `message` - текст сообщения пользователя
- `context` - дополнительный контекст (объект или строка)
- `sessionId` - ID существующей сессии чата
- `conversationId` - альтернативный ID для группировки
- `answers` - ответы на вопросы AI (credentials, URLs)

**Логирование:** `[CHAT] Request received` с userId, messageLength, hasSession, etc.

---

### STEP 1: ПРОВЕРКА WORKSPACE (строки 194-211)

#### 6. Получение или создание workspace (строки 197-211)

```typescript
let workspace_id: string;
try {
  const workspaceResult = await WorkspaceService.checkOrCreateWorkspace(userId);
  workspace_id = workspaceResult.workspace_id;

  if (workspaceResult.is_new) {
    logger.info("[CHAT] Created new workspace", { userId, workspace_id });
  }
} catch (workspaceError) {
  logger.error("[CHAT] WorkspaceService failed", { error, userId });
  throw new Error(`Failed to initialize workspace: ${workspaceError.message}`);
}
```

**Цель:** Убедиться, что у пользователя есть workspace (обязательно!)

**Что происходит:**

- Если workspace существует → возвращает его ID
- Если нет → создает новый workspace для пользователя

**Ошибка:** Если создание workspace провалилось → весь запрос прерывается

**Почему важно:** Workspace нужен для изоляции данных между пользователями и для работы с проектами

---

### STEP 2: УПРАВЛЕНИЕ СЕССИЕЙ ЧАТА (строки 216-233)

#### 7. Получение или создание сессии чата (строки 219-233)

```typescript
let chatSessionId: string | undefined;
try {
  chatSessionId = await getOrCreateChatSession(userId, sessionId, workspace_id);
  logger.debug("[CHAT] Chat session ready", {
    chatSessionId: chatSessionId || "none",
    providedSessionId: sessionId || "none",
  });
} catch (sessionError) {
  logger.warn(
    "[CHAT] getOrCreateChatSession failed, continuing without session",
    {
      error: sessionError.message,
      userId,
    }
  );
  chatSessionId = undefined; // Graceful degradation
}
```

**Логика `getOrCreateChatSession()`:**

1. Если `providedSessionId` передан:
   - Проверяет, что сессия существует и принадлежит пользователю
   - Если да → использует её
   - Если нет → создает новую
2. Если `providedSessionId` не передан:
   - Ищет последнюю активную сессию пользователя (по `updated_at DESC`)
   - Если найдена → использует её
   - Если нет → создает новую

**Graceful degradation:** Если создание сессии провалилось → продолжает без сессии (но история чата не будет сохранена)

**WebSocket уведомление:** `emitProcessingStep(chatSessionId, 'enriching_context', '🔍 Analyzing your request...', PROGRESS.ENRICHING)` (10%)

---

### STEP 3: ПРОВЕРКА PENDING TEST PLAN APPROVAL (строки 241-257)

#### 8. Обработка подтверждения тест-плана (строки 244-257)

```typescript
const approvalHandled = await handlePendingTestPlanApproval({
  req,
  res,
  message,
  conversationId,
  userId,
  chatSessionId,
  workspace_id,
});

if (approvalHandled) {
  return; // Early return - approval was handled
}
```

**Цель:** Проверить, не является ли сообщение пользователя подтверждением/отклонением тест-плана

**Логика `handlePendingTestPlanApproval()`:**

1. Проверяет последние 5 сообщений в сессии
2. Находит последнее AI сообщение
3. Проверяет, было ли это сообщение тест-планом:
   - `metadata.requiresApproval === true`
   - `metadata.testPlan` существует
   - `metadata.conversationId` существует
4. Если да → парсит сообщение пользователя через `detectUserApproval()`
5. Если это подтверждение → запускает тест
6. Если это отклонение → отправляет сообщение об отмене
7. Если неясно → просит уточнить

**Важно:** Это делается ДО парсинга интента, чтобы не создавать новый тест-план, если пользователь просто подтверждает существующий

**Возвращает:** `true` если обработано (и ответ уже отправлен), `false` если нужно продолжить

---

### STEP 4: ПАРСИНГ ИНТЕНТА (строки 262-340)

#### 9. WebSocket уведомление (строка 265)

```typescript
emitProcessingStep(
  chatSessionId,
  "parsing_intent",
  "🧠 Understanding what you need...",
  PROGRESS.INTENT_PARSING
);
```

**Прогресс:** 20%

---

#### 10. Fast Path: Явный API тест (строки 271-302)

```typescript
const contextObj =
  typeof context === "object" && context !== null ? context : null;

const isExplicitApiTest =
  message.startsWith("RUN_API_TEST:") || contextObj?.action === "run_api_test";

if (isExplicitApiTest) {
  parsedIntent = {
    intent: "api_test",
    confidence: 100,
    apiMethod: apiTestData?.method || "GET",
    apiUrl: apiTestData?.url,
    apiBody: apiTestData?.body,
    apiHeaders: apiTestData?.headers,
    assertions: apiTestData?.assertions,
    metadata: {
      source: "explicit_keyword",
      parsedAt: new Date().toISOString(),
    },
  };
}
```

**Цель:** Обойти AI парсинг, если фронтенд явно указал, что это API тест

**Условия:**

- Сообщение начинается с `RUN_API_TEST:`
- ИЛИ `context.action === 'run_api_test'`

**Преимущества:** Быстрее, дешевле, точнее (confidence = 100%)

---

#### 11. Normal Path: AI парсинг интента (строки 303-326)

```typescript
// Get chat history for context
const chatHistory = await getChatHistoryForIntent(chatSessionId, userId);

checkRequestTimeout();

try {
  parsedIntent = await parseUserIntent(message, { chatHistory }, workspace_id);
} catch (intentError) {
  logger.error("[CHAT] parseUserIntent failed", {
    error,
    userId,
    messageLength,
  });
  // Fallback to general_chat if intent parsing fails
  parsedIntent = { intent: "general_chat", confidence: 0 };
}
```

**Что делает `getChatHistoryForIntent()`:**

1. Получает последние 20 сообщений из сессии (`ChatService.getRecentMessages()`)
2. Конвертирует роли: `'ai'` → `'assistant'` (для OpenAI)
3. Добавляет тест-результаты из `metadata.testResult` в контент сообщений
4. Возвращает массив `{ role, content }`

**Что делает `parseUserIntent()`:**

1. Проверяет кэш (если такой запрос уже парсился)
2. Получает KB rules context (быстрый путь через кэш или медленный через поиск)
3. Определяет язык пользователя (en/ru/neutral)
4. Вызывает GPT с промптом `buildIntentPrompt()`
5. Парсит JSON ответ (несколько стратегий извлечения)
6. Вычисляет confidence
7. Если confidence низкий → использует RAG fallback

**Возможные интенты:**

- `platform_test` - тестирование UI/веб-сайта
- `api_test` - тестирование API endpoint
- `general_chat` - обычный разговор

**Fallback:** Если парсинг провалился → `general_chat` с confidence = 0

---

#### 12. WebSocket уведомление с результатом (строки 328-330)

```typescript
const intentMessage = buildIntentMessage(parsedIntent);
emitProcessingStep(
  chatSessionId,
  "parsing_intent",
  intentMessage,
  PROGRESS.INTENT_PARSED
);
```

**Прогресс:** 40%

**Примеры сообщений:**

- `"🔍 Got it! Testing GET https://api.example.com/users"`
- `"🌐 Got it! Testing website https://example.com"`
- `"💬 Got it! Let me help you with that"`

---

#### 13. Логирование результата (строки 332-339)

```typescript
const intent = parsedIntent?.intent || "general_chat";

logger.info("[CHAT] Intent parsed", {
  intent,
  scope: parsedIntent?.scope,
  confidence: parsedIntent?.confidence,
  usedRAG: parsedIntent?.metadata?.usedRAG,
});
```

---

### STEP 5: РОУТИНГ К ОБРАБОТЧИКАМ (строки 344-380)

#### 14. WebSocket уведомление (строка 347)

```typescript
emitProcessingStep(
  chatSessionId,
  "generating_plan",
  "🚀 Processing your request...",
  PROGRESS.ROUTING
);
```

**Прогресс:** 50%

---

#### 15. Роутинг по интенту (строки 349-380)

```typescript
if (intent === "platform_test") {
  return await handlePlatformTest(req, res, {
    message,
    parsedIntent,
    userId,
    workspace_id,
    chatSessionId,
    conversationId,
    answers,
  });
}

if (intent === "api_test") {
  return await handleApiTest(req, res, {
    message,
    parsedIntent,
    userId,
    workspace_id,
    chatSessionId,
    conversationId,
    answers,
  });
}

// general_chat (default)
return await handleGeneralChat(req, res, {
  message,
  userId,
  chatSessionId,
  context,
  userLanguage: parsedIntent?.userLanguage, // Pass language to avoid re-detection
});
```

**Три ветки:**

1. **`platform_test`** → `handlePlatformTest()` - создание тест-плана для UI тестирования
2. **`api_test`** → `handleApiTest()` - создание тест-плана для API тестирования
3. **`general_chat`** → `handleGeneralChat()` - обычный чат с AI

**Важно:** Каждый обработчик сам отправляет ответ (`res.json()`), поэтому используется `return await`

---

### ОБРАБОТКА ОШИБОК (строки 382-433)

#### 16. Try-catch блок (строки 382-433)

```typescript
} catch (error) {
  // Check if client connection was closed
  if (error instanceof Error && (
    error.message.includes('Client connection closed') ||
    error.message.includes('aborted') ||
    error.message.includes('ECONNRESET')
  )) {
    logger.warn('[CHAT] Client connection closed during request');
    return; // Don't send response if connection is closed
  }

  // Check if response already sent
  if (res.headersSent) {
    logger.warn('[CHAT] Response already sent, cannot send error response');
    return;
  }

  // Check if connection is still alive
  if (req.aborted || req.socket?.destroyed) {
    logger.warn('[CHAT] Cannot send error response - connection closed');
    return;
  }

  // Extract error message safely
  const errorMessage = error instanceof Error && error.message
    ? error.message
    : (error ? String(error) : 'An unexpected error occurred');

  // Check for timeout error
  const isTimeout = errorMessage.includes('timeout');

  res.status(isTimeout ? 408 : 500).json({
    success: false,
    error: isTimeout ? MESSAGES.REQUEST_TIMEOUT : 'Failed to process chat request',
    message: errorMessage,
    timestamp: new Date().toISOString(),
  });
}
```

**Обрабатываемые случаи:**

1. **Соединение закрыто** → просто логируем, не отправляем ответ
2. **Ответ уже отправлен** → не пытаемся отправить второй раз
3. **Таймаут** → 408 Request Timeout
4. **Другая ошибка** → 500 Internal Server Error

**Важно:** Всегда проверяет `res.headersSent` перед отправкой ответа

---

## Константы

```typescript
CONSTANTS = {
  RECENT_MESSAGES_LIMIT: 20, // Последние 20 сообщений для истории
  KB_MATCH_COUNT: 3, // Количество KB chunks для поиска
  KB_MATCH_THRESHOLD: 0.5, // Порог схожести для KB (0-1)
  FUZZING_TIMEOUT: 30000, // 30 секунд для fuzzing
  AUTO_EMBED_TIMEOUT: 30000, // 30 секунд для авто-эмбеддинга
  CHAT_REQUEST_TIMEOUT: 180000, // 180 секунд (3 минуты) для всего запроса
  TEST_PLAN_EXPIRY_HOURS: 24, // Тест-план истекает через 24 часа
};

PROGRESS = {
  START: 0,
  ENRICHING: 10, // Обогащение контекста
  INTENT_PARSING: 20, // Парсинг интента
  INTENT_PARSED: 40, // Интент распознан
  ROUTING: 50, // Роутинг к обработчику
};

MESSAGES = {
  APPROVAL_UNCLEAR: "❓ I didn't quite understand...",
  TEST_REJECTED: "❌ Test plan canceled...",
  REQUEST_TIMEOUT: "⏱️ Request timeout...",
  INVALID_REQUEST: "❌ Invalid request...",
  AUTH_REQUIRED: "🔒 Authentication required",
};
```

---

## Потенциальные проблемы

### 1. Workspace не создается

**Симптом:** Запрос падает с ошибкой "Failed to initialize workspace"
**Причина:** Проблема с БД или правами доступа
**Решение:** Проверить логи `WorkspaceService.checkOrCreateWorkspace()`

### 2. Сессия не создается

**Симптом:** История чата не сохраняется, но запрос продолжается
**Причина:** Ошибка в `ChatService.createChatSession()`
**Решение:** Проверить логи `[CHAT_SESSION]` - graceful degradation работает, но нужно исправить

### 3. Intent неправильно распознается

**Симптом:** "Test this API" → `general_chat` вместо `api_test`
**Причина:** Проблема в промпте или низкий confidence
**Решение:** Проверить логи `[INTENT_PARSER]` - confidence, usedRAG, reasoning

### 4. Таймаут запроса

**Симптом:** 408 Request Timeout после 3 минут
**Причина:** OpenAI API медленно отвечает или зависло
**Решение:** Увеличить `CHAT_REQUEST_TIMEOUT` или оптимизировать промпты

### 5. Двойной ответ

**Симптом:** Ошибка "Cannot set headers after they are sent"
**Причина:** Обработчик уже отправил ответ, но `handleChat` пытается отправить еще раз
**Решение:** Всегда проверять `res.headersSent` перед отправкой

---

## Диаграмма потока

```
POST /api/v1/chat
    ↓
[Валидация] → req.user, req.body, message
    ↓
[Workspace] → checkOrCreateWorkspace()
    ↓
[Session] → getOrCreateChatSession()
    ↓
[Approval Check] → handlePendingTestPlanApproval()
    ├─→ Approved → Execute Test → Return
    ├─→ Rejected → Send Message → Return
    └─→ Not Approval → Continue
    ↓
[Intent Parsing] → parseUserIntent()
    ├─→ Fast Path (explicit API test)
    └─→ Normal Path (AI parsing)
    ↓
[Routing] → Route by intent
    ├─→ platform_test → handlePlatformTest()
    ├─→ api_test → handleApiTest()
    └─→ general_chat → handleGeneralChat()
    ↓
[Response] → res.json()
```

---

## Логи для мониторинга

**Критические логи:**

- `[CHAT] Request received` - входной запрос
- `[CHAT] Intent parsed` - результат парсинга
- `[CHAT] WorkspaceService failed` - ошибка workspace
- `[CHAT] getOrCreateChatSession failed` - ошибка сессии
- `[INTENT_PARSER] Intent parsing failed` - ошибка парсинга

**WebSocket события:**

- `enriching_context` (10%)
- `parsing_intent` (20%)
- `parsing_intent` (40%) - с результатом
- `generating_plan` (50%)
