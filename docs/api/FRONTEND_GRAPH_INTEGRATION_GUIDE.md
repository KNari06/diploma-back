# Frontend: Real-Time Test Graph Visualization Guide

## 📋 Overview

This guide explains how to integrate real-time test visualization in your frontend. The system provides **two ways** to get test execution graph:

1. **WebSocket (Real-Time)** - Stream graph updates as test runs
2. **REST API (Final)** - Get complete graph after test finishes

---

## 🔌 WebSocket Integration

### Step 1: Connect

**Endpoint:**

```
wss://your-api-domain.com
```

**Authentication:**

- Add Bearer JWT token to connection handshake
- Token from login response

**Connection:**

```
Protocol: Socket.IO v4
Auto-reconnect: Yes
```

---

### Step 2: Listen for Graph Updates

**Event Name:**

```
test:graph-update
```

**When You Receive:**

- Test starts → Full graph with START node
- Each action → Incremental update (new node + edge)
- Test ends → Full graph with END node + metadata

**Frequency:** 1-3 updates per second during execution

---

### Step 3: Handle Updates

#### Type A: `incremental` (Most Common)

**When:** Every action during test execution

**What You Get:**

- `newNode` - One new action node
- `newEdge` - Connection from previous to new node

**What To Do:**

- Add newNode to graph state
- Add newEdge to connect nodes
- Update counters (totalSteps++)
- Trigger graph re-render

#### Type B: `full` (Start & End)

**When:** Test starts or completes

**What You Get:**

- `fullGraph.nodes` - All nodes array
- `fullGraph.edges` - All edges array
- `fullGraph.metadata` - Statistics

**What To Do:**

- Replace entire graph state
- Show final statistics

---

## 📊 Node Structure

### Node Properties

**Always Present:**

```
id          : "node_1", "node_2", etc.
type        : "start" | "end" | "action" | "assertion"
label       : "Click Login Button"
```

**Sometimes Present:**

```
stepType    : "goto" | "click" | "fill" | "wait"
selector    : "button.login"
value       : "test@example.com"
```

**Metadata:**

```
meta.icon         : "🌐", "👆", "✏️"
meta.color        : "#03A9F4", "#F44336", etc.
meta.success      : true | false
meta.durationMs   : 340
meta.errorMessage : "Selector not found"
meta.timestamp    : 1732534567890
meta.elapsedTime  : 5000
```

**Problem Indicators:**

```
meta.retryCount   : 2 (if retried)
meta.isTimeout    : true (if timeout)
meta.isRepeated   : true (if repeated action)
meta.warning      : "Action repeated - possible cycle"
```

**URL Tracking:**

```
meta.urlChanged   : true | false
meta.urlBefore    : "https://example.com"
meta.urlAfter     : "https://example.com/login"
```

---

## 🎨 Visual Styling

### Node Colors

```
Green (#4CAF50)   → Start, End (success), Assertions
Blue (#03A9F4)    → Normal actions
Purple (#673AB7)  → Navigation (goto)
Yellow (#FFC107)  → Retry (succeeded after retry)
Orange (#FF9800)  → Warnings (repeated, timeout)
Red (#F44336)     → Failed, Critical patterns
Gray (#9E9E9E)    → Wait actions
```

### Node Labels

```
Normal:     "Click Login Button"
Repeated:   "⚠️ Click Login Button (repeated)"
Retry:      "🔄 Fill Email (retry 2)"
Timeout:    "Wait for element ⏱️ Timeout"
Failed:     "Click Submit ❌ Selector not found"
```

### Node Sizing

```
Start/End:  80x80 px
Actions:    60x60 px
Waits:      40x40 px
```

**Highlight:**

- Failed nodes: Red border (2px)
- Repeated nodes: Orange border (2px)
- Critical patterns: Pulsing animation

---

## 🔔 Warning System

### Pattern Warnings

**Event:** `test:progress` with `event: 'test_warning'`

**Warning Types:**

```
⚠️ repeated_action: Click Login repeated 3 times
⚠️ failed_chain: 5 consecutive actions failed
⚠️ stuck: Stuck on same page for 5 failed actions
⚠️ timeout_chain: 3 consecutive timeout errors
```

**UI:**

- Show toast notification
- Highlight affected nodes (orange border)
- Display warning count in header

### Test Stopped

**Event:** `test:progress` with `event: 'test_stopped'`

**Data:**

```
reason: "Repeated action 3x: click::button.login"
```

**UI:**

- Show error modal with reason
- Mark test as failed
- Show "View Details" button

---

## 🌐 REST API Endpoints

### Endpoint 1: Full Test Data

**Route:**

```
GET /api/v1/manual-test/{testId}/full
```

**Auth:** Bearer token required

**Returns:**

- Test info (URL, status, browsers, timestamps)
- All test results
- Generated Playwright code
- Intelligent session details
- Screenshots, videos, logs, errors
- Trace files

**When To Use:**

- "View Full Report" button
- WebSocket failed
- Test history

**Size:** 50-500 KB

---

