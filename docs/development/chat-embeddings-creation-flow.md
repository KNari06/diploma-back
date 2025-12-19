# 🔄 Процесс создания векторных embeddings для сообщений

## ⚠️ ВАЖНО: Lazy Creation (ленивое создание)

**Embeddings НЕ создаются сразу при сохранении сообщений!**

Они создаются **только когда нужно** - когда сообщений становится > 20.

---

## 📊 Визуальная схема процесса

### Сценарий 1: Первые 20 сообщений (embeddings НЕ создаются)

```
┌─────────────────────────────────────────────────────────────┐
│  Пользователь отправляет сообщение                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Сохранение в БД (chat_messages)                            │
│  ────────────────────────────────────────────────────────    │
│  ChatService.saveChatMessages(sessionId, [                  │
│    { role: 'user', content: 'Привет' },                     │
│    { role: 'ai', content: 'Здравствуй!' }                   │
│  ])                                                          │
│                                                              │
│  ✅ Сообщения сохранены в chat_messages                      │
│  ❌ Embeddings НЕ создаются (еще рано)                      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Следующее сообщение...                                      │
│  (повторяется до 20 сообщений)                              │
└─────────────────────────────────────────────────────────────┘
```

**Итого:** 20 сообщений в БД, 0 embeddings

---

### Сценарий 2: 21-е сообщение (embeddings начинают создаваться)

```
┌─────────────────────────────────────────────────────────────┐
│  Пользователь отправляет 21-е сообщение                     │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 1: Сохранение нового сообщения                          │
│  ────────────────────────────────────────────────────────    │
│  ChatService.saveChatMessages(sessionId, [                   │
│    { role: 'user', content: 'Новое сообщение' },            │
│    { role: 'ai', content: 'Ответ AI' }                      │
│  ])                                                          │
│                                                              │
│  ✅ Сообщения сохранены в chat_messages                      │
│  ❌ Embeddings НЕ создаются сразу                            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 2: Проверка количества сообщений                       │
│  ────────────────────────────────────────────────────────    │
│  totalMessages = 21                                          │
│  if (totalMessages > 20) {                                  │
│    // Начинаем создавать embeddings!                         │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 3: Автоматическое создание embeddings (ФОН)            │
│  ────────────────────────────────────────────────────────    │
│  autoEmbedOldMessages(sessionId)                             │
│                                                              │
│  Что происходит:                                             │
│  1. getMessagesNeedingEmbedding(sessionId)                  │
│     → Получает ВСЕ сообщения из БД                           │
│     → Исключает последние 20 (они в conversationHistory)    │
│     → Фильтрует те, у которых уже есть embeddings            │
│     → Возвращает: [msg1, msg2, ... msgN] (старые без embed) │
│                                                              │
│  2. embedMultipleMessages(sessionId, messages)               │
│     → Для каждого сообщения:                                 │
│        a) embedChatMessage(sessionId, msgId, role, content)  │
│        b) generateEmbedding(content) → [1536 чисел]          │
│        c) Сохранить в chat_message_embeddings                │
│        d) Задержка 600ms (rate limit OpenAI)                  │
│                                                              │
│  ⚡ ВАЖНО: Это происходит в ФОНЕ (Promise.race с timeout)    │
│  ⚡ НЕ блокирует ответ пользователю!                         │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 4: Векторный поиск (параллельно)                       │
│  ────────────────────────────────────────────────────────    │
│  searchChatHistory(sessionId, currentMessage, {             │
│    matchCount: 5,                                            │
│    matchThreshold: 0.4                                       │
│  })                                                          │
│                                                              │
│  Что происходит:                                            │
│  1. generateEmbedding(currentMessage) → query vector        │
│  2. SQL: search_chat_history(                                │
│       p_session_id,                                          │
│       query_vector,                                          │
│       match_count: 5                                         │
│     )                                                        │
│  3. Возвращает топ-5 релевантных старых сообщений             │
│                                                              │
│  ⚠️ Если embeddings еще не созданы → вернет пустой массив    │
│  ✅ Если embeddings созданы → вернет релевантные сообщения   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔍 Детальный процесс создания embeddings

### Функция: `autoEmbedOldMessages(sessionId)`

```typescript
// 1. Получить сообщения, которым нужны embeddings
const messagesNeedingEmbedding = await getMessagesNeedingEmbedding(sessionId);

