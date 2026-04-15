---
name: telegram
provider: telegram
version: "1.0"
description: Send messages, notifications, and documents to Telegram chats, groups, and channels via Bot API
auth: bot_token
token_table: integration_tokens (provider='telegram') OR env TELEGRAM_BOT_TOKEN
api_base: https://api.telegram.org
requires_confirmation: [telegram_send_message, telegram_send_document, telegram_send_notification]
read_only_tools: [telegram_get_chat]
tools:
  - telegram_send_message
  - telegram_get_chat
  - telegram_send_document
  - telegram_send_notification
supported_ai_models:
  - gpt-4o
  - gpt-4o-mini
  - gemini-2.5-flash
  - gemini-2.5-flash-lite
  - claude-sonnet-4-5
  - claude-opus-4
---

# Telegram Skill

## Overview

The Telegram skill allows the QAIT agent to interact with Telegram chats, groups, and channels through the Telegram Bot API. It wraps the Telegram Bot API service (`src/services/api/telegram.service.ts`) and exposes 4 tools for messaging via OpenAI function calling format.

This skill enables:
- **Sending text messages** to any Telegram chat, group, or channel (with HTML/Markdown formatting)
- **Sending formatted notifications** with severity levels (info, success, warning, error) including emoji indicators
- **Sending documents/files** via URL to Telegram chats
- **Retrieving chat information** (type, title, username, description)

The implementation uses the Telegram Bot API directly via `fetch` -- there is no dependency on grammy, telegraf, or any other Telegram framework library.

This skill is registered in the SkillRegistry singleton at server startup and becomes available when a user has a Telegram bot token configured (either per-user in `integration_tokens` or globally via `TELEGRAM_BOT_TOKEN` environment variable).

## Architecture

```
User Chat Message
    |
    v
General Chat Handler (handler.ts)
    |
    v
SkillRegistry.getAvailableTools() --> checks TelegramSkill.isAvailable()
    |                                      |
    |                                      v
    |                                getTelegramToken(userId)
    |                                      |
    |                                      v
    |                           +-------------------------------+
    |                           | 1. integration_tokens table   |
    |                           |    (provider='telegram',      |
    |                           |     user_id, enabled=true)    |
    |                           |                               |
    |                           | 2. TELEGRAM_BOT_TOKEN env     |
    |                           |    (global fallback)          |
    |                           +-------------------------------+
    |
    v
AI Model (with tools parameter)
    |
    v
tool_calls response
    |
    v
SkillRegistry.executeTool('telegram_send_message', args, context)
    |
    v
TelegramSkill.execute() --> getTelegramToken() --> botToken
    |
    v
fetch('https://api.telegram.org/bot{token}/sendMessage', { ... })
    |
    v
Telegram Bot API Response
    |
    v
SkillResult { success, data, message, displayToUser }
```

## Authentication

| Field | Value |
|-------|-------|
| **Method** | Bot Token (static API key from @BotFather) |
| **Provider** | Telegram Bot API |
| **Token Source 1** | Per-user: `integration_tokens` table where `provider='telegram'` and `enabled=true` |
| **Token Source 2** | Global fallback: `TELEGRAM_BOT_TOKEN` environment variable |
| **Priority** | Per-user token takes priority over global env token |
| **Refresh** | None required -- bot tokens do not expire |
| **Config** | `TELEGRAM_BOT_TOKEN` env var (optional global fallback) |

