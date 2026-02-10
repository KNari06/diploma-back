---
name: notion
provider: notion
version: "1.0"
description: Create pages, search content, update properties, and manage Notion databases
auth: oauth2
auth_url: /api/v1/integrations/notion/authorize
token_table: integration_tokens
api_base: https://api.notion.com/v1
api_version: "2022-06-28"
requires_confirmation: [notion_create_page, notion_update_page, notion_add_to_database]
read_only_tools: [notion_search]
tools:
  - notion_create_page
  - notion_search
  - notion_update_page
  - notion_add_to_database
supported_ai_models:
  - gpt-4o
  - gpt-4o-mini
  - gemini-2.0-flash
  - gemini-2.0-pro
  - claude-sonnet-4-5
  - claude-opus-4
---

# Notion Skill

## Overview

The Notion skill allows the QAIT agent to interact with Notion workspaces through the Notion REST API (version 2022-06-28). It wraps the existing Notion service (`src/services/api/notion.service.ts`) and exposes 4 tools for page and database management via OpenAI function calling format.

This skill is registered in the SkillRegistry singleton at server startup and becomes available when a user has connected their Notion workspace via OAuth 2.0.

## Architecture

```
User Chat Message
    |
    v
General Chat Handler (handler.ts)
    |
    v
SkillRegistry.getAvailableTools() --> checks NotionSkill.isAvailable()
    |                                      |
    |                                      v
    |                                getNotionToken(userId) --> integration_tokens table
    |                                                           (provider='notion', enabled=true)
    |
    v
OpenAI API (with tools parameter)
    |
    v
tool_calls response
    |
    v
SkillRegistry.executeTool('notion_create_page', args, context)
    |
    v
NotionSkill.execute() --> getNotionToken() --> Notion API (https://api.notion.com/v1)
    |
    v
SkillResult { success, data, message, displayToUser }
```

## Authentication

| Field | Value |
|-------|-------|
| **Method** | OAuth 2.0 (Authorization Code Grant) |
| **Provider** | Notion |
| **Auth URL** | `https://api.notion.com/v1/oauth/authorize` |
| **Token URL** | `https://api.notion.com/v1/oauth/token` |
| **Token Exchange** | Basic Auth header (`Base64(client_id:client_secret)`) |
| **Token Table** | `integration_tokens` (shared table, filtered by `provider='notion'`) |
| **Refresh** | Notion OAuth tokens do not expire; no refresh mechanism needed |
| **Config** | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` env vars |

### Token Data Structure (integration_tokens table, provider='notion')

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "workspace_id": "uuid",
  "provider": "notion",
  "access_token": "ntn_...",
  "token_type": "bearer",
  "external_id": "workspace-uuid-from-notion",
  "external_url": "https://notion.so/workspace-icon.png",
  "metadata": {
    "workspace_name": "My Workspace",
    "bot_id": "bot-uuid"
  },
  "enabled": true,
  "created_at": "2026-02-10T08:00:00.000Z",
  "updated_at": "2026-02-10T08:00:00.000Z"
}
```

**Key fields:**
- `external_id` stores the Notion workspace ID
- `external_url` stores the workspace icon URL
- `metadata.workspace_name` stores the human-readable workspace name
- `metadata.bot_id` stores the Notion integration bot ID
- `enabled` must be `true` for the token to be considered valid

### Availability Check

```typescript
// NotionSkill.isAvailable(context) implementation:
const token = await getNotionToken(context.userId);
return token !== null;
// Queries integration_tokens table:
//   WHERE user_id = ? AND provider = 'notion' AND enabled = true
//   ORDER BY created_at DESC LIMIT 1
```

---

## Tools

### 1. notion_create_page

