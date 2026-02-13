# 🔄 Изменения в Team Invites - Краткое руководство для фронтенда

## Что изменилось

Теперь **email отправляется ВСЕМ пользователям** (новым и существующим).

---

## 📊 API Response изменился

### Было:

```json
{
  "success": true,
  "data": {
    /* invite data */
  },
  "message": "Invite created successfully"
}
```

### Стало:

```json
{
  "success": true,
  "data": {
    /* invite data */
  },
  "emailSent": true, // ← NEW
  "userExists": false, // ← NEW
  "inviteUrl": "https://...", // ← NEW
  "message": "Invite created and email sent successfully"
}
```

---

## 🎯 Что делать на фронте

### 1. Обновите обработку response

```typescript
// После создания invite:
const response = await createInvite(workspaceId, email, role);

// Проверяйте новые поля:
if (response.emailSent) {
  // ✅ Email отправлен
  toast.success("Invitation sent successfully!");
} else {
  // ⚠️ Email не отправлен - покажите ссылку
  toast.warning("Email failed. Copy invite link and share manually.");
  showCopyLinkButton(response.inviteUrl);
}
```

### 2. Добавьте кнопку "Copy Link"

```tsx
{
  !response.emailSent && (
    <div className="warning">
      <p>⚠️ Email could not be sent. Copy this link:</p>
      <input value={response.inviteUrl} readOnly />
      <button onClick={() => copyToClipboard(response.inviteUrl)}>
        Copy Link
      </button>
    </div>
  );
}
```

---

## 🔍 Два сценария

### Сценарий 1: Новый пользователь (email не зарегистрирован)

```
1. Email отправляется через Supabase Auth
2. Пользователь получает email
3. Устанавливает пароль
4. Автоматический редирект на /invite/accept?inviteId=xxx
5. Фронт вызывает POST /invites/{inviteId}/accept
6. Membership создан ✅
```

**Response:**

```json
{
  "emailSent": true,
  "userExists": false
}
```

### Сценарий 2: Существующий пользователь (email уже есть)

```
1. Email отправляется через nodemailer (custom HTML)
2. Пользователь получает email
3. Кликает ссылку → логин (если нужно)
4. Редирект на /invite/accept?inviteId=xxx
5. Фронт вызывает POST /invites/{inviteId}/accept
6. Membership создан ✅
```

**Response:**

```json
{
  "emailSent": true,
  "userExists": true
}
```

---

## 📝 TypeScript типы

```typescript
interface CreateInviteResponse {
  success: boolean;
  data: {
    id: string;
    email: string;
    role: "full_access" | "view";
    status: "invited";
    expires_at: string;
    // ...
  };
  emailSent: boolean; // ← Добавьте
  userExists: boolean; // ← Добавьте
  inviteUrl: string; // ← Добавьте
  message: string;
}
```

---

## 🚀 Минимальная интеграция

### 1. Обновите API client

```typescript
// api/workspaces.ts
export const createInvite = async (
  workspaceId: string,
  email: string,
  role: string,
) => {
  const response = await axios.post(`/workspaces/${workspaceId}/invites`, {
    email,
    role,
  });
  return response.data; // Теперь включает emailSent, userExists, inviteUrl
};
```

### 2. Обновите UI

```tsx
const handleInvite = async () => {
  const response = await createInvite(workspaceId, email, role);

  if (response.success) {
    if (response.emailSent) {
      // ✅ Успех
      toast.success("Invitation sent!");
      onClose();
    } else {
      // ⚠️ Email failed
      setShowCopyLink(true);
      setInviteUrl(response.inviteUrl);
    }
  }
};
```

---

## 🎨 UI компонент (пример)

```tsx
function InviteModal({ workspaceId }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("full_access");
  const [showCopyLink, setShowCopyLink] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();

    const response = await createInvite(workspaceId, email, role);

    if (response.emailSent) {
      toast.success("Invitation sent!");
      setEmail("");
      onClose();
    } else {
      setShowCopyLink(true);
      setInviteUrl(response.inviteUrl);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="user@example.com"
      />

      <select value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="full_access">Full Access</option>
        <option value="view">View Only</option>
      </select>

      {showCopyLink && (
        <div className="alert-warning">
          <p>⚠️ Email failed. Copy this link:</p>
          <input value={inviteUrl} readOnly />
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(inviteUrl);
              toast.success("Copied!");
            }}
          >
            Copy Link
          </button>
        </div>
      )}

      <button type="submit">Send Invitation</button>
    </form>
  );
}
```

---

## ✅ Checklist

- [ ] Обновить TypeScript типы (добавить `emailSent`, `userExists`, `inviteUrl`)
- [ ] Обработать `emailSent` в UI
- [ ] Добавить блок с кнопкой "Copy Link" если `emailSent = false`
- [ ] Показать разные сообщения для `userExists = true/false` (опционально)
- [ ] ✨ **НОВОЕ**: Убрать фильтрацию invites - API теперь возвращает только pending!
- [ ] Протестировать оба сценария

## 🆕 Важное обновление: API возвращает только pending invites

**GET /workspaces/:id/invites** теперь возвращает **только pending invites** (status = 'invited').

### Что это значит:

```typescript
// ❌ БОЛЬШЕ НЕ НУЖНО фильтровать:
const pendingInvites = invites.filter(i => i.status === 'invited');

// ✅ Все invites уже pending:
const { data: invites } = await getInvites(workspaceId);
// Используйте напрямую!
```

### Упростите код:

```tsx
// Было:
const pendingInvites = invites.filter(i => i.status === 'invited');
{pendingInvites.map(invite => ...)}

// Стало:
{invites.map(invite => ...)}
// Все уже pending!
```

### После revoke:

- ✅ Invite исчезает из списка автоматически
- ✅ Можно создать новый invite с тем же email
- ✅ Новый invite появится в списке

---

## 🐛 Если что-то не работает

### Email не приходит

1. Проверьте backend логи: `docker logs backend | grep WORKSPACE_MEMBERS`
2. Ищите `emailSent: false` в логах
3. Проверьте, что `SMTP_PASSWORD` настроен в `.env`

### Response не содержит новые поля

1. Проверьте версию backend (должна быть обновлена)
2. Проверьте endpoint URL (должен быть правильный)
3. Посмотрите Network tab в DevTools

---

## 📞 Вопросы?
