---
name: memory
provider: internal
version: "1.0"
description: Persistent workspace memory system — remembers facts, preferences, and patterns across conversations using vector embeddings
auth: none (uses workspace context from chat session)
storage_table: workspace_memory
embedding_model: text-embedding-3-small
embedding_dimensions: 1536
vector_index: HNSW cosine
rpc_function: search_workspace_memory
requires_confirmation: []
tools:
  - remember_fact
  - search_memory
  - forget_fact
supported_ai_models:
  - gpt-4o
  - gpt-4o-mini
  - gemini-2.0-flash
  - gemini-2.0-pro
  - claude-sonnet-4-5
  - claude-opus-4
---

# Memory Skill

## Overview

The Memory skill provides persistent, semantic workspace memory for the QAIT agent. It allows the agent to **remember important facts, user preferences, testing patterns, recurring bugs, and integration context** across conversations within a workspace. Unlike conversation history (which is session-scoped), workspace memory persists indefinitely and is available to every conversation in the workspace.

**Why it exists:** Without persistent memory, the agent starts every conversation from scratch. Users would have to re-explain their Jira project key, preferred browser, testing conventions, and known bugs every time. Workspace memory solves this by giving the agent a long-term knowledge store that it can read from and write to automatically.

**How it enables cross-conversation context:** At the start of every conversation, the handler loads the most relevant memories (top-accessed + most-recent) and injects them into the system prompt. The agent also has three tools (`remember_fact`, `search_memory`, `forget_fact`) available during the conversation to actively manage its memory. All memory operations are internal — they are never displayed to the user and require no confirmation.

## Architecture

```
workspace_memory table (Supabase/PostgreSQL)
    |
    |-- HNSW cosine vector index (on embedding column, 1536 dimensions)
    |
    v
search_workspace_memory RPC (PostgreSQL function)
    |
    v
WorkspaceMemoryService (workspace-memory.service.ts)
    |-- writeMemory()     --> generates embedding via OpenAI, upserts by workspace_id+key
    |-- searchMemory()    --> generates query embedding, calls RPC with vector similarity
    |-- readMemory()      --> direct key lookup, updates access tracking
    |-- deleteMemory()    --> removes by workspace_id+key
    |-- listMemories()    --> lists memories with optional category filter
    |-- getMemoryForContext() --> loads top-accessed + most-recent, formats for system prompt
    |
    v
memory-tools.ts (OpenAI Function Calling Definitions)
    |-- MEMORY_TOOLS[]         --> tool definitions for remember_fact, search_memory, forget_fact
    |-- executeMemoryTool()    --> routes tool calls to appropriate handler
    |-- rememberFact()         --> calls WorkspaceMemoryService.writeMemory()
    |-- searchMemory()         --> calls WorkspaceMemoryService.searchMemory()
    |-- forgetFact()           --> calls WorkspaceMemoryService.deleteMemory()
    |
    v
handler.ts (General Chat Handler — Agentic Loop)
    |
    |-- STEP 2.6: Loads workspace memory via getMemoryForContext()
    |             Injects as system message: "--- Workspace Memory (Persistent Facts & Preferences) ---"
    |
    |-- STEP 2.8: Collects MEMORY_TOOLS[] and adds them to availableTools[]
    |
    |-- STEP 3: Agentic tool-calling loop (up to 5 rounds)
    |           Routes remember_fact/search_memory/forget_fact to executeMemoryTool()
    |
    v
OpenAI API (with tools parameter, tool_choice: 'auto')
    |
    v
Agent decides when to use memory tools based on conversation context
```

## Memory Loading Flow

At the start of every general chat conversation, the handler automatically loads workspace memory:

1. **Extract workspace ID** from the request context (`context.workspaceId` or `context.workspace_id`)
2. **Call `WorkspaceMemoryService.getMemoryForContext(workspaceId, 2000)`** with a 2000-character budget
3. **getMemoryForContext() internally:**
   - Fetches top 5 memories by `access_count` (most frequently used)
   - Fetches top 5 memories by `created_at` (most recently created)
   - Combines both lists and deduplicates by `id`
   - Sorts by a composite score: `access_count + time_decay_factor`
   - Formats each memory as: `[category] key: content`
   - Accumulates entries until the `maxChars` budget (2000) is exhausted
