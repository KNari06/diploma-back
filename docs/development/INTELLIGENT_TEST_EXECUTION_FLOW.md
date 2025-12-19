# Intelligent Test Execution Flow - Complete Diagram

## Overview

Детальная flow-диаграмма работы тестирования от момента `execute()` до финиша, строго по коду.

**📊 Визуальные диаграммы:**

- **SVG Diagram:** [INTELLIGENT_TEST_EXECUTION_FLOW.svg](./INTELLIGENT_TEST_EXECUTION_FLOW.svg) - статическая SVG картинка
- **Mermaid Diagrams:** [INTELLIGENT_TEST_EXECUTION_FLOW_DIAGRAM.md](./INTELLIGENT_TEST_EXECUTION_FLOW_DIAGRAM.md) - интерактивные Mermaid диаграммы

![Intelligent Test Execution Flow](./INTELLIGENT_TEST_EXECUTION_FLOW.svg)

**Основные фазы:**

1. **INITIALIZATION** - Инициализация сервисов, проверка URL, настройка listeners
2. **MAIN LOOP** - Основной цикл: Analyze → Generate → Execute → Decide → Repeat
3. **FINALIZATION** - Построение результата, валидация, cleanup
4. **SAVE RESULTS** - Сохранение в БД, загрузка артефактов

**Ключевые компоненты:**

- `IntelligentTestOrchestrator` - главный оркестратор
- `MainLoopService` - основной цикл тестирования
- `IntelligentPageAnalyzer` - анализ страницы (Vision + DOM)
- `ContextualActionGenerator` - генерация действий (AI)
- `CommandExecutor` - выполнение Playwright команд
- `PreActionAnalyzer` - анализ перед действием
- `PostActionAnalyzer` - анализ после действия
- `ResultValidator` - валидация результатов
- `ClarificationService` - запрос уточнений у пользователя

---

## Entry Point: `IntelligentTestOrchestrator.execute()`

**File:** `src/agent/intelligent-test-orchestrator.ts:170`

```
executePlaywrightTest()
  ↓
IntelligentTestOrchestrator.execute(browser, page)
```

---

## Phase 1: INITIALIZATION (lines 170-434)

### Step 1.1: Setup Abort Handling

- **Lines 175-207**: Create `isCancelledOrAborted()`, `raceWithAbort()`, `withTimeout()` helpers
- **Purpose**: Handle cancellation and timeouts throughout execution

### Step 1.2: Initialize CommandExecutor

- **Lines 211-219**: Create `CommandExecutor` with:
  - `abortSignal` (for cancellation)
  - `costManager` (for AI cost tracking)
  - `metadata` (url, projectId, userId)

### Step 1.3: Setup Navigation Listeners

- **Lines 221-222**: `setupNavigationListeners()`
- **What it does:**
  - Tracks `framenavigated` events (main frame + iframes)
  - Tracks `requestfailed` events
  - Tracks `pageerror` events (uncaught JS errors)
  - Auto-dismisses dialogs (beforeunload, alert, confirm, prompt)

### Step 1.4: Verify Initial URL

- **Lines 224-259**: Check if page is on `about:blank`
- **If about:blank:**
  - Try to navigate to `config.startUrl`
  - If still `about:blank` → return failed result immediately

### Step 1.5: Initialize State

- **Lines 280-295**: Create initial `TestState` via `StateTracker.createInitialState()`
  - Goal, startUrl, maxPages, maxDuration
  - Empty arrays for visitedPages, completedActions, errors
  - Start timestamp

### Step 1.6: Initialize Services

- **Lines 297-300**:
  - `ErrorCollectorService.startCollecting()` - collect console/network/UI errors
  - `GraphBuilder` - for visualization graph
  - `AICostManager` - track AI costs

### Step 1.7: Execute Custom Scripts (if provided)

- **Lines 326-351**: Execute `config.customScripts` (from Standard Mode)
  - Each script has 10s timeout
  - Respects abort signal
  - Failures don't stop test (just warn)

### Step 1.8: Wait for Selector (if provided)

- **Lines 353-395**: Wait for `config.waitForSelector` before starting
  - Tries `visible` state first (70% of timeout)
  - Falls back to `attached` state (30% of timeout)
  - If not found → warn but continue (AI will adapt)

### Step 1.9: Emit Progress (30%)

- **Lines 407-411**: Emit `progress: 30, phase: 'analysis'`

---

## Phase 2: MAIN LOOP (MainLoopService.execute)

**File:** `src/agent/main-loop.service.ts:68`

### Loop Entry (while continueLoop)

**Iteration Start:**

