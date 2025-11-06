# 📋 Anonymous Migration - Pre-Deployment Checklist

## ⚠️ ВАЖНО: Выполняй строго по порядку!

---

## 🔍 Шаг 1: Проверка предварительных условий

### 1.1 Убедись что все таблицы созданы

```sql
-- Выполни в Supabase SQL Editor
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'anonymous_chat_sessions',
    'anonymous_chat_messages',
    'anonymous_usage_limits',
    'api_environments',
    'api_endpoints'
  );
```

**Ожидаемый результат:** Все 5 таблиц должны быть в списке.

**Если таблиц нет:**
1. Выполни: `supabase-migrations/anonymous-chat-limits.sql`
2. Выполни: `supabase-migrations/api-configurations.sql`

---

### 1.2 Запусти валидационный скрипт

```sql
-- Скопируй и выполни весь файл:
-- supabase-migrations/test-before-migration.sql
```

**Ожидаемый результат:**
```
✅ All required tables exist
✅ All required columns exist
✅ Data types are correct
✅ Pre-migration checks passed!
```

**Если есть ошибки:**
- ❌ Missing tables → сначала создай таблицы (см. 1.1)
- ❌ Missing columns → проверь schema таблиц
- ❌ Wrong data type → исправь типы колонок

---

## 🚀 Шаг 2: Выполнение миграции

### 2.1 Бэкап (опционально, но рекомендуется)

```sql
-- Создай копии таблиц перед миграцией
CREATE TABLE anonymous_chat_sessions_backup AS
  SELECT * FROM anonymous_chat_sessions;

CREATE TABLE anonymous_usage_limits_backup AS
  SELECT * FROM anonymous_usage_limits;

CREATE TABLE api_environments_backup AS
  SELECT * FROM api_environments WHERE user_id::TEXT LIKE 'project_%';
```

---

### 2.2 Выполни основную миграцию

```sql
-- Скопируй и выполни весь файл:
-- supabase-migrations/anonymous-to-auth-migration.sql
```

**Ожидаемый результат:**
```
CREATE FUNCTION (migrate_anonymous_to_authenticated)
CREATE FUNCTION (check_anonymous_data)
CREATE INDEX (idx_anon_sessions_anonymous_id_not_migrated)
COMMENT
GRANT
```

**Если есть ошибки:**
- ❌ `relation does not exist` → таблицы не созданы (см. 1.1)
- ❌ `column does not exist` → неправильная schema (проверь таблицы)
- ❌ Syntax error → проверь SQL файл

---

## ✅ Шаг 3: Проверка после миграции

### 3.1 Проверь что функции созданы

```sql
SELECT
  proname as function_name,
  pg_get_function_identity_arguments(oid) as arguments
FROM pg_proc
WHERE proname IN (
  'migrate_anonymous_to_authenticated',
  'check_anonymous_data'
)
AND pronamespace = 'public'::regnamespace;
```

**Ожидаемый результат:** 2 функции.

---

### 3.2 Проверь права доступа

```sql
SELECT
  proname,
  array_agg(rolname) as granted_to
FROM pg_proc p
JOIN pg_proc_acl a ON p.oid = a.prooid
JOIN pg_roles r ON a.grantee = r.oid
WHERE proname IN (
  'migrate_anonymous_to_authenticated',
  'check_anonymous_data'
)
GROUP BY proname;
```

**Ожидаемый результат:** Обе функции должны иметь `authenticated` в `granted_to`.

---

### 3.3 Тестовый вызов функции (проверка данных)

```sql
-- Проверь есть ли анонимные данные для тестового projectId
SELECT check_anonymous_data('project_test_anon_project_123');
```

**Ожидаемый результат:**
```json
{
  "has_data": true/false,
  "counts": {
    "sessions": 1,
    "messages": 2,
    "environments": 0
  }
}
```

---

### 3.4 Тестовая миграция (опционально)

**⚠️ Только если есть тестовые данные!**

```sql
-- 1. Создай тестового пользователя (или используй существующего)
-- Получи user_id из auth.users

-- 2. Проверь что есть анонимные данные
SELECT check_anonymous_data('project_test_migration_1762419245');

-- 3. Выполни миграцию
SELECT migrate_anonymous_to_authenticated(
  'project_test_migration_1762419245',
  'user-uuid-here'::UUID
);

-- 4. Проверь результат
SELECT * FROM anonymous_chat_sessions
WHERE anonymous_id LIKE '%_migrated_to_%';
```