### Token Data Structure (integration_tokens table)

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "workspace_id": "uuid (optional)",
  "access_token": "7123456789:AAHfiqksKZ8WmR2zCx463hg-_EhsNHQwBkM",
  "external_id": "@my_bot_username",
  "external_url": null,
  "metadata": {},
  "enabled": true,
  "created_at": "2026-02-10T08:00:00.000Z",
  "updated_at": "2026-02-10T08:00:00.000Z"
}
```

### Global Fallback Token Structure (from env)

When no per-user token is found, the service constructs a synthetic `TelegramTokenData` object from the `TELEGRAM_BOT_TOKEN` environment variable:

```json
{
  "id": "env-global",
  "user_id": "<requesting-user-id>",
  "access_token": "<value of TELEGRAM_BOT_TOKEN>",
  "enabled": true,
  "created_at": "<current ISO timestamp>",
  "updated_at": "<current ISO timestamp>"
}
```

### Availability Check

```typescript
// TelegramSkill.isAvailable(context) implementation:
async isAvailable(context: SkillContext): Promise<boolean> {
  try {
    const token = await getTelegramToken(context.userId);
    return token !== null;
  } catch (error) {
    return false;
  }
}

// getTelegramToken fallback logic:
// 1. Query: SELECT * FROM integration_tokens
//      WHERE user_id = $1 AND provider = 'telegram' AND enabled = true
//      ORDER BY created_at DESC LIMIT 1
// 2. If found -> return per-user token
// 3. If not found AND env.TELEGRAM_BOT_TOKEN exists -> return synthetic token
// 4. If neither -> return null (skill unavailable)
```

---

## Tools

### 1. telegram_send_message

**Purpose:** Send a text message to a Telegram chat, group, or channel. Supports HTML, Markdown, and MarkdownV2 formatting.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "telegram_send_message",
    "description": "Send a text message to a Telegram chat or group. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "chat_id": {
          "type": "string",
          "description": "Telegram chat ID or @channel_username to send the message to"
        },
        "text": {
          "type": "string",
          "description": "Message text to send. Supports HTML formatting (<b>bold</b>, <i>italic</i>, <code>code</code>)."
        },
        "parse_mode": {
          "type": "string",
          "enum": ["HTML", "Markdown", "MarkdownV2"],
          "description": "Message formatting mode. Default: HTML"
        }
      },
      "required": ["chat_id", "text"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `chat_id` | string | Yes | - | Telegram chat ID (numeric string like "-1001234567890") or @channel_username (like "@mychannel"). See Chat ID Reference below. |
| `text` | string | Yes | - | Message text. Supports HTML tags when parse_mode is HTML. Max 4096 characters per Telegram API limits. |
| `parse_mode` | string | No | "HTML" | Formatting mode. One of: `HTML`, `Markdown`, `MarkdownV2`. HTML is recommended as the default. |

**HTML Formatting Support:**

When `parse_mode` is `HTML` (the default), the following tags are supported:

| Tag | Rendered As | Example |
|-----|-------------|---------|
| `<b>text</b>` | **bold** | `<b>Important</b>` |
| `<i>text</i>` | *italic* | `<i>Note</i>` |
| `<u>text</u>` | underline | `<u>underlined</u>` |
| `<s>text</s>` | ~~strikethrough~~ | `<s>removed</s>` |
| `<code>text</code>` | `inline code` | `<code>var x = 1</code>` |
| `<pre>text</pre>` | code block | `<pre>function() {}</pre>` |
| `<pre><code class="language-python">text</code></pre>` | syntax-highlighted code block | See below |
| `<a href="url">text</a>` | hyperlink | `<a href="https://example.com">Link</a>` |
| `<tg-spoiler>text</tg-spoiler>` | spoiler | `<tg-spoiler>hidden</tg-spoiler>` |
| `<blockquote>text</blockquote>` | block quote | `<blockquote>Quoted text</blockquote>` |

**Telegram Bot API endpoint:** `POST /bot{token}/sendMessage`

**Request body sent to Telegram API:**
```json
{
  "chat_id": "-1001234567890",
  "text": "<b>Build Passed</b>\nAll 42 tests passed successfully.",
  "parse_mode": "HTML"
}
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "messageId": 1547,
    "chatId": "-1001234567890"
  },
  "message": "Sent message to Telegram chat -1001234567890",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: chat_id, text", "displayToUser": false }

