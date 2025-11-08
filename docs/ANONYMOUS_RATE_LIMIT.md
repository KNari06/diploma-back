# 🔒 Anonymous User Rate Limiting

## Обзор

Система ограничения запросов для анонимных (неавторизованных) пользователей.

**Лимит:** 3 сообщения в чат за 24 часа
**Сброс:** Автоматически через 24 часа после первого запроса
**Авторизованные пользователи:** Без ограничений ✅

---

## 📦 Компоненты

### 1. База данных (3 таблицы)

**`anonymous_chat_sessions`** - сессии анонимных пользователей
```sql
- id: UUID
- anonymous_id: TEXT (project_{projectId})
- title: TEXT
- created_at: TIMESTAMP
```

**`anonymous_chat_messages`** - сообщения анонимных пользователей
```sql
- id: UUID
- session_id: UUID (FK to anonymous_chat_sessions)
- role: TEXT (user/ai)
- content: TEXT
- created_at: TIMESTAMP
```

**`anonymous_usage_limits`** - счетчик запросов
```sql
- id: UUID
- anonymous_id: TEXT (UNIQUE)
- request_count: INTEGER
- last_request_at: TIMESTAMP
- first_request_at: TIMESTAMP
```

### 2. Сервисы

**`AnonymousLimiterService`** - управление лимитами
- `getRequestCount()` - получить текущий счетчик
- `incrementRequestCount()` - увеличить счетчик
- `hasReachedLimit()` - проверить достижение лимита
- `getRemainingRequests()` - получить остаток запросов
- `resetRequestCount()` - сбросить счетчик (после авторизации)

### 3. Middleware

**`checkAnonymousLimit`** - проверка перед обработкой запроса
- Пропускает авторизованных пользователей
- Проверяет лимит для анонимных
- Возвращает 429 при превышении лимита

---

## 🚀 Применение миграции

### Шаг 1: Выполнить SQL в Supabase

Перейти в Supabase SQL Editor:
```
https://supabase.com/dashboard/project/{your-project}/sql/new
```

Скопировать и выполнить:
```bash
supabase-migrations/anonymous-chat-limits.sql
```

### Шаг 2: Перезапустить сервер

```bash
npm run dev
```

---

## 📊 API Ответы

### Успешный запрос (анонимный пользователь)

```json
{
  "reply": "...",
  "timestamp": "2025-11-06T12:00:00.000Z",
  "rateLimitInfo": {
    "isAnonymous": true,
    "limit": 3,
    "remaining": 1,
    "message": "💡 У вас осталось 1 сообщение. Авторизуйтесь для неограниченного доступа."
  }
}
```

**HTTP Headers:**
```
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 1
X-RateLimit-Reset: 1699308000000
```

### Превышен лимит (429 Too Many Requests)

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "🔒 Вы достигли лимита в 3 сообщения для анонимных пользователей.\n\n✨ Авторизуйтесь для неограниченного доступа к чату!",
  "rateLimitInfo": {
    "limit": 3,
    "current": 3,
    "remaining": 0,
    "requiresAuth": true,
    "authMessage": "Войдите или зарегистрируйтесь, чтобы продолжить использование QAI"
  },
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

---

## 🧪 Тестирование

### Тест 1: Анонимный пользователь (3 запроса)

```bash
# Запрос 1
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Привет",
    "context": {"projectId": "test"},
    "sessionId": "anon-test"
  }'
# Ответ: remaining: 2

# Запрос 2
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Как дела?",
    "context": {"projectId": "test"},
    "sessionId": "anon-test"
  }'
# Ответ: remaining: 1

# Запрос 3
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Спасибо",
    "context": {"projectId": "test"},
    "sessionId": "anon-test"
  }'
# Ответ: remaining: 0

# Запрос 4 - БЛОКИРОВКА
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Еще вопрос",
    "context": {"projectId": "test"},
    "sessionId": "anon-test"
  }'
# Ответ: 429 Too Many Requests
```

### Тест 2: Авторизованный пользователь (без лимита)