### Endpoint 2: Test Visualization Graph

**Route:**

```
GET /api/v1/test-visualization/{testId}
```

**Query:**

```
?format=json&includeStartEnd=true&autoLayout=true
```

**Auth:** Bearer token required

**Returns:**

- Nodes array
- Edges array
- Metadata (totalSteps, completedSteps, failedSteps)

**When To Use:**

- WebSocket disconnected
- Historical view
- Export graph

**Size:** 5-20 KB

---

### Endpoint 3: User's Test List

**Route:**

```
GET /api/v1/manual-test?page=1&limit=20
```

**Auth:** Bearer token required

**Returns:**

- Paginated list of all user's tests
- Includes: manual, chat-initiated, intelligent, API tests

**Fields Per Test:**

```
id, url, status, browsers, intelligentMode, testGoal, createdAt, completedAt
```

**When To Use:**

- Test history
- Dashboard
- Search/filter

**Size:** 2-10 KB per page

---

## 📱 User Flow Example

### Scenario: User Starts Test from Chat

**1. User sends:** `"Test login on example.com"`

**2. Frontend receives:**

```
Event: chat:message
Data: {
  metadata: {
    testId: 'abc-123',
    is_test_runned: false  // Test is running
  }
}
```

**3. Frontend action:**

- Show "Test Running" badge
- Open graph panel
- Start listening for `test:graph-update`

**4. Real-time updates (every 1-3 seconds):**

```
WS Event: test:graph-update (type: incremental)
  → Add new node
  → Animate appearance
  → Update progress bar
```

**5. Test completes:**

```
WS Event: test:graph-update (type: full)
  → Replace graph with final version
  → Show statistics
  → Enable "View Full Report" button
```

**6. User clicks "View Full Report":**

```
GET /api/v1/manual-test/{testId}/full
  → Show comprehensive results
  → Display screenshots, videos, logs
  → Show generated code
```

---

## ⚡ Performance

**Use WebSocket for:**

- Active/running tests
- Real-time progress

**Use REST API for:**

- Completed tests
- WebSocket failures
- Exporting data

**Bandwidth:**

- WebSocket: ~10-20 KB per test
- REST API: ~5-20 KB per call

---

## 🚨 Error Handling

### WebSocket Disconnect

**What To Do:**

1. Show "Reconnecting..." indicator
2. Auto-reconnect (Socket.IO handles this)
3. If fails after 30s:
   → Poll REST API every 3 seconds
   → `GET /api/v1/test-visualization/{testId}`
4. When test completes:
   → Switch to final REST call

### Missing Graph Data

**Solution:**

```
GET /api/v1/test-visualization/{testId}
```

### Pattern Warnings

**Display:**

- Toast notification
- Highlight nodes (orange border)
- Show recommendation

**Example:**

```
"⚠️ repeated_action: Click Login repeated 3 times"
```

### Test Stopped

**Display:**

- Error modal with reason
- Mark test as failed
- Show actionable next steps

**Example:**

```
Title: "Test Stopped: Critical Pattern Detected"
Message: "Action 'click' on 'button.login' was repeated 3 times."
Action: "View Full Report" button
```

---

## 🎯 Implementation Checklist

### Phase 1: Basic WebSocket

- [ ] Connect with auth token
- [ ] Listen for `test:graph-update`
- [ ] Handle `incremental` updates
- [ ] Handle `full` updates

### Phase 2: Visual Rendering

- [ ] Render nodes with `meta.color`
- [ ] Show icons from `meta.icon`
- [ ] Display labels
- [ ] Connect nodes with edges
- [ ] Auto-layout graph

### Phase 3: Problem Detection

- [ ] Highlight repeated (`meta.isRepeated`)
- [ ] Show retry (`meta.retryCount > 0`)
- [ ] Mark timeouts (`meta.isTimeout`)
- [ ] Display warnings (`meta.warning`)

### Phase 4: Warnings & Errors

- [ ] Listen for `test:progress` warnings
- [ ] Show toast notifications
- [ ] Listen for `test_stopped`
- [ ] Display error modal

### Phase 5: REST API Fallback

- [ ] Detect WebSocket disconnect
- [ ] Fall back to REST API
- [ ] Poll if test still running
- [ ] Switch to final call when complete

### Phase 6: Full Report

- [ ] Add "View Full Report" button
- [ ] Call `GET /api/v1/manual-test/{testId}/full`
- [ ] Display screenshots, videos, logs
- [ ] Show generated code

---

## 📋 Event Sequence Example

**Time: 0s - Test Created**

```
Event: chat:message
Data: { metadata: { testId: "abc-123", is_test_runned: false } }
Action: Open graph panel, start listener
```

**Time: 1s - Test Started**

```
Event: test:graph-update (type: full)
Data: { fullGraph: { nodes: [{ id: "node_1", type: "start" }], edges: [] } }
Action: Initialize graph with START node
```

**Time: 3s - First Action**

