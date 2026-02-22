# Frontend — интеграция GitHub (OAuth и API репозиториев/веток/CI)

Документ описывает, как на фронтенде подключить GitHub через OAuth и использовать API для списка репозиториев, веток, статуса коммита и GitHub Actions.

---

## 1. Базовый URL и авторизация

- **Базовый URL API:** `{BACKEND_URL}/api/v1/integrations`  
  Пример: `https://api.qait.dev/api/v1/integrations` или `http://localhost:3000/api/v1/integrations`.
- Все запросы к эндпоинтам интеграций (в т.ч. GitHub) выполняются с заголовком:
  ```http
  Authorization: Bearer <access_token>
  ```
  где `access_token` — JWT (или иной токен авторизации пользователя в вашем приложении).

---

## 2. Подключение GitHub (OAuth)

- **Не делать** обычный `fetch()` на `/authorize` без параметра ниже: ответ 302 ведёт на GitHub, fetch следует редиректу и получает CORS-ошибку.
- **Рекомендуемый вариант (для кнопки «Connect»):**
  1. Вызвать: `GET /api/v1/integrations/github/authorize?return_url=1` (и при необходимости `&workspace_id=...`) с заголовком `Authorization: Bearer <access_token>`.
  2. Бэкенд вернёт **200** и JSON: `{ "success": true, "redirect_url": "https://github.com/login/oauth/authorize?..." }`.
  3. Выполнить переход: `window.location.href = data.redirect_url`. Пользователь уйдёт на GitHub, после авторизации — на callback бэкенда, затем редирект на фронт (например `FRONTEND_URL/integrations?provider=github&status=success`).

**Альтернатива без fetch:** открыть в текущем окне ссылку  
`GET /api/v1/integrations/github/authorize?workspace_id=...` (тот же URL в `window.location.href`). Бэкенд ответит 302 и браузер сам перейдёт на GitHub. При этом запрос должен идти с куками/сессией, если авторизация по кукам; при Bearer — так не получится, поэтому предпочтителен вариант с `return_url=1` и fetch.

---

## 3. Проверка подключения GitHub

- Эндпоинт: `GET /api/v1/integrations?workspace_id=...` (с заголовком `Authorization: Bearer <access_token>`).
- В ответе в списке интеграций искать элемент с `provider === 'github'`.
- Если такой есть — GitHub подключён, можно вызывать эндпоинты репозиториев/веток/статуса/Actions.

---

## 4. Эндпоинты GitHub API

Все запросы — с заголовком `Authorization: Bearer <access_token>` (ваш JWT).

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/v1/integrations/github/repos?per_page=30` | Список репозиториев пользователя |
| GET | `/api/v1/integrations/github/repos/:owner/:repo/branches?per_page=30` | Список веток репозитория |
| GET | `/api/v1/integrations/github/repos/:owner/:repo/commits/:ref/status` | Статус коммита и check runs (CI/CD) |
| GET | `/api/v1/integrations/github/repos/:owner/:repo/actions/runs?per_page=20&branch=&status=` | Запуски workflow GitHub Actions |

- **owner** — логин владельца репозитория (например `octocat`).
- **repo** — имя репозитория (например `Hello-World`).
- **ref** — ветка (например `main`) или SHA коммита.
- **per_page** — опционально, по умолчанию для repos/branches 30, для runs 20; максимум 100.
- **branch** — опционально, фильтр по ветке для Actions runs.
- **status** — опционально, фильтр по статусу (например `completed`, `in_progress`) для Actions runs.

Успешный ответ имеет вид:
```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2025-02-21T12:00:00.000Z"
}
```

---

## 5. Коды ошибок

| Код | Значение |
|-----|----------|
| **401 Unauthorized** | Нет или невалидный Bearer-токен; пользователь не авторизован. |
| **403** | GitHub не подключён. В теле ответа обычно `error: 'GitHub not connected'` и `message` с подсказкой подключить аккаунт в разделе «Интеграции». |
| **404** | Репозиторий или ветка не найдены (в т.ч. нет доступа). |
| **500** | Внутренняя ошибка; в теле ответа поле `message` может содержать текст от GitHub API или сервера — показывать пользователю при необходимости. |

---

## 6. Связь с регрессией и webhook

- Список репозиториев (`GET .../github/repos`) и веток (`GET .../github/repos/:owner/:repo/branches`) используется в UI регрессионного плана: выбор репо и ветки для автоматического запуска по webhook.
- При сохранении плана с выбранным репозиторием фронт должен отправлять в `PATCH /api/v1/regression-plans/:planId` в `automationConfig.gitTriggers`:
  - **repositoryUrl** — полный URL репо (например `html_url` из ответа `/github/repos`: `https://github.com/owner/repo`).
  - **branch** — выбранная ветка (например `main`).
  - **webhookSecret** — секрет для webhook в GitHub (если пользователь его ввёл); бэкенд создаст или найдёт git-integration и привяжет план.
  - Либо **integrationId** — ID уже существующей git-integration (из `GET /api/v1/git-integrations?projectId=...`).
- Чтобы по push в репо реально запускалась регрессия, в GitHub в настройках репозитория должен быть добавлен webhook на `{BACKEND_URL}/api/v1/git-integrations/webhook` с тем же секретом. Подробнее см. [GIT_WEBHOOK_REGRESSION_SETUP.md](./GIT_WEBHOOK_REGRESSION_SETUP.md).
