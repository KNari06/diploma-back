---
name: jira
provider: jira
version: "1.0"
description: Manage Jira issues, search tickets, add comments, and control workflows
auth: oauth2
auth_url: /api/v1/jira/authorize
token_table: jira_tokens
token_refresh: automatic (ensureValidToken)
api_base: https://api.atlassian.com
api_version: REST API v3
requires_confirmation: [jira_create_issue, jira_add_comment, jira_transition_issue]
read_only_tools: [jira_search_issues, jira_get_issue]
tools:
  - jira_create_issue
  - jira_search_issues
  - jira_add_comment
  - jira_get_issue
  - jira_transition_issue
supported_ai_models:
  - gpt-4o
  - gpt-4o-mini
  - gemini-2.0-flash
  - gemini-2.0-pro
  - claude-sonnet-4-5
  - claude-opus-4
---

# Jira Skill

## Overview

The Jira skill allows the QAIT agent to interact with Jira Cloud through the Atlassian REST API v3. It wraps the existing Jira OAuth service (`src/services/api/jira.service.ts`) and exposes 5 tools for issue management via OpenAI function calling format.

This skill is registered in the SkillRegistry singleton at server startup and becomes available when a user has connected their Jira account via OAuth 2.0.

## Architecture

```
User Chat Message
    |
    v
General Chat Handler (handler.ts)
    |
    v
SkillRegistry.getAvailableTools() --> checks JiraSkill.isAvailable()
    |                                      |
    |                                      v
    |                                getJiraToken(userId) --> jira_tokens table
    |
    v
OpenAI API (with tools parameter)
    |
    v
tool_calls response
    |
    v
SkillRegistry.executeTool('jira_create_issue', args, context)
    |
    v
JiraSkill.execute() --> getJiraToken() --> ensureValidToken() --> Jira Cloud API
    |
    v
SkillResult { success, data, message, displayToUser }
```

## Authentication

| Field | Value |
|-------|-------|
| **Method** | OAuth 2.0 (Authorization Code Grant) |
| **Provider** | Atlassian Cloud |
| **Auth URL** | `https://auth.atlassian.com/authorize` |
| **Token URL** | `https://auth.atlassian.com/oauth/token` |
| **Scopes** | `read:jira-user read:jira-work write:jira-work read:board-scope:jira-software read:project:jira read:issue-details:jira offline_access` |
| **Token Table** | `jira_tokens` (legacy) |
| **Refresh** | Automatic via `ensureValidToken()` — refreshes if token expires within 5 minutes |
| **Config** | `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_CALLBACK_URL` env vars |

### Token Data Structure (jira_tokens table)

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_at": "2026-02-11T10:00:00.000Z",
  "scope": "read:jira-user read:jira-work ...",
  "cloud_id": "abc123-def456",
  "site_url": "https://yoursite.atlassian.net",
  "token_type": "Bearer",
  "created_at": "2026-02-10T08:00:00.000Z",
  "updated_at": "2026-02-10T08:00:00.000Z"
}
```

### Availability Check

```typescript
// JiraSkill.isAvailable(context) implementation:
const token = await getJiraToken(context.userId);
return token !== null;
// Reads from jira_tokens table, returns most recent token for user
```

---

## Tools

### 1. jira_create_issue

**Purpose:** Create a new Jira issue (Bug, Task, Story, or Epic) in a specified project.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "jira_create_issue",
    "description": "Create a new Jira issue (Bug, Task, Story, etc.). Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "project_key": {
          "type": "string",
          "description": "Jira project key (e.g., 'PROJ', 'TEST'). Ask user if unknown."
        },
        "summary": {
          "type": "string",
          "description": "Issue title/summary"
        },
        "description": {
          "type": "string",
          "description": "Detailed issue description (optional)"
        },
        "issue_type": {
          "type": "string",
          "enum": ["Bug", "Task", "Story", "Epic"],
          "description": "Issue type. Default: Bug"
        },
        "priority": {
          "type": "string",
          "enum": ["Highest", "High", "Medium", "Low", "Lowest"],
          "description": "Priority level. Default: Medium"
        }
      },
      "required": ["project_key", "summary"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project_key` | string | Yes | - | Jira project key. Must be uppercase letters (e.g., "PROJ", "QA", "TEST"). If unknown, ask the user. |