4. **Inject as system message** into the messages array:
   ```
   --- Workspace Memory (Persistent Facts & Preferences) ---
   [preference] preferred_browser: User prefers Chrome browser for testing
   [integration_context] default_jira_project: The default Jira project is PROJ
   [fact] team_timezone: The team works in UTC+6 (Almaty timezone)
   [bug_pattern] checkout_timeout: The checkout API times out after 30 seconds on slow connections

   These are important facts, preferences, and patterns you've remembered about this workspace.
   ```
5. **Non-fatal:** If memory loading fails for any reason, the handler continues with an empty string and logs a warning

---

## Tools

### 1. remember_fact

**Purpose:** Save an important fact, preference, or context to workspace memory for future conversations. The agent uses this when the user shares information that should persist.

**Action type:** INTERNAL (no confirmation needed, not displayed to user, `displayToUser: false`)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "remember_fact",
    "description": "Save an important fact, preference, or context to workspace memory for future conversations. Use this when the user shares important information that should be remembered.",
    "parameters": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Unique key for this memory (e.g., \"jira_default_project\", \"preferred_browser\"). Use lowercase with underscores."
        },
        "content": {
          "type": "string",
          "description": "The content to remember (e.g., \"User prefers Chrome browser for testing\")."
        },
        "category": {
          "type": "string",
          "enum": ["fact", "preference", "test_pattern", "bug_pattern", "integration_context"],
          "description": "Category: fact (general info), preference (user settings), test_pattern (common scenarios), bug_pattern (recurring issues), integration_context (Jira/GitHub context)."
        }
      },
      "required": ["key", "content", "category"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Unique key for this memory. Must be lowercase with underscores (e.g., `"default_jira_project"`, `"preferred_browser"`). If the same key exists in the workspace, it will be **overwritten** (upsert). |
| `content` | string | Yes | The content to remember. Should be a clear, self-contained statement (e.g., `"User prefers Chrome browser for testing"`). |
| `category` | string | Yes | One of: `fact`, `preference`, `test_pattern`, `bug_pattern`, `integration_context`. See Memory Categories Reference below. |

**What happens internally:**

1. Validates that `key`, `content`, and `category` are all provided
2. Calls `WorkspaceMemoryService.writeMemory(workspaceId, userId, key, content, category, 'agent_written', {}, 1.0)`
3. `writeMemory()` generates a 1536-dimension embedding via `generateEmbedding(content)` using `text-embedding-3-small`
4. Upserts into the `workspace_memory` table with conflict resolution on `(workspace_id, key)` — if the key already exists, it overwrites the content, embedding, and resets `access_count` to 0
5. Returns the created/updated memory record

**Success Response:**
```json
{
  "success": true,
  "data": {
    "memoryId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "key": "default_jira_project",
    "category": "integration_context"
  },
  "message": "I've remembered this: [integration_context] default_jira_project",
  "displayToUser": false
}
```

**Error Responses:**
```json
// Missing required fields
{
  "success": false,
  "message": "Missing required parameters: key, content, category",
  "displayToUser": false
}

// Embedding generation failure
{
  "success": false,
  "message": "Failed to remember: Failed to generate embedding: OpenAI API returned empty or invalid response",
  "displayToUser": false
}

// Database error
{
  "success": false,
  "message": "Failed to remember: duplicate key value violates unique constraint ...",
  "displayToUser": false
}
```

**Conversation Examples:**

```
User: "Our default Jira project is PROJ"
Agent: "Got it! I'll remember that your default Jira project is PROJ."
[internally calls remember_fact with key="default_jira_project", content="The default Jira project for this workspace is PROJ", category="integration_context"]
Agent: "I've noted that down. Next time you ask me to create a Jira issue, I'll default to the PROJ project."
```

```
User: "I prefer Chrome for testing"
Agent: "Noted!"
[internally calls remember_fact with key="preferred_browser", content="User prefers Chrome browser for testing", category="preference"]
Agent: "I'll remember that you prefer Chrome. I'll use it as the default browser when running UI tests."
```

```
User: "Our login flow requires 2FA — always include OTP step in test cases"
Agent: "That's important context."
[internally calls remember_fact with key="login_flow_requires_2fa", content="The login flow requires two-factor authentication (2FA). All test cases for login must include the OTP verification step.", category="test_pattern"]
Agent: "I've saved that. Future login test cases will always include the 2FA/OTP step."
```

```
User: "The checkout API endpoint is /api/v2/checkout, not /api/v1/checkout"
Agent: [internally calls remember_fact with key="checkout_api_endpoint", content="The checkout API endpoint is /api/v2/checkout (not /api/v1/checkout)", category="fact"]
Agent: "Updated! I'll use /api/v2/checkout going forward."
```

---

### 2. search_memory

**Purpose:** Search workspace memory for relevant information using semantic (vector) search. The agent uses this to recall past context, preferences, or patterns.

**Action type:** INTERNAL (no confirmation needed, not displayed to user, `displayToUser: false`)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "search_memory",
    "description": "Search workspace memory for relevant information using semantic search. Use this to recall past conversations or context.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Natural language query to search for (e.g., \"What is the default Jira project?\")"
        },
        "category": {
          "type": "string",
          "enum": ["fact", "preference", "test_pattern", "bug_pattern", "integration_context"],
          "description": "Optional category filter to narrow search."
        }
      },
      "required": ["query"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language query to search for. The system generates an embedding for this query and finds the closest memories by cosine similarity. |
| `category` | string | No | Optional category filter. If provided, only memories in this category are searched. One of: `fact`, `preference`, `test_pattern`, `bug_pattern`, `integration_context`. |

**What happens internally:**

1. Validates that `query` is provided
2. Calls `WorkspaceMemoryService.searchMemory(workspaceId, query, category, 5, 0.5)`
3. `searchMemory()` generates a 1536-dimension embedding for the query via `generateEmbedding(query)`
4. Calls the `search_workspace_memory` Supabase RPC with `p_workspace_id`, `p_query_embedding`, `p_match_count=5`, `p_match_threshold=0.5`, and optional `p_category`
5. The RPC performs cosine similarity search using the HNSW index, returning up to 5 results with similarity >= 0.5
6. Updates `access_count` and `last_accessed_at` for each returned memory (fire-and-forget)
7. Formats results as `[category] key: content (similarity: 0.XX)` lines

**Success Response (with results):**
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "key": "preferred_browser",
        "content": "User prefers Chrome browser for testing",
        "category": "preference",
        "similarity": 0.92,
        "created_at": "2026-02-08T10:30:00.000Z"
      },
      {
        "key": "default_viewport",
        "content": "Default viewport for UI tests is 1920x1080",
        "category": "preference",
        "similarity": 0.71,
        "created_at": "2026-02-05T14:00:00.000Z"
      }
    ]
  },
  "message": "Found 2 relevant memories:\n[preference] preferred_browser: User prefers Chrome browser for testing (similarity: 0.92)\n[preference] default_viewport: Default viewport for UI tests is 1920x1080 (similarity: 0.71)",
  "displayToUser": false
}
```

**Success Response (no results):**
```json
{
  "success": true,
  "data": { "results": [] },
  "message": "No relevant memories found.",
  "displayToUser": false
}
```

**Error Responses:**
```json
// Missing query
{
  "success": false,
  "message": "Missing required parameter: query",
  "displayToUser": false
}