**Purpose:** Create a new Notion page under a specified parent page. The page is created with a title and optional paragraph content.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "notion_create_page",
    "description": "Create a new Notion page. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "parent_id": {
          "type": "string",
          "description": "Parent page ID or database ID where the page will be created"
        },
        "title": {
          "type": "string",
          "description": "Page title"
        },
        "content": {
          "type": "string",
          "description": "Page content (optional, will be split into paragraphs)"
        }
      },
      "required": ["parent_id", "title"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `parent_id` | string | Yes | - | The Notion page ID to nest this page under. Must be a valid 32-character UUID (with or without hyphens). If unknown, ask the user or use `notion_search` to find it. |
| `title` | string | Yes | - | Page title. Also added as a heading_1 block at the top of the page content. |
| `content` | string | No | empty | Plain text content. Newlines (`\n`) split the text into separate paragraph blocks. Empty lines are filtered out. |

**Notion API call:** `POST /pages`

Request body:
```json
{
  "parent": { "page_id": "{parent_id}" },
  "properties": {
    "title": {
      "title": [{ "text": { "content": "{title}" } }]
    }
  },
  "children": [
    {
      "object": "block",
      "type": "heading_1",
      "heading_1": {
        "rich_text": [{ "type": "text", "text": { "content": "{title}" } }]
      }
    },
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "type": "text", "text": { "content": "{paragraph_text}" } }]
      }
    }
  ]
}
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "pageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "url": "https://www.notion.so/My-Page-Title-a1b2c3d4e5f67890abcdef1234567890"
  },
  "message": "Created Notion page: Sprint Planning Notes\nhttps://www.notion.so/Sprint-Planning-Notes-a1b2c3d4e5f67890abcdef1234567890",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: parent_id, title", "displayToUser": false }

// Invalid parent ID
{ "success": false, "message": "Failed to create page: Notion API error: 400 {\"object\":\"error\",\"status\":400,\"code\":\"validation_error\",\"message\":\"path failed validation...\"}", "displayToUser": true }

// Parent page not shared with integration
{ "success": false, "message": "Failed to create page: Notion API error: 404 {\"object\":\"error\",\"status\":404,\"code\":\"object_not_found\",\"message\":\"Could not find page with ID: ...\"}", "displayToUser": true }

// No Notion connection
{ "success": false, "message": "Notion integration not connected. Please connect your Notion workspace first.", "displayToUser": true }
```

**Conversation Examples:**

```
User: "Create a new page for our sprint planning notes"
Agent: "I'd be happy to create that page. Which Notion page should I create it under? I'll need the parent page ID."
User: "Put it under the Engineering page, the ID is a1b2c3d4-e5f6-7890-abcd-ef1234567890"
Agent: "I'll create the following Notion page:
  - Parent: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  - Title: Sprint Planning Notes

  Should I proceed?"
User: "Yes"
Agent: [calls notion_create_page] "Created Notion page: Sprint Planning Notes
https://www.notion.so/Sprint-Planning-Notes-a1b2c3d4e5f67890abcdef1234567890"
```

```
User: "Create a page called 'API Documentation' with some initial content about our REST endpoints"
Agent: "I'll create that page. Which parent page should it go under? Please share the page ID."
User: "Use f8e7d6c5-b4a3-2109-8765-432109876543"
Agent: "I'll create the following Notion page:
  - Parent: f8e7d6c5-b4a3-2109-8765-432109876543
  - Title: API Documentation
  - Content: Overview of our REST API endpoints and their usage.

  Should I create this?"
User: "Go ahead"
Agent: [calls notion_create_page with content] "Created Notion page: API Documentation
https://www.notion.so/API-Documentation-f8e7d6c5b4a321098765432109876543"
```

```
User: "I need a new meeting notes page under abc123"
Agent: "I'll create the following Notion page:
  - Parent: abc123
  - Title: Meeting Notes

  Should I proceed?"
User: "Yes, and add today's date and attendees section"
Agent: [calls notion_create_page with content="Date: 2026-02-10\n\nAttendees:\n\nAgenda:\n\nAction Items:"]
"Created Notion page: Meeting Notes
https://www.notion.so/Meeting-Notes-..."
```

---

### 2. notion_search

**Purpose:** Search for pages across the connected Notion workspace by query text. Read-only operation.

**Action type:** READ (no confirmation needed, execute immediately)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "notion_search",
    "description": "Search Notion pages by query text.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query text"
        }
      },
      "required": ["query"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Text to search for across all accessible Notion pages. Matches against page titles and content. The search is powered by Notion's built-in search and supports partial matches. |

**Notion API call:** `POST /search`

Request body:
```json
{
  "query": "{query}",
  "page_size": 10,
  "filter": {
    "property": "object",
    "value": "page"
  }
}
```

**Note:** The search is filtered to return only pages (not databases). Results are limited to 10 items. Only pages shared with the Notion integration bot are searchable.

**Success Response:**
```json
{
  "success": true,
  "data": {
    "pages": [
      {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "url": "https://www.notion.so/Sprint-Planning-a1b2c3d4e5f67890abcdef1234567890",
        "created": "2026-01-15T09:00:00.000Z",
        "lastEdited": "2026-02-08T14:30:00.000Z"
      },
      {
        "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "url": "https://www.notion.so/Sprint-Retro-b2c3d4e5f6a78901bcdef12345678901",
        "created": "2026-01-20T11:00:00.000Z",
        "lastEdited": "2026-02-07T16:45:00.000Z"
      }
    ],
    "hasMore": false
  },
  "message": "Found 2 Notion pages for: sprint",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing query
{ "success": false, "message": "Missing required field: query", "displayToUser": false }

// API error
{ "success": false, "message": "Failed to search: Notion API error: 401 {\"object\":\"error\",\"status\":401,\"code\":\"unauthorized\",\"message\":\"API token is invalid.\"}", "displayToUser": true }

// No Notion connection
{ "success": false, "message": "Notion integration not connected. Please connect your Notion workspace first.", "displayToUser": true }
```

**Conversation Examples:**

```
User: "Find my sprint planning pages in Notion"
Agent: [calls notion_search with query="sprint planning"]
Agent: "Found 3 Notion pages matching 'sprint planning':
  1. Sprint Planning Q1 - Last edited Feb 8
     https://www.notion.so/Sprint-Planning-Q1-...
  2. Sprint Planning Template - Last edited Jan 20
     https://www.notion.so/Sprint-Planning-Template-...
  3. Sprint Planning Archive - Last edited Dec 15
     https://www.notion.so/Sprint-Planning-Archive-..."
```

```
User: "Search Notion for API documentation"
Agent: [calls notion_search with query="API documentation"]
Agent: "Found 1 Notion page matching 'API documentation':
  1. API Documentation v2 - Last edited Feb 10
     https://www.notion.so/API-Documentation-v2-...

  Would you like me to do anything with this page?"
```

```
User: "Do we have any test plans in Notion?"
Agent: [calls notion_search with query="test plan"]
Agent: "I found 5 Notion pages matching 'test plan'. Here are the results:
  1. QA Test Plan - Release 3.0 - Last edited Feb 9
  2. Integration Test Plan - Last edited Feb 5
  3. Performance Test Plan - Last edited Jan 28
  4. Test Plan Template - Last edited Jan 15
  5. Mobile App Test Plan - Last edited Jan 10

  Would you like more details on any of these?"
```

---

### 3. notion_update_page

**Purpose:** Update properties of an existing Notion page. Used to modify page metadata such as title, status, tags, and custom properties.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "notion_update_page",
    "description": "Update properties of an existing Notion page. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "page_id": {
          "type": "string",
          "description": "Page ID to update"
        },
        "properties": {
          "type": "object",
          "description": "Properties to update (Notion-formatted properties object)"
        }
      },
      "required": ["page_id", "properties"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page_id` | string | Yes | - | The Notion page ID to update. Must be a valid UUID. Use `notion_search` to find it if unknown. |
| `properties` | object | Yes | - | A Notion-formatted properties object. Each key is the property name, and the value must follow the Notion property schema. See the **Notion Properties Reference** section below for formatting details. |

**Notion API call:** `PATCH /pages/{page_id}`

Request body:
```json
{
  "properties": {
    "Name": {
      "title": [{ "text": { "content": "Updated Title" } }]
    },
    "Status": {
      "select": { "name": "In Progress" }
    }
  }
}
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "pageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "url": "https://www.notion.so/Updated-Title-a1b2c3d4e5f67890abcdef1234567890"
  },
  "message": "Updated Notion page\nhttps://www.notion.so/Updated-Title-a1b2c3d4e5f67890abcdef1234567890",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: page_id, properties", "displayToUser": false }

