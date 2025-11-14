# Multi-Chat Sessions API

## Overview

Multi-chat sessions allow users to create multiple isolated chat conversations, similar to ChatGPT. Each session maintains its own context, message history, and vector embeddings for semantic search.

## Key Features

- ✅ **Multiple independent chats** - Users can create unlimited chat sessions
- ✅ **Isolated contexts** - Each session has independent message history and vector embeddings
- ✅ **Auto-generated titles** - Session titles are automatically generated from first user message
- ✅ **Activity sorting** - Sessions sorted by `updated_at` (last activity)
- ✅ **CRUD operations** - Create, read, update, delete chat sessions
- ✅ **Backward compatible** - Existing single-chat flow still works

## Database Changes

### Migration: `multi-chat-sessions.sql`

**Added:**
- `updated_at` column to `chat_sessions` table
- Trigger to auto-update `updated_at` on new messages
- Indexes for performance: `idx_chat_sessions_user_updated`

**No breaking changes** - All existing data preserved.

## API Endpoints

### 1. Create New Chat Session

**POST** `/api/v1/chat/sessions/new`

Creates a new isolated chat session for multi-chat support.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "title": "New Chat",
    "created_at": "2025-11-14T..."
  },
  "message": "New chat session created"
}
```

### 2. List User Chat Sessions

**GET** `/api/v1/chat/sessions/list?limit=50&offset=0`

Returns all user's chat sessions sorted by recent activity.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "id": "uuid",
        "title": "Test my login flow",
        "created_at": "2025-11-14T...",
        "updated_at": "2025-11-14T...",
        "message_count": 15,
        "last_message": {
          "role": "ai",
          "content": "Test plan approved...",
          "created_at": "2025-11-14T..."
        }
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 10,
      "has_more": false
    }
  }
}
```

### 3. Get Chat Session by ID

**GET** `/api/v1/chat/sessions/:sessionId`

Returns specific chat session with all messages.

**Response:**
```json
{
  "success": true,
  "data": {
    "session": {
      "id": "uuid",
      "title": "Test my login flow",
      "created_at": "2025-11-14T...",
      "updated_at": "2025-11-14T..."
    },
    "messages": [
      {
        "id": "uuid",
        "role": "user",
        "content": "Test my login",
        "metadata": {},
        "created_at": "2025-11-14T..."
      }
    ]
  }
}
```

### 4. Update Chat Session Title

**PATCH** `/api/v1/chat/sessions/:sessionId`

Updates chat session title.

**Request:**
```json
{
  "title": "API Testing Discussion"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "title": "API Testing Discussion"
  },
  "message": "Chat title updated"
}
```

### 5. Delete Chat Session

**DELETE** `/api/v1/chat/sessions/:sessionId`

Deletes chat session and all messages (CASCADE).

**Response:**
```json
{
  "success": true,
  "message": "Chat session deleted"
}
```

## Frontend Integration

### Usage Flow

#### 1. **Create New Chat**

```typescript
// User clicks "New Chat" button
const response = await fetch('/api/v1/chat/sessions/new', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer TOKEN' }
});

const { data } = await response.json();
const newSessionId = data.sessionId; // Use this for subsequent messages
```

#### 2. **Send Message to Specific Chat**

```typescript
// Send message to specific session
const response = await fetch('/api/v1/chat', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: "Test my login flow",
    sessionId: newSessionId // IMPORTANT: Pass sessionId
  })
});
```

#### 3. **List All Chats (Sidebar)**

```typescript
// Load chat list for sidebar
const response = await fetch('/api/v1/chat/sessions/list?limit=50', {
  headers: { 'Authorization': 'Bearer TOKEN' }
});

const { data } = await response.json();
const sessions = data.sessions; // Display in sidebar
```

#### 4. **Switch Between Chats**

```typescript
// User clicks on different chat in sidebar
const response = await fetch(`/api/v1/chat/sessions/${sessionId}`, {
  headers: { 'Authorization': 'Bearer TOKEN' }
});

const { data } = await response.json();
const messages = data.messages; // Display in chat window
```

