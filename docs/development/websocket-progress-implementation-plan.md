# WebSocket Real-Time Progress Implementation Plan

## 📋 Overview

Real-time test progress tracking через WebSocket для улучшения UX во время выполнения автономных тестов.

---

## 1. Architecture & Flow

### Full Flow: От клика до результата

```
1. USER → Click "Start Test"
   ↓
2. Frontend → POST /api/v1/chat
   ↓
3. chat.controller.ts → handleChat() → executeApprovedTestPlan()
   ↓
4. manualTest.service.ts → runTest() → testQueue.add()
   ↓
5. test.processor.ts → processTest() → executePlaywrightTest()
   ↓
6. playwright.service.ts
   🔔 EMIT: browser_launching (10%)
   🔔 EMIT: page_loading (25%)
   🔔 EMIT: intelligent_starting (40%)
   ↓
7. intelligent-test-orchestrator.ts
   🔔 EMIT: analyzing_page (50%)
   🔔 EMIT: planning_actions (60%)
   🔔 EMIT: action_executing (70-90%)
   🔔 EMIT: test_completed (100%)
   ↓
8. Frontend: socket.on('test:progress') → Update UI
```

---

## 2. Progress Distribution (0-100%)

### Phase 1: INITIALIZATION (0-25%)

- 0%: Test created
- 5%: Test queued
- 10%: Browser launching
- 15%: Browser ready
- 20%: Navigating to page
- 25%: Page loaded

### Phase 2: INTELLIGENT ANALYSIS (25-50%)

- 30%: AI analyzing page structure
- 35%: Taking initial screenshot
- 40%: Analyzing DOM elements
- 45%: Identifying interactive elements
- 50%: Analysis complete

### Phase 3: ACTION PLANNING (50-60%)

- 52%: AI planning test strategy
- 55%: Generating action sequence
- 60%: Action plan ready

### Phase 4: ACTION EXECUTION (60-90%)

- Progress = 60 + (30 \* completedActions / totalActions)
- Each action emits progress update

### Phase 5: FINALIZATION (90-100%)

- 92%: Taking final screenshots
- 95%: Collecting results
- 97%: Saving to database
- 100%: Test completed

---

## 3. WebSocket Event Structure

### TestProgressPayload Interface

```typescript
interface TestProgressPayload {
  testId: string; // UUID теста
  browser: string; // 'chrome' | 'firefox'

  // Progress tracking
  progress: number; // 0-100
  phase: string; // 'initialization' | 'analysis' | 'planning' | 'execution' | 'finalization'

  // Current action
  currentStep: string; // "🌐 Launching browser..."
  action?: {
    type: string; // 'click' | 'fill' | 'navigate'
    description: string; // "Clicking login button"
    target?: string; // CSS selector
  };

  // Step tracking
  totalSteps?: number; // Total actions
  completedSteps?: number; // Completed actions

  // Timing
  timestamp: string; // ISO timestamp
  elapsedTime?: number; // ms since start
  estimatedRemaining?: number; // Estimated ms remaining

  // Status
  status: "queued" | "running" | "completed" | "failed";
}
```

### Example Events

```json
// 1. Test queued
{
  "testId": "abc-123",
  "browser": "chrome",
  "progress": 5,
  "phase": "initialization",
  "currentStep": "📋 Test queued",
  "status": "queued",
  "timestamp": "2025-11-12T20:00:00Z"
}

// 2. Action execution
{
  "testId": "abc-123",
  "browser": "chrome",
  "progress": 75,
  "phase": "execution",
  "currentStep": "✍️ Filling username field...",
  "action": {
    "type": "fill",
    "description": "Filling username field",
    "target": "input[name='username']"
  },
  "totalSteps": 5,
  "completedSteps": 3,
  "status": "running",
  "elapsedTime": 25000,
  "estimatedRemaining": 10000
}

// 3. Completed
{
  "testId": "abc-123",
  "browser": "chrome",
  "progress": 100,
  "phase": "finalization",
  "currentStep": "✅ Test completed successfully!",
  "totalSteps": 5,
  "completedSteps": 5,
  "status": "completed",
  "elapsedTime": 35000
}
```

---

## 4. Backend Implementation

### Step 1: Create TestProgressEmitter

**File:** `src/agent/utils/progress-emitter.ts`

