# API: создание теста из тикета Jira (асинхронный поток)

Инструкция для frontend: как использовать новый поток «тест из Jira» после изменений на backend.

---

## Обзор

Раньше (если был такой сценарий): один запрос сразу создавал intent test case.  
**Теперь:** один запрос принимается, возвращается **200 + runId**, а создание теста (UI или API) выполняется **в фоне**. Результат узнаётся по **runId** через polling (или в будущем SSE).

Тип теста (WEB_UI или API) и входные данные определяются на backend по тикету и Knowledge Base; frontend только инициирует запуск и опрашивает статус.

---

## 1. Запуск создания теста из Jira

**Метод и URL:**  
`POST /api/v1/preview/intent-test-cases/from-jira`

**Авторизация:** Bearer-токен (как обычно).

**Заголовки:**
- `Content-Type: application/json`
- `Accept-Language: en | ru | kk` — язык сообщений об ошибках (и при необходимости статусов). Необязательно, по умолчанию `en`.

**Тело запроса (JSON):**
```json
{
  "issueKey": "PROJ-123",
  "projectId": "uuid-проекта",
  "cloudId": "опционально, если несколько Jira-подключений",
  "ticket": {
    "summary": "Название тикета",
    "description": "Описание в тексте или HTML/ADF (опционально)"
  }
}
```

- **Рекомендуемый способ:** передавать объект **`ticket`** с полями **`summary`** и при необходимости **`description`**. В этом случае backend **не обращается к Atlassian API** — данные тикета берутся только из запроса. Это избавляет от ошибок 401/403 и зависимости от доступности Jira при создании теста.
- Если **`ticket`** не передан или в нём нет непустого **`summary`**, backend по-прежнему запрашивает тикет через Jira API (нужно подключение Jira и возможны ошибки Atlassian).

**Успешный ответ (200):**
```json
{
  "accepted": true,
  "runId": "uuid-run",
  "statusUrl": "/api/v1/preview/jira-runs/uuid-run"
}
```

После этого нужно показывать пользователю, что запрос принят, и перейти к опросу статуса по `runId` (см. п. 2).

**Ошибки (4xx/5xx):**

Тело ответа при ошибке всегда в формате:
```json
{
  "error": {
    "title": "Краткий заголовок ошибки",
    "message": "Подробное сообщение"
  }
}
```

Примеры:
- **400** — нет или неверный `issueKey` / `projectId` → `error.title` и `error.message` по выбранному языку.
- **401** — не авторизован.
- **403** — Jira не подключена для пользователя (`error.message` про отсутствие подключения).
- **404** — тикет не найден в Jira.
- **500** — любая внутренняя ошибка (Jira недоступна, анализ не прошёл и т.д.) — показывать `error.title` и `error.message`.

На frontend достаточно один раз реализовать отображение `error.title` и `error.message` для всех этих кодов.

---

## 2. Получение статуса запуска (polling)

**Метод и URL:**  
`GET /api/v1/preview/jira-runs/:runId`

**Авторизация:** Bearer-токен.

**Параметры пути:**
- `runId` — значение из ответа `POST from-jira` (поле `runId`).

**Успешный ответ (200):**
```json
{
  "runId": "uuid-run",
  "status": "queued | running | completed | failed"
}
```

Дополнительно в зависимости от `status`:

- **completed**
  - Либо UI-тест создан — появляется ссылка на intent test case:
    ```json
    {
      "runId": "...",
      "status": "completed",
      "result": {
        "intentTestCaseId": "uuid-intent-test-case"
      }
    }
    ```
  - Либо API-тест создан — ссылка на api test config:
    ```json
    {
      "runId": "...",
      "status": "completed",
      "result": {
        "apiTestConfigId": "uuid-api-test-config"
      }
    }
    ```
  Действия на frontend: перенаправить/открыть соответствующий редактор (intent test case или API test config) по полученному id.

- **failed** (при WEB_UI в ответе может быть и `result.intentTestCaseId` — сохранённые шаги до падения):
  ```json
  {
    "runId": "...",
    "status": "failed",
    "error": { "title": "...", "message": "..." },
    "result": { "intentTestCaseId": "uuid" }
  }
  ```
  Показывать `error.title` и `error.message`; при наличии `result.intentTestCaseId` дать ссылку «Открыть сохранённые шаги».

**Где лежат сохранённые шаги (WEB_UI):** не в manual-test. Шаги сохраняются в **intent test case**. По `result.intentTestCaseId` нужно запрашивать **`GET /api/v1/preview/intent-test-cases/:intentTestCaseId`** — в ответе будет тест-кейс с полем `stepsJson` (массив шагов). Эндпоинт `GET /api/v1/manual-test/:testId/full` отдаёт данные **прогона** теста (testId — id из таблицы tests); там есть `intelligentSession` и т.д., но «официальные» сохранённые шаги из Jira-флоу — в intent test case по `result.intentTestCaseId`.

**Ошибки:**
- **401** — не авторизован.
- **404** — run не найден или нет доступа → тело в том же формате `{ "error": { "title", "message" } }`.
- **500** — серверная ошибка.

---

## 3. Рекомендуемый UX на frontend

