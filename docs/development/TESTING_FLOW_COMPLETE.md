# Полный Flow: От сообщения юзера до тестинга

**Дата:** 2024-11-27
**Статус:** Документация текущего состояния

---

## 🎯 Обзор: 2 режима тестирования

1. **Autonomous Mode** (генерация теста из exploration)
2. **Intelligent Mode** (умное тестирование с AI)

---

## 📊 Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        USER SENDS MESSAGE                                │
│                   "Test login on https://app.com"                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 1: handleChat (chat.controller.ts)                                 │
│ ─────────────────────────────────────────────────────────────────────── │
│ • Parse user message with AI                                             │
│ • Detect intent: platform_test | api_test | general_chat               │
│ • Extract URL, scope, credentials                                       │
│ • Route to handler based on intent                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
        ┌───────────────────────────┼───────────────────────────┐
        ↓                           ↓                           ↓
  [API Test]              [Platform Test]              [General Chat]
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 2: handlePlatformTest (chat.controller.ts)                         │
│ ─────────────────────────────────────────────────────────────────────── │
│ • Validate URL & scope                                                   │
│ • Create/find project                                                    │
│ • Call runAutonomousExploration()                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 3: runAutonomousExploration (autonomous-orchestrator.service.ts)  │
│ ─────────────────────────────────────────────────────────────────────── │
│ 3.1. Parse answers (URL, scope, credentials)                            │
│ 3.2. Check cache (getCachedExploration)                                 │
│ 3.3. If NO cache → exploreProduct()                                     │
│ 3.4. If cache hit → use cached exploration                              │
│ 3.5. Generate test plan (generateTestPlan)                              │
│ 3.6. Save test plan to DB                                               │
│ 3.7. Return plan for USER APPROVAL                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 4: exploreProduct (autonomous-explorer.service.ts)                 │
│ ─────────────────────────────────────────────────────────────────────── │
│ 4.1. Launch browser (Playwright)                                        │
│ 4.2. Navigate to URL                                                    │
│ 4.3. Capture screenshot (full page)                                     │
│ 4.4. Analyze DOM structure (analyzeDOMStructure)                        │
│      ├── Extract buttons, links, inputs, forms                          │
│      └── Generate selectors (ID, class, aria-label, etc.)               │
│ 4.5. Analyze screenshot with GPT-4 Vision                               │
│      ├── Understand page type (login, product, checkout, etc.)          │
│      ├── Identify visual elements                                       │
│      └── Get suggestions                                                │
│ 4.6. Generate recommendations                                           │
│ 4.7. Close browser                                                      │
│ 4.8. Return ExplorationResult                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 5: generateTestPlan (autonomous-planner.service.ts)               │
│ ─────────────────────────────────────────────────────────────────────── │
│ • Use GPT-4 to generate test plan from exploration                      │
│ • Input: DOM analysis + Visual analysis + User message                  │
│ • Output: Array of test steps (click, fill, assert, etc.)              │
│ • Save plan to database                                                 │
│ • Status: "pending" (waiting for user approval)                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 6: USER APPROVES TEST PLAN                                         │
│ ─────────────────────────────────────────────────────────────────────── │
│ • User sees formatted test plan in chat                                 │
│ • User clicks "Approve" or sends approval message                       │
│ • Triggers: executeApprovedTestPlan()                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 7: executeApprovedTestPlan (chat.controller.ts)                   │
│ ─────────────────────────────────────────────────────────────────────── │
│ • Validate test plan                                                    │
│ • Check credits                                                          │
│ • Route to executeUiTestFlow() or executeApiTestFlow()                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
        ┌───────────────────────────┼───────────────────────────┐
        ↓                                                        ↓
[intelligentMode: false]                          [intelligentMode: true]
        ↓                                                        ↓
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ CLASSIC MODE                 │              │ INTELLIGENT MODE             │
│ (executePlaywrightTest)      │              │ (IntelligentTestOrchestrator)│
│                              │              │                              │
│ • Execute predefined steps   │              │ • AI-driven dynamic testing  │
│ • Use selectors from plan    │              │ • Contextual action gen      │
│ • No AI during execution     │              │ • Self-healing (NEW!)        │
└──────────────────────────────┘              └──────────────────────────────┘
                                                              ↓
                        ┌─────────────────────────────────────────────────┐
                        │ INTELLIGENT MODE FLOW (DETAILED)                │
                        └─────────────────────────────────────────────────┘
                                                ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 8: IntelligentTestOrchestrator.execute()                          │