// Page not found or not shared with integration
{ "success": false, "message": "Failed to update page: Notion API error: 404 {\"object\":\"error\",\"status\":404,\"code\":\"object_not_found\",\"message\":\"Could not find page with ID: ...\"}", "displayToUser": true }

// Invalid property format
{ "success": false, "message": "Failed to update page: Notion API error: 400 {\"object\":\"error\",\"status\":400,\"code\":\"validation_error\",\"message\":\"...\"}", "displayToUser": true }

// No Notion connection
{ "success": false, "message": "Notion integration not connected. Please connect your Notion workspace first.", "displayToUser": true }
```

**Notion Property Format Examples for notion_update_page:**

```json
// Update title property
{
  "Name": {
    "title": [{ "text": { "content": "New Page Title" } }]
  }
}

// Update rich_text property
{
  "Description": {
    "rich_text": [{ "text": { "content": "Updated description text" } }]
  }
}

// Update number property
{
  "Priority Score": {
    "number": 85
  }
}

// Update select property
{
  "Status": {
    "select": { "name": "Done" }
  }
}

// Update multi_select property
{
  "Tags": {
    "multi_select": [{ "name": "bug" }, { "name": "critical" }]
  }
}

// Update date property
{
  "Due Date": {
    "date": { "start": "2026-03-15" }
  }
}

