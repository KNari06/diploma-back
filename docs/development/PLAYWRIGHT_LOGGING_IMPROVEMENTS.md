# Playwright Testing Flow - Детальное логирование

**Date Created:** 2024-11-21
**Status:** ✅ Implemented
**Purpose:** Comprehensive error logging across the entire Playwright testing flow

---

## 🎯 Цель

Добавить детальные логи с full stack traces и контекстом на **каждый** этап Playwright testing flow, чтобы:
1. Быстро диагностировать причину падения тестов
2. Понять на каком этапе происходит сбой
3. Получать полную информацию об ошибках (не только message, но и stack + context)

---

## 📊 Улучшенные компоненты

### 1. **Logger Configuration** (`src/utils/logger.ts`)

**Проблема:** Winston console output не выводил `error.stack` и metadata.

**Исправление:**
- Добавлен `winston.format.errors({ stack: true })` для извлечения stack trace
- Улучшен `printf` формат:
  ```typescript
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, ...meta } = info;
    let logMessage = `${timestamp} ${level}: ${message}`;

    // Append stack trace
    if (stack) logMessage += `\n${stack}`;

    // Append metadata (JSON)
    if (Object.keys(meta).length > 0) {
      logMessage += `\n${JSON.stringify(meta, null, 2)}`;
    }

    return logMessage;
  })
  ```

**Результат:** Теперь все ошибки выводятся с полным stack trace + context объектами.

---

### 2. **Worker** (`src/worker/index.ts`)

**Добавлено:**
- ✅ Логирование старта job с полным контекстом
- ✅ Логирование успешного завершения с длительностью
- ✅ Детальное логирование ошибок с:
  - `testId`, `url`, `browser`, `intelligentMode`
  - `retryCount`, `jobAttempts`
  - `duration` (сколько работал job)
  - `error.message`, `error.name`, `error.stack`

**Пример лога:**
```
info: [TEST_RUN_WORKER] 🔄 Processing job: abc-123
{
  "testId": "test-456",
  "url": "https://repetino.kz",
  "browser": "chrome",
  "intelligentMode": true,
  "retryCount": 0,
  "jobAttempts": 1
}

error: [TEST_RUN_WORKER] ❌ Job failed: abc-123
APIConnectionTimeoutError: Request timed out after 60000ms
    at OpenAI.chat.completions.create (...)
{
  "testId": "test-456",
  "url": "https://repetino.kz",
  "browser": "chrome",
  "duration": "61243ms",
  "error": {
    "message": "Request timed out after 60000ms",
    "name": "APIConnectionTimeoutError",
    "stack": "..."
  }
}
```

---

### 3. **Test Run Job Handler** (`src/jobs/manual-test-run.job.ts`)

**Добавлено:**
- ✅ Детальное логирование ошибок выполнения теста с:
  - `testId`, `browser`, `url`
  - `intelligentMode`, `testGoal`
  - `retryAttempt`, `maxRetries`
  - `error.message`, `error.name`, `error.stack`

---

### 4. **Playwright Service** (`src/agent/playwright.service.ts`)

**Добавлено:**
- ✅ Детальное логирование ошибок с:
  - `testId`, `browser`, `url`
  - `intelligentMode`
  - `error.message`, `error.name`, `error.stack`

**Retry Logic (`executePlaywrightTestWithRetry`):**
- ✅ Логирование старта retry flow
- ✅ Логирование каждой попытки (attempt 1, 2, 3...)
- ✅ Логирование успеха после retry
- ✅ Детальное логирование финальной ошибки после всех попыток

**Пример лога:**
```
info: [PLAYWRIGHT_RETRY] Starting test with retry logic
{
  "testId": "test-456",
  "url": "https://repetino.kz",
  "browser": "chrome",
  "intelligentMode": true,
  "maxRetries": 2
}

warn: [PLAYWRIGHT_RETRY] Test attempt threw exception
{
  "testId": "test-456",
  "attempt": 1,
  "url": "https://repetino.kz",
  "browser": "chrome",
  "error": {
    "message": "Timeout navigating to https://repetino.kz",
    "name": "TimeoutError",
    "stack": "..."
  }
}

info: [PLAYWRIGHT_RETRY] Retrying Playwright test
{
  "testId": "test-456",
  "attempt": 1,
  "maxRetries": 2,
  "retryDelay": "2000ms",
  "lastError": "Timeout navigating to https://repetino.kz"
}
```

