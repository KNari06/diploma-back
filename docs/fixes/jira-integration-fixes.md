---
name: Jira Integration Fixes
overview: Исправить критические баги в Jira интеграции и добавить недостающие API endpoints для полной функциональности
todos: []
---

# Jira Integration - Исправления и доработки

## Для чего нужна Jira интеграция

**Простыми словами**: Интеграция позволяет автоматически создавать задачи (issues) в Jira на основе результатов тестирования.

**Как это работает:**

1. **Пользователь подключает свой Jira аккаунт** через OAuth 2.0 (безопасная авторизация)
2. **После запуска теста** система анализирует результаты и находит баги
3. **Автоматически создается задача в Jira** с полной информацией:

   - Описание найденных багов
   - Скриншоты проблемных мест
   - Видео записи теста
   - Сгенерированный Playwright код для воспроизведения
   - Рекомендации по исправлению

4. **Разработчики видят задачу в Jira** и могут сразу начать исправлять баги

**Зачем это нужно:**

- Не нужно вручную копировать результаты тестов в Jira
- Вся информация о баге в одном месте (скриншоты, видео, код)
- Автоматизация процесса отчетности об ошибках
- Интеграция тестирования в рабочий процесс команды

**Что может пользователь:**

- Подключить свой Jira аккаунт (один или несколько)
- Выбрать проект Jira для создания задач
- Автоматически создавать задачи из результатов тестов
- Управлять подключениями (проверять статус, отключать)

## Текущее состояние

### Что работает:

- OAuth 2.0 авторизация (`/api/v1/jira/auth/start`, `/callback`)
- Получение списка проектов (`/api/v1/jira/projects`)
- Создание Jira issues из тестовых отчетов (`/api/v1/reports/:testId/jira`)
- Автоматическое обновление токенов в `jira.service.ts`
- Сохранение связей тестов с Jira issues в БД

### Критические проблемы:

1. **Поле `active` отсутствует в БД** - в [jira-report.service.ts](src/services/integrations/jira-report.service.ts:481) используется `.eq('active', true)`, но в схеме [jira-oauth.sql](supabase-migrations/features/jira-oauth.sql) этого поля нет
2. **Токены не обновляются в jira-report.service** - метод `getJiraAuth` не использует `ensureValidToken`, что приведет к ошибкам при истекших токенах
3. **Отсутствуют API endpoints**:

   - Проверка статуса подключения Jira
   - Отключение Jira аккаунта
   - Получение списка подключенных Jira аккаунтов

## Что нужно исправить

### 1. Исправить запрос токенов в jira-report.service.ts

**Файл**: `src/services/integrations/jira-report.service.ts`

- Убрать `.eq('active', true)` из запроса (строка 481)
- Использовать `ensureValidToken` из `jira.service.ts` для автоматического обновления токенов
- Импортировать `ensureValidToken` и `getJiraToken` из `@/services/api/jira.service`

**Изменения**:

```typescript
// Было:
const { data, error } = await supabaseAdmin
  .from("jira_tokens")
  .select("access_token, cloud_id")
  .eq("user_id", userId)
  .eq("active", true) // ❌ Поле не существует
  .single();

// Станет:
const tokenData = await getJiraToken(userId);
if (!tokenData) return null;

const accessToken = await ensureValidToken(tokenData); // ✅ Обновление токена
return {
  accessToken,
  cloudId: tokenData.cloud_id!,
};
```

### 2. Добавить API endpoints для управления подключением

**Файл**: `src/api/jira/jira.controller.ts`

Добавить 3 новых метода:

- **`getConnectionStatus`** - `GET /api/v1/jira/status`

  - Проверяет наличие активных токенов для пользователя
  - Возвращает список подключенных Jira аккаунтов (cloud_id, site_url)
  - Использует `getJiraToken` из `jira.service.ts`

- **`disconnectJira`** - `DELETE /api/v1/jira/disconnect`

  - Удаляет токены Jira для пользователя
  - Принимает опциональный `cloudId` query param (если не указан - удаляет все)
  - Использует `supabaseAdmin.from('jira_tokens').delete()`

- **`getConnections`** - `GET /api/v1/jira/connections`
  - Возвращает список всех подключенных Jira аккаунтов с деталями
  - Показывает cloud_id, site_url, created_at для каждого

**Файл**: `src/api/jira/jira.route.ts`

Добавить роуты:

```typescript
router.get("/status", requireAuth, asyncHandler(getConnectionStatus));
router.delete("/disconnect", requireAuth, asyncHandler(disconnectJira));
router.get("/connections", requireAuth, asyncHandler(getConnections));
```

### 3. Добавить Swagger документацию

**Файл**: `src/api/jira/jira.route.ts`

Добавить Swagger аннотации для новых endpoints с описанием запросов/ответов.

## Порядок выполнения

1. Исправить `jira-report.service.ts` (критично - блокирует создание issues)
2. Добавить новые методы в `jira.controller.ts`
3. Добавить роуты в `jira.route.ts`
4. Добавить Swagger документацию
5. Протестировать все endpoints

## Тестирование

После исправлений проверить:

- Создание Jira issue из отчета (должно работать с истекшими токенами)
- Проверка статуса подключения
- Отключение Jira аккаунта
- Получение списка подключений