```typescript
import { webSocketService } from "@/websocket/websocket.service";

export class TestProgressEmitter {
  private testId: string;
  private browser: string;
  private startTime: number;
  private totalActions: number = 0;

  constructor(testId: string, browser: string) {
    this.testId = testId;
    this.browser = browser;
    this.startTime = Date.now();
  }

  setTotalActions(count: number) {
    this.totalActions = count;
  }

  emit(params: {
    progress: number;
    phase: string;
    currentStep: string;
    action?: any;
    completedSteps?: number;
    status?: string;
  }) {
    const elapsedTime = Date.now() - this.startTime;
    const estimatedTotal =
      params.progress > 0 ? (elapsedTime / params.progress) * 100 : 30000;
    const estimatedRemaining = estimatedTotal - elapsedTime;

    webSocketService.emitTestProgress(this.testId, {
      testId: this.testId,
      browser: this.browser,
      progress: params.progress,
      phase: params.phase,
      currentStep: params.currentStep,
      action: params.action,
      totalSteps: this.totalActions,
      completedSteps: params.completedSteps,
      status: params.status || "running",
      timestamp: new Date().toISOString(),
      elapsedTime,
      estimatedRemaining: Math.max(0, estimatedRemaining),
    });
  }
}
```

### Step 2: Integrate into playwright.service.ts

```typescript
import { TestProgressEmitter } from "./utils/progress-emitter";

export async function executePlaywrightTest(testData: TestJobData) {
  const progressEmitter = new TestProgressEmitter(
    testData.testId,
    testData.browser
  );

  try {
    // Phase 1: INITIALIZATION (0-25%)
    progressEmitter.emit({
      progress: 10,
      phase: "initialization",
      currentStep: "🌐 Launching browser...",
    });

    const browser = await browserPool.getBrowser(testData.browser);

    progressEmitter.emit({
      progress: 20,
      phase: "initialization",
      currentStep: `📄 Navigating to ${testData.url}...`,
    });

    await page.goto(testData.url);

    progressEmitter.emit({
      progress: 25,
      phase: "initialization",
      currentStep: "✅ Page loaded",
    });

    // Phase 2: INTELLIGENT MODE
    if (testData.intelligentMode) {
      const orchestrator = new IntelligentTestOrchestrator(
        testData.testId,
        intelligentConfig,
        progressEmitter // ✅ Pass emitter
      );

      const result = await orchestrator.execute(browser, page);

      progressEmitter.emit({
        progress: 100,
        phase: "finalization",
        currentStep: "✅ Test completed!",
        status: "completed",
      });
    }
  } catch (error) {
    progressEmitter.emit({
      progress: 0,
      phase: "error",
      currentStep: `❌ Test failed: ${error.message}`,
      status: "failed",
    });
  }
}
```

### Step 3: Integrate into intelligent-test-orchestrator.ts

```typescript
import { TestProgressEmitter } from "./utils/progress-emitter";

export class IntelligentTestOrchestrator {
  private progressEmitter: TestProgressEmitter;

  constructor(
    testId: string,
    config: IntelligentTestConfig,
    progressEmitter: TestProgressEmitter
  ) {
    this.testId = testId;
    this.config = config;
    this.progressEmitter = progressEmitter;
  }

  async execute(browser: Browser, page: Page) {
    // Phase 2: ANALYSIS (25-50%)
    this.progressEmitter.emit({
      progress: 30,
      phase: "analysis",
      currentStep: "📸 Taking initial screenshot...",
    });

    // ... analysis logic ...

    this.progressEmitter.emit({
      progress: 50,
      phase: "analysis",
      currentStep: "✅ Analysis complete",
    });

    // Phase 3: PLANNING (50-60%)
    this.progressEmitter.emit({
      progress: 52,
      phase: "planning",
      currentStep: "🎯 AI planning test strategy...",
    });

    const actions = await this.planActions(context);
    this.progressEmitter.setTotalActions(actions.length);

    this.progressEmitter.emit({
      progress: 60,
      phase: "planning",
      currentStep: `✅ Planned ${actions.length} actions`,
    });

    // Phase 4: EXECUTION (60-90%)
    await this.executeActions(page, context);
  }

  private async executeActions(page: Page, context: TestContext) {
    const actions = context.actions;
    const totalActions = actions.length;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const progress = 60 + Math.round((i / totalActions) * 30);

      // Emit BEFORE execution
      this.progressEmitter.emit({
        progress,
        phase: "execution",
        currentStep: `${this.getActionEmoji(action.action)} ${
          action.description
        }...`,
        action: {
          type: action.action,
          description: action.description,
          target: action.selector,
        },
        completedSteps: i,
      });

      // Execute
      await this.executor.execute(page, action);
    }
  }

  private getActionEmoji(actionType: string): string {
    const emojiMap: Record<string, string> = {
      click: "👆",
      fill: "✍️",
      select: "📋",
      wait: "⏱️",
      scroll: "📜",
      press: "⌨️",
      hover: "🖱️",
      goto: "🌐",
    };
    return emojiMap[actionType] || "🔄";
  }
}
```

