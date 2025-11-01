# OAuth Flow через Google - Step by Step

## Общая схема

```
User → Frontend → Backend → Supabase → Google → Supabase → Backend → Frontend → User
```

---

## Детальный Flow

### Step 1: Пользователь нажимает "Sign in with Google"

**Frontend:**
```typescript
// User clicks "Login with Google" button
window.location.href = 'http://localhost:3000/api/v1/auth/oauth/google';
```

**Что происходит:**
- GET запрос на backend endpoint `/api/v1/auth/oauth/google`

---

### Step 2: Backend генерирует OAuth URL

**Backend:** `src/api/auth/auth.controller.ts` → `getOAuthUrlHandler()`

```typescript
// 1. Получает provider из URL params: "google"
const provider = 'google';

// 2. Вызывает Supabase Auth API
const { data } = await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: 'http://localhost:3000/auth/callback' // Your frontend callback
  }
});

// 3. Получает OAuth URL от Supabase
// Пример: https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...
```

**Что происходит:**
- Supabase генерирует специальный URL для Google OAuth
- Backend делает 302 redirect на этот URL
- Браузер пользователя перенаправляется на Google

---

### Step 3: Пользователь на странице Google

**Google OAuth Screen:**
```
┌─────────────────────────────────┐
│  Sign in with Google            │
│                                 │
│  QAI wants to access:           │
│  ✓ Your email                   │
│  ✓ Your name                    │
│  ✓ Your profile picture         │
│                                 │
│  [ user@gmail.com ▼ ]          │
│                                 │
│  [Cancel]  [Allow]              │
└─────────────────────────────────┘
```

**Что происходит:**
- Пользователь видит consent screen
- Выбирает аккаунт Google
- Нажимает "Allow"

---

### Step 4: Google редиректит обратно в Supabase

**Google redirect:**
```
https://YOUR_PROJECT.supabase.co/auth/v1/callback?
  code=GOOGLE_AUTH_CODE
  &state=RANDOM_STATE
```

**Что происходит:**
- Google отправляет authorization code в Supabase
- Supabase обменивает code на Google access token
- Supabase получает user profile от Google (email, name, picture)

---

### Step 5: Supabase создает/находит пользователя

**Supabase Auth внутренняя логика:**

```sql
-- 1. Проверяет существует ли user с таким email
SELECT * FROM auth.users WHERE email = 'user@gmail.com';

-- Если НЕ существует:
-- 2. Создает нового user в auth.users
INSERT INTO auth.users (
  id,
  email,
  raw_user_meta_data
) VALUES (
  gen_random_uuid(),
  'user@gmail.com',
  '{"name": "John Doe", "avatar_url": "https://..."}'::jsonb
);

-- 3. Создает identity (связь с Google)
INSERT INTO auth.identities (
  user_id,
  provider,
  provider_id,
  identity_data
) VALUES (...);
```

**Что происходит:**
- Supabase автоматически создает user в `auth.users`
- Сохраняет Google ID для future logins
- Генерирует JWT tokens (access + refresh)

---

### Step 6: Trigger синхронизирует в public.users

**Database Trigger:** `sync_user_to_public()`

```sql
-- Автоматически срабатывает после INSERT/UPDATE в auth.users
INSERT INTO public.users (
  id,        -- UUID из auth.users
  email,     -- user@gmail.com
  name,      -- "John Doe" из Google metadata
  role,      -- 'user' по умолчанию
  credits,   -- 0 (без начальных кредитов)
  created_at,
  updated_at
) VALUES (...);
```

**Что происходит:**
- Trigger срабатывает автоматически
- Создается запись в `public.users`
- Пользователь готов к использованию API

---

### Step 7: Supabase редиректит на Frontend

**Supabase redirect:**
```
http://localhost:3000/auth/callback#
  access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  &refresh_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  &expires_in=3600
  &token_type=bearer
```

**Что происходит:**
- Supabase редиректит обратно на ваш frontend
- Токены передаются в URL hash (после `#`)
- Frontend может извлечь токены

---

### Step 8: Frontend обрабатывает callback

**Frontend:** (пример на React/Next.js)

```typescript
// pages/auth/callback.tsx
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    // 1. Извлечь токены из URL hash
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);

    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    const expires_in = params.get('expires_in');

    if (access_token && refresh_token) {
      // 2. Сохранить токены
      localStorage.setItem('access_token', access_token);
      localStorage.setItem('refresh_token', refresh_token);

      // 3. Опционально: получить user data
      fetch('http://localhost:3000/api/v1/auth/me', {
        headers: {
          'Authorization': `Bearer ${access_token}`
        }
      })
      .then(res => res.json())
      .then(data => {
        console.log('Logged in user:', data);
        // Сохранить в state/context
      });

      // 4. Редирект на dashboard
      router.push('/dashboard');
    } else {
      // Error handling
      router.push('/login?error=oauth_failed');
    }
  }, []);

  return <div>Logging you in...</div>;
}
```

