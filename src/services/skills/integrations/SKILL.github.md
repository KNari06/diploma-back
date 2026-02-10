---
name: github
provider: github
version: "1.0"
description: Create issues, manage pull requests, add comments, and access repository information
auth: oauth2
auth_url: /api/v1/integrations/github/authorize
token_table: integration_tokens
token_refresh: none (GitHub OAuth tokens do not expire)
api_base: https://api.github.com
api_version: REST v3
requires_confirmation: [github_create_issue, github_add_comment]
read_only_tools: [github_list_prs, github_get_repo]
tools:
  - github_create_issue
  - github_list_prs
  - github_add_comment
  - github_get_repo
supported_ai_models:
  - gpt-4o
  - gpt-4o-mini
  - gemini-2.0-flash
  - gemini-2.0-pro
  - claude-sonnet-4-5
  - claude-opus-4
---

# GitHub Skill

## Overview

The GitHub skill allows the QAIT agent to interact with GitHub repositories through the GitHub REST API v3. It wraps the existing GitHub API service (`src/services/api/github.service.ts`) and exposes 4 tools for issue management, pull request browsing, commenting, and repository information retrieval via OpenAI function calling format.

This skill is registered in the SkillRegistry singleton at server startup and becomes available when a user has connected their GitHub account via OAuth 2.0. In the QAIT context, this enables testers and QA engineers to file bugs as GitHub issues, track pull requests under review, annotate issues/PRs with test results, and inspect repository metadata -- all from within the chat interface without switching to the GitHub web UI.

## Architecture

```
User Chat Message
    |
    v
General Chat Handler (handler.ts)
    |
    v
SkillRegistry.getAvailableTools() --> checks GitHubSkill.isAvailable()
    |                                      |
    |                                      v
    |                                getGitHubToken(userId) --> integration_tokens table
    |                                      |                    (provider = 'github',
    |                                      |                     enabled = true)
    |                                      v
    |                                return token !== null
    |
    v
OpenAI / Gemini / Claude API (with tools parameter)
    |
    v
tool_calls response
    |
    v
SkillRegistry.executeTool('github_create_issue', args, context)
    |
    v
GitHubSkill.execute() --> getGitHubToken() --> GitHub REST API (api.github.com)
    |                                           |
    |                                           v
    |                                  Authorization: Bearer {access_token}
    |                                  Accept: application/vnd.github+json
    |                                  X-GitHub-Api-Version: 2022-11-28
    |
    v
SkillResult { success, data, message, displayToUser }
```

## Authentication

| Field | Value |
|-------|-------|
| **Method** | OAuth 2.0 (Authorization Code Grant) |
| **Provider** | GitHub |
| **Auth URL** | `https://github.com/login/oauth/authorize` |
| **Token URL** | `https://github.com/login/oauth/access_token` |
| **Scopes** | `repo, read:user` |
| **Token Table** | `integration_tokens` (shared table, filtered by `provider = 'github'`) |
| **Refresh** | None -- GitHub OAuth tokens do not expire unless revoked |
| **Config** | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` env vars |
| **Callback URL** | `{BACKEND_URL}/api/{API_VERSION}/integrations/github/callback` |

### Scopes Explained

| Scope | Grants |
|-------|--------|
| `repo` | Full control of private and public repositories: read/write issues, pull requests, comments, code, commit statuses, deployments, and more |
| `read:user` | Read access to the authenticated user's profile data (login, name, email, avatar) |

### Token Data Structure (integration_tokens table)

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "workspace_id": "uuid | null",
  "access_token": "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "refresh_token": null,
  "expires_at": null,
  "scope": "repo,read:user",
  "external_id": "octocat",
  "external_url": "https://github.com/octocat",
  "metadata": {
    "username": "octocat",
    "name": "The Octocat"
  },
  "enabled": true,
  "created_at": "2026-02-10T08:00:00.000Z",
  "updated_at": "2026-02-10T08:00:00.000Z"
}
```

### Availability Check