| `summary` | string | Yes | - | The issue title. Keep concise but descriptive (max ~255 chars). |
| `description` | string | No | empty | Detailed description. Plain text — automatically converted to Atlassian Document Format (ADF) with paragraph blocks. Newlines create separate paragraphs. |
| `issue_type` | string | No | "Bug" | Must be one of: Bug, Task, Story, Epic. Case-sensitive. The project must support the selected type. |
| `priority` | string | No | "Medium" | Must be one of: Highest, High, Medium, Low, Lowest. Case-sensitive. |

**Jira API call:** `POST /ex/jira/{cloudId}/rest/api/3/issue`

**Success Response:**
```json
{
  "success": true,
  "data": {
    "issueKey": "PROJ-456",
    "issueId": "10042",
    "self": "https://api.atlassian.com/ex/jira/abc123/rest/api/3/issue/10042"
  },
  "message": "Created Jira issue: PROJ-456",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: project_key, summary", "displayToUser": false }

// Invalid project key
{ "success": false, "message": "Failed to create issue: Jira create issue failed: 404 ...", "displayToUser": true }

// No Jira connection
{ "success": false, "message": "Jira integration not connected. Please connect your Jira account first.", "displayToUser": true }
```

**Conversation Examples:**

```
User: "Create a bug ticket for the login page timeout issue"
Agent: "I'll create a bug ticket for this. Which Jira project should I create it in? (e.g., PROJ, QA)"
User: "PROJ"
Agent: "I'll create the following Jira issue:
  - Project: PROJ
  - Type: Bug
  - Priority: Medium
  - Summary: Login page timeout issue
  - Description: The login page is experiencing timeout errors

  Should I proceed?"
User: "Yes"
Agent: [calls jira_create_issue] "Created Jira issue: PROJ-456"
```

```
User: "Create a high priority story in QA project: implement password reset flow"
Agent: "I'll create the following:
  - Project: QA
  - Type: Story
  - Priority: High
  - Summary: Implement password reset flow

  Should I create this?"
```

---

### 2. jira_search_issues

**Purpose:** Search for Jira issues using JQL (Jira Query Language). Read-only operation.