**Что происходит:**
- Frontend извлекает токены из URL
- Сохраняет в localStorage/cookies
- Получает user data с backend
- Редиректит на главную страницу

---

### Step 9: Использование API с токеном

**Frontend API calls:**

```typescript
// Все последующие запросы используют access_token
const response = await fetch('http://localhost:3000/api/v1/tests/run', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`
  },
  body: JSON.stringify({
    url: 'https://example.com',
    browsers: ['chrome'],
    projectId: 'uuid'
  })
});
```

**Backend:**
```typescript
// Middleware автоматически:
// 1. Извлекает token из Authorization header
// 2. Проверяет через Supabase
// 3. Добавляет req.user = { id, email, name, role }
// 4. Controller использует req.user.id
```

---

## Полная диаграмма последовательности

```
┌──────┐      ┌──────────┐      ┌─────────┐      ┌─────────┐      ┌────────┐
│ User │      │ Frontend │      │ Backend │      │Supabase │      │ Google │
└──┬───┘      └────┬─────┘      └────┬────┘      └────┬────┘      └───┬────┘
   │               │                  │                │               │
   │ 1. Click      │                  │                │               │
   │  "Google"     │                  │                │               │
   ├──────────────>│                  │                │               │
   │               │                  │                │               │
   │               │ 2. GET /oauth/google              │               │
   │               ├─────────────────>│                │               │
   │               │                  │                │               │
   │               │                  │ 3. signInWithOAuth()           │
   │               │                  ├───────────────>│               │
   │               │                  │                │               │
   │               │                  │ 4. OAuth URL   │               │
   │               │                  │<───────────────┤               │
   │               │                  │                │               │
   │               │ 5. 302 Redirect  │                │               │
   │               │<─────────────────┤                │               │
   │               │                  │                │               │
   │               │ 6. Redirect to Google OAuth       │               │
   │               ├──────────────────────────────────────────────────>│
   │               │                  │                │               │
   │ 7. Google     │                  │                │               │
   │    Login      │                  │                │               │
   │<──────────────────────────────────────────────────────────────────┤
   │               │                  │                │               │
   │ 8. Allow      │                  │                │               │
   ├──────────────────────────────────────────────────────────────────>│
   │               │                  │                │               │
   │               │                  │                │ 9. Callback   │
   │               │                  │                │   with code   │
   │               │                  │                │<──────────────┤
   │               │                  │                │               │
   │               │                  │                │ 10. Exchange  │
   │               │                  │                │     code for  │
   │               │                  │                │     token     │
   │               │                  │                ├──────────────>│
   │               │                  │                │               │
   │               │                  │                │ 11. User data │
   │               │                  │                │<──────────────┤
   │               │                  │                │               │
   │               │                  │                │ 12. Create    │
   │               │                  │                │     user in   │
   │               │                  │                │  auth.users   │
   │               │                  │                │               │
   │               │                  │ 13. TRIGGER: sync_user_to_public()
   │               │                  │                │     ↓         │
   │               │                  │                │  Creates in   │
   │               │                  │                │  public.users │
   │               │                  │                │               │
   │               │ 14. Redirect with tokens          │               │
   │               │<───────────────────────────────────┤               │
   │               │ http://localhost:3000/auth/callback#              │
   │               │   access_token=...&refresh_token=...              │
   │               │                  │                │               │
   │ 15. Extract   │                  │                │               │
   │     tokens    │                  │                │               │
   │<──────────────┤                  │                │               │
   │               │                  │                │               │
   │               │ 16. GET /auth/me │                │               │
   │               ├─────────────────>│                │               │
   │               │                  │                │               │
   │               │                  │ 17. Verify JWT │               │
   │               │                  ├───────────────>│               │
   │               │                  │                │               │
   │               │                  │ 18. User data  │               │
   │               │                  │<───────────────┤               │
   │               │                  │                │               │
   │               │ 19. User profile │                │               │
   │               │<─────────────────┤                │               │
   │               │ { id, email, name, credits, ... } │               │
   │               │                  │                │               │
   │ 20. Show      │                  │                │               │
   │  dashboard    │                  │                │               │
   │<──────────────┤                  │                │               │
```

---

## Детальное описание каждого шага

### Step 1-2: Инициация OAuth
**Место:** Frontend
**Что:** User кликает кнопку → браузер делает GET запрос на backend

```typescript
// Frontend code
<button onClick={() => window.location.href = '/api/v1/auth/oauth/google'}>
  Sign in with Google