### Step 4: Update WebSocket Types

**File:** `src/websocket/types.ts`

```typescript
export interface TestProgressPayload {
  testId: string;
  browser: string;
  progress: number;
  phase: string; // ✅ ADD
  currentStep?: string;
  action?: {
    // ✅ ADD
    type: string;
    description: string;
    target?: string;
  };
  totalSteps?: number;
  completedSteps?: number;
  status?: string; // ✅ ADD
  timestamp: string;
  elapsedTime?: number; // ✅ ADD
  estimatedRemaining?: number; // ✅ ADD
}
```

---

## 5. Frontend Implementation Guide

### React Hook

```typescript
// hooks/useTestProgress.ts

export function useTestProgress(testId: string) {
  const [progress, setProgress] = useState({
    progress: 0,
    phase: "idle",
    currentStep: "Waiting...",
    status: "idle",
  });

  const { socket } = useWebSocket();

  useEffect(() => {
    if (!socket || !testId) return;

    const handleProgress = (data: TestProgressPayload) => {
      if (data.testId === testId) {
        setProgress({
          progress: data.progress,
          phase: data.phase,
          currentStep: data.currentStep || "Running...",
          action: data.action,
          totalSteps: data.totalSteps,
          completedSteps: data.completedSteps,
          elapsedTime: data.elapsedTime,
          estimatedRemaining: data.estimatedRemaining,
          status: data.status || "running",
        });
      }
    };

    socket.on("test:progress", handleProgress);

    return () => socket.off("test:progress", handleProgress);
  }, [socket, testId]);

  return progress;
}
```

### UI Component

```typescript
export function TestProgressCard({ testId }: { testId: string }) {
  const progress = useTestProgress(testId);

  return (
    <Card>
      <CardHeader>
        <h3>🤖 Автономное тестирование</h3>
        <Badge>{progress.phase}</Badge>
      </CardHeader>

      <CardBody>
        <Progress value={progress.progress} max={100} />
        <Text>{progress.progress}%</Text>

        <Flex align="center" gap={2}>
          <Spinner />
          <Text>{progress.currentStep}</Text>
        </Flex>

        {progress.totalSteps && (
          <Text>
            Step {progress.completedSteps} of {progress.totalSteps}
          </Text>
        )}

        <Flex justify="space-between">
          <Text>⏱️ {formatTime(progress.elapsedTime)}</Text>
          <Text>⏳ ~{formatTime(progress.estimatedRemaining)}</Text>
        </Flex>
      </CardBody>
    </Card>
  );
}
```

---

## 6. Rollout Strategy

### Phase 1: Backend (1-2 hours)

- [ ] Создать `TestProgressEmitter`
- [ ] Интегрировать в `playwright.service.ts`
- [ ] Интегрировать в `intelligent-test-orchestrator.ts`
- [ ] Обновить WebSocket types
- [ ] Тестировать через WebSocket клиент

### Phase 2: Frontend (Frontend team)

- [ ] Создать `useTestProgress` hook
- [ ] Создать `TestProgressCard` компонент
- [ ] Интегрировать в чат UI
- [ ] Стилизация и UX

### Phase 3: Testing

- [ ] E2E тесты
- [ ] Load testing (multiple concurrent tests)
- [ ] Fix bugs

### Phase 4: Deploy

- [ ] Deploy backend
- [ ] Deploy frontend
- [ ] Monitor & iterate

---

## 7. Testing Plan

### Unit Tests

- TestProgressEmitter.emit() correctly calculates estimatedRemaining
- getActionEmoji() returns correct emojis
- Progress calculation formula works

### Integration Tests

- WebSocket emits received on frontend
- Progress updates in real-time
- Multiple tests don't overlap

### Manual Testing

- Start test through chat
- Observe progress bar
- Verify all steps shown
- Check estimated time accuracy

---

## 8. Success Metrics

- ✅ User sees progress updates within 1s of action
- ✅ Estimated time is within ±30% of actual time
- ✅ No UI freezes or lag
- ✅ Progress bar reaches 100% on completion
- ✅ Error states clearly communicated

---

## 9. Future Enhancements

- [ ] Store progress history for replay
- [ ] Show live screenshots during execution
- [ ] Allow pause/resume (advanced)
- [ ] Export progress timeline
- [ ] Analytics on average test duration
