# Regression Run — Frontend Integration Guide

Этот документ описывает как бэкенд работает при запуске regression тестов,
какие данные отправляет, какие события слушать и как показать всё на UI.

---

## 1. Общая архитектура

Regression run — это набор тестов, которые выполняются на бэкенде в фоне.
Фронтенд получает данные двумя способами:

1. **WebSocket** (real-time) — события прогресса, шагов, видео
2. **REST API** (polling fallback) — статистика, статус, финальный отчёт

Структура данных:

```
regression_runs          — один запуск (run)
  └── test_executions[]  — каждый тест-кейс внутри run
        └── tests        — реальный запуск Playwright (testId)
              └── test_results — артефакты, AI-анализ
```

---

## 2. Запуск regression run

### Эндпоинты для запуска

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/v1/regression/run` | Запуск одного сохранённого тест-кейса |
| POST | `/api/v1/regression/run-plan` | Запуск плана (набор тестов) |
| POST | `/api/v1/regression/run-module` | Запуск всех тестов модуля |
| POST | `/api/v1/regression/run-flow` | Запуск всех тестов флоу |
| POST | `/api/v1/regression/run-by-tag` | Запуск тестов по тегу |
| POST | `/api/v1/regression/run-by-priority` | Запуск тестов по приоритету |

### Пример: запуск плана

**Request:**
```
POST /api/v1/regression/run-plan
Authorization: Bearer {JWT}

