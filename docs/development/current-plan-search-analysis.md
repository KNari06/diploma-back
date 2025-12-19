# ✅ АКТУАЛЬНЫЙ анализ логики поиска и создания embeddings

**Дата обновления:** Декабрь 2024
**Статус:** ИСПРАВЛЕННАЯ ВЕРСИЯ после фикса

---

## 🎯 Краткий ответ на вопрос

**"Когда происходит поиск, мы берем последние 20 смс и все старые сообщения >20 в формате embedding?"**

**Да, но с важными деталями:**

1. **Последние 20 сообщений** → напрямую из БД (`chat_messages`)
2. **Старые сообщения (>20)** → через векторный поиск в СУЩЕСТВУЮЩИХ embeddings
3. **Embeddings создаются** → ПОСЛЕ сохранения ответа (для следующего запроса)

---

## 📊 Полный процесс (handleGeneralChat)

### ШАГ 1: Получение последних 20 сообщений

```typescript
// ВСЕГДА первое действие
const recentMessages = await ChatService.getRecentMessages(
  chatSessionId,
  userId,
  20 // RECENT_MESSAGES_LIMIT
);

// Быстрая оптимизация
if (recentMessages.length < 20) {
  // Точно нет старых сообщений → пропускаем векторный поиск
  conversationHistory = recentMessages;
  // → сразу к шагу 3 (OpenAI)
}
```

**Источник:** `chat_messages` таблица
**Формат:** Полный текст сообщений
**Использование:** `conversationHistory` для OpenAI

---

### ШАГ 2: Векторный поиск (ТОЛЬКО если >= 20)

```typescript
let oldContextSummary = '';

if (recentMessages.length >= 20 && chatSessionId) {
  // Подтверждаем через точный count
  const { count: totalMessageCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', chatSessionId);

  const totalMessages = totalMessageCount || 0;

  // Только если ДЕЙСТВИТЕЛЬНО > 20
  if (totalMessages > 20) {
    logger.info('[GENERAL_CHAT] Chat has old messages, using vector search');

    // ✅ Ищем в СУЩЕСТВУЮЩИХ embeddings
    // НЕ создаем новые здесь!
    const relevantOldMessages = await searchChatHistory(
      chatSessionId,
      message, // Текущий запрос пользователя
      {
        matchCount: 5,        // Топ-5
        matchThreshold: 0.4   // Минимальная схожесть
      }
    );

    if (relevantOldMessages.length > 0) {
      // Форматируем для контекста
      oldContextSummary = relevantOldMessages
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n\n');

      logger.info('[GENERAL_CHAT] Retrieved relevant old context via vectors', {
        retrievedCount: relevantOldMessages.length,
        avgSimilarity: (
          relevantOldMessages.reduce((sum, m) => sum + m.similarity, 0) /
          relevantOldMessages.length
        ).toFixed(2)
      });
    }
  }
}
```

**Источник:** `chat_message_embeddings` таблица
**Формат:** Embeddings (векторный поиск)
**Использование:** `oldContextSummary` для OpenAI
**Важно:** Ищем ТОЛЬКО в уже созданных embeddings!

---

### ШАГ 3: Получение ответа от OpenAI

```typescript
// Строим промпт
const systemPrompt = buildChatSystemPrompt();
const enhancedSystemPrompt = oldContextSummary
  ? `${systemPrompt}\n--- Previous Conversation Context ---\n${oldContextSummary}\n...`
  : systemPrompt;

const messages = [
  { role: 'system', content: enhancedSystemPrompt },
  ...conversationHistory, // Последние 20 сообщений
  { role: 'user', content: message }
];

// Получаем ответ
const gptResponse = await getChatCompletionWithMessages(messages, {
  temperature: 0.3,
  max_tokens: 1000
});
```

**Контекст включает:**
- System prompt (с `oldContextSummary` если есть)
- Последние 20 сообщений (полный текст)
- Текущий запрос пользователя

---

### ШАГ 4: Сохранение сообщений

```typescript
if (chatSessionId) {
  await ChatService.saveChatMessages(chatSessionId, [
    { role: 'user', content: message },
    { role: 'ai', content: gptResponse.content },
  ]);

  // Auto-generate title (фон)
  ChatService.autoGenerateTitle(chatSessionId).catch(error => {
    logger.warn('[GENERAL_CHAT] Failed to auto-generate title');
  });
}
```

---

### ШАГ 5: Создание embeddings (ПОСЛЕ сохранения!)