1. **Кнопка/действие** «Создать тест из Jira» (или из тикета) → вызов `POST /api/v1/preview/intent-test-cases/from-jira` с выбранным `issueKey` и `projectId`.
2. При **200**:
   - Показать сообщение вида «Запрос принят, создаём тест…».
   - Сохранить `runId`, начать polling: `GET /api/v1/preview/jira-runs/:runId` каждые 2–3 секунды (или с экспоненциальным backoff, но не чаще 1 раза в секунду).
3. При **status: completed**:
   - Если есть `result.intentTestCaseId` — переход/открытие редактора intent test case по этому id.
   - Если есть `result.apiTestConfigId` — переход/открытие конфигурации API-теста по этому id.
   - Остановить polling.
4. При **status: failed**:
   - Показать `error.title` и `error.message`, остановить polling.
5. Пока **queued** или **running** — показывать индикатор загрузки/статус («В очереди» / «Выполняется…»).
6. Таймаут: например, через 5–10 минут считать run «зависшим» и предложить обновить страницу или повторить; при этом polling можно остановить.

Опционально: передавать в запрос заголовок `Accept-Language` (en / ru / kk), чтобы сообщения об ошибках и при необходимости статусы приходили на нужном языке.

---

## 4. Изменения на клиенте (React): передача данных тикета в payload

Чтобы избежать ошибок Atlassian (401/403) и не вызывать Jira API на backend, **рекомендуется передавать данные тикета с клиента**.

### 4.1 Откуда взять данные тикета на frontend

- Если у вас уже есть экран/модалка выбора тикета Jira: при выборе тикета вы получаете (из своего API или из Jira REST/клиента) как минимум **summary** и при необходимости **description**.
- Если тикет открыт на отдельной странице: при загрузке страницы тикета запросите у своего backend или напрямую у Jira (с фронта, если есть CORS/прокси) поля `summary` и `description` и сохраните их в state (например React state или контекст).
- Формат **description**: backend принимает строку. Если в Jira приходит ADF/HTML, можно передавать как есть или конвертировать в plain text на клиенте — анализ на backend умеет работать с текстом.

### 4.2 Что отправлять в POST from-jira

При вызове `POST /api/v1/preview/intent-test-cases/from-jira` передавайте в теле запроса объект **`ticket`**:

```ts
interface FromJiraRequestBody {
  issueKey: string;   // например "PROJ-123"
  projectId: string;  // uuid проекта в вашем приложении
  cloudId?: string;   // опционально
  ticket?: {
    summary: string;           // обязательно, если передаёте ticket
    description?: string | null;
  };
}
```

Пример тела запроса с тикетом из клиента:

```json
{
  "issueKey": "PROJ-123",
  "projectId": "a1b2c3d4-...",
  "ticket": {
    "summary": "As a user I want to log in via SSO",
    "description": "Steps: 1. Open login page..."
  }
}
```

### 4.3 Пример вызова из React

```tsx
// Где у вас есть данные выбранного тикета (например из Jira picker или страницы тикета)
const selectedIssue = {
  key: 'PROJ-123',
  summary: 'As a user I want to log in via SSO',
  description: 'Steps: 1. Open login page...', // или null
};

const runFromJira = async () => {
  setLoading(true);
  try {
    const res = await fetch('/api/v1/preview/intent-test-cases/from-jira', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept-Language': 'ru',
      },
      body: JSON.stringify({
        issueKey: selectedIssue.key,
        projectId: currentProjectId,
        ticket: {
          summary: selectedIssue.summary,
          description: selectedIssue.description ?? null,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error?.message ?? 'Error');
      return;
    }
    setRunId(data.runId);
    startPolling(data.runId);
  } finally {
    setLoading(false);
  }
};
```

### 4.4 Поведение backend

| Передано с клиента | Поведение backend |
|--------------------|--------------------|
| `ticket` с непустым `summary` | Данные тикета берутся только из запроса, **запрос к Atlassian не выполняется**. Подключение Jira не требуется для этого запроса. |
| `ticket` не передан или `summary` пустой | Как раньше: backend вызывает Jira API (нужен подключённый Jira и возможны 401/403). |

Итого: на клиенте при выборе/открытии тикета сохраняйте `summary` и при необходимости `description`, и передавайте их в поле **`ticket`** при вызове **from-jira**. Так вы избегаете ошибок, связанных с Atlassian, на backend.

---

## 5. Краткая сводка контракта

| Действие              | Метод | URL                                                    | Ответ 200 / результат |
|-----------------------|-------|--------------------------------------------------------|------------------------|
| Запустить из Jira     | POST  | `/api/v1/preview/intent-test-cases/from-jira`          | `{ accepted, runId, statusUrl }` |
| Узнать статус по runId| GET   | `/api/v1/preview/jira-runs/:runId`                     | `{ runId, status, result?, error? }` |

- Ошибки везде: `{ "error": { "title": "...", "message": "..." } }`.
- Язык: заголовок `Accept-Language: en | ru | kk` (по желанию).

Если у frontend появятся вопросы по полям или сценариям — можно уточнять по этому документу и актуальному коду backend (preview.controller, jira-test-run.service, jira-from-ticket.job).
