# ✅ Исправление логики создания embeddings и векторного поиска

## 🚨 Проблемы в старой реализации

### Проблема 1: Timing создания embeddings

**Старая логика:**
```typescript
// 1. Считаем сообщения ДО сохранения
const totalMessages = await count('chat_messages');  // = 20

// 2. Проверка
if (totalMessages > 20) {  // 20 > 20 = FALSE ❌
  autoEmbedOldMessages();
}

// 3. OpenAI ответ
const gptResponse = await getChatCompletionWithMessages();

// 4. СОХРАНЕНИЕ (ПОСЛЕ проверки!)
await ChatService.saveChatMessages([user, ai]);
// ТЕПЕРЬ в БД 22 сообщения, но проверка уже прошла!
```

**Эффект:**
- При 20-м сообщении: `totalMessages = 19` → embeddings НЕ создаются ❌
- При 21-м сообщении: `totalMessages = 20` → embeddings НЕ создаются ❌
- При 22-м сообщении: `totalMessages = 21` → embeddings создаются ✅

**Опоздание на 1 сообщение!**

---

### Проблема 2: Race condition с autoEmbedOldMessages

**Старая логика:**
```typescript
// Запускаем создание embeddings (фон, не ждем)
Promise.race([embedPromise, embedTimeout]).catch(error => {
  logger.warn('Failed to auto-embed messages');
});

// СРАЗУ же ищем (может не успеть!)
const relevantOldMessages = await searchChatHistory(...);
```

**Эффект:**
- `searchChatHistory()` выполняется **до** того, как `autoEmbedOldMessages()` создаст embeddings
- Первый раз векторный поиск вернет `[]` (пустой), т.к. embeddings еще создаются

---

### Проблема 3: Лишний count запрос

**Старая логика:**
```typescript
// Сначала считаем
const totalMessages = await count('chat_messages');

// Потом получаем последние 20
const recentMessages = await getRecentMessages(sessionId, 20);
```

**Эффект:**
- 2 запроса к БД вместо 1
- Можно оптимизировать: если `recentMessages.length < 20` → точно нет старых сообщений

---

## ✅ Новая логика (исправленная)

### Шаг 1: Получение последних сообщений (ДО поиска)

```typescript
// Получаем последние 20 сообщений (всегда нужны)
const recentMessages = await ChatService.getRecentMessages(
  chatSessionId,
  userId,
  20
);
```

**Зачем:**
- Нужны для `conversationHistory` (всегда)
- Быстрая проверка: если < 20 → точно нет старых сообщений

---

### Шаг 2: Векторный поиск (ТОЛЬКО если есть старые)

```typescript
// Оптимизация: если < 20 сообщений → пропускаем
if (recentMessages.length >= 20 && chatSessionId) {
  // Подтверждаем через count
  const { count: totalMessageCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', chatSessionId);

  const totalMessages = totalMessageCount || 0;

  // Только если ДЕЙСТВИТЕЛЬНО > 20
  if (totalMessages > 20) {
    // Ищем в СУЩЕСТВУЮЩИХ embeddings
    const relevantOldMessages = await searchChatHistory(
      chatSessionId,
      message,
      { matchCount: 5, matchThreshold: 0.4 }
    );

    // Форматируем для контекста
    if (relevantOldMessages.length > 0) {
      oldContextSummary = relevantOldMessages
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n\n');
    }
  }
}
```

**Ключевые моменты:**
- ✅ НЕ создаем embeddings здесь (ищем в существующих)
- ✅ Оптимизация: быстрая проверка `recentMessages.length`
- ✅ Векторный поиск ТОЛЬКО для существующих embeddings

---

### Шаг 3: Получение ответа от OpenAI

```typescript
// Строим промпт с conversationHistory + oldContextSummary
const messages = [
  { role: 'system', content: systemPrompt },
  ...conversationHistory,
  { role: 'user', content: message }
];

// Получаем ответ
const gptResponse = await getChatCompletionWithMessages(messages);
```

---

### Шаг 4: Сохранение сообщений

```typescript
if (chatSessionId) {
  await ChatService.saveChatMessages(chatSessionId, [
    { role: 'user', content: message },
    { role: 'ai', content: gptResponse.content },
  ]);
}
```

---

### Шаг 5: Создание embeddings (ПОСЛЕ сохранения)

```typescript
if (chatSessionId) {
  // Проверяем количество ПОСЛЕ сохранения
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

    // Запускаем в фоне (не блокирует ответ)
    const embedPromise = autoEmbedOldMessages(chatSessionId);
    const embedTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Auto-embed timeout')), 30000)
    );

    Promise.race([embedPromise, embedTimeout]).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-embed messages (background)', {
        error,
        sessionId: chatSessionId
      });
    });
  }
}
```

**Ключевые моменты:**
- ✅ Проверка ПОСЛЕ сохранения
- ✅ Embeddings создаются для СЛЕДУЮЩЕГО запроса
- ✅ Не блокирует текущий ответ

---

## 📊 Сценарии (новая логика)

### Сценарий 1: 20-е сообщение (10-я пара user+ai)

