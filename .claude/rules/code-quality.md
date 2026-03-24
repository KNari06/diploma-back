---
description: Code quality checks — roles, imports, DB fields, duplicates, performance
alwaysApply: true
---

# Code Quality Checks

## Chat Message Roles (CRITICAL)

OpenAI API requires `assistant`, but our DB uses `ai`.

```typescript
import { convertRoleForOpenAI } from "@/utils/helpers/chat-helpers";

// CORRECT
const messages = chatHistory.map((msg) => ({
  role: convertRoleForOpenAI(msg.role), // 'ai' → 'assistant'
  content: msg.content,
}));

// WRONG — will cause 400 from OpenAI
const messages = chatHistory.map((msg) => ({
  role: msg.role, // 'ai' is invalid for OpenAI
  content: msg.content,
}));
```

- DB/TypeScript types: `'user' | 'ai' | 'system'`
- OpenAI accepts: `'user' | 'assistant' | 'system' | 'function' | 'tool' | 'developer'`
- Use `convertRoleForOpenAI()` before ANY OpenAI API call.

## Import verification on refactoring

When changing exports, ALWAYS check all imports:

```bash
rg "import.*from.*changed-module" src/
```

Update imports EVERYWHERE they're used.

## Database field verification

Before using a field — verify it exists in the schema (`supabase-migrations/supabase-schema.sql`).

```typescript
// CORRECT — verified fields
.select("id, url, status, created_at")

// WRONG — fields don't exist
.select("test_id, created_date")
```

## No duplicates

Before creating a new file:
- Search for existing similar functionality
- Two files with similar names = likely duplicate
- Files marked "improved", "v2", "new" = delete the old one

## Avoid N+1 queries

```typescript
// BAD — N+1
for (const r of results) {
  const test = await supabase.from("tests").select("*").eq("id", r.test_id).single();
}

// GOOD — single query
const testIds = results.map((r) => r.test_id);
const { data: tests } = await supabase.from("tests").select("*").in("id", testIds);
```

## Pre-commit checks

```bash
npm run type-check
npm run lint
```