#### 5. **Delete Chat**

```typescript
// User clicks delete button
await fetch(`/api/v1/chat/sessions/${sessionId}`, {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer TOKEN' }
});
```

## Backend Architecture

### Context Isolation

Each chat session is **fully isolated**:

- ✅ **Message history** - Stored with `session_id`
- ✅ **Vector embeddings** - `chat_message_embeddings` table uses `session_id`
- ✅ **Context retrieval** - Semantic search scoped to `session_id`
- ✅ **Projects** - Each session can have different `project_id`

### Auto-Generated Titles

Titles are automatically generated from the first user message:
- Removes markdown, URLs, special chars
- Truncates to 50 characters
- Runs in background (non-blocking)

### Updated At Trigger

SQL trigger automatically updates `chat_sessions.updated_at` when:
- New message is inserted
- Keeps sessions sorted by recent activity

## Code Changes Summary

### New Files

1. **`multi-chat-sessions.sql`** - SQL migration
2. **`chat-sessions.controller.ts`** - CRUD endpoints for sessions

### Modified Files

1. **`chat.service.ts`** - Added methods:
   - `getUserChatSessions()` - List user sessions
   - `deleteChatSession()` - Delete session
   - `updateChatTitle()` - Update title
   - `autoGenerateTitle()` - Generate title from first message

2. **`chat.controller.ts`** - Modified:
   - `getOrCreateChatSession()` - Added `createNew` parameter
   - `handleGeneralChat()` - Auto-generate title after first message

3. **`chat.route.ts`** - Added routes:
   - `POST /sessions/new` - Create session
   - `GET /sessions/list` - List sessions
   - `GET /sessions/:id` - Get session
   - `PATCH /sessions/:id` - Update title
   - `DELETE /sessions/:id` - Delete session

## Backward Compatibility

✅ **No breaking changes!**

Existing behavior still works:
- If no `sessionId` provided → uses last active session
- Old chat sessions automatically get `updated_at = created_at`
- Vector search continues to work (isolated by `session_id`)

## Testing

### Manual Testing Steps

1. **Create new session:**
   ```bash
   curl -X POST http://localhost:3000/api/v1/chat/sessions/new \
     -H "Authorization: Bearer TOKEN"
   ```

2. **Send message to new session:**
   ```bash
   curl -X POST http://localhost:3000/api/v1/chat \
     -H "Authorization: Bearer TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"message": "Test my login", "sessionId": "SESSION_ID"}'
   ```

3. **List all sessions:**
   ```bash
   curl http://localhost:3000/api/v1/chat/sessions/list \
     -H "Authorization: Bearer TOKEN"
   ```

4. **Verify title was auto-generated** (should be "Test my login")

5. **Update title:**
   ```bash
   curl -X PATCH http://localhost:3000/api/v1/chat/sessions/SESSION_ID \
     -H "Authorization: Bearer TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"title": "Custom Title"}'
   ```

6. **Delete session:**
   ```bash
   curl -X DELETE http://localhost:3000/api/v1/chat/sessions/SESSION_ID \
     -H "Authorization: Bearer TOKEN"
   ```

## Performance Considerations

- **Indexes added** for fast session queries by user + updated_at
- **Vector search** remains fast (already indexed by session_id)
- **Pagination** supported for large chat lists
- **Auto-title generation** runs in background (non-blocking)

## Security

✅ All endpoints protected by `requireAuth` middleware
✅ Session ownership verified before any operation
✅ CASCADE delete ensures no orphaned messages
✅ Title length validated (max 200 chars)

## Future Enhancements

Potential improvements:
- [ ] AI-powered title generation (GPT-4o-mini)
- [ ] Session folders/tags for organization
- [ ] Search across all sessions
- [ ] Export session as JSON/PDF
- [ ] Pin favorite sessions

---

**Implementation Date:** 2025-11-14
**Status:** ✅ Complete & Production Ready
**Breaking Changes:** None
