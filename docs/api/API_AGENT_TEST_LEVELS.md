# 🧪 API Agent тесты по уровням (LIGHT / MEDIUM / HARD)

Этот документ описывает, **как у нас работает API тестирование “агентом”** и чем отличаются уровни `light`, `medium`, `hard`.

## TL;DR (чем уровни реально отличаются)

Источник правды: `src/services/testing/api/agent/api-agent-policy.ts`

| Level | Baseline credits | Budget (steps / seconds / aiTokens) | Novelty stop threshold | Mutations | Fuzzing | Race probing | Retry on high-risk |
|------:|------------------:|--------------------------------------|------------------------:|----------:|--------:|-------------:|-------------------:|
| light | 2  | 8 / 60s / 5k  | 0.5 | ❌ | ❌ | ❌ | 0 |
| medium| 6  | 20 / 180s / 15k | 0.3 | ✅ (с safety gates) | ❌ | ❌ | 0 |
| hard  | 12 | 35 / 300s / 30k | 0.1 | ✅ | ✅ | ✅ (но не на prod-host) | 4 (итого до 5 попыток) |

Ключевая идея:
- **`light`**: быстро проверить, что “happy path” работает + базовый контракт.
- **`medium`**: добавить негативные кейсы/бизнес-валидацию/consistency и осторожные мутации.
- **`hard`**: максимально исследовать, включая security/fuzzing и повторные атаки при 5xx/timeout.

## Где это запускается (entry points)

### 1) Агентский флоу (уровни LIGHT/MEDIUM/HARD)

- Вход: `src/api/chat/api_test/handler.ts`
- Если `parsedIntent.agentLevel` валидный → сразу в агент:
  - `src/api/chat/api_test/agent-execution.ts` → `executeApiAgentTestFlow()`
  - дальше `ApiAgentOrchestratorService.run()`

### 2) Legacy API test (без уровней)

Если `agentLevel` не передан, включается “план → подтверждение → выполнение”:
- План генерится в `handleApiTest()` (через `ApiTestPlanService`)
- Исполнение после подтверждения — `src/api/chat/api_test/execution.ts` (`executeApiTestFlow`)

Важно: **legacy fuzzing отключён** (коммент: “moved to API Agent HARD level”).

## Контракт (что приходит/уходит)

### Request в агента

Тип: `ApiAgentRequest` (`src/services/testing/api/agent/api-agent.types.ts`)

Минимально нужно:
- `level`: `'light' | 'medium' | 'hard'`
- `url`, `method`
- `userId`

Опционально:
- `headers`, `body`
- `expectedStatus` (для happy-path ожидания, default 200)
- `chatSessionId` (для WebSocket стрима)
- `userMessage` (текст интента пользователя; влияет на AI-планирование)
- `budgetOverrides` (точечные оверрайды бюджета)

### Response из агента (HTTP)

Отдаём:
- `success`
- `reply` (форматированный текст)
- `summary` (агрегированный итог)
- `testId`, `sessionId`

Сохранение в БД делается внутри `executeApiAgentTestFlow()` через `ApiTestStorageService.saveApiTestExecution()`
и кладёт `metadata` с summary + trace pointer.

## Основной execution loop (как агент работает)

Источник: `src/services/testing/api/agent/api-agent-orchestrator.service.ts`

Высокоуровнево цикл выглядит так:

1) **Budget/stop checks** (каждая итерация):
   - лимит шагов / времени / токенов
   - novelty ниже порога (после 3 шагов)
   - для `light`: если happy-path сломался → `contract_broken` и стоп

2) **Planning (think)**:
   - сначала rule-based (дешево), потом AI-based (дороже) через `ApiAgentPlannerService`

3) **Executing (do)**:
   - один HTTP шаг выполняет `ApiAgentStepExecutorService.executeStep()`
   - для `hard` может выполняться `executeStepWithRetry()` при high-risk сигнале (5xx/timeout)

4) **Observing (observe)**:
   - анализ результата → findings
   - обновление state: novelty, inferred schema, discovered methods, known IDs, error signatures

5) **WebSocket стрим в UI** (детали ниже)

## Планирование шагов (planner)

Источник: `src/services/testing/api/agent/api-agent-planner.service.ts`

### Rule-based “стартовый сценарий”

1) Шаг 0 всегда `happy_path`:
- `description`: “Execute {method} {url} …”
- `expectedOutcome`: “Expect {expectedStatus||200} response”

