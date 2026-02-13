# Frontend Integration Guide: Team Invites

Полное руководство по интеграции системы приглашений в команду на фронтенде.

---

## 📋 Содержание

1. [Обзор системы](#обзор-системы)
2. [API Endpoints](#api-endpoints)
3. [Типы данных](#типы-данных)
4. [Создание invite](#создание-invite)
5. [Принятие invite](#принятие-invite)
6. [Управление invites](#управление-invites)
7. [UI компоненты](#ui-компоненты)
8. [Примеры кода](#примеры-кода)
9. [Edge cases](#edge-cases)
10. [Тестирование](#тестирование)

---

## Обзор системы

### Как работает система invite

```
Owner создает invite
        ↓
Backend определяет: новый или существующий пользователь?
        ↓
    ┌───────┴───────┐
    ↓               ↓
[НОВЫЙ]        [СУЩЕСТВУЮЩИЙ]
    ↓               ↓
Supabase Auth   Custom Email
    ↓               ↓
Email с invite → Email с invite
    ↓               ↓
Set password    Just login
    ↓               ↓
    └───────┬───────┘
            ↓
    /invite/accept
            ↓
    API accept
            ↓
    Membership создан
```

### Ключевые моменты

- **Новые пользователи**: Email через Supabase Auth → установка пароля → accept
- **Существующие пользователи**: Email через nodemailer → логин (если нужно) → accept
- **Оба сценария**: После логина попадают на `/invite/accept?inviteId=xxx`
- **Accept один раз**: После принятия invite нельзя использовать повторно

---

## API Endpoints

### Base URL
```
Production: https://api.qait.dev/api/v1
Development: http://localhost:3000/api/v1
```

### Аутентификация
Все endpoints требуют JWT token в header:
```
Authorization: Bearer <your_jwt_token>
```

### 1. Создать invite

```http
POST /workspaces/:workspaceId/invites
```

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**
```json
{
  "email": "user@example.com",
  "role": "full_access" // или "view"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "03ddcd0f-ebcf-4f0f-a84b-01e5e330b7b1",
    "workspace_id": "bbe6819d-ebd3-4116-9ed7-4d530afc9095",
    "email": "user@example.com",
    "role": "full_access",
    "status": "invited",
    "invited_by_user_id": "...",
    "expires_at": "2026-02-20T08:46:50.000Z",
    "created_at": "2026-02-13T08:46:50.000Z",
    "supabase_invite_user_id": "..." // может быть null
  },
  "emailSent": true,
  "userExists": false,
  "inviteUrl": "https://qait.dev/invite/accept?inviteId=03ddcd0f...&workspaceId=bbe6819d...",
  "message": "Invite created and email sent successfully",
  "timestamp": "2026-02-13T08:46:50.000Z"
}
```

**Errors:**
- `400` - Invalid email or role
- `401` - Not authenticated
- `403` - Not workspace owner
- `404` - Workspace not found

---

### 2. Получить список invites

```http
GET /workspaces/:workspaceId/invites
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "workspace_id": "...",
      "email": "user@example.com",
      "role": "full_access",
      "status": "invited", // invited | accepted | revoked | expired
      "invited_by_user_id": "...",
      "expires_at": "2026-02-20T08:46:50.000Z",
      "accepted_at": null,
      "accepted_by_user_id": null,
      "created_at": "2026-02-13T08:46:50.000Z"
    }
  ],
  "count": 1,
  "timestamp": "2026-02-13T08:46:50.000Z"
}
```

---

### 3. Переслать invite

```http
POST /workspaces/:workspaceId/invites/:inviteId/resend
```

**Response:**
```json
{
  "success": true,
  "emailSent": true,
  "message": "Invite resent successfully",
  "timestamp": "2026-02-13T08:46:50.000Z"
}
```

**Note:** Продлевает срок действия на +7 дней от текущей даты.

---

### 4. Отозвать invite

```http
POST /workspaces/:workspaceId/invites/:inviteId/revoke
```

**Response:**
```json
{
  "success": true,
  "message": "Invite revoked successfully",
  "timestamp": "2026-02-13T08:46:50.000Z"
}
```

---

### 5. Принять invite

```http
POST /invites/:inviteId/accept
```

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "membership-id",
    "workspace_id": "...",
    "user_id": "...",
    "role": "full_access",
    "status": "active",
    "created_at": "2026-02-13T08:46:50.000Z"
  },
  "message": "Invite accepted successfully",
  "timestamp": "2026-02-13T08:46:50.000Z"
}
```

**Errors:**
- `400` - Invalid invite / email mismatch / expired / already accepted
- `401` - Not authenticated
- `404` - Invite not found

---

### 6. Получить pending invites (опционально)

Этот endpoint нужно добавить на бэкенде, если хотите показывать список pending invites пользователю.

```http
GET /users/me/pending-invites
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "invite_id": "...",
      "workspace_id": "...",
      "workspace_name": "My Workspace",
      "role": "full_access",
      "invited_by": "John Doe",
      "expires_at": "2026-02-20T08:46:50.000Z"
    }
  ],
  "count": 1
}
```

---

## Типы данных

### TypeScript Interfaces

```typescript
// ============================================================================
// ENUMS
// ============================================================================

export type WorkspaceRole = 'owner' | 'full_access' | 'view';
export type InviteStatus = 'invited' | 'accepted' | 'revoked' | 'expired';

// ============================================================================
// INVITE
// ============================================================================

export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: 'full_access' | 'view';
  status: InviteStatus;
  invited_by_user_id: string;
  expires_at: string; // ISO 8601
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  supabase_invite_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// API RESPONSES
// ============================================================================

export interface CreateInviteResponse {
  success: boolean;
  data: WorkspaceInvite;
  emailSent: boolean;        // Был ли отправлен email
  userExists: boolean;       // Существующий пользователь?
  inviteUrl: string;         // Ссылка для ручной отправки
  message: string;
  timestamp: string;
}

export interface InvitesListResponse {
  success: boolean;
  data: WorkspaceInvite[];
  count: number;
  timestamp: string;
}

export interface ResendInviteResponse {
  success: boolean;
  emailSent: boolean;
  message: string;
  timestamp: string;
}

export interface AcceptInviteResponse {
  success: boolean;
  data: WorkspaceMembership;
  message: string;
  timestamp: string;
}

// ============================================================================
// MEMBERSHIP
// ============================================================================

export interface WorkspaceMembership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  status: 'active' | 'removed';
  invited_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// REQUEST BODIES
// ============================================================================

export interface CreateInviteRequest {
  email: string;
  role: 'full_access' | 'view';
}
```

---

## Создание invite

### API Client

```typescript
// api/workspaces.ts

import axios from 'axios';

const API_BASE = 'https://api.qait.dev/api/v1';

export const workspaceApi = {
  /**
   * Создать invite
   */
  createInvite: async (
    workspaceId: string,
    data: CreateInviteRequest
  ): Promise<CreateInviteResponse> => {
    const response = await axios.post(
      `${API_BASE}/workspaces/${workspaceId}/invites`,
      data,
      {
        headers: {
          Authorization: `Bearer ${getToken()}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  },

  /**
   * Получить список invites
   */
  getInvites: async (workspaceId: string): Promise<InvitesListResponse> => {
    const response = await axios.get(
      `${API_BASE}/workspaces/${workspaceId}/invites`,
      {
        headers: {
          Authorization: `Bearer ${getToken()}`,
        },
      }
    );
    return response.data;
  },

  /**
   * Переслать invite
   */
  resendInvite: async (
    workspaceId: string,
    inviteId: string
  ): Promise<ResendInviteResponse> => {
    const response = await axios.post(
      `${API_BASE}/workspaces/${workspaceId}/invites/${inviteId}/resend`,
      {},
      {
        headers: {
          Authorization: `Bearer ${getToken()}`,
        },
      }
    );
    return response.data;
  },

  /**
   * Отозвать invite
   */
  revokeInvite: async (
    workspaceId: string,
    inviteId: string
  ): Promise<{ success: boolean; message: string }> => {
    const response = await axios.post(
      `${API_BASE}/workspaces/${workspaceId}/invites/${inviteId}/revoke`,
      {},
      {
        headers: {
          Authorization: `Bearer ${getToken()}`,
        },
      }
    );
    return response.data;
  },

  /**
   * Принять invite
   */
  acceptInvite: async (inviteId: string): Promise<AcceptInviteResponse> => {
    const response = await axios.post(
      `${API_BASE}/invites/${inviteId}/accept`,
      {},
      {
        headers: {
          Authorization: `Bearer ${getToken()}`,
        },
      }
    );
    return response.data;
  },
};

// Helper для получения токена
function getToken(): string {
  return localStorage.getItem('token') || '';
}
```

### React Hook

```typescript
// hooks/useInvites.ts

import { useState } from 'react';
import { workspaceApi } from '@/api/workspaces';
import { toast } from 'react-hot-toast';

export function useCreateInvite(workspaceId: string) {
  const [loading, setLoading] = useState(false);

  const createInvite = async (email: string, role: 'full_access' | 'view') => {
    setLoading(true);

    try {
      const response = await workspaceApi.createInvite(workspaceId, {
        email,
        role,
      });

      if (response.success) {
        if (response.emailSent) {
          // ✅ Email отправлен
          toast.success(
            response.userExists
              ? `Invitation sent to ${email}`
              : `Invitation sent. User will set password via email.`
          );
        } else {
          // ⚠️ Email не отправлен
          toast.error(
            'Failed to send email. Please copy the invite link manually.',
            {
              duration: 5000,
            }
          );
        }

        return response;
      }
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to create invite');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  return { createInvite, loading };
}

export function useInvites(workspaceId: string) {
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchInvites = async () => {
    setLoading(true);
    try {
      const response = await workspaceApi.getInvites(workspaceId);
      setInvites(response.data);
    } catch (error) {
      console.error('Failed to fetch invites', error);
    } finally {
      setLoading(false);
    }
  };

  const resendInvite = async (inviteId: string) => {
    try {
      const response = await workspaceApi.resendInvite(workspaceId, inviteId);
      if (response.emailSent) {
        toast.success('Invitation resent successfully');
      } else {
        toast.error('Failed to resend email');
      }
      await fetchInvites(); // Refresh list
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to resend invite');
    }
  };

  const revokeInvite = async (inviteId: string) => {
    try {
      await workspaceApi.revokeInvite(workspaceId, inviteId);
      toast.success('Invitation revoked');
      await fetchInvites(); // Refresh list
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to revoke invite');
    }
  };

  return {
    invites,
    loading,
    fetchInvites,
    resendInvite,
    revokeInvite,
  };
}
```

### Vue Composable (альтернатива)

```typescript
// composables/useInvites.ts

import { ref, Ref } from 'vue';
import { workspaceApi } from '@/api/workspaces';
import { useToast } from '@/composables/useToast';

export function useCreateInvite(workspaceId: string) {
  const loading = ref(false);
  const { showToast } = useToast();

  const createInvite = async (email: string, role: 'full_access' | 'view') => {
    loading.value = true;

    try {
      const response = await workspaceApi.createInvite(workspaceId, {
        email,
        role,
      });

      if (response.success) {
        if (response.emailSent) {
          showToast({
            type: 'success',
            message: `Invitation sent to ${email}`,
          });
        } else {
          showToast({
            type: 'warning',
            message: 'Failed to send email. Copy the link manually.',
          });
        }

        return response;
      }
    } catch (error: any) {
      showToast({
        type: 'error',
        message: error.response?.data?.error || 'Failed to create invite',
      });
      throw error;
    } finally {
      loading.value = false;
    }
  };

  return { createInvite, loading };
}
```

---

## Принятие invite

### Страница `/invite/accept`

```tsx
// pages/InviteAccept.tsx

import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { workspaceApi } from '@/api/workspaces';
import { Spinner } from '@/components/Spinner';
import { CheckCircle, XCircle } from 'lucide-react';

type Status = 'loading' | 'success' | 'error';

export function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');

  const inviteId = searchParams.get('inviteId');
  const workspaceId = searchParams.get('workspaceId');

  useEffect(() => {
    if (!inviteId) {
      setStatus('error');
      setMessage('Invalid invite link');
      return;
    }

    acceptInvite();
  }, [inviteId]);

  const acceptInvite = async () => {
    try {
      // Проверяем аутентификацию
      const token = localStorage.getItem('token');

      if (!token) {
        // Не залогинен - сохраняем invite URL и редирект на логин
        const returnUrl = window.location.pathname + window.location.search;
        navigate(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }

      // Принимаем инвайт
      const response = await workspaceApi.acceptInvite(inviteId!);

      if (response.success) {
        setStatus('success');
        setMessage('Successfully joined the workspace!');

        // Редирект в workspace через 2 секунды
        setTimeout(() => {
          if (workspaceId) {
            navigate(`/workspaces/${workspaceId}`);
          } else {
            navigate('/workspaces');
          }
        }, 2000);
      }
    } catch (error: any) {
      setStatus('error');

      // Обработка специфичных ошибок
      const errorMsg = error.response?.data?.error;

      if (errorMsg?.includes('expired')) {
        setMessage('This invitation has expired. Please contact the workspace owner.');
      } else if (errorMsg?.includes('already accepted')) {
        setMessage('This invitation has already been accepted.');
      } else if (errorMsg?.includes('email mismatch')) {
        setMessage('This invitation was sent to a different email address.');
      } else {
        setMessage(errorMsg || 'Failed to accept invitation');
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white shadow-lg rounded-lg p-8">
        {status === 'loading' && (
          <div className="text-center">
            <Spinner className="mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Accepting invitation...</h2>
            <p className="text-gray-600">Please wait</p>
          </div>
        )}

        {status === 'success' && (
          <div className="text-center">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Welcome aboard! 🎉</h2>
            <p className="text-gray-600 mb-4">{message}</p>
            <p className="text-sm text-gray-500">Redirecting to workspace...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="text-center">
            <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Oops!</h2>
            <p className="text-gray-600 mb-4">{message}</p>
            <button
              onClick={() => navigate('/login')}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Go to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Routing Setup

```tsx
// App.tsx или routes.tsx

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { InviteAcceptPage } from '@/pages/InviteAccept';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ... другие роуты */}

        {/* Invite accept route */}
        <Route path="/invite/accept" element={<InviteAcceptPage />} />

        {/* ... */}
      </Routes>
    </BrowserRouter>
  );
}
```

### Обработка после Supabase редиректа

Когда новый пользователь устанавливает пароль через Supabase, он автоматически редиректится на URL, указанный в `redirectTo`:

```
https://qait.dev/invite/accept?inviteId=xxx&workspaceId=yyy
```

**Важно:** Убедитесь, что этот URL добавлен в Supabase Dashboard:
- Settings → Auth → Redirect URLs
- Добавьте: `https://qait.dev/invite/accept*`

---

## Управление invites

### Компонент списка invites

```tsx
// components/InvitesList.tsx

import { useEffect } from 'react';
import { useInvites } from '@/hooks/useInvites';
import { formatDistanceToNow } from 'date-fns';
import { Mail, RotateCw, XCircle, Copy } from 'lucide-react';

interface InvitesListProps {
  workspaceId: string;
}

export function InvitesList({ workspaceId }: InvitesListProps) {
  const { invites, loading, fetchInvites, resendInvite, revokeInvite } =
    useInvites(workspaceId);

  useEffect(() => {
    fetchInvites();
  }, [workspaceId]);

  const copyInviteLink = (inviteId: string) => {
    const url = `${window.location.origin}/invite/accept?inviteId=${inviteId}&workspaceId=${workspaceId}`;
    navigator.clipboard.writeText(url);
    toast.success('Invite link copied!');
  };

  const getStatusBadge = (status: InviteStatus) => {
    const styles = {
      invited: 'bg-blue-100 text-blue-800',
      accepted: 'bg-green-100 text-green-800',
      revoked: 'bg-red-100 text-red-800',
      expired: 'bg-gray-100 text-gray-800',
    };

    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${styles[status]}`}>
        {status}
      </span>
    );
  };

  const getRoleBadge = (role: string) => {
    const label = role === 'full_access' ? 'Full Access' : 'View Only';
    const color = role === 'full_access' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-800';

    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${color}`}>
        {label}
      </span>
    );
  };

  if (loading) {
    return <div>Loading invites...</div>;
  }

  if (invites.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No pending invitations
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Email
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Role
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Created
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {invites.map((invite) => (
            <tr key={invite.id}>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center">
                  <Mail className="w-4 h-4 text-gray-400 mr-2" />
                  <span className="text-sm text-gray-900">{invite.email}</span>
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                {getRoleBadge(invite.role)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                {getStatusBadge(invite.status)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {formatDistanceToNow(new Date(invite.created_at), {
                  addSuffix: true,
                })}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                {invite.status === 'invited' && (
                  <div className="flex space-x-2">
                    <button
                      onClick={() => resendInvite(invite.id)}
                      className="text-blue-600 hover:text-blue-900"
                      title="Resend invitation"
                    >
                      <RotateCw className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => copyInviteLink(invite.id)}
                      className="text-gray-600 hover:text-gray-900"
                      title="Copy invite link"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => revokeInvite(invite.id)}
                      className="text-red-600 hover:text-red-900"
                      title="Revoke invitation"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## UI компоненты

### Модальное окно создания invite

```tsx
// components/InviteModal.tsx

import { useState } from 'react';
import { Dialog } from '@headlessui/react';
import { X, Copy } from 'lucide-react';
import { useCreateInvite } from '@/hooks/useInvites';

interface InviteModalProps {
  workspaceId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function InviteModal({
  workspaceId,
  isOpen,
  onClose,
  onSuccess,
}: InviteModalProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'full_access' | 'view'>('full_access');
  const [showCopyLink, setShowCopyLink] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');

  const { createInvite, loading } = useCreateInvite(workspaceId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const response = await createInvite(email, role);

      if (response.emailSent) {
        // Email отправлен успешно
        setEmail('');
        setRole('full_access');
        onSuccess?.();
        onClose();
      } else {
        // Email не отправлен - показать ссылку
        setShowCopyLink(true);
        setInviteUrl(response.inviteUrl);
      }
    } catch (error) {
      // Ошибка уже обработана в хуке
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(inviteUrl);
    toast.success('Link copied to clipboard!');
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="mx-auto max-w-md w-full bg-white rounded-lg shadow-xl">
          <div className="flex items-center justify-between p-6 border-b">
            <Dialog.Title className="text-lg font-semibold">
              Invite Team Member
            </Dialog.Title>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6">
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as any)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="full_access">Full Access</option>
                <option value="view">View Only</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {role === 'full_access'
                  ? 'Can create, edit, and delete resources'
                  : 'Can only view workspace content'}
              </p>
            </div>

            {showCopyLink && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="text-sm text-yellow-800 mb-2">
                  ⚠️ Email could not be sent. Please copy and share this link:
                </p>
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={inviteUrl}
                    readOnly
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md bg-white"
                  />
                  <button
                    type="button"
                    onClick={copyToClipboard}
                    className="px-3 py-2 bg-gray-800 text-white rounded-md hover:bg-gray-700"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending...' : 'Send Invitation'}
              </button>
            </div>
          </form>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
```

### Страница Team Settings

```tsx
// pages/WorkspaceTeam.tsx

import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { InviteModal } from '@/components/InviteModal';
import { InvitesList } from '@/components/InvitesList';
import { MembersList } from '@/components/MembersList';

interface WorkspaceTeamProps {
  workspaceId: string;
}

export function WorkspaceTeam({ workspaceId }: WorkspaceTeamProps) {
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleInviteSuccess = () => {
    setRefreshKey((prev) => prev + 1); // Trigger refresh
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team Members</h1>
          <p className="text-gray-600">Manage workspace members and invitations</p>
        </div>
        <button
          onClick={() => setShowInviteModal(true)}
          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <UserPlus className="w-4 h-4 mr-2" />
          Invite Member
        </button>
      </div>

      {/* Active Members */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Active Members</h2>
        <div className="bg-white rounded-lg shadow">
          <MembersList workspaceId={workspaceId} />
        </div>
      </div>

      {/* Pending Invites */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Pending Invitations</h2>
        <div className="bg-white rounded-lg shadow">
          <InvitesList key={refreshKey} workspaceId={workspaceId} />
        </div>
      </div>

      {/* Invite Modal */}
      <InviteModal
        workspaceId={workspaceId}
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        onSuccess={handleInviteSuccess}
      />
    </div>
  );
}
```

### Banner для pending invites

```tsx
// components/PendingInvitesBanner.tsx

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail } from 'lucide-react';

export function PendingInvitesBanner() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);

  useEffect(() => {
    // Fetch pending invites count
    // TODO: Implement API endpoint /users/me/pending-invites
    // For now, mock:
    setCount(0);
  }, []);

  if (count === 0) return null;

  return (
    <div className="bg-blue-50 border-b border-blue-200">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Mail className="w-5 h-5 text-blue-600" />
          <p className="text-sm text-blue-800">
            You have <strong>{count}</strong> pending workspace invitation
            {count > 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => navigate('/invitations')}
          className="text-sm font-medium text-blue-600 hover:text-blue-800"
        >
          View Invitations →
        </button>
      </div>
    </div>
  );
}
```

---

## Примеры кода

### Полный flow: От invite до accept

```typescript
// ============================================================================
// 1. OWNER: Создает invite
// ============================================================================

async function inviteUser(email: string) {
  const response = await workspaceApi.createInvite(workspaceId, {
    email: 'newuser@example.com',
    role: 'full_access',
  });

  if (response.emailSent) {
    console.log('✅ Email sent!');
    console.log('User exists?', response.userExists);
    console.log('Invite URL:', response.inviteUrl);
  } else {
    console.log('❌ Email failed');
    console.log('Copy this link:', response.inviteUrl);
  }
}

// ============================================================================
// 2. INVITED USER: Получает email, кликает, попадает на /invite/accept
// ============================================================================

// React Router обрабатывает /invite/accept
// InviteAcceptPage автоматически вызывает:

async function autoAcceptInvite(inviteId: string) {
  try {
    const response = await workspaceApi.acceptInvite(inviteId);

    if (response.success) {
      console.log('✅ Joined workspace!');
      navigate(`/workspaces/${workspaceId}`);
    }
  } catch (error) {
    console.error('❌ Failed to accept', error);
  }
}

// ============================================================================
// 3. В workspace: Пользователь видит нового мембера
// ============================================================================

// MembersList автоматически подтянет нового члена команды
```

### Error Handling

```typescript
// Обработка всех возможных ошибок

async function createInviteWithErrorHandling(
  workspaceId: string,
  email: string,
  role: 'full_access' | 'view'
) {
  try {
    const response = await workspaceApi.createInvite(workspaceId, {
      email,
      role,
    });

    return response;
  } catch (error: any) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.error;

    switch (status) {
      case 400:
        if (errorMsg?.includes('already a member')) {
          toast.error('This user is already a member of this workspace');
        } else if (errorMsg?.includes('pending invite')) {
          toast.error('An invitation is already pending for this email');
        } else {
          toast.error('Invalid email or role');
        }
        break;

      case 401:
        toast.error('You need to log in first');
        navigate('/login');
        break;

      case 403:
        toast.error('Only workspace owners can invite members');
        break;

      case 404:
        toast.error('Workspace not found');
        break;

      case 500:
        toast.error('Server error. Please try again later.');
        break;

      default:
        toast.error('Failed to create invitation');
    }

    throw error;
  }
}
```

### Loading States

```typescript
// Правильная обработка loading состояний

function InviteButton() {
  const [isInviting, setIsInviting] = useState(false);

  const handleInvite = async () => {
    setIsInviting(true);

    try {
      await workspaceApi.createInvite(workspaceId, {
        email,
        role,
      });

      toast.success('Invitation sent!');
    } catch (error) {
      // Error handled in function
    } finally {
      setIsInviting(false);
    }
  };

  return (
    <button onClick={handleInvite} disabled={isInviting}>
      {isInviting ? (
        <>
          <Spinner className="w-4 h-4 mr-2" />
          Sending...
        </>
      ) : (
        <>
          <Mail className="w-4 h-4 mr-2" />
          Send Invitation
        </>
      )}
    </button>
  );
}
```

---

## Edge cases

### 1. Пользователь не залогинен при переходе по invite ссылке

```typescript
// В InviteAcceptPage

useEffect(() => {
  const token = getToken();

  if (!token) {
    // Сохраняем текущий URL для возврата после логина
    const returnUrl = window.location.pathname + window.location.search;
    navigate(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
    return;
  }

  acceptInvite();
}, []);
```

```typescript
// После логина в LoginPage

const handleLoginSuccess = (token: string) => {
  localStorage.setItem('token', token);

  // Проверяем, есть ли returnUrl
  const params = new URLSearchParams(window.location.search);
  const returnUrl = params.get('returnUrl');

  if (returnUrl) {
    navigate(decodeURIComponent(returnUrl));
  } else {
    navigate('/workspaces');
  }
};
```

### 2. Invite истек

```typescript
// Backend вернет 400 с error: "This invite has expired"

catch (error) {
  if (error.response?.data?.error?.includes('expired')) {
    setMessage('This invitation has expired.');
    setShowContactOwner(true); // Показать кнопку "Contact Owner"
  }
}
```

### 3. Email mismatch

```typescript
// Backend проверяет: email пользователя === email в invite

// Если не совпадает:
{
  "success": false,
  "error": "This invite was sent to a different email address"
}

// На фронте:
if (error.includes('email')) {
  setMessage(
    'This invitation was sent to a different email. Please log in with the correct account.'
  );
}
```

### 4. Invite уже принят

```typescript
// Если пользователь кликает по ссылке повторно

if (error.includes('already accepted')) {
  setMessage('You have already joined this workspace.');
  // Редирект в workspace
  setTimeout(() => navigate(`/workspaces/${workspaceId}`), 2000);
}
```

### 5. Email не отправился

```typescript
// При создании invite:

if (!response.emailSent) {
  // Показать предупреждение и ссылку для копирования
  showWarning({
    title: 'Email not sent',
    message: 'Please share this invite link manually:',
    copyLink: response.inviteUrl,
  });
}
```

### 6. Duplicate invite

```typescript
// Backend не позволит создать 2 pending invite на один email

// Response:
{
  "success": false,
  "error": "An invite for this email is already pending"
}

// На фронте:
toast.error('An invitation is already pending for this email. You can resend it from the invitations list.');
```

### 7. Пользователь уже член workspace

```typescript
// Backend проверяет перед созданием invite

// Response:
{
  "success": false,
  "error": "User is already a member of this workspace"
}

// На фронте:
toast.error('This user is already a member of the workspace.');
```

---

## Тестирование

### Unit Tests (Jest + React Testing Library)

```typescript
// __tests__/InviteModal.test.tsx

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InviteModal } from '@/components/InviteModal';
import { workspaceApi } from '@/api/workspaces';

jest.mock('@/api/workspaces');

describe('InviteModal', () => {
  const mockOnClose = jest.fn();
  const mockOnSuccess = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should render invite form', () => {
    render(
      <InviteModal
        workspaceId="test-id"
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    expect(screen.getByText('Invite Team Member')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument();
  });

  it('should create invite successfully', async () => {
    const mockResponse = {
      success: true,
      emailSent: true,
      userExists: false,
      inviteUrl: 'https://test.com/invite/accept?inviteId=xxx',
      message: 'Invite sent',
    };

    (workspaceApi.createInvite as jest.Mock).mockResolvedValue(mockResponse);

    render(
      <InviteModal
        workspaceId="test-id"
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    const emailInput = screen.getByPlaceholderText('user@example.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByText('Send Invitation');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(workspaceApi.createInvite).toHaveBeenCalledWith('test-id', {
        email: 'test@example.com',
        role: 'full_access',
      });
      expect(mockOnSuccess).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('should show copy link when email fails', async () => {
    const mockResponse = {
      success: true,
      emailSent: false,
      inviteUrl: 'https://test.com/invite/accept?inviteId=xxx',
    };

    (workspaceApi.createInvite as jest.Mock).mockResolvedValue(mockResponse);

    render(
      <InviteModal
        workspaceId="test-id"
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    const emailInput = screen.getByPlaceholderText('user@example.com');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    const submitButton = screen.getByText('Send Invitation');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/Email could not be sent/i)).toBeInTheDocument();
      expect(screen.getByDisplayValue(mockResponse.inviteUrl)).toBeInTheDocument();
    });
  });
});
```

### Integration Tests (Cypress)

```typescript
// cypress/e2e/invites.cy.ts

describe('Workspace Invites', () => {
  beforeEach(() => {
    cy.login(); // Custom command для логина
    cy.visit('/workspaces/test-workspace-id/team');
  });

  it('should create and send invite', () => {
    // Открыть модалку
    cy.contains('Invite Member').click();

    // Заполнить форму
    cy.get('input[type="email"]').type('newuser@example.com');
    cy.get('select').select('full_access');

    // Отправить
    cy.contains('Send Invitation').click();

    // Проверить успех
    cy.contains('Invitation sent successfully').should('be.visible');

    // Проверить что invite появился в списке
    cy.contains('newuser@example.com').should('be.visible');
    cy.contains('invited').should('be.visible');
  });

  it('should accept invite', () => {
    // Мокаем invite ID
    const inviteId = 'test-invite-id';
    const workspaceId = 'test-workspace-id';

    // Переходим по invite ссылке
    cy.visit(`/invite/accept?inviteId=${inviteId}&workspaceId=${workspaceId}`);

    // Ждем редиректа
    cy.url().should('include', `/workspaces/${workspaceId}`);

    // Проверяем сообщение об успехе
    cy.contains('Successfully joined').should('be.visible');
  });

  it('should handle expired invite', () => {
    const expiredInviteId = 'expired-invite-id';

    cy.visit(`/invite/accept?inviteId=${expiredInviteId}`);

    cy.contains('This invitation has expired').should('be.visible');
  });
});
```

### E2E Test Scenario

```typescript
// Полный сценарий: от создания до accept

describe('Full Invite Flow', () => {
  it('should complete invite flow from creation to acceptance', () => {
    // 1. Owner создает invite
    cy.login('owner@example.com');
    cy.visit('/workspaces/test-id/team');
    cy.contains('Invite Member').click();
    cy.get('input[type="email"]').type('newuser@example.com');
    cy.contains('Send Invitation').click();

    // 2. Копируем invite link
    cy.contains('Copy Link').click();
    cy.window().then((win) => {
      win.navigator.clipboard.readText().then((text) => {
        const url = new URL(text);
        const inviteId = url.searchParams.get('inviteId');

        // 3. Новый пользователь переходит по ссылке
        cy.clearCookies();
        cy.visit(text);

        // 4. Регистрация (если новый)
        // ... set password through Supabase
        // После регистрации автоматический редирект на /invite/accept

        // 5. Accept происходит автоматически
        cy.url().should('include', '/workspaces/');
        cy.contains('Welcome aboard').should('be.visible');

        // 6. Owner видит нового члена команды
        cy.login('owner@example.com');
        cy.visit('/workspaces/test-id/team');
        cy.contains('newuser@example.com').should('be.visible');
        cy.contains('active').should('be.visible');
      });
    });
  });
});
```

---

## Чек-лист интеграции

### Backend готов ✅
- [x] API endpoints работают
- [x] Email отправка настроена
- [x] Логирование включено

### Frontend TODO
- [ ] Установить зависимости (`axios`, `react-router-dom`, UI библиотека)
- [ ] Создать API client (`api/workspaces.ts`)
- [ ] Создать TypeScript types
- [ ] Создать React hooks (`useInvites`, `useCreateInvite`)
- [ ] Создать компоненты:
  - [ ] `InviteModal` - модалка создания invite
  - [ ] `InvitesList` - список invites
  - [ ] `InviteAcceptPage` - страница принятия
  - [ ] `PendingInvitesBanner` - banner для pending invites (опционально)
- [ ] Настроить роутинг (`/invite/accept`)
- [ ] Добавить в Workspace Settings страницу Team
- [ ] Обработать все edge cases
- [ ] Добавить тесты
- [ ] Добавить в Supabase Redirect URLs: `https://qait.dev/invite/accept*`

### Testing
- [ ] Unit tests для компонентов
- [ ] Integration tests для API calls
- [ ] E2E tests для полного flow
- [ ] Протестировать оба сценария (новый + существующий пользователь)
- [ ] Протестировать edge cases (expired, revoked, email mismatch)

---

## Полезные ссылки

- **Backend API Docs**: `/docs/WORKSPACE_INVITES.md`
- **Backend Testing**: `/INVITE_TESTING.md`
- **Supabase Auth Docs**: https://supabase.com/docs/guides/auth
- **React Router**: https://reactrouter.com/
- **TypeScript**: https://www.typescriptlang.org/

---

## Поддержка

Если возникли вопросы:
1. Проверьте логи backend: `docker logs backend | grep WORKSPACE_MEMBERS`
2. Проверьте Network tab в DevTools
3. Проверьте Supabase Dashboard → Logs
4. Проверьте Console для ошибок JS

---

**Готово!** 🚀 Теперь у вас есть всё для интеграции team invites на фронтенде.
