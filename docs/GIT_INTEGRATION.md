# Git Integration: архитектура и webhook

Документация по интеграции с GitHub и GitLab: как устроена интеграция, как работает webhook и запуск регрессий по событиям в репозитории.

---

## 1. Обзор

Git-интеграция связывает **репозиторий** (GitHub или GitLab) с **проектом** в системе и при наступлении событий (push, merge PR/MR, release) может **автоматически запускать регрессионный план**.

- **Один репозиторий** = одна запись в `git_integrations` (привязка к проекту и опционально к регрессионному плану).
- **Webhook** — единственная публичная точка входа: GitHub/GitLab шлют POST на один и тот же URL; провайдер определяется по заголовкам.
- **Обработка асинхронная**: запрос принимается, проверяется подпись/токен, доставка пишется в БД и ставится в очередь; воркер обрабатывает задачу и при выполнении условий запускает план.

---

## 2. Компоненты и поток данных

```
GitHub/GitLab  →  POST /api/v1/git-integrations/webhook
                         ↓
                  [handleWebhook]
                         ↓
                  GitWebhookService.receiveAndEnqueue()
                    - определить provider (x-github-event / x-gitlab-event)
                    - извлечь repository URL из payload
                    - найти git_integration по provider + repository_url
                    - сохранить доставку в git_webhook_deliveries (идемпотентность)
                    - проверить подпись (GitHub: HMAC-SHA256, GitLab: token)
                    - добавить джоб в очередь git-webhook
                         ↓
                  Ответ 202 (queued) или 200 (ignored)
                         ↓
                  [Worker] GitWebhookJobHandler.process(job)
                    - загрузить delivery + integration
                    - проверить plan_id, enabled, events, branch, triggerTypes
                    - GitWebhookService.shouldTrigger() → ветка и тип события
                    - RegressionRunService.runPlan({ planId, userId, trigger: 'webhook' })
                    - обновить status доставки: processed / ignored / failed
```

---

## 3. Webhook endpoint

### URL

- **POST** `{BACKEND_URL}/api/v1/git-integrations/webhook`
- Публичный (без `Authorization`). Безопасность — проверка подписи/токена в теле запроса.

### Raw body

Для проверки подписи GitHub нужен **сырой body** (Buffer). В приложении для этого пути включён отдельный парсер:

- В `src/index.ts` до общего `express.json()`:
  - `app.use('/api/v1/git-integrations/webhook', express.raw({ type: 'application/json', limit: '10mb' }))`
- Остальные роуты используют обычный `express.json()`.

### Определение провайдера

- **GitHub**: заголовок `x-github-event` присутствует → `provider = 'github'`.
- **GitLab**: заголовок `x-gitlab-event` присутствует → `provider = 'gitlab'`.
- Если оба отсутствуют → ответ **400** «Missing Git provider headers».

### Идентификация доставки (idempotency)

- **GitHub**: `x-github-delivery` (уникальный ID доставки).
- **GitLab**: `x-gitlab-event-uuid`.
- Если заголовка нет — берётся SHA256 от тела запроса (fallback).

### Подпись / токен

- **GitHub**: заголовок `x-hub-signature-256` (формат `sha256=<hex>`). Проверка: HMAC-SHA256 от raw body с секретом из `git_integrations.webhook_secret`; сравнение через `crypto.timingSafeEqual`.
- **GitLab**: заголовок `x-gitlab-token`. Сравнение с `webhook_secret` (константное сравнение в коде через `timingSafeEqual`).
- При неверной подписи/токене — **401** и запись в `git_webhook_deliveries` с `status: 'failed'`, `error: 'invalid_signature'` / `'invalid_token'`.

### Ответы

- **202**: webhook принят и поставлен в очередь (`queued: true`).
- **200**: webhook принят, но регрессия не будет запускаться (`ignored: true`, в теле может быть `reason`).
- **400**: нет провайдера, пустое тело, невалидный JSON.
- **401**: неверная подпись/токен.
- **500**: ошибка при обработке (например, при сохранении доставки).

