---
platform: qait
version: '1.0'
description: QAIT Agent Skills Registry — Master Index
total_tools: 20
total_skills: 5
supported_ai_models:
  - gpt-4o
  - gpt-4o-mini
  - gpt-4-turbo
  - gemini-2.5-flash
  - gemini-2.0-pro
  - claude-sonnet-4-5-20250929
---

# QAIT Skills Registry

This document is the **master index** for all available skills in the QAIT agent platform. Skills are modular capabilities that extend the agent's functionality through OpenAI-compatible tool calling (function calling format). Each skill wraps an external API or internal service and exposes a set of tools that the agent can invoke during conversations.

**Total: 5 skills, 20 tools**

Each skill has its own comprehensive documentation file (`SKILL.<name>.md`) with full OpenAI function definitions, parameter tables, response examples, conversation examples, behavioral rules, and error handling — designed to be consumed by any AI model (GPT-4o, Gemini 2, Claude, etc.).

---

## Architecture

```
src/services/skills/
├── types.ts                          # SkillDefinition, SkillContext, SkillResult, IntegrationProvider
├── skill-registry.ts                 # Singleton registry — register, lookup, execute
├── index.ts                          # registerAllSkills() entry point (called from src/index.ts)
└── integrations/
    ├── jira.skill.ts                 # Jira skill implementation
    ├── github.skill.ts               # GitHub skill implementation
    ├── notion.skill.ts               # Notion skill implementation
    ├── telegram.skill.ts             # Telegram skill implementation
    └── skills/                       # Skill documentation (for AI/model context)
        ├── SKILL.jira.md             # Jira skill documentation (585 lines)
        ├── SKILL.github.md           # GitHub skill documentation (822 lines)
        ├── SKILL.notion.md           # Notion skill documentation (1092 lines)
        └── SKILL.telegram.md         # Telegram skill documentation (915 lines)

src/services/ai/memory/
├── workspace-memory.service.ts       # Memory CRUD + vector search + context loading
├── memory-tools.ts                   # Memory tools for agent (remember, search, forget)
└── SKILL.memory.md                   # Memory skill documentation (788 lines)

src/services/api/
├── jira.service.ts                   # Jira REST API client
├── github.service.ts                 # GitHub REST API client
├── notion.service.ts                 # Notion REST API client
├── telegram.service.ts               # Telegram Bot API client
└── integration-token.service.ts      # Unified token management for all providers
```

---

## Registered Skills

| #   | Skill        | Provider   | Tools | Auth            | API                          | Documentation                                               |
| --- | ------------ | ---------- | ----- | --------------- | ---------------------------- | ----------------------------------------------------------- |
| 1   | **Jira**     | `jira`     | 5     | OAuth 2.0 (3LO) | Atlassian REST API v3        | `src/services/skills/integrations/skills/SKILL.jira.md`     |
| 2   | **GitHub**   | `github`   | 4     | OAuth 2.0       | GitHub REST API v3           | `src/services/skills/integrations/skills/SKILL.github.md`   |
| 3   | **Notion**   | `notion`   | 4     | OAuth 2.0       | Notion API (2022-06-28)      | `src/services/skills/integrations/skills/SKILL.notion.md`   |
| 4   | **Telegram** | `telegram` | 4     | Bot Token       | Telegram Bot API             | `src/services/skills/integrations/skills/SKILL.telegram.md` |
| 5   | **Memory**   | `internal` | 3     | None (internal) | Supabase + OpenAI Embeddings | `src/services/ai/memory/SKILL.memory.md`                    |

---

## All Tools (20)

### Jira (5 tools)

| Tool                    | Action                                           | Type  | Confirmation |
| ----------------------- | ------------------------------------------------ | ----- | ------------ |
| `jira_create_issue`     | Create Bug/Task/Story/Epic in a Jira project     | WRITE | Required     |
| `jira_search_issues`    | Search issues using JQL queries                  | READ  | No           |
| `jira_add_comment`      | Add a comment to an existing issue               | WRITE | Required     |
| `jira_get_issue`        | Get full details of an issue by key              | READ  | No           |
| `jira_transition_issue` | Change issue status (e.g., To Do -> In Progress) | WRITE | Required     |

