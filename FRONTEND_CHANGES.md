# Frontend Integration Guide — Backend Changes

> Generated: 2026-02-10
> Backend branch: `main`
> API base: `/api/v1`

---

## Table of Contents

1. [New API Endpoints](#1-new-api-endpoints)
2. [Modified API Endpoints](#2-modified-api-endpoints)
3. [New Database Tables](#3-new-database-tables)
4. [OAuth Flows](#4-oauth-flows)
5. [Chat / AI Changes](#5-chat--ai-changes)
6. [New Frontend Pages & Components](#6-new-frontend-pages--components)
7. [Breaking Changes](#7-breaking-changes)
8. [Environment Variables](#8-environment-variables)

---

## 1. New API Endpoints

### 1.1 List Connected Integrations

```
GET /api/v1/integrations
Authorization: Bearer <token>
```

**Query Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `workspace_id` | string | No | Filter by workspace |

**Response 200:**

```json
{
  "success": true,
  "integrations": [
    {
      "id": "uuid",
      "provider": "jira",
      "external_id": "cloud-id-or-username",
      "external_url": "https://your-site.atlassian.net",
      "enabled": true,
      "created_at": "2026-02-10T12:00:00.000Z",
      "updated_at": "2026-02-10T12:00:00.000Z"
    }
  ],
  "timestamp": "2026-02-10T12:00:00.000Z"
}
```

**Providers:** `jira`, `github`, `notion`, `telegram`, `gitlab`, `slack`, `trello`

---

### 1.2 Start OAuth Authorization

```
GET /api/v1/integrations/:provider/authorize
Authorization: Bearer <token>
```

**Path Params:**

| Param | Type | Values |
|-------|------|--------|
| `provider` | string | `jira`, `github`, `notion` |

**Query Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `workspace_id` | string | No | Associate with workspace |

**Response:** `302 Redirect` to OAuth provider consent screen.

**Implemented providers:** `jira`, `github`, `notion`
**Not implemented:** `gitlab`, `slack`, `trello` — returns `501`

---

### 1.3 OAuth Callback

```
GET /api/v1/integrations/:provider/callback
```

No auth required (called by OAuth provider).

**Response:** `302 Redirect` to:
- Success: `{FRONTEND_URL}/integrations?provider={provider}&status=success`
- Error: `{FRONTEND_URL}/integrations?status=error&message={encoded_message}`

> Frontend must handle these query params on `/integrations` page.

---

### 1.4 Disconnect Integration

```
DELETE /api/v1/integrations/:provider
Authorization: Bearer <token>
```

**Query Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `external_id` | string | No | For providers with multiple connections (e.g. multiple Jira sites) |

**Response 200:**

```json
{
  "success": true,
  "message": "jira integration disconnected successfully",
  "timestamp": "2026-02-10T12:00:00.000Z"
}
```

---

### 1.5 Setup Telegram Bot (Non-OAuth)

```
POST /api/v1/integrations/telegram/setup
Authorization: Bearer <token>
Content-Type: application/json
```

**Query Params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `workspace_id` | string | No | Associate with workspace |

**Request Body:**

```json
{
  "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
  "chat_id": "-1001234567890",
  "description": "QA Notifications Bot"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bot_token` | string | Yes | Token from @BotFather |
| `chat_id` | string/number | No | Default chat/channel ID |
| `description` | string | No | User label for the bot |

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "provider": "telegram",
    "bot_username": "qa_bot",
    "bot_name": "QA Bot",
    "bot_id": 123456789,
    "chat_id": "-1001234567890",
    "external_url": "https://t.me/qa_bot",
    "enabled": true,
    "created_at": "2026-02-10T12:00:00.000Z",
    "updated_at": "2026-02-10T12:00:00.000Z"
  },
  "message": "Telegram bot configured successfully"
}
```

**Error 400 (invalid token):**

```json
{
  "success": false,
  "error": "Invalid bot token. Please verify the token from @BotFather."
}
```

---

## 2. Modified API Endpoints

### 2.1 Chat Handler (`POST /api/v1/chat`)

Route unchanged, but behavior now includes **agentic tool-calling**.

**What changed:**

| Aspect | Before | After |
|--------|--------|-------|
| AI response | Single LLM call | Up to 5 tool-calling rounds |
| Integrations | Not available | Jira, GitHub, Notion, Telegram tools in chat |
| Memory | None | Persistent workspace memory loaded per request |
| Credits response | `creditsUsed` only | + `creditsRemaining`, `dailyRemaining`, `monthlyRemaining` |

**New response fields:**

```json
{
  "message": "...",
  "creditsUsed": 1,
  "creditsRemaining": 99,
  "dailyRemaining": 49,
  "monthlyRemaining": 499
}
```

**Tool confirmation pattern in chat:**

The AI now calls integration tools. For **write operations** (create issue, send message, etc.), the AI will:
1. Show a summary/preview in the chat message
2. Ask the user for confirmation ("Should I create this issue?")
3. On user approval ("yes", "ok", "да", "ия"), execute the tool
4. Return the result ("Issue PROJ-123 created successfully")

For **read operations** (search, list, get), tools execute immediately without confirmation.

For **memory operations** (remember, search, forget), tools execute silently — the user does not see them.

---

## 3. New Database Tables

### 3.1 `integration_tokens`

Unified OAuth token storage for all providers. Replaces provider-specific tables.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `user_id` | UUID | FK → users |
| `workspace_id` | UUID | FK → workspaces, nullable |
| `provider` | VARCHAR(50) | jira, github, notion, telegram, etc. |
| `access_token` | TEXT | Encrypted at rest |
| `refresh_token` | TEXT | Nullable |
| `expires_at` | TIMESTAMPTZ | Nullable |
| `scope` | TEXT | OAuth scopes |
| `token_type` | VARCHAR(50) | Bearer, Bot, etc. |
| `external_id` | TEXT | Provider-specific ID |
| `external_url` | TEXT | Provider-specific URL |
| `metadata` | JSONB | Extra provider data |
| `enabled` | BOOLEAN | Default true |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Unique constraint:** `(user_id, provider, external_id)`

**SQL migration file:** `supabase-migrations/20260211_integration_tokens.sql`

---

### 3.2 `workspace_memory`

Persistent semantic memory with vector embeddings.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `workspace_id` | UUID | FK → workspaces |
| `user_id` | UUID | FK → users (audit) |
| `category` | VARCHAR(50) | fact, preference, test_pattern, bug_pattern, integration_context |
| `key` | VARCHAR(255) | Unique per workspace |
| `content` | TEXT | Memory content |
| `embedding` | vector(1536) | OpenAI text-embedding-3-small |
| `source` | VARCHAR(50) | agent_written, auto_extracted, user_provided |
| `confidence` | FLOAT | 0.0–1.0 |
| `access_count` | INTEGER | Usage tracking |
| `metadata` | JSONB | |
| `expires_at` | TIMESTAMPTZ | Optional TTL |

**Unique constraint:** `(workspace_id, key)`

**SQL migration file:** `supabase-migrations/20260211_workspace_memory.sql`

> Frontend does not directly query this table. Memory is managed internally by the AI agent.

---

## 4. OAuth Flows

### 4.1 GitHub / Notion (Standard OAuth 2.0)

```
Frontend                    Backend                         Provider
   │                           │                               │
   │  Click "Connect GitHub"   │                               │
   ├──────────────────────────>│                               │
   │  GET /integrations/       │                               │
   │  github/authorize         │                               │
   │  ?workspace_id=xxx        │                               │
   │                           │  302 Redirect                 │
   │                           ├──────────────────────────────>│
   │                           │  OAuth consent screen         │
   │                           │                               │
   │                           │  callback?code=xxx&state=xxx  │
   │                           │<──────────────────────────────┤
   │                           │  Exchange code → token        │
   │                           │  Save to integration_tokens   │
   │  302 Redirect             │                               │
   │  /integrations?status=    │                               │
   │  success&provider=github  │                               │
   │<──────────────────────────┤                               │
   │                           │                               │
   │  Show success toast       │                               │
   │  Refresh integrations list│                               │
```

### 4.2 Jira (Atlassian OAuth 2.0 3-LO)

Same flow as above, but:
- Uses existing `/api/v1/jira/authorize` internally
- Callback saves to `integration_tokens` (new) with dual-read fallback to `jira_tokens` (legacy)
- `external_id` = Jira Cloud ID, `external_url` = Jira site URL

### 4.3 Telegram (Non-OAuth)

No redirect flow. Frontend collects bot token directly:

```
Frontend                    Backend
   │                           │
   │  POST /integrations/      │
   │  telegram/setup           │
   │  { bot_token, chat_id }   │
   ├──────────────────────────>│
   │                           │  Validate via Telegram getMe API
   │                           │  Save to integration_tokens
   │  200 { data: bot info }   │
   │<──────────────────────────┤
   │                           │
   │  Show success, display    │
   │  bot info                 │
```

---

## 5. Chat / AI Changes

### 5.1 Skills & Tools Available in Chat

The AI agent now has 20 tools across 5 skills:

| Skill | Tools | Confirmation Required |
|-------|-------|----------------------|
| **Jira** | `jira_create_issue`, `jira_search_issues`, `jira_add_comment`, `jira_get_issue`, `jira_transition_issue` | Write: yes, Read: no |
| **GitHub** | `github_create_issue`, `github_list_prs`, `github_add_comment`, `github_get_repo` | Write: yes, Read: no |
| **Notion** | `notion_create_page`, `notion_search`, `notion_update_page`, `notion_add_to_database` | Write: yes, Read: no |
| **Telegram** | `telegram_send_message`, `telegram_get_chat`, `telegram_send_document`, `telegram_send_notification` | Write: yes, Read: no |
| **Memory** | `remember_fact`, `search_memory`, `forget_fact` | None (silent) |

### 5.2 Approval Detection

The AI detects user approval in multiple languages:

| Language | Approve examples | Reject examples |
|----------|-----------------|-----------------|
| English | yes, ok, approve, go ahead, do it | no, cancel, stop, don't |
| Russian | да, ок, давай, одобряю, создавай | нет, отмена, стоп, не надо |
| Kazakh | ия, жарайды, бар, жібер | жоқ, тоқта, болдырма |

### 5.3 What Frontend Sees

The tool execution is transparent to the frontend. The chat response text will contain:
- Tool result summaries (e.g., "I created Jira issue PROJ-123: Login timeout bug")
- Confirmation requests for write ops (e.g., "I'll create a GitHub issue with title 'Fix CSS bug'. Should I proceed?")
- No visible memory operations

No changes to the chat API request/response format are needed — the AI handles tools internally and returns a final text response.

---

## 6. New Frontend Pages & Components

### 6.1 Integrations Page (`/integrations`)

**Required — new page.**

**Features:**
- List of provider cards (Jira, GitHub, Notion, Telegram)
- Connection status per provider (connected/disconnected)
- "Connect" button → navigates to `GET /api/v1/integrations/:provider/authorize?workspace_id=...`
- "Disconnect" button → `DELETE /api/v1/integrations/:provider`
- Handle OAuth redirect query params: `?provider=...&status=success|error&message=...`

**Provider card data (from GET /api/v1/integrations):**

```typescript
interface Integration {
  id: string;
  provider: 'jira' | 'github' | 'notion' | 'telegram' | 'gitlab' | 'slack' | 'trello';
  external_id: string;   // e.g. GitHub username, Jira cloud ID
  external_url: string;  // e.g. profile URL, site URL
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
```

### 6.2 Telegram Setup Modal/Form

**Required — part of integrations page.**

Since Telegram uses bot tokens (not OAuth), the frontend needs a form:

| Field | Type | Required | Placeholder |
|-------|------|----------|-------------|
| Bot Token | password input | Yes | `123456789:ABCdef...` |
| Chat ID | text input | No | `-1001234567890` |
| Description | text input | No | `QA Notifications Bot` |

Submit → `POST /api/v1/integrations/telegram/setup`

### 6.3 Chat UI Updates

**Recommended — enhance existing chat.**

| Component | Description | Priority |
|-----------|-------------|----------|
| Tool execution indicator | Show spinner/text when AI is executing tools (e.g., "Searching Jira...") | Medium |
| Tool result card | Styled display for tool results (Jira issue link, GitHub PR list, etc.) | Low |
| Credits display | Show `creditsRemaining`, `dailyRemaining`, `monthlyRemaining` from response | Low |

> Tool confirmation is handled in-chat via natural language — no special UI components required.

---

## 7. Breaking Changes

### 7.1 Jira Token Migration

| Before | After |
|--------|-------|
| Tokens in `jira_tokens` table | Tokens in `integration_tokens` table |
| Direct queries to `jira_tokens` | IntegrationTokenService (dual-read fallback) |

**Frontend impact:** None. Backend handles the migration transparently. The new unified `GET /api/v1/integrations` endpoint replaces any direct `jira_tokens` queries the frontend may have used.

### 7.2 Chat Response Shape

New optional fields added (non-breaking):

```diff
  {
    "message": "...",
    "creditsUsed": 1,
+   "creditsRemaining": 99,
+   "dailyRemaining": 49,
+   "monthlyRemaining": 499
  }
```

### 7.3 OAuth Callback Redirects

The backend now redirects OAuth callbacks to:
```
{FRONTEND_URL}/integrations?provider={provider}&status=success
{FRONTEND_URL}/integrations?status=error&message={encoded_message}
```

The frontend **must** handle these URLs. If `/integrations` page doesn't exist yet, create it.

---

## 8. Environment Variables

New backend env vars (backend-only, no frontend impact):

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID | For GitHub integration |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret | For GitHub integration |
| `NOTION_CLIENT_ID` | Notion OAuth client ID | For Notion integration |
| `NOTION_CLIENT_SECRET` | Notion OAuth client secret | For Notion integration |
| `JIRA_CLIENT_ID` | Jira/Atlassian OAuth client ID | For Jira integration |
| `JIRA_CLIENT_SECRET` | Jira/Atlassian OAuth client secret | For Jira integration |
| `TELEGRAM_BOT_TOKEN` | Global fallback Telegram bot token | Optional |
| `BACKEND_URL` | Full backend URL for OAuth callbacks | Yes |
| `FRONTEND_URL` | Full frontend URL for OAuth redirects | Yes |
| `AI_PROVIDER_FAST` | `gemini` or `openai` for fast tasks | No (default: gemini) |
| `AI_PROVIDER_SMART` | `openai` or `gemini` for complex tasks | No (default: openai) |
| `OPENAI_API_KEY` | For embeddings (memory) & chat | Yes |

---

## Quick Start Checklist

- [ ] Create `/integrations` page
- [ ] Handle OAuth redirect query params (`?provider=...&status=...`)
- [ ] Add "Connect" buttons for Jira, GitHub, Notion
- [ ] Add Telegram bot setup form
- [ ] Call `GET /api/v1/integrations` to list connections
- [ ] Call `DELETE /api/v1/integrations/:provider` to disconnect
- [ ] Parse new chat response fields (`creditsRemaining`, etc.)
- [ ] (Optional) Add tool execution indicators in chat UI