- **Line 100**: Get current state
- **Line 109**: Check cancellation → if cancelled, return `true`
- **Line 121**: Check limits via `SafetyGuard.checkLimits()`
  - If limits exceeded → break loop

---

### STEP 1: ANALYZE PAGE (lines 143-278)

**Calls:** `analyzePage()` → `IntelligentPageAnalyzer.analyzePage()`

#### 1.1: Wait for SPA Load

- **File:** `intelligent-page-analyzer.ts:112`
- Wait for network idle, DOM stability, interactive elements
- Handles heavy SPAs with many API requests

#### 1.2: Parallel Analysis

- **Lines 116-119**: Run in parallel:
  - `quickModalCheck()` - fast modal detection
  - `analyzeDOMFull()` - full DOM analysis (buttons, inputs, forms, links, etc.)

#### 1.3: Modal Handling

- **Lines 122-130**: If modals detected → wait for them to appear/close

#### 1.4: Screenshot Capture

- **Line 133**: Capture screenshot (if mode !== 'fast')

#### 1.5: Enhance DOM with AI Selectors

- **Lines 137-142**: `enhanceDOMWithAISelectors()` - improve selector quality

#### 1.6: Vision Analysis Decision

- **Lines 155-156**: Decide if Vision API needed:
  - `mode === 'full'` → always use Vision
  - `mode === 'balanced'` → use Vision if complex page
  - `mode === 'fast'` → skip Vision

#### 1.7: Vision + Logic Analysis (if Vision needed)

- **Lines 196-200**: Run in parallel:
  - `analyzeWithVision()` - GPT-4 Vision API (screenshot + DOM context)
  - `analyzeLogic()` - GPT-4o-mini (logical dependencies, required actions)

#### 1.8: Match Vision Elements with DOM Selectors

- **Lines 229-242**: `matchVisionElementsWithDOMSelectors()`
  - Match Vision elements to actual DOM selectors
  - Strategies: exact text, contains text, fuzzy match, aria-label, data-attributes
  - Batch text selector validation

#### 1.9: Enhance DOM with Vision Modals

- **Line 232**: `enhanceDOMWithVisionModals()` - add modal close selectors

#### 1.10: Re-run Logic with Vision Data (if Vision used)

- **Lines 249-271**: Re-run `analyzeLogic()` with Vision elements for better accuracy

#### 1.11: Build PageContext

- **Lines 280-303**: Combine all data into `PageContext`:
  - url, pageType, timestamp
  - vision (elements, description, warnings)
  - dom (enhanced with AI selectors)
  - screenshot
  - requiredActions, possibleActions (from logic analysis)
  - criticalElements, warnings, errorSignals, skipHints, navigationActions

#### 1.12: Add Page Node to Graph

- **Lines 162-189**: If graphBuilder exists:
  - Get page title, meta description
  - `graphBuilder.addPageNode()` with screenshot, DOM stats
  - Emit graph update via WebSocket

#### 1.13: Check for Empty Pages

- **Lines 200-281**:
  - If no interactive elements → increment `consecutiveEmptyPages`
  - If threshold reached → break loop
  - Otherwise → ask `decideNextStep()` what to do
  - If decision is `skip` → go back or navigate to startUrl

#### 1.14: Check for URL Cycles

- **Lines 283-319**: `StateTracker.detectCycle()`
  - If same URL visited 3+ times → warn
  - If cycle threshold reached → break loop
  - Otherwise → ask `decideNextStep()` what to do

#### 1.15: Check for Action Patterns

- **Lines 321-354**: `ActionPatternDetector.detectPatterns()`
  - Detects: repeated actions, failed chains, stuck patterns
  - If critical pattern → break loop

---

### STEP 2: GENERATE ACTIONS (lines 356-386)

**Calls:** `generateActions(context)` → `IntelligentTestOrchestrator.generateActions()`

#### 2.1: Emit Progress (55%)

- **Lines 911-930**: Emit `progress: 55, phase: 'generation'`

#### 2.2: Call ContextualActionGenerator

- **Lines 943-949**: `ContextualActionGenerator.generateActions()`
  - Builds prompt with: pageType, goal, availableElements, history, domSummary, actualHTML, hints
  - Calls GPT-4o-mini with `buildActionGenerationPrompt()`
  - Validates response with `ActionGenerationResponseSchema` (zod)
  - Sanitizes actions via `sanitizeActions()`:
    - Validates action types (only safe actions)
    - Validates required fields (selector for click, value for fill, etc.)
    - Validates selector format (catches mixed CSS+Playwright)
    - Fixes mixed selectors (extracts Playwright part)

