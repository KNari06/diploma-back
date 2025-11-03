# 💬 Обработка пользовательских запросов в QAI

Детальное описание как система обрабатывает различные типы запросов от пользователей.

---

## 🔄 Общий Flow

```
User Message
    ↓
1. Intent Parsing (GPT-4o)
    ↓
2. Route by Intent
    ├─→ api_test → Execute API Request → Return result
    ├─→ check_element → (Future: Playwright test)
    ├─→ fill_form → (Future: Playwright test)
    └─→ general_chat → GPT chat + RAG → Return reply
    ↓
3. Save to Database (chat history)
    ↓
4. Return Response
```

---

## 📥 Endpoint

**POST** `/api/v1/chat`

**Request:**
```json
{
  "message": "Проверь что GET на https://api.example.com/users возвращает 200",
  "context": {
    "projectId": "project_123"
  },
  "sessionId": "session_456"
}
```

**Response:**
```json
{
  "reply": "✅ Запрос выполнен.\n- Метод: GET\n- URL: https://api.example.com/users\n- Код ответа: 200...",
  "timestamp": "2024-11-03T00:00:00.000Z",
  "parsedIntent": {
    "intent": "api_test",
    "apiMethod": "GET",
    "apiUrl": "https://api.example.com/users",
    "expectedStatus": 200
  },
  "sessionId": "session_456",
  "apiTestResult": {
    "success": true,
    "status": 200,
    "durationMs": 150,
    "responseBody": {...}
  }
}
```

---

## 🧠 Step 1: Intent Parsing

### Как работает

**Service:** `src/services/intentParser.service.ts`
**Prompt:** `src/ai/prompts/intentParserPrompt.ts`
**Model:** GPT-4o-mini (быстрый и дешевый)

**Process:**
```typescript
const parsedIntent = await parseUserIntent(message);

// Используется GPT-4o-mini с JSON mode
// Temperature: 0 (детерминированный результат)
```

### Supported Intents

| Intent | Description | Example |
|--------|-------------|---------|
| `api_test` | Тестирование API | "Проверь GET на /api/users" |
| `check_element` | Проверка элемента UI | "Проверь что кнопка Buy видна" |
| `fill_form` | Заполнение формы | "Заполни форму регистрации" |
| `login_flow` | Авторизация | "Залогинься как admin" |
| `assert_ui` | Проверка UI/дизайна | "Проверь что цвет кнопки синий" |
| `navigate` | Навигация | "Перейди на /dashboard" |
| `general_chat` | Обычный чат | "Привет, как дела?" |

### Intent Result

```typescript
interface IntentResult {
  intent: string;

  // For UI testing
  elementType?: string;      // button, input, link
  elementLabel?: string;      // "Buy", "Submit"
  page?: string;              // "/login"
  viewport?: string;          // mobile, desktop
  action?: string;            // click, visible
  value?: string;             // input value

  // For API testing
  apiMethod?: string;         // GET, POST, PUT, DELETE
  apiUrl?: string;            // https://api.example.com/users
  apiBody?: any;              // Request body
  apiHeaders?: object;        // Request headers
  expectedStatus?: number;    // 200, 404, etc.

  // Metadata
  confidence?: number;        // 0-1
  rawText?: string;           // Original message
  metadata?: object;          // Additional data
}
```

---

## 🔀 Step 2: Route by Intent

### 2A. API Test Intent

**Условие:** `intent === 'api_test'`

**Process:**
```typescript
// 1. Execute API request
const apiTestResult = await executeApiTest({
  method: parsedIntent.apiMethod,
  url: parsedIntent.apiUrl,
  headers: parsedIntent.apiHeaders,
  body: parsedIntent.apiBody,
  expectedStatus: parsedIntent.expectedStatus,
});

// 2. Format response
const statusEmoji = apiTestResult.success ? '✅' : '❌';
gptResponse = `${statusEmoji} Запрос выполнен.
- Метод: ${method}
- URL: ${url}
- Код ответа: ${status}
- Время: ${durationMs} мс`;

// 3. Save to api_test_logs table
await supabase.from('api_test_logs').insert({...});
```