// Embedding generation failure
{
  "success": false,
  "message": "Failed to search memory: Failed to generate embedding: Text must be a non-empty string",
  "displayToUser": false
}

// RPC error
{
  "success": false,
  "message": "Failed to search memory: Could not find the function search_workspace_memory ...",
  "displayToUser": false
}
```

**Conversation Examples:**

```
User: "What browser does the team prefer for testing?"
Agent: [internally calls search_memory with query="preferred browser for testing", category="preference"]
Agent: "Based on what I remember, you prefer Chrome for testing. Would you like me to use Chrome for this test run?"
```

```
User: "Create a bug ticket for the checkout timeout"
Agent: [internally calls search_memory with query="checkout timeout bug", category="bug_pattern"]
[finds: "checkout_timeout: The checkout API times out after 30 seconds on slow connections"]
Agent: [internally calls search_memory with query="default Jira project", category="integration_context"]
[finds: "default_jira_project: The default Jira project for this workspace is PROJ"]
Agent: "I found some relevant context. I'll create a bug in PROJ about the checkout API timeout issue (30s on slow connections). Shall I proceed?"
```

```
User: "Run the login test"
Agent: [internally calls search_memory with query="login test pattern 2FA OTP", category="test_pattern"]
[finds: "login_flow_requires_2fa: The login flow requires two-factor authentication (2FA). All test cases for login must include the OTP verification step."]
Agent: "I'll include the 2FA/OTP step in the login test since your login flow requires it. Starting the test now."
```

---

### 3. forget_fact

**Purpose:** Remove a memory from workspace storage. The agent uses this when information becomes outdated, the user corrects previous information, or the user explicitly asks to forget something.

**Action type:** INTERNAL (no confirmation needed, not displayed to user, `displayToUser: false`)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "forget_fact",
    "description": "Remove a memory from workspace storage. Use this when information becomes outdated or user asks to forget something.",
    "parameters": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "The key of the memory to forget (e.g., \"jira_default_project\")."
        }
      },
      "required": ["key"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | The exact key of the memory to delete. Must match the key used when the memory was created. Case-sensitive. |

**What happens internally:**

1. Validates that `key` is provided
2. Calls `WorkspaceMemoryService.deleteMemory(workspaceId, key)`
3. `deleteMemory()` executes a Supabase delete query with `workspace_id` and `key` filters
4. Returns `true` if deletion succeeded (even if no row was found — Supabase delete does not error on missing rows)
5. The response message indicates whether the memory existed: `"I've forgotten: {key}"` vs. `"Memory not found: {key}"`

**Success Response (memory existed):**
```json
{
  "success": true,
  "data": { "key": "preferred_browser", "deleted": true },
  "message": "I've forgotten: preferred_browser",
  "displayToUser": false
}
```

**Success Response (memory not found):**
```json
{
  "success": true,
  "data": { "key": "nonexistent_key", "deleted": true },
  "message": "I've forgotten: nonexistent_key",
  "displayToUser": false
}
```

**Error Responses:**
```json
// Missing key
{
  "success": false,
  "message": "Missing required parameter: key",
  "displayToUser": false
}

