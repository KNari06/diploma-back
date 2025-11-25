# Real-Time Graph Visualization - Technical Summary

## ✅ Что реализовано

### 1. **GraphBuilder Service** (`src/agent/utils/graph-builder.service.ts`)
- Инкрементальное построение графа
- Методы: `addStartNode()`, `addActionNode()`, `addPageNode()`, `addEndNode()`
- Автоматическое определение цветов, иконок, типов узлов
- Tracking: totalSteps, completedSteps, failedSteps

### 2. **WebSocket Event**: `test:graph-update`
- Payload: `TestGraphUpdatePayload`
- Типы: `'full'` (начало/конец) | `'incremental'` (каждое действие)
- Структура: `{ newNode, newEdge, fullGraph }`

### 3. **Integration в Orchestrator**
- Автоматически создает граф во время теста
- Отправляет обновления через Redis → WebSocket
- Поддерживает worker → main process коммуникацию

### 4. **Redis Pub/Sub Support**
- События маршрутизируются через Redis
- Работает из worker процессов
- Fallback на прямой WebSocket если Redis недоступен

---

## 🔄 Flow Diagram

```
TEST START
   ↓
[GraphBuilder.addStartNode()]
   ↓
WS: test:graph-update { type: 'full', fullGraph: { nodes: [start], edges: [] } }
   ↓
[Analyze Page] → [GraphBuilder.addPageNode()]
   ↓
WS: test:graph-update { type: 'incremental', newNode: goto, newEdge: start→goto }
   ↓
[Execute Action 1] → [GraphBuilder.addActionNode()]
   ↓
WS: test:graph-update { type: 'incremental', newNode: click, newEdge: goto→click }
   ↓
[Execute Action 2] → [GraphBuilder.addActionNode()]
   ↓
WS: test:graph-update { type: 'incremental', newNode: fill, newEdge: click→fill }
   ↓
[...more actions...]
   ↓
[GraphBuilder.addEndNode()]
   ↓
WS: test:graph-update { type: 'full', newNode: end, fullGraph: {...} }
   ↓
REST API: GET /api/v1/test-visualization/{testId} (финальный граф сохранен)
```

---

## 📦 Data Format

### Incremental Update (Each Action)
```json
{
  "testId": "abc-123",
  "type": "incremental",
  "data": {
    "newNode": {
      "id": "node_3",
      "type": "action",
      "stepType": "click",
      "label": "Click Login Button",
      "selector": "button.login",
      "meta": {
        "icon": "👆",
        "color": "#03A9F4",
        "success": true,
        "durationMs": 340,
        "elapsedTime": 3200
      }
    },
    "newEdge": {
      "id": "edge_2",
      "source": "node_2",
      "target": "node_3",
      "type": "normal"
    }
  },
  "timestamp": "2025-11-25T10:30:03.200Z"
}
```

### Full Update (Start/End)
```json
{
  "testId": "abc-123",
  "type": "full",
  "data": {
    "fullGraph": {
      "nodes": [
        { "id": "node_1", "type": "start", "label": "Test Started", ... },
        { "id": "node_2", "type": "action", "stepType": "goto", ... },
        { "id": "node_3", "type": "action", "stepType": "click", ... },
        { "id": "node_10", "type": "end", "label": "Test Completed ✅", ... }
      ],
      "edges": [
        { "id": "edge_1", "source": "node_1", "target": "node_2", ... },
        { "id": "edge_2", "source": "node_2", "target": "node_3", ... }
      ],
      "metadata": {
        "totalSteps": 8,
        "completedSteps": 7,
        "failedSteps": 1
      }
    }
  },
  "timestamp": "2025-11-25T10:30:15.000Z"
}
```

---

## 🎨 Node Colors

| Condition                    | Color     | Meaning          |
|------------------------------|-----------|------------------|
| `type: 'start'`              | `#4CAF50` | Green (success)  |
| `type: 'end'` + `success: true` | `#4CAF50` | Green (success)  |
| `type: 'end'` + `success: false` | `#F44336` | Red (failed)     |
| `stepType: 'goto'`           | `#673AB7` | Purple (nav)     |
| `stepType: 'assert*'`        | `#4CAF50` | Green (check)    |
| `stepType: 'wait*'`          | `#9E9E9E` | Gray (wait)      |
| `meta.success: false`        | `#F44336` | Red (error)      |
| Default action               | `#03A9F4` | Blue (action)    |

---

## 📊 Frontend Integration Checklist

### Step 1: WebSocket Connection
```typescript
import { io } from 'socket.io-client';

const socket = io(API_URL, {
  auth: { token: userToken }
});

socket.on('connect', () => {
  console.log('✅ Connected to WebSocket');
});
```

### Step 2: Subscribe to Graph Updates
```typescript
socket.on('test:graph-update', (payload) => {
  console.log('📊 Graph update:', payload);

  if (payload.type === 'full') {
    // Replace entire graph
    setGraph(payload.data.fullGraph);
  } else {
    // Add new node incrementally
    addNode(payload.data.newNode);
    addEdge(payload.data.newEdge);
  }
});
```

### Step 3: Visualize with React Flow
```typescript
import ReactFlow from 'reactflow';

<ReactFlow
  nodes={nodes}
  edges={edges}
  fitView
  onNodeClick={node => showDetails(node)}
/>
```

### Step 4: Fallback to REST API
```typescript
// When test completes or WebSocket fails
const response = await fetch(`/api/v1/test-visualization/${testId}`);
const finalGraph = await response.json();
```

---

## 🚀 Performance

- **Incremental update size**: ~200-500 bytes
- **Full graph size**: ~2-5 KB (for 10-20 actions)
- **Update frequency**: 1-3 updates/second during execution
- **Total bandwidth**: ~10-20 KB per test

---

## 🔧 Configuration

No configuration needed! Works out of the box for all intelligent tests.

Graph streaming is automatically enabled when:
- Test is run in intelligent mode
- `testId` and `userId` are available
- WebSocket is initialized

---

## 📝 Example Log Output

```
[GRAPH_BUILDER] Start node added { nodeId: 'node_1' }
[GRAPH_BUILDER] Page node added { nodeId: 'node_2', url: 'https://example.com' }
[GRAPH_BUILDER] Action node added { nodeId: 'node_3', action: 'click', success: true, totalNodes: 3 }
[GRAPH_BUILDER] Action node added { nodeId: 'node_4', action: 'fill', success: true, totalNodes: 4 }
[GRAPH_BUILDER] End node added { nodeId: 'node_5', success: true, totalNodes: 5, totalEdges: 4 }
```

---

## ✅ Testing

### Verify WebSocket Events
```typescript
// In browser console
socket.on('test:graph-update', (data) => {
  console.log('📊 Graph update received:', {
    type: data.type,
    nodeId: data.data.newNode?.id,
    edgeId: data.data.newEdge?.id,
    totalNodes: data.data.fullGraph?.nodes.length
  });
});
```

### Verify REST API
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/v1/test-visualization/{testId}
```

---

## 🎯 Benefits

1. **Real-Time**: User sees test building live
2. **Interactive**: Can click on nodes to see details
3. **Debuggable**: Identify failures immediately
4. **Reliable**: REST API fallback if WebSocket fails
5. **Performant**: Incremental updates (not full graph each time)

---

## 📚 See Also

- [WebSocket API Documentation](../development/websocket-progress-implementation-plan.md)
- [Test Visualization Controller](../../src/api/testVisualization/testVisualization.controller.ts)
- [Playwright Parser](../../src/utils/playwrightParser.ts)