**Ожидаемый результат:**
```json
{
  "success": true,
  "migrated": {
    "chat_sessions": 1,
    "chat_messages": 2,
    "api_environments": 0,
    "api_endpoints": 0
  }
}
```

---

## 🎯 Шаг 4: Финальная проверка Backend

### 4.1 Перезапусти сервер

```bash
cd /Users/yerassylospanov/Desktop/QAI-BackEnd
npm run dev
```

### 4.2 Проверь логи при старте

```bash
# Должны быть без ошибок о миграциях
# Проверь что сервис загрузился:
[INFO] Server started on port 3000
```

### 4.3 Тестовый запрос (анонимный)

```bash
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello",
    "context": {"projectId": "test_final_check"}
  }'
```

**Проверь:**
- ✅ Статус 200
- ✅ `rateLimitInfo.isAnonymous: true`
- ✅ `rateLimitInfo.remaining: 2`

---

## 📊 Шаг 5: Мониторинг Production

### 5.1 Логи миграций

```sql
-- Проверь сколько пользователей уже мигрировали
SELECT
  COUNT(*) as migrated_sessions,
  COUNT(DISTINCT SUBSTRING(anonymous_id FROM '_migrated_to_(.*)$')) as unique_users
FROM anonymous_chat_sessions
WHERE anonymous_id LIKE '%_migrated_to_%';
```

### 5.2 Ошибки миграции

```bash
# В логах сервера ищи:
grep "AUTH.*Failed to migrate" logs/app.log
grep "ANON_MIGRATION.*failed" logs/app.log
```

### 5.3 Rate limit статистика

```sql
-- Проверь сколько анонимных пользователей активны
SELECT
  COUNT(*) as active_anonymous_users,
  AVG(request_count) as avg_requests,
  MAX(request_count) as max_requests
FROM anonymous_usage_limits
WHERE last_request_at >= NOW() - INTERVAL '24 hours';
```

---

## 🆘 Troubleshooting

### Проблема: Функция не вызывается из backend

**Решение:**
```sql
-- Проверь что функция в public schema
SELECT n.nspname, p.proname
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.proname = 'migrate_anonymous_to_authenticated';

-- Если функция не в public, пересоздай:
DROP FUNCTION IF EXISTS migrate_anonymous_to_authenticated;
-- Выполни миграцию заново
```

---

### Проблема: "Permission denied for function"

**Решение:**
```sql
-- Проверь права
GRANT EXECUTE ON FUNCTION public.migrate_anonymous_to_authenticated TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_anonymous_data TO authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_anonymous_to_authenticated TO anon;
GRANT EXECUTE ON FUNCTION public.check_anonymous_data TO anon;
```

---

### Проблема: Миграция возвращает 0 для всех счетчиков

**Причины:**
1. Anonymous user не создавал данные
2. Неправильный `anonymousId` формат
3. Данные уже были мигрированы

**Проверка:**
```sql
-- 1. Проверь есть ли данные
SELECT * FROM anonymous_chat_sessions
WHERE anonymous_id = 'project_your_id_here';

-- 2. Проверь формат
SELECT anonymous_id FROM anonymous_chat_sessions
WHERE anonymous_id NOT LIKE 'project_%';

-- 3. Проверь уже мигрированные
SELECT * FROM anonymous_chat_sessions
WHERE anonymous_id LIKE '%_migrated_to_%';
```

---

### Проблема: Backend возвращает "Migration failed"

**Проверь логи:**
```typescript
// В коде уже есть обработка:
catch (migrationError: any) {
  logger.error('[AUTH] Failed to migrate anonymous data', {
    migrationError,
    anonymousId,
    userId: result.user.id
  });
}
```

**Частые причины:**
- Таблица не существует
- RLS политики блокируют доступ
- Неправильный тип данных `user_id`

---

## ✅ Success Criteria

Миграция успешна если:

- [x] Все SQL скрипты выполнились без ошибок
- [x] Функции созданы и доступны
- [x] Backend запускается без ошибок
- [x] Анонимные пользователи могут отправлять сообщения
- [x] Rate limiting работает (3 запроса)
- [x] При регистрации данные мигрируют (если были)
- [x] В логах нет критических ошибок

---

## 📞 Support

Если что-то пошло не так:

1. Проверь все шаги чеклиста заново
2. Посмотри логи: `grep "ANON_MIGRATION\|AUTH.*migrate" logs/app.log`
3. Проверь Supabase logs в Dashboard
4. Rollback: восстанови из бэкапа (см. Шаг 2.1)

---

**Готово! 🚀**

После выполнения всех шагов система готова к production использованию.
