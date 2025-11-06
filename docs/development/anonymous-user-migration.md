# Anonymous User Migration Guide

## Overview

Система поддерживает работу анонимных пользователей с автоматической миграцией данных при регистрации.

## Flow: Anonymous → Authenticated User

```
1. Anonymous User:
   - Отправляет до 3 сообщений без авторизации
   - Данные сохраняются с anonymousId = `project_{projectId}`
   - Rate limit: 3 запроса

2. Registration/Login:
   - Frontend отправляет `anonymousId` в body
   - Backend мигрирует все данные к новому userId
   - Rate limit сбрасывается

3. Authenticated User:
   - Получает все свои анонимные данные
   - Неограниченный доступ (с учетом кредитов)
```

## API Endpoints

### Chat (Anonymous Allowed)

```bash
# Anonymous user can send messages
POST /api/v1/chat
{
  "message": "Test API https://example.com/api",
  "context": { "projectId": "my_project_123" }
}

# Response includes rate limit info
{
  "reply": "...",
  "rateLimitInfo": {
    "isAnonymous": true,
    "limit": 3,
    "remaining": 2,
    "message": "💡 У вас осталось 2 сообщения..."
  }
}
```

### Signup with Migration

```bash
POST /api/v1/auth/signup
{
  "email": "user@example.com",
  "password": "password123",
  "name": "User Name",
  "anonymousId": "project_my_project_123"  # ← Important!
}

# Response includes migration info
{
  "success": true,
  "data": {
    "user": { ... },
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

### Login with Migration

```bash
POST /api/v1/auth/login
{
  "email": "user@example.com",
  "password": "password123",
  "anonymousId": "project_my_project_123"  # ← Important!
}

# Same migration response as signup
```

## Frontend Integration

### 1. Track Anonymous ID

```typescript
// Store in localStorage/sessionStorage
const anonymousId =
  localStorage.getItem("anonymousId") || `project_${generateUniqueId()}`;
localStorage.setItem("anonymousId", anonymousId);
```

### 2. Send with Chat Requests

```typescript
const sendMessage = async (message: string) => {
  const response = await fetch("/api/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      context: { projectId: anonymousId },
    }),
  });

  const data = await response.json();

  // Show rate limit warning
  if (data.rateLimitInfo?.isAnonymous) {
    showWarning(`Осталось ${data.rateLimitInfo.remaining} запросов`);
  }
};
```

### 3. Register/Login with Anonymous ID

```typescript
const signup = async (email: string, password: string) => {
  const anonymousId = localStorage.getItem("anonymousId");

  const response = await fetch("/api/v1/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      anonymousId: anonymousId || undefined, // Send if exists
    }),
  });

  const data = await response.json();

  if (data.data.migration) {
    console.log("Migrated data:", data.data.migration.migrated);
    // Show success message about imported data
  }

  // Clear anonymous ID after successful migration
  localStorage.removeItem("anonymousId");
};
```

## Database Schema

### Tables Involved

```sql
-- Anonymous data
anonymous_chat_sessions (anonymous_id, title, context, ...)
anonymous_chat_messages (session_id, role, content, ...)
anonymous_usage_limits (anonymous_id, request_count, ...)

-- API configurations (can use anonymousId as user_id)
api_environments (user_id, base_url, ...)
api_endpoints (environment_id, path, method, ...)
```

### Migration Process

```sql
-- Called automatically on signup/login with anonymousId
SELECT migrate_anonymous_to_authenticated(
  'project_my_project_123',  -- anonymous_id
  'uuid-of-new-user'          -- user_id
);

-- Returns:
{
  "success": true,
  "migrated": {
    "chat_sessions": 1,
    "chat_messages": 4,
    "api_environments": 2,
    "api_endpoints": 3
  }
}
```

## Testing

### Manual Test

```bash
# 1. Run test script
./test-anonymous-migration.sh

# 2. Check data in Supabase
SELECT * FROM anonymous_chat_sessions
WHERE anonymous_id LIKE 'project_test_migration_%';

# 3. Register user with the anonymousId
# 4. Verify data is migrated
```

### Automated Test

```bash
# Create anonymous user
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "context": {"projectId": "test_123"}}'

# Register with anonymousId
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "pass123",
    "anonymousId": "project_test_123"
  }'
```

## Rate Limiting

### Anonymous Users

- **Limit**: 3 requests per session
- **Tracking**: By `anonymousId` (project-based)
- **Reset**: After registration/login

### Authenticated Users

- **Limit**: Based on credits/subscription
- **Tracking**: By `user_id`
- **Deduction**: 1 credit per chat message

## Migration Service

### Check if Data Exists

```typescript
import { AnonymousMigrationService } from "@/services/anonymous-migration.service";

const dataCheck = await AnonymousMigrationService.checkAnonymousData(
  "project_my_project_123"
);

console.log(dataCheck);
// {
//   has_data: true,
//   counts: { sessions: 1, messages: 4, environments: 2 }
// }
```

### Manual Migration

```typescript
const result = await AnonymousMigrationService.migrateToAuthenticatedUser(
  "project_my_project_123",
  "user-uuid"
);

console.log(result.migrated);
// { chat_sessions: 1, chat_messages: 4, ... }
```

### Get Migrated Data

```typescript
// Get user's migrated sessions
const sessions = await AnonymousMigrationService.getMigratedSessions(
  "user-uuid"
);

// Check if user has migrated data
const hasMigrated = await AnonymousMigrationService.hasMigratedData(
  "user-uuid"
);
```

## Cleanup

Old anonymous data is automatically cleaned up after 7 days:

```sql
-- Cleanup function (runs daily)
SELECT cleanup_old_anonymous_data();

-- Manual cleanup
DELETE FROM anonymous_chat_sessions
WHERE created_at < NOW() - INTERVAL '7 days';
```

## Security Considerations

1. **Anonymous ID Format**: Always use `project_{projectId}` format
2. **Rate Limiting**: Enforced at middleware level
3. **Data Isolation**: RLS policies prevent cross-user access
4. **Migration Safety**: Atomic transaction, rollback on error
5. **Duplicate Prevention**: Checks existing data before migration

## Error Handling

```typescript
try {
  const result = await AnonymousMigrationService.migrateToAuthenticatedUser(
    anonymousId,
    userId
  );
  // Success: result.migrated contains counts
} catch (error) {
  // Migration failed, but signup/login still succeeds
  logger.error("Migration failed:", error);
  // User won't have their anonymous data, but can still use the app
}
```

## Best Practices

1. **Always send anonymousId** on signup/login if available
2. **Clear anonymousId** from storage after successful migration
3. **Show migration results** to user ("Imported 5 messages")
4. **Handle rate limits** gracefully in UI
5. **Test migration flow** before production deployment

## SQL Migration

Execute before deploying:

```bash
# Apply migration
psql -f supabase-migrations/anonymous-to-auth-migration.sql
```

Or via Supabase Dashboard:

1. Go to SQL Editor
2. Paste contents of `anonymous-to-auth-migration.sql`
3. Run query