**What it does:**
- ✅ Выполняет реальный HTTP запрос
- ✅ Проверяет expectedStatus
- ✅ Возвращает body, headers, время ответа
- ✅ Сохраняет в БД
- ✅ Форматирует результат для юзера

**Example:**
```
User: "Проверь GET на https://jsonplaceholder.typicode.com/users/1"

Intent Parser:
{
  "intent": "api_test",
  "apiMethod": "GET",
  "apiUrl": "https://jsonplaceholder.typicode.com/users/1"
}

Execute API Request:
GET https://jsonplaceholder.typicode.com/users/1
→ 200 OK (150ms)

Response:
"✅ Запрос выполнен.
- Метод: GET
- URL: https://jsonplaceholder.typicode.com/users/1
- Код ответа: 200
- Время: 150 мс

Тело ответа:
{
  "id": 1,
  "name": "Leanne Graham",
  "username": "Bret",
  ...
}"
```

---

### 2B. General Chat Intent

**Условие:** `intent !== 'api_test'` или другие intents

**Process:**
```typescript
// 1. Build prompt
const prompt = buildChatPrompt({ message, context });

// 2. Get KB context (RAG)
const kbResults = await searchKB(message, projectId, {
  matchThreshold: 0.7,
  matchCount: 5,
});

// 3. Add KB context to prompt
const finalContext = kbContext + userContext;

// 4. Get GPT response
gptResponse = await getChatCompletion(prompt, finalContext);
```

**Features:**
- ✅ RAG (Retrieval Augmented Generation)
- ✅ Knowledge Base search
- ✅ Project-specific context
- ✅ Global KB context
- ✅ Semantic search (embeddings)

**Example:**
```
User: "Как правильно тестировать форму логина?"

KB Search:
→ Finds 5 relevant chunks from uploaded docs
→ Adds context about login testing best practices

GPT Response:
"Для тестирования формы логина рекомендую:
1. Проверить валидацию email
2. Проверить обработку ошибок
3. Проверить успешный вход
...

На основе ваших документов в Knowledge Base:
[Source: login-testing-guide.pdf]
..."
```

---

### 2C. UI Testing Intents (Future)

**Intents:** `check_element`, `fill_form`, `login_flow`, `navigate`, `assert_ui`

**Current Status:** ⚠️ Parser работает, но execution не реализован

**Planned Process:**
```typescript
if (intent === 'check_element') {
  // Create Playwright test
  const test = await createPlaywrightTest({
    url: context.url || 'default',
    action: 'checkElement',
    selector: parsedIntent.elementLabel,
    viewport: parsedIntent.viewport,
  });

  // Queue test execution
  await queueTest(test.id);

  // Return test ID
  return `✅ Тест создан. ID: ${test.id}`;
}
```

**Not implemented yet:** ❌

---

## 💾 Step 3: Save to Database

### Chat Sessions

```sql
chat_sessions (
  id UUID,
  user_id UUID,
  title TEXT,
  created_at TIMESTAMP
)
```

### Chat Messages

```sql
chat_messages (
  id UUID,
  session_id UUID,
  role TEXT, -- 'user' | 'ai'
  content TEXT,
  metadata JSONB, -- parsedIntent, context
  created_at TIMESTAMP
)
```

### API Test Logs

```sql
api_test_logs (
  id UUID,
  user_id UUID,
  method TEXT,
  url TEXT,
  status INT,
  success BOOLEAN,
  duration_ms INT,
  request JSONB,
  response JSONB,
  created_at TIMESTAMP
)
```

