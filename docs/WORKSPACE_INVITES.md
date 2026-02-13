# Workspace Team Invites - Руководство

## Обзор

Система инвайтов позволяет владельцам workspace приглашать пользователей для совместной работы через email.

## Как это работает

1. **Owner создает инвайт** через API
2. **Backend создает запись** в таблице `workspace_invites`
3. **Supabase Auth отправляет email** на указанный адрес
4. **Пользователь получает email** с ссылкой для принятия инвайта
5. **Пользователь кликает ссылку** → редирект на фронтенд
6. **Фронтенд вызывает API** для принятия инвайта
7. **Backend создает membership** в таблице `workspace_members`

## Конфигурация

### 1. Supabase SMTP настройки

В Supabase Dashboard → Settings → Auth → SMTP Settings:

```
Enable custom SMTP: ON
Sender email: noreply@qait.dev
Sender name: QAIT.dev
Host: smtp.gmail.com
Port: 587
Username: noreply@qait.dev
Password: [app password]
```

⚠️ **ВАЖНО**: Используйте App Password для Gmail, а не обычный пароль!

### 2. Environment Variables

В `.env` файле:

```bash
FRONTEND_URL=https://qait.dev
SUPABASE_URL=https://[your-project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=[your-service-role-key]
```

## API Endpoints

### Создать инвайт

```http
POST /api/v1/workspaces/:workspaceId/invites
Authorization: Bearer <token>
Content-Type: application/json

{
  "email": "user@example.com",
  "role": "full_access" | "view"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "workspace_id": "uuid",
    "email": "user@example.com",
    "role": "full_access",
    "status": "invited",
    "expires_at": "2026-02-20T10:00:00Z",
    ...
  },
  "emailSent": true,
  "message": "Invite created successfully"
}
```

### Получить список инвайтов

```http
GET /api/v1/workspaces/:workspaceId/invites
Authorization: Bearer <token>
```

### Переслать инвайт

```http
POST /api/v1/workspaces/:workspaceId/invites/:inviteId/resend
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "emailSent": true,
  "message": "Invite resent successfully"
}
```

### Отозвать инвайт

```http
POST /api/v1/workspaces/:workspaceId/invites/:inviteId/revoke
Authorization: Bearer <token>
```

### Принять инвайт

```http
POST /api/v1/invites/:inviteId/accept
Authorization: Bearer <token>
```

## Тестирование

### Вариант 1: Через скрипт

```bash
# Установите зависимости
npm install

# Запустите тест
npx tsx scripts/test-invite.ts <workspace-id> <email>

# Пример:
npx tsx scripts/test-invite.ts "123e4567-e89b-12d3-a456-426614174000" "test@example.com"
```

### Вариант 2: Через API

```bash
# 1. Получите токен авторизации
curl -X POST https://api.qait.dev/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "owner@example.com", "password": "password"}'

# 2. Создайте инвайт
curl -X POST https://api.qait.dev/api/v1/workspaces/{workspace-id}/invites \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "newuser@example.com", "role": "full_access"}'

# 3. Проверьте email inbox
```

### Вариант 3: Через Postman/Insomnia

1. Import коллекцию API
2. Авторизуйтесь как owner workspace
3. Создайте инвайт через POST `/workspaces/:id/invites`
4. Проверьте email

## Мониторинг и логи

### Успешная отправка

```
[WORKSPACE_MEMBERS] Sending invite email {
  email: 'user@example.com',
  redirectTo: 'https://qait.dev/invite/accept?inviteId=...',
  frontendUrl: 'https://qait.dev'
}

[WORKSPACE_MEMBERS] Invite email sent successfully {
  email: 'user@example.com',
  userId: 'uuid',
  inviteId: 'uuid'
}

[WORKSPACE_MEMBERS] Invite created {
  workspaceId: 'uuid',
  inviteId: 'uuid',
  email: 'user@example.com',
  role: 'full_access',
  emailSent: true
}
```

### Ошибка при отправке