// Bot not in chat / invalid chat ID
{ "success": false, "message": "Failed to send message: Telegram API error: 400 {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: chat not found\"}", "displayToUser": true }

// Bot not configured
{ "success": false, "message": "Telegram bot not configured. Please set TELEGRAM_BOT_TOKEN or connect via integrations.", "displayToUser": true }

// Message too long
{ "success": false, "message": "Failed to send message: Telegram API error: 400 {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: message is too long\"}", "displayToUser": true }
```

**Conversation Examples:**

```
User: "Send a message to our QA channel saying all tests passed"
Agent: "I'll send this message to your Telegram channel. Which chat ID or channel username should I send it to?"
User: "@qa_notifications"
Agent: "I'll send the following message to @qa_notifications:

  All tests passed successfully.

  Should I proceed?"
User: "Yes"
Agent: [calls telegram_send_message with chat_id="@qa_notifications", text="All tests passed successfully."]
Agent: "Message sent to Telegram chat @qa_notifications."
```

```
User: "Send this to Telegram chat -1001234567890: Build #145 deployed to staging"
Agent: "I'll send the following message to chat -1001234567890:

  Build #145 deployed to staging

  Should I send this?"
User: "Yes, go ahead"
Agent: [calls telegram_send_message] "Sent message to Telegram chat -1001234567890."
```

```
User: "Send a formatted message to @devteam with bold title 'Release Notes' and the body 'Version 2.5.0 is now live'"
Agent: "I'll send this HTML-formatted message to @devteam:

  <b>Release Notes</b>
  Version 2.5.0 is now live

  Should I proceed?"
User: "Yes"
Agent: [calls telegram_send_message with parse_mode="HTML", text="<b>Release Notes</b>\nVersion 2.5.0 is now live"]
Agent: "Sent message to Telegram chat @devteam."
```

---

### 2. telegram_get_chat

**Purpose:** Retrieve information about a Telegram chat, group, or channel. Read-only operation.

**Action type:** READ (no confirmation needed, execute immediately)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "telegram_get_chat",
    "description": "Get information about a Telegram chat, group, or channel.",
    "parameters": {
      "type": "object",
      "properties": {
        "chat_id": {
          "type": "string",
          "description": "Telegram chat ID or @channel_username"
        }
      },
      "required": ["chat_id"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `chat_id` | string | Yes | - | Telegram chat ID (numeric string) or @channel_username. The bot must be a member of the chat/group/channel to retrieve info. |

**Telegram Bot API endpoint:** `POST /bot{token}/getChat`

**Request body sent to Telegram API:**
```json
{
  "chat_id": "@qa_notifications"
}
```

**Success Response (supergroup):**
```json
{
  "success": true,
  "data": {
    "id": -1001234567890,
    "type": "supergroup",
    "title": "QA Notifications",
    "username": "qa_notifications",
    "description": "Automated QA test results and notifications"
  },
  "message": "Chat: QA Notifications (supergroup)",
  "displayToUser": true
}
```

**Success Response (private chat):**
```json
{
  "success": true,
  "data": {
    "id": 123456789,
    "type": "private",
    "title": "John Doe",
    "username": "johndoe",
    "description": null
  },
  "message": "Chat: John Doe (private)",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing chat_id
{ "success": false, "message": "Missing required field: chat_id", "displayToUser": false }

// Chat not found / bot not member
{ "success": false, "message": "Failed to get chat info: Telegram API error: 400 {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: chat not found\"}", "displayToUser": true }
```

**Conversation Examples:**

```
User: "What type of chat is -1001234567890?"
Agent: [calls telegram_get_chat with chat_id="-1001234567890"]
Agent: "That's a supergroup called 'QA Notifications' (@qa_notifications). It's described as: Automated QA test results and notifications."
```

```
User: "Can you check if our bot has access to @devteam channel?"
Agent: [calls telegram_get_chat with chat_id="@devteam"]
Agent: "Yes, the bot has access. It's a channel called 'Dev Team'."
```

```
User: "Get info about chat @nonexistent_channel"
Agent: [calls telegram_get_chat with chat_id="@nonexistent_channel"]
Agent: "I couldn't retrieve info for that chat. The bot may not be a member, or the chat ID might be incorrect. Please verify the chat ID and ensure the bot has been added to the group/channel."
```

---

### 3. telegram_send_document

**Purpose:** Send a document or file to a Telegram chat by providing a publicly accessible URL. Telegram's servers will download the file from the URL and deliver it to the chat.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "telegram_send_document",
    "description": "Send a document/file to a Telegram chat via URL. Requires user confirmation before execution.",
    "parameters": {
      "type": "object",
      "properties": {
        "chat_id": {
          "type": "string",
          "description": "Telegram chat ID or @channel_username"
        },
        "document_url": {
          "type": "string",
          "description": "URL of the document to send"
        },
        "caption": {
          "type": "string",
          "description": "Optional caption for the document"
        }
      },
      "required": ["chat_id", "document_url"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `chat_id` | string | Yes | - | Telegram chat ID (numeric string) or @channel_username. |
| `document_url` | string | Yes | - | Publicly accessible URL of the document to send. Telegram servers will download it. Max file size: 50 MB. Supported: PDF, ZIP, DOCX, XLSX, TXT, CSV, and other file types. |
| `caption` | string | No | - | Optional caption displayed below the document. Max 1024 characters. |

**Telegram Bot API endpoint:** `POST /bot{token}/sendDocument`

**Request body sent to Telegram API:**
```json
{
  "chat_id": "-1001234567890",
  "document": "https://example.com/reports/test-results-2026-02-10.pdf",
  "caption": "Test Results - February 10, 2026"
}
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "messageId": 1548,
    "chatId": "-1001234567890"
  },
  "message": "Sent document to Telegram chat -1001234567890",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: chat_id, document_url", "displayToUser": false }

