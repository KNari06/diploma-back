# 👍👎 Message Feedback API - Usage Examples

## Overview

The Message Feedback API allows users to provide feedback (like/dislike) on AI chat responses. This data is used for:
- **RLHF** (Reinforcement Learning from Human Feedback)
- **Prompt Engineering** - Improving system prompts based on user preferences
- **Analytics** - Understanding which responses work best
- **Quality Monitoring** - Tracking AI satisfaction rates

---

## 🔗 Endpoints

Base URL: `/api/v1/chat/feedback`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/` | Submit feedback for a message |
| `GET` | `/:messageId` | Get feedback for a specific message |
| `DELETE` | `/:feedbackId` | Delete feedback |
| `GET` | `/analytics/user` | Get user's feedback statistics |
| `GET` | `/analytics/global` | Get global analytics (admin) |
| `GET` | `/analytics/timeseries` | Get time-series data for charts |
| `GET` | `/top/:type` | Get top liked/disliked messages (admin) |

---

## 📝 Examples

### 1. Submit Feedback (Like)

When user clicks "👍 Like" button on an AI message:

```typescript
const submitFeedback = async (messageId: string, feedbackType: 'like' | 'dislike') => {
  const response = await fetch('/api/v1/chat/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      message_id: messageId,
      feedback_type: feedbackType,
      intent_type: 'api_test', // optional: from chat context
      context: {
        response_time_ms: 1234,
        model: 'gpt-4o',
        user_agent: navigator.userAgent
      }
    })
  });

  const data = await response.json();
  console.log('Feedback saved:', data);
};