```
[WORKSPACE_MEMBERS] Supabase auth invite failed {
  error: 'Error message',
  errorCode: 'error_code',
  email: 'user@example.com',
  redirectTo: '...'
}
```

## Troubleshooting

### Проблема: Email не приходит

**Чек-лист:**
1. ✅ SMTP включен в Supabase Dashboard?
2. ✅ Правильный SMTP host/port/credentials?
3. ✅ `FRONTEND_URL` правильно настроен в `.env`?
4. ✅ Email не в спаме?
5. ✅ Проверьте логи на сервере: `docker logs backend`

**Проверка SMTP в Supabase:**
```bash
# Отправьте тестовый email через Supabase Dashboard
Settings → Auth → SMTP Settings → Send test email
```

### Проблема: emailSent = false в ответе

Это означает, что Supabase не смог отправить email. Причины:
- SMTP не настроен
- Неверные SMTP credentials
- Email провайдер заблокировал отправку
- Rate limit превышен

**Решение:**
1. Проверьте логи сервера
2. Проверьте Supabase Dashboard → Logs
3. Проверьте SMTP settings
4. Попробуйте отправить test email через Dashboard

### Проблема: Invite создан, но redirectTo неправильный

Убедитесь, что `FRONTEND_URL` в `.env` правильный:
```bash
echo $FRONTEND_URL
# Должно быть: https://qait.dev
```

## Структура базы данных

### workspace_invites

```sql
CREATE TABLE workspace_invites (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL, -- 'full_access' | 'view'
    status TEXT NOT NULL, -- 'invited' | 'accepted' | 'revoked' | 'expired'
    invited_by_user_id UUID NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    accepted_by_user_id UUID,
    supabase_invite_user_id UUID, -- ID от Supabase Auth
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### workspace_members

```sql
CREATE TABLE workspace_members (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    role TEXT NOT NULL, -- 'owner' | 'full_access' | 'view'
    status TEXT NOT NULL, -- 'active' | 'removed'
    invited_by_user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Роли и права доступа

### owner
- Полный контроль над workspace
- Может приглашать/удалять пользователей
- Может менять роли
- Может передавать ownership

### full_access
- Может создавать/редактировать/удалять ресурсы
- Может просматривать всё
- НЕ может управлять членами команды

### view
- Только чтение
- Не может создавать/редактировать/удалять
- Не может управлять членами команды

## Email Template

Supabase использует дефолтный шаблон для инвайтов. Можно кастомизировать в:
**Supabase Dashboard → Auth → Email Templates → Invite User**

Переменные доступные в шаблоне:
- `{{ .ConfirmationURL }}` - ссылка для подтверждения
- `{{ .Email }}` - email получателя
- `{{ .SiteURL }}` - ваш FRONTEND_URL

## Безопасность

1. **Email валидация** - проверяется формат email
2. **Duplicate protection** - нельзя создать 2 pending инвайта на один email
3. **Expiry** - инвайты истекают через 7 дней
4. **Owner only** - только owner может создавать инвайты
5. **Email match** - при accept проверяется, что email пользователя совпадает с email в инвайте
6. **Audit log** - все действия логируются в `workspace_audit_log`

## FAQ

**Q: Можно ли пригласить пользователя, который уже зарегистрирован?**
A: Да, если пользователь существует, ему просто отправится инвайт для присоединения к workspace.

**Q: Что если пользователь не зарегистрирован?**
A: Supabase автоматически создаст аккаунт и отправит email для установки пароля + принятия инвайта.

**Q: Сколько инвайтов можно отправить?**
A: Нет лимита, но Supabase SMTP имеет rate limits (60 emails per hour по умолчанию).

**Q: Можно ли изменить роль в инвайте после создания?**
A: Нет, нужно отозвать (revoke) старый инвайт и создать новый с другой ролью.

**Q: Что происходит при истечении срока инвайта?**
A: Status автоматически меняется на 'expired' при попытке accept. Можно resend для продления.
