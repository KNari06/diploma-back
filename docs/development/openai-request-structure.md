# 📊 Структура запроса к OpenAI API

## Визуальная схема формирования `messages` массива

### 🔄 Процесс сборки контекста:

```
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 1: Получение последних 20 сообщений из БД              │
│  ────────────────────────────────────────────────────────    │
│  ChatService.getRecentMessages(sessionId, userId, 20)       │
│                                                              │
│  Результат: conversationHistory[]                           │
│  [                                                           │
│    { role: 'user', content: 'Привет' },                     │
│    { role: 'assistant', content: 'Здравствуй!' },           │
│    { role: 'user', content: 'Тест API...' },                │
│    ... (до 20 сообщений)                                    │
│  ]                                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 2: Векторный поиск старых сообщений (>20)              │
│  ────────────────────────────────────────────────────────    │
│  searchChatHistory(sessionId, currentMessage, {              │
│    matchCount: 5,                                            │
│    matchThreshold: 0.4                                       │
│  })                                                          │
│                                                              │
│  Результат: oldContextSummary (string)                      │
│  "User: Test API endpoint                                   │
│   Assistant: I tested it, status 200...                     │
│   User: What were results?                                  │
│   Assistant: Here are results..."                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 3: Построение system prompt                            │
│  ────────────────────────────────────────────────────────    │
│  buildChatSystemPrompt()                                     │
│                                                              │
│  Результат: systemPrompt (string)                          │
│  "You are QAIT - an AI QA automation assistant..."          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ШАГ 4: Сборка финального массива messages                  │
│  ────────────────────────────────────────────────────────    │
│  messages = []                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Финальная структура `messages` массива

### Пример 1: Новый чат (нет истории)

```javascript
messages = [
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1️⃣ SYSTEM PROMPT (базовый)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'system',
    content: `You are QAIT - an AI QA automation assistant. Think like ChatGPT having a natural conversation about testing.

🎯 YOUR MINDSET: Understand CONTEXT, not just keywords

When user talks to you, FIRST understand WHAT THEY WANT:
• Are they REQUESTING a new test? → Guide them through test creation
• Are they ASKING about past results? → Discuss what happened
• Are they having a CONVERSATION? → Be helpful and natural
• Are they APPROVING a test? → Acknowledge and proceed

--- YOUR CAPABILITIES ---

You work with a real testing platform that:
✓ Executes UI tests (Playwright) on real browsers
✓ Runs API tests (HTTP requests) on real endpoints
✓ Generates comprehensive test plans
✓ Analyzes bugs and performance

⚠️ IMPORTANT: You're NOT just chatting - you EXECUTE real tests!
• When user approves → Platform runs REAL tests automatically
• You receive ACTUAL results (not simulated)
• NEVER say "I cannot execute" or "I'm just an AI" - you CAN and DO execute!

[... остальной промпт ...]`
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2️⃣ ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'user',
    content: 'Привет! Как дела?'
  }
]
```

---

### Пример 2: Чат с историей (≤20 сообщений)

```javascript
messages = [
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1️⃣ SYSTEM PROMPT (базовый)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'system',
    content: `You are QAIT - an AI QA automation assistant...`
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2️⃣ ИСТОРИЯ РАЗГОВОРА (последние 20 сообщений, хронологически)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'user',
    content: 'Привет'
  },
  {
    role: 'assistant',
    content: 'Здравствуй! Чем могу помочь?'
  },
  {
    role: 'user',
    content: 'Протестируй API https://api.example.com/users'
  },
  {
    role: 'assistant',
    content: 'Хорошо, вот план теста:\n\n📋 Test Plan:\n- Method: GET\n- URL: https://api.example.com/users\n\nПодтверждаешь?'
  },
  {
    role: 'user',
    content: 'Да, запускай'
  },
  {
    role: 'assistant',
    content: '✅ Test executed!\n\n--- TEST RESULTS ---\nTest ID: api_12345\nTest Type: api\nHTTP Status: 200\nResponse Time: 613ms\nMethod: GET\nResponse Body: [{"id": 1, "name": "John"}, ...]\nHeaders: {"content-type": "application/json"}'
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3️⃣ ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'user',
    content: 'Какие были результаты?'
  }
]
```

---

### Пример 3: Чат с историей (>20 сообщений) + векторный поиск

```javascript
messages = [
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1️⃣ SYSTEM PROMPT (улучшенный с summary старых сообщений)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'system',
    content: `You are QAIT - an AI QA automation assistant...

--- Previous Conversation Context ---
User: Test API endpoint https://api.example.com/users
Assistant: I tested it, status 200, response time 613ms
User: What were the results?
Assistant: Here are the results: [details]
User: Can you explain this?
Assistant: Sure, the API returns...

Note: The above is a summary of earlier messages. Recent messages follow below.`
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2️⃣ ИСТОРИЯ РАЗГОВОРА (последние 20 сообщений)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'user',
    content: 'Протестируй другой endpoint'
  },
  {
    role: 'assistant',
    content: 'Какой endpoint тестировать?'
  },
  {
    role: 'user',
    content: 'https://api.example.com/posts'
  },
  {
    role: 'assistant',
    content: '📋 Test Plan:\n- Method: GET\n- URL: https://api.example.com/posts\n\nПодтверждаешь?'
  },
  // ... еще 16 сообщений (всего 20 последних)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3️⃣ ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    role: 'user',
    content: 'Покажи результаты последнего теста'
  }
]
```

---

### Пример 4: С test results в metadata

```javascript
messages = [
  {
    role: 'system',
    content: `You are QAIT - an AI QA automation assistant...`
  },

  // Сообщение с test results в metadata
  {
    role: 'assistant',
    content: `✅ Test executed!

--- TEST RESULTS ---
Test ID: api_12345
Test Type: api
HTTP Status: 200
Response Time: 613ms
Method: GET
Response Body: [{"id": 1, "name": "John", "email": "john@example.com"}, ...]
Headers: {"content-type": "application/json", "x-ratelimit": "100"}

Fuzzing Report: 50 tests, 45 passed, 5 failed, 3 issues found, Security Score: 85`
  },

  {
    role: 'user',
    content: 'Что было в ответе?'
  }
]
```

---

## 🔢 Размеры и лимиты

### Токены (примерно):

```
┌─────────────────────────────────────────────────────────────┐
│ System Prompt:        ~800-1000 tokens                      │
│ Old Context Summary:  ~200-500 tokens (если >20 сообщений) │
│ KB Context:          ~0 tokens (закомментирован)           │
│ KB Rules:            ~0 tokens (закомментирован)           │
│ Conversation History: ~100-2000 tokens (20 сообщений)       │
│ Current Message:      ~10-200 tokens                        │
├─────────────────────────────────────────────────────────────┤
│ TOTAL:               ~1100-3700 tokens                     │
└─────────────────────────────────────────────────────────────┘
```

### Лимиты:

- **Последние сообщения**: максимум 20 (`CONSTANTS.RECENT_MESSAGES_LIMIT`)
- **Векторный поиск**: топ 5 релевантных старых сообщений
- **Max tokens**: 1000 для ответа (`max_tokens: 1000`)
- **Temperature**: 0.3 (более консистентные ответы)

---

## 📝 Код формирования (из chat.controller.ts)

```typescript
// 1. Получаем последние 20 сообщений
const recentMessages = await ChatService.getRecentMessages(
  chatSessionId,
  userId,
  20
);