**Process:**
```typescript
// 1. Save user message
await supabase.from('chat_messages').insert({
  session_id: chatSessionId,
  role: 'user',
  content: message,
  metadata: { parsedIntent, context }
});

// 2. Save AI response
await supabase.from('chat_messages').insert({
  session_id: chatSessionId,
  role: 'ai',
  content: gptResponse,
  metadata: { parsedIntent }
});

// 3. If API test - save to api_test_logs
if (intent === 'api_test') {
  await supabase.from('api_test_logs').insert({
    user_id: userId,
    method: apiMethod,
    url: apiUrl,
    status: result.status,
    success: result.success,
    duration_ms: result.durationMs,
    request: {...},
    response: {...}
  });
}
```

---

## 🎯 Supported Request Types

### 1. API Testing (Working ✅)

**Примеры:**
```
"Проверь GET на https://api.example.com/users"
"Сделай POST на /api/login с телом {\"email\":\"test@test.com\"}"
"Протестируй DELETE https://api.myapp.com/users/123"
"Проверь что /api/health возвращает 200"
```

**What happens:**
1. Intent Parser распознает `api_test`
2. Извлекает method, url, body, headers, expectedStatus
3. Выполняет реальный HTTP запрос (axios)
4. Проверяет статус код
5. Возвращает результат с телом ответа
6. Сохраняет в api_test_logs

---

### 2. General Chat (Working ✅)

**Примеры:**
```
"Привет, как дела?"
"Расскажи про QAI"
"Какие возможности у платформы?"
"Как тестировать форму?"
```

**What happens:**
1. Intent Parser распознает `general_chat`
2. Ищет релевантный контекст в Knowledge Base
3. Добавляет KB chunks к промпту
4. GPT-4o генерирует ответ
5. Возвращает ответ с контекстом
6. Сохраняет в chat_messages

---

### 3. UI Testing (Not Working ❌)

**Примеры:**
```
"Проверь что кнопка Buy видна на мобилке"
"Заполни форму регистрации"
"Залогинься как admin@test.com"
```

**What happens NOW:**
1. Intent Parser распознает `check_element`/`fill_form`/`login_flow`
2. ❌ Execution не реализован
3. Fallback на general_chat
4. GPT объясняет что нужно сделать (но не выполняет)

**What SHOULD happen:**
1. Create Playwright test
2. Queue execution
3. Wait for results
4. Return test results
5. Show screenshots/errors

---

## 🔑 Key Features

### 1. Intent Parsing (GPT-4o-mini)

**Advantages:**
- ✅ Natural language understanding
- ✅ Flexible (handles typos, different formats)
- ✅ Extensible (new intents easy to add)
- ✅ JSON mode for structured output
- ✅ Fast & cheap (gpt-4o-mini)

**Example transformations:**
```
"Проверь что /api/users работает"
→ { intent: "api_test", apiMethod: "GET", apiUrl: "/api/users" }

"Сделай пост запрос на /login с емейл test@test.com"
→ { intent: "api_test", apiMethod: "POST", apiUrl: "/login", apiBody: {"email":"test@test.com"} }

"Привет"
→ { intent: "general_chat" }
```

### 2. RAG (Retrieval Augmented Generation)

**Process:**
```typescript
// 1. Search KB with semantic similarity
const kbResults = await searchKB(message, projectId, {
  matchThreshold: 0.7,
  matchCount: 5,
});

// 2. Format context
kbContext = kbResults.chunks.map(chunk =>
  `[${chunk.source_file}]:\n${chunk.content}`
).join('\n\n');

// 3. Add to GPT prompt
const response = await getChatCompletion(prompt, kbContext);
```

**Benefits:**
- ✅ Uses user's uploaded documents
- ✅ Project-specific knowledge
- ✅ Global knowledge base
- ✅ Semantic search (not keyword)
- ✅ Automatic context injection

### 3. Chat Sessions

**Features:**
- ✅ Persistent chat history
- ✅ Session management
- ✅ Auto-create sessions
- ✅ Message history stored in DB
- ✅ Metadata tracking (intent, context)

---

## 📊 Examples - What Works Now

### Example 1: API Testing ✅

**User Input:**
```
"Проверь GET запрос на https://jsonplaceholder.typicode.com/users/1"
```