// Invalid URL / unreachable document
{ "success": false, "message": "Failed to send document: Telegram API error: 400 {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: wrong file identifier/HTTP URL specified\"}", "displayToUser": true }

// File too large
{ "success": false, "message": "Failed to send document: Telegram API error: 400 {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: file is too big\"}", "displayToUser": true }
```

**Conversation Examples:**

```
User: "Send the test report PDF to our QA channel"
Agent: "I can send a document to your QA Telegram channel. Please provide:
  1. The URL of the PDF
  2. The chat ID or channel username"
User: "URL is https://ci.example.com/reports/run-4521.pdf, channel is @qa_notifications"
Agent: "I'll send the document to @qa_notifications:

  Document: https://ci.example.com/reports/run-4521.pdf
  Caption: Test Report - Run #4521

  Should I proceed?"
User: "Yes"
Agent: [calls telegram_send_document] "Sent document to Telegram chat @qa_notifications."
```

```
User: "Share https://storage.example.com/builds/v2.5.0-changelog.txt to -1001234567890 with caption 'Changelog for v2.5.0'"
Agent: "I'll send this document to chat -1001234567890:

  Document: https://storage.example.com/builds/v2.5.0-changelog.txt
  Caption: Changelog for v2.5.0

  Should I send this?"
User: "Go ahead"
Agent: [calls telegram_send_document] "Sent document to Telegram chat -1001234567890."
```

```
User: "Send the coverage report to the dev channel"
Agent: "I'll need the document URL and the target chat. What is the URL of the coverage report, and which Telegram chat should I send it to?"
User: "https://ci.example.com/coverage/report.html and send it to @devteam"
Agent: "I'll send this to @devteam:

  Document: https://ci.example.com/coverage/report.html

  Would you like to add a caption? If not, I'll send it without one."
