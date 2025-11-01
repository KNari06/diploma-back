# Supabase Authentication Setup Guide

## Overview

QAI Backend использует Supabase Auth для полной системы аутентификации с поддержкой:
- Email + Password
- Magic Links (passwordless)
- OAuth (Google, GitHub, GitLab, Bitbucket)
- Автоматическая синхронизация с `public.users`

---

## 1. Database Migration

### Применить миграцию синхронизации

В Supabase Dashboard → SQL Editor выполнить:

```bash
supabase-migrations/auth-sync.sql
```

Это создаст:
- Trigger для автоматической синхронизации `auth.users` → `public.users`
- При регистрации нового юзера → автоматически создается в `public.users` с 100 кредитами
- При обновлении email/name → синхронизация
- При удалении → каскадное удаление

---

## 2. Environment Variables

Добавить в `.env`:

```bash
SUPABASE_JWT_SECRET=your_jwt_secret_from_supabase_settings
```

Получить JWT Secret:
1. Supabase Dashboard → Settings → API
2. Скопировать JWT Secret

---

## 3. Enable Auth Providers (Optional)

### Email/Password (Default)
Уже включен по умолчанию.

### Magic Links
1. Supabase Dashboard → Authentication → Providers
2. Email → Enable "Email OTP"

### OAuth Providers

#### Google
1. Supabase Dashboard → Authentication → Providers → Google
2. Создать OAuth App в Google Cloud Console
3. Добавить Client ID и Secret
4. Redirect URL: `https://your-project.supabase.co/auth/v1/callback`

#### GitHub
1. Supabase Dashboard → Authentication → Providers → GitHub
2. Создать OAuth App в GitHub Settings
3. Добавить Client ID и Secret
4. Redirect URL: `https://your-project.supabase.co/auth/v1/callback`

---

## 4. API Endpoints

### Public Endpoints (без auth)

```bash
POST /api/v1/auth/signup       # Регистрация
POST /api/v1/auth/login        # Вход
POST /api/v1/auth/magic-link   # Magic link
GET  /api/v1/auth/oauth/:provider  # OAuth redirect
POST /api/v1/auth/refresh      # Обновить токен
```

### Protected Endpoints (требуют Bearer token)

```bash
GET  /api/v1/auth/me               # Текущий пользователь
POST /api/v1/auth/logout           # Выход
POST /api/v1/auth/password/update  # Изменить пароль

# Все остальные endpoints требуют auth:
POST /api/v1/tests/run             # Создать тест
GET  /api/v1/tests/:id             # Получить тест
POST /api/v1/chat                  # AI chat
POST /api/v1/api-test/run          # API test
GET  /api/v1/jira/projects         # Jira projects
```

---

## 5. Usage Examples

### 5.1 Register User

```bash
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "John Doe"
  }'
```

Response:
```json
{
  "success": true,
  "message": "User registered successfully. Please check your email for verification.",
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "role": "user"
    },
    "tokens": {
      "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expires_in": 3600
    }
  }
}
```

### 5.2 Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

### 5.3 Use Protected Endpoint

```bash
curl -X POST http://localhost:3000/api/v1/tests/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "url": "https://example.com",
    "browsers": ["chrome"],
    "projectId": "project-uuid"
  }'
```

### 5.4 Refresh Token

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "YOUR_REFRESH_TOKEN"
  }'
```

### 5.5 Magic Link

```bash
curl -X POST http://localhost:3000/api/v1/auth/magic-link \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "redirectTo": "http://localhost:3000/auth/verify"
  }'
```

### 5.6 OAuth (Google)

```bash
# Redirect user to:
GET http://localhost:3000/api/v1/auth/oauth/google

# Or with custom redirect:
GET http://localhost:3000/api/v1/auth/oauth/google?redirectTo=http://localhost:3000/dashboard
```

---

## 6. Frontend Integration

### Store Tokens

```typescript
// After login/signup
const { access_token, refresh_token, expires_in } = response.data.tokens;