```typescript
// GitHubSkill.isAvailable(context) implementation:
const token = await getGitHubToken(context.userId);
return token !== null;
// Queries integration_tokens table:
//   SELECT * FROM integration_tokens
//   WHERE user_id = {userId}
//     AND provider = 'github'
//     AND enabled = true
//   ORDER BY created_at DESC
//   LIMIT 1
```

---

## Tools

### 1. github_create_issue

**Purpose:** Create a new GitHub issue in a specified repository. Supports title, description body, and labels.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "github_create_issue",
    "description": "Create a new GitHub issue in a repository. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Repository owner (username or organization)"
        },
        "repo": {
          "type": "string",
          "description": "Repository name"
        },
        "title": {
          "type": "string",
          "description": "Issue title"
        },
        "body": {
          "type": "string",
          "description": "Issue description/body (optional)"
        },
        "labels": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Labels to add (optional, e.g., [\"bug\", \"urgent\"])"
        }
      },
      "required": ["owner", "repo", "title"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `owner` | string | Yes | - | Repository owner. Can be a GitHub username (e.g., "octocat") or an organization name (e.g., "my-org"). Case-sensitive. |
| `repo` | string | Yes | - | Repository name without the owner prefix (e.g., "my-app", not "octocat/my-app"). Case-sensitive. |
| `title` | string | Yes | - | The issue title. Keep concise but descriptive. |
| `body` | string | No | `""` | Issue description body. Supports GitHub-flavored Markdown (headings, lists, code blocks, etc.). |
| `labels` | string[] | No | `[]` | Array of label names to apply. Labels must already exist in the repository or the user must have permission to create them. |

**GitHub API call:** `POST /repos/{owner}/{repo}/issues`

**Request Headers:**
```
Authorization: Bearer {access_token}
Accept: application/vnd.github+json
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "number": 42,
    "title": "Login page timeout on slow connections",
    "url": "https://github.com/my-org/web-app/issues/42",
    "state": "open"
  },
  "message": "Created GitHub issue #42: Login page timeout on slow connections\nhttps://github.com/my-org/web-app/issues/42",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{
  "success": false,
  "message": "Missing required fields: owner, repo, title",
  "displayToUser": false
}

// Repository not found or no access
{
  "success": false,
  "message": "Failed to create issue: GitHub API error: 404 {\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest\"}",
  "displayToUser": true
}

// Validation error (e.g., label does not exist and user lacks permission)
{
  "success": false,
  "message": "Failed to create issue: GitHub API error: 422 {\"message\":\"Validation Failed\",\"errors\":[{\"value\":\"nonexistent-label\",\"resource\":\"Label\",\"field\":\"name\",\"code\":\"invalid\"}]}",
  "displayToUser": true
}

// No GitHub connection
{
  "success": false,
  "message": "GitHub integration not connected. Please connect your GitHub account first.",
  "displayToUser": true
}
```

**Conversation Examples:**

```
User: "Create a bug issue for the login timeout problem in our web-app repo"
Agent: "I'll create a GitHub issue for this. Which repository owner should I use? (e.g., your username or organization name)"
User: "my-org"
Agent: "I'll create the following GitHub issue:
  - Repository: my-org/web-app
  - Title: Login page timeout on slow connections
  - Body: Users on slow connections experience timeout errors when attempting to log in.
  - Labels: bug

  Should I proceed?"
User: "Yes"
Agent: [calls github_create_issue] "Created GitHub issue #42: Login page timeout on slow connections
https://github.com/my-org/web-app/issues/42"
```

```
User: "File an issue in octocat/hello-world titled 'Update README with installation instructions'"
Agent: "I'll create the following GitHub issue:
  - Repository: octocat/hello-world
  - Title: Update README with installation instructions

  Should I create this?"
User: "Yes, and add the labels 'documentation' and 'good first issue'"
Agent: [calls github_create_issue with labels] "Created GitHub issue #7: Update README with installation instructions
https://github.com/octocat/hello-world/issues/7"
```

```
User: "Create an issue for the failing API tests with a detailed description"
Agent: "Which repository should I create this in? Please provide the owner and repo name (e.g., my-org/api-service)."
User: "my-org/api-service"
Agent: "I'll create:
  - Repository: my-org/api-service
  - Title: Failing API integration tests
  - Body: Several API integration tests are failing intermittently in CI. Affected endpoints: /users, /auth/login. Error: 503 Service Unavailable. Needs investigation.
  - Labels: bug, tests

  Should I proceed?"
User: "Yes"
Agent: [calls github_create_issue] "Created GitHub issue #156: Failing API integration tests
https://github.com/my-org/api-service/issues/156"
```

---

### 2. github_list_prs

**Purpose:** List pull requests in a repository, optionally filtered by state (open, closed, or all). Read-only operation.

**Action type:** READ (no confirmation needed, execute immediately)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "github_list_prs",
    "description": "List pull requests in a repository. Use to see open/closed PRs.",
    "parameters": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Repository owner (username or organization)"
        },
        "repo": {
          "type": "string",
          "description": "Repository name"
        },
        "state": {
          "type": "string",
          "enum": ["open", "closed", "all"],
          "description": "PR state to filter by. Default: open"
        }
      },
      "required": ["owner", "repo"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `owner` | string | Yes | - | Repository owner (username or organization). Case-sensitive. |
| `repo` | string | Yes | - | Repository name. Case-sensitive. |
| `state` | string | No | `"open"` | Filter by PR state. Must be one of: `open`, `closed`, `all`. |

**GitHub API call:** `GET /repos/{owner}/{repo}/pulls?state={state}&per_page=10`

**Request Headers:**
```
Authorization: Bearer {access_token}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "prs": [
      {
        "number": 87,
        "title": "feat: add password reset flow",
        "state": "open",
        "author": "jane-smith",
        "head": "feature/password-reset",
        "base": "main",
        "url": "https://github.com/my-org/web-app/pull/87",
        "created": "2026-02-08T14:30:00Z"
      },
      {
        "number": 85,
        "title": "fix: resolve login timeout on slow connections",
        "state": "open",
        "author": "john-doe",
        "head": "fix/login-timeout",
        "base": "main",
        "url": "https://github.com/my-org/web-app/pull/85",
        "created": "2026-02-07T09:15:00Z"
      },
      {
        "number": 83,
        "title": "chore: upgrade dependencies",
        "state": "open",
        "author": "dependabot[bot]",
        "head": "dependabot/npm_and_yarn/express-5.0.0",
        "base": "main",
        "url": "https://github.com/my-org/web-app/pull/83",
        "created": "2026-02-06T02:00:00Z"
      }
    ]
  },
  "message": "Found 3 open pull requests in my-org/web-app",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{
  "success": false,
  "message": "Missing required fields: owner, repo",
  "displayToUser": false
}

// Repository not found
{
  "success": false,
  "message": "Failed to list PRs: GitHub API error: 404 {\"message\":\"Not Found\"}",
  "displayToUser": true
}

// No GitHub connection
{
  "success": false,
  "message": "GitHub integration not connected. Please connect your GitHub account first.",
  "displayToUser": true
}
```

**Conversation Examples:**

```
User: "Show me the open PRs in my-org/web-app"
Agent: [calls github_list_prs with owner="my-org", repo="web-app"]
Agent: "Found 3 open pull requests in my-org/web-app:
  1. #87: feat: add password reset flow (jane-smith) - feature/password-reset -> main
  2. #85: fix: resolve login timeout (john-doe) - fix/login-timeout -> main
  3. #83: chore: upgrade dependencies (dependabot[bot]) - dependabot/npm_and_yarn/express-5.0.0 -> main"
```

```
User: "Are there any closed PRs in octocat/hello-world?"
Agent: [calls github_list_prs with owner="octocat", repo="hello-world", state="closed"]
Agent: "Found 5 closed pull requests in octocat/hello-world:
  1. #12: Update documentation (octocat) - docs/update -> main
  2. #10: Fix typo in README (contributor) - fix/typo -> main
  ..."
```

```
User: "List all pull requests for our API service"
Agent: "Which repository? Please provide the owner and repo name."
User: "my-org/api-service"
Agent: [calls github_list_prs with owner="my-org", repo="api-service", state="all"]
Agent: "Found 8 pull requests (open and closed) in my-org/api-service: ..."
```

---

### 3. github_add_comment

**Purpose:** Add a comment to an existing GitHub issue or pull request. GitHub uses the same comment API for both issues and PRs.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "github_add_comment",
    "description": "Add a comment to a GitHub issue or PR. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Repository owner (username or organization)"
        },
        "repo": {
          "type": "string",
          "description": "Repository name"
        },
        "issue_number": {
          "type": "number",
          "description": "Issue or PR number"
        },
        "comment": {
          "type": "string",
          "description": "Comment text"
        }
      },
      "required": ["owner", "repo", "issue_number", "comment"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `owner` | string | Yes | - | Repository owner (username or organization). Case-sensitive. |
| `repo` | string | Yes | - | Repository name. Case-sensitive. |
| `issue_number` | number | Yes | - | The issue or PR number (e.g., `42`). In GitHub, issues and PRs share the same number space, so this works for both. |
| `comment` | string | Yes | - | Comment text. Supports GitHub-flavored Markdown (headings, lists, code blocks, mentions, etc.). |

**GitHub API call:** `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

**Request Headers:**
```
Authorization: Bearer {access_token}
Accept: application/vnd.github+json
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "issueNumber": 42,
    "owner": "my-org",
    "repo": "web-app"
  },
  "message": "Added comment to my-org/web-app#42",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{
  "success": false,
  "message": "Missing required fields: owner, repo, issue_number, comment",
  "displayToUser": false
}

