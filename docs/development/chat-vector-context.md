# Chat Vector Context - Semantic Search for Chat History

## 📊 Overview

Instead of using GPT to summarize old chat messages (>20), we use **vector embeddings** for semantic search.

### ✅ Benefits:

| Metric | GPT Summarization | Vector Search |
|--------|-------------------|---------------|
| **Speed** | 2-3 seconds | ~100ms |
| **Cost** | $0.002 per 1K msgs | $0.0001 per 1K msgs |
| **Accuracy** | Lossy (summary) | Lossless (full content) |
| **Relevance** | All old context | Only relevant messages |

---

## 🏗️ Architecture

### Database Schema

```sql
-- New table: chat_message_embeddings
CREATE TABLE chat_message_embeddings (
    id UUID PRIMARY KEY,
    session_id UUID REFERENCES chat_sessions(id),
    message_id UUID REFERENCES chat_messages(id),
    role TEXT,                    -- 'user' or 'ai'
    content TEXT,                 -- Original message
    embedding VECTOR(1536),       -- OpenAI text-embedding-3-small
    metadata JSONB,
    created_at TIMESTAMP
);

-- Vector similarity search index (HNSW)
CREATE INDEX idx_chat_embeddings_vector
    ON chat_message_embeddings
    USING hnsw (embedding vector_cosine_ops);
```

### Workflow

```
1. User sends message:
   "давай потести API"

2. System counts messages:
   totalMessages = 50

3. Retrieve last 20 messages (always):
   [msg 31, msg 32, ... msg 50]

4. If totalMessages > 20:
   a) Auto-embed old messages (background):
      - Messages 1-30 → generate embeddings
      - Store in chat_message_embeddings table

   b) Semantic search:
      - Query: "давай потести API"
      - Generate query embedding
      - Find top 3 most similar old messages
      - Example results:
        * msg 5: "я хочу протестировать API /credit-packs" (similarity: 0.85)
        * msg 12: "API endpoint не отвечает" (similarity: 0.72)
        * msg 8: "запусти тест на проде" (similarity: 0.68)

5. Build context for AI:
   messages = [
     { role: 'system', content: 'You are QAIT...' },

     // ⬇️ RELEVANT old context (semantic search)
     { role: 'system', content: 'Relevant past context:\n...' },

     // ⬇️ Last 20 messages (full)
     ...recentMessages,

     // ⬇️ Current query
     { role: 'user', content: 'давай потести API' }
   ]
```

---

## 🚀 Implementation

### Service: `chat-embeddings.service.ts`

```typescript
// Embed a single message
await embedChatMessage(sessionId, messageId, role, content);

// Search chat history semantically
const results = await searchChatHistory(sessionId, queryText, {
  matchCount: 3,      // Top 3 results
  matchThreshold: 0.6 // Min similarity score
});

// Auto-embed old messages (background)
await autoEmbedOldMessages(sessionId);
```

### Controller: `chat.controller.ts`

```typescript
if (totalMessages > 20) {
  // Background: embed old messages
  autoEmbedOldMessages(chatSessionId);

  // Foreground: search relevant context
  const relevantOldMessages = await searchChatHistory(
    chatSessionId,
    message,
    { matchCount: 3, matchThreshold: 0.6 }
  );

  oldContextSummary = relevantOldMessages
    .map(msg => `${msg.role}: ${msg.content}`)
    .join('\n\n');
}
```

---

## 💾 Migration

### SQL Migration

Run: `supabase-migrations/features/chat-message-embeddings.sql`

This will:
- ✅ Create `chat_message_embeddings` table
- ✅ Add vector index for fast search
- ✅ Create `search_chat_history()` function
- ✅ Set up RLS policies

### Initial Embedding (Optional)

For existing chat sessions with >20 messages:

```typescript
// Embed all existing sessions
const sessions = await getAllSessionsWithOldMessages();

for (const session of sessions) {
  await autoEmbedOldMessages(session.id);
  await sleep(100); // Rate limit
}
```

---

## 📈 Performance

### Embedding Cost

| Messages | Tokens | Cost (text-embedding-3-small) |
|----------|--------|-------------------------------|
| 100 | ~50,000 | $0.001 |
| 1,000 | ~500,000 | $0.01 |
| 10,000 | ~5M | $0.10 |

### Search Performance

- **First search (without embeddings):** ~2 sec (embedding + search)
- **Subsequent searches:** ~100ms (search only)
- **Embedding rate limit:** ~100 requests/min

---

## 🎯 Example Use Cases

### 1. User discusses API testing multiple times

```
User (msg 5): "я вчера тестил https://api.hrgpt.kz/credit-packs"
AI (msg 6): "Какой метод использовать?"
User (msg 7): "GET"

... 25 messages later ...

User (msg 35): "давай потести"
AI: ✅ Находит msg 5-7 по контексту!
    "Вижу вы уже обсуждали этот API. Запускаю GET https://api.hrgpt.kz/credit-packs"
```

### 2. User mentions Docker setup

```
User (msg 12): "у нас на сервере Docker"
... 30 messages later ...
User (msg 45): "как деплоить?"
AI: ✅ Вспоминает msg 12
    "Вижу у вас Docker. Вот инструкция для Docker..."
```

---

## 🔧 Configuration

### Environment Variables

```env
# Already configured (uses existing OPENAI_API_KEY)
OPENAI_API_KEY=sk-...
```

### Tuning Parameters

```typescript
// In chat.controller.ts
const relevantOldMessages = await searchChatHistory(sessionId, message, {
  matchCount: 3,        // ⬅️ How many old messages to retrieve
  matchThreshold: 0.6,  // ⬅️ Min similarity (0.0 - 1.0)
});
```

**Recommendations:**
- `matchCount: 3-5` - Good balance
- `matchThreshold: 0.6` - Only relevant context
- Lower threshold = more context (but less relevant)

---

## 🐛 Troubleshooting

### No old context found

Check if embeddings exist:

```typescript
const count = await getEmbeddingsCount(sessionId);
console.log(`Embeddings: ${count}`);
```

### Slow search

Check vector index:

```sql
SELECT * FROM pg_indexes
WHERE tablename = 'chat_message_embeddings'
  AND indexname = 'idx_chat_embeddings_vector';
```

### Re-embed messages

```typescript
await deleteSessionEmbeddings(sessionId);
await autoEmbedOldMessages(sessionId);
```

---

## 📚 References

- [Supabase pgvector Guide](https://supabase.com/docs/guides/ai/vector-columns)
- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
- [HNSW Index](https://github.com/pgvector/pgvector#hnsw)