#### 2.3: Filter Safe Actions

- **Lines 954-980**: For each action:
  - `SafetyGuard.checkAction()` - checks if action is safe
  - Filters: delete, remove account, pay, purchase, subscribe
  - If requires approval → emit warning

#### 2.4: Emit Progress (60%)

- **Lines 983-1002**: Emit `progress: 60, phase: 'generation'`

#### 2.5: Return Actions

- **Lines 1005-1008**: Return `{ actions, reasoning, confidence }`

#### 2.6: Handle Empty Actions

- **Lines 359-378**: If no actions generated:
  - Ask `decideNextStep()` what to do
  - If decision !== 'continue' → break loop

---

### STEP 3: EXECUTE ACTIONS (lines 388-414)

**Calls:** `executeActions(context, actions)` → `IntelligentTestOrchestrator.executeActions()`

#### 3.1: Set Total Actions for Progress

- **Lines 1023-1025**: `progressEmitter.setTotalActions(actions.length)`

#### 3.2: Loop Through Each Action

**For each action (i = 0 to actions.length-1):**

##### 3.2.1: Emit Progress (60-90%)

- **Lines 1035-1046**: `progress = 60 + (i / actions.length) * 30`

##### 3.2.2: Pre-Action Analysis

- **Lines 1084-1182**: `PreActionAnalyzer.analyzeBeforeAction()`
  - Checks: element exists, visible, actionable, disabled
  - Finds blocking factors (required fields empty, element disabled, etc.)
  - If blocked → execute prerequisite actions (fill required fields)
  - Re-analyze after prerequisites
  - If still blocked → skip action (if not optional)

##### 3.2.3: Validate Selector

- **Lines 1184-1383**:
  - Normalize selector
  - Check if selector failed before (track in `selectorFailures` map)
  - Get locator via `getLocator()`
  - Check element count:
    - If 0 → try self-healing via `SelfHealingService.healSelector()`
    - If healing successful → update action selector
    - If healing failed → check failure threshold
    - If too many failures → mark as optional and skip
  - For click actions: check visibility and actionability

##### 3.2.4: Capture Before Screenshot (if navigation)

- **Lines 1398-1418**: Only for navigation actions (click on links)

##### 3.2.5: Check Element Disabled State

- **Lines 1420-1461**: `getElementDisabledContext()`
  - If disabled → log reason and suggestions
  - Continue anyway (will fail, AI adapts next iteration)

##### 3.2.6: Capture DOM Snapshot (for post-analysis)

- **Lines 1463-1468**: `PostActionAnalyzer.captureSnapshot()` (for fill/type/click/select)

##### 3.2.7: Execute Command

- **Lines 1470-1517**:
  - Convert `DynamicAction` to `PlaywrightCommand`
  - `commandExecutor.executeCommand(finalCommand)`
  - Measure execution duration

##### 3.2.8: Wait for Page Stabilization (if URL changed)

- **Lines 1519-1533**: If `urlBefore !== urlAfter`:
  - Wait for `domcontentloaded` state

##### 3.2.9: Capture After Screenshot (if needed)

- **Lines 1536-1574**: Capture if:
  - Action failed (to debug)
  - URL changed (new page)
  - Click on button (might show modal/message)

##### 3.2.10: Check for about:blank Redirect

- **Lines 1585-1630**: If redirected to `about:blank`:
  - Try `goBack()`
  - Mark action as failed
  - Break action execution loop

##### 3.2.11: Validate Result

- **Lines 1643-1663**: `ResultValidator.validateResult()`
  - For fill/type: check actual input value
  - For check/uncheck: check checkbox state
  - For click: check URL change or element state
  - Returns: `{ valid, expected, actual, passed, message }`

##### 3.2.12: Create ActionResult

- **Lines 1667-1675**: Combine execution result + validation result

##### 3.2.13: Post-Action Analysis

- **Lines 1784-1823**: `PreActionAnalyzer.analyzeAfterAction()`
  - Detects: validation errors, new modals, button state changes
  - If errors found → try to fix via `tryFixValidationErrors()`
  - If action seemed successful but errors appear → mark as failed

##### 3.2.14: Post-Action AI Analysis (optional)

- **Lines 1825-1947**: `PostActionAnalyzer.analyze()` (for fill actions)
  - Captures DOM snapshot after action
  - Detects changes: new elements, errors, modals
  - Asks AI if follow-up actions needed (autocomplete, dropdown, etc.)
  - Executes follow-up actions if needed

##### 3.2.15: Record ActionResult

- **Lines 1677-1678**: `StateTracker.recordActionResult()`

