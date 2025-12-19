# 🔍 Процесс поиска сообщений для контекста

## ✅ Правильное понимание:

**НЕТ!** Мы НЕ берем все сообщения в формате embedding.

**Правильно:**
- **Последние 20 сообщений** → берутся **НАПРЯМУЮ из БД** (chat_messages)
- **Старые сообщения (>20)** → ищутся через **векторный поиск** в embeddings

---

## 📊 Визуальная схема процесса

### Ситуация: В чате 50 сообщений

```
Все сообщения: [msg1, msg2, ..., msg30, msg31, ..., msg50]
                ↑                    ↑
            Старые (>20)        Последние 20
```

### Процесс поиска:

```
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 1: Получение последних 20 сообщений                   │
│  ────────────────────────────────────────────────────────    │
│  ChatService.getRecentMessages(sessionId, userId, 20)       │
│                                                              │
│  SQL запрос:                                                 │
│  SELECT * FROM chat_messages                                 │
│  WHERE session_id = 'xxx'                                    │
│  ORDER BY created_at DESC                                    │
│  LIMIT 20                                                    │
│                                                              │
│  Результат: [msg31, msg32, ..., msg50]                      │
│                                                              │
│  ✅ Источник: chat_messages (обычная таблица)               │
│  ✅ Формат: Полный текст сообщений                          │
│  ✅ НЕ используется: embeddings                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 2: Векторный поиск старых сообщений (>20)              │
│  ────────────────────────────────────────────────────────    │
│  searchChatHistory(sessionId, currentMessage, {             │
│    matchCount: 5,                                            │
│    matchThreshold: 0.4                                       │
│  })                                                          │
│                                                              │
│  Что происходит:                                            │
│  1. generateEmbedding(currentMessage) → query vector        │
│  2. SQL функция: search_chat_history(                        │
│       p_session_id: sessionId,                               │
│       p_query_embedding: query_vector,                       │
│       p_match_count: 5                                       │
│     )                                                        │
│  3. Поиск в таблице: chat_message_embeddings                │
│     WHERE session_id = sessionId                            │
│     AND similarity > 0.4                                     │
│     ORDER BY similarity DESC                                 │
│     LIMIT 5                                                  │
│                                                              │
│  Результат: [msg5, msg12, msg8, msg3, msg15]                │
│             (топ-5 релевантных старых сообщений)             │
│                                                              │
│  ✅ Источник: chat_message_embeddings (векторная таблица)   │
│  ✅ Формат: Embeddings (векторный поиск)                     │
│  ✅ Используется: Только для старых сообщений (>20)          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 3: Объединение результатов                              │
│  ────────────────────────────────────────────────────────    │
│  conversationHistory = [msg31, ..., msg50]                  │
│  oldContextSummary = "User: msg5\nAssistant: msg12..."      │
│                                                              │
│  Итого для OpenAI:                                          │
│  - Последние 20: полный текст (из chat_messages)            │
│  - Старые релевантные: топ-5 (из embeddings)               │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔍 Детальный процесс

### 1. Последние 20 сообщений (НАПРЯМУЮ из БД)

```typescript
// Из handleGeneralChat():
const recentMessages = await ChatService.getRecentMessages(
  chatSessionId,
  userId,
  20  // ← Последние 20
);

// Что происходит внутри:
// SQL: SELECT * FROM chat_messages
//      WHERE session_id = 'xxx'
//      ORDER BY created_at DESC
//      LIMIT 20
//
// ✅ Источник: chat_messages (обычная таблица)
// ✅ Формат: Полный текст сообщений
// ❌ НЕ используется: embeddings
```

**Результат:** Массив из 20 сообщений с полным текстом

---

### 2. Старые сообщения (>20) через векторный поиск

```typescript
// Из handleGeneralChat():
if (totalMessages > 20) {
  const relevantOldMessages = await searchChatHistory(
    chatSessionId,
    message, // Текущий запрос пользователя
    { matchCount: 5, matchThreshold: 0.4 }
  );
}

