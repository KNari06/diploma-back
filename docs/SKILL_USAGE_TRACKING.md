# Skill / Memory usage tracking — "Used Nx" is misleading

## Problem

In the frontend Knowledge Base → **Skills** tab, every card shows a usage counter
(`Used 0x`). In practice it stays `0x` for skills that the AI agent is actually
using on every run. This makes users believe their uploaded knowledge is ignored,
when it usually is not.

A "Skill" in the UI is a row in the `workspace_memory` table. The counter shows
`access_count`.

## Root cause

The agent consumes memory through **two different paths**, and only one of them
increments `access_count`:

| Path | Where | Increments `access_count`? |
|---|---|---|
| **Context auto-injection** (primary) | `WorkspaceMemoryService.getMemoryForContext()` — called on (almost) every run | ❌ **No** |
| **Explicit search tool** (occasional) | `searchMemory()` / `readMemory()` via the memory tool the agent calls by name | ✅ Yes (`updateAccessTracking`, fire-and-forget) |

`getMemoryForContext()` pulls the top-5-by-`access_count` + 5-most-recent
memories and injects them straight into the system prompt — but it is a plain
`SELECT` with no tracking update. Since this is the path that feeds skills to the
agent on normal runs, the counter never moves, so users see `Used 0x` even though
the skill was injected into the model's context.

### Evidence (qai-backend)

- `src/services/ai/memory/workspace-memory.service.ts:345` — `getMemoryForContext()`:
  `SELECT ... order('access_count' desc).limit(5)` + recent, **no** call to
  `updateAccessTracking` / `increment_memory_access_count`.
- `src/services/ai/memory/workspace-memory.service.ts:166` — `readMemory()` calls
  `updateAccessTracking()` (the only auto path that increments).
- `src/services/ai/memory/workspace-memory.service.ts:323` — `searchMemory()` calls
  `updateAccessTracking()` per returned result.
- `src/services/ai/memory/workspace-memory.service.ts:556` — `updateAccessTracking()`:
  `rpc('increment_memory_access_count')` then bumps `access_count + 1`,
  sets `last_accessed_at`.
- Consumers of the injection path (no increment):
  - `src/agent/core/lite/lite-engine.ts:1086`
  - `src/api/chat/general/handler.ts:656`
  - `src/services/integrations/jira-qa-orchestrator.service.ts:231`
- `src/api/kb/skills.controller.ts:62` — maps `access_count` → `accessCount` for the UI.

### Secondary issue: counter reset on rewrite

- `src/services/ai/memory/workspace-memory.service.ts:101` — `writeMemory()` upserts
  on `(workspace_id, key)` and **resets `access_count: 0`**. So saving a skill whose
  key already exists wipes its usage history.
- Note: `updateMemoryById()` (edit by id, used by the UI's edit flow) does **not**
  reset `access_count` — only `writeMemory`/upsert-by-key does. So the reset bites
  on re-create/overwrite, not on a plain in-place edit.

## What "used" should mean (product decision needed)

Two distinct events, currently conflated under one number:

1. **Injected** — the skill was placed into the agent's context for a run
   (the common case; not currently counted).
2. **Searched** — the agent explicitly looked it up via the memory tool
   (the rare case; the only one counted today).

Recommendation: track **injection** as the primary "used" signal, since that is
what actually feeds the agent. Optionally keep "searched" as a separate, finer
signal.

## Proposed changes (backend)

### 1. Count injection (minimum fix)
In `getMemoryForContext()` (`workspace-memory.service.ts:345`), after selecting the
memories that are actually included in the returned context string, increment usage
for those ids (fire-and-forget, same pattern as `updateAccessTracking`). Increment
only the memories that fit within `maxChars` and are actually emitted — not the full
top-10 fetched.

Prefer a dedicated counter so semantics stay clean:
- add `injection_count` (and `last_injected_at`) columns, **or**
- reuse `access_count` if product is OK conflating both. A dedicated column is
  safer because `access_count` also drives ranking in `getMemoryForContext` and a
  composite sort score (`:360`, `:394`) — inflating it changes selection behavior.

### 2. Stop wiping history on rewrite
In `writeMemory()` (`:101`), do not hard-reset `access_count: 0` on upsert when the
row already exists; preserve the existing count (or only reset on genuine content
change if that is the desired semantics).

### 3. Surface evidence, not just a number (frontend follow-up)
Expose `last_used_at` (and ideally the run/session id where it was last used) via
`skills.controller.ts` so the UI can show "Last used · 2h ago" instead of a bare
count. This is what actually answers the user question "is the agent using this?".

## Acceptance criteria

- Running an agent task in a workspace that has enabled skills increases the
  "used" signal for the skills injected into that run (visible in the Skills tab
  after refresh).
- Editing/saving an existing skill does not reset its usage history.
- A skill that is injected but never explicitly searched no longer shows `Used 0x`
  forever.
- Ranking behavior in `getMemoryForContext` is not unintentionally skewed by the
  new counting (verified if a separate `injection_count` column is used).

## Frontend touch-points (for reference, qai-frontend)

- `apps/web/src/components/Home/KnowledgeBase/SkillCard.jsx:64` — renders `Used {count}x`.
- `apps/web/src/components/Home/KnowledgeBase/SkillDetailPanel.jsx:136` — detail "Used".
- `apps/web/src/store/knowledgeBaseStore.ts:70` — `accessCount` field.
- i18n key `knowledgeBase.skillsUsedTimes` (`Used {count}x`) — may want a
  "Last used" string added once `last_used_at` is exposed.