// Store in localStorage or cookie
localStorage.setItem('access_token', access_token);
localStorage.setItem('refresh_token', refresh_token);
```

### Add to Requests

```typescript
const response = await fetch('http://localhost:3000/api/v1/tests/run', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`
  },
  body: JSON.stringify({ ... })
});
```

### Handle 401 Errors

```typescript
if (response.status === 401) {
  // Try refresh token
  const refreshResponse = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: localStorage.getItem('refresh_token') })
  });

  if (refreshResponse.ok) {
    const { access_token } = await refreshResponse.json();
    localStorage.setItem('access_token', access_token);
    // Retry original request
  } else {
    // Redirect to login
    window.location.href = '/login';
  }
}
```

---

## 7. Security Features

### Automatic Protection

- **JWT Verification**: Все protected routes автоматически проверяют токен
- **User Injection**: `req.user` автоматически доступен в контроллерах
- **Credit Check**: `requireCredits(n)` middleware проверяет баланс перед действием
- **Role Check**: `requireAdmin` middleware для admin endpoints

### Rate Limiting

Supabase Auth автоматически применяет rate limiting:
- 30 регистраций в час с одного IP
- 10 magic links в час на email
- 30 password resets в час

### Password Security

- Минимум 6 символов (можно увеличить в валидации)
- Bcrypt хэширование (автоматически через Supabase)
- Password reset flow

---

## 8. User Synchronization

### Как работает

1. Пользователь регистрируется через `/auth/signup`
2. Supabase создает юзера в `auth.users`
3. Trigger `on_auth_user_created` срабатывает
4. Автоматически создается запись в `public.users` с:
   - `id` = auth user id
   - `email` = auth email
   - `name` = из metadata или email
   - `role` = 'user'
   - `credits` = 100 (initial bonus)

### Поля синхронизации

- `id` → всегда синхронизируется
- `email` → синхронизируется при UPDATE
- `name` → синхронизируется из metadata
- `role`, `credits`, `subscription` → управляются только в `public.users`

---

## 9. Testing Auth

### Test Signup

```bash
npm run dev

curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test123","name":"Test User"}'
```

### Check Database

```sql
-- Check auth.users
SELECT id, email, created_at FROM auth.users;

-- Check public.users (should be synced)
SELECT id, email, name, role, credits FROM public.users;
```

### Test Protected Endpoint

```bash
# Get access token from signup/login response
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Use protected endpoint
curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

---

## 10. Troubleshooting

### "Invalid JWT" Error
- Проверь что `SUPABASE_JWT_SECRET` правильный
- Проверь что токен не истек
- Попробуй refresh token

### User Not Syncing to public.users
- Проверь что trigger создан: `SELECT * FROM pg_trigger WHERE tgname = 'on_auth_user_created';`
- Проверь логи функции
- Убедись что RLS не блокирует INSERT

### OAuth Not Working
- Проверь что провайдер включен в Supabase Dashboard
- Проверь redirect URLs
- Проверь Client ID/Secret

---

## 11. Next Steps

После настройки auth:

1. **Протестировать все auth flows** (signup, login, magic link, OAuth)
2. **Проверить синхронизацию** в БД
3. **Протестировать protected endpoints** с валидным/невалидным токенами
4. **Настроить email templates** в Supabase (опционально)
5. **Добавить rate limiting per user** (будущее)

---

## 12. Production Checklist

Before deploying:

- [ ] `SUPABASE_JWT_SECRET` установлен
- [ ] Email provider настроен (SMTP или встроенный)
- [ ] OAuth провайдеры настроены
- [ ] Redirect URLs обновлены для production
- [ ] Email templates кастомизированы
- [ ] RLS политики проверены
- [ ] Trigger синхронизации работает
- [ ] Rate limiting проверен

---

**Документация:** https://supabase.com/docs/guides/auth
**Swagger UI:** http://localhost:3000/api/docs
