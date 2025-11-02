# ✅ Новые Playwright Trace Endpoints - Реализовано

## 🎯 Что добавлено

### 1. GET /trace-files?userId=...

**Назначение:** Получить список всех trace файлов пользователя

**Функциональность:**
- ✅ Фильтрация по userId
- ✅ Сортировка по дате (новые сверху)
- ✅ Метаинформация: fileName, testId, size, status, browser
- ✅ Подготовлено для frontend списка тестов

**Endpoint:**
```
GET /api/v1/playwright/trace-files?userId=user_123
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "fileName": "trace_user_123_test_test456_2025-11-02.zip",
      "testId": "test456",
      "uploadedAt": "2025-11-02T15:22:10Z",
      "size": 5482112,
      "status": "parsed",
      "browser": "chrome",
      "publicUrl": "https://..."
    }
  ],
  "count": 1,
  "message": "Found 1 trace file(s)"
}
```

---

### 2. GET /trace/:testId/steps

**Назначение:** Распаковать trace.zip и извлечь шаги теста

**Функциональность:**
- ✅ Автоматическая распаковка ZIP
- ✅ Парсинг trace файла (JSONL format)
- ✅ Извлечение действий: goto, click, fill, check, assert, etc.
- ✅ Human-readable descriptions
- ✅ Кэширование в БД (status: parsed)
- ✅ Повторные запросы возвращают cached data
- ✅ Готово для визуализации флоу

**Endpoint:**
```
GET /api/v1/playwright/trace/test_456/steps
```

**Response:**
```json
{
  "success": true,
  "data": {
    "testId": "test_456",
    "userId": "user_123",
    "fileName": "trace_user_123_test_test456_2025-11-02.zip",
    "totalSteps": 4,
    "steps": [
      {
        "stepId": 1,
        "type": "goto",
        "url": "https://app.qai.ai/login",
        "timestamp": 1667312123123,
        "description": "Navigate to https://app.qai.ai/login"
      },
      {
        "stepId": 2,
        "type": "fill",
        "selector": "input#email",
        "text": "test@example.com",
        "description": "Fill \"test@example.com\" into input#email"
      },
      {
        "stepId": 3,
        "type": "click",
        "selector": "button#submit",
        "description": "Click on button#submit"
      },
      {
        "stepId": 4,
        "type": "assert",
        "text": "Dashboard loaded",
        "description": "Assert: Dashboard loaded"
      }
    ],
    "parsedAt": "2025-11-02T15:25:00.000Z"
  }
}
```

---

## 📁 Файлы

### Backend Code

**src/api/playwright/playwright.controller.ts**
- ✅ `getTraceFilesByUser()` - получить список trace файлов
- ✅ `getTraceSteps()` - распарсить и вернуть шаги
- ✅ `generateStepDescription()` - helper для описаний

**src/api/playwright/playwright.route.ts**
- ✅ `GET /trace-files` - роут для списка файлов
- ✅ `GET /trace/:testId/steps` - роут для парсинга
- ✅ Swagger документация для обоих endpoints

### Types

**src/types/index.ts**
- ✅ `TraceFileListItem` - тип для элемента списка
- ✅ `TraceStep` - тип для шага теста
- ✅ `TraceStepsResponse` - тип ответа

### Documentation

**docs/api/playwright.md**
- ✅ Документация новых endpoints
- ✅ Request/Response примеры
- ✅ Features описание

**docs/api/examples.md**
- ✅ cURL примеры
- ✅ JavaScript примеры
- ✅ React component example
- ✅ Flow visualization example

### Dependencies

**package.json**
- ✅ `adm-zip` - для распаковки ZIP файлов
- ✅ `@types/adm-zip` - TypeScript типы

---

## 🔑 Key Features

### 1. Intelligent Parsing

```typescript
// Парсинг trace в JSONL format
const traceLines = traceData.split('\n').filter(line => line.trim());

for (const line of traceLines) {
  const event = JSON.parse(line);

  if (event.type === 'action' || event.type === 'apiCall') {
    const step = {
      stepId: stepId++,
      type: event.apiName || event.method,
      selector: event.params?.selector,
      text: event.params?.text,
      url: event.params?.url,
      timestamp: event.time,
      description: generateStepDescription(...)
    };

    steps.push(step);
  }
}
```

### 2. Automatic Caching

```typescript
// Check if already parsed
if (traceFile.parsed_data && traceFile.status === 'parsed') {
  return cachedData; // Instant response
}

// Parse and cache
const steps = parseTrace(buffer);
await supabase
  .from('trace_files')
  .update({
    status: 'parsed',
    parsed_data: { steps },
    parsed_at: new Date().toISOString()
  });
```

