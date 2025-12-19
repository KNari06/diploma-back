# Platform Test Flow - Complete Analysis

## 📋 Overview

Complete flow analysis of the `platform_test` logic, from entry point to test execution.

---

## 🚀 Entry Point

**File:** `src/api/chat/shared/routing.ts` (lines 45-53)

```typescript
if (intent === "platform_test") {
  return await handlePlatformTest(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    answers: params.answers,
  });
}
```

**Flow:** `routeToHandler()` → `handlePlatformTest()`

---

## 📍 Phase 1: Test Plan Generation

### 1.1 Handler: `handlePlatformTest`

**File:** `src/api/chat/ai_test/handler.ts`

**Main Steps:**

1. **Load Session Context** (lines 71-94)

   - Get project from chat session
   - Load user projects from DB

2. **Process User Answers** (lines 131-160)

   - Parse answers if provided (URL, scope, credentials)
   - Uses `parseAnswers()` from `question-generator.service`

3. **Validate URL + Scope** (lines 166-233)

   - Extract URL: `answers > parsedIntent > sessionProject`
   - Normalize URL with `normalizeUrl()`
   - If missing → call `requestMissingInformation()`

4. **Find/Create Project** (lines 243-270)

   - `ProjectContextService.findOrCreateProject()`
   - Update chat session with project

5. **Handle Credentials** (lines 278-304)

   - Priority: user answers > saved in DB
   - `ProjectContextService.getProjectCredentials()`

6. **Run Autonomous Exploration** (lines 312-410)

   - Call `runAutonomousExploration()`
   - If auth error → re-ask for credentials
   - Returns: `exploration`, `testPlan`, `formattedPlan`

7. **Save & Respond** (lines 422-459)
   - Save to chat history
   - Send test plan to user for approval
   - Response includes `requiresApproval: true`

**Key Features:**

- Timeout protection (60s)
- WebSocket progress updates
- Comprehensive error handling
- Graceful degradation

---

### 1.2 Autonomous Exploration Orchestrator

**File:** `src/services/testing/ui/autonomous/autonomous-orchestrator.service.ts`

**Function:** `runAutonomousExploration()` (lines 271-524)

**Flow:**

1. **Parse Answers** (lines 319-327)

   - Validate URL presence
   - Parse user answers

2. **Check Cache** (lines 336-431)

   - `getCachedExploration()` - check if exploration exists
   - If cached → use cached data
   - If not → run fresh exploration

3. **Fresh Exploration** (if not cached)

   - **Handle Credentials** (lines 352-392)
     - Store credentials securely
     - Retrieve for use
   - **Launch Browser** (lines 394-422)
     - `exploreProduct()` - real browser analysis
     - Timeout: 5 minutes
     - WebSocket progress updates
   - **Save to Cache** (lines 427-431)
     - `saveExplorationToCache()`

4. **Generate Test Plan** (lines 433-494)

   - **URL Context Analysis** (lines 437-440)
     - `analyzeUrlContext()` - domain/path insights
     - `getScopeStrategy()` - scope-specific strategy
   - **Choose Generator** (lines 449-483)
     - **Note:** Both generators now create intelligent mode plans (Standard mode removed)
     - `generateIntelligentTestPlan()`: Used for `scope === 'full' || 'flow'`
     - `generateTestPlan()`: Used for other scopes (but still creates intelligent mode plan)
     - **Scope differences:**
       - `full`: Comprehensive site-wide testing (10-20 min) - All major journeys, navigation, responsive, accessibility, performance, cross-browser, platform functionality, integration points
       - `flow`: Specific user journey testing (5-10 min) - Complete flow from start to finish, happy path, error handling, state persistence
       - Other scopes (`page`, `component`, `quick`): More focused testing with shorter duration
   - **Generate Plan** (lines 481-483)
     - `generateIntelligentTestPlan()` OR `generateTestPlan()`
   - **Save Plan** (line 494)
     - `saveTestPlan()` - save to DB with status `pending_confirmation`

5. **Format for User** (lines 496-503)
   - `formatTestPlanForConfirmation()`
   - Detect user language
   - Return formatted message

**Returns:**

```typescript
{
  exploration: ExplorationResult,
  testPlan: TestPlan,
  message: string // Formatted plan for user
}
```

---

### 1.3 Test Plan Generation

**File:** `src/services/testing/plans/test-plan-generator.service.ts`

**Functions:**

