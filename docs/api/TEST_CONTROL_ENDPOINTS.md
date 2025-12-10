# Test Control Endpoints - Управление тестами

## 📋 Overview

API endpoints для управления тестами: отмена, повтор, проверка статуса.

**Base URL:** `/api/v1/manual-test`

---

## 🛑 POST /:id/cancel - Отменить тест

### Описание

Отменяет запущенный или ожидающий тест.

### Endpoint

```http
POST /api/v1/manual-test/{id}/cancel
```

### Authentication

✅ **Required** - Bearer token

### Path Parameters

| Parameter | Type | Required | Description         |
| --------- | ---- | -------- | ------------------- |
| `id`      | UUID | Yes      | ID теста для отмены |

### Response

**Success (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "test-uuid",
    "status": "cancelled",
    "url": "https://example.com",
    "browsers": ["chrome", "firefox"],
    "completed_at": "2024-01-01T12:00:00Z"
  },
  "message": "Test cancelled successfully",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**Error (400 Bad Request):**

```json
{
  "success": false,
  "error": "Cannot cancel completed or failed test"
}
```

**Error (403 Forbidden):**

```json
{
  "success": false,
  "error": "Access denied to this test"
}
```

**Error (404 Not Found):**

```json
{
  "success": false,
  "error": "Test not found"
}
```

### Поведение

1. **Проверка доступа** - Только владелец теста может его отменить
2. **Проверка статуса** - Нельзя отменить завершенный (`completed`) или упавший (`failed`) тест
3. **Обновление БД** - Статус теста меняется на `cancelled`
4. **Очистка очереди:**
   - `waiting/delayed` jobs - удаляются из очереди
   - `active` jobs - продолжают выполнение, но worker проверяет статус в БД и останавливается
5. **WebSocket event** - Отправляется `test:cancelled` event всем подписчикам
6. **Graceful shutdown** - Playwright процессы завершаются корректно (cleanup, close browser)

### Implementation Flow

```
User Request
  ↓
POST /api/v1/manual-test/:id/cancel
  ↓
ManualTestService.cancelTest()
  ↓
1. Check access (userId matches test.user_id)
  ↓
2. Check status (not completed/failed)
  ↓
3. Update DB: status = 'cancelled', completed_at = NOW()
  ↓
4. cancelTestJobs() - для каждого browser:
   - Get job from queue
   - If state = 'waiting'/'delayed' → job.remove()
   - If state = 'active' → worker checks DB and stops
  ↓
5. Emit WebSocket: test:cancelled
  ↓
6. Return updated test
```

### Worker Integration

**File:** `src/jobs/manual-test-run.job.ts`

```typescript
// Worker checks cancellation at multiple points:

// 1. Before starting
if (await this.checkTestCancelled(testId)) {
  throw new TestCancelledError(testId, browser);
}

// 2. After status update
await this.updateTestStatus(testId, 'running', ...);
if (await this.checkTestCancelled(testId)) {
  throw new TestCancelledError(testId, browser);
}

// 3. During execution (via AbortSignal)
orchestrator.abort(); // Stops all operations
```

**File:** `src/agent/intelligent-test-orchestrator.ts`

```typescript
// Orchestrator aborts via AbortController
abort(): void {
  this.abortController.abort(); // Triggers all AbortSignals
  this.commandExecutor.abort(); // Stops CommandExecutor
}
```

**File:** `src/agent/command-executor.ts`

```typescript
// CommandExecutor checks abort before each command
private checkAborted(): void {
  if (this.isAborted) {
    throw new Error('Operation aborted by user');
  }
}
```

### Использование

**cURL:**

