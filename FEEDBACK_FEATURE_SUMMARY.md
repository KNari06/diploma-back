# 👍👎 Message Feedback Feature - Implementation Summary

## ✅ Completed

Реализована полная система для сбора фидбека пользователей на ответы AI агента.

### 📋 Созданные компоненты:

1. **Database Migration** - `supabase-migrations/features/message-feedback.sql`
   - Таблица `message_feedback`
   - Индексы для производительности
   - RLS политики безопасности
   - View `feedback_analytics` для аналитики

2. **TypeScript Types** - `src/types/index.ts`
   - `MessageFeedback`, `FeedbackType`
   - `CreateFeedbackRequest`, `FeedbackStatistics`
   - `FeedbackAnalytics`, `FeedbackContext`

3. **Service Layer** - `src/services/feedback.service.ts`
   - `createFeedback()` - создание/обновление фидбека
   - `getFeedbackForMessage()` - получение фидбека для сообщения
   - `getUserFeedbackStats()` - статистика пользователя
   - `getGlobalFeedbackStats()` - глобальная статистика (admin)
   - `getTopFeedbackMessages()` - топ сообщений для RLHF

4. **API Endpoints** - `src/api/chat/feedback.*`
   - `POST /api/v1/chat/feedback` - отправить фидбек
   - `GET /api/v1/chat/feedback/:messageId` - получить фидбек
   - `DELETE /api/v1/chat/feedback/:feedbackId` - удалить фидбек
   - `GET /api/v1/chat/feedback/analytics/user` - аналитика пользователя
   - `GET /api/v1/chat/feedback/analytics/global` - глобальная аналитика
   - `GET /api/v1/chat/feedback/analytics/timeseries` - данные для графиков
   - `GET /api/v1/chat/feedback/top/:type` - топ сообщений

5. **Documentation**
   - `docs/api/feedback-api-examples.md` - подробные примеры использования
   - Обновлен `docs/README.md`
   - Обновлен `supabase-migrations/features/README.md`

---

## 🚀 Deployment Instructions

### 1. Apply Database Migration

```bash
# Connect to Supabase SQL Editor or use psql
psql $DATABASE_URL

# Apply migration
\i supabase-migrations/features/message-feedback.sql
```

Или через Supabase Dashboard:
1. Open SQL Editor
2. Copy contents of `message-feedback.sql`
3. Execute

### 2. Build & Deploy Backend

```bash
# Build TypeScript
npm run build

# Run tests (if any)
npm test

# Start production server
npm start
```

### 3. Verify API Endpoints

```bash
# Health check
curl http://localhost:3000/health

# Check Swagger docs
open http://localhost:3000/api/docs
# Look for "Feedback" tag in API documentation
```

---

## 🧪 Testing

### Manual Testing Steps:

1. **Create Feedback**
```bash
curl -X POST http://localhost:3000/api/v1/chat/feedback \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "message_id": "MESSAGE_UUID",
    "feedback_type": "like",
    "intent_type": "api_test"
  }'
```

2. **Get Feedback**
```bash
curl http://localhost:3000/api/v1/chat/feedback/MESSAGE_UUID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

3. **Get Analytics**
```bash
curl http://localhost:3000/api/v1/chat/feedback/analytics/user?days=30 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Database Verification:

```sql
-- Check if table exists
SELECT * FROM message_feedback LIMIT 5;

-- Check view
SELECT * FROM feedback_analytics LIMIT 10;

-- Verify RLS policies
SELECT * FROM pg_policies WHERE tablename = 'message_feedback';
```

---

## 📊 How to Use the Data

### Phase 1: Analytics (Ready Now)
```typescript
// Get satisfaction rate by intent type
const stats = await FeedbackService.getUserFeedbackStats(userId, 30);

console.log('API Test satisfaction:',
  stats.by_intent.find(i => i.intent_type === 'api_test')?.satisfaction_rate
);
```