User: "Add caption: Coverage Report - Sprint 14"
Agent: "I'll send the document to @devteam with caption 'Coverage Report - Sprint 14'. Should I proceed?"
User: "Yes"
Agent: [calls telegram_send_document] "Sent document to Telegram chat @devteam."
```

---

### 4. telegram_send_notification

**Purpose:** Send a formatted notification message with severity level and consistent styling. Intended for test results, build status, alerts, and other structured notifications. Uses the `sendMessage` API internally with a formatted HTML template.

**Action type:** WRITE (requires user confirmation before execution)

**OpenAI Function Definition:**
```json
{
  "type": "function",
  "function": {
    "name": "telegram_send_notification",
    "description": "Send a formatted notification message (e.g., test results, build status, alerts) to a Telegram chat. Requires user confirmation.",
    "parameters": {
      "type": "object",
      "properties": {
        "chat_id": {
          "type": "string",
          "description": "Telegram chat ID or @channel_username"
        },
        "title": {
          "type": "string",
          "description": "Notification title"
        },
        "body": {
          "type": "string",
          "description": "Notification body text"
        },
        "level": {
          "type": "string",
          "enum": ["info", "success", "warning", "error"],
          "description": "Notification severity level. Default: info"
        }
      },
      "required": ["chat_id", "title", "body"]
    }
  }
}
```

**Parameters Detail:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `chat_id` | string | Yes | - | Telegram chat ID (numeric string) or @channel_username. |
| `title` | string | Yes | - | Notification title. Rendered in bold HTML. Keep concise (1 line). |
| `body` | string | Yes | - | Notification body text. Can be multi-line. Plain text (no HTML needed -- the template wraps it). |
| `level` | string | No | "info" | Severity level that determines the emoji prefix. One of: `info`, `success`, `warning`, `error`. |

**Emoji Mapping:**

| Level | Emoji | Unicode | Use Case |
|-------|-------|---------|----------|
| `info` | ℹ️ | `\u2139\uFE0F` | General information, status updates, FYI notifications |
| `success` | ✅ | `\u2705` | Tests passed, build successful, deployment complete |
| `warning` | ⚠️ | `\u26A0\uFE0F` | Flaky tests, performance degradation, approaching limits |
| `error` | ❌ | `\u274C` | Tests failed, build broken, deployment failed, critical issues |

**Formatted Message Template:**

The notification is assembled into the following HTML template before being sent via `sendMessage` with `parse_mode: 'HTML'`:

```
{emoji} <b>{title}</b>

{body}

<i>Sent via QAIT</i>
```

**Example rendered messages:**

```
✅ <b>Test Suite Passed</b>

All 128 test cases passed in 4m 32s.
Coverage: 87.3%

<i>Sent via QAIT</i>
```

```
❌ <b>Build Failed</b>

Build #456 failed at step 'unit-tests'.
3 tests failed in module auth-service.
See logs: https://ci.example.com/builds/456

<i>Sent via QAIT</i>
```

**Telegram Bot API endpoint:** `POST /bot{token}/sendMessage` (internally uses sendMessage with formatted HTML)

**Request body sent to Telegram API:**
```json
{
  "chat_id": "-1001234567890",
  "text": "✅ <b>Test Suite Passed</b>\n\nAll 128 test cases passed in 4m 32s.\nCoverage: 87.3%\n\n<i>Sent via QAIT</i>",
  "parse_mode": "HTML"
}
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "messageId": 1549,
    "chatId": "-1001234567890",
    "level": "success"
  },
  "message": "Sent success notification to Telegram chat -1001234567890",
  "displayToUser": true
}
```

**Error Responses:**
```json
// Missing required fields
{ "success": false, "message": "Missing required fields: chat_id, title, body", "displayToUser": false }