```
До запроса: 19 сообщений

handleGeneralChat():
├─ ШАГ 1: getRecentMessages() → [msg1...msg19] (19 сообщений)
├─ ШАГ 2: if (19 >= 20) → FALSE
│          Векторный поиск НЕ выполняется (оптимизация)
├─ ШАГ 3: OpenAI ответ
├─ ШАГ 4: Сохранение → msg20 (user) + msg21 (ai)
└─ ШАГ 5: count() = 21
           if (21 > 20) → TRUE ✅
           autoEmbedOldMessages() в фоне
           └─ Создается embedding для msg1

После запроса:
- В БД: 21 сообщение
- Embeddings: 1 (msg1) ✅ (создается в фоне)
```

### Сценарий 2: 21-е сообщение (11-я пара user+ai)

```
До запроса: 21 сообщение

handleGeneralChat():
├─ ШАГ 1: getRecentMessages() → [msg2...msg21] (20 сообщений)
├─ ШАГ 2: if (20 >= 20) → TRUE
│          count() = 21
│          if (21 > 20) → TRUE
│          searchChatHistory()
│          └─ Ищет в embeddings: [msg1] ✅ (создан в предыдущем запросе)
│          oldContextSummary = "User: msg1..."
├─ ШАГ 3: OpenAI ответ (с oldContextSummary)
├─ ШАГ 4: Сохранение → msg22 (user) + msg23 (ai)
└─ ШАГ 5: count() = 23
           if (23 > 20) → TRUE ✅
           autoEmbedOldMessages() в фоне
           └─ Проверка: msg1 есть ✅, msg2 нет ❌, msg3 нет ❌
           └─ Создаются embeddings для msg2, msg3

После запроса:
- В БД: 23 сообщения
- Embeddings: 3 (msg1, msg2, msg3) ✅
```

### Сценарий 3: 22-е сообщение (12-я пара user+ai)

```
До запроса: 23 сообщения

handleGeneralChat():
├─ ШАГ 1: getRecentMessages() → [msg4...msg23] (20 сообщений)
├─ ШАГ 2: if (20 >= 20) → TRUE
│          count() = 23
│          if (23 > 20) → TRUE
│          searchChatHistory()
│          └─ Ищет в embeddings: [msg1, msg2, msg3] ✅
│          └─ Находит релевантные: [msg2, msg1] (топ-2)
│          oldContextSummary = "User: msg2...\nAssistant: msg1..."
├─ ШАГ 3: OpenAI ответ (с oldContextSummary)
├─ ШАГ 4: Сохранение → msg24 (user) + msg25 (ai)
└─ ШАГ 5: count() = 25
           if (25 > 20) → TRUE ✅
           autoEmbedOldMessages() в фоне
           └─ Проверка: msg1-3 есть ✅, msg4-5 нет ❌
           └─ Создаются embeddings для msg4, msg5

После запроса:
- В БД: 25 сообщений
- Embeddings: 5 (msg1-5) ✅
```

---

## 🎯 Ключевые улучшения

### 1. Правильный timing

**Было:**
- Проверка ДО сохранения → опоздание на 1 сообщение

**Стало:**
- Проверка ПОСЛЕ сохранения → правильный timing ✅

---

### 2. Нет race condition

**Было:**
- `autoEmbedOldMessages()` и `searchChatHistory()` параллельно
- Первый раз поиск возвращает `[]`

**Стало:**
- `searchChatHistory()` ищет в СУЩЕСТВУЮЩИХ embeddings
- `autoEmbedOldMessages()` создает для СЛЕДУЮЩЕГО запроса ✅

---

### 3. Оптимизация запросов

**Было:**
- Всегда 2 запроса: `count()` + `getRecentMessages()`

**Стало:**
- Быстрая проверка: `if (recentMessages.length < 20)` → пропускаем `count()`
- Экономия на запросах ✅

---

### 4. Логика "на опережение"

**Новая логика:**
- Текущий запрос использует embeddings из ПРОШЛОГО запроса
- Текущий запрос создает embeddings для СЛЕДУЮЩЕГО запроса

**Эффект:**
- Embeddings всегда готовы к моменту использования ✅
- Нет задержек на создание ✅

---

## 📝 Итоговая схема

```
┌─────────────────────────────────────────────────────────────┐
│  НОВАЯ ЛОГИКА (ПРАВИЛЬНАЯ):                                  │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│  1. Получение последних 20 сообщений                         │
│     → recentMessages = [msg31...msg50] (из chat_messages)   │
│                                                              │
│  2. Векторный поиск (если >= 20)                            │
│     → Поиск в СУЩЕСТВУЮЩИХ embeddings                        │
│     → oldContextSummary = топ-5 релевантных                │
│                                                              │
│  3. OpenAI ответ                                             │
│     → Использует conversationHistory + oldContextSummary     │
│                                                              │
│  4. Сохранение сообщений                                     │
│     → msg51 (user) + msg52 (ai)                              │
│                                                              │
│  5. Создание embeddings (ПОСЛЕ сохранения, фон)             │
│     → Проверка: count() = 52 > 20 ✅                         │
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
