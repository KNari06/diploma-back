# 🔗 Frontend Integration Guide

## Anonymous User Flow - Backend API Reference

---

## 📋 Overview

Backend поддерживает работу с анонимными пользователями через:
- ✅ `X-Anonymous-Id` заголовок (рекомендуется для фронтенда) **← CORS настроен!**
- ✅ `context.projectId` в body (для POST запросов)
- ✅ `anonymousId` query параметр (альтернатива)

### ✅ CORS Configuration

Backend настроен на поддержку следующих заголовков:
```
Backend URL: http://localhost:3001
Access-Control-Allow-Headers: Content-Type, Authorization, X-User-ID, X-Anonymous-Id
Access-Control-Allow-Origin: http://localhost:8080 (development)
Access-Control-Allow-Credentials: true
```

**Заголовок `X-Anonymous-Id` разрешён и готов к использованию!**

---

## 🔐 Authentication Methods

### 1. Authenticated User
```javascript
Headers: {
  'Authorization': 'Bearer eyJhbGc...'
}
```

### 2. Anonymous User
```javascript
Headers: {
  'X-Anonymous-Id': 'project_1730969245_abc123'
}
```

---

## 🎯 API Endpoints

### 📬 POST `/api/v1/chat` - Send Message

**Anonymous Request:**
```javascript
fetch('/api/v1/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Anonymous-Id': 'project_1730969245_abc123'
  },
  body: JSON.stringify({
    message: "Test API https://example.com/api",
    context: {
      environment: "Staging",
      projectId: "project_1730969245_abc123"  // ← Same as header
    }
  })
});
```

**Authenticated Request:**
```javascript
fetch('/api/v1/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer eyJhbGc...'
  },
  body: JSON.stringify({
    message: "Test API https://example.com/api",
    context: {
      environment: "Staging"
      // No projectId needed for authenticated users
    }
  })
});
```

**Response:**
```json
{
  "reply": "✅ Запрос выполнен...",
  "timestamp": "2025-11-06T10:00:00Z",
  "rateLimitInfo": {
    "isAnonymous": true,
    "limit": 3,
    "remaining": 2,
    "message": "💡 У вас осталось 2 сообщения..."
  }
}
```

---

### 📜 GET `/api/v1/chat/history` - Get Chat History

**Anonymous Request (with header):**
```javascript
fetch('/api/v1/chat/history?limit=50&offset=0', {
  headers: {
    'X-Anonymous-Id': 'project_1730969245_abc123'  // ← Recommended
  }
});
```

**Anonymous Request (with query param):**
```javascript
fetch('/api/v1/chat/history?limit=50&offset=0&anonymousId=project_1730969245_abc123');
```

**Authenticated Request:**
```javascript
fetch('/api/v1/chat/history?limit=50&offset=0', {
  headers: {
    'Authorization': 'Bearer eyJhbGc...'
  }
});
```

**Response:**
```json
{
  "success": true,
  "data": {
    "session": {
      "id": "uuid",
      "title": "Chat Title",
      "created_at": "2025-11-06T10:00:00Z"
    },
    "messages": [
      {
        "id": "uuid",
        "role": "user",
        "content": "Hello",
        "metadata": {},
        "created_at": "2025-11-06T10:00:00Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 10,
      "has_more": false
    }
  }
}
```

---

### 🔐 POST `/api/v1/auth/signup` - Register with Migration

```javascript
const anonymousId = localStorage.getItem('qai_anonymous_id');

fetch('/api/v1/auth/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: "user@example.com",
    password: "password123",
    name: "User Name",
    anonymousId: anonymousId  // ← Backend migrates data
  })
});
```

