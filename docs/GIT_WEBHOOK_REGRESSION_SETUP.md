# Настройка webhook: запуск регрессии при изменениях в репозитории

Когда в выбранном репозитории происходит **push** или **merge** в выбранную ветку, бэкенд принимает webhook от GitHub/GitLab и ставит задачу в очередь; воркер обрабатывает её и запускает регрессионный план.

---

## Как реализован запуск регресса «именно по этому репо и ветке»

Цепочка уже реализована в коде:

1. **Приём webhook** — `POST /api/v1/git-integrations/webhook` (контроллер `handleWebhook`). Из тела запроса берётся репозиторий (GitHub: `payload.repository.html_url`).
2. **Поиск интеграции** — по `provider` + `repository_url` находится запись в `git_integrations`. Так одна интеграция = один конкретный репозиторий.
3. **Очередь** — запрос валидируется (подпись/секрет), доставка пишется в `git_webhook_deliveries`, в очередь BullMQ добавляется джоб **git-webhook**.
4. **Воркер** (`GitWebhookJobHandler.process`) по `delivery_id` загружает доставку и интеграцию. У интеграции должен быть заполнен **plan_id** — это связь «этот репо → этот регрессионный план».
5. **Ветка** — из плана читается `automation_config.gitTriggers.branch`. Регрессия запускается только если событие (push/merge) произошло **в эту ветку** (`GitWebhookService.shouldTrigger` сверяет `payload.ref` с `allowedBranches`).
6. **Тип события** — в плане задаётся `triggerTypes` (например `["merge_to_main"]`). Push и merge PR маппятся на `merge_to_main`; при несовпадении джоб завершается с `ignored`, регресс не стартует.
7. **Запуск** — вызывается `RegressionRunService.runPlan({ planId, userId, trigger: 'webhook' })` — запускается именно тот план, который привязан к этой интеграции (репо + ветка уже отфильтрованы выше).

Итого: **репозиторий** определяется записью git-integration (по URL из webhook), **ветка** — полем `gitTriggers.branch` в плане. Один план может быть привязан к одной интеграции; для другого репо/ветки создаётся отдельная интеграция и при необходимости другой план.

---

## Что должно быть

- **Бэкенд** запущен и доступен по URL, на который будет слать GitHub (для продакшена — публичный URL; для localhost — через туннель, см. ниже).
- **Воркер** запущен: `npm run worker` (или `start:worker`). Без воркера задачи из очереди не обрабатываются.
- **Redis** запущен и доступен бэкенду и воркеру (очередь BullMQ).

---

## Как это работает

1. В GitHub в репозитории настраивается webhook: **Payload URL** = `{BACKEND_URL}/api/v1/git-integrations/webhook`.
2. При push/merge GitHub шлёт POST на этот URL. Бэкенд:
   - ищет **git-integration** по `provider` + `repository_url` (из payload);
   - проверяет подпись по **Secret**;
   - записывает доставку в `git_webhook_deliveries` и ставит задачу в очередь **git-webhook**.
3. Воркер забирает задачу, находит интеграцию и привязанный к ней план (`plan_id`), проверяет ветку и тип события и запускает регрессию.

Если интеграции с таким репозиторием нет или у неё не указан план — webhook всё равно отвечает 200, но в теле будет `ignored: true` и `reason` (см. раздел «Устранение неполадок»).

---

## Шаг 1. Создать Git-интеграцию (привязать репозиторий к проекту)

**Запрос:** `POST /api/v1/git-integrations`  
**Headers:** `Authorization: Bearer <token>`

**Тело:**
```json
{
  "projectId": "<uuid проекта>",
  "provider": "github",
  "repositoryUrl": "https://github.com/owner/repo",
  "webhookSecret": "<любая случайная строка, например 32+ символов>",
  "events": ["pull_request", "push", "release"]
}
```

**Ответ:** в нём будет поле `webhookUrl`, например:
`https://api.qait.dev/api/v1/git-integrations/webhook`

Запомните или сохраните:
- `webhookUrl` — его нужно указать в настройках webhook в GitHub.
- `webhookSecret` — тот же секрет нужно указать в GitHub (для проверки подписи).

---

## Шаг 2. Добавить webhook в GitHub

1. Репозиторий на GitHub → **Settings** → **Webhooks** → **Add webhook**.
2. **Payload URL:** полный URL до эндпоинта (обязательно с путём):
   - `https://ваш-домен/api/v1/git-integrations/webhook`
   - Либо `webhookUrl` из ответа `POST /api/v1/git-integrations` (уже содержит путь). Не указывайте только домен без `/api/v1/git-integrations/webhook` — иначе будет 404.
3. **Content type:** `application/json`.
4. **Secret:** строка, **идентичная** `webhookSecret`, переданному при создании git-integration. Подпись запросов проверяется по этому секрету.
5. **Which events:** "Let me select individual events" → включите:
   - **Pushes** — запуск при push в выбранную ветку;
   - **Pull requests** — запуск при merge PR в выбранную ветку;
   - при необходимости **Releases**.
6. **Add webhook**. В Recent Deliveries после push должен быть ответ 200 или 202.

---

## Шаг 3. Связать интеграцию с регрессионным планом и указать ветку

