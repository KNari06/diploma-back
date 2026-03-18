# Как на фронте подтягивать регрессионные runs (включая webhook)

Чтобы на странице Regressions карточки планов показывали последний run (или "Never run"), фронт должен загружать и планы, и runs по **одному и тому же projectId**, и сопоставлять их по `planId`.

## 1. Откуда брать projectId

- Обычно страница Regressions открыта в контексте **текущего проекта** или **workspace**.
- Нужен один или несколько `projectId`, для которых показываются планы. Например:
  - из роута: `/regressions?projectId=...` или из контекста текущего проекта;
  - или список проектов workspace, тогда для каждого проекта свой запрос runs (см. ниже).

## 2. Загрузка планов

**Запрос:**

```http
GET /api/v1/regression-plans?projectId=<uuid>
Authorization: Bearer <token>
```

**Ответ:** `{ success: true, data: Plan[] }`. У каждого плана есть `id`, `name`, `projectId` и т.д.

- Планы привязаны к проекту: один запрос на один `projectId`.
- Если на странице планы из одного проекта — один раз вызываете этот endpoint с его `projectId`.

## 3. Загрузка runs (обязательно для "Last run" / "Never run")

**Запрос:**

```http
GET /api/v1/regression/runs?projectId=<uuid>
Authorization: Bearer <token>
```

**Ответ:** `{ success: true, data: Run[] }`. Каждый элемент:

| Поле        | Тип     | Описание |
|------------|---------|----------|
| `id`       | string  | ID run |
| `planId`   | string  | ID плана (для сопоставления с карточкой) |
| `planName` | string  | Название плана |
| `projectId`| string  | ID проекта |
| `status`   | string  | `passed` \| `failed` \| `running` \| `pending` \| `cancelled` |
| `trigger`  | string  | `manual` \| `chat` \| `scheduled` \| `webhook` |
| `startedAt`| string  | ISO дата старта |
| `completedAt` | string \| null | ISO дата завершения |
| `durationMs`  | number \| null | Длительность в мс |
| `passRate` | number  | 0–100 |
| `stats`    | object  | `{ total, passed, failed, skipped, pending, running, cancelled }` |
| `bugsFound`| number  | Количество багов |

- Runs отсортированы по `started_at` по убыванию (последние первые).
- В список попадают в том числе runs, запущенные по **webhook** (`trigger: 'webhook'`).
- Доступ проверяется по workspace: видят все участники workspace проекта, не только владелец.

## 4. Как показать на карточке плана "Never run" или последний run

1. Иметь список планов (из шага 2) и список runs (из шага 3) для **того же** `projectId`.
2. Для каждого плана с `plan.id`:
   - взять runs: `runs.filter(r => r.planId === plan.id)` (или `r.plan_id` в зависимости от контракта);
   - если массив пустой → показывать **"Never run"**;
   - иначе взять первый элемент (он уже последний по времени) → показать его `status`, `startedAt`, `trigger`, `passRate`, `stats` и т.д.

Пример (псевдокод):

```js
// Загрузить для текущего проекта
const projectId = currentProject.id;
const [plansRes, runsRes] = await Promise.all([
  api.get(`/api/v1/regression-plans?projectId=${projectId}`),
  api.get(`/api/v1/regression/runs?projectId=${projectId}`),
]);
const plans = plansRes.data.data;
const runs = runsRes.data.data;

// Для каждой карточки плана — последний run
const lastRunByPlanId = {};
for (const run of runs) {
  const pid = run.planId || run.plan_id;
  if (pid && !lastRunByPlanId[pid]) lastRunByPlanId[pid] = run;
}

// В рендере
plans.forEach(plan => {
  const lastRun = lastRunByPlanId[plan.id];
  // lastRun === undefined → "Never run"
  // иначе: lastRun.status, lastRun.startedAt, lastRun.trigger, lastRun.stats, ...
});
```

## 5. Несколько проектов на одной странице

Если страница показывает планы из нескольких проектов (например, все проекты workspace):

- Планы обычно приходят с указанием `projectId` у каждого плана.
- Собрать уникальные `projectId` и для каждого вызвать:
  - `GET /api/v1/regression/runs?projectId=<id>`.
- Дальше так же: для каждого плана искать в runs соответствующего проекта последний run по `planId`.

## 6. Обновление в реальном времени (WebSocket)

При запуске run (вручную или по webhook) бэкенд шлёт события:

- Событие: `regression:run:progress`.
- В payload есть `runId`, `planId`, `projectId`, `status`, `progress`, `trigger` и др.

Фронт может:

- подписаться на `regression:run:progress` (по подключению к WS с тем же токеном);
- при получении события обновлять состояние run (например, добавить/обновить run в списке и пересчитать последний run по `planId`);
- опционально при `status: 'completed' | 'failed' | 'cancelled'` перезапросить `GET /api/v1/regression/runs?projectId=...` для актуальных итогов.

## 7. Частые причины "не подтягиваются"

- **Не вызывается** `GET /api/v1/regression/runs?projectId=...` — без него на карточках нечего показывать, будет "Never run".
- **Другой projectId**: runs запрашиваются с одним `projectId`, а планы отображаются для другого — нужен один и тот же проект.
- **Кэш**: после webhook-run обновлять список runs (повторный запрос или обновление из WS), иначе старые данные без нового run.

Итог: для страницы Regressions по текущему проекту обязательно вызывать оба запроса с одним и тем же `projectId` (планы + runs) и выводить последний run по `planId` для каждой карточки плана.