// Issue not found
{
  "success": false,
  "message": "Failed to add comment: GitHub API error: 404 {\"message\":\"Not Found\"}",
  "displayToUser": true
}

// No write access to repository
{
  "success": false,
  "message": "Failed to add comment: GitHub API error: 403 {\"message\":\"Resource not accessible by integration\"}",
  "displayToUser": true
}

// No GitHub connection
{
  "success": false,
  "message": "GitHub integration not connected. Please connect your GitHub account first.",
  "displayToUser": true
}
```

**Conversation Examples:**

```
User: "Add a comment to issue #42 in my-org/web-app saying the bug is reproduced"
Agent: "I'll add the following comment to my-org/web-app#42:

  'Bug confirmed and reproduced on staging environment. Steps: 1) Navigate to login page, 2) Enter valid credentials on a throttled connection, 3) Observe timeout after 30 seconds.'

  Should I proceed?"
User: "Yes"
Agent: [calls github_add_comment] "Added comment to my-org/web-app#42"
```

```
User: "Comment on PR #85 that the tests are passing now"
Agent: "I'll add this comment to my-org/web-app#85:

  'All integration tests are now passing. The login timeout fix has been verified on the staging environment.'

  Should I post this?"
User: "Go ahead"
Agent: [calls github_add_comment] "Added comment to my-org/web-app#85"
```

```
User: "Leave a note on issue 156 in my-org/api-service"
Agent: "What would you like the comment to say?"
User: "Root cause identified: the database connection pool is exhausted under load"
Agent: "I'll add this comment to my-org/api-service#156:

  'Root cause identified: the database connection pool is exhausted under load.'

  Should I post it?"
