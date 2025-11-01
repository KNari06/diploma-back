# Supabase Setup Instructions

## Пошаговая инструкция по применению миграций

---

## 1. Войти в Supabase Dashboard

1. Открыть https://supabase.com
2. Выбрать свой проект
3. Перейти в **SQL Editor** (левое меню)

---

## 2. Применить основную схему БД

**Файл:** `supabase-schema.sql`

1. SQL Editor → New Query
2. Скопировать весь контент из `supabase-schema.sql`
3. Вставить в редактор
4. Нажать **Run** (или Ctrl+Enter)

**Что создастся:**
- Все таблицы (users, projects, tests, test_results, и т.д.)
- Индексы
- RLS политики
- Функции для работы с кредитами
- Триггеры для auto-update timestamps
- Sample data для тестирования

**Ожидаемый результат:**
```
Success. No rows returned
```

---

## 3. Применить Auth Sync Migration

**Файл:** `supabase-migrations/auth-sync.sql`

### ⚠️ ВАЖНО: Проверить права доступа

Эта миграция создает триггеры на `auth.users` (системная схема).

**Вариант A: Через SQL Editor (рекомендуется)**

1. SQL Editor → New Query
2. Скопировать весь контент из `supabase-migrations/auth-sync.sql`
3. Вставить в редактор
4. Нажать **Run**

**Если ошибка прав доступа:**
```sql
ERROR: permission denied for schema auth
```

**Решение:**
- Supabase Dashboard → Database → Extensions
- Убедиться что у вас есть права на auth схему
- Или использовать Supabase CLI (см. Вариант B)

**Вариант B: Через Supabase CLI (если нет прав в UI)**

```bash
# Установить Supabase CLI
npm install -g supabase

# Login
supabase login

# Link к проекту
supabase link --project-ref YOUR_PROJECT_REF

# Применить миграцию
supabase db push
```

**Ожидаемый результат:**
```
Success. No rows returned

Created:
- Function: public.sync_user_to_public()
- Function: public.handle_auth_user_delete()
- Trigger: on_auth_user_created
- Trigger: on_auth_user_deleted
```

---

## 4. Проверить что триггеры созданы

**SQL для проверки:**

```sql
-- Проверить функции
SELECT
  routine_name,
  routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name LIKE '%user%';

-- Должно показать:
-- sync_user_to_public | FUNCTION
-- handle_auth_user_delete | FUNCTION

-- Проверить триггеры
SELECT
  trigger_name,
  event_object_table,
  action_timing,
  event_manipulation
FROM information_schema.triggers
WHERE trigger_name LIKE '%auth_user%';

-- Должно показать:
-- on_auth_user_created | users | AFTER | INSERT
-- on_auth_user_created | users | AFTER | UPDATE
-- on_auth_user_deleted | users | AFTER | DELETE
```

---

## 5. Применить Jira OAuth Migration (опционально)

**Файл:** `supabase-migrations/jira-oauth.sql`

Только если используете Jira интеграцию:

1. SQL Editor → New Query
2. Скопировать контент из `supabase-migrations/jira-oauth.sql`
3. Вставить
4. Run

---

## 6. Настроить Auth Providers

### Email/Password (уже включен)
По умолчанию работает.

### Magic Links
1. Dashboard → Authentication → Providers
2. Email → Enable "Confirm email"
3. Сохранить

### Google OAuth
1. Dashboard → Authentication → Providers → Google
2. Enable Google provider
3. Добавить:
   - **Client ID** (из Google Cloud Console)
   - **Client Secret** (из Google Cloud Console)
4. Сохранить

**Как получить Google credentials:**
1. https://console.cloud.google.com
2. Create Project → "QAI"
3. APIs & Services → Credentials
4. Create OAuth 2.0 Client ID
5. Application type: Web application
6. Authorized redirect URIs:
   ```
   https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
   ```
7. Копировать Client ID и Client Secret

### GitHub OAuth
1. Dashboard → Authentication → Providers → GitHub
2. Enable GitHub provider
3. Добавить Client ID и Secret
4. Сохранить

**Как получить GitHub credentials:**
1. https://github.com/settings/developers
2. OAuth Apps → New OAuth App
3. Homepage URL: `http://localhost:3000`
4. Authorization callback URL:
   ```
   https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
   ```
5. Копировать Client ID и Client Secret

---

## 7. Настроить URL Configuration

1. Dashboard → Authentication → URL Configuration
2. **Site URL:**
   - Development: `http://localhost:3000`
   - Production: `https://qai.so`
3. **Redirect URLs** (разрешенные URL для callback):
   ```
   http://localhost:3000/auth/callback
   https://qai.so/auth/callback
   ```
4. Сохранить

---

## 8. Тестирование