**Action type:** READ (no confirmation needed, execute immediately)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "jira_search_issues",
    "description": "Search Jira issues using JQL (Jira Query Language). Use for finding issues by status, type, assignee, etc.",
    "parameters": {
      "type": "object",
      "properties": {
        "jql": {
          "type": "string",
          "description": "JQL query (e.g., 'project = PROJ AND status = Open', 'issuetype = Bug AND priority = High')"
        },
        "max_results": {
          "type": "number",
          "description": "Maximum number of results to return. Default: 10"
        }
      },
      "required": ["jql"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jql` | string | Yes | - | JQL query string. See JQL reference below. |
| `max_results` | number | No | 10 | Max results to return. Capped at 100 by API. |

**JQL Reference for AI Models:**

JQL (Jira Query Language) follows SQL-like syntax. Key operators and fields:

```
# Basic field queries
project = "PROJ"                          # By project key
status = "Open"                           # By status name
status = "In Progress"                    # Status with spaces (use quotes)
issuetype = Bug                           # By issue type
priority = High                           # By priority
assignee = currentUser()                  # Current authenticated user
assignee = "john.doe"                     # Specific user
reporter = currentUser()                  # Issues you reported
labels = "regression"                     # By label

# Compound queries
project = PROJ AND status = Open
project = PROJ AND issuetype = Bug AND priority IN (High, Highest)
project = PROJ AND status != Done
project = PROJ AND created >= -7d         # Created in last 7 days
project = PROJ AND updated >= -24h        # Updated in last 24 hours

# Sprint and Agile queries
sprint in openSprints()                   # Current sprint
sprint in futureSprints()                 # Future sprints

# Text search
summary ~ "login"                         # Summary contains "login"
text ~ "timeout error"                    # Full text search

# Ordering
project = PROJ ORDER BY created DESC
project = PROJ ORDER BY priority ASC, created DESC

# Common patterns for QA testing context
issuetype = Bug AND status != Done AND project = PROJ
issuetype IN (Bug, Task) AND assignee = currentUser() AND sprint in openSprints()
issuetype = Bug AND priority IN (High, Highest) AND created >= -30d
```

**Jira API call:** `GET /ex/jira/{cloudId}/rest/api/3/search/jql?jql={jql}&maxResults={max_results}&fields=summary,description,status,priority,issuetype,reporter,assignee,created,updated,labels,project`

**Success Response:**
```json
{
  "success": true,
  "data": {
    "issues": [
      {
        "key": "PROJ-123",
        "summary": "Login page timeout on slow connections",
        "status": "Open",
        "priority": "High",
        "assignee": "John Doe",
        "created": "2026-02-01T10:30:00.000Z"
      },
      {
        "key": "PROJ-124",
        "summary": "Password reset email not sent",
        "status": "In Progress",
        "priority": "Medium",
        "assignee": "Jane Smith",
        "created": "2026-02-02T14:00:00.000Z"
      }
    ],
    "total": 42
  },
  "message": "Found 2 issues (total: 42)",
  "displayToUser": true
}
```

**Conversation Examples:**

```
User: "How many open bugs do we have in PROJ?"
Agent: [calls jira_search_issues with jql="project = PROJ AND issuetype = Bug AND status != Done"]
Agent: "Found 15 open bugs in PROJ. Here are the top ones:
  1. PROJ-123: Login page timeout (High) - Assigned to John Doe
  2. PROJ-124: Password reset issue (Medium) - Assigned to Jane Smith
  ..."
```

```
User: "Show me high priority issues from the last week"
Agent: [calls jira_search_issues with jql="priority IN (High, Highest) AND created >= -7d ORDER BY created DESC"]
```

---

### 3. jira_add_comment

**Purpose:** Add a comment to an existing Jira issue.

**Action type:** WRITE (requires user confirmation)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "jira_add_comment",
    "description": "Add a comment to an existing Jira issue. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "issue_key": {
          "type": "string",
          "description": "Jira issue key (e.g., 'PROJ-123')"
        },
        "comment": {
          "type": "string",
          "description": "Comment text to add"
        }
      },
      "required": ["issue_key", "comment"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issue_key` | string | Yes | Issue key in format `PROJECT-NUMBER` (e.g., "PROJ-123"). Case-sensitive. |
| `comment` | string | Yes | Comment text. Plain text — automatically converted to ADF. Newlines create separate paragraphs. |

**Jira API call:** `POST /ex/jira/{cloudId}/rest/api/3/issue/{issueKey}/comment`

**Success Response:**
```json
{
  "success": true,
  "data": { "issueKey": "PROJ-123" },
  "message": "Added comment to PROJ-123",
  "displayToUser": true
}
```

---

### 4. jira_get_issue

**Purpose:** Retrieve full details of a specific Jira issue by its key.

**Action type:** READ (no confirmation needed)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "jira_get_issue",
    "description": "Get details of a specific Jira issue by key.",
    "parameters": {
      "type": "object",
      "properties": {
        "issue_key": {
          "type": "string",
          "description": "Jira issue key (e.g., 'PROJ-123')"
        }
      },
      "required": ["issue_key"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issue_key` | string | Yes | Issue key in format `PROJECT-NUMBER`. Case-sensitive. |

**Jira API call:** `GET /ex/jira/{cloudId}/rest/api/3/issue/{issueKey}?fields=summary,description,status,priority,issuetype,reporter,assignee,created,updated,labels,project`

**Success Response:**
```json
{
  "success": true,
  "data": {
    "key": "PROJ-123",
    "summary": "Login page timeout on slow connections",
    "description": "Users on slow connections experience a timeout when trying to log in. The request takes longer than 30 seconds and fails.",
    "status": "Open",
    "priority": "High",
    "assignee": "John Doe",
    "reporter": "Jane Smith",
    "created": "2026-02-01T10:30:00.000Z",
    "updated": "2026-02-08T15:45:00.000Z"
  },
  "message": "Retrieved PROJ-123: Login page timeout on slow connections",
  "displayToUser": true
}
```

**Note:** The `description` field is extracted from Atlassian Document Format (ADF) to plain text. Complex formatting (tables, code blocks, etc.) may lose some structure.

---

### 5. jira_transition_issue

**Purpose:** Change the workflow status of a Jira issue.

**Action type:** WRITE (requires user confirmation)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "jira_transition_issue",
    "description": "Change the status of a Jira issue (e.g., To Do -> In Progress -> Done). Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "issue_key": {
          "type": "string",
          "description": "Jira issue key (e.g., 'PROJ-123')"
        },
        "status": {
          "type": "string",
          "description": "Target status name (e.g., 'In Progress', 'Done', 'Closed')"
        }
      },
      "required": ["issue_key", "status"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issue_key` | string | Yes | Issue key in format `PROJECT-NUMBER`. |
| `status` | string | Yes | Target status name. Case-insensitive matching. Must be a valid transition from the current status. Common values: "To Do", "In Progress", "In Review", "Done", "Closed". |

**How it works internally:**
1. Fetches available transitions for the issue: `GET /rest/api/3/issue/{issueKey}/transitions`
2. Finds a matching transition by comparing `transition.to.name` or `transition.name` (case-insensitive)
3. Executes the transition: `POST /rest/api/3/issue/{issueKey}/transitions` with `{ "transition": { "id": "..." } }`

**Important:** Not all status transitions are valid. Jira workflows define which statuses can transition to which. If the requested transition is not available, the error message will list available transitions.

**Success Response:**
```json
{
  "success": true,
  "data": { "issueKey": "PROJ-123", "newStatus": "Done" },
  "message": "Moved PROJ-123 to Done",
  "displayToUser": true
}
```

**Error — Invalid Transition:**
```json
{
  "success": false,
  "message": "Failed to transition issue: No transition to status \"Closed\". Available: In Progress, Done",
  "displayToUser": true
}
```

---

## Behavioral Rules for AI Models

### Confirmation Pattern
```
For WRITE tools (jira_create_issue, jira_add_comment, jira_transition_issue):
1. Parse the user's intent
2. Show a summary of what you will do (project, type, summary, etc.)
3. Ask "Should I proceed?" or "Should I create this?"
4. Only call the tool function AFTER the user confirms
5. Report the result back to the user

For READ tools (jira_search_issues, jira_get_issue):
1. Parse the user's intent
2. Call the tool function immediately (no confirmation needed)
3. Format the results in a readable way for the user
```

### JQL Construction Rules
```
When the user says:               Construct JQL:
"open bugs in PROJ"              -> project = PROJ AND issuetype = Bug AND status != Done
"my assigned issues"             -> assignee = currentUser()
"high priority tasks"            -> priority IN (High, Highest)
"issues created this week"       -> created >= startOfWeek()
"unresolved issues"              -> resolution = Unresolved
"bugs assigned to John"          -> issuetype = Bug AND assignee = "john"
"search for login issues"        -> text ~ "login" OR summary ~ "login"
```

### Missing Information Handling
```
If user doesn't specify project_key: Ask "Which Jira project should I use? (e.g., PROJ, QA)"
If user doesn't specify issue_type:  Default to "Bug"
If user doesn't specify priority:    Default to "Medium"
If user doesn't specify issue_key:   Ask "Which issue? Please provide the issue key (e.g., PROJ-123)"
```

## Error Handling

| Error | Cause | Agent Response |
|-------|-------|----------------|
| "Jira integration not connected" | No token in `jira_tokens` | "Your Jira account is not connected. Please connect it via the integrations page." |
| "Jira cloud ID not found" | Token exists but no `cloud_id` | "Please reconnect your Jira account — the cloud ID is missing." |
| "Token expired and no refresh token" | Refresh token missing | "Your Jira session has expired. Please reconnect your account." |
| "Jira create issue failed: 404" | Invalid project key | "That project key doesn't exist. Please check the project key and try again." |
| "No transition to status" | Invalid workflow transition | "I can't move this issue to that status. Available transitions are: [list]" |
| "Jira search failed: 400" | Invalid JQL | "The search query is invalid. Let me fix it and try again." |

## Source Files

| File | Purpose |
|------|---------|
| `src/services/skills/integrations/jira.skill.ts` | Skill definition, tools, execute handler |
| `src/services/api/jira.service.ts` | Jira REST API client (OAuth, CRUD, search) |
| `src/types/index.ts` | JiraTokenData, JiraIssueListItem, JiraSearchResult types |