**Intent Parsed:**
```json
{
  "intent": "api_test",
  "apiMethod": "GET",
  "apiUrl": "https://jsonplaceholder.typicode.com/users/1"
}
```

**API Execution:**
```
GET https://jsonplaceholder.typicode.com/users/1
→ 200 OK (152ms)
→ Body: {"id":1,"name":"Leanne Graham",...}
```

**Response:**
```
✅ Запрос выполнен.
- Метод: GET
- URL: https://jsonplaceholder.typicode.com/users/1
- Код ответа: 200
- Время: 152 мс

Тело ответа (первые 200 символов):
{"id":1,"name":"Leanne Graham","username":"Bret","email":"Sincere@april.biz"...
```

---

### Example 2: API Testing with Expected Status ✅

**User Input:**
```
"Проверь что POST на /api/login без пароля возвращает 401"
```

**Intent Parsed:**
```json
{
  "intent": "api_test",
  "apiMethod": "POST",
  "apiUrl": "/api/login",
  "expectedStatus": 401
}
```

**Response:**
```
✅ Запрос выполнен.
- Метод: POST
- URL: /api/login
- Код ответа: 401
- Успешность: Да, как ожидалось
- Время: 85 мс
```

---

### Example 3: General Chat ✅

**User Input:**
```
"Как правильно тестировать форму авторизации?"
```

**Intent Parsed:**
```json
{
  "intent": "general_chat"
}
```

**KB Search:**
```
Finds 3 relevant chunks from uploaded docs:
- login-testing-guide.pdf
- best-practices.md
- auth-testing.docx
```

**Response:**
```
Для тестирования формы авторизации рекомендую:

1. Валидация:
   - Проверь что поля email/password обязательны
   - Проверь валидацию формата email
   - Проверь минимальную длину пароля

2. Ошибки:
   - Неверный email → показывается ошибка
   - Неверный пароль → показывается ошибка
   - Заблокированный аккаунт → показывается предупреждение

3. Успешный вход:
   - Редирект на dashboard
   - Сохранение токена
   - Отображение имени пользователя

На основе ваших документов:
[Source: login-testing-guide.pdf]
Всегда проверяй что форма работает на мобильных устройствах...
```

---

### Example 4: UI Testing (Not Working ❌)

**User Input:**
```
"Проверь что кнопка Buy видна на главной странице"
```

**Intent Parsed:**
```json
{
  "intent": "check_element",
  "elementType": "button",
  "elementLabel": "Buy",
  "action": "visible"
}
```

**Current Response:**
```
Для проверки видимости кнопки "Buy" на главной странице,
я могу создать Playwright тест который:

1. Откроет главную страницу
2. Найдет кнопку по тексту "Buy"
3. Проверит что она visible
4. Сделает screenshot

Однако, автоматическое выполнение UI тестов пока не реализовано.
Используй API endpoint POST /api/v1/manual-test для запуска теста.
```

**What SHOULD happen:**
```
✅ Тест создан и запущен.
ID: test_123
Статус: running

[Через 30 секунд]
✅ Тест завершен!
- Кнопка "Buy" найдена: Да
- Видима: Да
- Screenshot: [link]
```

---

## 🔧 Implementation Details

### Chat Controller

**File:** `src/api/chat/chat.controller.ts`

**Main Function:** `handleChat()`

**Flow:**
```typescript
export const handleChat = async (req, res) => {
  // 1. Extract message, context, sessionId
  const { message, context, sessionId } = req.body;
  const userId = req.user?.id;

  // 2. Create or get session
  let chatSessionId = sessionId || await createSession(userId, message);

  // 3. Parse intent
  const parsedIntent = await parseUserIntent(message);

  // 4. Route by intent
  if (parsedIntent?.intent === 'api_test') {
    // Execute API test
    const apiTestResult = await executeApiTest({...});
    gptResponse = formatApiTestResult(apiTestResult);
  } else {
    // Regular chat with RAG
    const kbContext = await searchKB(message, projectId);
    gptResponse = await getChatCompletion(prompt, kbContext);
  }

  // 5. Save messages to DB
  await saveUserMessage(chatSessionId, message, parsedIntent);
  await saveAIMessage(chatSessionId, gptResponse, parsedIntent);

  // 6. Return response
  res.json({
    reply: gptResponse,
    parsedIntent,
    sessionId: chatSessionId,
    apiTestResult
  });
};
```