// Что происходит внутри searchChatHistory():
// 1. generateEmbedding(currentMessage) → [1536 чисел]
// 2. SQL функция: search_chat_history(
//      p_session_id: sessionId,
//      p_query_embedding: [1536 чисел],
//      p_match_count: 5
//    )
// 3. Поиск в: chat_message_embeddings
//    WHERE session_id = sessionId
//    AND cosine_similarity > 0.4
//    ORDER BY similarity DESC
//    LIMIT 5
//
// ✅ Источник: chat_message_embeddings (векторная таблица)
// ✅ Формат: Векторный поиск по embeddings
// ✅ Результат: Топ-5 релевантных старых сообщений
```

**Результат:** Массив из 5 релевантных старых сообщений (на основе семантического поиска)

---

## 📝 Код подтверждает это:

### Последние 20 (из chat_messages):

```1671:1676:src/api/chat/chat.controller.ts
    // Get recent messages (last 20)
    const recentMessages = await ChatService.getRecentMessages(chatSessionId, userId, CONSTANTS.RECENT_MESSAGES_LIMIT); // SECURITY: Pass userId for verification

    logger.info('[GENERAL_CHAT] Retrieved recent history', {
      messageCount: recentMessages.length
    });
```

```131:137:src/services/utils/chat.service.ts
      const { data, error } = await supabaseAdmin
        .from('chat_messages')
        .select('id, role, content, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }) // Secondary sort for messages with same timestamp
        .limit(validLimit);
```

**Источник:** `chat_messages` (обычная таблица)

---

### Старые сообщения (из embeddings):

```1705:1713:src/api/chat/chat.controller.ts
        // Search for relevant old messages using semantic similarity
        const relevantOldMessages = await searchChatHistory(
          chatSessionId,
          message, // Current user query
          {
            matchCount: 5, // Top 5 (increased from 3 for better recall)
            matchThreshold: 0.4, // Lowered from 0.5 for better recall on vague questions
          }
        );
```

```170:180:src/services/chat-embeddings.service.ts
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(queryText);

    // Search using stored procedure
    const { data, error } = await supabaseAdmin
      .rpc('search_chat_history', {
        p_session_id: sessionId,
        p_query_embedding: queryEmbedding,
        p_match_count: matchCount,
        p_match_threshold: matchThreshold,
      });
```

**Источник:** `chat_message_embeddings` (векторная таблица)

---

## 🎯 Итоговая схема

```
┌─────────────────────────────────────────────────────────────┐
│  ПРОЦЕСС ПОИСКА:                                              │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│  Всего сообщений: 50                                          │
│                                                              │
│  ├─ Последние 20: [msg31...msg50]                           │
│  │   → Источник: chat_messages (SQL SELECT)                  │
│  │   → Формат: Полный текст                                  │
│  │   → Использование: conversationHistory                    │
│  │   → ❌ НЕ через embeddings                                │
│  │                                                           │
│  └─ Старые (>20): [msg1...msg30]                            │
│      → Источник: chat_message_embeddings (векторный поиск)  │
│      → Формат: Embeddings (семантический поиск)             │
│      → Использование: oldContextSummary (топ-5 релевантных) │
│      → ✅ ТОЛЬКО через embeddings                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 💡 Ключевые моменты

### ✅ Последние 20 сообщений:

- **Источник:** `chat_messages` (обычная таблица)
- **Метод:** Прямой SQL SELECT с LIMIT 20
- **Формат:** Полный текст сообщений
- **Использование:** Всегда включаются в conversationHistory
- **Embeddings:** НЕ используются

### ✅ Старые сообщения (>20):

- **Источник:** `chat_message_embeddings` (векторная таблица)
- **Метод:** Векторный поиск (cosine similarity)
- **Формат:** Embeddings (1536 чисел)
- **Использование:** Только топ-5 релевантных (на основе текущего запроса)
- **Embeddings:** Используются обязательно

---

## 📊 Пример

**Чат с 50 сообщениями, пользователь спрашивает: "Какие были результаты теста?"**

```
1. Получение последних 20:
   → SQL: SELECT * FROM chat_messages WHERE session_id = 'xxx' LIMIT 20
   → Результат: [msg31, msg32, ..., msg50] (полный текст)
   → conversationHistory = [msg31, ..., msg50]

2. Векторный поиск старых:
   → generateEmbedding("Какие были результаты теста?") → query_vector
   → SQL: search_chat_history(sessionId, query_vector, 5)
   → Поиск в: chat_message_embeddings WHERE session_id = sessionId
   → Результат: [msg5, msg12, msg8] (топ-3 релевантных)
   → oldContextSummary = "User: msg5\nAssistant: msg12..."

3. Итого для OpenAI:
   - conversationHistory: 20 сообщений (полный текст)
   - oldContextSummary: 3 релевантных старых сообщения
```

---

## 🎯 Итог

**НЕТ, мы НЕ берем все сообщения в формате embedding!**

**Правильно:**
- ✅ **Последние 20** → напрямую из `chat_messages` (полный текст)
- ✅ **Старые (>20)** → через векторный поиск в `chat_message_embeddings` (топ-5 релевантных)

**Два разных источника данных для двух разных целей!**