User: "Yes"
Agent: [calls github_add_comment] "Added comment to my-org/api-service#156"
```

---

### 4. github_get_repo

**Purpose:** Retrieve detailed information about a GitHub repository, including description, default branch, language, visibility, stars, and fork count.

**Action type:** READ (no confirmation needed, execute immediately)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "github_get_repo",
    "description": "Get information about a GitHub repository.",
    "parameters": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Repository owner (username or organization)"
        },
        "repo": {
          "type": "string",
          "description": "Repository name"
        }
      },
      "required": ["owner", "repo"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `owner` | string | Yes | - | Repository owner (username or organization). Case-sensitive. |
| `repo` | string | Yes | - | Repository name. Case-sensitive. |

**GitHub API call:** `GET /repos/{owner}/{repo}`

**Request Headers:**
```
Authorization: Bearer {access_token}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "name": "web-app",
    "fullName": "my-org/web-app",
    "description": "Main web application for the QAIT platform",
    "url": "https://github.com/my-org/web-app",
    "defaultBranch": "main",
    "private": true,
    "language": "TypeScript",
    "stars": 24,
    "forks": 3
  },
  "message": "Repository: my-org/web-app\nMain web application for the QAIT platform\nStars: 24 | Forks: 3",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{
  "success": false,
  "message": "Missing required fields: owner, repo",
  "displayToUser": false
}