```
Event: test:graph-update (type: incremental)
Data: {
  newNode: { id: "node_2", stepType: "goto", label: "Navigate to...", meta: { icon: "🌐", color: "#673AB7" } },
  newEdge: { source: "node_1", target: "node_2" }
}
Action: Add navigation node, connect to START
```

**Time: 5s - Second Action**

```
Event: test:graph-update (type: incremental)
Data: {
  newNode: { id: "node_3", stepType: "click", label: "Click Login", meta: { icon: "👆", color: "#03A9F4", success: true } },
  newEdge: { source: "node_2", target: "node_3" }
}
Action: Add click node, show blue color
```

**Time: 8s - Failed Action**

```
Event: test:graph-update (type: incremental)
Data: {
  newNode: { id: "node_4", stepType: "fill", meta: { color: "#F44336", success: false, errorMessage: "Selector not found" } },
  newEdge: { source: "node_3", target: "node_4" }
}
Action: Add fill node with RED color, show error tooltip
```

**Time: 10s - Warning**

```
Event: test:progress
Data: { event: "test_warning", data: { message: "⚠️ repeated_action: Fill Email repeated 2 times" } }
Action: Show toast, highlight nodes
```

**Time: 15s - Test Completed**

```
Event: test:graph-update (type: full)
Data: {
  newNode: { id: "node_8", type: "end", label: "Test Completed ✅", meta: { success: true } },
  fullGraph: { nodes: [...], edges: [...], metadata: { totalSteps: 6, completedSteps: 5, failedSteps: 1 } }
}
Action: Add END node, show statistics, enable "View Full Report"
```

---

## 🎨 UI Recommendations

### Graph Panel Layout

**Header:**

```
🔴 Live | Test: abc-123 | 5 actions
━━━━━━━━━━━━━━━━━ 60% ━━━━━━━━━━━━
```

**Main Area:**

```
[GRAPH VISUALIZATION]
(React Flow / Cytoscape / D3.js)
```

**Sidebar:**

```
📊 Current Action:
👆 Clicking Login Button...

⏱️ Elapsed: 5.2s
✅ Completed: 3 / 7 actions
❌ Failed: 1

⚠️ Warnings:
• Selector not found (1x)
```

**Footer:**

```
[View Full Report] [Export Graph] [⚙️]
```

### Node Tooltip

**On hover:**

```
👆 Click Login Button
─────────────────────
Selector: button.login
Status: ✅ Success
Duration: 340ms
URL: https://example.com/login
Time: 10:30:05
```

**For failed nodes:**

```
✏️ Fill Email
─────────────────────
Selector: input[name='email']
Status: ❌ Failed
Error: Selector not found
Retries: 2
⚠️ Warning: Repeated action
```

---

## 🔄 State Management

### Recommended State

```typescript
interface TestGraphState {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    selector?: string;
    meta?: Record<string, any>;
  }>;

  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
  }>;

  metadata: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
  };

  isLive: boolean;
  testId: string;
  startTime: number;
  endTime?: number;

  warnings: Array<{
    type: string;
    message: string;
    severity: string;
    timestamp: string;
  }>;
}
```

### Update Logic

**Incremental:**

```
1. Append newNode to nodes
2. Append newEdge to edges
3. Increment metadata.totalSteps
4. If success → increment completedSteps
5. If failed → increment failedSteps
6. Re-render graph
```

**Full:**

```
1. Replace nodes array
2. Replace edges array
3. Replace metadata
4. If newNode.type === 'end' → set isLive: false
5. Re-render graph
```

---

## 🎯 Metrics to Display

### During Test

```
Status: 🔴 Running
Progress: 60% (3 / 5 actions)
Elapsed: 5.2s

✅ Completed: 3
❌ Failed: 1
⚠️ Warnings: 2
⏱️ Avg Duration: 1.2s/action
```

### After Test

```
Status: ✅ Completed
Duration: 15.3s
Actions: 8
Success Rate: 87% (7/8)
Pages Visited: 3

Navigation: 2 (100%)
Clicks: 3 (66%)
Fills: 2 (100%)
Waits: 1 (100%)
```

---

## 🔐 Authentication

**Required Header:**

```
Authorization: Bearer {JWT_TOKEN}
```

**Token:**

- Get from login response
- Store in localStorage or secure cookie
- Include in WebSocket handshake
- Include in all REST API requests

---

## ✅ Quick Start

### 1. WebSocket

```
Connect: wss://your-api-domain.com
Event: test:graph-update
Auth: Bearer token
```

### 2. Handle Updates

```
Incremental: Add newNode + newEdge
Full: Replace entire graph
```

### 3. Visual Styling

```
Colors: Use meta.color
Icons: Use meta.icon
Labels: Add ⚠️ for repeated, 🔄 for retry
```

### 4. REST API

```
Full data: GET /api/v1/manual-test/{testId}/full
Graph: GET /api/v1/test-visualization/{testId}
List: GET /api/v1/manual-test?page=1&limit=20
```

### 5. Error Handling

```
Disconnect → Poll REST API
Warnings → Show toasts
Stopped → Show error modal
```

---

**That's it! Everything you need is above. 🚀**