### 3. Human-Readable Descriptions

```typescript
function generateStepDescription(step: TraceStep): string {
  switch (step.type) {
    case 'goto':
      return `Navigate to ${step.url}`;
    case 'click':
      return `Click on ${step.selector}`;
    case 'fill':
      return `Fill "${step.text}" into ${step.selector}`;
    case 'assert':
      return `Assert: ${step.text}`;
    default:
      return `${step.type} ${step.selector}`;
  }
}
```

### 4. Error Handling

- ✅ Missing userId validation
- ✅ Missing testId validation
- ✅ File not found handling
- ✅ ZIP parsing errors
- ✅ Database errors
- ✅ Download errors

---

## 📊 Supported Action Types

| Type | Description | Extracted Data |
|------|-------------|----------------|
| `goto` | Navigate to URL | url |
| `click` | Click element | selector |
| `fill` | Fill input | selector, text |
| `type` | Type text | selector, text |
| `check` | Check checkbox | selector |
| `uncheck` | Uncheck checkbox | selector |
| `select` | Select dropdown | selector, text |
| `waitForSelector` | Wait for element | selector |
| `screenshot` | Take screenshot | - |
| `expect` | Assertion | text, selector |
| `assert` | Assertion | text, selector |

---

## 🚀 Usage Examples

### Frontend - Get User's Traces

```javascript
const getTraceFiles = async (userId) => {
  const response = await fetch(
    `/api/v1/playwright/trace-files?userId=${userId}`
  );
  return await response.json();
};

// Usage
const files = await getTraceFiles('user_123');
files.data.forEach(file => {
  console.log(`${file.fileName} - ${file.status}`);
});
```

### Frontend - Visualize Test Steps

```javascript
const getTestSteps = async (testId) => {
  const response = await fetch(
    `/api/v1/playwright/trace/${testId}/steps`
  );
  return await response.json();
};

// Build flow diagram
const { data } = await getTestSteps('test_456');
const flowNodes = data.steps.map(step => ({
  id: step.stepId,
  type: step.type,
  label: step.description,
  data: step
}));

// Render with React Flow, D3, or any visualization library
```

### React Component

```javascript
function TraceVisualization({ testId }) {
  const [steps, setSteps] = useState([]);

  useEffect(() => {
    fetch(`/api/v1/playwright/trace/${testId}/steps`)
      .then(res => res.json())
      .then(data => setSteps(data.data.steps));
  }, [testId]);

  return (
    <div className="trace-flow">
      {steps.map(step => (
        <StepCard key={step.stepId} step={step} />
      ))}
    </div>
  );
}
```

---

## ✅ Validation

- ✅ TypeScript компиляция passed
- ✅ Type-check passed
- ✅ No linter errors
- ✅ Build successful
- ✅ Dependencies installed (adm-zip)
- ✅ Swagger documentation added
- ✅ API examples added

---

## 🔄 Flow

```
1. Upload trace.zip
   POST /upload-trace
   ↓
2. Get user's traces
   GET /trace-files?userId=user_123
   ↓
3. Parse specific trace
   GET /trace/test_456/steps
   ↓
   [First time: Download → Parse → Cache → Return]
   [Subsequent: Return cached data instantly]
   ↓
4. Frontend visualizes steps
   - Flow diagram
   - Step-by-step list
   - Timeline
   - Error highlights
```

---

## 📚 Next Steps

### For Frontend Integration

1. **Trace List Page:**
   - Call `/trace-files?userId=...`
   - Display table/cards with traces
   - Show status, date, test name
   - Click to visualize

2. **Trace Visualization Page:**
   - Call `/trace/:testId/steps`
   - Render flow diagram
   - Show step details
   - Highlight errors
   - Add screenshot thumbnails

3. **Features to Add:**
   - Filter by status (parsed/uploaded)
   - Search by test name
   - Compare failed vs success runs
   - Export steps as JSON
   - Replay test steps

### For Backend Enhancements

1. **Better Parsing:**
   - Extract screenshots from trace
   - Parse network requests
   - Extract console logs
   - Parse performance metrics

2. **Advanced Features:**
   - Screenshot URLs in steps
   - Network waterfall data
   - CPU/Memory metrics
   - Element snapshots

3. **Optimization:**
   - Background parsing jobs
   - Chunked parsing for large files
   - Redis caching
   - CDN for trace files

---

**Created:** 2024-11-02
**Status:** ✅ Ready for Frontend Integration
**Version:** 1.0.0