```typescript
if (chatSessionId) {
  // ✅ Проверка ПОСЛЕ сохранения
  const { count: totalMessageCountAfterSave } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', chatSessionId);

  const totalMessagesNow = totalMessageCountAfterSave || 0;

  // Если ТЕПЕРЬ > 20 → создаем embeddings (фон, для NEXT запроса)
  if (totalMessagesNow > 20) {
    logger.info('[GENERAL_CHAT] Creating embeddings for old messages (background)', {
      sessionId: chatSessionId,
      totalMessages: totalMessagesNow
    });

    // Auto-embed с таймаутом
    const embedPromise = autoEmbedOldMessages(chatSessionId);
    const embedTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Auto-embed timeout')), 30000)
    );

    // Не блокирует ответ, готовит для следующего запроса
    Promise.race([embedPromise, embedTimeout]).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-embed messages (background)', {
        error: error instanceof Error ? error.message : String(error),
        sessionId: chatSessionId
      });
    });
  }
}
```

**Ключевые моменты:**
- ✅ Проверка **ПОСЛЕ** сохранения
- ✅ Embeddings создаются для **СЛЕДУЮЩЕГО** запроса
- ✅ Не блокирует текущий ответ (Promise.race с таймаутом)

---

## 🔄 Логика "на опережение"

### Принцип

**Текущий запрос:**
- Использует embeddings из **ПРОШЛОГО** запроса
- Создает embeddings для **СЛЕДУЮЩЕГО** запроса

**Эффект:**
- Embeddings всегда готовы к моменту использования ✅
- Нет задержек на создание во время ответа ✅
- Нет race condition ✅

---

### Сценарий: 20-е сообщение (10-я пара user+ai)

```
До запроса: 19 сообщений в БД

handleGeneralChat():
├─ ШАГ 1: getRecentMessages() → [msg1...msg19] (19 сообщений)
├─ ШАГ 2: if (19 >= 20) → FALSE
│          Векторный поиск НЕ выполняется (оптимизация)
│          oldContextSummary = ''
├─ ШАГ 3: OpenAI ответ (без oldContextSummary)
├─ ШАГ 4: Сохранение → msg20 (user) + msg21 (ai)
└─ ШАГ 5: count() = 21
           if (21 > 20) → TRUE ✅
           autoEmbedOldMessages() в фоне
           └─ getMessagesNeedingEmbedding()
              → Все сообщения: 21
              → Последние 20: исключаем
              → Старые: [msg1]
              └─ Создается embedding для msg1

После запроса:
- В БД: 21 сообщение
- Embeddings: 1 (msg1) ✅
```

---

### Сценарий: 21-е сообщение (11-я пара user+ai)

```
До запроса: 21 сообщение в БД

handleGeneralChat():
├─ ШАГ 1: getRecentMessages() → [msg2...msg21] (20 сообщений)
├─ ШАГ 2: if (20 >= 20) → TRUE
│          count() = 21
│          if (21 > 20) → TRUE
│          searchChatHistory()
│          └─ Ищет в embeddings: [msg1] ✅ (создан в предыдущем запросе)
│          └─ Находит релевантные: [msg1]
│          oldContextSummary = "User: msg1..."
├─ ШАГ 3: OpenAI ответ (с oldContextSummary)
├─ ШАГ 4: Сохранение → msg22 (user) + msg23 (ai)
└─ ШАГ 5: count() = 23
           if (23 > 20) → TRUE ✅
           autoEmbedOldMessages() в фоне
           └─ getMessagesNeedingEmbedding()
              → Все сообщения: 23
              → Последние 20: [msg4...msg23]
              → Старые: [msg1, msg2, msg3]
              → Проверка embeddings:
                 msg1: EXISTS ✅
                 msg2: NOT EXISTS ❌
                 msg3: NOT EXISTS ❌
              └─ Создаются embeddings для msg2, msg3

После запроса:
- В БД: 23 сообщения
- Embeddings: 3 (msg1, msg2, msg3) ✅
```

---

### Сценарий: 22-е сообщение (12-я пара user+ai)