### Phase 2: Prompt Engineering (Next Week)
```typescript
// Find patterns in disliked messages
const disliked = await FeedbackService.getTopFeedbackMessages('dislike', 'api_test', 50);

// Analyze common issues
const issues = analyzeDislikedMessages(disliked);

// Update system prompt to address issues
updateSystemPrompt(issues);
```

### Phase 3: RLHF / Fine-tuning (Next Month)
```typescript
// Export dataset for OpenAI fine-tuning
const liked = await FeedbackService.getTopFeedbackMessages('like', null, 1000);

// Format as JSONL for fine-tuning API
const dataset = formatForFineTuning(liked);

// Upload to OpenAI
await openai.files.create({
  file: dataset,
  purpose: 'fine-tune'
});
```

---

## 🎨 Frontend Integration

### React Component Example:

```tsx
import { useState, useEffect } from 'react';

function MessageFeedback({ messageId }) {
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Load existing feedback
    fetch(`/api/v1/chat/feedback/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => setFeedback(data.data?.feedback_type));
  }, [messageId]);

  const handleFeedback = async (type: 'like' | 'dislike') => {
    setLoading(true);
    await fetch('/api/v1/chat/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        message_id: messageId,
        feedback_type: type
      })
    });
    setFeedback(type);
    setLoading(false);
  };

  return (
    <div className="flex gap-2 mt-2">
      <button
        onClick={() => handleFeedback('like')}
        disabled={loading}
        className={feedback === 'like' ? 'text-green-500' : 'text-gray-400'}
      >
        👍 {feedback === 'like' && '✓'}
      </button>
      <button
        onClick={() => handleFeedback('dislike')}
        disabled={loading}
        className={feedback === 'dislike' ? 'text-red-500' : 'text-gray-400'}
      >
        👎 {feedback === 'dislike' && '✓'}
      </button>
    </div>
  );
}
```

---

## 📈 Success Metrics

После внедрения отслеживайте:

1. **Feedback Rate** - сколько % пользователей оставляют фидбек
   - Цель: 10-15% от всех сообщений

2. **Satisfaction Rate** - % like от всего фидбека
   - Цель: >80% для API tests
   - Цель: >70% для general chat

3. **Improvement Over Time** - растет ли satisfaction rate
   - После улучшения промптов

4. **Coverage by Intent** - есть ли фидбек по всем типам интентов
   - api_test, general_chat, ui_test и т.д.

---

## 🔧 Troubleshooting

### Issue: RLS policies blocking access
```sql
-- Check if user is authenticated
SELECT auth.uid();

-- Temporarily disable RLS for testing (dev only!)
ALTER TABLE message_feedback DISABLE ROW LEVEL SECURITY;
```

### Issue: Foreign key violations
```sql
-- Check if referenced message exists
SELECT id, session_id FROM chat_messages WHERE id = 'MESSAGE_UUID';

-- Check if user exists
SELECT id FROM users WHERE id = auth.uid();
```

### Issue: Duplicate feedback error
```sql
-- Check existing feedback
SELECT * FROM message_feedback
WHERE message_id = 'MESSAGE_UUID' AND user_id = auth.uid();

-- Delete duplicate (if needed)
DELETE FROM message_feedback WHERE id = 'FEEDBACK_UUID';
```

---

## 📝 Next Steps

1. ✅ **Deploy to staging** - test with real users
2. ⏳ **Collect 100+ feedback samples** - minimum for pattern analysis
3. ⏳ **Analyze disliked messages** - find common issues
4. ⏳ **Update prompts** - address issues from step 3
5. ⏳ **Measure improvement** - compare satisfaction rates before/after
6. ⏳ **Consider fine-tuning** - if budget allows (~$8 per 1K examples)

---

## 🙏 Credits

Implemented with attention to:
- Security (RLS policies)
- Performance (proper indexes)
- Type safety (TypeScript)
- Documentation (Swagger + examples)
- Best practices (service layer, error handling)

---

**Created:** 2024-11-13
**Status:** ✅ Ready for deployment
