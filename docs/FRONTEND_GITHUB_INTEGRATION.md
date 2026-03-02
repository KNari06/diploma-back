# GitHub и GitLab Integration — выбор репозитория и ветки (Frontend)

Документ описывает, как на фронтенде подключить **GitHub** или **GitLab** через OAuth и дать пользователю выбрать репозиторий и ветку (например, для регрессионного плана). Эндпоинты и сценарий для GitLab аналогичны GitHub (см. раздел 8).

---

## 1. Базовый URL и авторизация

- **Базовый URL:** `{BACKEND_URL}/api/v1/integrations`  
  Примеры: `https://api.qait.dev/api/v1/integrations`, `http://localhost:3000/api/v1/integrations`.

- **Авторизация:** во всех запросах передавать заголовок:
  ```http
  Authorization: Bearer <access_token>
  ```
  где `access_token` — JWT пользователя в вашем приложении.

---

## 2. Подключение GitHub (OAuth)

Чтобы пользователь мог выбрать репо и ветку, сначала нужно подключить его GitHub-аккаунт.

**Рекомендуемый способ (кнопка «Подключить GitHub»):**

1. Вызвать с фронта:
   ```http
   GET /api/v1/integrations/github/authorize?return_url=1
   ```
   Опционально: `&workspace_id=<uuid>` — если интеграции привязаны к workspace.  
   Заголовок: `Authorization: Bearer <access_token>`.

2. Бэкенд вернёт **200** и JSON:
   ```json
   {
     "success": true,
     "redirect_url": "https://github.com/login/oauth/authorize?...",
     "message": "Redirect user to redirect_url to complete OAuth.",
     "timestamp": "..."
   }
   ```

3. Выполнить переход на страницу GitHub:
   ```js
   window.location.href = data.redirect_url;
   ```

4. После авторизации на GitHub пользователь попадёт на callback бэкенда, затем редирект на фронт:
   - Успех: `{FRONTEND_URL}/integrations?provider=github&status=success`
   - Ошибка: `{FRONTEND_URL}/integrations?status=error&message=...`

**Важно:** не вызывать `/authorize` через `fetch()` без `return_url=1` — иначе бэкенд ответит 302 на GitHub, и при следовании редиректу будет CORS-ошибка. Используйте `return_url=1` и переход по `redirect_url` в текущем окне.

---

## 3. Проверка, подключён ли GitHub

Перед показом выбора репо/ветки проверьте, что GitHub уже подключён.

**Запрос:**
```http
GET /api/v1/integrations?workspace_id=<uuid>
Authorization: Bearer <access_token>
```

**Ответ (успех):**
```json
{
  "success": true,
  "integrations": [
    { "id": "...", "provider": "github", "external_id": "octocat", ... },
    ...
  ],
  "timestamp": "..."
}
```

Если в массиве `integrations` есть элемент с `provider === 'github'` — можно вызывать эндпоинты списка репозиториев и веток. Если нет — показать кнопку «Подключить GitHub» (п. 2).

---

## 4. Список репозиториев

**Запрос:**
```http
GET /api/v1/integrations/github/repos?per_page=30
Authorization: Bearer <access_token>
```

- `per_page` — опционально (по умолчанию 30, максимум 100).

**Ответ (успех):**
```json
{
  "success": true,
  "data": [
    {
      "id": 12345,
      "name": "my-repo",
      "full_name": "owner/my-repo",
      "description": "...",
      "html_url": "https://github.com/owner/my-repo",
      "default_branch": "main",
      "private": false,
      "language": "TypeScript",
      "stargazers_count": 0,
      "forks_count": 0
    }
  ],
  "timestamp": "..."
}
```

Для выбора репо в UI достаточно: `name`, `full_name`, `html_url`, `default_branch`. Поле `html_url` пригодится, если позже будете сохранять выбранный репо в настройках плана (см. п. 7).

---

## 5. Список веток репозитория

После выбора репозитория запросите ветки. **owner** и **repo** берите из выбранного репо: из `full_name` это `owner` и `repo`, либо из `html_url` (`https://github.com/owner/repo`).

**Запрос:**
```http
GET /api/v1/integrations/github/repos/:owner/:repo/branches
Authorization: Bearer <access_token>
```

Пример: для репо `https://github.com/octocat/Hello-World`:
```http
GET /api/v1/integrations/github/repos/octocat/Hello-World/branches
```

**Ответ (успех):**
```json
{
  "success": true,
  "data": [
    {
      "name": "main",
      "commit": { "sha": "abc123...", "url": "https://api.github.com/..." },
      "protected": false
    }
  ],
  "timestamp": "..."
}
```