### GitHub (4 tools)

| Tool                  | Action                                           | Type  | Confirmation |
| --------------------- | ------------------------------------------------ | ----- | ------------ |
| `github_create_issue` | Create issue with title, body, and labels        | WRITE | Required     |
| `github_list_prs`     | List pull requests (open/closed/all)             | READ  | No           |
| `github_add_comment`  | Add comment to an issue or PR                    | WRITE | Required     |
| `github_get_repo`     | Get repository details (branch, language, stars) | READ  | No           |

### Notion (4 tools)

| Tool                     | Action                                             | Type  | Confirmation |
| ------------------------ | -------------------------------------------------- | ----- | ------------ |
| `notion_create_page`     | Create a sub-page under a parent page              | WRITE | Required     |
| `notion_search`          | Search across all shared pages by title            | READ  | No           |
| `notion_update_page`     | Update page properties (title, status, tags, etc.) | WRITE | Required     |
| `notion_add_to_database` | Add a new row/entry to a Notion database           | WRITE | Required     |

### Telegram (4 tools)

| Tool                         | Action                                          | Type  | Confirmation |
| ---------------------------- | ----------------------------------------------- | ----- | ------------ |
| `telegram_send_message`      | Send text message with HTML/Markdown formatting | WRITE | Required     |
| `telegram_get_chat`          | Get chat/group/channel info                     | READ  | No           |
| `telegram_send_document`     | Send a file via public URL                      | WRITE | Required     |
| `telegram_send_notification` | Send formatted notification with severity level | WRITE | Required     |

### Memory (3 tools)

| Tool            | Action                                             | Type     | Confirmation |
| --------------- | -------------------------------------------------- | -------- | ------------ |
| `remember_fact` | Save a fact/preference/pattern to workspace memory | INTERNAL | No           |
| `search_memory` | Semantic search across workspace memory            | INTERNAL | No           |
| `forget_fact`   | Delete a memory entry by key                       | INTERNAL | No           |

---

## Confirmation Rules

The agent follows these rules for all tool execution:

| Type         | Behavior                                                                              | Examples                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **READ**     | Execute immediately without asking the user                                           | `jira_search_issues`, `github_list_prs`, `notion_search`, `telegram_get_chat`            |
| **WRITE**    | Describe the planned action, show a preview, wait for user confirmation, then execute | `jira_create_issue`, `github_add_comment`, `notion_create_page`, `telegram_send_message` |
| **INTERNAL** | Execute silently as part of the agent's internal cognition. Not displayed to user.    | `remember_fact`, `search_memory`, `forget_fact`                                          |

**Write confirmation flow:**

1. Parse the user's intent
2. Show a summary/preview of the action (e.g., the issue title, message text, page properties)
3. Ask "Should I proceed?" / "Should I create this?" / "Should I send this?"
4. Only call the tool function AFTER the user explicitly confirms
5. Report the result back (issue URL, message ID, page URL, etc.)

---

## Agentic Tool-Calling Loop

The general chat handler (`src/api/chat/general/handler.ts`) implements a multi-turn agentic loop:

```
Step 1: Load workspace memory → inject into system prompt
Step 2: Collect available tools:
        - SkillRegistry.getAvailableTools(ctx)  → integration tools (Jira, GitHub, Notion, Telegram)
        - MEMORY_TOOLS                          → memory tools (remember, search, forget)
Step 3: Inject skill descriptions into system prompt
Step 4: Call OpenAI/Gemini with tools parameter
Step 5: If response has tool_calls:
        - Execute each tool via SkillRegistry.executeTool() or executeMemoryTool()
        - Append tool results as role: 'tool' messages
        - Call AI again with updated message history
Step 6: Repeat Step 4-5 (max 5 rounds to prevent infinite loops)
Step 7: Final text response sent to user
Step 8: Save conversation (user message + tool summaries + AI reply)
```