</button>
```

---

### Step 3-4: Backend запрашивает OAuth URL у Supabase
**Место:** `src/api/auth/auth.controller.ts`
**Функция:** `getOAuthUrlHandler()`

```typescript
const { data } = await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: 'http://localhost:3000/auth/callback'
  }
});
// data.url = "https://accounts.google.com/o/oauth2/v2/auth?..."
```

**Supabase возвращает:**
```
https://accounts.google.com/o/oauth2/v2/auth?
  client_id=YOUR_GOOGLE_CLIENT_ID
  &redirect_uri=https://YOUR_PROJECT.supabase.co/auth/v1/callback
  &response_type=code
  &scope=openid email profile
  &state=RANDOM_STATE_FOR_SECURITY
```

---

### Step 5-6: Redirect на Google
**Место:** Browser
**Что:** Backend отправляет 302 redirect → браузер открывает Google OAuth

```http
HTTP/1.1 302 Found
Location: https://accounts.google.com/o/oauth2/v2/auth?client_id=...
```

---

### Step 7-8: Google Authentication
**Место:** Google Servers
**Что:**
1. Пользователь выбирает Google аккаунт
2. Видит consent screen (какие данные будут доступны)
3. Нажимает "Allow"

**Google генерирует:**
- Authorization Code (одноразовый)
- State parameter (для безопасности)

---

### Step 9: Google → Supabase Callback
**Место:** Google → Supabase
**Что:** Google редиректит на Supabase callback URL

```
https://YOUR_PROJECT.supabase.co/auth/v1/callback?
  code=4/0AY0e-g7xyzABC123...
  &state=abc123def456
```

---

### Step 10-11: Supabase обменивает code на токены
**Место:** Supabase Backend (автоматически)
**Что:**

```typescript
// Supabase делает POST запрос к Google:
POST https://oauth2.googleapis.com/token
{
  client_id: "GOOGLE_CLIENT_ID",
  client_secret: "GOOGLE_CLIENT_SECRET",
  code: "4/0AY0e-g7xyzABC123...",
  grant_type: "authorization_code",
  redirect_uri: "https://YOUR_PROJECT.supabase.co/auth/v1/callback"
}

// Google возвращает:
{
  access_token: "ya29.a0AfH6SMBxyz...",  // Google access token
  id_token: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk...",  // JWT с user info
  expires_in: 3599,
  scope: "openid email profile",
  token_type: "Bearer"
}
```

Supabase декодирует `id_token` и получает:
```json
{
  "sub": "117234567890123456789",  // Google user ID
  "email": "user@gmail.com",
  "email_verified": true,
  "name": "John Doe",
  "picture": "https://lh3.googleusercontent.com/..."
}
```

---

### Step 12: Supabase создает User в auth.users
**Место:** Supabase Auth
**Что:**

```sql
-- Проверка существующего user
SELECT * FROM auth.users WHERE email = 'user@gmail.com';

-- Если НЕ существует - создает нового
INSERT INTO auth.users (
  id,
  email,
  email_confirmed_at,  -- Сразу confirmed (Google проверил)
  raw_user_meta_data,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'user@gmail.com',
  NOW(),
  '{"name": "John Doe", "avatar_url": "https://...", "provider": "google"}'::jsonb,
  NOW(),
  NOW()
);

-- Создает identity (связь с Google)
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  user_id,
  '{"sub": "117234567890123456789", "email": "user@gmail.com", ...}'::jsonb,
  'google',
  '117234567890123456789',  -- Google user ID
  NOW(),
  NOW(),
  NOW()
);
```

---

### Step 13: Trigger синхронизирует в public.users

**Место:** PostgreSQL Trigger
**Файл:** `supabase-migrations/auth-sync.sql`
**Функция:** `sync_user_to_public()`

```sql
-- Автоматически срабатывает AFTER INSERT ON auth.users
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_to_public();

-- Функция выполняет:
INSERT INTO public.users (
  id,                    -- UUID из auth.users
  email,                 -- user@gmail.com
  name,                  -- "John Doe"
  role,                  -- 'user'
  credits,               -- 0
  created_at,
  updated_at
) VALUES (...)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  name = COALESCE(EXCLUDED.name, public.users.name),
  updated_at = NOW();
```

**Результат:**
```sql
-- Теперь user существует в обеих таблицах:

SELECT * FROM auth.users WHERE email = 'user@gmail.com';
-- id | email              | email_confirmed_at | raw_user_meta_data
-- uuid | user@gmail.com   | 2025-11-01...     | {"name": "John Doe", ...}

SELECT * FROM public.users WHERE email = 'user@gmail.com';
-- id   | email            | name      | role  | credits
-- uuid | user@gmail.com   | John Doe  | user  | 0
```

---

### Step 14: Supabase генерирует JWT и редиректит

**Место:** Supabase
**Что:** Генерирует собственные JWT токены и редиректит

```typescript
// Supabase создает JWT
const access_token = jwt.sign({
  sub: user.id,
  email: user.email,
  role: 'authenticated',
  aal: 'aal1',
  ...
}, SUPABASE_JWT_SECRET, { expiresIn: '1h' });