---

## 📋 What Works vs What Doesn't

### ✅ Working Features

| Feature | Status | Description |
|---------|--------|-------------|
| Intent Parsing | ✅ 100% | GPT-4o-mini парсит любые запросы |
| API Testing | ✅ 100% | Выполняет HTTP requests |
| General Chat | ✅ 100% | GPT-4o отвечает на вопросы |
| RAG/KB | ✅ 100% | Использует uploaded документы |
| Chat History | ✅ 100% | Сохраняет все в БД |
| Session Management | ✅ 100% | Persistent sessions |

### ❌ Not Working Features

| Feature | Status | Blocker |
|---------|--------|---------|
| UI Testing | ❌ 0% | No Playwright agent |
| Form Filling | ❌ 0% | No browser automation |
| Element Checking | ❌ 0% | No test execution |
| Navigation Tests | ❌ 0% | No browser control |
| Visual Assertions | ❌ 0% | No screenshot comparison |

---

## 🎯 Roadmap for Full Chat Support

### Phase 1: UI Testing Support (2-3 weeks)

```
[ ] Implement Playwright agent
[ ] Create test execution service
[ ] Queue UI test jobs
[ ] Return test results in chat
[ ] Support: check_element, fill_form, navigate
```

**Example after implementation:**
```
User: "Проверь что кнопка Buy видна"
AI: "✅ Тест запущен...
     ✅ Завершен! Кнопка найдена и видна.
     Screenshot: [link]"
```

### Phase 2: Advanced Intents (1-2 weeks)

```
[ ] Support login_flow
[ ] Support assert_ui (visual testing)
[ ] Support screenshot comparison
[ ] Support performance checks
[ ] Support accessibility tests
```

### Phase 3: Streaming Responses (1 week)

```
[ ] Implement SSE (Server-Sent Events)
[ ] Stream GPT responses
[ ] Stream test progress
[ ] Real-time status updates
```

**Endpoint:**
```typescript
POST /api/v1/chat/stream
→ Returns SSE stream
→ Real-time updates
```

---

## 🔍 Current Limitations

### 1. Only API Testing Works

**What you CAN do:**
```
✅ "Проверь GET на /api/users"
✅ "Сделай POST на /login"
✅ "Протестируй DELETE /users/123"
```

**What you CAN'T do yet:**
```
❌ "Проверь что кнопка Buy видна"
❌ "Заполни форму"
❌ "Залогинься как admin"
❌ "Проверь цвет кнопки"
```

### 2. No Streaming

Responses are synchronous (no real-time updates).

### 3. No Test History in Chat

Chat doesn't show previous test results automatically.

---

## 💡 Recommended Usage (Current State)

### For API Testing ✅
```
POST /api/v1/chat
{
  "message": "Проверь GET на https://api.example.com/users"
}

→ Executes immediately
→ Returns result
```

### For UI Testing ❌ (Use manual endpoint instead)
```
POST /api/v1/manual-test
{
  "url": "https://example.com",
  "action": "checkElement",
  "selector": "button.buy"
}

→ Creates test
→ Queues execution
→ Returns test ID
```

### For Questions ✅
```
POST /api/v1/chat
{
  "message": "Как тестировать форму?"
}

→ Uses RAG + KB
→ Returns detailed answer
```

---

## 📚 Related Documentation

- [Chat API](../api/README.md#chat)
- [Intent Parser](../development/intent-parser.md)
- [Knowledge Base](../architecture/knowledge-base.md)
- [API Testing](../api/examples.md#api-test)

---

**Created:** 2024-11-03
**Status:** API Testing works ✅ | UI Testing planned ⚠️
**Version:** 1.0.0