- `generateTestPlan()` (lines 416-521) - **Note:** Always creates intelligent mode plan (Standard mode removed)
- `generateIntelligentTestPlan()` (lines 734-877) - Creates intelligent mode plan with enhanced features

**Important:** Both functions now always set `intelligentMode: true`. The difference is in the prompt and plan structure, not the execution mode.

**Process:**

1. **Build AI Prompt** (line 431)

   - `buildTestPlanPrompt()` - comprehensive prompt with exploration data

2. **Call AI** (lines 434-447)

   - `getChatCompletionWithMessages()`
   - Temperature: 0.4
   - Max tokens: 3000
   - Response format: JSON

3. **Parse & Validate** (lines 449-487)

   - Parse AI response
   - Normalize steps
   - Validate selectors

4. **Create TestPlan Object** (lines 490-508)
   ```typescript
   {
     id: UUID,
     status: 'pending_confirmation',
     url: string,
     scope: string,
     summary: string,
     steps: Step[],
     commands: Command[],
     intelligentMode: boolean,
     createdAt: ISO string,
     expiresAt: ISO string (72 hours)
   }
   ```

---

## ✅ Phase 2: Test Plan Approval

### 2.1 Approval Check

**File:** `src/api/chat/shared/test-plan-approval.ts`

**Function:** `checkPendingApproval()` (lines 14-46)

**Called from:** `chat.controller.ts` (before intent parsing)

**Flow:**

1. **Check Last AI Message** (lines 75-225)

   - Verify last message was a test plan
   - Prevents false approvals

2. **Find Pending Plan** (lines 310-377)

   - `findPendingTestPlan()` - parallel search:
     - By `conversationId` (if provided)
     - Latest pending plan for user
   - Check expiration

3. **Detect User Approval** (line 249)

   - `detectUserApproval()` - AI-based detection
   - Returns: `{ approved: boolean, confidence: number }`

4. **Process Approval** (lines 271-301)
   - If approved → `executeApprovedTestPlan()`
   - If rejected → save rejection message
   - If unclear (confidence < 0.5) → continue normal flow

---

### 2.2 Execute Approved Plan

**File:** `src/api/chat/shared/test-execution.ts`

**Function:** `executeApprovedTestPlan()` (lines 168-223)

**Flow:**

1. **Validate Test Plan** (line 190)

   - `validateTestPlan()` - check exists, not expired

2. **Determine Test Type** (line 194)

   - `determineTestType()` - API vs Intelligent

3. **Check Credits** (line 198)

   - `checkCreditsBeforeTest()` - verify user has enough

4. **Route to Execution** (lines 202-219)
   - API test → `executeApiTestFlow()`
   - UI test → `executeUiTestFlow()`

---

## 🎯 Phase 3: Test Execution

### 3.1 UI Test Flow Execution

**File:** `src/api/chat/ai_test/execution.ts`

**Function:** `executeUiTestFlow()` (lines 23-268)

**Flow:**

1. **Confirm Test Plan** (line 67)

   - `confirmTestPlan()` - mark as `confirmed` in DB

2. **Deduct Credits** (lines 84-99)

   - `CreditCostTrackerService.deductCreditsForTest()`
   - Intelligent mode: $0.08
   - Credits deducted BEFORE execution

3. **Find/Create Project** (lines 107-124)

   - `ProjectContextService.findOrCreateProject()`

4. **Create Test** (lines 130-156)

   - `ManualTestService.runTest()` - creates test record
   - Returns: `{ success: true, data: { id: testId } }`

5. **Save Mapping** (lines 166-177)

   - `TestChatMappingService.saveTestChatMapping()`
   - Links test to chat session

6. **Emit WebSocket Event** (lines 180-202)

   - `webSocketService.emitChatTestUpdate()`
   - Notify frontend test started

7. **Save Chat & Respond** (lines 216-243)
   - Save success message to chat
   - Send HTTP response with testId

**Key Points:**

- Test is created and queued (not executed yet)
- Execution happens in background worker
- Timeout: 90 seconds for setup

---

### 3.2 Manual Test Service

**File:** `src/services/testing/ui/manualTest.service.ts`

**Function:** `runTest()` - Creates test record in DB

**Creates:**

- Test record in `tests` table
- Status: `pending`
- Queues test for execution

---

### 3.3 Playwright Service

**File:** `src/agent/playwright.service.ts`

**Function:** `executePlaywrightTest()` (lines 318-1008)