{
  "planId": "uuid-of-plan",
  "parameters": {
    "password": "test123",
    "env": "staging"
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "runId": "uuid-of-run",
    "executionIds": ["exec-1", "exec-2", "exec-3"],
    "totalTests": 3,
    "message": "Plan run started with 3 tests"
  },
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

После этого ответа бэкенд запускает тесты **асинхронно**. Фронт НЕ ждёт завершения —
он подписывается на WebSocket и показывает прогресс в реальном времени.

### Пример: запуск одного теста

**Request:**
```
POST /api/v1/regression/run
Authorization: Bearer {JWT}

{
  "savedTestCaseId": "uuid-of-test-case"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "runId": "uuid-of-run",
    "testId": "uuid-of-test",
    "message": "Test case run started"
  }
}
```

---

## 3. WebSocket: подключение и комнаты

### Подключение

```
wss://your-api.com?token={JWT}
```

При подключении бэкенд автоматически добавляет клиента в комнату `user:{userId}`.
Дополнительные комнаты подключаются вручную:

| Действие | Событие от клиента | Комната |
|----------|-------------------|---------|
| Автоматически при connect | — | `user:{userId}` |
| Следить за тестом | `subscribe:test` с `{ testId }` | `test:{testId}` |
| Следить за чатом | `subscribe:chat` с `{ sessionId }` | `chat:{sessionId}` |
| Отписаться от теста | `unsubscribe:test` с `{ testId }` | — |

### Какие комнаты для чего

- **`user:{userId}`** — получает `regression:run:progress` (общий прогресс run), `test:created`
- **`test:{testId}`** — получает все события конкретного теста (прогресс, шаги, видео, AI анализ)
- **`chat:{sessionId}`** — получает `chat:message`, `chat:test:update` (если тест запущен из чата)

---

## 4. WebSocket события: regression run уровень

### Событие: `regression:run:progress`

**Комната:** `user:{userId}`
**Когда:** На каждом этапе выполнения run

```json
{
  "runId": "uuid",
  "userId": "uuid",
  "status": "started | level_started | test_started | test_completed | level_completed | completed | failed",
  "progress": 0-100,
  "message": "Running UI test (3/10)",
  "details": {
    "totalTests": 10,
    "completedTests": 3,
    "currentLevel": 2,
    "totalLevels": 4,
    "currentTestName": "uuid-of-test-case",
    "passed": 2,
    "failed": 1,
    "skipped": 0
  },
  "timestamp": "ISO8601"
}
```

**Последовательность статусов:**

```
started           → "Regression run started: 10 tests in 3 levels"
level_started     → "Starting level 1/3 (4 tests)"
test_started      → "Running UI test (1/10)"
test_completed    → "UI test passed (1/10)"
test_started      → "Running UI test (2/10)"
test_completed    → "UI test failed (2/10)"
...
level_completed   → "Level 1/3 completed"
level_started     → "Starting level 2/3 (3 tests)"
...
completed         → "Regression run completed: 8 passed, 1 failed, 1 skipped"
```

**Что показывать на UI:**

- `started` → показать карточку run с progress bar 0%
- `test_started` / `test_completed` → обновить progress bar и счётчики
- `completed` / `failed` → финальный статус, показать кнопку "View Report"

---

## 5. WebSocket события: уровень отдельного теста

Чтобы получить детали конкретного теста, фронт должен подписаться на `test:{testId}`.

### Как получить testId?

1. При запуске одного теста — `testId` приходит в ответе POST `/api/v1/regression/run`
2. При запуске плана — testId появляется ПОЗЖЕ, когда бэкенд создаёт тест. Два способа:
   - Слушать `test:created` в комнате `user:{userId}` (приходит для каждого теста)
   - Поллить `GET /api/v1/regression/runs/{runId}/stats` и потом дёрнуть executions

### Событие: `test:progress`

**Комната:** `test:{testId}`
**Когда:** На каждом шаге + при качественных проверках

```json
{
  "testId": "uuid",
  "browser": "chrome",
  "progress": 45,
  "phase": "execution | initializing | quality_checks | finalizing",
  "currentStep": "Step 3/8: Click 'Login Button'",
  "icon": "🖱️",
  "status": "running",
  "timestamp": "ISO8601"
}
```

**Фазы и их значение:**

| phase | progress | Что происходит |
|-------|----------|---------------|
| `initializing` | 5% | Браузер запускается, worker подхватил задачу |
| `execution` | 10-90% | Выполнение шагов (click, type, assert...) |
| `quality_checks` | 92-96% | Проверка broken resources, accessibility, Web Vitals |
| `finalizing` | 98% | Сохранение видео, скриншотов, cleanup |

### Событие: `test:step:completed`

**Комната:** `test:{testId}`
**Когда:** После каждого шага

```json
{
  "testId": "uuid",
  "browser": "chrome",
  "step": 3,
  "stepDescription": "Click login button",
  "success": true,
  "timestamp": "ISO8601",
  "runtimeMeta": {
    "runtimeStatus": "executed | healed | failed",
    "executionMs": 450,
    "rootCause": "ui | backend",
    "failedReason": "element_not_found | assertion_failed | timeout | silent_backend_failure",
    "failureExplanation": "Button not found after 5 second timeout",
    "bugScreenshotUrl": "https://storage.../screenshot.jpg",
    "needsReview": false,
    "flaky": false
  }
}
```

**Что показывать:**

- `success: true` → зелёная галочка рядом с шагом
- `success: false` → красный крестик + `failureExplanation`
- `runtimeStatus: "healed"` → жёлтая иконка "self-healed"
- `bugScreenshotUrl` → кликабельная миниатюра скриншота ошибки
- `rootCause: "backend"` → бейдж "Backend Error" (бэкенд API вернул ошибку)

### Событие: `test:completed`

**Комната:** `test:{testId}`
**Когда:** Когда все браузеры завершили тест

```json
{
  "testId": "uuid",
  "status": "completed",
  "totalBrowsers": 1,
  "completedBrowsers": 1,
  "failedBrowsers": 0,
  "timestamp": "ISO8601"
}
```

### Событие: `test:failed`

**Комната:** `test:{testId}`
**Когда:** Тест упал с ошибкой (не путать с failed step — это полный крэш)

```json
{
  "testId": "uuid",
  "browser": "chrome",
  "error": "Browser crashed unexpectedly",
  "timestamp": "ISO8601"
}
```

### Событие: `test:cancelled`

**Комната:** `test:{testId}`
**Когда:** Юзер отменил или таймаут

```json
{
  "testId": "uuid",
  "reason": "User cancelled",
  "timestamp": "ISO8601"
}
```

---

## 6. Видеострим (опционально)

### Событие: `test:video:started`

**Комната:** `test:{testId}`

```json
{
  "testId": "uuid",
  "sessionId": "stream-session-id",
  "width": 1280,
  "height": 720,
  "fps": 12,
  "timestamp": "ISO8601"
}
```

### Событие: `test:video:frame`

**Комната:** `test:{testId}`
**Частота:** ~12 кадров в секунду

```json
{
  "testId": "uuid",
  "seq": 142,
  "format": "jpeg",
  "data": "base64-encoded-jpeg-without-prefix",
  "width": 1280,
  "height": 720,
  "elapsedTime": 12500,
  "timestamp": "ISO8601"
}
```

**Как отображать:**
```html
<img src="data:image/jpeg;base64,{payload.data}" />
```

### Событие: `test:video:stopped`

```json
{
  "testId": "uuid",
  "reason": "completed | error | timeout",
  "timestamp": "ISO8601"
}
```

### Событие: `test:video:paused` / `test:video:resumed`

Если Redis под нагрузкой, видео может временно остановиться.
Показать overlay "Buffering..." при `paused`, убрать при `resumed`.

---

## 7. AI анализ

После завершения теста бэкенд запускает AI анализ. Это отдельные события:

### `ai:analysis:started` → `ai:analysis:progress` → `ai:analysis:completed`

**Комната:** `test:{testId}`

```json
// ai:analysis:completed
{
  "testId": "uuid",
  "resultId": "uuid",
  "summary": {
    "summary": "Test detected 2 critical bugs in checkout flow",
    "bugs": [
      {
        "severity": "critical",
        "message": "Payment form submitted empty data",
        "location": "#payment-form"
      }
    ],
    "recommendations": [
      "Add client-side validation for payment fields"
    ],
    "confidence": 87
  },
  "timestamp": "ISO8601"
}
```

### `ai:bug:found`

**Комната:** `test:{testId}`
**Когда:** По мере обнаружения багов (до финального отчёта)

```json
{
  "testId": "uuid",
  "bug": {
    "severity": "high",
    "message": "Login button unresponsive after 3 attempts",
    "screenshot": "https://storage.../bug-screenshot.jpg"
  },
  "timestamp": "ISO8601"
}
```

---

## 8. Chat-события (если тест запущен из чата)

### `chat:message`

**Комната:** `chat:{sessionId}`
**Когда:** Тест завершился и результат сохранён в чат

```json
{
  "sessionId": "uuid",
  "messageId": "test-result-{testId}",
  "role": "assistant",
  "content": "🧪 Test Completed\n**URL:** https://example.com\n**Results:** 1/1 passed\n✅ All tests passed!",
  "timestamp": "ISO8601"
}
```

Фронт должен при получении этого события добавить сообщение в чат без перезагрузки.

---

## 9. Polling fallback (если WebSocket упал)

Если WebSocket соединение потеряно, фронт должен поллить REST API.

### GET `/api/v1/regression/runs/{runId}/stats`

**Частота:** каждые 2 секунды пока run не завершён

```json
{
  "success": true,
  "data": {
    "total": 10,
    "passed": 3,
    "failed": 1,
    "skipped": 0,
    "pending": 4,
    "running": 2,
    "cancelled": 0,
    "passRate": 75
  }
}
```

**Логика:**

- `pending + running > 0` → run ещё выполняется, продолжать поллинг
- `pending + running === 0` → run завершён, запросить финальный отчёт
- `progress = (passed + failed + skipped) / total * 100`

---

## 10. Финальный отчёт

### GET `/api/v1/regression/runs/{runId}/report`

**Когда запрашивать:** после получения `regression:run:progress` с `status: "completed"` или `"failed"`,
или когда polling показывает `pending + running === 0`.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "id": "run-uuid",
    "planId": "plan-uuid",
    "planName": "Smoke Tests",
    "status": "completed",
    "trigger": "manual",
    "startedAt": "ISO8601",
    "completedAt": "ISO8601",
    "durationMs": 125000,
    "aiConfidence": 87,

    "summary": {
      "total": 10,
      "passed": 8,
      "failed": 1,
      "skipped": 1,
      "flaky": 0,
      "totalBugs": 3,
      "bySeverity": { "critical": 1, "high": 2, "medium": 0, "low": 0 },
      "byCategory": { "functional": 2, "performance": 1, "accessibility": 0, "visual": 0, "security": 0 }
    },

    "executions": [
      {
        "id": "exec-uuid",
        "testCaseId": "test-case-uuid",
        "testCaseName": "Login Flow",
        "status": "passed",
        "durationMs": 12000,
        "browser": "chrome",
        "bugsCount": 0,

        "steps": [
          {
            "index": 1,
            "description": "Navigate to login page",
            "status": "passed",
            "durationMs": 2100
          },
          {
            "index": 2,
            "description": "Type username",
            "status": "passed",
            "durationMs": 800
          }
        ],

        "artifacts": {
          "videoUrl": "https://storage.../video.webm",
          "traceUrl": "https://storage.../trace.zip",
          "screenshots": ["https://storage.../final.jpg"],
          "bugScreenshots": [],
          "consoleLogs": ["[12:00:01] Page loaded"],
          "networkLogs": [
            { "method": "POST", "url": "/api/login", "status": 200, "durationMs": 340 }
          ],
          "qualityChecks": {
            "webVitals": {
              "loadTime": 1200,
              "firstContentfulPaint": 800,
              "largestContentfulPaint": 1100,
              "cumulativeLayoutShift": 0.05,
              "totalBlockingTime": 120
            },
            "accessibility": {
              "warnings": [{ "message": "Image missing alt text", "selector": "img.hero" }],
              "totalWarnings": 1
            },
            "brokenResources": [],
            "slowAPIs": [
              { "url": "/api/products", "method": "GET", "status": 200, "responseTime": 3200 }
            ]
          }
        }
      }
    ],

    "bugs": [
      {
        "id": "bug-uuid",
        "title": "Payment form accepts empty data",
        "severity": "critical",
        "category": "functional",
        "testCaseId": "test-case-uuid",
        "testCaseName": "Checkout Flow",
        "executionId": "exec-uuid",
        "steps": ["Go to checkout", "Leave all fields empty", "Click Submit"],
        "expected": "Validation error shown",
        "actual": "Form submitted with empty data",
        "selector": "#checkout-form",
        "recommendation": "Add required field validation"
      }
    ],

    "recommendations": [
      "Add client-side validation for payment fields",
      "Consider adding retry logic for flaky network requests"
    ],

    "artifactsSummary": {
      "screenshots": ["url1", "url2"],
      "bugScreenshots": ["url3"],
      "consoleLogs": ["log1", "log2"],
      "networkLogs": [{ "method": "GET", "url": "/api/products", "status": 200, "durationMs": 3200 }],
      "qualityChecks": {
        "webVitals": { "loadTime": 1200, "firstContentfulPaint": 800 },
        "accessibility": { "warnings": [...], "totalWarnings": 3 },
        "brokenResources": [{ "type": "image", "url": "/img/missing.png" }],
        "slowAPIs": [{ "url": "/api/products", "responseTime": 3200 }]
      }
    }
  }
}
```

---

## 11. Step-by-step: полный flow на фронте

### Шаг 1: Юзер нажимает "Run"

```
POST /api/v1/regression/run-plan { planId, parameters }
→ Получить runId
→ Показать карточку run со статусом "Starting..."
→ Progress bar 0%
```

### Шаг 2: Подписаться на WebSocket

```
// Автоматически при connect — уже в комнате user:{userId}
// Слушать regression:run:progress
socket.on('regression:run:progress', handleRunProgress)
```

### Шаг 3: Получаем первые события

```
regression:run:progress { status: "started", totalTests: 10, progress: 0 }
→ Показать "10 tests, 3 levels"
→ Отрисовать список тестов (пустой, все "pending")