// Update checkbox property
{
  "Completed": {
    "checkbox": true
  }
}
```

**Conversation Examples:**

```
User: "Mark the sprint planning page as Done"
Agent: "I'll update the status. Do you have the page ID, or should I search for it?"
User: "Search for it"
Agent: [calls notion_search with query="sprint planning"]
Agent: "Found it: Sprint Planning Q1 (ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890)

  I'll update the following:
  - Page: Sprint Planning Q1
  - Set Status to: Done

  Should I proceed?"
User: "Yes"
Agent: [calls notion_update_page] "Updated Notion page
https://www.notion.so/Sprint-Planning-Q1-..."
```

```
User: "Change the title of page abc123 to 'Release Notes v3.0'"
Agent: "I'll update the following:
  - Page: abc123
  - New title: Release Notes v3.0

  Should I make this change?"
User: "Yes"
Agent: [calls notion_update_page with properties={"Name": {"title": [{"text": {"content": "Release Notes v3.0"}}]}}]
"Updated Notion page
https://www.notion.so/Release-Notes-v3-0-..."
```

```
User: "Set the priority to High and add tags 'urgent' and 'backend' on page xyz789"
Agent: "I'll update the following properties on page xyz789:
  - Priority: High (select)
  - Tags: urgent, backend (multi_select)

  Should I proceed?"
User: "Go ahead"
Agent: [calls notion_update_page with properties={"Priority": {"select": {"name": "High"}}, "Tags": {"multi_select": [{"name": "urgent"}, {"name": "backend"}]}}]
"Updated Notion page
https://www.notion.so/..."
```

---

### 4. notion_add_to_database

**Purpose:** Add a new entry (row) to a Notion database. Creates a new page with the database as its parent, populating the specified properties.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "notion_add_to_database",
    "description": "Add a new entry to a Notion database. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "database_id": {
          "type": "string",
          "description": "Database ID to add entry to"
        },
        "properties": {
          "type": "object",
          "description": "Properties for the new database entry (Notion-formatted)"
        }
      },
      "required": ["database_id", "properties"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `database_id` | string | Yes | - | The Notion database ID to add the entry to. Must be a valid UUID. The database must be shared with the integration bot. |
| `properties` | object | Yes | - | A Notion-formatted properties object. Each key must match an existing database property name exactly (case-sensitive). Values must follow the Notion property schema for the corresponding property type. See the **Notion Properties Reference** section below. |

**Notion API call:** `POST /pages`

Request body:
```json
{
  "parent": { "database_id": "{database_id}" },
  "properties": {
    "Name": {
      "title": [{ "text": { "content": "New Entry" } }]
    },
    "Status": {
      "select": { "name": "To Do" }
    },
    "Priority": {
      "select": { "name": "High" }
    },
    "Due Date": {
      "date": { "start": "2026-03-01" }
    }
  }
}
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "pageId": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "url": "https://www.notion.so/c3d4e5f6a7b89012cdef123456789012"
  },
  "message": "Added entry to Notion database\nhttps://www.notion.so/c3d4e5f6a7b89012cdef123456789012",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: database_id, properties", "displayToUser": false }

