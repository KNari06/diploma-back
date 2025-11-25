# Real-Time Test Graph Visualization

## Overview

Система потоковой визуализации тестовых действий в режиме реального времени через WebSocket + финальное сохранение через REST API.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ WORKER PROCESS (Playwright Test Execution)                  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  IntelligentTestOrchestrator                                │
│         │                                                    │
│         ├─> GraphBuilder.addStartNode()                     │
│         │   → WS: test:graph-update (type='full')           │
│         │   → Payload: { fullGraph: { nodes: [start], ... }}│
│         │                                                    │
│         ├─> GraphBuilder.addActionNode(action, result)      │
│         │   → WS: test:graph-update (type='incremental')    │
│         │   → Payload: { newNode: {...}, newEdge: {...} }   │
│         │                                                    │
│         └─> GraphBuilder.addEndNode(success, summary)       │
│             → WS: test:graph-update (type='full')           │
│             → Payload: { fullGraph: { nodes: [...], ... } } │
│                                                              │
└──────────────────────────────────────────────────────────────┘
         │
         │ Redis Pub/Sub
         ↓
┌──────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (WebSocket Server)                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  WebSocketService.emitTestGraphUpdate()                     │
│         │                                                    │
│         └─> Socket.IO → Client                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
         │
         ↓
┌──────────────────────────────────────────────────────────────┐
│ CLIENT (Frontend)                                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  socket.on('test:graph-update', (data) => {                 │
│    if (data.type === 'full') {                              │
│      setGraph(data.fullGraph);                              │
│    } else {                                                  │
│      addNode(data.newNode);                                 │
│      addEdge(data.newEdge);                                 │
│    }                                                         │
│  });                                                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## WebSocket Event

### Event Name
```
test:graph-update
```

### Payload Structure

```typescript
interface TestGraphUpdatePayload {
  testId: string;
  type: 'full' | 'incremental';
  data: {
    // For incremental updates
    newNode?: {
      id: string;                    // "node_1", "node_2", etc.
      type: string;                  // "start" | "end" | "action" | "assertion"
      stepType?: string;             // "goto" | "click" | "fill" | etc.
      label: string;                 // "Navigate to https://example.com"
      selector?: string;             // "button.login"
      value?: any;                   // "test@example.com"
      meta?: {
        icon?: string;               // "🌐" | "👆" | "✏️"
        color?: string;              // "#673AB7" | "#03A9F4" | "#F44336"
        success?: boolean;           // true | false
        durationMs?: number;         // 1234
        errorMessage?: string;       // "Selector not found"
        urlChanged?: boolean;        // true | false
        urlBefore?: string;          // "https://example.com"
        urlAfter?: string;           // "https://example.com/login"
        timestamp?: number;          // 1732534567890
        elapsedTime?: number;        // 5000 (ms from test start)
      };
    };
    newEdge?: {
      id: string;                    // "edge_1", "edge_2", etc.
      source: string;                // "node_1"
      target: string;                // "node_2"
      type: string;                  // "normal" | "branch" | "loop"
      label?: string;                // "true" | "false" | "repeat"
      meta?: {
        color?: string;              // "#4CAF50"
        style?: string;              // "solid" | "dashed" | "dotted"
        animated?: boolean;          // true | false
      };
    };
    updatedNode?: {
      id: string;
      meta?: Record<string, any>;
    };

    // For full graph updates
    fullGraph?: {
      nodes: GraphNode[];
      edges: GraphEdge[];
      metadata: {
        totalSteps: number;
        completedSteps: number;
        failedSteps: number;
      };
    };
  };
  timestamp: string;
}
```

---

## Event Flow

### 1. Test Started
```json
{
  "testId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "full",
  "data": {
    "fullGraph": {
      "nodes": [
        {
          "id": "node_1",
          "type": "start",
          "label": "Test Started",
          "meta": {
            "color": "#4CAF50",
            "icon": "▶️",
            "timestamp": 1732534567890
          }
        }
      ],
      "edges": [],
      "metadata": {
        "totalSteps": 0,
        "completedSteps": 0,
        "failedSteps": 0
      }
    }
  },
  "timestamp": "2025-11-25T10:30:00.000Z"
}
```

### 2. Action Executed (Incremental)
```json
{
  "testId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "incremental",
  "data": {
    "newNode": {
      "id": "node_2",
      "type": "action",
      "stepType": "goto",
      "label": "Navigate to https://example.com",
      "value": "https://example.com",
      "meta": {
        "icon": "🌐",
        "color": "#673AB7",
        "success": true,
        "durationMs": 1234,
        "elapsedTime": 2000
      }
    },
    "newEdge": {
      "id": "edge_1",
      "source": "node_1",
      "target": "node_2",
      "type": "normal"
    }
  },
  "timestamp": "2025-11-25T10:30:02.000Z"
}
```