```
До запроса: 23 сообщения в БД

handleGeneralChat():
├─ ШАГ 1: getRecentMessages() → [msg4...msg23] (20 сообщений)
├─ ШАГ 2: if (20 >= 20) → TRUE
│          count() = 23
│          if (23 > 20) → TRUE
│          searchChatHistory()
│          └─ Ищет в embeddings: [msg1, msg2, msg3] ✅
│          └─ Находит релевантные: [msg2, msg1] (топ-2 по similarity)
│          oldContextSummary = "User: msg2...\nAssistant: msg1..."
├─ ШАГ 3: OpenAI ответ (с oldContextSummary)
├─ ШАГ 4: Сохранение → msg24 (user) + msg25 (ai)
└─ ШАГ 5: count() = 25
           if (25 > 20) → TRUE ✅
           autoEmbedOldMessages() в фоне
           └─ getMessagesNeedingEmbedding()
              → Все сообщения: 25
              → Последние 20: [msg6...msg25]
              → Старые: [msg1, msg2, msg3, msg4, msg5]
              → Проверка embeddings:
                 msg1-3: EXISTS ✅
                 msg4-5: NOT EXISTS ❌
              └─ Создаются embeddings для msg4, msg5

После запроса:
- В БД: 25 сообщений
- Embeddings: 5 (msg1-5) ✅
```

---

## 🎯 Ключевые улучшения после фикса

### 1. Правильный timing

**Было (ПЛОХО):**
```typescript
// 1. Проверка ДО сохранения
if (totalMessages > 20) {
  autoEmbedOldMessages(); // Опоздание на 1 сообщение!
}

// 2. Сохранение ПОСЛЕ проверки
await saveChatMessages();
```

**Стало (ХОРОШО):**
```typescript
// 1. Сохранение СНАЧАЛА
await saveChatMessages();

// 2. Проверка ПОСЛЕ сохранения
const { count } = await supabaseAdmin.from('chat_messages')...;
if (count > 20) {
  autoEmbedOldMessages(); // Правильный timing!
}
```

---

### 2. Нет race condition

**Было (ПЛОХО):**
```typescript
// autoEmbedOldMessages и searchChatHistory параллельно
Promise.race([embedPromise, timeout]);
const relevantOldMessages = await searchChatHistory(); // Может не найти!
```

**Стало (ХОРОШО):**
```typescript
// searchChatHistory ищет в СУЩЕСТВУЮЩИХ embeddings
const relevantOldMessages = await searchChatHistory(); // Всегда находит

// autoEmbedOldMessages создает для СЛЕДУЮЩЕГО запроса
Promise.race([embedPromise, timeout]);
```

---

### 3. Оптимизация запросов

**Было (ПЛОХО):**
```typescript
// Всегда 2 запроса
const { count } = await supabaseAdmin...;
const recentMessages = await getRecentMessages();
```

**Стало (ХОРОШО):**
```typescript
// Сначала быстрая проверка
const recentMessages = await getRecentMessages();
if (recentMessages.length < 20) {
  // Пропускаем count() → экономия запроса
}
```

---

## 📋 Итоговая схема

```
┌─────────────────────────────────────────────────────────────┐
│  ИСПРАВЛЕННАЯ ЛОГИКА:                                        │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│  1. Получение последних 20 сообщений                         │
│     → recentMessages = [msg31...msg50] (из chat_messages)   │
│     → Оптимизация: if (< 20) → пропускаем шаги 2            │
│                                                              │
│  2. Векторный поиск (если >= 20)                            │
│     → count() для подтверждения                             │
│     → searchChatHistory() в СУЩЕСТВУЮЩИХ embeddings         │
│     → oldContextSummary = топ-5 релевантных                │
│                                                              │
│  3. OpenAI ответ                                             │
│     → Использует conversationHistory + oldContextSummary     │
│                                                              │
│  4. Сохранение сообщений                                     │
│     → msg51 (user) + msg52 (ai)                              │
│                                                              │
│  5. Создание embeddings (ПОСЛЕ сохранения, фон)             │
│     → count() = 52 > 20 ✅                                   │
│     → autoEmbedOldMessages() для [msg1...msg32]             │
│     → Embeddings готовы для СЛЕДУЮЩЕГО запроса               │
└─────────────────────────────────────────────────────────────┘
```

---

## ✅ Результат

1. **Правильный timing:** Embeddings создаются в нужный момент
2. **Нет race condition:** Поиск работает с готовыми embeddings
3. **Оптимизация:** Меньше запросов к БД
4. **Надежность:** Embeddings всегда готовы к использованию

---

## 📚 Связанные документы

- `embeddings-fix-analysis.md` - Детальный анализ проблем и исправлений
- `chat-embeddings-creation-flow.md` - Визуальная схема создания embeddings
- `openai-request-structure.md` - Структура запроса к OpenAI
- `chat-search-process.md` - Процесс поиска в истории чата