---

## 4. Таблицы БД

### git_integrations

- **project_id** — проект, к которому привязан репозиторий.
- **provider** — `github` | `gitlab`.
- **repository_url** — нормализованный URL репозитория (например `https://github.com/owner/repo`).
- **webhook_secret** — секрет для проверки подписи (GitHub) или токена (GitLab).
- **events** — массив событий: `pull_request`, `push`, `release`.
- **enabled** — вкл/выкл приём webhook.
- **plan_id** — (опционально) регрессионный план, который запускается при срабатывании. Связь «репо → план» задаётся при настройке плана (PATCH regression-plans с `automationConfig.gitTriggers.integrationId`).

Связь план ↔ интеграция делается **только по URL репозитория** (и проекту). Если в плане указан **repositoryUrl**, но записи в `git_integrations` для этого проекта и URL ещё нет, она **создаётся автоматически** (при сохранении плана через API или при срабатывании триггера в БД). Дополнительно при **обработке вебхука** действует авто-привязка: если у найденной интеграции не заполнен `plan_id`, воркер ищет в том же проекте регрессионный план с `gitTriggers.repositoryUrl`, совпадающим с URL интеграции, проставляет `plan_id` и запускает план. Таким образом синхронизация выполняется автоматически и при сохранении плана, и при приходе вебхука. Поле **provider** в `gitTriggers` не обязательно. Пример:

```json
"gitTriggers": {
  "branch": "main",
  "enabled": true,
  "triggerTypes": ["merge_to_main"],
  "repositoryUrl": "https://github.com/owner/repo"
}
```

Ограничение: одна запись на пару `(project_id, repository_url)`.

**Связь с регрессионным планом:** поле `plan_id` (UUID, ссылка на `regression_plans.id`). Именно оно определяет, какой план запускать при вебхуке: воркер читает `integration.plan_id` и вызывает `RegressionRunService.runPlan(planId, ...)`. Если `plan_id` пустой, вебхук обрабатывается, но регрессия не запускается (`reason: no_plan_linked`).

**Откуда берётся `plan_id`:** связь синхронизируется **автоматом** двумя способами:

1. **Триггер в БД** (рекомендуется): при любом `INSERT` или `UPDATE` строки в `regression_plans` (поля `automation_config` или `project_id`) срабатывает триггер `sync_git_integration_plan_id_trigger`. Он смотрит `automation_config.gitTriggers` (enabled + integrationId или repositoryUrl), находит подходящую запись в `git_integrations` и проставляет у неё `plan_id`. Так синхронизация работает и при сохранении плана через API, и при прямом изменении данных в Supabase (SQL/UI).
2. **Код приложения:** при создании/обновлении плана через API дополнительно вызывается `RegressionPlanService.syncGitIntegration()` — дублирует логику триггера для консистентности.

Скрипт `scripts/sync-git-integration-plan-ids.ts` нужен только для **разовой** простановки связей по уже существующим планам (например, до применения миграции с триггером или после ручного массового изменения `automation_config` в БД).

### git_webhook_deliveries

- **provider**, **delivery_id** — уникальная пара (идемпотентность: повторная доставка с тем же `delivery_id` не создаёт новую запись).
- **event_type** — тип события (например `push`, `pull_request`, `merge_request`, `release`).
- **repository_url** — URL репозитория из payload (или нормализованный).
- **integration_id** — ссылка на `git_integrations` (null, если интеграция не найдена).
- **payload** — полное тело webhook (JSONB).
- **signature** — значение заголовка подписи/токена (для аудита).
- **status** — `received` → `queued` → `processed` | `ignored` | `failed`.
- **received_at**, **processed_at**, **error** — для отладки и аудита.

---

## 5. Сервисы и воркер

### GitWebhookService (`src/services/integrations/git-webhook.service.ts`)