│ ─────────────────────────────────────────────────────────────────────── │
│ 8.1. Initialize test state                                              │
│ 8.2. Launch browser & navigate to start URL                            │
│ 8.3. Enter main loop (while continueLoop)                              │
│      └── Loop iterations until goal achieved or limit reached           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 9: Main Loop Iteration (mainLoop)                                 │
│ ─────────────────────────────────────────────────────────────────────── │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ 9.1. ANALYZE PAGE (analyzePage)                                  │   │
│ │ ──────────────────────────────────────────────────────────────── │   │
│ │ • IntelligentPageAnalyzer.analyzePage()                          │   │
│ │   ├── waitForModals() - wait for cookie banners, etc. (2 sec)   │   │
│ │   ├── Capture screenshot (viewport)                              │   │
│ │   ├── analyzeDOMFull() - extract DOM structure                   │   │
│ │   │   └── Get buttons, inputs, links, forms with selectors       │   │
│ │   ├── Vision Analysis (GPT-4 Vision) - 11-12 sec                │   │
│ │   │   ├── Understand page type                                   │   │
│ │   │   ├── Identify visual elements                               │   │
│ │   │   └── Suggestions for testing                                │   │
│ │   ├── matchVisionElementsWithDOMSelectors()                      │   │
│ │   │   └── Match Vision AI elements with real DOM selectors       │   │
│ │   ├── analyzeLogic() - understand dependencies                   │   │
│ │   │   └── What actions are required vs optional                  │   │
│ │   └── Return PageContext (full page understanding)               │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ 9.2. CHECK CYCLES & PATTERNS                                     │   │
│ │ ──────────────────────────────────────────────────────────────── │   │
│ │ • StateTracker.detectCycle() - visited same URL too many times?  │   │
│ │ • ActionPatternDetector.detectPatterns() - repeated actions?     │   │
│ │ • If stuck → decide to skip or stop                              │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ 9.3. GENERATE ACTIONS (generateActions)                          │   │
│ │ ──────────────────────────────────────────────────────────────── │   │
│ │ • ContextualActionGenerator.generateActions()                    │   │
│ │   ├── Build prompt with:                                         │   │
│ │   │   ├── Page type & description                                │   │
│ │   │   ├── Available elements (with SELECTORS)                    │   │
│ │   │   ├── DOM summary (forms, buttons, inputs)                   │   │
│ │   │   ├── History (what was done before)                         │   │
│ │   │   └── Goal                                                    │   │
│ │   ├── Call GPT-4o (5 sec)                                        │   │
│ │   ├── Parse response (JSON)                                      │   │
│ │   ├── Sanitize actions                                           │   │
│ │   │   └── Remove unsafe actions (delete, payment, etc.)          │   │
│ │   └── Return DynamicAction[] (2-5 actions)                       │   │
│ │       Example action:                                             │   │
│ │       {                                                           │   │
│ │         action: "fill",                                           │   │
│ │         selector: "input[name='email']",  ← FROM DOM ANALYSIS    │   │
│ │         value: "test@example.com",                                │   │
│ │         description: "Fill email field"                           │   │
│ │       }                                                            │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ 9.4. EXECUTE ACTIONS (executeActions)                            │   │
│ │ ──────────────────────────────────────────────────────────────── │   │
│ │ For each action:                                                  │   │
│ │   ├── Validate selector exists on page                           │   │
│ │   ├── Execute via CommandExecutor                                │   │
│ │   │   └── CommandExecutor.executeCommand()                       │   │
│ │   │       ├── Try original selector                              │   │
│ │   │       ├── If fails → Self-Healing (NEW!)                     │   │
│ │   │       │   └── SelfHealingService.healSelector()              │   │
│ │   │       │       ├── Extract DOM nodes with boundingBox         │   │
│ │   │       │       ├── AI Selector Engine resolve                 │   │
│ │   │       │       ├── Get new selector                           │   │
│ │   │       │       ├── Test new selector                          │   │
│ │   │       │       └── Auto-apply if confidence ≥ 0.85           │   │
│ │   │       └── Return success/failure                             │   │
│ │   ├── Validate result (ResultValidator)                          │   │
│ │   │   └── Check expectedResult matches actual                    │   │
│ │   ├── Capture screenshot (before/after)                          │   │
│ │   ├── Update graph (GraphBuilder)                                │   │
│ │   └── Update state (StateTracker)                                │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ 9.5. DECIDE NEXT STEP (decideNextStep)                           │   │
│ │ ──────────────────────────────────────────────────────────────── │   │
│ │ • ContextualActionGenerator.decideNextStep()                     │   │
│ │   ├── Goal achieved? → STOP                                      │   │
│ │   ├── Stuck/errors? → SKIP or STOP                               │   │
│ │   ├── More to explore? → CONTINUE                                │   │
│ │   └── Return decision (continue/stop/skip)                       │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│ • If decision = CONTINUE → next iteration                               │
│ • If decision = STOP → exit loop                                        │
│ • Repeat until goal achieved or limits reached                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 10: Finalize Test Results                                          │
│ ─────────────────────────────────────────────────────────────────────── │
│ • Build test result summary                                             │
│ • Upload artifacts (screenshots, video, trace)                          │
│ • Save to database (test_sessions, test_results)                        │
│ • Deduct credits                                                         │
│ • Send response to user                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Детальные шаги по компонентам