// Логика getMessagesNeedingEmbedding:
// - Получить ВСЕ сообщения из chat_messages WHERE session_id = X
// - Отсортировать по created_at ASC
// - Взять все КРОМЕ последних 20: allMessages.slice(0, -20)
// - Получить список уже созданных embeddings
// - Отфильтровать: только те, у которых НЕТ embeddings
// - Вернуть список

// 2. Создать embeddings для каждого сообщения
return await embedMultipleMessages(sessionId, messagesNeedingEmbedding);
```

### Функция: `embedMultipleMessages(sessionId, messages)`

```typescript
for (const message of messages) {
  // Для каждого сообщения:

  // 1. Обрезать если слишком длинное (>15K символов)
  let truncatedContent =
    content.length > 15000
      ? content.substring(0, 15000) + "... [truncated]"
      : content;

  // 2. Создать embedding через OpenAI
  const embedding = await generateEmbedding(truncatedContent);
  // → Вызов OpenAI API: text-embedding-3-small
  // → Возвращает массив из 1536 чисел (вектор)

  // 3. Сохранить в БД
  await supabaseAdmin.from("chat_message_embeddings").upsert({
    session_id: sessionId,
    message_id: message.id,
    role: message.role,
    content: truncatedContent,
    embedding: embedding, // VECTOR(1536)
    metadata: {
      original_length: content.length,
      was_truncated: content.length > 15000,
    },
  });

  // 4. Задержка 600ms (rate limit OpenAI: ~3000 RPM)
  await new Promise((resolve) => setTimeout(resolve, 600));
}
```

---

## ⏱️ Временная шкала создания embeddings

### Первый раз (когда сообщений становится > 20):

```
0ms      → Пользователь отправил 21-е сообщение
50ms     → Сообщение сохранено в chat_messages
100ms    → Проверка: totalMessages = 21 > 20 ✅
150ms    → Запуск autoEmbedOldMessages() (ФОН)
200ms    → getMessagesNeedingEmbedding() → [msg1, msg2, ... msgN]
250ms    → Начало embedMultipleMessages()
          ↓
300ms    → embedChatMessage(msg1) → OpenAI API → embedding[1536]
900ms    → Сохранение в chat_message_embeddings (msg1)
1500ms   → embedChatMessage(msg2) → OpenAI API → embedding[1536]
2100ms   → Сохранение в chat_message_embeddings (msg2)
...
N*600ms  → Все embeddings созданы
```

**Пример:** Если нужно создать embeddings для 10 старых сообщений:

- Время: ~10 \* 600ms = **6 секунд** (в фоне)
- Пользователь получит ответ сразу (не ждет embeddings)

---

## 🔄 Последующие запросы (>20 сообщений)

### Когда embeddings уже созданы:

```
┌─────────────────────────────────────────────────────────────┐
│  Пользователь отправляет новое сообщение                     │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Проверка: totalMessages = 50 > 20 ✅                        │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  autoEmbedOldMessages(sessionId)                            │
│  ────────────────────────────────────────────────────────    │
│  getMessagesNeedingEmbedding() →                            │
│    - Всего сообщений: 50                                     │
│    - Последние 20: [msg31...msg50] (исключаем)              │
│    - Старые: [msg1...msg30]                                  │
│    - Проверяем embeddings:                                  │
│      * msg1-msg30: ✅ уже есть embeddings                    │
│    - Результат: [] (пусто - все уже созданы)                │
│                                                              │
│  ⚡ Возвращает: { success: 0, failed: 0 }                    │
│  ⚡ Время: ~50ms (только проверка)                          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  searchChatHistory() - работает сразу!                       │
│  ────────────────────────────────────────────────────────    │
│  - Все embeddings уже в БД                                   │
│  - Векторный поиск находит релевантные сообщения             │
│  - Время: ~100ms                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📝 Код из chat.controller.ts