// Database not found or not shared with integration
{ "success": false, "message": "Failed to add to database: Notion API error: 404 {\"object\":\"error\",\"status\":404,\"code\":\"object_not_found\",\"message\":\"Could not find database with ID: ...\"}", "displayToUser": true }

// Property name mismatch
{ "success": false, "message": "Failed to add to database: Notion API error: 400 {\"object\":\"error\",\"status\":400,\"code\":\"validation_error\",\"message\":\"Property 'Status' does not exist...\"}", "displayToUser": true }

// Invalid property value format
{ "success": false, "message": "Failed to add to database: Notion API error: 400 {\"object\":\"error\",\"status\":400,\"code\":\"validation_error\",\"message\":\"...is not a valid select option...\"}", "displayToUser": true }

// No Notion connection
{ "success": false, "message": "Notion integration not connected. Please connect your Notion workspace first.", "displayToUser": true }
```

**Notion Property Format Examples for notion_add_to_database:**

```json
// Full example: Bug tracker database entry
{
  "Name": {
    "title": [{ "text": { "content": "Login button unresponsive on mobile" } }]
  },
  "Status": {
    "select": { "name": "Open" }
  },
  "Priority": {
    "select": { "name": "High" }
  },
  "Assignee": {
    "rich_text": [{ "text": { "content": "John Doe" } }]
  },
  "Tags": {
    "multi_select": [{ "name": "mobile" }, { "name": "UI" }, { "name": "regression" }]
  },
  "Due Date": {
    "date": { "start": "2026-02-20" }
  },
  "Severity": {
    "number": 3
  },
  "Verified": {
    "checkbox": false
  }
}

// Full example: Task tracker database entry
{
  "Task": {
    "title": [{ "text": { "content": "Write integration tests for auth module" } }]
  },
  "Status": {
    "status": { "name": "Not started" }
  },
  "Category": {
    "select": { "name": "Testing" }
  },
  "Story Points": {
    "number": 5
  },
  "Sprint": {
    "rich_text": [{ "text": { "content": "Sprint 14" } }]
  },
  "Due Date": {
    "date": { "start": "2026-02-28", "end": "2026-03-07" }
  }
}
```

**Conversation Examples:**

```
User: "Add a new bug to our Notion bug tracker: the search filter isn't working on the dashboard"
Agent: "I'll add that to the bug tracker. What's the database ID?"
User: "The database ID is d4e5f6a7-b8c9-0123-defg-456789012345"
Agent: "I'll add the following entry to the bug tracker:
  - Name: Search filter not working on dashboard
  - Status: Open
  - Priority: Medium

  Should I add this entry?"
User: "Make it high priority"
Agent: "Updated plan:
  - Name: Search filter not working on dashboard
  - Status: Open
  - Priority: High

  Should I proceed?"
User: "Yes"
Agent: [calls notion_add_to_database] "Added entry to Notion database
https://www.notion.so/..."
```

```
User: "Add a task to database abc123: 'Deploy v2.1 to staging' with status In Progress and due date March 1st"
Agent: "I'll add the following entry to the database:
  - Database: abc123
  - Name: Deploy v2.1 to staging
  - Status: In Progress
  - Due Date: 2026-03-01

  Should I create this entry?"
User: "Yes"
Agent: [calls notion_add_to_database] "Added entry to Notion database
https://www.notion.so/..."
```

```
User: "Log a test result in database xyz789 - test case 'User Registration', passed, with tags 'smoke' and 'auth'"
Agent: "I'll add the following entry:
  - Database: xyz789
  - Name: User Registration
  - Status: Passed (select)
  - Tags: smoke, auth (multi_select)

  Should I add this?"