// Repository not found or no access
{
  "success": false,
  "message": "Failed to get repo info: GitHub API error: 404 {\"message\":\"Not Found\"}",
  "displayToUser": true
}

// No GitHub connection
{
  "success": false,
  "message": "GitHub integration not connected. Please connect your GitHub account first.",
  "displayToUser": true
}
```

**Conversation Examples:**

```
User: "Tell me about the my-org/web-app repository"
Agent: [calls github_get_repo with owner="my-org", repo="web-app"]
Agent: "Here's the info for my-org/web-app:
  - Description: Main web application for the QAIT platform
  - Language: TypeScript
  - Default branch: main
  - Visibility: Private
  - Stars: 24 | Forks: 3
  - URL: https://github.com/my-org/web-app"
```

```
User: "What's the default branch for octocat/hello-world?"
Agent: [calls github_get_repo with owner="octocat", repo="hello-world"]
Agent: "The default branch for octocat/hello-world is 'main'."
```

```
User: "Get the details of our API service repo"
Agent: "Which repository? Please provide the owner and repo name (e.g., my-org/api-service)."
User: "my-org/api-service"
Agent: [calls github_get_repo] "Repository: my-org/api-service
  - Description: REST API backend service
  - Language: TypeScript
  - Default branch: develop
  - Visibility: Private
  - Stars: 12 | Forks: 1"
```

---

## Behavioral Rules for AI Models

### Confirmation Pattern

```
For WRITE tools (github_create_issue, github_add_comment):
1. Parse the user's intent
2. Show a summary of what you will do (repository, title, body, labels, comment text, etc.)
3. Ask "Should I proceed?" or "Should I create this?" or "Should I post this?"
4. Only call the tool function AFTER the user confirms
5. Report the result back to the user, including the issue/PR URL when available

For READ tools (github_list_prs, github_get_repo):
1. Parse the user's intent
2. Call the tool function immediately (no confirmation needed)
3. Format the results in a readable way for the user
```

### Handling Missing owner/repo

```
Every GitHub tool requires both 'owner' and 'repo' parameters. When the user provides:

"my-org/web-app"        -> Split: owner = "my-org", repo = "web-app"
"web-app"               -> Missing owner. Ask: "Who owns this repository? Please provide the owner (username or organization)."
"the web app repo"      -> Missing both. Ask: "Which repository? Please provide in the format owner/repo (e.g., my-org/web-app)."
"issue #42"             -> Missing owner AND repo. Ask: "Which repository is issue #42 in? Please provide in the format owner/repo."
"octocat/hello-world#7" -> Split: owner = "octocat", repo = "hello-world", issue_number = 7