---

### 5. **Intelligent Test Orchestrator** (`src/agent/intelligent-test-orchestrator.ts`)

**Добавлено:**
- ✅ Логирование старта main loop
- ✅ Логирование каждой итерации loop с:
  - `iteration` number
  - `pagesVisited`, `actionsCompleted`
  - `currentUrl`
- ✅ Детальное логирование ошибок loop iteration с:
  - `testId`, `iteration`, `currentUrl`
  - `pagesVisited`, `actionsCompleted`, `errorCount`
  - `error.stack`
- ✅ Логирование "too many errors" с последними 3 ошибками
- ✅ Детальное логирование ошибок action execution:
  - `action.type`, `action.description`, `action.selector`
  - `optional` flag
  - Логирование "Required action failed, stopping" vs "Optional action failed, continuing"

**Пример лога:**
```
info: [INTELLIGENT_ORCHESTRATOR] Starting main test loop
{
  "testId": "test-456",
  "goal": "Test registration form",
  "mode": "balanced"
}

info: [INTELLIGENT_ORCHESTRATOR] Loop iteration 1
{
  "testId": "test-456",
  "pagesVisited": 0,
  "actionsCompleted": 0,
  "currentUrl": "https://repetino.kz"
}

error: [INTELLIGENT_ORCHESTRATOR] Action execution error
{
  "testId": "test-456",
  "action": {
    "type": "click",
    "description": "Click register button",
    "selector": "#register-btn",
    "optional": false
  },
  "currentUrl": "https://repetino.kz/register",
  "error": {
    "message": "Element not found: #register-btn",
    "name": "PlaywrightError",
    "stack": "..."
  }
}

error: [INTELLIGENT_ORCHESTRATOR] Required action failed, stopping
{
  "testId": "test-456",
  "action": "Click register button"
}
```

---

### 6. **Intelligent Page Analyzer** (`src/agent/intelligent-page-analyzer.ts`)

**Добавлено:**
- ✅ OpenAI API timeout: `60000ms` (было: 10 минут!)
- ✅ OpenAI API `maxRetries`: `2`
- ✅ Логирование каждого этапа анализа:
  - Screenshot & DOM capture (start + completed with sizes)
  - Vision analysis (start + completed with duration)
  - Logic analysis (start + completed with duration)
- ✅ Детальное логирование ошибок с:
  - `url`
  - `error.message`, `error.name`, `error.stack`

**Пример лога:**
```
info: [INTELLIGENT_ANALYZER] Starting parallel screenshot & DOM capture
{
  "url": "https://repetino.kz"
}

info: [INTELLIGENT_ANALYZER] Screenshot & DOM captured successfully
{
  "url": "https://repetino.kz",
  "screenshotSize": "245KB",
  "domElementsCount": {
    "forms": 2,
    "buttons": 15,
    "links": 30,
    "inputs": 8
  }
}

info: [INTELLIGENT_ANALYZER] Using GPT-4 Vision for analysis
{
  "url": "https://repetino.kz"
}

info: [INTELLIGENT_ANALYZER] Vision analysis completed
{
  "url": "https://repetino.kz",
  "duration": "2345ms",
  "pageType": "homepage",
  "elementsFound": 23
}
```

---

### 7. **Contextual Action Generator** (`src/agent/contextual-action-generator.ts`)

**Добавлено:**
- ✅ OpenAI API timeout: `60000ms`
- ✅ OpenAI API `maxRetries`: `2`

---

### 8. **Command Executor** (`src/agent/command-executor.ts`)

**Добавлено:**
- ✅ Детальное логирование ошибок команд с:
  - `action`, `selector`, `value`, `url`
  - `timeout`, `description`
  - `currentUrl` (где мы находимся сейчас)
  - `error.message`, `error.name`, `error.stack`
- ✅ Логирование "Command execution stopped" vs "continuing despite error"
- ✅ Контекст выполнения batch команд:
  - `command.index`, `totalCommands`