// Bot not in chat
{ "success": false, "message": "Failed to send notification: Telegram API error: 400 {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: chat not found\"}", "displayToUser": true }
```

**Conversation Examples:**

```
User: "Send a success notification to @qa_notifications that all tests passed"
Agent: "I'll send a success notification to @qa_notifications:

  ✅ Test Suite Passed
  All tests passed successfully.

  Should I send this?"
User: "Yes"
Agent: [calls telegram_send_notification with level="success", title="Test Suite Passed", body="All tests passed successfully."]
Agent: "Sent success notification to Telegram chat @qa_notifications."
```

```
User: "Notify the team on Telegram that build #789 failed -- 3 unit tests broken in auth module"
Agent: "I'll send an error notification. Which chat should I send it to?"
User: "-1001234567890"
Agent: "I'll send this error notification to chat -1001234567890:

  ❌ Build #789 Failed
  3 unit tests broken in auth module.

  Should I proceed?"
User: "Yes"
Agent: [calls telegram_send_notification with level="error", title="Build #789 Failed", body="3 unit tests broken in auth module."]
Agent: "Sent error notification to Telegram chat -1001234567890."
```

```
User: "Send a warning to @devteam about flaky tests in the payment module"
Agent: "I'll send a warning notification to @devteam:

  ⚠️ Flaky Tests Detected
  Payment module has flaky tests that intermittently fail. Investigation recommended.

  Should I send this?"
User: "Yes"
Agent: [calls telegram_send_notification with level="warning"] "Sent warning notification to Telegram chat @devteam."
```

---

## Telegram Chat ID Reference

### Chat ID Formats

| Chat Type | Format | Example | Notes |
|-----------|--------|---------|-------|
| **Private chat** | Positive integer | `123456789` | User's unique Telegram ID |
| **Group** | Negative integer | `-1234567890` | Standard group chat ID |
| **Supergroup** | Negative 13-digit | `-1001234567890` | Supergroups start with `-100` prefix |
| **Channel** | Negative 13-digit or @username | `-1001234567890` or `@mychannel` | Public channels can use @username |

### How to Get a Chat ID

1. **For private chats:** Send a message to the bot, then call `https://api.telegram.org/bot{token}/getUpdates` and look for `message.chat.id` in the response.

2. **For groups/supergroups:** Add the bot to the group, send any message in the group, then call `getUpdates` and look for the `chat.id` field.

3. **For public channels:** Use the `@channel_username` format directly (e.g., `@qa_notifications`). No numeric ID needed.

4. **For private channels:** Add the bot as an admin, forward a message from the channel to `@userinfobot`, or use the `getUpdates` method after the bot is added.

5. **Using telegram_get_chat:** If you have a @username, call `telegram_get_chat` to retrieve the numeric `id` from the response.

### Important Notes

- Chat IDs are passed as **strings** in the tool parameters, even though they are numeric.
- The bot **must be a member** of the group/channel to send messages. For channels, the bot must be added as an **administrator**.
- Group chat IDs are always **negative numbers**.
- When a regular group is converted to a supergroup, the chat ID changes (gets a `-100` prefix).

---

## HTML Formatting Reference

When using `parse_mode: "HTML"` (the default for all Telegram skill tools), the following HTML tags are supported by the Telegram Bot API:

```html
<!-- Text styling -->
<b>bold text</b>
<strong>bold text</strong>
<i>italic text</i>
<em>italic text</em>
<u>underline text</u>
<ins>underline text</ins>
<s>strikethrough</s>
<strike>strikethrough</strike>
<del>strikethrough</del>

<!-- Code -->
<code>inline code</code>
<pre>code block (preformatted)</pre>
<pre><code class="language-python">
def hello():
    print("Hello, world!")
</code></pre>

<!-- Links -->
<a href="https://example.com">link text</a>

<!-- Mentions -->
<a href="tg://user?id=123456789">inline mention</a>

<!-- Special -->
<tg-spoiler>spoiler text</tg-spoiler>
<blockquote>block quote</blockquote>
<blockquote expandable>expandable block quote</blockquote>

<!-- Custom emoji (Telegram Premium) -->
<tg-emoji emoji-id="5368324170671202286">emoji</tg-emoji>
```