### 1. Chat Entry Point (`chat.controller.ts`)

```typescript
handleChat()
├── Parse message with AI (intent detection)
├── Extract URL, scope, credentials
├── Route by intent:
│   ├── platform_test → handlePlatformTest()
│   ├── api_test → handleApiTest()
│   └── general_chat → handleGeneralChat()
```

### 2. Platform Test Handler (`chat.controller.ts`)

```typescript
handlePlatformTest()
├── Validate URL & scope
├── Create/find project
├── runAutonomousExploration()
│   ├── Parse answers
│   ├── Check cache
│   ├── exploreProduct() [if no cache]
│   │   ├── Launch browser
│   │   ├── Navigate to URL
│   │   ├── Capture screenshot
│   │   ├── analyzeDOMStructure()
│   │   ├── GPT-4 Vision analysis
│   │   └── Return ExplorationResult
│   ├── generateTestPlan()
│   │   ├── GPT-4 generates plan
│   │   └── Save to DB (status: pending)
│   └── Return formatted plan
├── Show plan to user
└── Wait for approval
```

### 3. Test Execution (after approval)

```typescript
executeApprovedTestPlan()
├── Validate plan
├── Check credits
└── executeUiTestFlow()
    ├── If intelligentMode = false:
    │   └── executePlaywrightTest() [Classic mode]
    │       └── Execute predefined steps
    │
    └── If intelligentMode = true:
        └── IntelligentTestOrchestrator.execute()
            └── Main Loop (while continueLoop):
                ├── analyzePage() → PageContext
                ├── generateActions() → DynamicAction[]
                ├── executeActions()
                │   └── For each action:
                │       ├── CommandExecutor.executeCommand()
                │       ├── If fails → Self-Healing
                │       └── Validate result
                ├── decideNextStep() → continue/stop
                └── Repeat
```

### 4. Page Analysis (Intelligent Mode)

```typescript
IntelligentPageAnalyzer.analyzePage()
├── waitForModals() [2 sec - оптимизирован]
├── Capture screenshot [0.2 sec]
├── analyzeDOMFull() [0.5 sec]
│   └── Extract: buttons, inputs, links, forms with selectors
├── Vision Analysis [11-12 sec]
│   ├── GPT-4 Vision API
│   ├── Understand page type
│   └── Identify elements
├── matchVisionElementsWithDOMSelectors() [1 sec - оптимизирован]
│   └── Match Vision elements with real selectors
├── analyzeLogic() [2.4 sec]
│   └── Understand dependencies (required vs optional actions)
└── Return PageContext
```

### 5. Action Generation