- **verifyGitHubSignature(rawBody, signatureHeader, secret)** — проверка `x-hub-signature-256`.
- **verifyGitLabToken(tokenHeader, secret)** — проверка `x-gitlab-token`.
- **extractRepositoryUrl(provider, payload)** — GitHub: `payload.repository.html_url`, GitLab: `payload.project.web_url`.
- **shouldTrigger({ provider, eventType, payload, allowedBranches })** — решает, запускать ли регрессию:
  - GitHub: `pull_request` (action=closed, merged) → base ref в allowedBranches; `push` → ref в allowedBranches; `release` (action=published).
  - GitLab: `merge_request` (state=merged) → target_branch в allowedBranches; `push`; `release` (action=create).
- **receiveAndEnqueue(...)** — поиск интеграции, сохранение доставки, проверка подписи, постановка джоба в очередь, обновление статуса.

### GitIntegrationService (`src/services/integrations/git-integration.service.ts`)

- CRUD для `git_integrations` (create, get, list, update, delete).
- **findByProviderAndRepositoryUrl** — поиск интеграции по провайдеру и URL (для webhook).
- **findByProjectAndRepositoryUrl** — поиск по проекту и URL (для привязки плана к репо).
- Нормализация URL и валидация формата (GitHub/GitLab).

### GitWebhookJobHandler (`src/jobs/git-webhook.job.ts`)

- Вход: `{ provider, deliveryId }`.
- Загружает запись из `git_webhook_deliveries` и связанную `git_integrations`.
- Проверки: статус доставки уже обработан/ignored/failed → выход; нет `integration_id` / интеграция удалена / `enabled: false` → status `ignored`.
- Проверка событий: `integration.events` должен содержать тип события (для GitLab `merge_request` мапится в конфиг как `pull_request`).
- Проверка плана: у интеграции должен быть `plan_id`; иначе `ignored`, `no_plan_linked`.
- Из плана читается `automation_config.gitTriggers`: **branch** (допустимые ветки), **triggerTypes** (например `merge_to_main`, `release`). Типы событий маппятся: push/pull_request/merge_request → `merge_to_main`, release → `release`.
- **shouldTrigger** по payload и allowedBranches — если не trigger, то status `ignored` с причиной.
- Запуск: **RegressionRunService.runPlan({ planId, userId: project.user_id, trigger: 'webhook' })**.
- При успехе — status `processed`; при ошибке — `failed`, при «Insufficient credits» — создаётся уведомление пользователю.

### Очередь

- Имя: из `QUEUE_NAMES.GIT_WEBHOOK` (конфиг в `src/config/infrastructure/queues.ts`).
- Добавление джоба: **QueueManager.addGitWebhookJob({ provider, deliveryId })**.
- Воркер регистрирует обработчик в `src/worker/index.ts` для этой очереди.

---

## 6. API (требуют авторизации)

| Метод | Путь | Описание |
|-------|------|----------|
| POST  | /api/v1/git-integrations | Создать интеграцию (projectId, provider, repositoryUrl, webhookSecret, events). В ответе — **webhookUrl** и данные интеграции (без секрета). |
| GET   | /api/v1/git-integrations?projectId= | Список интеграций проекта. |
| GET   | /api/v1/git-integrations/:id | Одна интеграция. |
| PUT   | /api/v1/git-integrations/:id | Обновить (webhookSecret, events, enabled). |
| DELETE| /api/v1/git-integrations/:id | Удалить интеграцию. |
| POST  | /api/v1/git-integrations/webhook | Приём webhook (публичный, без Bearer). |
| GET   | /api/v1/git-integrations/webhook | 405 (подсказка использовать POST). |

**webhookUrl** в ответах формируется как `{BACKEND_URL}/api/v1/git-integrations/webhook` (BACKEND_URL из env). Этот URL нужно указать в настройках webhook в GitHub/GitLab.

---

## 7. Когда запускается регрессия