// Usage
submitFeedback('550e8400-e29b-41d4-a716-446655440000', 'like');
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "message_id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": "user123",
    "session_id": "session456",
    "feedback_type": "like",
    "intent_type": "api_test",
    "context": {
      "response_time_ms": 1234,
      "model": "gpt-4o"
    },
    "created_at": "2024-11-13T10:30:00Z"
  },
  "message": "Feedback saved successfully"
}
```

---

### 2. Check if Message Already Has Feedback

Before rendering like/dislike buttons, check if user already provided feedback:

```typescript
const checkExistingFeedback = async (messageId: string) => {
  const response = await fetch(`/api/v1/chat/feedback/${messageId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  const data = await response.json();

  if (data.data) {
    // User already provided feedback
    return data.data.feedback_type; // 'like' or 'dislike'
  }

  return null; // No feedback yet
};

// Usage in React
const [userFeedback, setUserFeedback] = useState<'like' | 'dislike' | null>(null);

useEffect(() => {
  checkExistingFeedback(messageId).then(setUserFeedback);
}, [messageId]);
```

---

### 3. Toggle Feedback (Change from Like to Dislike)

If user changes their mind:

```typescript
const toggleFeedback = async (messageId: string, newType: 'like' | 'dislike') => {
  // Same endpoint - it will UPDATE if feedback exists
  await submitFeedback(messageId, newType);
};

// UI Component Example (React)
const FeedbackButtons = ({ messageId }) => {
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null);

  const handleFeedback = async (type: 'like' | 'dislike') => {
    await submitFeedback(messageId, type);
    setFeedback(type);
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={() => handleFeedback('like')}
        className={feedback === 'like' ? 'active' : ''}
      >
        👍 {feedback === 'like' && '✓'}
      </button>
      <button
        onClick={() => handleFeedback('dislike')}
        className={feedback === 'dislike' ? 'active' : ''}
      >
        👎 {feedback === 'dislike' && '✓'}
      </button>
    </div>
  );
};
```

---

### 4. Get User Analytics

Display user's feedback statistics in their profile:

```typescript
const getUserStats = async (days: number = 30) => {
  const response = await fetch(`/api/v1/chat/feedback/analytics/user?days=${days}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  const data = await response.json();
  return data.data;
};

// Usage
const stats = await getUserStats(30);
console.log(`Satisfaction rate: ${stats.satisfaction_rate}%`);
console.log(`Total feedback: ${stats.total_feedback}`);
console.log(`Likes: ${stats.likes}, Dislikes: ${stats.dislikes}`);
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total_feedback": 45,
    "likes": 38,
    "dislikes": 7,
    "satisfaction_rate": 84.44,
    "by_intent": [
      {
        "intent_type": "api_test",
        "likes": 20,
        "dislikes": 3,
        "satisfaction_rate": 86.96,
        "total": 23
      },
      {
        "intent_type": "general_chat",
        "likes": 18,
        "dislikes": 4,
        "satisfaction_rate": 81.82,
        "total": 22
      }
    ],
    "recent_feedback": [...]
  }
}
```

---

### 5. Display Feedback Chart (Time Series)

For analytics dashboard:

```typescript
const getFeedbackTimeSeries = async (days: number = 30) => {
  const response = await fetch(
    `/api/v1/chat/feedback/analytics/timeseries?days=${days}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();
  return data.data;
};

// Usage with Chart.js or Recharts
const chartData = await getFeedbackTimeSeries(7);

// Format for chart library
const formatted = chartData.map(item => ({
  date: item.date,
  intent: item.intent_type,
  [item.feedback_type]: item.count
}));
```

---

### 6. Delete Feedback (Undo)

If user wants to remove their feedback:

```typescript
const deleteFeedback = async (feedbackId: string) => {
  const response = await fetch(`/api/v1/chat/feedback/${feedbackId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  const data = await response.json();
  return data.success;
};
```

---

### 7. Admin: Get Top Liked Messages (RLHF)

For AI improvement pipeline (admin only):

```typescript
const getTopLikedMessages = async (intentType?: string, limit: number = 50) => {
  const params = new URLSearchParams({
    limit: limit.toString(),
    ...(intentType && { intent: intentType })
  });

  const response = await fetch(
    `/api/v1/chat/feedback/top/like?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    }
  );

  const data = await response.json();
  return data.data;
};

// Usage
const topApiTestResponses = await getTopLikedMessages('api_test', 100);

// Use for fine-tuning or prompt improvement
topApiTestResponses.forEach(({ feedback, message }) => {
  console.log('User message:', message.content);
  console.log('AI response:', message.content);
  console.log('Feedback context:', feedback.context);
});
```

---

## 🎨 UI/UX Best Practices

### 1. **Subtle Buttons**
Don't make feedback buttons too prominent - users should focus on content first.

```tsx
<div className="flex items-center gap-2 text-gray-400 text-sm mt-2">
  <button className="hover:text-green-500 transition">
    👍 Helpful
  </button>
  <button className="hover:text-red-500 transition">
    👎 Not helpful
  </button>
</div>
```

### 2. **Confirmation Feedback**
Show visual confirmation when feedback is saved:

```tsx
const [showConfirmation, setShowConfirmation] = useState(false);

const handleLike = async () => {
  await submitFeedback(messageId, 'like');
  setShowConfirmation(true);
  setTimeout(() => setShowConfirmation(false), 2000);
};

return (
  <>
    <button onClick={handleLike}>👍</button>
    {showConfirmation && (
      <span className="text-green-500 text-xs">
        ✓ Thank you for your feedback!
      </span>
    )}
  </>
);
```

### 3. **Only Show for AI Messages**
Don't show feedback buttons on user messages:

```tsx
{message.role === 'ai' && (
  <FeedbackButtons messageId={message.id} />
)}
```

---

## 📊 Integration with Analytics

### Track in Mixpanel/PostHog

```typescript
const submitFeedbackWithTracking = async (
  messageId: string,
  feedbackType: 'like' | 'dislike'
) => {
  await submitFeedback(messageId, feedbackType);

  // Track event
  analytics.track('AI Feedback Submitted', {
    message_id: messageId,
    feedback_type: feedbackType,
    intent_type: currentIntent,
    session_id: sessionId
  });
};
```

---

## 🔐 Error Handling

```typescript
const submitFeedbackSafely = async (messageId: string, type: 'like' | 'dislike') => {
  try {
    const response = await fetch('/api/v1/chat/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        message_id: messageId,
        feedback_type: type
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to submit feedback:', error);
    // Show toast notification
    toast.error('Failed to save feedback. Please try again.');
    return null;
  }
};
```

---

## 📖 See Also

- [Chat API Documentation](./README.md)
- [Websocket Events](../websocket-api.md)
- [Authentication](../setup/authentication.md)

---

**Last updated:** 2024-11-13