```typescript
ContextualActionGenerator.generateActions()
├── Build prompt:
│   ├── Page type & description
│   ├── Available elements (WITH SELECTORS!)  ← ВАЖНО!
│   ├── DOM summary
│   ├── History
│   └── Goal
├── Call GPT-4o [5 sec]
├── Parse JSON response
├── Sanitize actions (remove unsafe)
└── Return DynamicAction[]
```

**Пример промпта:**

```
Available Elements:
- Button "Login" | Selector: "button:has-text('Login')"
- Input email | Selector: "input[name='email']"
- Input password | Selector: "input[type='password']"

Generate actions to achieve goal: "Test login functionality"

Response (JSON):
{
  "actions": [
    {
      "action": "fill",
      "selector": "input[name='email']",  ← Использует селектор из DOM
      "value": "test@example.com"
    }
  ]
}
```

### 6. Command Execution (with Self-Healing)

```typescript
CommandExecutor.executeCommand()
├── Try original selector
├── If selector not found:
│   └── executeWithSelfHealing()
│       ├── SelfHealingService.healSelector()
│       │   ├── Extract DOM nodes (DOMNodeExtractor)
│       │   ├── AI Selector Engine resolve
│       │   │   ├── Parse intent from action.description
│       │   │   ├── Find candidates
│       │   │   ├── Score candidates
│       │   │   ├── Generate selectors (priority order)
│       │   │   └── Return best selector
│       │   ├── Test new selector
│       │   └── Auto-apply if confidence ≥ 0.85
│       └── Retry with new selector
└── Return result
```

---

## ⏱️ Время выполнения (на страницу)

### Было (до оптимизации):
- Modal Waiting: 5 сек
- DOM Analysis: 0.5 сек
- Vision Analysis: 11-12 сек
- Match Vision-DOM: 1 сек
- Logic Analysis: 2.4 сек
- Action Generation: 5 сек
- Execute Actions: 2 сек
- Delays: 1.5 сек
- **ИТОГО: ~28 секунд**

### Стало (после оптимизации):
- Modal Waiting: 0.5-1.5 сек ✅
- DOM Analysis: 0.5 сек
- Vision Analysis: 11-12 сек (или skip для простых страниц)
- Match Vision-DOM: 0.5 сек ✅
- Logic Analysis: 2.4 сек
- Action Generation: 5 сек
- Execute Actions: 2 сек
- Delays: 0 сек ✅
- **ИТОГО: ~22-23 секунды** (или 11-12 сек без Vision)

---

## 🔑 Ключевые места для AI Selector Engine

### Вариант A: В ContextualActionGenerator
**Где:** `src/agent/contextual-action-generator.ts:generateActions()`
**Что делать:**
- ПЕРЕД вызовом GPT-4o
- Извлечь DOM nodes через DOMNodeExtractor
- Для каждого элемента получить лучший селектор через AI Selector Engine
- Передать в промпт GPT точные селекторы

**Плюсы:**
- GPT сразу получает лучшие селекторы
- Один раз на генерацию actions
- Меньше изменений в коде

**Минусы:**
- Только для action generation
- Повторяет часть работы analyzeDOMFull()

---

### Вариант B: В IntelligentPageAnalyzer
**Где:** `src/agent/intelligent-page-analyzer.ts:analyzePage()`
**Что делать:**
- Во время analyzeDOMFull()
- Для каждого элемента (button, input, link) получить лучший селектор
- Сохранить в PageContext
- Все компоненты используют эти селекторы

**Плюсы:**
- Один раз на страницу
- Кэшируется в PageContext
- Все компоненты получают лучшие селекторы
- Меньше изменений downstream

**Минусы:**
- Больше времени на analyzePage
- Больше изменений в analyzer

---

### Вариант C: Hybrid
**Где:** Оба места
**Что делать:**
- В IntelligentPageAnalyzer: для критичных элементов (buttons, key inputs)
- В ContextualActionGenerator: для специфичных intent

**Плюсы:**
- Лучшее из двух миров

**Минусы:**
- Сложнее поддерживать

---

## 🎯 Рекомендация

**Начать с Варианта B** - добавить в `IntelligentPageAnalyzer.analyzePage()`:

1. Меньше дублирования
2. Кэшируется результат
3. Все компоненты получают лучшие селекторы
4. Проще тестировать

---

**Дата создания:** 2024-11-27