User: "Go ahead"
Agent: [calls notion_add_to_database] "Added entry to Notion database
https://www.notion.so/..."
```

---

## Notion Properties Reference

Notion database properties and page properties follow a strict JSON format. Each property type has its own schema. AI models must format property values exactly as shown below.

### title

The primary name/title of a page. Every database has exactly one title property.

```json
{
  "Name": {
    "title": [
      {
        "text": {
          "content": "Page Title Here"
        }
      }
    ]
  }
}
```

### rich_text

Plain text or formatted text content.

```json
{
  "Description": {
    "rich_text": [
      {
        "text": {
          "content": "This is the description text"
        }
      }
    ]
  }
}
```

Multiple text segments can be concatenated:
```json
{
  "Notes": {
    "rich_text": [
      { "text": { "content": "First part. " } },
      { "text": { "content": "Second part." } }
    ]
  }
}
```

### number

Numeric value (integer or float).

```json
{
  "Priority Score": {
    "number": 85
  }
}
```

```json
{
  "Completion Rate": {
    "number": 0.95
  }
}
```

### select

Single selection from predefined options.

```json
{
  "Status": {
    "select": {
      "name": "In Progress"
    }
  }
}
```

**Important:** The `name` value must match an existing option in the database exactly (case-sensitive). If the option does not exist, Notion will create it automatically in some configurations.

### multi_select

Multiple selections from predefined options.

```json
{
  "Tags": {
    "multi_select": [
      { "name": "bug" },
      { "name": "critical" },
      { "name": "backend" }
    ]
  }
}
```

### date

Date or date range. Supports ISO 8601 format.

```json
// Single date
{
  "Due Date": {
    "date": {
      "start": "2026-03-15"
    }
  }
}

// Date with time
{
  "Meeting Time": {
    "date": {
      "start": "2026-03-15T14:00:00.000+00:00"
    }
  }
}

// Date range
{
  "Sprint Duration": {
    "date": {
      "start": "2026-03-01",
      "end": "2026-03-14"
    }
  }
}
```

### checkbox

Boolean true/false value.

```json
{
  "Completed": {
    "checkbox": true
  }
}
```

```json
{
  "Archived": {
    "checkbox": false
  }
}
```

### url

URL value.

```json
{
  "Website": {
    "url": "https://example.com/docs"
  }
}
```

### email

Email address value.

```json
{
  "Contact Email": {
    "email": "team@example.com"
  }
}
```

### phone_number

Phone number value (stored as string).

```json
{
  "Support Line": {
    "phone_number": "+1-555-0123"
  }
}
```

### status

Status property (distinct from select; uses Notion's built-in status groups: To-do, In progress, Complete).

```json
{
  "Status": {
    "status": {
      "name": "In progress"
    }
  }
}
```

**Note:** The `status` property type is different from `select`. Notion databases can use either one. The `status` type has built-in grouping (To-do, In progress, Complete) while `select` is fully custom. Check which type the database uses before formatting.

---

## Behavioral Rules for AI Models

### Confirmation Pattern

```
For WRITE tools (notion_create_page, notion_update_page, notion_add_to_database):
1. Parse the user's intent
2. Show a summary of what you will do (parent/database, title, properties, etc.)
3. Ask "Should I proceed?" or "Should I create this?"
4. Only call the tool function AFTER the user confirms
5. Report the result back to the user, including the page URL

For READ tools (notion_search):
1. Parse the user's intent
2. Call the tool function immediately (no confirmation needed)
3. Format the results in a readable list for the user
4. Offer follow-up actions (e.g., "Would you like me to update any of these?")
```

### Missing parent_id / database_id Handling

```
If user doesn't specify parent_id:
  1. Ask "Which Notion page should I create this under? Please provide the page ID."
  2. Alternatively, offer to search: "I can search for it. What's the parent page called?"
  3. If user gives a page name, use notion_search first, then use the returned ID.

If user doesn't specify database_id:
  1. Ask "Which Notion database should I add this to? Please provide the database ID."
  2. Note: notion_search filters by pages only, so it cannot discover databases directly.
     The user must provide the database ID from their Notion URL.

If user doesn't specify page_id for updates:
  1. Ask "Which page should I update? Provide the page ID or I can search for it."
  2. If user gives a name, use notion_search, then confirm the correct page before updating.
```

### Property Formatting Guidance

```
When the user specifies properties in natural language, convert them to Notion format:

