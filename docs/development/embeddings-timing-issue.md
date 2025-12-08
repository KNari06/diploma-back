# 🚨 Проблема с timing'ом создания embeddings

## Обнаруженная проблема

В текущей реализации есть **рассинхронизация** между проверкой количества сообщений и их сохранением.

---

## 📊 Текущая логика (ПРОБЛЕМНАЯ)

```typescript
async function handleGeneralChat() {
  // ═══════════════════════════════════════════════════════════
  // ШАГ 1: Получаем количество СУЩЕСТВУЮЩИХ сообщений
  // ═══════════════════════════════════════════════════════════
  const { count: totalMessageCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', chatSessionId);

  const totalMessages = totalMessageCount || 0;
  // ⚠️ НЕ включает текущее сообщение пользователя!

  // ═══════════════════════════════════════════════════════════
  // ШАГ 2: Проверка и векторный поиск
  // ═══════════════════════════════════════════════════════════
  if (totalMessages > 20) {  // ⚠️ Проверка ДО сохранения
    autoEmbedOldMessages(chatSessionId);
    searchChatHistory(...);
  }

  // ═══════════════════════════════════════════════════════════
  // ШАГ 3: Получаем ответ от OpenAI
  // ═══════════════════════════════════════════════════════════
  const gptResponse = await getChatCompletionWithMessages(messages);

  // ═══════════════════════════════════════════════════════════
  // ШАГ 4: СОХРАНЯЕМ сообщения (пользователь + AI)
  // ═══════════════════════════════════════════════════════════
  await ChatService.saveChatMessages(chatSessionId, [
    { role: 'user', content: message },
    { role: 'ai', content: gptResponse.content },
  ]);
  // ⚠️ ТЕПЕРЬ в БД стало totalMessages + 2 сообщения!
}
```

---

## 🔢 Сценарий по шагам

### Сценарий 1: 20-е сообщение (10-я пара user+ai)

```
До запроса:
- В БД: 19 сообщений (9 пар user+ai)
- Пользователь пишет: "Привет" (это будет 20-е сообщение)

Во время handleGeneralChat():
├─ ШАГ 1: totalMessages = 19 (count из БД)
├─ ШАГ 2: if (19 > 20) → FALSE ❌
│          Embeddings НЕ создаются
├─ ШАГ 3: OpenAI ответ: "Здравствуй"
└─ ШАГ 4: Сохранение:
           - { role: 'user', content: 'Привет' }      → msg20
           - { role: 'ai', content: 'Здравствуй' }    → msg21

После запроса:
- В БД: 21 сообщение
- Embeddings: 0 (НЕ созданы)
```

### Сценарий 2: 21-е сообщение (11-я пара user+ai)

```
До запроса:
- В БД: 21 сообщение
- Пользователь пишет: "Как дела?" (это будет 22-е сообщение)

Во время handleGeneralChat():
├─ ШАГ 1: totalMessages = 21 (count из БД)
├─ ШАГ 2: if (21 > 20) → TRUE ✅
│          autoEmbedOldMessages(sessionId)
│          ├─ allMessages = [msg1...msg21]
│          ├─ oldMessages = slice(0, -20) = [msg1]
│          └─ Создается embedding для msg1 ✅
│
│          searchChatHistory()
│          └─ Ищет в embeddings (может найти msg1 если успел создаться)
│
├─ ШАГ 3: OpenAI ответ: "Отлично!"
└─ ШАГ 4: Сохранение:
           - { role: 'user', content: 'Как дела?' }  → msg22
           - { role: 'ai', content: 'Отлично!' }     → msg23

После запроса:
- В БД: 23 сообщения
- Embeddings: 1 (msg1)
```

### Сценарий 3: 22-е сообщение (12-я пара user+ai)

```
До запроса:
- В БД: 23 сообщения
- Пользователь пишет: "Что нового?" (это будет 24-е сообщение)

Во время handleGeneralChat():
├─ ШАГ 1: totalMessages = 23 (count из БД)
├─ ШАГ 2: if (23 > 20) → TRUE ✅
│          autoEmbedOldMessages(sessionId)
│          ├─ allMessages = [msg1...msg23]
│          ├─ oldMessages = slice(0, -20) = [msg1, msg2, msg3]
│          ├─ Проверка embeddings:
│          │  * msg1: уже есть ✅
│          │  * msg2: НЕТ ❌
│          │  * msg3: НЕТ ❌
│          └─ Создаются embeddings для msg2, msg3 ✅
│
│          searchChatHistory()
│          └─ Ищет в embeddings [msg1, msg2, msg3]
│
├─ ШАГ 3: OpenAI ответ: "Все хорошо!"
└─ ШАГ 4: Сохранение:
           - { role: 'user', content: 'Что нового?' }  → msg24
           - { role: 'ai', content: 'Все хорошо!' }    → msg25

После запроса:
- В БД: 25 сообщений
- Embeddings: 3 (msg1, msg2, msg3)
```

