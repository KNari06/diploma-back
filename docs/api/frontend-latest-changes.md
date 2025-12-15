# Frontend: Latest Changes

## 🆕 New Features

### 1. Multi-Chat Sessions
Support for multiple isolated chat conversations.

**New Endpoints:**
- `POST /api/v1/chat/sessions/new` - Create new session
- `GET /api/v1/chat/sessions/list?limit=50&offset=0` - List sessions
- `GET /api/v1/chat/sessions/:sessionId` - Get session with messages
- `PATCH /api/v1/chat/sessions/:sessionId` - Update title (`{title: string}`)
- `DELETE /api/v1/chat/sessions/:sessionId` - Delete session

**Updated:**
- `POST /api/v1/chat` - Add optional `sessionId` in body

**Response:**
```typescript
interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message?: {
    role: 'user' | 'ai';
    content: string;
    created_at: string;
  };
}
```

### 2. Real-Time Graph Updates
WebSocket event for live test graph during execution.

**Event:** `test:graph-update`

**Payload:**
```typescript
{
  testId: string;
  type: 'full' | 'incremental';
  data: {
    newNode?: {
      id: string;
      type: 'start' | 'end' | 'action' | 'assertion' | 'condition' | 'loop' | 'merge';
      label: string;
      selector?: string;
      meta?: {
        icon?: string;
        color?: string;
        success?: boolean;
        durationMs?: number;
      };
    };
    newEdge?: {
      id: string;
      source: string;
      target: string;
      type: 'normal' | 'branch' | 'loop';
    };
    fullGraph?: {
      nodes: GraphNode[];
      edges: GraphEdge[];
      metadata: { totalSteps: number; completedSteps: number; failedSteps: number; };
    };
  };
  timestamp: string;
}
```

**Usage:**
```typescript
socket.on('test:graph-update', (payload) => {
  if (payload.type === 'full') {
    setGraph(payload.data.fullGraph);
  } else {
    if (payload.data.newNode) addNode(payload.data.newNode);
    if (payload.data.newEdge) addEdge(payload.data.newEdge);
  }
});
```

### 3. Test Clarification Request
WebSocket event when test needs user input.

**Event:** `test:clarification:request`

**Payload:**
```typescript
{
  testId: string;
  question: string;
  options?: string[];
  userId: string;
  timestamp: string;
}
```

### 4. Test Visualization API
Get complete test graph after execution.

**Endpoint:** `GET /api/v1/test-visualization/:testId?format=json`

**Response:**
```typescript
{
  success: true;
  data: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    metadata: {
      totalSteps: number;
      testId: string;
      testStatus: string;
      executedAt: string;
    };
  };
}
```

## ✅ Checklist

- [ ] Add `sessionId` to chat requests
- [ ] Implement multi-chat UI (sessions list)
- [ ] Subscribe to `test:graph-update` WebSocket
- [ ] Handle incremental graph updates
- [ ] Handle `test:clarification:request` event
- [ ] Integrate test visualization API