### 3. Action Failed (Incremental)
```json
{
  "testId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "incremental",
  "data": {
    "newNode": {
      "id": "node_3",
      "type": "action",
      "stepType": "click",
      "label": "Click Login Button",
      "selector": "button.login-missing",
      "meta": {
        "icon": "👆",
        "color": "#F44336",  // ❌ Red for failed
        "success": false,
        "errorMessage": "Selector not found: button.login-missing",
        "elapsedTime": 3000
      }
    },
    "newEdge": {
      "id": "edge_2",
      "source": "node_2",
      "target": "node_3",
      "type": "normal"
    }
  },
  "timestamp": "2025-11-25T10:30:03.000Z"
}
```

### 4. Test Completed (Full Graph)
```json
{
  "testId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "full",
  "data": {
    "newNode": {
      "id": "node_10",
      "type": "end",
      "label": "Test Completed ✅",
      "meta": {
        "color": "#4CAF50",
        "icon": "✅",
        "success": true,
        "totalDuration": 15000
      }
    },
    "newEdge": {
      "id": "edge_9",
      "source": "node_9",
      "target": "node_10",
      "type": "normal"
    },
    "fullGraph": {
      "nodes": [ /* all nodes */ ],
      "edges": [ /* all edges */ ],
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

## Frontend Integration

### WebSocket Subscription

```typescript
import { io } from 'socket.io-client';

const socket = io('https://api.example.com', {
  auth: {
    token: 'your-auth-token'
  }
});

// Subscribe to graph updates
socket.on('test:graph-update', (payload) => {
  console.log('Graph update received:', payload);

  if (payload.type === 'full') {
    // Initial graph or final graph
    setGraph(payload.data.fullGraph);
  } else if (payload.type === 'incremental') {
    // Add new node and edge
    if (payload.data.newNode) {
      addNode(payload.data.newNode);
    }
    if (payload.data.newEdge) {
      addEdge(payload.data.newEdge);
    }
  }
});
```

### State Management (Example with React)

```typescript
import { useState, useEffect } from 'react';

interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
  };
}