**Response with Migration:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "name": "User Name"
    },
    "tokens": {
      "access_token": "eyJhbGc...",
      "refresh_token": "eyJhbGc..."
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

---

### 🔓 POST `/api/v1/auth/login` - Login with Migration

Same as signup - include `anonymousId` to migrate data:

```javascript
fetch('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: "user@example.com",
    password: "password123",
    anonymousId: localStorage.getItem('qai_anonymous_id')
  })
});
```

---

## 🛠️ Frontend Utils

### Generate Anonymous ID

```javascript
// utils/anonymousId.js

export const getOrCreateAnonymousId = () => {
  const STORAGE_KEY = 'qai_anonymous_id';
  let id = localStorage.getItem(STORAGE_KEY);

  if (!id) {
    id = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(STORAGE_KEY, id);
  }

  return id;
};

export const clearAnonymousId = () => {
  localStorage.removeItem('qai_anonymous_id');
};
```

---

### API Service

```javascript
// services/chatService.js

import { getOrCreateAnonymousId } from '../utils/anonymousId';

export const sendMessage = async (message, token = null) => {
  const headers = {
    'Content-Type': 'application/json',
  };

  let body = { message };

  if (token) {
    // Authenticated user
    headers['Authorization'] = `Bearer ${token}`;
    body.context = { environment: "Production" };
  } else {
    // Anonymous user
    const anonymousId = getOrCreateAnonymousId();
    headers['X-Anonymous-Id'] = anonymousId;
    body.context = {
      environment: "Staging",
      projectId: anonymousId
    };
  }

  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  return response.json();
};

export const getChatHistory = async (limit = 50, offset = 0, token = null) => {
  const headers = {};

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['X-Anonymous-Id'] = getOrCreateAnonymousId();
  }

  const response = await fetch(
    `/api/v1/chat/history?limit=${limit}&offset=${offset}`,
    { headers }
  );

  return response.json();
};
```

---

### Auth Service

```javascript
// services/authService.js

import { getOrCreateAnonymousId, clearAnonymousId } from '../utils/anonymousId';

export const signup = async (email, password, name) => {
  const anonymousId = getOrCreateAnonymousId();

  const response = await fetch('/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      name,
      anonymousId
    })
  });

  const data = await response.json();

  if (data.success) {
    // Save tokens
    localStorage.setItem('access_token', data.data.tokens.access_token);
    localStorage.setItem('refresh_token', data.data.tokens.refresh_token);

    // Clear anonymous ID
    clearAnonymousId();

    // Show migration results
    if (data.data.migration?.migrated) {
      const { chat_sessions, chat_messages } = data.data.migration.migrated;
      console.log(`✅ Imported ${chat_sessions} sessions, ${chat_messages} messages`);
    }
  }

  return data;
};

export const login = async (email, password) => {
  const anonymousId = getOrCreateAnonymousId();

  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      anonymousId
    })
  });

  const data = await response.json();

  if (data.success) {
    localStorage.setItem('access_token', data.data.tokens.access_token);
    localStorage.setItem('refresh_token', data.data.tokens.refresh_token);
    clearAnonymousId();

    if (data.data.migration?.migrated) {
      const { chat_sessions, chat_messages } = data.data.migration.migrated;
      console.log(`✅ Restored ${chat_sessions} sessions, ${chat_messages} messages`);
    }
  }

  return data;
};
```

---

## 🎨 React Hook Example

```jsx
// hooks/useChat.js
import { useState, useEffect } from 'react';
import { getOrCreateAnonymousId } from '../utils/anonymousId';

export const useChat = () => {
  const [anonymousId, setAnonymousId] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [token, setToken] = useState(null);

  useEffect(() => {
    const storedToken = localStorage.getItem('access_token');
    if (storedToken) {
      setIsAuthenticated(true);
      setToken(storedToken);
    } else {
      setAnonymousId(getOrCreateAnonymousId());
    }
  }, []);

  const sendMessage = async (message) => {
    const headers = { 'Content-Type': 'application/json' };
    let body = { message };

    if (isAuthenticated) {
      headers['Authorization'] = `Bearer ${token}`;
      body.context = { environment: "Production" };
    } else {
      headers['X-Anonymous-Id'] = anonymousId;
      body.context = {
        environment: "Staging",
        projectId: anonymousId
      };
    }

    const response = await fetch('/api/v1/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    return response.json();
  };

  const getHistory = async () => {
    const headers = {};

    if (isAuthenticated) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      headers['X-Anonymous-Id'] = anonymousId;
    }

    const response = await fetch('/api/v1/chat/history?limit=50&offset=0', {
      headers
    });

    return response.json();
  };

  return { sendMessage, getHistory, isAuthenticated, anonymousId };
};
```

---

## 🔄 Complete Flow Example

```javascript
// App.js
import { useChat } from './hooks/useChat';
import { signup, login } from './services/authService';

function App() {
  const { sendMessage, getHistory, isAuthenticated, anonymousId } = useChat();

  // 1. Anonymous user sends message
  const handleSend = async (message) => {
    const result = await sendMessage(message);

    if (result.rateLimitInfo?.isAnonymous) {
      if (result.rateLimitInfo.remaining === 0) {
        // Show registration prompt
        setShowAuthModal(true);
      }
    }
  };

  // 2. User registers
  const handleSignup = async (email, password) => {
    const result = await signup(email, password);

    if (result.success && result.data.migration) {
      // Show success notification
      toast.success(
        `✅ Account created! Imported ${result.data.migration.migrated.chat_messages} messages`
      );

      // Reload history with new token
      const history = await getHistory();
    }
  };

  // 3. Load history
  useEffect(() => {
    getHistory().then(setMessages);
  }, [isAuthenticated]);

  return (
    <div>
      <ChatInput onSend={handleSend} />
      {!isAuthenticated && (
        <AuthPrompt onSignup={handleSignup} />
      )}
    </div>
  );
}
```

---

## ✅ Summary

### Headers to Use:

| User Type | Header | Value |
|-----------|--------|-------|
| **Anonymous** | `X-Anonymous-Id` | `project_{timestamp}_{random}` |
| **Authenticated** | `Authorization` | `Bearer {access_token}` |

### Body Fields:

| Endpoint | Field | Required |
|----------|-------|----------|
| POST `/chat` | `context.projectId` | For anonymous |
| POST `/auth/signup` | `anonymousId` | Optional (for migration) |
| POST `/auth/login` | `anonymousId` | Optional (for migration) |

### Rate Limiting:

- **Anonymous:** 3 requests → then show auth prompt
- **Authenticated:** Credit-based (no rate limit)

---

**Backend готов! Используй эти примеры для интеграции.** 🚀
