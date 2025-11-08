# 🚀 Anonymous User Flow - Quick Guide for Frontend

## 📋 Overview

Анонимные пользователи могут использовать чат без регистрации (до 3 запросов). При регистрации все их данные автоматически мигрируют.

---

## 🎯 Implementation Steps

### 1. Generate & Store Anonymous ID

```typescript
// utils/anonymousId.ts
export const getAnonymousId = (): string => {
  const key = 'qai_anonymous_id';
  let id = localStorage.getItem(key);

  if (!id) {
    // Generate unique ID: project_{timestamp}_{random}
    id = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(key, id);
  }

  return id;
};

export const clearAnonymousId = () => {
  localStorage.removeItem('qai_anonymous_id');
};
```

---

### 2. Send Messages (Anonymous/Authenticated)

```typescript
// api/chat.ts
import { getAnonymousId } from '@/utils/anonymousId';

export const sendChatMessage = async (message: string, token?: string) => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  // Add auth token if user is authenticated
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message,
      context: {
        projectId: getAnonymousId() // Always send for consistency
      }
    })
  });

  const data = await response.json();

  // Check rate limit for anonymous users
  if (data.rateLimitInfo?.isAnonymous) {
    return {
      ...data,
      shouldShowAuthPrompt: data.rateLimitInfo.remaining <= 1
    };
  }

  return data;
};
```

---

### 3. Show Rate Limit Warning

```typescript
// components/ChatInput.tsx
const ChatInput = () => {
  const [rateLimit, setRateLimit] = useState<{remaining: number, limit: number} | null>(null);

  const handleSend = async (message: string) => {
    const result = await sendChatMessage(message);

    if (result.rateLimitInfo?.isAnonymous) {
      setRateLimit({
        remaining: result.rateLimitInfo.remaining,
        limit: result.rateLimitInfo.limit
      });

      // Show auth modal if limit reached
      if (result.shouldShowAuthPrompt) {
        showAuthModal();
      }
    }
  };

  return (
    <div>
      {rateLimit && (
        <div className="rate-limit-warning">
          ⚠️ Осталось {rateLimit.remaining} из {rateLimit.limit} сообщений.
          <button onClick={showAuthModal}>Войти</button>
        </div>
      )}
      {/* ... input field */}
    </div>
  );
};
```

---

### 4. Signup with Migration

```typescript
// api/auth.ts
import { getAnonymousId, clearAnonymousId } from '@/utils/anonymousId';

export const signup = async (email: string, password: string, name?: string) => {
  const response = await fetch('/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      name,
      anonymousId: getAnonymousId() // ✅ Include for migration
    })
  });

  const data = await response.json();

  if (data.success) {
    // Show migration results to user
    if (data.data.migration?.migrated) {
      const { chat_sessions, chat_messages, api_environments } = data.data.migration.migrated;
      showNotification(`✅ Импортировано: ${chat_messages} сообщений, ${api_environments} API конфигураций`);
    }

    // Clear anonymous ID after successful migration
    clearAnonymousId();

    // Store tokens
    localStorage.setItem('access_token', data.data.tokens.access_token);
    localStorage.setItem('refresh_token', data.data.tokens.refresh_token);
  }

  return data;
};
```

---

### 5. Login with Migration

```typescript
export const login = async (email: string, password: string) => {
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      anonymousId: getAnonymousId() // ✅ Include for migration
    })
  });

  const data = await response.json();

  if (data.success) {
    // Same migration handling as signup
    if (data.data.migration?.migrated) {
      const counts = data.data.migration.migrated;
      if (counts.chat_messages > 0 || counts.api_environments > 0) {
        showNotification(`✅ Ваши данные восстановлены!`);
      }
    }

    clearAnonymousId();
    localStorage.setItem('access_token', data.data.tokens.access_token);
    localStorage.setItem('refresh_token', data.data.tokens.refresh_token);
  }

  return data;
};
```

---

## 🎨 UI/UX Recommendations

### Rate Limit Indicator

```tsx
// Show remaining requests visually
<div className="rate-limit-badge">
  {isAnonymous && (
    <>
      <span className="icon">🔓</span>
      <span className="text">{remaining}/3</span>
    </>
  )}
</div>
```

### Auth Prompt Modal