##### 3.2.16: Emit Progress Update

- **Lines 1681-1698**: Emit progress after each action

##### 3.2.17: Handle Conditional Fields

- **Lines 2079-2158**: `handleConditionalFieldsAfterAction()`
  - If action revealed new fields (e.g., country → state dropdown)
  - Fill conditional fields automatically

##### 3.2.18: Update State

- **Line 1950**: Update state with action result

##### 3.2.19: Add Action Edge to Graph

- **Lines 1952-1978**: `graphBuilder.addActionEdge()` with action details

##### 3.2.20: Emit Graph Update

- **Line 1979**: Emit graph update via WebSocket

#### 3.3: Build PageVisit

- **Lines 1959-1978**: Create `PageVisit` object:
  - url, pageType, timestamp
  - actionResults (all completed actions)
  - success (if any action succeeded)
  - screenshot (from context)

#### 3.4: Return PageVisit

- **Line 1980**: Return `PageVisit`

---

### STEP 4: RECORD PAGE VISIT (lines 400-414)

- **Line 401**: `StateTracker.recordPageVisit()`
- **Condition**: Only record if URL changed OR has successful actions
- **Line 402**: Update state

---

### STEP 5: DECIDE NEXT STEP (lines 416-544)

**Calls:** `ContextualActionGenerator.decideNextStep()`

#### 5.1: Build Decision Prompt

- Uses: goal, history, currentPage, visitedPages, errors
- Calls GPT-4o-mini with `buildNextStepPrompt()`

#### 5.2: Get Decision

- Returns: `{ decision, reason, progress, goalAchieved, nextTarget }`
- Decision types: `continue`, `stop`, `wait_for_user`, `retry`, `skip`

#### 5.3: Handle Decision

**Case: `stop`**

- **Line 437-440**: `continueLoop = false`, break

**Case: `wait_for_user`**

- **Lines 442-506**:
  - Detect missing data type (url, credentials, test_data, payment_approval)
  - Build clarification question
  - `ClarificationService.requestClarification()`:
    - Creates Promise with questionId (UUID)
    - Stores request in `pendingQuestions` Map
    - Emits WebSocket event `test:clarification:request` to user
    - Sets 60s timeout
    - Waits for user response via WebSocket `test:clarification:response`
    - If timeout → retry once (MAX_RETRIES=1)
    - If max retries reached → resolve with `null`
  - If answer received → emit `test_info`, continue to next iteration
  - If no answer (null) → emit `test_warning`, stop test

**Case: `skip`**

- **Lines 508-533**:
  - Try `goBack()`
  - If fails → try `goto(startUrl)`
  - If fails → stop

**Case: `retry`**

- **Lines 535-538**: Continue loop (retry same iteration)

**Case: `continue`**

- **Lines 540-544**: Continue loop (normal flow)

#### 5.4: Check Cancellation After Iteration

- **Lines 546-553**: If cancelled → return `true`

---

### STEP 6: ERROR HANDLING (lines 554-631)

**If iteration throws error:**

- **Lines 555-581**:
  - Log error with iteration context
  - Record error in state
  - Check for repeated selector errors (infinite loop detection)
  - If too many selector errors → emit warning
  - If too many errors (>threshold) → break loop
  - Otherwise → continue despite error

---

## Phase 3: FINALIZATION (after MainLoopService.execute returns)

**File:** `intelligent-test-orchestrator.ts:436-585`

### Step 3.1: Check Cancellation

- **Line 440**: If `wasCancelled === true`:
  - Return `buildCancelledResult()`

### Step 3.2: Build Result

- **Line 445**: `buildResult(true)`

#### 3.2.1: Validate State

- **Lines 2292-2302**: If state not initialized → create initial state

#### 3.2.2: Get Statistics

- **Line 2304**: `StateTracker.getStatistics(state)`

#### 3.2.3: Build Summary

- **Line 2306**: `buildSummary(success, stats)`

#### 3.2.4: Collect Screenshots

- **Lines 2308-2314**: Collect from `state.visitedPages`

#### 3.2.5: Add End Node to Graph

- **Lines 2334-2347**: `graphBuilder.addEndNode()` with final stats
- Emit final graph update

#### 3.2.6: Upload Graph Screenshots

- **Lines 2369-2379**: Upload base64 screenshots to storage, replace with public URLs

#### 3.2.7: Return IntelligentTestResult

- **Lines 2381-2398**: Return complete result object

### Step 3.3: Validate Test Result

- **Line 448**: `validateTestResult(result)`
  - Check: not all pages are about:blank
  - Check: start URL was visited (handles redirects)
  - Check: success rate is reasonable
  - If invalid → mark as failed, add error