**Rules:**
- All HTML tags must be properly closed.
- Special characters `<`, `>`, and `&` in text content must be escaped as `&lt;`, `&gt;`, and `&amp;`.
- Nested tags are supported (e.g., `<b><i>bold italic</i></b>`).
- Unsupported tags are stripped by the Telegram API.

---

## Behavioral Rules for AI Models

### Confirmation Pattern

```
For WRITE tools (telegram_send_message, telegram_send_document, telegram_send_notification):
1. Parse the user's intent
2. Show a preview of the message that will be sent (including the target chat)
3. Ask "Should I send this?" or "Should I proceed?"
4. Only call the tool function AFTER the user confirms
5. Report the result back to the user

For READ tools (telegram_get_chat):
1. Parse the user's intent
2. Call the tool function immediately (no confirmation needed)
3. Format the results in a readable way for the user
```

### Missing Information Handling

```
If user doesn't specify chat_id:      Ask "Which Telegram chat should I send to? Please provide a chat ID
                                       (e.g., -1001234567890) or channel username (e.g., @mychannel)."
If user doesn't specify text/body:     Compose appropriate text from context, then confirm with user before sending.
If user doesn't specify parse_mode:    Default to "HTML" (no need to ask).
If user doesn't specify level:         Infer from context. Default to "info" if unclear.
If user doesn't specify caption:       Omit it (optional field). If context suggests one, propose it and confirm.
If user doesn't specify document_url:  Ask "What is the URL of the document you want to send?"
```

### Notification Level Selection Logic

```
When the user says:                          Select level:
"tests passed" / "build succeeded"          -> success
"tests failed" / "build broken" / "error"   -> error
"flaky tests" / "slow" / "degraded"         -> warning
"deployed" / "status update" / "FYI"        -> info
"critical" / "outage" / "down"              -> error
"new release" / "changelog"                 -> info
"alert" / "attention needed"                -> warning
"all clear" / "resolved" / "fixed"          -> success
```

### Message Composition Guidelines

```
1. Keep messages concise -- Telegram messages should be scannable.
2. Use HTML formatting to improve readability (<b> for titles, <code> for technical terms).
3. For notifications, always use telegram_send_notification (not telegram_send_message) --
   it provides consistent formatting with emoji and the QAIT footer.
4. For documents with context, always include a caption.
5. When the user provides raw content, format it appropriately rather than sending it verbatim.
6. Do not add HTML formatting to the body of telegram_send_notification -- the template handles it.
7. For telegram_send_message, prefer HTML parse_mode unless the user explicitly requests Markdown.
```

---

## Setup Guide

### Step 1: Create a Bot via @BotFather

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot` to start the creation process.
3. Provide a **display name** for the bot (e.g., "QAIT Notifications").
4. Provide a **username** for the bot (must end in `bot`, e.g., `qait_notify_bot`).
5. @BotFather will respond with a **bot token** in the format: `7123456789:AAHfiqksKZ8WmR2zCx463hg-_EhsNHQwBkM`.
6. Save this token securely.

### Step 2: Configure the Token

**Option A -- Global (environment variable):**
```bash
# Add to your .env file
TELEGRAM_BOT_TOKEN=7123456789:AAHfiqksKZ8WmR2zCx463hg-_EhsNHQwBkM
```

**Option B -- Per-user (integration_tokens table):**
```sql
INSERT INTO integration_tokens (user_id, provider, access_token, enabled)
VALUES ('user-uuid-here', 'telegram', '7123456789:AAHfiqksKZ8WmR2zCx463hg-_EhsNHQwBkM', true);
```

### Step 3: Add Bot to a Group or Channel

**For groups:**
1. Open the group in Telegram.
2. Go to Group Settings > Add Members.
3. Search for your bot by username (e.g., `@qait_notify_bot`).
4. Add it to the group.

**For channels:**
1. Open the channel in Telegram.
2. Go to Channel Settings > Administrators.
3. Add the bot as an administrator (bots must be admins to post in channels).
4. Grant at minimum the "Post Messages" permission.

### Step 4: Get the Chat ID

1. After adding the bot, send a message in the group/channel.
2. Open this URL in a browser: `https://api.telegram.org/bot{YOUR_TOKEN}/getUpdates`
3. Find the `"chat"` object in the response and note the `"id"` field.
4. Use this ID as the `chat_id` parameter in Telegram skill tools.