```bash
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "message": "Привет",
    "context": {"projectId": "test"}
  }'
# Ответ: БЕЗ rateLimitInfo, неограниченные запросы
```

---

## 🔧 Настройка

### Изменить лимит запросов

В `src/services/anonymous-limiter.service.ts`:

```typescript
export class AnonymousLimiterService {
  private static readonly MAX_REQUESTS = 3;  // ← Изменить здесь
  private static readonly RESET_PERIOD_HOURS = 24;
}
```

### Изменить период сброса

```typescript
private static readonly RESET_PERIOD_HOURS = 24;  // ← Изменить здесь
```

---

## 🗑️ Очистка старых данных

### Автоматическая очистка (старше 7 дней)

SQL функция уже создана:
```sql
SELECT cleanup_old_anonymous_data();
```

### Настроить cron (если доступно в Supabase)

```sql
SELECT cron.schedule(
  'cleanup-anonymous-data',
  '0 3 * * *',  -- Каждый день в 3:00
  'SELECT cleanup_old_anonymous_data()'
);
```

---

## 📈 Мониторинг

### Проверить текущие лимиты

```sql
SELECT
  anonymous_id,
  request_count,
  last_request_at,
  first_request_at
FROM anonymous_usage_limits
ORDER BY last_request_at DESC;
```

### Статистика использования

```sql
SELECT
  COUNT(*) as total_anonymous_users,
  AVG(request_count) as avg_requests,
  MAX(request_count) as max_requests
FROM anonymous_usage_limits;
```

### Активные анонимные сессии

```sql
SELECT
  COUNT(*) as active_sessions,
  COUNT(DISTINCT anonymous_id) as unique_users
FROM anonymous_chat_sessions
WHERE created_at > NOW() - INTERVAL '24 hours';
```

---

## 🎯 Сброс лимита после авторизации

В `auth.controller.ts` после успешной авторизации:

```typescript
import { AnonymousLimiterService } from '@/services/anonymous-limiter.service';

// После успешного логина
const oldAnonymousId = `project_${projectId}`;
await AnonymousLimiterService.resetRequestCount(oldAnonymousId);
```

---

---

## 🔌 API Endpoints

### GET /api/v1/user/credits

Получить текущую информацию о кредитах/лимитах.

**Request:**
```bash
# Анонимный пользователь
curl -X GET "http://localhost:3000/api/v1/user/credits?userId=project_myapp"

# Авторизованный пользователь
curl -X GET http://localhost:3000/api/v1/user/credits \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response (Anonymous):**
```json
{
  "success": true,
  "user": {
    "id": "project_myapp",
    "type": "anonymous"
  },
  "credits": {
    "plan": "free",
    "limit": 3,
    "used": 2,
    "remaining": 1,
    "resetAt": "2025-11-07T12:00:00.000Z",
    "isLimitReached": false
  },
  "message": "💡 У вас осталось 1 сообщение",
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

**Response (Authenticated):**
```json
{
  "success": true,
  "user": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "type": "authenticated"
  },
  "credits": {
    "plan": "unlimited",
    "limit": null,
    "used": null,
    "remaining": null,
    "resetAt": null
  },
  "message": "✅ У вас неограниченный доступ",
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

### POST /api/v1/user/credits/reset

Сбросить лимит для анонимного пользователя (после авторизации).

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/user/credits/reset \
  -H "Content-Type: application/json" \
  -d '{"anonymousId": "project_myapp"}'
```

**Response:**
```json
{
  "success": true,
  "message": "✅ Лимит успешно сброшен",
  "anonymousId": "project_myapp",
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

---

## ✅ Готово!

Система работает:
- ✅ 3 запроса для анонимных
- ✅ Неограниченно для авторизованных
- ✅ Автосброс через 24 часа
- ✅ Сохранение истории чата для анонимных
- ✅ Информирование о лимите в ответах
- ✅ API для проверки текущих лимитов (`GET /user/credits`)
- ✅ API для сброса лимитов (`POST /user/credits/reset`)