// Database error
{
  "success": false,
  "message": "Failed to forget: relation \"workspace_memory\" does not exist",
  "displayToUser": false
}
```

**Conversation Examples:**

```
User: "Actually, I switched from Chrome to Firefox"
Agent: [internally calls forget_fact with key="preferred_browser"]
[internally calls remember_fact with key="preferred_browser", content="User prefers Firefox browser for testing", category="preference"]
Agent: "Updated! I've switched your preferred browser from Chrome to Firefox."
```

```
User: "We moved from PROJ to NEWPROJ for our Jira project"
Agent: [internally calls forget_fact with key="default_jira_project"]
[internally calls remember_fact with key="default_jira_project", content="The default Jira project for this workspace is NEWPROJ", category="integration_context"]
Agent: "Got it, I've updated the default Jira project to NEWPROJ."
```

```
User: "Forget that the checkout API has a timeout bug — it was fixed"
Agent: [internally calls forget_fact with key="checkout_timeout"]
Agent: "Done! I've removed the checkout timeout bug from my memory. Good to know it's been fixed."
```

```
User: "Stop remembering my viewport preference, just ask me each time"
Agent: [internally calls forget_fact with key="default_viewport"]
Agent: "No problem. I've removed the viewport preference. I'll ask you each time from now on."
```

---

## Memory Categories Reference

| Category | Description | When to Use | Examples |
|----------|-------------|-------------|----------|
| `fact` | General factual information about the project, team, or technical environment | When the user shares objective facts about their system, team, or infrastructure | `"checkout_api_endpoint"`: The checkout API endpoint is /api/v2/checkout |
| | | | `"team_timezone"`: The team works in UTC+6 (Almaty timezone) |
| | | | `"staging_url"`: Staging environment is at https://staging.example.com |
| | | | `"db_type"`: The application uses PostgreSQL 15 |
| | | | `"auth_provider"`: Authentication is handled by Auth0 |
| | | | `"api_rate_limit"`: API rate limit is 100 requests per minute |
| `preference` | User preferences and settings for how the agent should behave | When the user expresses a preference for tools, formats, workflows, or communication style | `"preferred_browser"`: User prefers Chrome browser for testing |
| | | | `"default_viewport"`: Default viewport for UI tests is 1920x1080 |
| | | | `"response_language"`: User prefers responses in Russian |
| | | | `"test_detail_level"`: User prefers detailed step-by-step test cases |
| | | | `"bug_report_format"`: User wants bug reports with screenshots and network logs |
| | | | `"preferred_test_framework"`: User prefers Playwright over Cypress |
| `test_pattern` | Common testing patterns, scenarios, and conventions specific to this workspace | When recurring testing workflows, required steps, or standard test structures are identified | `"login_flow_requires_2fa"`: Login flow requires 2FA — always include OTP step |
| | | | `"checkout_requires_auth"`: Checkout flow requires authentication first |
| | | | `"file_upload_max_10mb"`: File upload tests should test boundary at 10MB limit |
| | | | `"pagination_default_20"`: Default pagination is 20 items per page |
| | | | `"api_auth_bearer_token"`: API tests use Bearer token authentication |
| | | | `"mobile_breakpoint_768"`: Mobile responsive breakpoint is 768px |
| `bug_pattern` | Recurring issues, known bugs, flaky tests, and failure patterns | When a bug is reported repeatedly, a test is known to be flaky, or a workaround is identified | `"checkout_timeout_bug"`: Checkout API times out after 30s on slow connections |
| | | | `"image_upload_cors_error"`: Image upload fails with CORS error in Safari |
| | | | `"flaky_search_test"`: Search test is flaky due to Elasticsearch index delay |
| | | | `"login_csrf_token_expiry"`: CSRF token expires after 15 minutes causing login failures |
| | | | `"dark_mode_contrast_issue"`: Dark mode has contrast issues on the settings page |
| | | | `"ie11_polyfill_missing"`: IE11 fails because Promise polyfill is missing |
| `integration_context` | Context specific to integrated tools — Jira, GitHub, Notion, Slack | When the user shares project keys, repository names, board IDs, or other integration-specific identifiers | `"default_jira_project"`: Default Jira project is PROJ |
| | | | `"github_repo"`: GitHub repository is org/repo-name |
| | | | `"jira_bug_workflow"`: Jira bug workflow: Open -> In Progress -> In Review -> Done |
| | | | `"notion_test_database"`: Test cases are tracked in Notion database "QA Test Suite" |
| | | | `"slack_qa_channel"`: QA team communicates in #qa-testing Slack channel |
| | | | `"jira_sprint_board_id"`: Active sprint board ID is 42 |

---

## Memory Sources Reference

| Source | Value | Description | When Used |
|--------|-------|-------------|-----------|
| **Agent-Written** | `agent_written` | Memory created by the agent during a conversation using the `remember_fact` tool | When the agent decides to save information based on user input. This is the primary source for tool-created memories. The `rememberFact()` function always sets source to `'agent_written'`. |
| **Auto-Extracted** | `auto_extracted` | Memory automatically extracted from conversation content by a background process | Planned for background auto-extraction after conversations end. Not yet actively used in the current tool flow. Will be used when the system analyzes completed conversations to extract important facts. |
| **User-Provided** | `user_provided` | Memory explicitly provided by the user through a direct interface (not via chat) | Reserved for future use when users can manage memories through a settings UI or API endpoint. Not currently used by the memory tools. |

---

## Memory Key Naming Convention

Memory keys must follow these rules:

- **Format:** `lowercase_with_underscores` (snake_case)
- **Characters:** Only lowercase letters, numbers, and underscores
- **Uniqueness:** Keys are unique per workspace (enforced by `(workspace_id, key)` unique constraint). Writing to an existing key overwrites it.
- **Descriptive:** Keys should clearly describe what they store without needing to read the content

**Good key examples:**

| Key | Category | Content |
|-----|----------|---------|
| `default_jira_project` | integration_context | The default Jira project is PROJ |
| `preferred_browser` | preference | User prefers Chrome browser for testing |
| `login_flow_requires_2fa` | test_pattern | Login flow requires 2FA with OTP verification |
| `checkout_api_timeout_bug` | bug_pattern | Checkout API times out after 30s on slow connections |
| `staging_environment_url` | fact | Staging is at https://staging.example.com |
| `api_auth_method` | fact | API uses Bearer token authentication |
| `github_main_repo` | integration_context | Main repo is org/frontend-app |
| `mobile_test_viewport` | preference | Mobile tests use 375x812 viewport (iPhone X) |
| `search_index_delay` | bug_pattern | Elasticsearch has 2s delay after write before search returns results |
| `response_language` | preference | User prefers responses in Russian |

**Bad key examples (avoid):**

| Bad Key | Problem | Better Key |
|---------|---------|------------|
| `JiraProject` | Not snake_case | `default_jira_project` |
| `browser` | Too vague | `preferred_browser` |
| `bug1` | Not descriptive | `checkout_api_timeout_bug` |
| `the-user-prefers-chrome` | Uses hyphens, too long | `preferred_browser` |
| `temp_session_token` | Temporary data should not be remembered | Do not save |

---

## Database Schema

### workspace_memory table

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | No | `gen_random_uuid()` | Primary key |
| `workspace_id` | uuid | No | - | Foreign key to workspaces table. All memories are scoped to a workspace. |
| `user_id` | uuid | No | - | The user who created or triggered this memory. For agent-written memories, this is the user who was chatting when the agent decided to remember. |
| `category` | text | No | - | Memory category. One of: `fact`, `preference`, `test_pattern`, `bug_pattern`, `integration_context`. |
| `key` | text | No | - | Unique key within the workspace. Used for upsert and direct lookups. |
| `content` | text | No | - | The actual memory content. Human-readable text that describes the fact/preference/pattern. |
| `embedding` | vector(1536) | Yes | - | Vector embedding generated by `text-embedding-3-small`. Used for semantic search via HNSW index. |
| `source` | text | No | `'agent_written'` | How this memory was created. One of: `agent_written`, `auto_extracted`, `user_provided`. |
| `confidence` | float | No | `1.0` | Confidence score from 0.0 to 1.0. Agent-written memories default to 1.0. Auto-extracted memories may have lower confidence. |
| `access_count` | integer | No | `0` | Number of times this memory has been accessed (read or returned in search). Used for LRU-style selection in `getMemoryForContext()`. Reset to 0 on write/update. |
| `last_accessed_at` | timestamptz | No | `now()` | Last time this memory was accessed. Updated on every read and search hit. |
| `metadata` | jsonb | No | `{}` | Arbitrary metadata. Currently passed as empty `{}` by memory tools. Reserved for future use (e.g., source conversation ID, extraction confidence details). |
| `created_at` | timestamptz | No | `now()` | When this memory was first created. |
| `updated_at` | timestamptz | No | `now()` | When this memory was last updated (via upsert). |
| `expires_at` | timestamptz | Yes | `null` | Optional expiration date. Currently not set by memory tools. Reserved for future TTL-based memory eviction. |

**Unique Constraint:** `(workspace_id, key)` — ensures each key is unique within a workspace. Used for upsert conflict resolution.

**Vector Index:** HNSW cosine index on the `embedding` column with 1536 dimensions.

---

## Vector Search Details

### search_workspace_memory RPC

The `search_workspace_memory` function is a PostgreSQL RPC (Remote Procedure Call) registered in Supabase. It performs vector similarity search using the HNSW cosine index.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `p_workspace_id` | uuid | Workspace to search within. Required. |
| `p_query_embedding` | vector(1536) | Embedding of the search query, generated by `text-embedding-3-small`. |
| `p_match_count` | integer | Maximum number of results to return. Default used by tools: `5`. |
| `p_match_threshold` | float | Minimum cosine similarity threshold. Results below this are excluded. Default used by tools: `0.5`. |
| `p_category` | text | Optional category filter. If `null`, searches all categories. |

**How it works:**

1. The caller generates an embedding for the search query using `generateEmbedding(query)` (OpenAI `text-embedding-3-small`)
2. The RPC computes cosine similarity between the query embedding and all memory embeddings in the workspace
3. The HNSW index accelerates this to approximate nearest-neighbor search (sub-linear time)
4. Results are filtered by `p_match_threshold` (default 0.5) — only memories with similarity >= threshold are returned
5. If `p_category` is provided, results are further filtered to that category
6. Results are ordered by similarity (highest first) and limited to `p_match_count`

**Similarity Scoring:**

- Uses **cosine distance** (1 - cosine_similarity), converted to cosine similarity for the `similarity` field in results
- Score range: `0.0` to `1.0` (OpenAI embeddings are normalized, so negative values are extremely rare)
- `1.0` = identical meaning, `0.5` = loosely related, `0.0` = completely unrelated
- Default threshold of `0.5` filters out noise while allowing loosely related results

**Performance:**

- HNSW index provides approximate nearest-neighbor search in O(log N) time
- Embedding generation takes ~100-200ms (OpenAI API call)
- Vector search in PostgreSQL takes ~5-20ms depending on table size
- Total search latency: ~150-250ms

---

## Access Tracking

The memory system tracks how frequently and recently each memory is accessed to enable intelligent memory selection.

### How access tracking works

1. **On read (`readMemory`):** After returning the memory, `updateAccessTracking(memoryId)` is called fire-and-forget. This increments `access_count` by 1 and sets `last_accessed_at` to `now()`.

2. **On search (`searchMemory`):** After returning search results, `updateAccessTracking(memoryId)` is called fire-and-forget for **each result** in the search results array. This means frequently searched-for memories accumulate higher access counts.

3. **On write (`writeMemory`):** The `access_count` is **reset to 0** and `last_accessed_at` is set to `now()`. This ensures updated memories do not carry stale access counts from their previous version.

### How getMemoryForContext uses access tracking

`getMemoryForContext()` uses a hybrid approach to select the most relevant memories:

1. **Top-accessed:** Fetches 5 memories ordered by `access_count DESC` — these are the most frequently referenced memories
2. **Most-recent:** Fetches 5 memories ordered by `created_at DESC` — these are the newest memories
3. **Deduplication:** Combines both lists and removes duplicates by `id`
4. **Composite scoring:** Sorts by a composite score that factors in both access frequency and recency:
   ```
   score = access_count + (time_since_creation_ms / 1_000_000)
   ```
   This ensures frequently accessed memories rank high, but very old memories with few accesses gradually lose priority.
5. **Budget-limited:** Accumulates formatted entries (`[category] key: content`) until the character budget (default 2000) is exhausted

### updateAccessTracking implementation

```typescript
private static async updateAccessTracking(memoryId: string): Promise<void> {
  // Read current count then increment
  const { data } = await supabaseAdmin
    .from('workspace_memory')
    .select('access_count')
    .eq('id', memoryId)
    .single();

  await supabaseAdmin
    .from('workspace_memory')
    .update({
      access_count: (data?.access_count || 0) + 1,
      last_accessed_at: new Date().toISOString(),
    })
    .eq('id', memoryId);
}
```

Note: This is a read-then-write pattern (not atomic increment), which is acceptable for access tracking since exact counts are not critical. The operation is fire-and-forget — failures are logged as warnings but do not affect the main operation.

---

## Behavioral Rules for AI Models

### When to use remember_fact

```
USE remember_fact WHEN:
- User explicitly shares important info:     "Our Jira project is PROJ"
- User states a preference:                  "I prefer Playwright over Cypress"
- User describes a recurring pattern:        "Our login always requires 2FA"
- User mentions a known bug:                 "The search is broken on Safari"
- Agent learns integration context:          User connects Jira --> save project key
- User corrects a previous assumption:       "Actually, the API is v2, not v1"
- User shares team conventions:              "We use BDD-style test cases"
- User provides environment details:         "Staging is at staging.example.com"