---

## ⚠️ Проблемы текущей логики

### 1. Опоздание на 1 сообщение

При 20-м сообщении (10-я пара user+ai):
- `totalMessages = 19` → embeddings НЕ создаются
- Должно быть: `totalMessages = 21` → embeddings создаются

**Эффект:** Embeddings начинают создаваться на 1 сообщение позже, чем нужно.

### 2. Включаются ли текущие сообщения?

При сохранении мы сохраняем 2 сообщения (user + ai), но проверка `totalMessages` их не учитывает.

**Пример:**
- До запроса: 19 сообщений
- Во время запроса: `totalMessages = 19` → embeddings НЕ создаются
- После запроса: 21 сообщение (19 + user + ai)

**Должно быть:**
- После сохранения будет 21 сообщение
- Значит, нужно создавать embeddings для msg1

### 3. Race condition с autoEmbedOldMessages

```typescript
// Запускается в фоне (не ждем)
Promise.race([embedPromise, embedTimeout]).catch(error => {
  logger.warn('[GENERAL_CHAT] Failed to auto-embed messages', { error });
});

// Сразу же ищем (может не успеть создаться)
const relevantOldMessages = await searchChatHistory(...);
```

**Проблема:** `searchChatHistory()` может выполниться **до** того, как `autoEmbedOldMessages()` создаст embeddings.

**Результат:** Первый раз векторный поиск вернет `[]` (пустой массив), потому что embeddings еще создаются.

---

## ✅ Правильная логика (предложение)

### Вариант 1: Проверять ПОСЛЕ сохранения

```typescript
async function handleGeneralChat() {
  // ШАГ 1: Получаем текущие сообщения (без текущего запроса)
  const recentMessages = await ChatService.getRecentMessages(...);

  // ШАГ 2: Получаем ответ от OpenAI
  const gptResponse = await getChatCompletionWithMessages(messages);

  // ШАГ 3: СОХРАНЯЕМ сообщения
  await ChatService.saveChatMessages(chatSessionId, [
    { role: 'user', content: message },
    { role: 'ai', content: gptResponse.content },
  ]);

  // ШАГ 4: ТЕПЕРЬ проверяем количество (ПОСЛЕ сохранения)
  const { count: totalMessageCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', chatSessionId);

  const totalMessages = totalMessageCount || 0;

  // ШАГ 5: Если > 20 → создаем embeddings (фон, для следующего запроса)
  if (totalMessages > 20) {
    autoEmbedOldMessages(chatSessionId).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-embed messages', { error });
    });
  }

  // ШАГ 6: Отправляем ответ пользователю
  res.json({ reply: gptResponse.content });
}
```

**Плюсы:**
- Embeddings создаются в правильный момент (после сохранения)
- Не блокирует ответ пользователю
- Embeddings будут готовы к следующему запросу

**Минусы:**
- Текущий запрос не получит векторный поиск (но это OK, т.к. embeddings еще создаются)

### Вариант 2: Прогнозировать количество

```typescript
async function handleGeneralChat() {
  // ШАГ 1: Получаем количество
  const { count: totalMessageCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', chatSessionId);

  const totalMessages = totalMessageCount || 0;

  // ШАГ 2: Прогнозируем количество ПОСЛЕ сохранения (+2 сообщения)
  const futureMessageCount = totalMessages + 2;

  // ШАГ 3: Векторный поиск (если БУДЕТ > 20)
  if (futureMessageCount > 20) {
    // Создаем embeddings для старых сообщений
    autoEmbedOldMessages(chatSessionId);

    // Ищем в существующих embeddings
    const relevantOldMessages = await searchChatHistory(...);
  }

  // ШАГ 4: OpenAI
  const gptResponse = await getChatCompletionWithMessages(messages);

  // ШАГ 5: Сохранение
  await ChatService.saveChatMessages(chatSessionId, [
    { role: 'user', content: message },
    { role: 'ai', content: gptResponse.content },
  ]);
}
```

**Плюсы:**
- Embeddings создаются в правильный момент
- Текущий запрос может использовать существующие embeddings

**Минусы:**
- Прогнозирование может быть неточным (если AI не ответит)

---

## 🎯 Рекомендация

Использовать **Вариант 1** (проверка после сохранения):

1. Проще и надежнее
2. Не блокирует ответ пользователю
3. Embeddings будут готовы к следующему запросу
4. Нет race condition

**Логика:**
- При 20-м сообщении (после сохранения: 21 сообщение) → создаются embeddings для msg1
- При 21-м сообщении (после сохранения: 23 сообщения) → embeddings уже есть, используются в векторном поиске