**Flow:**

1. **Setup Browser** (lines 400-500)

   - Launch Playwright browser
   - Create page context

2. **Determine Mode** (lines 600-700)

   - Check `intelligentMode` flag
   - All UI tests now use intelligent mode

3. **Build Intelligent Config** (lines 664-684)

   ```typescript
   {
     mode: 'balanced',
     safety: SafetyConfig,
     goal: testPlan.summary,
     startUrl: testData.url,
     browser: 'chrome',
     credentials: testData.options?.credentials,
     hints: commandsFromPlan,
     commands: testData.commands
   }
   ```

4. **Create Orchestrator** (lines 687-691)

   - `IntelligentTestOrchestrator(config, userId, testId)`

5. **Execute Test** (line 694)
   - `orchestrator.execute(browser, page)`

---

### 3.4 Intelligent Test Orchestrator

**File:** `src/agent/intelligent-test-orchestrator.ts`

**Class:** `IntelligentTestOrchestrator`

**Main Method:** `execute()` (lines 138-449)

**Flow:**

1. **Initialize** (lines 139-200)

   - Setup CommandExecutor
   - Setup navigation listeners
   - Verify initial URL
   - Initialize state tracker

2. **Navigate to Start URL** (lines 201-250)

   - Navigate to test URL
   - Wait for page load
   - Handle authentication if needed

3. **Main Loop** (lines 472-897)
   - `mainLoop()` - core testing logic

**Main Loop Steps** (lines 482-897):

```
ITERATION:
  1. Check cancellation
  2. Check limits (SafetyGuard)
  3. Analyze page (IntelligentPageAnalyzer)
  4. Pre-action analysis (PreActionAnalyzer)
  5. Generate actions (ContextualActionGenerator)
  6. Execute actions (CommandExecutor)
  7. Post-action analysis (PostActionAnalyzer)
  8. Validate results (ResultValidator)
  9. Make decision (continue/stop)
  10. Update state (StateTracker)
```

**Key Components:**

- **IntelligentPageAnalyzer** - Analyzes DOM, finds elements
- **PreActionAnalyzer** - Validates action before execution
- **ContextualActionGenerator** - Generates actions based on context
- **CommandExecutor** - Executes actions safely
- **PostActionAnalyzer** - Analyzes results after action
- **ResultValidator** - Validates test outcomes
- **SafetyGuard** - Enforces limits and safety rules
- **StateTracker** - Tracks test state and history

**Decision Making:**

- Continue if: more actions possible, limits not reached
- Stop if: goal achieved, limits reached, errors detected

**Result:**

```typescript
{
  success: boolean,
  pagesVisited: number,
  actionsTaken: number,
  duration: number,
  cost: number,
  errors: Error[],
  pages: PageVisit[]
}
```

---

## 📊 Data Flow Diagram

```
User Message
    ↓
[Routing] routeToHandler()
    ↓
[Handler] handlePlatformTest()
    ├─→ Load session context
    ├─→ Parse answers
    ├─→ Validate URL/scope
    ├─→ Find/create project
    ├─→ Handle credentials
    └─→ [Autonomous Orchestrator] runAutonomousExploration()
            ├─→ Check cache
            ├─→ [Explorer] exploreProduct() (if not cached)
            │       └─→ Launch browser, analyze page
            ├─→ [Plan Generator] generateTestPlan()
            │       └─→ AI generates plan from exploration
            └─→ Save plan to DB (pending_confirmation)
    ↓
[Response] Send test plan to user
    ↓
User approves
    ↓
[Approval Handler] handlePendingTestPlanApproval()
    ├─→ Detect approval
    └─→ [Execution] executeApprovedTestPlan()
            ├─→ Validate plan
            ├─→ Check credits
            └─→ [UI Flow] executeUiTestFlow()
                    ├─→ Confirm plan
                    ├─→ Deduct credits
                    ├─→ [Manual Test] runTest()
                    │       └─→ Create test record, queue
                    └─→ [Playwright] executePlaywrightTest()
                            └─→ [Orchestrator] IntelligentTestOrchestrator.execute()
                                    └─→ Main loop: analyze → generate → execute → validate
```

---

## 🔑 Key Files Summary