2) Дальше `method_contract` шаги:
- проверяем остальные методы из `GET/POST/PUT/DELETE/PATCH`
- ожидаем `405` или `4xx`
- если вдруг метод “неожиданно работает” (2xx) — это не ошибка, а **capability discovered** (findings `info`)

3) Для `light` после `happy_path + method_contract` — планировщик возвращает `shouldStop=true` и run завершается.

### AI-based planning (MEDIUM/HARD)

Если rule-based шаги закончились — вызывается AI, который возвращает JSON (response_format=`json_object`).

Поля, на которые AI ориентируется:
- endpoint (url/method)
- `userMessage` (интент юзера)
- последние шаги и findings
- discovered methods / known IDs / schema inferred
- allowed step types для уровня

## Что именно проверяет executor (findings)

Источник: `src/services/testing/api/agent/api-agent-step-executor.service.ts`

На каждый HTTP ответ формируются findings, например:

- **5xx** → `server_error` (high/medium)
- **method_contract**:
  - 2xx на “запрещённый метод” → `capability_discovered` (info)
  - странная ситуация “не 405 и не 4xx” → `contract_violation` (low)
- **negative_case**:
  - если негативный кейс “внезапно успешен” (2xx) → `validation_bypass` (medium)
- **schema_validation / happy_path**:
  - `content-type: application/json`, но body невалидный JSON → `schema_mismatch` (medium)
  - пустой body → `schema_mismatch` (low)
- **401/403** (если это не `auth_bypass`) → `auth_issue` (happy_path = high, иначе info)
- **slow responses** (> 5s) → `performance_anomaly`
- **429** → `rate_limit_issue` (info)

## Safety gates (ограничения “не ломать прод”)

Источник: `src/services/testing/api/agent/api-agent-policy.ts` (`checkSafetyGate`)

Гейты применяются до исполнения шага (на этапе парсинга AI решения):
- **Mutations** (`POST/PUT/PATCH/DELETE`) запрещены на `light`, а на `medium` блокируются на “production-looking host”.
- **Mutation step types** (`crud_chain`, `race_probe`) требуют `allowMutations=true`.
- **Fuzzing step types** (`fuzzing`, `auth_bypass`) требуют `allowFuzzing=true`.
- **race_probe**:
  - требует `allowRaceProbing=true`
  - даже в `hard` блокируется на “production-looking host”

Если шаг заблокирован — planner не останавливает run, а “пропускает” шаг и пробует планировать дальше.

## Retrying (только HARD)

Источник: `ApiAgentStepExecutorService.executeStepWithRetry()`

High-risk сигнал = `5xx` или timeout/нет ответа.

- 1-я попытка + до `maxRetryOnHighRisk` повторов (в `hard` это 4) → всего до 5 попыток.
- Все попытки помечаются единым correlation id (`x-qai-correlation-id`) для диагностики.
- Если после всех повторов high-risk сохраняется, добавляется finding “Consistent server error across retries”.

## Когда тест “успешен”

Высокоуровневая логика:
- `summary.success` вычисляется как “happy-path отработал” (`hasSuccessfulHappyPath`) + не накопили критических проблем (зависит от итоговой агрегации).
- `light` может остановиться раньше при `contract_broken`.

## WebSocket: как UI получает шаги

Тип события: `api:agent:step`  
Payload: `ApiAgentStepPayload` (`src/websocket/types/types.ts`)

Ключевые поля для фронта:
- `runId`, `stepIndex`
- `stage`: `planning` → `executing` → `completed`
- `description` (человекочитаемый заголовок)
- `expectedOutcome` (то, что UI должен показать как assertion/expectation)
- `reasoning` (в planning)
- `request` (в executing; есть `bodyPreview`, `correlationId` при retries)
- `response` + `durationMs` (в completed)
- `findingsCount` + `findings[]` (в completed)
- `shouldStop` **есть в типе**, но в текущей реализации **финальный stop-step не эмитится**: когда planner решает остановиться, run просто завершается.

Дополнительно UI получает прогресс через `chat:processing:step` (progress 0..100).

## Trace logs (для дебага)

Источник: `src/services/testing/api/agent/api-agent-trace.service.ts`

Пишется JSONL trace (через `LiteTraceWriter`) и при валидном `userId` грузится в storage (`lite-trace-logs`).
В `summary.traceLogPath` сохраняется ссылка на лог.

---

[← Назад к API документации](./README.md)

