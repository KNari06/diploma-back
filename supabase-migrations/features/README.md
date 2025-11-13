# ✨ Feature Migrations

Feature-specific database migrations for QAIT Backend.

## 📋 Available Features

### 1️⃣ Authentication & Users

#### `auth-sync.sql`
- Syncs Supabase auth.users with public.users
- Triggers for auto user creation
- User deletion handling

**Apply when:**
- Setting up authentication
- Need auto-sync between auth and public tables

---

### 2️⃣ Workspace & Projects

#### `workspaces.sql`
- Workspace table and relationships
- Project associations
- User workspace permissions

**Apply when:**
- Adding workspace feature
- Multi-project support needed

#### `default-project.sql`
- Creates default project for users
- Auto-assignment logic

**Apply when:**
- Need default workspace on signup

---

### 3️⃣ Knowledge Base

#### `knowledge-base-safe.sql`
- Global KB chunks
- Project KB chunks
- Vector embeddings (pgvector)
- Search functions

**Apply when:**
- Adding RAG/KB features
- Need semantic search

---

### 4️⃣ Testing Features

#### `autonomous-exploration.sql`
- Autonomous test exploration
- Exploration cache
- Test plans

**Apply when:**
- Adding intelligent testing
- Autonomous mode needed

#### `playwright-traces.sql`
- Trace file storage
- Browser automation artifacts

**Apply when:**
- Need to store Playwright traces
- Visual regression testing

#### `test-chat-mappings.sql`
- Link tests to chat sessions
- Test context tracking

**Apply when:**
- Connecting tests with chat
- Need test conversation history

---

### 5️⃣ API Configuration

#### `api-configurations.sql`
- API environment configs
- Base URLs (dev/prod)
- API credentials storage

**Apply when:**
- Adding API testing features
- Need environment management

---

### 6️⃣ Integrations

#### `jira-oauth.sql`
- Jira OAuth tokens
- Integration settings

**Apply when:**
- Adding Jira integration
- Need OAuth flow

---

### 7️⃣ Credits & Billing

#### `token-based-credits-system.sql`
- User credits table
- Credit transactions
- Subscription management
- Balance tracking

**Apply when:**
- Adding billing/credits system
- Token-based usage tracking

---

### 8️⃣ AI Improvement & Feedback

#### `message-feedback.sql`
- User feedback (like/dislike) on AI messages
- Feedback analytics view
- RLHF data collection
- Intent-based statistics

**Apply when:**
- Want to collect user feedback on AI responses
- Need RLHF (Reinforcement Learning from Human Feedback) data
- Building AI improvement pipeline

---

## 🚀 How to Apply

### Single Feature:

```sql
-- In Supabase SQL Editor
\i features/jira-oauth.sql
```

### Multiple Features:

```sql
-- Apply in order (dependencies matter!)

-- 1. Core features first
\i features/auth-sync.sql
\i features/workspaces.sql
\i features/default-project.sql

-- 2. Knowledge base
\i features/knowledge-base-safe.sql

-- 3. Testing features
\i features/autonomous-exploration.sql
\i features/playwright-traces.sql
\i features/test-chat-mappings.sql

-- 4. API & integrations
\i features/api-configurations.sql
\i features/jira-oauth.sql

-- 5. Credits system
\i features/token-based-credits-system.sql

-- 6. AI improvement
\i features/message-feedback.sql
```

---

## 📋 Dependencies

Some features depend on others:

```
auth-sync.sql
├── workspaces.sql
│   ├── default-project.sql
│   └── api-configurations.sql
└── token-based-credits-system.sql

knowledge-base-safe.sql
└── workspaces.sql

autonomous-exploration.sql
├── workspaces.sql
└── test-chat-mappings.sql
```

---

## ⚠️ Important

- Check dependencies before applying
- Some features require core schema first
- Test on staging before production
- Review SQL before running

---

**Last updated:** 2024-11-13