В UI для выпадающего списка веток достаточно полей `name` (и при необходимости `commit.sha`).

---

## 6. Коды ошибок

| Код | Значение |
|-----|----------|
| **401** | Нет или невалидный Bearer-токен. Показать повторный вход. |
| **403** | GitHub не подключён. В теле: `error: 'GitHub not connected'`, `message` с подсказкой. Показать кнопку «Подключить GitHub». |
| **500** | Внутренняя ошибка или ошибка GitHub API. В теле есть `message` — при необходимости показать пользователю. |

При 404 от GitHub (репо/ветка не найдены или нет доступа) бэкенд может вернуть 500 с текстом ошибки в `message`.

---

## 7. Использование выбранного репо и ветки (регрессия по webhook)

Если нужно сохранить выбранные репозиторий и ветку в регрессионном плане (автозапуск по push):

1. **Git-интеграция создаётся отдельно** — через `POST /api/v1/git-integrations` (projectId, provider, repositoryUrl, webhookSecret, events). Пользователь сначала создаёт интеграцию и добавляет webhook в настройках репо в GitHub на `{BACKEND_URL}/api/v1/git-integrations/webhook`.

2. **При сохранении плана** передайте в `PATCH /api/v1/regression-plans/:planId` в теле:
   ```json
   {
     "automationConfig": {
       "gitTriggers": {
         "enabled": true,
         "triggerTypes": ["push"],
         "branch": "main",
         "repositoryUrl": "https://github.com/owner/repo"
       }
     }
   }
   ```
   Либо укажите уже существующую интеграцию: `"integrationId": "<uuid>"` (UUID из `GET /api/v1/git-integrations?projectId=...`).

Бэкенд привязывает план к уже созданной git-интеграции по `repositoryUrl` или по `integrationId`; он не создаёт интеграцию из тела PATCH. Подробнее по настройке webhook: [GIT_WEBHOOK_REGRESSION_SETUP.md](./GIT_WEBHOOK_REGRESSION_SETUP.md).

---

## Краткий сценарий для UI «Выбор репо и ветки»

1. `GET /api/v1/integrations?workspace_id=...` → есть ли `provider === 'github'`?
2. Если нет → кнопка «Подключить GitHub» → `GET .../github/authorize?return_url=1` → `window.location.href = data.redirect_url` → после редиректа снова п. 1.
3. `GET .../github/repos?per_page=30` → выпадающий список репозиториев (например, `full_name` или `name`).
4. После выбора репо → `GET .../github/repos/:owner/:repo/branches` → выпадающий список веток (`name`).
5. Сохранить выбранные `repositoryUrl` (или `html_url` репо) и `branch` у себя или в `automationConfig.gitTriggers` плана (п. 7).

---

## 8. GitLab (аналогично GitHub)

Для GitLab (gitlab.com) используется тот же базовый URL и заголовок `Authorization: Bearer <access_token>`.

- **Подключение:** `GET /api/v1/integrations/gitlab/authorize?return_url=1` → ответ 200 с `redirect_url` → `window.location.href = data.redirect_url`. После OAuth редирект на `{FRONTEND_URL}/integrations?provider=gitlab&status=success`.
- **Проверка:** в `GET /api/v1/integrations?workspace_id=...` искать элемент с `provider === 'gitlab'`.
- **Список проектов (репо):** `GET /api/v1/integrations/gitlab/repos?per_page=30`. В ответе `data` — массив объектов с полями: `id`, `name`, `path_with_namespace`, `description`, `web_url`, `default_branch`, `visibility`. Для выбора репо и сохранения в плане используйте `web_url` (аналог `html_url` у GitHub).
- **Список веток:** `GET /api/v1/integrations/gitlab/projects/:projectId/branches`. Параметр `projectId` — числовой ID проекта из списка репо (поле `id`) либо URL-encoded path (например `owner%2Frepo`). В ответе `data` — массив с полями `name`, `merged`, `protected`, `default`, `commit`.
- **Ошибки:** 401/403 (GitLab not connected)/500 — как у GitHub.
- **Регрессия по webhook:** создание git-интеграции через `POST /api/v1/git-integrations` с `provider: "gitlab"`, `repositoryUrl` (например `web_url` из списка репо). В плане в `automationConfig.gitTriggers` передать `repositoryUrl` и `branch` (или `integrationId`). Webhook в GitLab настраивается на `{BACKEND_URL}/api/v1/git-integrations/webhook` (Secret — тот же, что в интеграции). Подробнее: [GIT_WEBHOOK_REGRESSION_SETUP.md](./GIT_WEBHOOK_REGRESSION_SETUP.md).
