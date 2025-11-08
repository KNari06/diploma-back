# 🧠 Chat Context Implementation

## ✅ Реализовано

### Hybrid Context Strategy

Умная комбинация:
- **Последние 20 сообщений** - детально (для точного контекста)
- **Старые сообщения** - summarization через GPT-3.5-turbo (для экономии токенов)

---

## 📊 Архитектура

### 1. Извлечение истории

```typescript
// Последние 20 сообщений в хронологическом порядке
const recentMessages = await getRecentChatHistory(sessionId, 20);
```

### 2. Summarization старых сообщений

```typescript
// Если сообщений > 20, суммаризируем старые
if (totalMessages > 20) {
  const oldMessages = await getOldMessages(sessionId, 20);
  const summary = await summarizeOldMessages(oldMessages);
}
```

### 3. Построение контекста для OpenAI

```typescript
[
  {
    role: 'system',
    content: systemPrompt + oldContextSummary // Summary в system prompt
  },
  ...recentMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: compressMessageContent(msg.content) // Сжимаем test plans
  })),
  {
    role: 'user',
    content: currentMessage
  }
]
```

---

## 🎯 Оптимизации

### Token Compression

1. **Длинные test plans** сжимаются:
```
БЫЛО (2000 tokens):
"Here is detailed test plan:
1. Navigate to https://example.com
2. Click registration
... [50 строк]"

СТАЛО (50 tokens):
"[Test plan for https://example.com - approved]"
```

2. **Очень длинные сообщения** truncate:
```typescript
if (content.length > 2000) {
  return content.substring(0, 2000) + '... [truncated]';
}
```

---

## 💰 Стоимость (gpt-4o-mini)

### Обычный чат (< 20 сообщений)
- Input: ~2000 tokens
- Cost: ~$0.0003 per request
- ✅ Очень дешево

### Длинный чат (с summarization)
- Summary generation: ~$0.0001 (one-time per 20+ messages)
- Input: ~3000 tokens (summary + recent)
- Cost: ~$0.0005 per request
- ✅ Все еще дешево

### Пример на 100 сообщений
- Суммаризация первых 80: $0.0001
- Обработка каждого из последних 20: $0.0003 × 20 = $0.006
- **Итого: ~$0.006 для всего чата**

---

## 🔧 Реализованные функции

### `getRecentChatHistory(sessionId, limit)`
Извлекает последние N сообщений из БД в хронологическом порядке.

### `getOldMessages(sessionId, recentLimit)`
Получает все сообщения старше последних N.

### `summarizeOldMessages(oldMessages)`
Суммаризирует старые сообщения через GPT-3.5-turbo.
- Извлекает ключевые факты
- Фокус на URL, решениях, контексте
- Max 200 слов
- Язык соответствует оригиналу

### `compressMessageContent(content)`
Сжимает длинные test plans и truncate очень длинные сообщения.

### `handleGeneralChat()` - ОБНОВЛЕНА
Теперь:
1. Загружает историю (последние 20)
2. Проверяет наличие старых сообщений
3. Суммаризирует старые (если есть)
4. Строит messages array для OpenAI
5. Использует `getChatCompletionWithMessages()` вместо `getChatCompletion()`

---

## 📈 Поведение

### Чат с 10 сообщениями
```
System: [Базовый prompt]
User: Message 1
Assistant: Response 1
...
User: Message 10 (current)
```
- Все сообщения детально
- Нет summarization

### Чат с 50 сообщениями
```
System: [Базовый prompt]
        --- Previous Context ---
        Summary of messages 1-30:
        "User tested example.com registration.
         Test plan was approved. Found 2 bugs..."

User: Message 31 (recent)
Assistant: Response 31
...
User: Message 50 (current)
```
- Старые 30 = summary
- Последние 20 = детально

---

## ✅ Преимущества этого подхода

1. **Сохраняет контекст** даже в длинных чатах
2. **Экономит токены** (compress + summarize)
3. **Быстрая реализация** (30 минут)
4. **Масштабируется** до 100+ сообщений
5. **Fail-safe** (если summary fails, продолжаем без него)
6. **Умная приоритезация** (детальный контекст последних 20)

---

## 🧪 Тестирование

Запустить тест:
```bash
./test-chat-context.sh
```

Тест проверяет:
1. AI помнит URL из первого сообщения
2. AI понимает контекст без повторения информации
3. AI отвечает на вопросы про прошлые сообщения

---

## ✅ Фаза 2: Кеширование summary - РЕАЛИЗОВАНО!

### Что добавлено:

**1. getCachedSummary(sessionId)**
- Получает summary из `chat_sessions.context` (JSONB поле)
- Возвращает `{ summary, summarizedUpTo }` или `null`

**2. saveSummaryToCache(sessionId, summary, summarizedUpTo)**
- Сохраняет/обновляет summary в `context` поле
- Логирует все операции

**3. Умная валидация кеша:**
```typescript
if (alreadySummarized >= messagesNeedingSummarization) {
  // Кеш валидный → используем
} else {
  // Кеш устарел → пересуммаризируем
}
```

**4. Структура context (JSONB):**
```json
{
  "context_summary": "User tested example.com...",
  "summarized_up_to_message": 25,
  "last_summary_update": "2025-01-08T12:00:00Z"
}
```

**Схема БД:**
```sql
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY,
  user_id TEXT,
  workspace_id uuid,
  context jsonb DEFAULT '{}',  -- Здесь храним summary
  ...
)
```

### Результат:
- **95% экономия** на summarization calls
- **95% экономия** стоимости
- Автоматическое обновление при устаревании

### Пример:
- Без кеша: 100 сообщений = **80 GPT calls** ($0.008)
- С кешем: 100 сообщений = **4 GPT calls** ($0.0004)

---

## 🚀 Будущие улучшения (если нужно)

### Фаза 3: RAG + Embeddings
- Для чатов > 200 сообщений
- Semantic search по истории
- Использовать pgvector (уже есть в Supabase)

---

## 📝 Логирование

Все этапы логируются:
- `[CHAT_HISTORY]` - извлечение истории
- `[CHAT_SUMMARY]` - суммаризация
- `[GENERAL_CHAT]` - общая обработка

Примеры логов:
```
[GENERAL_CHAT] Retrieved recent history { messageCount: 20 }
[GENERAL_CHAT] Found old messages to summarize { count: 35 }
[CHAT_SUMMARY] Summarizing old messages { count: 35 }
[CHAT_SUMMARY] Summary created { originalLength: 15000, summaryLength: 450 }
[GENERAL_CHAT] Built context for AI {
  totalMessages: 22,
  hasOldSummary: true,
  recentHistoryCount: 20
}
```

---

## 🎯 Итого

✅ **AI теперь помнит контекст чата**
✅ **Последние 20 сообщений - детально**
✅ **Старые сообщения - summarization**
✅ **Экономия токенов через compression**
✅ **Масштабируется до 100+ сообщений**
✅ **Fail-safe & быстро**

Готово к production! 🚀