### Step 5: Verify

Test by using the `telegram_get_chat` tool with your chat ID. If it returns the chat information, the bot is properly configured and has access.

---

## Error Handling

| Error | Cause | Agent Response |
|-------|-------|----------------|
| "Telegram bot not configured. Please set TELEGRAM_BOT_TOKEN or connect via integrations." | No token found in `integration_tokens` and no `TELEGRAM_BOT_TOKEN` env var | "Your Telegram bot is not configured. Please set up a bot token via the integrations page or ask your admin to set the TELEGRAM_BOT_TOKEN environment variable." |
| "Telegram API error: 400 ... chat not found" | Invalid chat ID or bot has never interacted with this chat | "That chat ID doesn't exist or the bot hasn't been added to it. Please verify the chat ID and ensure the bot is a member of the group/channel." |
| "Telegram API error: 400 ... message is too long" | Message exceeds 4096 characters | "The message is too long for Telegram (max 4096 characters). Let me shorten it and try again." |
| "Telegram API error: 403 ... bot was blocked by the user" | User blocked the bot in private chat | "The user has blocked the bot. Messages cannot be delivered until they unblock it." |
| "Telegram API error: 403 ... bot is not a member of the channel chat" | Bot is not added to the channel as admin | "The bot is not a member of this channel. Please add the bot as an administrator to the channel." |
| "Telegram API error: 403 ... bot was kicked from the group chat" | Bot was removed from the group | "The bot was removed from this group. Please add it back to send messages." |
| "Telegram API error: 400 ... wrong file identifier/HTTP URL specified" | Invalid or inaccessible document URL | "The document URL is invalid or not publicly accessible. Please provide a direct, publicly accessible URL." |
| "Telegram API error: 400 ... file is too big" | Document exceeds 50 MB limit | "The file is too large. Telegram allows documents up to 50 MB." |
| "Telegram API error: 401 ... Unauthorized" | Invalid bot token | "The bot token is invalid. Please verify it was copied correctly from @BotFather." |
| "Telegram API error: 429 ... Too Many Requests" | Rate limit exceeded | "Telegram rate limit reached. Please wait a moment and try again." |
| `Unknown Telegram tool: {toolName}` | Internal routing error -- unsupported tool name | This should not occur in normal usage. Indicates a skill registry mismatch. |

---

## Source Files

| File | Purpose |
|------|---------|
| `src/services/skills/integrations/telegram.skill.ts` | Skill definition, tool definitions (TELEGRAM_TOOLS), execute handler routing, notification formatting with emoji mapping |
| `src/services/api/telegram.service.ts` | Telegram Bot API client (sendMessage, getChat, sendDocument, getMe, pinMessage), token retrieval with dual-source fallback logic, TypeScript interfaces (TelegramTokenData, TelegramMessage, TelegramChat) |
| `src/services/skills/types.ts` | SkillDefinition, SkillContext, SkillResult, IntegrationProvider type interfaces |
| `src/services/skills/skill-registry.ts` | SkillRegistry singleton that registers and manages all skills including Telegram |
| `src/config/environment/env.ts` | Environment configuration including TELEGRAM_BOT_TOKEN variable |