const refresh_token = jwt.sign({
  ...
}, SUPABASE_JWT_SECRET, { expiresIn: '30d' });

// Redirect на frontend callback
res.redirect(`http://localhost:3000/auth/callback#access_token=${access_token}&refresh_token=${refresh_token}&expires_in=3600&token_type=bearer`);
```

---

### Step 15-16: Frontend сохраняет токены и получает user data

**Место:** Frontend
**Что:**

```typescript
// 1. Parse tokens from URL hash
const access_token = params.get('access_token');
localStorage.setItem('access_token', access_token);

// 2. Get full user profile from backend
const response = await fetch('/api/v1/auth/me', {
  headers: { 'Authorization': `Bearer ${access_token}` }
});

const user = await response.json();
// {
//   id: "uuid",
//   email: "user@gmail.com",
//   name: "John Doe",
//   role: "user",
//   credits: 0,
//   subscription: null,
//   created_at: "2025-11-01..."
// }
```

---

### Step 17-18: Backend проверяет JWT

**Место:** Backend Middleware
**Файл:** `src/middleware/auth.middleware.ts`

```typescript
// 1. Extract token
const token = req.headers.authorization.replace('Bearer ', '');

// 2. Verify через Supabase
const { data, error } = await supabase.auth.getUser(token);

// 3. Supabase проверяет:
//    - Signature (JWT_SECRET)
//    - Expiration (expires_in)
//    - User exists в auth.users

// 4. Получает доп данные из public.users
const { data: userData } = await supabaseAdmin
  .from('users')
  .select('role, name, credits')
  .eq('id', data.user.id)
  .single();

// 5. Attach to request
req.user = {
  id: data.user.id,
  email: data.user.email,
  name: userData.name,
  role: userData.role
};
```

---

### Step 19-20: User использует приложение

**Место:** Frontend → Backend
**Что:** Все API calls используют access_token

```typescript
// Любой protected endpoint
fetch('/api/v1/tests/run', {
  headers: {
    'Authorization': `Bearer ${access_token}`
  }
});

// Backend middleware автоматически:
// - Проверяет токен
// - Добавляет req.user
// - Controller использует req.user.id
```

---

## Важные моменты

### 1. Email уже занят
Если user с таким email уже существует (зарегистрировался через Email/Password):
- Supabase **НЕ создаст** нового user
- Вернет ошибку "Email already registered"
- Нужно использовать existing login метод

### 2. Linking Providers
Если нужно чтобы один user мог входить через Email И Google:
- Включить "Allow multiple accounts with same email" в Supabase
- Или использовать Supabase `linkIdentity()` API

### 3. Token Lifetime
- **Access Token:** 1 час (3600 сек)
- **Refresh Token:** 30 дней
- Frontend должен обновлять токен через `/auth/refresh`

### 4. Security
- OAuth flow защищен через `state` parameter (CSRF protection)
- JWT подписаны с `SUPABASE_JWT_SECRET`
- Tokens передаются через secure HTTPS (в production)

---

## FAQ

**Q: Где хранятся Google credentials?**
A: В Supabase Dashboard → Authentication → Providers → Google

**Q: Нужно ли что-то делать в backend для OAuth?**
A: Нет, Supabase полностью обрабатывает OAuth flow. Backend только генерирует начальный URL.

**Q: Как user входит второй раз через Google?**
A: Точно так же: клик на "Google" → Supabase проверяет `identities` таблицу → находит existing user → возвращает токены.

**Q: Что если user удалит аккаунт Google?**
A: Identity останется в БД, но user не сможет войти через Google. Нужно использовать другой метод или re-link.

**Q: Можно ли получить Google access token для API calls?**
A: Да, можно через `supabase.auth.getSession()` → `provider_token` в frontend.

---

## Конфигурация Supabase (Checklist)

В Supabase Dashboard нужно:

1. **Authentication → Providers**
   - [x] Email - Enabled
   - [ ] Google - Configure (Client ID + Secret)
   - [ ] GitHub - Configure (Client ID + Secret)
   - [ ] GitLab - Configure (optional)
   - [ ] Bitbucket - Configure (optional)

2. **Authentication → URL Configuration**
   - Site URL: `http://localhost:3000` (dev) / `https://qai.so` (prod)
   - Redirect URLs:
     - `http://localhost:3000/auth/callback`
     - `https://qai.so/auth/callback`

3. **Authentication → Email Templates**
   - Customize templates (optional)
   - Set From email

4. **SQL Editor**
   - Execute `supabase-migrations/auth-sync.sql`

---

**Готово!** OAuth через Google настроен и работает автоматически.