### Step 3.4: Emit Final Progress (100%)

- **Lines 501-508**: Emit `progress: 100, phase: 'finalization'`

### Step 3.5: Emit Final Event

- **Lines 511-528**:
  - If success → `test_completed`
  - If failed → `test_failed`

### Step 3.6: Cleanup

- **Lines 569-583**:
  - Log final cost stats
  - Remove cost manager from registry

### Step 3.7: Return Result

- **Line 530**: Return `IntelligentTestResult`

---

## Phase 4: SAVE RESULTS (test-executor.ts:127-166)

### Step 4.1: Save Test Session

- **Line 127**: `saveIntelligentTestResults()`
  - Creates `intelligent_test_sessions` record
  - Saves `intelligent_page_visits` with actions
  - Saves `intelligent_test_findings` (errors)

### Step 4.2: Upload Screenshots

- **Lines 128-131**: `uploadIntelligentTestScreenshots()`
  - Uploads all screenshots to Supabase Storage
  - Returns public URLs

### Step 4.3: Collect Artifacts

- **Lines 134-143**: `collectArtifactsAndCleanup()`
  - Collects video, trace files
  - Cleans up temporary files

### Step 4.4: Upload Artifacts

- **Lines 146-158**: `uploadArtifacts()`
  - Uploads video, trace to storage
  - Returns public URLs

### Step 4.5: Format Result