DO NOT use remember_fact for:
- Temporary, one-time information:           "Run the test on port 3001 this time"
- Information already in the conversation:   (no need to remember what was just said)
- Sensitive data (passwords, tokens, keys):  NEVER store credentials in memory
- Conversation-specific details:             "I'm debugging issue X right now"
- Obvious/universal facts:                   "HTTP 404 means not found"
```

### When to use search_memory

```
USE search_memory WHEN:
- User asks about past context:              "What browser do I usually use?"
- Agent needs to recall preferences:         Before choosing a browser for UI test
- Before making assumptions:                 Check if there's a default Jira project before asking
- User references something from the past:   "Remember that bug I told you about?"
- Agent needs integration context:           Before creating a Jira issue, search for default project
- User asks about known issues:              "Any known bugs with checkout?"
- Agent needs test patterns:                 Before generating test cases, check for workspace patterns

DO NOT use search_memory for:
- Information that was just stated:           (it's already in the conversation)
- General knowledge questions:               "What is REST API?" (not workspace memory)
- When the memory was already loaded:        (check system prompt first)
```

### When to use forget_fact

```
USE forget_fact WHEN:
- User explicitly corrects information:      "Actually, we switched to Firefox"
- User says to forget something:             "Don't remember that anymore"
- Information becomes outdated:              "We moved from PROJ to NEWPROJ"
- Context is no longer valid:               "That bug was fixed in v2.1"
- User wants to reset a preference:         "Stop defaulting to Chrome, ask me each time"

DO NOT use forget_fact for:
- Replacing information:                     Use remember_fact with the same key (upsert)
- Temporary corrections:                     "Use Firefox just for this test" (don't forget Chrome preference)
```

### What NOT to Remember

```
NEVER remember:
- Passwords, API keys, tokens, secrets:      Security risk — NEVER store credentials
- Temporary session data:                     Port numbers, one-time URLs, debug flags
- Conversation-specific context:              "I'm working on feature X today"
- Universally known facts:                    "JavaScript is a programming language"
- Sensitive personal information:             Email addresses, phone numbers (unless explicitly requested)
- Transient state:                            "The server is down right now" (will change)
```

### Memory is Workspace-Scoped

All memories belong to the **workspace**, not to individual users. This means:

- When User A says "Our Jira project is PROJ", that memory is available to User B in the same workspace
- Preferences should be framed as workspace-level when possible ("The team prefers Chrome") rather than user-level
- The `user_id` field records who triggered the memory creation, but does not restrict access

---

## Auto-Extraction (Planned)

A background auto-extraction system is planned for future implementation. After a conversation ends, a background job will:

1. Analyze the full conversation transcript
2. Identify important facts, preferences, patterns, and integration context
3. Create memories with `source: 'auto_extracted'` and an appropriate confidence score (typically 0.7-0.9)
4. Use lower confidence to distinguish auto-extracted memories from agent-written ones (1.0)

This system is **not yet active**. Currently, all memory creation happens through the `remember_fact` tool during active conversations. The `auto_extracted` source value and `confidence` field in the schema are reserved for this future capability.

---

## Error Handling

| Error | Cause | Agent Response |
|-------|-------|----------------|
| "Missing required parameters: key, content, category" | Tool called without required fields | The agent should retry with all required parameters |
| "Failed to generate embedding" | OpenAI embedding API failure (rate limit, timeout, invalid input) | Non-fatal for search/remember — agent should acknowledge and continue the conversation |
| "Could not find the function search_workspace_memory" | RPC not deployed to Supabase | Search is unavailable — agent should inform the user that memory search is temporarily unavailable |
| "Failed to execute {toolName}" | General execution error (network, database) | Non-fatal — all memory tool errors return `displayToUser: false` and the agent continues normally |
| Empty workspace memory on load | No memories exist yet, or loading failed | Agent starts with no pre-loaded context — this is the normal state for new workspaces |

---

## Source Files

| File | Purpose |
|------|---------|
| `src/services/ai/memory/memory-tools.ts` | Memory tool definitions (OpenAI function calling format), tool executor, `rememberFact()`, `searchMemory()`, `forgetFact()` implementations |
| `src/services/ai/memory/workspace-memory.service.ts` | `WorkspaceMemoryService` class — CRUD operations, semantic search, context formatting, access tracking |
| `src/services/ai/core/embedding.service.ts` | `generateEmbedding()` — generates 1536-dimension vectors using OpenAI `text-embedding-3-small` with retry logic |
| `src/api/chat/general/handler.ts` | General chat handler — loads workspace memory (Step 2.6), collects memory tools (Step 2.8), routes memory tool calls in agentic loop (Step 3) |