```tsx
// When user reaches limit
<Modal isOpen={showAuthPrompt}>
  <h2>🚀 Хотите продолжить?</h2>
  <p>Вы использовали все 3 бесплатных запроса.</p>
  <p>Зарегистрируйтесь, чтобы:</p>
  <ul>
    <li>✅ Получить неограниченный доступ</li>
    <li>✅ Сохранить историю чата</li>
    <li>✅ Импортировать ваши данные автоматически</li>
  </ul>
  <button onClick={handleSignup}>Регистрация</button>
  <button onClick={handleLogin}>Вход</button>
</Modal>
```

### Migration Success Notification

```tsx
// After successful signup/login with migration
<Notification type="success">
  <h3>✅ Добро пожаловать!</h3>
  <p>Импортировано:</p>
  <ul>
    <li>{chat_messages} сообщений</li>
    <li>{api_environments} API конфигураций</li>
  </ul>
</Notification>
```

---

## 📊 Response Examples

### Anonymous Chat Response

```json
{
  "reply": "✅ Запрос выполнен...",
  "timestamp": "2025-11-06T10:30:00Z",
  "rateLimitInfo": {
    "isAnonymous": true,
    "limit": 3,
    "remaining": 1,
    "message": "💡 У вас осталось 1 сообщение. Авторизуйтесь для неограниченного доступа."
  }
}
```

### Signup with Migration Response

```json
{
  "success": true,
  "message": "User registered successfully...",
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "name": "User Name"
    },
    "tokens": {
      "access_token": "...",
      "refresh_token": "..."
    },
    "migration": {
      "success": true,
      "migrated": {
        "chat_sessions": 1,
        "chat_messages": 4,
        "api_environments": 2,
        "api_endpoints": 3
      }
    }
  }
}
```

### Rate Limit Exceeded (429)

```json
{
  "success": false,
  "error": "Rate limit exceeded. Please sign in for unlimited access.",
  "rateLimitInfo": {
    "limit": 3,
    "remaining": 0,
    "resetAt": "2025-11-06T11:00:00Z"
  }
}
```

---

## 🔄 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Anonymous User Flow                       │
└─────────────────────────────────────────────────────────────┘

1. User opens app (no auth)
   ├─ Generate anonymousId: "project_12345_abc"
   └─ Store in localStorage

2. User sends messages (1/3, 2/3, 3/3)
   ├─ POST /api/v1/chat
   ├─ Backend tracks: anonymous_usage_limits
   └─ Backend stores: anonymous_chat_sessions/messages

3. Rate limit reached (3/3)
   ├─ Show auth prompt modal
   └─ Encourage registration

4. User signs up
   ├─ POST /api/v1/auth/signup
   │  └─ body: { email, password, anonymousId }
   ├─ Backend migrates data:
   │  ├─ anonymous_chat_sessions → linked to user_id
   │  ├─ anonymous_chat_messages → preserved
   │  ├─ api_environments → user_id updated
   │  └─ anonymous_usage_limits → deleted
   └─ Response includes migration counts

5. Frontend handles success
   ├─ Clear anonymousId from localStorage
   ├─ Store access_token
   ├─ Show migration results
   └─ Reload chat with full history

6. User continues (unlimited)
   ├─ Authenticated requests
   └─ Credit-based rate limiting
```

---

## ✅ Checklist for Frontend Developers

- [ ] Generate and persist `anonymousId` on first visit
- [ ] Include `anonymousId` in all chat requests (authenticated or not)
- [ ] Show rate limit indicator for anonymous users
- [ ] Display auth prompt when limit is reached
- [ ] Send `anonymousId` with signup/login requests
- [ ] Handle migration response and show results
- [ ] Clear `anonymousId` after successful auth
- [ ] Test complete flow: anonymous → signup → data verification

---

## 🐛 Troubleshooting

### Data not migrated after signup?

```typescript
// Check if anonymousId was sent
console.log('Signup payload:', {
  email,
  password,
  anonymousId: getAnonymousId() // Should not be null
});

// Check response
console.log('Migration result:', data.data.migration);
```

### Rate limit not working?

```typescript
// Verify anonymousId format
const id = getAnonymousId();
console.log('AnonymousId:', id);
// Should be: "project_1234567890_abc123"

// Check context in request
console.log('Chat payload:', {
  message,
  context: { projectId: id }
});
```

### Migration shows 0 items?

- Anonymous user might not have sent messages before signup
- Check database: `SELECT * FROM anonymous_chat_sessions WHERE anonymous_id = 'project_...'`
- Verify `anonymousId` is consistent across requests

---

## 📚 Full Documentation

Detailed technical docs: [`docs/development/anonymous-user-migration.md`](./docs/development/anonymous-user-migration.md)

---

**Questions?** Contact: dev@qai.so