```typescript
// В handleGeneralChat():

if (totalMessages > CONSTANTS.RECENT_MESSAGES_LIMIT && chatSessionId) {
  // ⚡ АВТОМАТИЧЕСКОЕ создание embeddings (ФОН)
  const embedPromise = autoEmbedOldMessages(chatSessionId);
  const embedTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Auto-embed timeout")), 30000)
  );

  // Запускаем в фоне, не ждем завершения
  Promise.race([embedPromise, embedTimeout]).catch((error) => {
    logger.warn("[GENERAL_CHAT] Failed to auto-embed messages", { error });
  });

  // ⚡ ПАРАЛЛЕЛЬНО: Векторный поиск
  const relevantOldMessages = await searchChatHistory(chatSessionId, message, {
    matchCount: 5,
    matchThreshold: 0.4,
  });

  // Если embeddings еще создаются → может вернуть пустой массив
  // Если embeddings уже есть → вернет релевантные сообщения
}
```

---

## 🎯 Ключевые моменты

### ✅ Когда создаются embeddings:

1. **Lazy creation**: Только когда сообщений > 20
2. **Фоновый процесс**: Не блокирует ответ пользователю
3. **Инкрементально**: Создаются только для новых старых сообщений
4. **Автоматически**: При каждом запросе проверяется и создаются если нужно

### ❌ Когда НЕ создаются:

1. Первые 20 сообщений (они всегда в conversationHistory)
2. Сообщения, у которых уже есть embeddings
3. Пустые сообщения (пропускаются)

### ⚡ Оптимизации:

1. **Upsert**: Если embedding уже есть → обновляется (не дублируется)
2. **Rate limiting**: 600ms задержка между запросами к OpenAI
3. **Timeout**: 30 секунд максимум на создание embeddings
4. **Truncation**: Сообщения >15K символов обрезаются

---

## 📊 Пример: Чат с 50 сообщениями

```
Сообщения в БД: [msg1, msg2, ..., msg50]

При первом запросе (>20):
├─ conversationHistory: [msg31...msg50] (последние 20)
├─ autoEmbedOldMessages():
│  └─ Создает embeddings для: [msg1...msg30] (старые)
└─ searchChatHistory():
   └─ Ищет в embeddings: [msg1...msg30] (если уже созданы)

При втором запросе:
├─ conversationHistory: [msg31...msg50] (последние 20)
├─ autoEmbedOldMessages():
│  └─ Проверяет: [msg1...msg30] уже есть embeddings ✅
│  └─ Результат: { success: 0, failed: 0 } (ничего не создано)
└─ searchChatHistory():
   └─ Ищет в embeddings: [msg1...msg30] ✅ (работает сразу)
```

---

## 🔍 Где хранятся embeddings?

### Таблица: `chat_message_embeddings`

```sql
CREATE TABLE chat_message_embeddings (
    id UUID PRIMARY KEY,
    session_id UUID REFERENCES chat_sessions(id),
    message_id UUID REFERENCES chat_messages(id), -- Связь с сообщением
    role TEXT,                    -- 'user' или 'ai'
    content TEXT,                 -- Оригинальный текст (обрезанный)
    embedding VECTOR(1536),       -- Вектор из 1536 чисел
    metadata JSONB,               -- { original_length, was_truncated }
    created_at TIMESTAMP
);
```

### Связь:

```
chat_messages (id: msg123)
    ↓
chat_message_embeddings (message_id: msg123, embedding: [0.123, -0.456, ...])
```

---

## 💡 Итог

**Embeddings создаются:**

- ✅ Лениво (lazy) - только когда нужно
- ✅ В фоне - не блокируют ответ
- ✅ Автоматически - при каждом запросе проверяется
- ✅ Инкрементально - только для новых старых сообщений

**Момент создания:**

1. Пользователь отправляет сообщение
2. Сообщение сохраняется в `chat_messages`
3. Если `totalMessages > 20`:
   - Запускается `autoEmbedOldMessages()` (фон)
   - Создаются embeddings для старых сообщений (>20)
   - Сохраняются в `chat_message_embeddings`
4. Параллельно выполняется векторный поиск
5. Пользователь получает ответ (не ждет embeddings)