- **Lines 161-166**: `formatTestResult()`
  - Converts `IntelligentTestResult` to standard format
  - Returns to job handler

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ ENTRY: executePlaywrightTest()                                   │
│   File: src/agent/playwright/test-executor.ts:115                │
│   → IntelligentTestOrchestrator.execute(browser, page)            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 1: INITIALIZATION                                        │
│   1.1 Setup Abort Handling                                     │
│   1.2 Initialize CommandExecutor                                │
│   1.3 Setup Navigation Listeners                                │
│   1.4 Verify Initial URL (handle about:blank)                 │
│   1.5 Initialize State (StateTracker)                          │
│   1.6 Initialize Services (ErrorCollector, GraphBuilder)     │
│   1.7 Execute Custom Scripts (if provided)                      │
│   1.8 Wait for Selector (if provided)                           │
│   1.9 Emit Progress (30%)                                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 2: MAIN LOOP (MainLoopService.execute)                   │
│                                                                 │
│   WHILE continueLoop:                                          │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ ITERATION START                                        │ │
│     │   - Check cancellation                                 │ │
│     │   - Check limits (SafetyGuard)                         │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ STEP 1: ANALYZE PAGE                                   │ │
│     │   1.1 Wait for SPA Load                                │ │
│     │   1.2 Parallel: Modal Check + DOM Analysis             │ │
│     │   1.3 Handle Modals                                    │ │
│     │   1.4 Capture Screenshot                               │ │
│     │   1.5 Enhance DOM with AI Selectors                    │ │
│     │   1.6 Decide: Vision needed?                           │ │
│     │   1.7 IF Vision: Parallel Vision + Logic Analysis      │ │
│     │   1.8 Match Vision Elements with DOM Selectors          │ │
│     │   1.9 Enhance DOM with Vision Modals                    │ │
│     │   1.10 Re-run Logic with Vision Data                    │ │
│     │   1.11 Build PageContext                               │ │
│     │   1.12 Add Page Node to Graph                         │ │
│     │   1.13 Check Empty Pages → decideNextStep()             │ │
│     │   1.14 Check URL Cycles → decideNextStep()              │ │
│     │   1.15 Check Action Patterns → break if critical        │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ STEP 2: GENERATE ACTIONS                               │ │
│     │   2.1 Emit Progress (55%)                             │ │
│     │   2.2 ContextualActionGenerator.generateActions()      │ │
│     │      - Build prompt (buildActionGenerationPrompt)      │ │
│     │      - Call GPT-4o-mini                               │ │
│     │      - Validate response (zod schema)                 │ │
│     │      - Sanitize actions (validate, fix selectors)     │ │
│     │   2.3 Filter Safe Actions (SafetyGuard)               │ │
│     │   2.4 Emit Progress (60%)                             │ │
│     │   2.5 IF no actions → decideNextStep() → break if stop │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ STEP 3: EXECUTE ACTIONS                               │ │
│     │   FOR each action:                                    │ │
│     │     3.1 Emit Progress (60-90%)                        │ │
│     │     3.2 Pre-Action Analysis                           │ │
│     │        - Check element exists/visible/actionable      │ │
│     │        - Execute prerequisites if needed              │ │
│     │     3.3 Validate Selector                             │ │
│     │        - Try self-healing if not found                 │ │
│     │     3.4 Capture Before Screenshot (if navigation)     │ │
│     │     3.5 Check Element Disabled                        │ │
│     │     3.6 Capture DOM Snapshot                          │ │
│     │     3.7 Execute Command (CommandExecutor)             │ │
│     │     3.8 Wait for Stabilization (if URL changed)       │ │
│     │     3.9 Capture After Screenshot (if needed)        │ │
│     │     3.10 Check about:blank Redirect → goBack()        │ │
│     │     3.11 Validate Result (ResultValidator)           │ │
│     │     3.12 Create ActionResult                          │ │
│     │     3.13 Post-Action Analysis                         │ │
│     │        - Detect validation errors                      │ │
│     │        - Try to fix errors                             │ │
│     │     3.14 Post-Action AI Analysis (optional)            │ │
│     │        - Detect changes (autocomplete, modals)        │ │
│     │        - Execute follow-up actions                    │ │
│     │     3.15 Record ActionResult                           │ │
│     │     3.16 Emit Progress Update                          │ │
│     │     3.17 Handle Conditional Fields                     │ │
│     │     3.18 Update State                                  │ │
│     │     3.19 Add Action Edge to Graph                      │ │
│     │     3.20 Emit Graph Update                             │ │
│     │   Build PageVisit                                      │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ STEP 4: RECORD PAGE VISIT                             │ │
│     │   - StateTracker.recordPageVisit()                    │ │
│     │   - Only if URL changed OR has successful actions     │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ STEP 5: DECIDE NEXT STEP                              │ │
│     │   5.1 ContextualActionGenerator.decideNextStep()      │ │
│     │   5.2 Handle Decision:                                │ │
│     │      - stop → break loop                              │ │
│     │      - wait_for_user → request clarification          │ │
│     │      - skip → goBack() or goto(startUrl)              │ │
│     │      - retry → continue                                │ │
│     │      - continue → continue                            │ │
│     │   5.3 Check Cancellation                              │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     ┌───────────────────────────────────────────────────────┐ │
│     │ STEP 6: ERROR HANDLING                                │ │
│     │   IF iteration error:                                 │ │
│     │     - Log error                                        │ │
│     │     - Record in state                                  │ │
│     │     - Check for infinite loops                        │ │
│     │     - IF too many errors → break                      │ │
│     │     - ELSE → continue                                  │ │
│     └───────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│     END LOOP (return false if normal, true if cancelled)      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 3: FINALIZATION                                          │
│   3.1 Check Cancellation → buildCancelledResult()              │
│   3.2 Build Result (buildResult)                              │
│      - Validate state                                          │
│      - Get statistics                                          │
│      - Build summary                                           │
│      - Collect screenshots                                     │
│      - Add end node to graph                                   │
│      - Upload graph screenshots                                │
│   3.3 Validate Test Result                                     │
│      - Check: not all about:blank                              │
│      - Check: start URL visited                                │
│      - Check: success rate                                     │
│   3.4 Emit Final Progress (100%)                               │
│   3.5 Emit Final Event (test_completed/failed)                 │
│   3.6 Cleanup (remove cost manager)                            │
│   3.7 Return IntelligentTestResult                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 4: SAVE RESULTS                                           │
│   4.1 Save Test Session (IntelligentTestStorageService)         │
│      - intelligent_test_sessions                                │
│      - intelligent_page_visits                                  │
│      - intelligent_test_findings                               │
│   4.2 Upload Screenshots (Supabase Storage)                    │
│   4.3 Collect Artifacts (video, trace)                         │
│   4.4 Upload Artifacts (Supabase Storage)                      │
│   4.5 Format Result → return to job handler                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                          COMPLETE
```

---

## Key Components Flow

### IntelligentPageAnalyzer.analyzePage()

```
1. Wait for SPA Load
2. Parallel: Modal Check + DOM Analysis
3. Handle Modals
4. Capture Screenshot
5. Enhance DOM with AI Selectors
6. IF Vision needed:
   - Parallel: Vision Analysis + Logic Analysis
   - Match Vision Elements with DOM
   - Re-run Logic with Vision data
7. ELSE:
   - DOM-only analysis
   - Logic Analysis
8. Build PageContext
```

### ContextualActionGenerator.generateActions()

```
1. Build prompt (buildActionGenerationPrompt)
   - pageType, goal, availableElements, history, domSummary, actualHTML, hints
2. Call GPT-4o-mini
3. Parse JSON response (zod schema)
4. Sanitize actions:
   - Validate action types
   - Validate required fields
   - Validate selector format
   - Fix mixed selectors