### Тест 1: Регистрация через Email

```bash
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123",
    "name": "Test User"
  }'
```

**Проверка в БД:**
```sql
-- Должен появиться в auth.users
SELECT id, email, email_confirmed_at
FROM auth.users
WHERE email = 'test@example.com';

-- И в public.users (автоматически через trigger)
SELECT id, email, name, role, credits
FROM public.users
WHERE email = 'test@example.com';

-- Результат:
-- id   | email              | name      | role | credits
-- uuid | test@example.com   | Test User | user | 0
```

### Тест 2: Вход

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123"
  }'
```

Должен вернуть `access_token` и `refresh_token`.

### Тест 3: Protected Endpoint

```bash
# Использовать access_token из ответа выше
curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

Должен вернуть user profile с credits = 0.

### Тест 4: OAuth через Google

В браузере открыть:
```
http://localhost:3000/api/v1/auth/oauth/google
```

Должно:
1. Редиректить на Google
2. После авторизации → вернуть на `http://localhost:3000/auth/callback#access_token=...`
3. Проверить БД - юзер создан с credits = 0

---

## 9. Troubleshooting

### Ошибка: "permission denied for schema auth"

**Проблема:** Нет прав на создание триггеров в auth схеме

**Решение 1:** Использовать Supabase CLI
```bash
supabase db push
```

**Решение 2:** Выполнить через API с service_role key
```bash
curl -X POST https://YOUR_PROJECT_REF.supabase.co/rest/v1/rpc/exec_sql \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "COPY_ENTIRE_SQL_HERE"}'
```

**Решение 3:** Обратиться в Supabase Support для создания триггера

### Ошибка: "duplicate key value violates unique constraint"

**Проблема:** User уже существует в public.users

**Решение:**
```sql
-- Удалить существующих test users
DELETE FROM public.users WHERE email IN ('admin@qai.so', 'user@qai.so');

-- Или очистить всю таблицу
TRUNCATE public.users CASCADE;
```

### Trigger не срабатывает

**Проверка:**
```sql
-- Создать тестового пользователя напрямую в auth.users
INSERT INTO auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
) VALUES (
  gen_random_uuid(),
  'trigger-test@test.com',
  '$2a$10$dummyhash',
  NOW(),
  '{"name": "Trigger Test"}'::jsonb
);

-- Проверить появился ли в public.users
SELECT * FROM public.users WHERE email = 'trigger-test@test.com';
```

Если НЕ появился:
- Проверить что trigger создан (см. шаг 4)
- Проверить логи функции
- Выполнить функцию вручную для дебага

---

## 10. Production Checklist

Перед запуском в production:

- [ ] Основная схема применена (`supabase-schema.sql`)
- [ ] Auth sync migration применена (`auth-sync.sql`)
- [ ] Триггеры работают (протестировано)
- [ ] Google OAuth настроен (если используется)
- [ ] GitHub OAuth настроен (если используется)
- [ ] Redirect URLs обновлены для production domain
- [ ] Email templates кастомизированы
- [ ] Email provider настроен (SMTP)
- [ ] RLS policies проверены
- [ ] `SUPABASE_JWT_SECRET` добавлен в backend .env
- [ ] Backend задеплоен с новыми переменными

---

## Команды для быстрого старта

```bash
# 1. Убедиться что Supabase проект создан
# 2. Скопировать credentials
cp .env.example .env
# Заполнить SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

# 3. Применить SQL в Supabase Dashboard
# - supabase-schema.sql
# - supabase-migrations/auth-sync.sql

# 4. Добавить JWT Secret в .env
# Dashboard → Settings → API → JWT Secret
echo "SUPABASE_JWT_SECRET=your_jwt_secret" >> .env

# 5. Запустить backend
npm run dev

# 6. Тестировать
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test123"}'
```

---

## Полезные SQL запросы

```sql
-- Посмотреть всех auth users
SELECT id, email, created_at, email_confirmed_at
FROM auth.users
ORDER BY created_at DESC;

-- Посмотреть всех public users
SELECT id, email, name, role, credits, created_at
FROM public.users
ORDER BY created_at DESC;

-- Посмотреть OAuth identities
SELECT user_id, provider, provider_id, created_at
FROM auth.identities
ORDER BY created_at DESC;

-- Проверить синхронизацию (should match)
SELECT
  a.id,
  a.email as auth_email,
  p.email as public_email,
  p.name,
  p.credits
FROM auth.users a
LEFT JOIN public.users p ON a.id = p.id
ORDER BY a.created_at DESC;

-- Удалить тестовых пользователей
DELETE FROM auth.users WHERE email LIKE '%test%';
-- public.users удалится автоматически через trigger
```

---

**Готово!** Следуй инструкциям шаг за шагом.
