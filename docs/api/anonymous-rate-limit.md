# 🔒 Credits & Rate Limiting System

## Обзор

Система управления кредитами и лимитами для разных типов пользователей.

### Типы пользователей:

1. **Анонимные** - 3 бесплатных сообщения за 24 часа
2. **Авторизованные без подписки** - 0 кредитов (требуется покупка)
3. **Авторизованные с кредитами** - использование на основе баланса

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

### GET /api/v1/user/pricing-plans

Получить список всех тарифных планов (публичный, без авторизации).

**Request:**
```bash
curl -X GET http://localhost:3000/api/v1/user/pricing-plans
```

**Response:**
```json
{
  "success": true,
  "plans": [
    {
      "id": "free",
      "name": "Free",
      "description": "Для знакомства с сервисом",
      "credits": 0,
      "price": 0,
      "currency": "USD",
      "features": [
        "3 бесплатных запроса (без регистрации)",
        "Базовое тестирование API",
        "Доступ к чату с AI"
      ]
    },
    {
      "id": "starter",
      "name": "Starter",
      "description": "Для небольших проектов",
      "credits": 100,
      "price": 9.99,
      "currency": "USD",
      "features": [
        "100 кредитов",
        "API тестирование",
        "UI тестирование",
        "История запросов",
        "Email поддержка"
      ]
    },
    {
      "id": "pro",
      "name": "Pro",
      "description": "Для профессионалов",
      "credits": 500,
      "price": 39.99,
      "currency": "USD",
      "popular": true,
      "discount": 20,
      "features": [
        "500 кредитов",
        "Приоритетная поддержка",
        "Расширенное API тестирование",
        "Playwright интеграция",
        "Autonomous тестирование",
        "Экспорт результатов",
        "Jira интеграция"
      ]
    },
    {
      "id": "business",
      "name": "Business",
      "description": "Для команд и компаний",
      "credits": 2000,
      "price": 129.99,
      "currency": "USD",
      "discount": 30,
      "features": [
        "2000 кредитов",
        "Все функции Pro",
        "Приоритетная поддержка 24/7",
        "Кастомные интеграции",
        "Dedicated менеджер",
        "SLA гарантии",
        "Тренинги для команды"
      ]
    },
    {
      "id": "enterprise",
      "name": "Enterprise",
      "description": "Индивидуальные решения",
      "credits": -1,
      "price": -1,
      "currency": "USD",
      "features": [
        "Неограниченные кредиты",
        "Все функции Business",
        "On-premise deployment",
        "Custom SLA",
        "Персональный аккаунт менеджер",
        "Кастомная разработка",
        "Security audit"
      ]
    }
  ],
  "count": 5,
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

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

**Response (Authenticated with credits):**
```json
{
  "success": true,
  "user": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "type": "authenticated"
  },
  "credits": {
    "plan": "pro",
    "status": "active",
    "balance": 150,
    "totalPurchased": 200,
    "totalUsed": 50,
    "expiresAt": "2025-12-31T23:59:59.000Z"
  },
  "message": "✅ У вас 150 кредитов",
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

**Response (Authenticated without credits):**
```json
{
  "success": true,
  "user": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "type": "authenticated"
  },
  "credits": {
    "plan": "free",
    "status": "inactive",
    "balance": 0,
    "totalPurchased": 0,
    "totalUsed": 0,
    "expiresAt": null
  },
  "message": "💳 Купите кредиты для продолжения работы",
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

### POST /api/v1/user/credits/purchase

Купить кредиты (требуется авторизация).

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/user/credits/purchase \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "amount": 100,
    "paymentId": "payment_123"
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "✅ Успешно куплено 100 кредитов",
  "credits": {
    "balance": 100,
    "purchased": 100
  },
  "timestamp": "2025-11-06T12:00:00.000Z"
}
```

### GET /api/v1/user/credits/history

История транзакций кредитов.

**Request:**
```bash
curl -X GET "http://localhost:3000/api/v1/user/credits/history?limit=20" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "transactions": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "amount": -1,
      "balance_after": 99,
      "transaction_type": "usage",
      "description": "Chat message",
      "created_at": "2025-11-06T12:00:00.000Z"
    },
    {
      "id": "uuid",
      "user_id": "uuid",
      "amount": 100,
      "balance_after": 100,
      "transaction_type": "purchase",
      "description": "Purchased 100 credits",
      "created_at": "2025-11-06T11:00:00.000Z"
    }
  ],
  "count": 2,
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
- ✅ **Анонимные**: 3 бесплатных запроса за 24 часа
- ✅ **Авторизованные**: система кредитов (покупка и списание)
- ✅ Автосброс лимита для анонимных через 24 часа
- ✅ Сохранение истории чата (отдельно для анонимных и авторизованных)
- ✅ API для проверки баланса (`GET /user/credits`)
- ✅ API для покупки кредитов (`POST /user/credits/purchase`)
- ✅ API для истории транзакций (`GET /user/credits/history`)
- ✅ Автоматическое списание кредитов при использовании чата
- ✅ Автосброс лимита анонимных после авторизации (`POST /user/credits/reset`)

## 💳 Система списания:

**Каждое сообщение в чат = 1 кредит**

- Анонимные: лимит 3 запроса (не требует кредитов)
- Авторизованные без кредитов: **402 Payment Required**
- Авторизованные с кредитами: списание 1 кредита + показ остатка в ответе

## 🔄 Flow для фронтенда:

1. Юзер заходит анонимно → 3 запроса бесплатно
2. После 3 запросов → **429 Too Many Requests** → показать форму регистрации
3. Юзер регистрируется → сброс анонимного лимита → 0 кредитов
4. Юзер покупает кредиты → `POST /user/credits/purchase`
5. Юзер использует чат → автоматическое списание
6. Проверка баланса → `GET /user/credits`