function useTestGraph(testId: string) {
  const [graph, setGraph] = useState<GraphState>({
    nodes: [],
    edges: [],
    metadata: { totalSteps: 0, completedSteps: 0, failedSteps: 0 }
  });

  useEffect(() => {
    const handleGraphUpdate = (payload: TestGraphUpdatePayload) => {
      if (payload.testId !== testId) return;

      if (payload.type === 'full' && payload.data.fullGraph) {
        // Replace entire graph
        setGraph(payload.data.fullGraph);
      } else if (payload.type === 'incremental') {
        // Add new node and edge
        setGraph(prev => ({
          nodes: payload.data.newNode
            ? [...prev.nodes, payload.data.newNode]
            : prev.nodes,
          edges: payload.data.newEdge
            ? [...prev.edges, payload.data.newEdge]
            : prev.edges,
          metadata: {
            totalSteps: prev.metadata.totalSteps + 1,
            completedSteps: payload.data.newNode?.meta?.success === true
              ? prev.metadata.completedSteps + 1
              : prev.metadata.completedSteps,
            failedSteps: payload.data.newNode?.meta?.success === false
              ? prev.metadata.failedSteps + 1
              : prev.metadata.failedSteps,
          }
        }));
      }
    };

    socket.on('test:graph-update', handleGraphUpdate);

    return () => {
      socket.off('test:graph-update', handleGraphUpdate);
    };
  }, [testId]);

  return graph;
}
```

### Visualization with React Flow

```typescript
import ReactFlow, { Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';

function TestGraphVisualization({ testId }: { testId: string }) {
  const graph = useTestGraph(testId);

  // Convert to React Flow format
  const nodes: Node[] = graph.nodes.map(node => ({
    id: node.id,
    type: node.type,
    position: node.meta?.position || { x: 0, y: 0 },
    data: {
      label: node.label,
      icon: node.meta?.icon,
      selector: node.selector,
      success: node.meta?.success,
      errorMessage: node.meta?.errorMessage,
    },
    style: {
      backgroundColor: node.meta?.color,
      borderColor: node.meta?.success === false ? '#F44336' : '#4CAF50',
      borderWidth: 2,
    },
  }));

  const edges: Edge[] = graph.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.meta?.animated,
    label: edge.label,
    style: {
      stroke: edge.meta?.color,
    },
  }));

  return (
    <div style={{ width: '100%', height: '600px' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        attributionPosition="bottom-right"
      />
    </div>
  );
}
```

---

## REST API (Final Graph)

### Endpoint
```
GET /api/v1/test-visualization/{testId}?format=json
```

### Response
```json
{
  "success": true,
  "data": {
    "nodes": [ /* all nodes */ ],
    "edges": [ /* all edges */ ],
    "metadata": {
      "totalSteps": 10,
      "conditionalBranches": 0,
      "loops": 0,
      "assertions": 2,
      "testId": "550e8400-e29b-41d4-a716-446655440000",
      "testUrl": "https://example.com",
      "testStatus": "completed",
      "executedAt": "2025-11-25T10:30:15.000Z"
    }
  },
  "timestamp": "2025-11-25T10:30:15.000Z"
}
```

---

## Node Types & Colors

| Type      | Color    | Icon | Description                    |
|-----------|----------|------|--------------------------------|
| start     | #4CAF50  | ▶️   | Test started                   |
| end       | #4CAF50  | ✅   | Test completed (success)       |
| end       | #F44336  | ❌   | Test failed                    |
| action    | #03A9F4  | ⚡   | Generic action                 |
| action    | #673AB7  | 🌐   | Navigation (goto)              |
| action    | #F44336  | 👆   | Failed click                   |
| assertion | #4CAF50  | ✅   | Successful assertion           |

### Action Icons

| Action Type      | Icon |
|------------------|------|
| goto             | 🌐   |
| click            | 👆   |
| fill             | ✏️   |
| type             | ⌨️   |
| hover            | 👋   |
| check            | ☑️   |
| select           | 📋   |
| wait             | ⏱️   |
| scroll           | 📜   |
| screenshot       | 📸   |
| assert           | ✅   |
| assertVisible    | 👁️   |

---

## Timeline Example

Real-time streaming during test execution:

```
Time: 0s
┌──────────────┐
│ ▶️ Start    │
└──────────────┘

Time: 2s
┌──────────────┐
│ ▶️ Start    │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 🌐 Navigate  │  ✅ Success (1.2s)
└──────────────┘

Time: 3s
┌──────────────┐
│ ▶️ Start    │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 🌐 Navigate  │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 👆 Click     │  ✅ Success (0.3s)
└──────────────┘

Time: 5s
┌──────────────┐
│ ▶️ Start    │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 🌐 Navigate  │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 👆 Click     │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ ✏️ Fill      │  ❌ Failed (timeout)
└──────────────┘

Time: 15s (Test Completed)
┌──────────────┐
│ ▶️ Start    │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 🌐 Navigate  │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ 👆 Click     │
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ ✏️ Fill      │  ❌
└──────┬───────┘
       │
       ↓
┌──────────────┐
│ ✅ End       │  Total: 15s
└──────────────┘
```

---

## Benefits

✅ **Real-Time Feedback**: User sees test progress as it happens
✅ **Debugging**: Can identify where test failed immediately
✅ **Performance**: Incremental updates (not full graph every time)
✅ **Reliability**: Final graph available via REST API if WebSocket fails
✅ **Visualization Ready**: Format compatible with React Flow, D3.js, Cytoscape

---

## Example: Full Integration

```typescript
import { useEffect, useState } from 'react';
import ReactFlow from 'reactflow';
import { io } from 'socket.io-client';

function IntelligentTestVisualization({ testId }: { testId: string }) {
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [isLive, setIsLive] = useState(true);

  useEffect(() => {
    const socket = io(API_URL, { auth: { token } });

    // Real-time updates
    socket.on('test:graph-update', (payload) => {
      if (payload.testId !== testId) return;

      if (payload.type === 'full') {
        setGraph(payload.data.fullGraph);
        if (payload.data.newNode?.type === 'end') {
          setIsLive(false); // Test completed
        }
      } else {
        setGraph(prev => ({
          nodes: payload.data.newNode ? [...prev.nodes, payload.data.newNode] : prev.nodes,
          edges: payload.data.newEdge ? [...prev.edges, payload.data.newEdge] : prev.edges,
        }));
      }
    });

    // Fallback: Load from REST API if WebSocket disconnects
    socket.on('disconnect', async () => {
      const response = await fetch(`/api/v1/test-visualization/${testId}`);
      const data = await response.json();
      setGraph(data.data);
      setIsLive(false);
    });

    return () => {
      socket.off('test:graph-update');
      socket.disconnect();
    };
  }, [testId]);

  return (
    <div>
      {isLive && <div className="badge">🔴 Live</div>}
      <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView />
    </div>
  );
}
```

---

## Testing

### Backend Test
```bash
# Start server
npm run dev

# Run intelligent test and monitor logs
# Look for: [GRAPH_BUILDER] entries in logs
```

### Frontend Test
```typescript
// In browser console
socket.on('test:graph-update', console.log);

// Trigger test from UI
// You should see graph updates streaming in real-time
```

---

## Performance

- **Incremental updates**: ~200 bytes per action
- **Full graph**: ~2-5KB for 10-20 actions
- **Frequency**: 1 update per action (~1-3 updates/second during execution)
- **Total data**: ~10-20KB for typical test with 20 actions

---

## Troubleshooting

### No graph updates received
- Check WebSocket connection: `socket.connected`
- Check user is subscribed to correct room: `user:{userId}`
- Check Redis Pub/Sub is working (worker → main process)
- Check logs for `[GRAPH_BUILDER]` entries

### Graph not rendering
- Verify `nodes` and `edges` arrays are not empty
- Check node positions are calculated (or use `fitView` in React Flow)
- Verify all `source` and `target` IDs in edges exist in nodes

### Incremental updates not applying
- Check `newNode.id` is unique
- Check `newEdge.source` and `newEdge.target` exist
- Verify state update logic is immutable (spread operators)

---

## Future Enhancements

1. **Conditional branches**: Support if/else visualization
2. **Loops**: Support for repeated actions
3. **Parallel actions**: Multiple browsers simultaneously
4. **Annotations**: User comments on specific nodes
5. **Playback**: Replay test execution with timestamps