У регрессионного плана в `automation_config` должны быть включены Git-триггеры и указана ветка (и при нескольких репо — нужная интеграция).

**Обновление плана:** `PATCH /api/v1/regression-plans/:planId`  
**Тело (пример):**
```json
{
  "automationConfig": {
    "gitTriggers": {
      "enabled": true,
      "triggerTypes": ["merge_to_main"],
      "branch": "main",
      "integrationId": "<uuid git-интеграции из GET /git-integrations>"
    }
  }
}
```

- **branch** — ветка, при событиях в которой запускается регрессия (например `main`, `develop`).
- **integrationId** — ID выбранной git-интеграции (репозитория). Если у проекта одна интеграция, можно не передавать — привяжется она.
- **repositoryUrl** — URL репозитория (например `html_url` из `GET /api/v1/integrations/github/repos`). Бэкенд **только ищет** существующую git-integration по проекту и этому URL; создание интеграции из тела PATCH не выполняется. Интеграцию нужно сначала создать через `POST /api/v1/git-integrations`, затем в плане указать либо **integrationId**, либо **repositoryUrl** (тогда подтянется найденная интеграция).

После сохранения плана бэкенд проставит у выбранной git-интеграции `plan_id` (связь «этот репо + эта ветка → этот план»).

---

## Когда запускается регрессия

- **GitHub push** в выбранную ветку → регрессия запускается.
- **GitHub:** merge pull request в выбранную ветку → регрессия запускается.
- **GitHub release** published → регрессия запускается (если включено в событиях).
- Аналогично для GitLab: push, merge merge request, release.

Если событие не по выбранной ветке или тип события не подходит — webhook принимается (200/202), но регрессия не запускается (в теле ответа `ignored: true`, `reason: ...`).

---

## Проверка

1. Сделайте **новый** push в выбранную ветку (новый коммит) или merge PR.
2. GitHub → **Settings** → **Webhooks** → ваш webhook → **Recent Deliveries**: ответ 200 или 202, тело с `success: true`; при постановке в очередь — `queued: true`.
3. В логах **бэкенда**: `[GIT_WEBHOOK_API] Webhook processed` с `queued: true` (без `reason: duplicate_delivery` или `integration_not_found`).
4. В логах **воркера**: обработка джоба git-webhook и запуск регрессии.
5. В приложении: у регрессионного плана появился новый запуск с триггером «webhook».

---

## Локальная разработка (localhost)

GitHub доставляет webhook только на **публичный URL**. Чтобы тестировать на своей машине:

1. **Туннель** (например ngrok):
   ```bash
   ngrok http 3000
   ```
   В выводе будет URL вида `https://xxxx.ngrok-free.app`. При каждом новом запуске ngrok (бесплатный план) URL может меняться.

2. **Payload URL в GitHub:**  
   `https://xxxx.ngrok-free.app/api/v1/git-integrations/webhook`  
   (обязательно с путём; без пути будет 404).

3. **В `.env` бэкенда:**  
   `BACKEND_URL=https://xxxx.ngrok-free.app` (без слэша в конце).

4. **Одновременно должны работать:**
   - бэкенд на порту 3000 (`npm run dev` или `npm start`);
   - ngrok (`ngrok http 3000`);
   - Redis (например `brew services start redis`);
   - воркер (`npm run worker`).

5. **Redis на хосте:** при запуске бэкенда и воркера не в Docker в `.env` укажите:
   - `REDIS_HOST=localhost`
   - `REDIS_URL=redis://localhost:6379`  
   (для Docker используйте `host.docker.internal`.)

---

## Устранение неполадок

В логах бэкенда ищется строка `[GIT_WEBHOOK_API] Webhook processed` с полями `queued`, `ignored`, `reason`.

| reason | Причина | Что сделать |
|--------|--------|-------------|
| **duplicate_delivery** | Та же доставка уже обработана (тот же `delivery_id`). | Делайте **новый** push (новый коммит). Не используйте кнопку Redeliver в GitHub — у неё тот же delivery_id. |
| **integration_not_found** | В базе нет git-integration с таким `repository_url` и `enabled: true`. | Создайте интеграцию: `POST /api/v1/git-integrations` с `repositoryUrl` (точно как в payload, например `https://github.com/owner/repo`), `webhookSecret`, `projectId`, `provider`, `events`. Затем привяжите план: `PATCH /api/v1/regression-plans/:planId` с `automationConfig.gitTriggers.integrationId` = id созданной интеграции. |
| (нет в ответе, но тест не стартует) | Задача в очереди, но воркер не привязывает план. | Проверьте логи воркера: `[GIT_WEBHOOK_JOB] No plan linked to git integration`. У интеграции должен быть проставлен `plan_id` (происходит при сохранении плана с `integrationId` или при создании интеграции через план с `repositoryUrl` + `webhookSecret`). Повторно сохраните план с выбранной интеграцией. |

Если в логах есть `[GIT_WEBHOOK] No git integration found for repo` — в сообщении указан `repositoryUrl`, по которому искали. Сверьте его с `repository_url` в таблице `git_integrations` (или с ответом `GET /api/v1/git-integrations`): они должны совпадать (включая `https://`, без лишнего слэша в конце).