---

## Integration Providers

All integration tokens are stored in the `integration_tokens` table with a `provider` column:

```typescript
type IntegrationProvider =
  | 'jira' // Atlassian Jira (OAuth 2.0 3LO)
  | 'github' // GitHub (OAuth 2.0)
  | 'gitlab' // GitLab (OAuth 2.0) — planned
  | 'notion' // Notion (OAuth 2.0)
  | 'trello' // Trello (OAuth 1.0a) — planned
  | 'slack' // Slack (OAuth 2.0) — planned
  | 'telegram'; // Telegram (Bot Token — no OAuth)
```

**OAuth flow:** `GET /api/v1/integrations/:provider/authorize` -> redirect to provider -> callback at `GET /api/v1/integrations/:provider/callback` -> token stored in `integration_tokens`.

**Telegram exception:** Uses a bot token (from `TELEGRAM_BOT_TOKEN` env var or per-user in `integration_tokens`), not OAuth.

---

## Adding a New Skill

Follow these steps to add a new integration skill:

1. **API Service** — Create `src/services/api/<provider>.service.ts` with typed API client functions
2. **Skill Implementation** — Create `src/services/skills/integrations/<provider>.skill.ts` implementing `SkillDefinition`
3. **Skill Documentation** — Create `src/services/skills/integrations/skills/SKILL.<provider>.md` with full detail (see existing files for format)
4. **Provider Type** — Add the provider to `IntegrationProvider` in both:
   - `src/services/skills/types.ts`
   - `src/services/api/integration-token.service.ts`
5. **Registration** — Register the skill in `src/services/skills/index.ts` → `registerAllSkills()`
6. **Database** — Add provider to `integration_tokens` CHECK constraint (new migration)
7. **OAuth Routes** (if applicable) — Add auth URL builder and callback handler in `src/api/integrations/integrations.controller.ts`
8. **Environment Variables** — Add any required env vars to `src/config/environment/env.ts`
9. **Update SKILLS.md** — Add the new skill to this master index

### Skill Interface

```typescript
interface SkillDefinition {
  id: string; // Unique skill ID (e.g., 'jira-skill')
  name: string; // Display name (e.g., 'Jira')
  provider: IntegrationProvider; // Provider type
  description: string; // Description injected into system prompt
  tools: ChatCompletionTool[]; // OpenAI function calling tool definitions
  isAvailable(ctx: SkillContext): Promise<boolean>; // Check if user has valid token
  execute(
    toolName: string,
    args: Record<string, any>,
    ctx: SkillContext,
  ): Promise<SkillResult>;
}

interface SkillContext {
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
}

interface SkillResult {
  success: boolean;
  data?: any;
  message: string;
  displayToUser?: boolean; // false for internal tools (memory)
}
```

---

## Environment Variables

| Variable               | Required     | Used By                                   |
| ---------------------- | ------------ | ----------------------------------------- |
| `OPENAI_API_KEY`       | Yes          | OpenAI completions + embeddings           |
| `OPENAI_MODEL`         | No           | AI model selection (default: gpt-4o-mini) |
| `JIRA_CLIENT_ID`       | For Jira     | Jira OAuth                                |
| `JIRA_CLIENT_SECRET`   | For Jira     | Jira OAuth                                |
| `GITHUB_CLIENT_ID`     | For GitHub   | GitHub OAuth                              |
| `GITHUB_CLIENT_SECRET` | For GitHub   | GitHub OAuth                              |
| `NOTION_CLIENT_ID`     | For Notion   | Notion OAuth                              |
| `NOTION_CLIENT_SECRET` | For Notion   | Notion OAuth                              |
| `TELEGRAM_BOT_TOKEN`   | For Telegram | Global Telegram bot token (fallback)      |
| `BACKEND_URL`          | For OAuth    | OAuth callback URL base                   |