User says "title: My Page"       -> { "Name": { "title": [{"text": {"content": "My Page"}}] } }
User says "status: Done"         -> { "Status": { "select": {"name": "Done"} } }
                                    OR { "Status": { "status": {"name": "Done"} } }
                                    (depends on database schema - prefer select if unsure)
User says "priority: High"       -> { "Priority": { "select": {"name": "High"} } }
User says "tags: bug, critical"  -> { "Tags": { "multi_select": [{"name": "bug"}, {"name": "critical"}] } }
User says "due date: March 15"   -> { "Due Date": { "date": {"start": "2026-03-15"} } }
User says "completed: yes"       -> { "Completed": { "checkbox": true } }
User says "score: 85"            -> { "Score": { "number": 85 } }
User says "link: https://..."    -> { "Link": { "url": "https://..." } }
```

### Important Notes for AI Models

```
1. Property names are CASE-SENSITIVE. "Status" != "status". Match the exact database property name.
2. The title property name varies by database. Common names: "Name", "Title", "Task", "Page".
   When unsure, use "Name" as the default title property name.
3. Notion page IDs are UUIDs. They can appear with or without hyphens:
   - With hyphens: a1b2c3d4-e5f6-7890-abcd-ef1234567890
   - Without hyphens: a1b2c3d4e5f67890abcdef1234567890
   Both formats are accepted by the API.
4. Only pages/databases explicitly shared with the Notion integration bot are accessible.
   If a 404 error occurs, the page likely hasn't been shared with the integration.
5. notion_create_page uses { parent: { page_id } } - for creating sub-pages under a page.
   notion_add_to_database uses { parent: { database_id } } - for adding rows to a database.
   Do NOT confuse the two: use notion_add_to_database when adding entries to a table/database.
6. All API requests include the Notion-Version header set to "2022-06-28".
```

---

## Error Handling

| Error | Cause | Agent Response |
|-------|-------|----------------|
| "Notion integration not connected" | No enabled token in `integration_tokens` for provider='notion' | "Your Notion workspace is not connected. Please connect it via the integrations page." |
| "Notion API error: 401" | Token is invalid or revoked | "Your Notion connection has expired. Please reconnect your workspace." |
| "Notion API error: 404 object_not_found" | Page/database not found or not shared with integration | "I couldn't find that page or database. Make sure it's shared with the Notion integration in your workspace settings." |
| "Notion API error: 400 validation_error" | Invalid property format or property name mismatch | "The property format is incorrect. Let me fix the format and try again." |
| "Notion API error: 403" | Integration doesn't have permission for the requested operation | "The Notion integration doesn't have permission to perform this action. Check the integration's capabilities in your Notion settings." |
| "Notion API error: 429" | Rate limit exceeded | "Notion's rate limit has been reached. Please wait a moment and try again." |
| "Notion API error: 500/502/503" | Notion server error | "Notion's servers are experiencing issues. Please try again in a few minutes." |
| "Missing required fields: parent_id, title" | Tool called without required parameters | Parse the user's request again and ask for missing information. |
| "Missing required fields: page_id, properties" | Tool called without required parameters | "Which page should I update? Please provide the page ID." |
| "Missing required fields: database_id, properties" | Tool called without required parameters | "Which database should I add to? Please provide the database ID." |
| "Unknown Notion tool: {name}" | Invalid tool name routed to Notion skill | Internal error; should not occur in normal operation. |

---

## Source Files

| File | Purpose |
|------|---------|
| `src/services/skills/integrations/notion.skill.ts` | Skill definition, tools, execute handler, tool routing |
| `src/services/api/notion.service.ts` | Notion REST API client (token retrieval, page CRUD, search, database operations) |
| `src/services/skills/types.ts` | SkillDefinition, SkillContext, SkillResult, IntegrationProvider types |
| `src/services/skills/skill-registry.ts` | SkillRegistry singleton (registration, availability, execution routing) |
| `src/api/integrations/integrations.controller.ts` | OAuth flow: buildNotionAuthUrl, handleNotionCallback, token exchange |
| `src/api/integrations/integrations.route.ts` | Route definitions: `/:provider/authorize`, `/:provider/callback` |
| `src/config/environment/env.ts` | Environment config: NOTION_CLIENT_ID, NOTION_CLIENT_SECRET |
