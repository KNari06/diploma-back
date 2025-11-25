# Frontend Integration - Quick Reference

## 🎯 What Frontend Needs to Implement

### 1. WebSocket Connection
- **Endpoint:** `wss://your-api-domain.com`
- **Auth:** Bearer token in connection handshake
- **Event to listen:** `test:graph-update`

### 2. Handle Two Update Types

#### Incremental (during test execution)
- Receive: `{ newNode, newEdge }`
- Action: Add node and edge to graph
- Frequency: 1-3 times per second

#### Full (test start and end)
- Receive: `{ fullGraph: { nodes[], edges[], metadata } }`
- Action: Replace entire graph
- Frequency: 2 times per test (start + end)

### 3. Visual Rendering

**Node Colors:**
- `#4CAF50` Green - Success, Start, End (if passed)
- `#03A9F4` Blue - Normal actions
- `#673AB7` Purple - Navigation
- `#FFC107` Yellow - Retry (succeeded after retry)
- `#FF9800` Orange - Warnings (repeated action, single timeout)
- `#F44336` Red - Failures, Critical patterns
- `#9E9E9E` Gray - Wait actions

**Node Icons:**
- `🌐` Navigate
- `👆` Click
- `✏️` Fill
- `⌨️` Type
- `⏱️` Wait
- `📜` Scroll
- `✅` Success/Assertion
- `❌` Failed

**Node Labels:**
- Normal: `"Click Login Button"`
- Repeated: `"⚠️ Click Login Button (repeated)"`
- Retry: `"🔄 Fill Email (retry 2)"`
- Timeout: `"Wait element ⏱️ Timeout"`

### 4. Problem Detection

**Watch for these in node metadata:**
- `meta.isRepeated: true` → Show orange border, warning icon
- `meta.retryCount > 0` → Show retry badge
- `meta.isTimeout: true` → Show timeout icon
- `meta.warning` → Display warning text

**Also listen for:**
- `test:progress` event with `event: 'test_warning'` → Show toast notification
- `test:progress` event with `event: 'test_stopped'` → Show error modal

---

## 🌐 API Routes

### Route 1: Test Visualization Graph
```
GET /api/v1/test-visualization/{testId}
Query: ?format=json&includeStartEnd=true
Auth: Required (Bearer token)
Returns: Complete graph (nodes, edges, metadata)
Use: Fallback if WebSocket fails, historical tests
```

### Route 2: Full Test Data
```
GET /api/v1/manual-test/{testId}/full
Auth: Required (Bearer token)
Returns: Test info, results, screenshots, videos, logs, code, intelligent session
Use: "View Full Report" button, detailed analysis
```

### Route 3: User's Tests List
```
GET /api/v1/manual-test?page=1&limit=20
Auth: Required (Bearer token)
Returns: Paginated list of all user's tests (manual + chat-initiated)
Use: Test history, dashboard, search
```

---

## 📱 User Flow

### Step 1: User Starts Test from Chat
- User sends: `"Test login on example.com"`
- Frontend receives chat message with `metadata.testId` and `is_test_runned: false`
- **Action:** Open graph panel, start listening for `test:graph-update`

### Step 2: Real-Time Updates
- Every action → New node appears in graph
- Failed actions → Red nodes
- Repeated actions → Orange nodes with warning
- **Action:** Update graph, show progress bar, display current action

### Step 3: Test Completes
- Receive `test:graph-update` with `type: 'full'` and `newNode.type: 'end'`
- Receive updated chat message with `is_test_runned: true`
- **Action:** Show final stats, enable "View Full Report" button

### Step 4: View Full Report
- User clicks "View Full Report"
- Call `GET /api/v1/manual-test/{testId}/full`
- **Action:** Display comprehensive results page with screenshots, videos, code

---

## ⚠️ Error Handling

### WebSocket Disconnected
- **Fallback:** Poll `GET /api/v1/test-visualization/{testId}` every 3 seconds
- **Indicator:** Show "Reconnecting..." badge
- **Final:** When test completes, switch to one-time REST call

### Missing Graph Data
- **Solution:** Request full graph via REST API
- **Route:** `GET /api/v1/test-visualization/{testId}`

### Test Stopped (Critical Pattern)
- **Event:** `test:progress` with `event: 'test_stopped'`
- **Display:** Error modal with reason
- **Example:** "Test stopped: Action 'click' repeated 3 times. Element may not exist."

---

## 🎨 Visual Examples

### Normal Test Flow
```
▶️ Start (green)
  ↓
🌐 Navigate (purple)
  ↓
👆 Click (blue)
  ↓
✏️ Fill (blue)
  ↓
✅ End (green)
```

### Test with Warnings
```
▶️ Start (green)
  ↓
🌐 Navigate (purple)
  ↓
👆 Click (red) - Failed
  ↓
⚠️ 👆 Click (orange) - Repeated warning
  ↓
⚠️ 👆 Click (red) - Critical
  ↓
❌ End (red) - Stopped: repeated_action
```

### Test with Retries
```
▶️ Start (green)
  ↓
🌐 Navigate (purple)
  ↓
🔄 ✏️ Fill Email (yellow) - Retry 1
  ↓
🔄 ✏️ Fill Email (yellow) - Retry 2
  ↓
✏️ Fill Email (green) - Success on retry 3
  ↓
✅ End (green)
```

---

## 📊 Metrics to Display

### Live (during test)
```
Progress: 60%
Current: "Clicking Login Button..."
Completed: 3 actions
Failed: 1 action
Warnings: 2
Elapsed: 5.2s
```

### Final (after test)
```
Duration: 15.3s
Total Actions: 8
Success Rate: 87% (7/8)
Pages Visited: 3
Warnings: 2
Errors: 1
```

---

## ✅ Implementation Checklist

**Phase 1: Basic Integration**
- [ ] Connect to WebSocket with auth
- [ ] Listen for `test:graph-update`
- [ ] Add nodes/edges to graph on updates
- [ ] Show graph visualization (React Flow recommended)

**Phase 2: Visual Polish**
- [ ] Apply correct colors based on `meta.color`
- [ ] Show icons from `meta.icon`
- [ ] Add labels with status indicators (⚠️, 🔄, ❌)
- [ ] Highlight failed/repeated nodes

**Phase 3: Warnings**
- [ ] Listen for `test:progress` warnings
- [ ] Show toast notifications
- [ ] Highlight affected nodes
- [ ] Display warning count

**Phase 4: Error Handling**
- [ ] Handle WebSocket disconnect
- [ ] Implement REST API fallback
- [ ] Show error modals for critical patterns
- [ ] Display meaningful error messages

**Phase 5: Full Report**
- [ ] Add "View Full Report" button (when `is_test_runned: true`)
- [ ] Call `GET /api/v1/manual-test/{testId}/full`
- [ ] Display screenshots, videos, logs
- [ ] Show generated Playwright code

---

## 📚 Complete Documentation

**Read this for full details:**
`docs/api/FRONTEND_GRAPH_INTEGRATION_GUIDE.md`

**Contains:**
- Event sequence examples
- Complete payload structures
- UI layout recommendations
- State management strategies
- Error handling patterns
- Performance optimization tips

---

## ✅ Ready to Implement

All backend work is complete. Frontend can start implementing immediately!

**Questions?** Check the full docs or ask!
