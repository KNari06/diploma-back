# Quick Start - Auth Setup

## Что нужно сделать сейчас

### 1. Выполнить SQL в Supabase

**Где:** Supabase Dashboard → SQL Editor

**Что:**
```sql
-- Удалить старые sample users (если были)
DELETE FROM users WHERE email IN ('admin@qai.so', 'user@qai.so');
DELETE FROM projects WHERE user_id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
);
```

Затем выполнить весь файл:
```
supabase-migrations/auth-sync.sql
```

**Результат:** `Success. No rows returned`

---

### 2. Добавить в .env

```bash
FRONTEND_URL=http://localhost:3000
```

(SUPABASE_JWT_SECRET опционален, Supabase сам управляет JWT)

---

### 3. Restart backend

```bash
npm run dev
```

---

### 4. Создать первого пользователя

```bash
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@test.com",
    "password": "test123",
    "name": "Test User"
  }'
```

**Ожидается:**
```json
{
  "success": true,
  "message": "User registered successfully...",
  "data": {
    "user": {
      "id": "uuid",
      "email": "test@test.com",
      "name": "Test User",
      "role": "user"
    },
    "tokens": {
      "access_token": "eyJhbGci...",
      "refresh_token": "eyJhbGci...",
      "expires_in": 3600
    }
  }
}
```

---

### 5. Проверить в БД

```sql
-- Должен быть в auth.users
SELECT id, email, created_at FROM auth.users;

-- И в public.users (через trigger)
SELECT id, email, name, role, credits FROM public.users;
```

**Результат:**
- Одинаковый UUID в обеих таблицах
- credits = 0
- role = 'user'

---

### 6. Использовать защищенный endpoint

```bash
TOKEN="ваш_access_token_из_шага_4"

curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

**Ожидается:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "test@test.com",
    "name": "Test User",
    "role": "user",
    "credits": 0,
    "subscription": null
  }
}
```

---

### 7. Проверить credits check

```bash
curl -X POST http://localhost:3000/api/v1/tests/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "browsers": ["chrome"],
    "projectId": "00000000-0000-0000-0000-000000000001"
  }'
```

**Ожидается:**
```json
{
  "success": false,
  "error": "Insufficient credits",
  "message": "You need at least 1 credits to perform this action. Current: 0"
}
```

✅ Это правильно! Credits check работает.

---

## Если хочешь протестировать с кредитами

Добавить кредиты вручную:
```sql
UPDATE users
SET credits = 10
WHERE email = 'test@test.com';
```

Теперь запуск теста пройдет.

---

## Админ (когда понадобится)

Когда будет нужен админ аккаунт:

1. Зарегистрировать через API
2. Вручную обновить роль:
```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

---

## Готово!

После выполнения `auth-sync.sql`:
- ✅ Регистрация работает
- ✅ Вход работает
- ✅ Синхронизация автоматическая
- ✅ Protected endpoints работают
- ✅ Credits check работает
- ✅ OAuth готов (если настроишь провайдеры)

Вся документация в:
- `SUPABASE_SETUP_INSTRUCTIONS.md` - полная инструкция
- `OAUTH_FLOW_EXPLANATION.md` - как работает OAuth
- `AUTH_FILES_CHECK.md` - проверка всех файлов