5. Return actions
```

### CommandExecutor.executeCommand()

```
1. Normalize selector (prepareSelector)
2. Get locator (getLocator)
3. Execute Playwright command
4. Handle errors (self-healing if enabled)
5. Return execution result
```

### PreActionAnalyzer.analyzeBeforeAction()

```
1. Check element exists
2. Check element visible
3. Check element actionable
4. Check element disabled
5. Find blocking factors:
   - Required fields empty
   - Element depends on other fields
   - Form validation errors
6. Suggest prerequisite actions
7. Return: canProceed, blockingFactors, suggestedActions
```

### PostActionAnalyzer.analyzeAfterAction()

```
1. Capture DOM snapshot
2. Detect changes:
   - New validation errors
   - New modals
   - Button state changes
3. Return: hasNewErrors, errors, suggestions
```

### ResultValidator.validateResult()

```
1. For fill/type: Check actual input value
2. For check/uncheck: Check checkbox state
3. For click: Check URL change or element state
4. Return: valid, expected, actual, passed, message
```

---

## Decision Points & Conditions

### When Loop Stops:

1. **Cancellation**: User cancels test → `checkTestCancelled()` returns true
2. **Limits Exceeded**: `SafetyGuard.checkLimits()` → maxPages, maxDuration, maxActions
3. **Empty Pages**: `consecutiveEmptyPages >= threshold` → no interactive elements
4. **URL Cycles**: Same URL visited `>= cycleThreshold` times
5. **Action Patterns**: Critical pattern detected → `shouldStop === true`
6. **Decision: stop**: AI decides to stop → `decision.action === 'stop'`
7. **Decision: wait_for_user**: No answer to clarification → stop
8. **Too Many Errors**: `errors.length > maxErrors` → stop
9. **No Actions Generated**: And decision !== 'continue' → stop

### When Actions Are Skipped:

1. **Selector Not Found**: After self-healing failed → mark as optional, skip
2. **Element Blocked**: After prerequisites failed → skip (if not optional)
3. **Unsafe Action**: SafetyGuard filters → skip
4. **about:blank Redirect**: Stop action execution, break loop

### When Follow-up Actions Execute:

1. **Prerequisites**: Before main action if blocking factors found
2. **Post-Action Fixes**: After action if validation errors found
3. **Post-Action AI**: After fill/type if autocomplete/dropdown detected

---

## Error Handling Strategy

1. **Selector Not Found**:

   - Try self-healing (once)
   - Track failures in `selectorFailures` map
   - If too many failures → mark as optional, skip
   - Continue to next action

2. **Element Disabled**:

   - Log reason and suggestions
   - Continue execution (will fail, AI adapts next iteration)

3. **about:blank Redirect**:

   - Try `goBack()`
   - Mark action as failed
   - Break action execution loop

4. **Validation Errors**:

   - Post-action analysis detects errors
   - Try to fix via Form Intelligence
   - If still errors → mark action as failed

5. **Iteration Error**:
   - Log with context
   - Record in state
   - Check for infinite loops
   - If too many errors → break loop
   - Otherwise → continue

---

## WebSocket Events Emitted

1. **test_started** - Test begins
2. **test_progress** - Progress updates (30%, 55%, 60%, 60-90%, 100%)
3. **page_analyzed** - Page analysis complete
4. **actions_generating** - AI generating actions
5. **action_executing** - Action being executed
6. **action_failed** - Action failed
7. **test_warning** - Warning (limits, cycles, patterns)
8. **test_completed** - Test finished successfully
9. **test_failed** - Test finished with errors
10. **test_cancelled** - Test cancelled by user
11. **graph_update** - Graph visualization update

---

## Data Structures

### TestState

- goal, startUrl, currentUrl
- visitedPages: PageVisit[]
- completedActions: ActionResult[]
- errors: Error[]
- pagesAnalyzed, actionsTaken
- startTime, cost

### PageContext

- url, pageType, timestamp
- vision: VisionAnalysis
- dom: DOMAnalysis
- screenshot
- requiredActions, possibleActions
- criticalElements, warnings, errorSignals
- skipHints, navigationActions

### PageVisit

- url, pageType, timestamp
- actionResults: ActionResult[]
- success
- screenshot

### ActionResult

- action: DynamicAction
- success: boolean
- error?: string
- urlChanged: boolean
- urlBefore, urlAfter
- timestamp

### IntelligentTestResult

- success, goal, startUrl
- pagesVisited, actionsTaken
- duration, cost
- errors, warnings, summary
- pageVisits: PageVisit[]
- screenshots
- graphData

---

## Critical Paths

### Happy Path:

```
Initialize → Analyze → Generate → Execute → Record → Decide (continue) → Loop
→ ... → Decide (stop) → Build Result → Save → Complete
```

### Error Path:

```
Execute Action → Error → Record Error → Continue → Too Many Errors → Stop
→ Build Result (failed) → Save → Complete
```

### Cancellation Path:

```
Any Step → Check Cancellation → Return true → Build Cancelled Result → Save → Complete
```

### Empty Page Path:

```
Analyze → No Elements → decideNextStep (skip) → goBack() → Continue Loop
```

### Cycle Detection Path:

```
Analyze → Same URL 3+ times → decideNextStep (stop) → Break Loop → Build Result
```

---

## Performance Optimizations

1. **Parallel Execution**:

   - Modal check + DOM analysis
   - Vision + Logic analysis
   - Vision-DOM matching + Modal enhancement

2. **Smart Screenshot Capture**:

   - Only before navigation actions
   - Only after errors/navigation/button clicks
   - Not for every action

3. **Early Exit**:

   - Empty pages check before action generation
   - Cycle detection before action generation
   - Pattern detection before action generation

4. **Adaptive Timeouts**:
   - Based on page context (slow page, network speed)
   - Based on test mode (balanced, fast, full)

---

## Clarification Mechanism Details

### ClarificationService Flow:

1. **Request Creation** (lines 33-87):

   - Generate `questionId` (UUID)
   - Create Promise with resolve/reject
   - Store in `pendingQuestions` Map
   - Emit WebSocket: `test:clarification:request` to test room + user room
   - Set timeout (60s default)

2. **User Response** (WebSocket handler):

   - **File:** `src/websocket/handlers/subscription.handler.ts:261`
   - User sends: `test:clarification:response` with `{ testId, questionId, answer }`
   - Calls: `ClarificationService.handleResponse(testId, questionId, answer)`
   - Resolves Promise with answer

3. **Timeout Handling** (lines 128-178):

   - If 60s timeout → `handleTimeout(questionId)`
   - If `retryCount < MAX_RETRIES (1)`:
     - Increment retryCount
     - Re-emit clarification request with `[RETRY 1/1]` prefix
     - Set new timeout
   - If max retries reached:
     - Resolve Promise with `null` (no answer)
     - Remove from pending

4. **Result Handling** (main-loop.service.ts:466-490):
   - If `answer` (not null) → continue to next iteration
   - If `answer === null` → stop test

---

## Graph Builder Details

### When Nodes/Edges Added:

1. **Start Node**: Line 321 (initialization)
2. **Page Nodes**: Lines 173-188 (each page analysis)
3. **Action Edges**: Lines 1952-1978 (each action execution)
4. **End Node**: Lines 2334-2347 (finalization)

### Graph Structure:

- **Nodes**: Pages (with screenshot, title, DOM stats)
- **Edges**: Actions (with action type, selector, result)
- **Metadata**: Test goal, start URL, final stats

### Real-time Updates:

- Graph updates emitted via WebSocket after each node/edge addition
- Final graph saved to `intelligent_test_sessions.graph_data`

---

## Error Collector Details

### Error Types Collected:

- **Console Errors**: `console.error`, `console.warn`
- **Network Errors**: Failed requests (4xx, 5xx)
- **UI Errors**: Validation errors, accessibility issues
- **Page Errors**: Uncaught exceptions

### Usage in Decision Making:

- Passed to `analyzeLogic()` as `errorSignals`
- Used in `decideNextStep()` to determine if test should stop
- Displayed in test results

---

## Self-Healing Details

### When Triggered:

- **Line 1208**: When selector not found AND `failureCount === 1` (first failure only)
- **Not triggered**: If selector failed before (tracked in `selectorFailures` map)

### Process:

1. Call `SelfHealingService.healSelector()`
2. AI analyzes page and finds alternative selector
3. If found → update action selector, reset failure count
4. If not found → increment failure count, check threshold

### Retry Limit:

- Only once per selector (first failure)
- If still fails → mark as optional, skip action

---

## Form Intelligence Details

### When Used:

- **Line 1397**: When `options.useIntelligence === true` AND form has fields
- **Line 1807**: When post-action analysis detects validation errors

### Form Type Detection:

- Uses AI to analyze form structure
- Detects: registration, login, checkout, contact, etc.
- Confidence threshold: 0.7 (70%)

### Smart Fill Sequence:

- Analyzes field dependencies
- Generates fill order (required fields first)
- Handles wizard/multi-step forms