- Найденная интеграция по `provider` + `repository_url` из payload.
- Интеграция включена (`enabled: true`), у неё задан `plan_id`.
- Тип события входит в `integration.events` и в `plan.automation_config.gitTriggers.triggerTypes` (с учётом маппинга push/PR/MR → `merge_to_main`).
- Ветка из payload входит в список разрешённых (из `plan.automation_config.gitTriggers.branch`, по умолчанию учитываются main/master).
- Подпись/токен webhook проверены успешно.

Подробные шаги настройки (создание интеграции, добавление webhook в GitHub, привязка плана и ветки) описаны в **[GIT_WEBHOOK_REGRESSION_SETUP.md](./GIT_WEBHOOK_REGRESSION_SETUP.md)**.

---

## 8. Типы событий и маппинг

| Событие (GitHub) | Событие (GitLab) | triggerType в плане | Условие запуска |
|------------------|------------------|----------------------|------------------|
| push             | push             | merge_to_main       | ref в разрешённой ветке |
| pull_request     | merge_request    | merge_to_main       | PR/MR merged в разрешённую ветку |
| release          | release          | release             | release published (GitHub) / create (GitLab) |

---

## 9. Устранение неполадок

- В логах бэкенда: `[GIT_WEBHOOK_API] Webhook processed` — смотреть `queued`, `ignored`, `reason`.
- В логах воркера: `[GIT_WEBHOOK_JOB]` — Triggering regression run / Delivery already handled / No plan linked / trigger_type_not_enabled / branch_not_allowed и т.д.
- Таблица **git_webhook_deliveries**: по `delivery_id` и `status`/`error` видно, почему доставка проигнорирована или упала.

Типичные **reason** и действия описаны в **[GIT_WEBHOOK_REGRESSION_SETUP.md](./GIT_WEBHOOK_REGRESSION_SETUP.md)** (раздел «Устранение неполадок»).

---

## 10. Схема файлов

| Файл | Назначение |
|------|------------|
| `src/api/gitIntegration/git-integration.controller.ts` | CRUD + handleWebhook (приём webhook, вызов GitWebhookService). |
| `src/api/gitIntegration/git-integration.route.ts` | Роуты: POST/GET webhook без auth, остальные с requireAuth. |
| `src/services/integrations/git-webhook.service.ts` | Подпись, извлечение URL, shouldTrigger, persistDelivery, receiveAndEnqueue. |
| `src/services/integrations/git-integration.service.ts` | CRUD и поиск интеграций по provider+URL / project+URL. |
| `src/jobs/git-webhook.job.ts` | Обработка джоба: загрузка delivery/integration/plan, фильтры, RegressionRunService.runPlan. |
| `src/config/infrastructure/queues.ts` | Очередь gitWebhookQueue. |
| `src/worker/index.ts` | Регистрация воркера для очереди git-webhook. |
| `src/index.ts` | express.raw для пути webhook; подключение роутов git-integrations. |
| `supabase-migrations/20250118_git_integrations.sql` | Таблица git_integrations. |
| `supabase-migrations/20250120_git_webhook_deliveries.sql` | Таблица git_webhook_deliveries. |
| `supabase-migrations/20260212_add_plan_automation_settings.sql` | plan_id в git_integrations. |
| `supabase-migrations/migrations/20260305_sync_git_integration_plan_id_trigger.sql` | Триггер: при INSERT/UPDATE regression_plans синхронизирует git_integrations.plan_id из automation_config.gitTriggers. |
| `scripts/create-git-integration.ts` | Создание записи в git_integrations (при reason integration_not_found). |
| `scripts/sync-git-integration-plan-ids.ts` | Разовая простановка plan_id по существующим планам (до триггера или после ручного изменения БД). |

Пошаговая настройка (создание интеграции, webhook в GitHub, привязка плана и ветки): **[GIT_WEBHOOK_REGRESSION_SETUP.md](./GIT_WEBHOOK_REGRESSION_SETUP.md)**.