**Пример лога:**
```
error: [COMMAND_EXECUTOR] Command execution failed: click
{
  "action": "click",
  "selector": "#submit-btn",
  "description": "Submit registration form",
  "currentUrl": "https://repetino.kz/register",
  "error": {
    "message": "Timeout 30000ms exceeded",
    "name": "TimeoutError",
    "stack": "..."
  }
}

error: [COMMAND_EXECUTOR] Command execution stopped due to error
{
  "command": {
    "action": "click",
    "selector": "#submit-btn",
    "description": "Submit registration form",
    "index": 3
  },
  "totalCommands": 5,
  "currentUrl": "https://repetino.kz/register",
  "error": {
    "message": "Timeout 30000ms exceeded",
    "name": "TimeoutError",
    "stack": "..."
  }
}
```

---

## 🔍 Типичные сценарии ошибок и их логи

### Сценарий 1: OpenAI API Timeout

**До:**
```
error: Playwright test failed
```

**После:**
```
info: [INTELLIGENT_ANALYZER] Using GPT-4 Vision for analysis { url: "https://repetino.kz" }

error: [INTELLIGENT_ANALYZER] Page analysis failed
APIConnectionTimeoutError: Request timed out after 60000ms
    at OpenAI.chat.completions.create (/app/node_modules/openai/...)
    at IntelligentPageAnalyzer.analyzeWithVision (/app/src/agent/intelligent-page-analyzer.ts:268)
{
  "url": "https://repetino.kz",
  "error": {
    "message": "Request timed out after 60000ms",
    "name": "APIConnectionTimeoutError",
    "stack": "..."
  }
}

error: [INTELLIGENT_ORCHESTRATOR] Loop iteration failed
{
  "testId": "test-456",
  "iteration": 1,
  "currentUrl": "https://repetino.kz",
  "pagesVisited": 0,
  "error": {
    "message": "Request timed out after 60000ms",
    "name": "APIConnectionTimeoutError",
    "stack": "..."
  }
}

error: [PLAYWRIGHT_RETRY] Test failed after all retries
{
  "testId": "test-456",
  "maxRetries": 2,
  "totalAttempts": 3,
  "lastError": {
    "message": "Request timed out after 60000ms",
    "stack": "..."
  }
}
```

---

### Сценарий 2: Element Not Found

**После:**
```
error: [COMMAND_EXECUTOR] Command execution failed: click
{
  "action": "click",
  "selector": "#register-button",
  "currentUrl": "https://repetino.kz/signup",
  "error": {
    "message": "Element not found: #register-button",
    "name": "PlaywrightError",
    "stack": "..."
  }
}

error: [INTELLIGENT_ORCHESTRATOR] Action execution error
{
  "testId": "test-456",
  "action": {
    "type": "click",
    "description": "Click register button",
    "selector": "#register-button",
    "optional": false
  },
  "error": { ... }
}

error: [INTELLIGENT_ORCHESTRATOR] Required action failed, stopping
```

---

## 📚 Best Practices

### 1. **Всегда логируй error.stack**
```typescript
error: error instanceof Error ? {
  message: error.message,
  name: error.name,
  stack: error.stack,
} : String(error)
```

### 2. **Добавляй контекст**
```typescript
logger.error('[MODULE] Operation failed', {
  testId,
  url,
  browser,
  currentStep,
  error: { ... },
});
```

### 3. **Логируй длительность операций**
```typescript
const startTime = Date.now();
// ... operation ...
const duration = Date.now() - startTime;
logger.info('[MODULE] Operation completed', { duration: `${duration}ms` });
```

### 4. **Используй префиксы**
- `[PLAYWRIGHT]` - основной playwright service
- `[PLAYWRIGHT_RETRY]` - retry logic
- `[INTELLIGENT_ORCHESTRATOR]` - main test loop
- `[INTELLIGENT_ANALYZER]` - page analysis
- `[COMMAND_EXECUTOR]` - command execution
- `[TEST_RUN_WORKER]` - queue worker
- `[TEST-RUN]` - job handler

---

## 🔗 Связанные файлы

- `src/utils/logger.ts` - Winston logger configuration
- `src/worker/index.ts` - BullMQ worker
- `src/jobs/manual-test-run.job.ts` - Test run job handler
- `src/agent/playwright.service.ts` - Playwright test execution
- `src/agent/intelligent-test-orchestrator.ts` - Intelligent test orchestration
- `src/agent/intelligent-page-analyzer.ts` - Page analysis
- `src/agent/contextual-action-generator.ts` - Action generation
- `src/agent/command-executor.ts` - Command execution

---

**Last Updated:** 2024-11-21
**Version:** 1.0
**Status:** ✅ Production Ready