| File                                 | Purpose                   | Key Functions                                         |
| ------------------------------------ | ------------------------- | ----------------------------------------------------- |
| `routing.ts`                         | Entry point               | `routeToHandler()`                                    |
| `handler.ts`                         | Test plan generation      | `handlePlatformTest()`                                |
| `autonomous-orchestrator.service.ts` | Exploration orchestration | `runAutonomousExploration()`                          |
| `autonomous-explorer.service.ts`     | Browser exploration       | `exploreProduct()`                                    |
| `test-plan-generator.service.ts`     | Plan generation           | `generateTestPlan()`, `generateIntelligentTestPlan()` |
| `test-plan-approval.ts`              | Approval handling         | `handlePendingTestPlanApproval()`                     |
| `test-execution.ts`                  | Execution routing         | `executeApprovedTestPlan()`                           |
| `execution.ts`                       | UI test execution         | `executeUiTestFlow()`                                 |
| `manualTest.service.ts`              | Test creation             | `runTest()`                                           |
| `playwright.service.ts`              | Playwright execution      | `executePlaywrightTest()`                             |
| `intelligent-test-orchestrator.ts`   | Intelligent testing       | `IntelligentTestOrchestrator.execute()`               |

---

## ⚙️ Configuration & Constants

**Timeouts:**

- Handler flow: 60 seconds
- Exploration: 5 minutes
- UI test setup: 90 seconds

**Test Plan:**

- Status: `pending_confirmation` → `confirmed` → `completed`
- Expiration: 72 hours
- **All UI tests use Intelligent mode** (Standard mode completely removed)
  - Both `generateTestPlan()` and `generateIntelligentTestPlan()` set `intelligentMode: true`
  - The choice between generators affects plan structure/prompts, not execution mode

**Credits:**

- Intelligent mode: $0.08 per test
- Deducted BEFORE execution

---

## 🔄 State Transitions

**Test Plan:**

```
pending_confirmation → confirmed → (execution) → completed
                   ↓
                rejected
```

**Test:**

```
pending → running → completed
                 ↓
              failed
```

---

## 🎯 Key Design Decisions

1. **Two-Phase Flow:**

   - Phase 1: Generate plan (requires approval)
   - Phase 2: Execute plan (after approval)

2. **Caching:**

   - Exploration results cached per URL/project
   - Reduces browser launches

3. **Intelligent Mode:**

   - **All UI tests use intelligent mode** (Standard mode removed)
   - Both plan generators create intelligent mode plans
   - AI-driven action generation
   - Adaptive to page changes
   - Scope affects plan structure, not execution mode

4. **Safety:**

   - Limits on pages/actions/duration
   - Safety guard prevents dangerous actions
   - Credit check before execution

5. **Error Handling:**
   - Comprehensive try-catch blocks
   - Graceful degradation
   - Non-blocking chat saves

---

## 📝 Notes

- Test plan generation is synchronous (waits for AI)
- Test execution is asynchronous (queued in background)
- WebSocket updates throughout the flow
- All database operations use `supabaseAdmin`
- User language detection for natural responses

---

## 🔍 Scope Types Explained

**Location:** `src/services/testing/ui/autonomous/autonomous-orchestrator.service.ts` (lines 115-201)

### Scope Differences:

| Scope           | Description                     | Duration  | Focus Areas                                                                                                                                                                      |
| --------------- | ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`full`**      | Comprehensive site-wide testing | 10-20 min | All major user journeys, navigation across sections, responsive design, accessibility, performance, cross-browser compatibility, core platform functionality, integration points |
| **`flow`**      | Specific user journey testing   | 5-10 min  | Complete user flow from start to finish, happy path validation, error handling, state persistence, flow interruption/recovery                                                    |
| **`page`**      | Single page deep testing        | 3-7 min   | All interactive elements, page-specific functionality, responsive behavior, accessibility, page load performance                                                                 |
| **`component`** | Component-level focused testing | 2-5 min   | Component in different states, component interactions, edge cases, error states, accessibility, responsiveness                                                                   |
| **`quick`**     | Quick smoke testing             | 1-3 min   | Basic functionality check, critical path validation, page load verification                                                                                                      |

**Important Notes:**

- `full` and `flow` use `generateIntelligentTestPlan()` (more comprehensive prompts)
- Other scopes use `generateTestPlan()` (more focused prompts)
- **Note:** `platform` scope was merged into `full` as they were identical (both 10-20 min, same focus areas)
- **All scopes result in intelligent mode execution** (Standard mode removed)
- Scope affects the test plan structure and AI prompts, not the execution mode