// 2. Если сообщений > 20, ищем старые через векторы
if (totalMessages > 20) {
  const relevantOldMessages = await searchChatHistory(
    chatSessionId,
    message, // текущий запрос
    { matchCount: 5, matchThreshold: 0.4 }
  );

  oldContextSummary = relevantOldMessages
    .map(msg => `${msg.role}: ${msg.content}`)
    .join('\n\n');
}

// 3. Собираем массив messages
const messages = [
  // System prompt (с summary если есть)
  {
    role: 'system',
    content: oldContextSummary
      ? `${systemPrompt}\n--- Previous Conversation Context ---\n${oldContextSummary}`
      : systemPrompt
  },

  // История (последние 20)
  ...conversationHistory.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: compressMessageContent(msg.content) // сжимаем длинные сообщения
  })),

  // Текущее сообщение
  { role: 'user', content: message }
];

// 4. Отправляем в OpenAI
const response = await getChatCompletionWithMessages(messages, {
  temperature: 0.3,
  max_tokens: 1000
});
```

---

## 🎯 Итоговая структура (всегда в таком порядке):

```
messages = [
  1. { role: 'system', content: 'System prompt + old context summary' }
  2. { role: 'user', content: 'Первое сообщение из истории' }
  3. { role: 'assistant', content: 'Первый ответ AI' }
  4. { role: 'user', content: 'Второе сообщение...' }
  ...
  N. { role: 'assistant', content: 'Последний ответ из истории' }
  N+1. { role: 'user', content: 'ТЕКУЩЕЕ сообщение пользователя' }
]
```

---

## ⚡ Оптимизации

1. **Сжатие длинных сообщений**: `compressMessageContent()` укорачивает test plans
2. **Векторный поиск**: вместо GPT summarization (20x быстрее, 20x дешевле)
3. **Лимит истории**: только последние 20 сообщений (экономия токенов)
4. **KB отключен**: временно закомментирован для экономии