regression:run:progress { status: "level_started", currentLevel: 1, totalLevels: 3 }
→ Подсветить Level 1

regression:run:progress { status: "test_started", completedTests: 0 }
→ Первый тест в статусе "running"
```

### Шаг 4: Подписаться на конкретные тесты (опционально)

Если юзер кликнул на тест в списке и хочет видеть детали + видео:

```
// Слушать test:created в user-room чтобы узнать testId
socket.on('test:created', (data) => {
  // data.testId — запомнить, сопоставить с executionId
})

// Когда юзер открывает детали теста:
socket.emit('subscribe:test', { testId: 'uuid' })
socket.on('test:progress', handleTestProgress)
socket.on('test:step:completed', handleStepCompleted)
socket.on('test:video:frame', handleVideoFrame)
```

### Шаг 5: Обновлять UI по мере событий

```
regression:run:progress { status: "test_completed", completedTests: 1, passed: 1 }
→ Первый тест — зелёная галочка
→ Progress bar 10%

regression:run:progress { status: "test_completed", completedTests: 2, failed: 1 }
→ Второй тест — красный крестик
→ Progress bar 20%

...

regression:run:progress { status: "completed", progress: 100, passed: 8, failed: 1, skipped: 1 }
→ Финальный статус
→ Показать кнопку "View Full Report"
```

### Шаг 6: Получить финальный отчёт

```
GET /api/v1/regression/runs/{runId}/report
→ Отрисовать полный отчёт: шаги, баги, видео, скриншоты, quality checks
```

---

## 12. UI mockup: что показывать

```
┌─────────────────────────────────────────────────────┐
│ Regression Run: "Smoke Tests"              [Cancel] │
│ ████████████████░░░░░░  70%   (7/10 tests)         │
│ Level 2 of 3 • 5 passed • 1 failed • 1 skipped     │
├─────────────────────────────────────────────────────┤
│ ✅ Login Flow                  passed    12s        │
│ ✅ Dashboard Load              passed     8s        │
│ ✅ Search Products             passed    15s        │
│ ✅ Add to Cart                 passed    11s        │
│ ✅ API: Payment endpoint       passed     2s        │
│ ❌ Checkout Flow               failed    23s  [👁]  │
│ 🔄 User Profile           Step 4/7  ██░░  57%      │
│ ⏳ Order History               pending              │
│ ⏸️ Admin Panel    blocked by "Checkout Flow"        │
│ ⏸️ Logout Flow    blocked by "User Profile"         │
└─────────────────────────────────────────────────────┘
```

**Статусы тестов в списке:**

| Иконка | Статус | Когда |
|--------|--------|-------|
| ⏳ | pending | Тест ещё не начался |
| ⏸️ | blocked | Зависит от упавшего/ещё не завершённого теста |
| 🔄 | running | Тест выполняется (показать прогресс + текущий шаг) |
| ✅ | passed | Тест прошёл |
| ❌ | failed | Тест упал (кликабельно для деталей) |
| ⏭️ | skipped | Пропущен из-за упавшего prerequisite |

---

## 13. Отмена run и маппинг testId

### POST `/api/v1/regression/runs/{runId}/cancel`

Отмена запущенного regression run. Отменяет все running/pending тесты внутри.

**Request:**
```
POST /api/v1/regression/runs/{runId}/cancel
Authorization: Bearer {JWT}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "runId": "uuid",
    "cancelledTests": 3,
    "totalTests": 5,
    "message": "Run cancelled. 3/5 tests stopped."
  }
}
```

**Ошибки:**
- `404` — run не найден или нет доступа
- `422` — run уже завершён (`status` не `running`/`pending`)

### GET `/api/v1/regression/runs/{runId}/executions`

Возвращает все executions с маппингом `testCaseId → testId`.
Используйте `testId` для подписки на `test:{testId}` room.

**Request:**
```
GET /api/v1/regression/runs/{runId}/executions
Authorization: Bearer {JWT}
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "execution-uuid",
      "testCaseId": "test-case-uuid",
      "testType": "ui",
      "status": "running",
      "browser": "chrome",
      "durationMs": null,
      "errorMessage": null,
      "testId": "test-uuid-for-websocket",
      "startedAt": "ISO8601",
      "completedAt": null
    },
    {
      "id": "execution-uuid-2",
      "testCaseId": "test-case-uuid-2",
      "testType": "ui",
      "status": "pending",
      "browser": "chrome",
      "durationMs": null,
      "errorMessage": null,
      "testId": null,
      "startedAt": null,
      "completedAt": null
    }
  ]
}
```

**Важно:**
- `testId` будет `null` для pending тестов (Playwright ещё не запустился)
- `testId` появляется когда статус переходит в `running`
- Поллите этот endpoint каждые 3-5 секунд чтобы получить новые `testId` по мере запуска тестов
- Как только получили `testId` → подписывайтесь на `test:{testId}` для live шагов/видео

---

## 14. Дополнительные API (справочник)

### Список run-ов для проекта

```
GET /api/v1/regression/runs?projectId={uuid}
```

**Response:** массив run-ов с `id, status, trigger, startedAt, stats, bugsFound`

### Список сохранённых тест-кейсов

```
GET /api/v1/regression/saved-test-cases?projectId={uuid}
```

### Список планов

```
GET /api/v1/regression-plans?projectId={uuid}
```

### План с items

```
GET /api/v1/regression-plans/{planId}
```

### Expand плана (превью перед запуском)

```
GET /api/v1/regression-plans/{planId}/expand
```

**Response:** массив `testCases[]` с `testCaseId, testType, dependsOn[]` — для визуализации зависимостей

### Health плана (тренды)

```
GET /api/v1/regression-plans/{planId}/health?historyLimit=10
```

**Response:** `passRate`, `runHistory[]`, `flakyTests[]`

### Scope items для plan builder

```
GET /api/v1/regression-plans/scope-items?projectId={uuid}
```

**Response:** `modules[], flows[], testCases[]` — всё что можно добавить в план

---

## 15. Обработка ошибок

Все ответы при ошибке:

```json
{
  "success": false,
  "error": "Short error code",
  "message": "Human-readable explanation"
}
```

| HTTP код | Когда |
|----------|-------|
| 400 | Не хватает обязательных полей |
| 404 | Ресурс не найден или нет доступа |
| 422 | Валидация (тест без команд, цикличные зависимости) |
| 500 | Внутренняя ошибка бэкенда |

---

## 16. Аутентификация

- **REST API:** заголовок `Authorization: Bearer {JWT}`
- **WebSocket:** параметр `?token={JWT}` в URL при подключении

При подключении WebSocket бэкенд автоматически:
1. Декодирует JWT → получает `userId`
2. Добавляет клиента в комнату `user:{userId}`
3. Все дальнейшие события в `user:{userId}` приходят автоматически
