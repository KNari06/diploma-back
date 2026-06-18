# 📑 Migration Index

Quick reference for all database migrations.

## 🎯 Quick Start

**New Installation:**

```bash
psql -f schema/recreate-all-tables-with-text-user-id.sql
psql -f features/auth-sync.sql
psql -f features/token-based-credits-system.sql
```

**Add Feature:**

```bash
psql -f features/<feature-name>.sql
```

---

## 📁 Directory Structure

```
supabase-migrations/
│
├── 📋 INDEX.md                          (this file)
├── 📖 README.md                         (detailed overview)
│
├── 🏗️  schema/                           Main database schemas
│   ├── README.md
│   └── recreate-all-tables-with-text-user-id.sql
│
├── ✨ features/                          Feature migrations
│   ├── README.md
│   ├── auth-sync.sql
│   ├── jira-oauth.sql
│   ├── knowledge-base-safe.sql
│   ├── playwright-traces.sql
│   ├── api-configurations.sql
│   ├── workspaces.sql
│   ├── default-project.sql
│   ├── autonomous-exploration.sql
│   ├── test-chat-mappings.sql
│   └── token-based-credits-system.sql
│
├── 🔄 migrations/                        Data migrations
│   ├── README.md
│   ├── anonymous-to-auth-migration.sql
│   └── anonymous-chat-limits.sql
│
├── 📚 docs/                              Documentation
│   ├── QUICK_START.md
│   └── README_TRACES.md
│
└── 📦 archive/                           Deprecated migrations
    └── (old migrations)
```

---

## 🗂️ File Categories

### 🏗️ Schema (1 file)

| File                                        | Purpose            | Status    |
| ------------------------------------------- | ------------------ | --------- |
| `recreate-all-tables-with-text-user-id.sql` | Complete DB schema | ✅ Active |

---

### ✨ Features (10 files)

| File                             | Feature              | Dependencies |
| -------------------------------- | -------------------- | ------------ |
| `auth-sync.sql`                  | Auth synchronization | None         |
| `workspaces.sql`                 | Workspace management | auth-sync    |
| `workspace-projects-workspace-id-backfill.sql` | Backfill projects.workspace_id (re-run, idempotent) | workspaces |
| `workspace-projects-workspace-id-notnull.sql` | Enforce projects.workspace_id NOT NULL (deploy AFTER backfill) | workspace-projects-workspace-id-backfill |
| `workspace-org-members.sql`      | B2B org: members, invites, credits, audit | workspaces, auth-sync |
| `workspace-org-rls-update.sql`   | RLS for membership-based access | workspace-org-members |
| `default-project.sql`            | Default workspace    | workspaces   |
| `api-configurations.sql`         | API environments     | workspaces   |
| `knowledge-base-safe.sql`        | RAG/KB system        | workspaces   |
| `autonomous-exploration.sql`     | Intelligent testing  | workspaces   |
| `playwright-traces.sql`          | Trace storage        | None         |
| `test-chat-mappings.sql`         | Test-chat links      | workspaces   |
| `jira-oauth.sql`                 | Jira integration     | auth-sync    |
| `token-based-credits-system.sql` | Credits/billing      | auth-sync    |

---

### 🔄 Migrations (2 files)

| File                              | Purpose               | Type   |
| --------------------------------- | --------------------- | ------ |
| `anonymous-to-auth-migration.sql` | Migrate anon → auth   | Data   |
| `anonymous-chat-limits.sql`       | Anonymous rate limits | Schema |

---

## 🎯 Common Workflows

### 1️⃣ New Project Setup

```sql
-- Run in order:
\i schema/recreate-all-tables-with-text-user-id.sql
\i features/auth-sync.sql
\i features/workspaces.sql
\i features/token-based-credits-system.sql
\i migrations/anonymous-chat-limits.sql
```

---

### 2️⃣ Add Jira Integration

```sql
-- Prerequisites: auth-sync must be applied
\i features/jira-oauth.sql
```

---

### 3️⃣ Add Knowledge Base

```sql
-- Prerequisites: workspaces must exist
\i features/knowledge-base-safe.sql
```

---

### 4️⃣ Enable Autonomous Testing

```sql
-- Prerequisites: workspaces
\i features/autonomous-exploration.sql
\i features/playwright-traces.sql
\i features/test-chat-mappings.sql
```

---

## 🔍 Search Guide

**Looking for...**

- **Tables?** → `schema/`
- **New feature?** → `features/`
- **Data migration?** → `migrations/`
- **How-to guides?** → `docs/`
- **Old migrations?** → `archive/`

---

## 📞 Need Help?

- See detailed README in each folder
- Check `/docs/` for guides
- Review SQL comments in files

---

**Last updated:** 2025-11-11