```bash
curl -X POST "https://api.qai.so/api/v1/manual-test/{test-id}/cancel" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**JavaScript:**

```javascript
const response = await fetch(`/api/v1/manual-test/${testId}/cancel`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const result = await response.json();
console.log(result.message); // "Test cancelled successfully"
```

---

## 🔁 POST /:id/retry - Повторить тест

### Описание

Повторяет выполнение теста (только для `failed` тестов).

### Endpoint

```http
POST /api/v1/manual-test/{id}/retry
```

### Authentication

✅ **Required** - Bearer token + Credits

### Path Parameters

| Parameter | Type | Required | Description          |
| --------- | ---- | -------- | -------------------- |
| `id`      | UUID | Yes      | ID теста для повтора |

### Credits

**Списание кредитов:**

- Intelligent mode: **20 кредитов** (зависит от исходного режима теста)

### Response

**Success (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "test-uuid",
    "status": "pending",
    "url": "https://example.com",
    "browsers": ["chrome", "firefox"]
  },
  "message": "Test retry initiated successfully",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**Error (400 Bad Request):**

```json
{
  "success": false,
  "error": "Test must be in failed status to retry"
}
```

**Error (402 Payment Required):**

```json
{
  "success": false,
  "error": "Insufficient credits"
}
```

### Поведение

1. **Проверка статуса** - Тест должен быть в статусе `failed`
2. **Проверка кредитов** - Middleware `requireCredits` проверяет баланс
3. **Списание кредитов** - Автоматически списываются при успехе
4. **Создание jobs** - Новые задачи добавляются в очередь для каждого browser
5. **Обновление статуса** - `status = 'pending'`, `started_at = null`, `completed_at = null`
6. **WebSocket event** - Отправляется `test:created` event

### Использование

**cURL:**

```bash
curl -X POST "https://api.qai.so/api/v1/manual-test/{test-id}/retry" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**JavaScript:**

```javascript
const response = await fetch(`/api/v1/manual-test/${testId}/retry`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const result = await response.json();
console.log(result.message); // "Test retry initiated successfully"
```

---

## 📊 GET /:id/status - Проверка статуса

### Описание

Легковесный endpoint для polling - возвращает только статус без полной информации.

### Endpoint

```http
GET /api/v1/manual-test/{id}/status
```

### Authentication

✅ **Required** - Bearer token

### Path Parameters

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `id`      | UUID | Yes      | ID теста    |

### Response

**Success (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "test-uuid",
    "status": "running",
    "progress": 1,
    "totalBrowsers": 3
  },
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Fields

| Field           | Type   | Description                                              |
| --------------- | ------ | -------------------------------------------------------- |
| `id`            | UUID   | ID теста                                                 |
| `status`        | string | `pending`, `running`, `completed`, `failed`, `cancelled` |
| `progress`      | number | Количество завершенных браузеров                         |
| `totalBrowsers` | number | Общее количество браузеров в тесте                       |

### Использование

**Polling Example:**

```javascript
// Poll every 2 seconds
const pollInterval = setInterval(async () => {
  const response = await fetch(`/api/v1/manual-test/${testId}/status`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const { data } = await response.json();

  console.log(
    `Status: ${data.status} (${data.progress}/${data.totalBrowsers})`
  );

  if (
    data.status === "completed" ||
    data.status === "failed" ||
    data.status === "cancelled"
  ) {
    clearInterval(pollInterval);
    console.log("Test finished!");
  }
}, 2000);
```

**WebSocket Alternative:**

```javascript
// Better alternative: Use WebSocket instead of polling
const ws = new WebSocket("wss://api.qai.so");

ws.on("test:progress", (data) => {
  console.log(`Progress: ${data.progress}%`);
});

ws.on("test:completed", (data) => {
  console.log("Test completed!");
});

ws.on("test:cancelled", (data) => {
  console.log("Test cancelled");
});
```

---

## 🔄 Complete Test Lifecycle

```
1. CREATE
   POST /api/v1/manual-test/run
   → status: pending
   → jobs added to queue

2. RUNNING
   Worker starts processing
   → status: running
   → WebSocket: test:started

3a. CANCEL (user action)
   POST /api/v1/manual-test/:id/cancel
   → status: cancelled
   → jobs removed/stopped
   → WebSocket: test:cancelled

3b. COMPLETE (success)
   Worker finishes
   → status: completed
   → WebSocket: test:completed

3c. FAIL (error)
   Worker encounters error
   → status: failed
   → WebSocket: test:failed

4. RETRY (only from failed)
   POST /api/v1/manual-test/:id/retry
   → status: pending
   → back to step 1
```

---

## ✅ Status Summary

| Endpoint      | Method | Auth | Credits    | Swagger | Implemented | Working |
| ------------- | ------ | ---- | ---------- | ------- | ----------- | ------- |
| `/:id/cancel` | POST   | ✅   | No         | ✅      | ✅          | ✅      |
| `/:id/retry`  | POST   | ✅   | Yes (1-20) | ✅      | ✅          | ✅      |
| `/:id/status` | GET    | ✅   | No         | ✅      | ✅          | ✅      |

### Integration Points

- ✅ **Worker** - `ManualTestRunJobHandler.checkTestCancelled()`
- ✅ **Orchestrator** - `IntelligentTestOrchestrator.abort()`
- ✅ **CommandExecutor** - `CommandExecutor.checkAborted()`
- ✅ **WebSocket** - `webSocketService.emitTestCancelled()`
- ✅ **Queue** - `testRunQueue.getJob()`, `job.remove()`

### Testing

```bash
# 1. Start a test
TEST_ID=$(curl -X POST "http://localhost:3000/api/v1/manual-test/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "browsers": ["chrome"],
    "projectId": "project-uuid"
  }' | jq -r '.data.id')

# 2. Check status
curl "http://localhost:3000/api/v1/manual-test/$TEST_ID/status" \
  -H "Authorization: Bearer $TOKEN"

# 3. Cancel test
curl -X POST "http://localhost:3000/api/v1/manual-test/$TEST_ID/cancel" \
  -H "Authorization: Bearer $TOKEN"

# 4. Verify cancelled
curl "http://localhost:3000/api/v1/manual-test/$TEST_ID/status" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🎯 Conclusion

**Все endpoints работают и документированы в Swagger!** ✅

- ✅ Cancel - останавливает тесты gracefully
- ✅ Retry - перезапускает failed тесты
- ✅ Status - легковесный polling endpoint
- ✅ Swagger документация добавлена
- ✅ Integration с Worker/Orchestrator/CommandExecutor
- ✅ WebSocket notifications

**Рекомендация:** Использовать WebSocket для real-time updates вместо polling `/status`.