If the user has recently mentioned a repository in the conversation, reuse that owner/repo
rather than asking again. Keep track of the current repository context within a session.
```

### Common Patterns

```
When the user says:                          Action:
"create an issue for ..."                  -> github_create_issue (WRITE, confirm first)
"file a bug in ..."                        -> github_create_issue with labels: ["bug"] (WRITE, confirm first)
"open a ticket for ..."                    -> github_create_issue (WRITE, confirm first)
"show me open PRs"                         -> github_list_prs with state="open" (READ, immediate)
"list closed pull requests"                -> github_list_prs with state="closed" (READ, immediate)
"show all PRs"                             -> github_list_prs with state="all" (READ, immediate)
"any PRs waiting for review?"              -> github_list_prs with state="open" (READ, immediate)
"comment on issue #42 ..."                 -> github_add_comment (WRITE, confirm first)
"add a note to PR #85"                     -> github_add_comment (WRITE, confirm first)
"leave feedback on ..."                    -> github_add_comment (WRITE, confirm first)
"what repo is this?" / "repo info"         -> github_get_repo (READ, immediate)
"what's the default branch?"               -> github_get_repo, then extract defaultBranch (READ, immediate)
"is the repo private?"                     -> github_get_repo, then extract private (READ, immediate)
"how many stars does ... have?"            -> github_get_repo, then extract stars (READ, immediate)
```

### GitHub-Specific Formatting Tips

```
When creating issues or comments, use GitHub-flavored Markdown:

- Use **bold** for emphasis
- Use `code` for inline code references
- Use ```language for code blocks
- Use - [ ] for task lists
- Use @username for mentions
- Use #number to cross-reference other issues/PRs

When presenting PR lists to the user:
- Show PR number, title, author, branch info (head -> base), and URL
- Group or sort by relevance (e.g., most recent first)
- Highlight the author and branch names for clarity

When presenting repo info to the user:
- Lead with the full name and description
- Include language, default branch, visibility
- Mention stars and forks as social proof indicators
```

---

## Error Handling

| Error | HTTP Status | Cause | Agent Response |
|-------|-------------|-------|----------------|
| "GitHub integration not connected" | - | No token in `integration_tokens` for this user with `provider = 'github'` and `enabled = true` | "Your GitHub account is not connected. Please connect it via the integrations page." |
| "GitHub API error: 401" | 401 | Token revoked or invalid | "Your GitHub session is no longer valid. Please reconnect your GitHub account via the integrations page." |
| "GitHub API error: 403" | 403 | Insufficient permissions or rate limit exceeded | Check response body: if rate limit, "GitHub API rate limit reached. Please wait a few minutes and try again." If permissions, "You don't have permission to perform this action on the repository." |
| "GitHub API error: 404" | 404 | Repository, issue, or PR not found (or private repo without access) | "That repository or issue was not found. Please check the owner/repo name and make sure you have access." |
| "GitHub API error: 422" | 422 | Validation error (invalid labels, duplicate issue, etc.) | "The request was invalid. Please check the parameters and try again." Report specifics from the error message. |
| "Missing required fields: ..." | - | Tool called without required parameters | Do not display to user. The AI model should supply the missing fields or ask the user. |
| "Unknown GitHub tool: ..." | - | Invalid tool name routed to skill | Internal error. Should not occur in normal operation. |
| Network / timeout errors | - | GitHub API unreachable | "Unable to reach GitHub right now. Please try again in a moment." |

### Rate Limit Details

GitHub REST API allows:
- **Authenticated requests:** 5,000 requests per hour per user
- Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- If rate limited, the API returns HTTP 403 with a `rate limit exceeded` message

---

## Source Files

| File | Purpose |
|------|---------|
| `src/services/skills/integrations/github.skill.ts` | Skill definition, tools array, execute handler with routing to individual tool handlers |
| `src/services/api/github.service.ts` | GitHub REST API client (token retrieval, issue creation, PR listing, commenting, repo info) |
| `src/services/skills/types.ts` | SkillDefinition, SkillContext, SkillResult, IntegrationProvider type definitions |
| `src/services/skills/skill-registry.ts` | SkillRegistry singleton that registers skills, checks availability, and routes tool execution |
| `src/api/integrations/integrations.controller.ts` | OAuth flow: buildGitHubAuthUrl(), handleGitHubCallback(), token exchange and storage |
| `src/config/environment/env.ts` | Environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET |
