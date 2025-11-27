# QAIT Architecture Plan - Полная спецификация

**Дата:** 2024-11-27
**Статус:** 📋 Планирование
**Цель:** Спроектировать архитектуру AI-платформы для E2E-тестирования согласно спецификации

---

## 📊 Текущий статус vs Требования

### ✅ Что УЖЕ есть

| Компонент | Статус | Файл | Примечания |
|-----------|--------|------|------------|
| **TestRunEngine** | ✅ Частично | `IntelligentTestOrchestrator` | Есть основной движок, но нет универсальной абстракции |
| **AI Action** | ✅ Есть | `ContextualActionGenerator` | Генерирует подшаги из goal |
| **AI Check** | ⚠️ Частично | `ResultValidator` | Есть валидация, но нет семантических ассертов |
| **Primitive Steps** | ✅ Есть | `CommandExecutor` | 20+ действий (click, fill, type, etc.) |
| **Smart Waiting** | ⚠️ Частично | `RequestTracker` | Есть для network, нет универсального |
| **Network Tracking** | ✅ Есть | `ResultCollector` | Собирает requests/responses |
| **Screenshot** | ✅ Есть | `IntelligentPageAnalyzer` | Скриншоты для Vision AI |
| **Browser Pool** | ✅ Есть | `browser-pool.ts` | Управление браузерами |
| **WebSocket Progress** | ✅ Есть | `websocket.service.ts` | Real-time обновления |

### ❌ Чего НЕТ (требуется реализовать)

| Компонент | Приоритет | Сложность | Оценка |
|-----------|-----------|-----------|--------|
| **TestRunEngine (универсальный)** | 🔴 Критично | Средняя | 8-12ч |
| **AI Extract** | 🔴 Критично | Средняя | 6-8ч |
| **AI Check (семантический)** | 🔴 Критично | Средняя | 6-8ч |
| **Visual Diff** | 🟡 Высокий | Высокая | 10-12ч |
| **Save/Load Auth State** | 🟡 Высокий | Низкая | 4-6ч |
| **Auto-healing локаторов** | 🔴 Критично | Высокая | 12-16ч |
| **Memory (AI решений)** | 🔴 Критично | Высокая | 16-20ч |
| **JavaScript Step** | 🟢 Средний | Низкая | 4-6ч |
| **JSON/YAML DSL** | 🔴 Критично | Средняя | 8-10ч |
| **CLI** | 🟡 Высокий | Средняя | 10-12ч |
| **Cloud Runtime API** | 🟡 Высокий | Средняя | 8-10ч |

**ИТОГО:** ~100-120 часов разработки

---

## 🏗️ Архитектура решения

### 1. TestRunEngine - Универсальный движок

#### 1.1. Абстракция

```typescript
// src/agent/test-run-engine.ts

export class TestRunEngine {
  private browser: Browser;
  private page: Page;
  private context: TestRunContext;
  private memory: MemoryService;
  private autoHealer: AutoHealerService;
  private smartWaiter: SmartWaiterService;

  /**
   * Execute test from DSL
   */
  async executeTest(test: TestDefinition): Promise<TestResult>;

  /**
   * Execute single step
   */
  private async executeStep(step: TestStep): Promise<StepResult>;

  /**
   * Handle step types
   */
  private async executeAiStep(step: AiStep): Promise<StepResult>;
  private async executePrimitiveStep(step: PrimitiveStep): Promise<StepResult>;
  private async executeAdvancedStep(step: AdvancedStep): Promise<StepResult>;
}
```

#### 1.2. Контекст прогона

```typescript
interface TestRunContext {
  // Current state
  currentPage: Page;
  currentUrl: string;
  activeTab: number;

  // Storage
  cookies: Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;

  // Network
  networkRequests: NetworkRequest[];
  networkMocks: RouteMock[];

  // Screenshots & logs
  screenshots: Screenshot[];
  consoleLogs: ConsoleLog[];
  jsErrors: JavaScriptError[];

  // Variables (для extract и ссылок)
  variables: Map<string, any>;
  secrets: Map<string, string>; // Логины, пароли, baseUrl

  // History
  stepHistory: StepResult[];
  pageHistory: PageVisit[];
}
```

#### 1.3. Типы шагов

```typescript
type TestStep = AiStep | PrimitiveStep | AdvancedStep;

interface BaseStep {
  id?: string;
  type: string;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  description?: string;
}

interface AiStep extends BaseStep {
  type: 'ai_action' | 'ai_check' | 'ai_extract';
  goal: string; // Для ai_action
  checkDescription?: string; // Для ai_check
  extractSchema?: JSONSchema; // Для ai_extract
}

interface PrimitiveStep extends BaseStep {
  type: 'click' | 'fill' | 'type' | 'navigate' | 'wait' | ...;
  selector?: string;
  value?: string | number;
  url?: string;
  // ... специфичные параметры
}

interface AdvancedStep extends BaseStep {
  type: 'javascript' | 'visual_diff' | 'save_auth' | 'load_auth';
  script?: string; // Для javascript
  baseline?: string; // Для visual_diff
  authFile?: string; // Для save/load_auth
}
```

---

### 2. AI Steps - Детальная реализация

#### 2.1. AI Action (goal → план подшагов)

**Текущее состояние:** ✅ Есть `ContextualActionGenerator.generateActions()`

**Что улучшить:**

```typescript
// src/agent/ai-steps/ai-action-step.ts

export class AiActionStep {
  /**
   * Execute AI action step
   * Goal → Plan → Execute sub-steps
   */
  static async execute(
    goal: string,
    context: TestRunContext,
    memory: MemoryService
  ): Promise<AiActionResult> {
    // 1. Search Memory for similar goals
    const similarPlans = await memory.searchSimilarGoals(goal, context.currentUrl);

    // 2. Build prompt with Memory examples (few-shot)
    const prompt = this.buildActionPrompt(goal, context, similarPlans);

    // 3. Call LLM planner (GPT-4o)
    const plan = await this.callLLMPlanner(prompt);

    // 4. Validate plan (check step types, selectors)
    const validatedPlan = this.validatePlan(plan);

    // 5. Execute sub-steps sequentially
    const results = await this.executeSubSteps(validatedPlan, context);

    // 6. Save to Memory if successful
    if (results.success) {
      await memory.saveSuccessfulPlan(goal, context, validatedPlan, results);
    }

    return results;
  }

  /**
   * Build prompt for LLM planner
   */
  private static buildActionPrompt(
    goal: string,
    context: TestRunContext,
    similarPlans: MemoryPlan[]
  ): string {
    return `
You are an expert QA automation engineer. Generate a test plan to achieve this goal:

GOAL: ${goal}

CURRENT PAGE CONTEXT:
- URL: ${context.currentUrl}
- Title: ${await context.currentPage.title()}
- DOM Summary: ${this.compressDOM(context.currentPage)}
- Available Elements: ${this.listElements(context.currentPage)}
- Previous Steps: ${context.stepHistory.slice(-5).map(s => s.description).join(', ')}

AVAILABLE STEP TYPES:
${this.listAvailableStepTypes()}

${similarPlans.length > 0 ? `
SIMILAR SUCCESSFUL PLANS (use as examples):
${similarPlans.map(p => `Goal: ${p.goal}\nPlan: ${JSON.stringify(p.plan, null, 2)}`).join('\n\n')}
` : ''}

CONSTRAINTS:
- Maximum 15 sub-steps
- Use only available step types
- Each step must have valid selector (if needed)
- Consider auto-healing (selectors may change)

Return JSON:
{
  "plan": [
    {
      "type": "click",
      "selector": "button.login",
      "description": "Click login button",
      "timeout": 10000
    },
    ...
  ],
  "reasoning": "Why this plan achieves the goal",
  "confidence": 0.85
}
`;
  }

  /**
   * Validate plan from LLM
   */
  private static validatePlan(plan: any): ValidatedPlan {
    const validated: ValidatedPlan = {
      steps: [],
      errors: [],
    };

    for (const step of plan.plan || []) {
      // Check step type is valid
      if (!this.isValidStepType(step.type)) {
        validated.errors.push(`Invalid step type: ${step.type}`);
        continue;
      }

      // Check required fields
      if (this.requiresSelector(step.type) && !step.selector) {
        validated.errors.push(`Step ${step.type} requires selector`);
        continue;
      }

      // Sanitize and add
      validated.steps.push({
        ...step,
        timeout: step.timeout || 10000,
        retryPolicy: step.retryPolicy || { maxRetries: 3, retryDelay: 1000 },
      });
    }

    return validated;
  }

  /**
   * Execute sub-steps with auto-healing and smart waiting
   */
  private static async executeSubSteps(
    plan: ValidatedPlan,
    context: TestRunContext
  ): Promise<AiActionResult> {
    const results: StepResult[] = [];
    let success = true;

    for (const step of plan.steps) {
      try {
        // Apply smart waiting before step
        await SmartWaiterService.waitForStep(step, context);

        // Execute with auto-healing
        const result = await AutoHealerService.executeWithHealing(
          step,
          context,
          this.memory
        );

        results.push(result);

        if (!result.success) {
          // Try error recovery
          const recovered = await this.recoverFromError(step, result, context);
          if (!recovered) {
            success = false;
            break; // Stop if critical step fails
          }
        }

        // Update context after step
        context = this.updateContextAfterStep(context, result);
      } catch (error) {
        success = false;
        results.push({
          step,
          success: false,
          error: error.message,
        });
        break;
      }
    }

    return {
      success,
      steps: results,
      totalSteps: plan.steps.length,
      successfulSteps: results.filter(r => r.success).length,
    };
  }

  /**
   * Error recovery strategies
   */
  private static async recoverFromError(
    step: ValidatedStep,
    result: StepResult,
    context: TestRunContext
  ): Promise<boolean> {
    // Strategy 1: Try alternative selector (auto-healing)
    if (result.error?.includes('not found')) {
      const alternative = await AutoHealerService.findAlternativeSelector(
        step.selector,
        step.type,
        context
      );
      if (alternative) {
        step.selector = alternative;
        return true; // Retry with new selector
      }
    }

    // Strategy 2: Simplify plan (remove failed step if optional)
    if (step.optional) {
      return true; // Skip optional step
    }

    // Strategy 3: Rollback to previous state
    if (context.stepHistory.length > 0) {
      const previousState = context.stepHistory[context.stepHistory.length - 1];
      // Restore context to previous state
      return true;
    }

    return false; // Cannot recover
  }
}
```

**Оценка:** 8-12 часов

---

#### 2.2. AI Check (семантический ассерт)

**Текущее состояние:** ⚠️ Есть `ResultValidator`, но нет семантических проверок

**Реализация:**

```typescript
// src/agent/ai-steps/ai-check-step.ts

export class AiCheckStep {
  /**
   * Execute AI check step
   * Semantic assertion using LLM
   */
  static async execute(
    checkDescription: string,
    context: TestRunContext,
    baseline?: any // Optional baseline for comparison
  ): Promise<AiCheckResult> {
    // 1. Capture current state
    const currentState = await this.captureState(context);

    // 2. Build prompt for LLM
    const prompt = this.buildCheckPrompt(
      checkDescription,
      currentState,
      baseline
    );

    // 3. Call LLM for semantic check
    const llmResult = await this.callLLMCheck(prompt);

    // 4. Return structured result
    return {
      passed: llmResult.verdict === 'pass',
      verdict: llmResult.verdict,
      explanation: llmResult.explanation,
      findings: llmResult.findings,
      confidence: llmResult.confidence,
      screenshot: currentState.screenshot,
    };
  }

  /**
   * Capture current page state
   */
  private static async captureState(context: TestRunContext): Promise<PageState> {
    const page = context.currentPage;

    // Parallel capture
    const [screenshot, dom, text, url] = await Promise.all([
      page.screenshot({ fullPage: false, type: 'png' }),
      page.content(),
      page.textContent('body'),
      page.url(),
    ]);

    return {
      screenshot: screenshot.toString('base64'),
      dom: this.compressDOM(dom),
      text: text?.substring(0, 5000), // Limit text
      url,
      timestamp: Date.now(),
    };
  }

  /**
   * Build prompt for LLM check
   */
  private static buildCheckPrompt(
    checkDescription: string,
    currentState: PageState,
    baseline?: any
  ): string {
    return `
You are an expert QA engineer performing semantic assertions.

CHECK DESCRIPTION: ${checkDescription}

CURRENT PAGE STATE:
- URL: ${currentState.url}
- Text Content: ${currentState.text}
- DOM Structure: ${currentState.dom}

${baseline ? `
BASELINE (for comparison):
${JSON.stringify(baseline, null, 2)}
` : ''}

Analyze if the check description is satisfied by the current page state.

Return JSON:
{
  "verdict": "pass" | "fail",
  "explanation": "Detailed explanation of why pass/fail",
  "findings": [
    {
      "type": "element_found" | "text_matches" | "visual_match" | "error_detected",
      "description": "What was found",
      "severity": "info" | "warning" | "error"
    }
  ],
  "confidence": 0.95
}
`;
  }
}
```

**Оценка:** 6-8 часов

---

#### 2.3. AI Extract (извлечение данных)

**Текущее состояние:** ❌ Нет

**Реализация:**

```typescript
// src/agent/ai-steps/ai-extract-step.ts

export class AiExtractStep {
  /**
   * Execute AI extract step
   * Extract structured data from page using LLM
   */
  static async execute(
    extractDescription: string,
    schema: JSONSchema,
    context: TestRunContext
  ): Promise<AiExtractResult> {
    // 1. Capture page state
    const pageState = await this.captureState(context);

    // 2. Build prompt with schema
    const prompt = this.buildExtractPrompt(
      extractDescription,
      schema,
      pageState
    );

    // 3. Call LLM with JSON schema constraint
    const extracted = await this.callLLMExtract(prompt, schema);

    // 4. Validate against schema
    const validated = this.validateAgainstSchema(extracted, schema);

    // 5. Save to context variables
    context.variables.set('extracted', validated.data);

    return {
      success: validated.valid,
      data: validated.data,
      errors: validated.errors,
    };
  }

  /**
   * Build extract prompt
   */
  private static buildExtractPrompt(
    description: string,
    schema: JSONSchema,
    state: PageState
  ): string {
    return `
Extract structured data from this page according to the description and schema.

DESCRIPTION: ${description}

SCHEMA:
${JSON.stringify(schema, null, 2)}

PAGE STATE:
- URL: ${state.url}
- Text: ${state.text}
- DOM: ${state.dom}

Extract data matching the schema. Return ONLY valid JSON matching the schema.
`;
  }

  /**
   * Call LLM with JSON schema constraint
   */
  private static async callLLMExtract(
    prompt: string,
    schema: JSONSchema
  ): Promise<any> {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a data extraction expert. Extract structured data from web pages.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${state.screenshot}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extracted_data',
          schema: schema,
          strict: true,
        },
      },
      temperature: 0.1, // Low temperature for consistent extraction
    });

    return JSON.parse(response.choices[0].message.content);
  }
}
```

**Пример использования:**

```yaml
steps:
  - type: ai_extract
    description: "Extract list of products with name, price, and availability"
    schema:
      type: object
      properties:
        products:
          type: array
          items:
            type: object
            properties:
              name: { type: string }
              price: { type: number }
              available: { type: boolean }
    saveTo: "products"
```

**Оценка:** 6-8 часов

---

### 3. Primitive Steps - Расширение

**Текущее состояние:** ✅ Есть 20+ действий в `CommandExecutor`

**Что добавить:**

```typescript
// Расширить PlaywrightActionType в src/types/index.ts

export type PlaywrightActionType =
  // ... существующие
  | 'element_check'      // ✅ NEW: Check element exists/visible
  | 'page_check'         // ✅ NEW: Check page properties
  | 'key_down'           // ✅ NEW: Key down
  | 'key_up'             // ✅ NEW: Key up
  | 'drag_and_drop'      // ✅ NEW: Drag and drop
  | 'switch_tab'         // ✅ NEW: Switch between tabs
  | 'new_tab'            // ✅ NEW: Open new tab
  | 'copy'               // ✅ NEW: Copy to clipboard
  | 'paste'              // ✅ NEW: Paste from clipboard
  | 'set_header'         // ✅ NEW: Set request header
  | 'register_listener'  // ✅ NEW: Register network listener
  | 'await_listener'     // ✅ NEW: Wait for network event
  | 'record_requests'    // ✅ NEW: Start recording
  | 'get_requests'       // ✅ NEW: Get recorded requests
  | 'mock_route'         // ✅ NEW: Mock network route
  | 'remove_mock';       // ✅ NEW: Remove mock
```

**Реализация в CommandExecutor:**

```typescript
// src/agent/command-executor.ts (расширение)

case 'element_check':
  const exists = await this.page.locator(selector).count() > 0;
  const visible = exists && await this.page.locator(selector).first().isVisible();
  return { success: exists && visible };

case 'page_check':
  const checks = command.checks || [];
  const results: Record<string, boolean> = {};
  for (const check of checks) {
    if (check.type === 'title') {
      results.title = (await this.page.title()).includes(check.expected);
    } else if (check.type === 'url') {
      results.url = this.page.url().includes(check.expected);
    }
  }
  return { success: Object.values(results).every(v => v) };

case 'mock_route':
  await this.page.route(command.urlPattern, (route) => {
    route.fulfill({
      status: command.mockResponse?.status || 200,
      body: JSON.stringify(command.mockResponse?.body || {}),
    });
  });
  return { success: true };

// ... остальные
```

**Оценка:** 4-6 часов

---

### 4. Advanced Steps

#### 4.1. JavaScript Step

```typescript
// src/agent/advanced-steps/javascript-step.ts

export class JavaScriptStep {
  static async execute(
    script: string,
    context: TestRunContext
  ): Promise<JavaScriptResult> {
    try {
      // Execute in page context with access to context variables
      const result = await context.currentPage.evaluate(
        (script, contextVars) => {
          // Inject context variables
          Object.assign(window, contextVars);

          // Execute script
          return eval(script);
        },
        script,
        Object.fromEntries(context.variables)
      );

      return {
        success: true,
        result,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
```

**Пример:**

```yaml
steps:
  - type: javascript
    script: |
      // Read Redux state
      const state = window.__REDUX_STORE__.getState();
      return state.user.isAuthenticated;
    saveTo: "isAuthenticated"
```

**Оценка:** 4-6 часов

---

#### 4.2. Visual Diff Step

```typescript
// src/agent/advanced-steps/visual-diff-step.ts

export class VisualDiffStep {
  static async execute(
    baseline: string, // URL to baseline screenshot
    context: TestRunContext,
    options: {
      threshold?: number; // 0-1, default 0.1
      maskRegions?: Array<{ x: number; y: number; width: number; height: number }>;
    }
  ): Promise<VisualDiffResult> {
    // 1. Capture current screenshot
    const current = await context.currentPage.screenshot({ fullPage: false });

    // 2. Load baseline
    const baselineBuffer = await this.loadBaseline(baseline);

    // 3. Compare using pixel-diff or perceptual algorithm
    const diff = await this.compareImages(
      baselineBuffer,
      current,
      options
    );

    // 4. Generate diff image
    const diffImage = await this.generateDiffImage(baselineBuffer, current, diff);

    return {
      passed: diff.difference < (options.threshold || 0.1),
      difference: diff.difference, // 0-1
      diffImage: diffImage.toString('base64'),
      changedPixels: diff.changedPixels,
      totalPixels: diff.totalPixels,
    };
  }

  /**
   * Compare images using pixel-diff
   */
  private static async compareImages(
    baseline: Buffer,
    current: Buffer,
    options: any
  ): Promise<DiffResult> {
    // Use pixelmatch or similar library
    const { default: pixelmatch } = await import('pixelmatch');
    const { default: PNG } = await import('pngjs');

    const img1 = PNG.sync.read(baseline);
    const img2 = PNG.sync.read(current);

    const diff = new PNG({ width: img1.width, height: img1.height });
    const numDiffPixels = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      img1.width,
      img1.height,
      {
        threshold: 0.1,
      }
    );

    return {
      difference: numDiffPixels / (img1.width * img1.height),
      changedPixels: numDiffPixels,
      totalPixels: img1.width * img1.height,
    };
  }
}
```

**Оценка:** 10-12 часов

---

#### 4.3. Save/Load Auth State

```typescript
// src/agent/advanced-steps/auth-state-step.ts

export class AuthStateStep {
  /**
   * Save authentication state
   */
  static async save(
    filePath: string,
    context: TestRunContext
  ): Promise<AuthStateResult> {
    // 1. Get cookies
    const cookies = await context.currentPage.context().cookies();

    // 2. Get localStorage
    const localStorage = await context.currentPage.evaluate(() => {
      const storage: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key) {
          storage[key] = window.localStorage.getItem(key) || '';
        }
      }
      return storage;
    });

    // 3. Get sessionStorage
    const sessionStorage = await context.currentPage.evaluate(() => {
      const storage: Record<string, string> = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key) {
          storage[key] = window.sessionStorage.getItem(key) || '';
        }
      }
      return storage;
    });

    // 4. Save to file
    const authState = {
      cookies,
      localStorage,
      sessionStorage,
      url: context.currentUrl,
      timestamp: Date.now(),
    };

    await fs.writeFile(filePath, JSON.stringify(authState, null, 2));

    return {
      success: true,
      filePath,
    };
  }

  /**
   * Load authentication state
   */
  static async load(
    filePath: string,
    context: TestRunContext
  ): Promise<AuthStateResult> {
    // 1. Read file
    const authState = JSON.parse(await fs.readFile(filePath, 'utf-8'));

    // 2. Set cookies
    await context.currentPage.context().addCookies(authState.cookies);

    // 3. Set localStorage
    await context.currentPage.evaluate((storage) => {
      for (const [key, value] of Object.entries(storage)) {
        window.localStorage.setItem(key, value);
      }
    }, authState.localStorage);

    // 4. Set sessionStorage
    await context.currentPage.evaluate((storage) => {
      for (const [key, value] of Object.entries(storage)) {
        window.sessionStorage.setItem(key, value);
      }
    }, authState.sessionStorage);

    // 5. Navigate to saved URL (if different)
    if (context.currentUrl !== authState.url) {
      await context.currentPage.goto(authState.url);
    }

    return {
      success: true,
    };
  }
}
```

**Оценка:** 4-6 часов

---

### 5. Auto-healing локаторов

**Текущее состояние:** ❌ Нет

**Реализация:**

```typescript
// src/agent/auto-healing/auto-healer.service.ts

export class AutoHealerService {
  private stepCache: Map<string, LocatorCache> = new Map();
  private memory: MemoryService;

  /**
   * Execute step with auto-healing
   */
  static async executeWithHealing(
    step: TestStep,
    context: TestRunContext,
    memory: MemoryService
  ): Promise<StepResult> {
    // 1. Try original selector
    try {
      return await this.executeStep(step, context);
    } catch (error) {
      // 2. Element not found - try healing
      if (error.message.includes('not found')) {
        return await this.healAndRetry(step, context, memory);
      }
      throw error;
    }
  }

  /**
   * Heal selector and retry
   */
  private static async healAndRetry(
    step: TestStep,
    context: TestRunContext,
    memory: MemoryService
  ): Promise<StepResult> {
    // 1. Search cache for this step
    const cached = this.stepCache.get(step.id || step.description);
    if (cached && cached.successfulSelector) {
      // Try cached selector
      step.selector = cached.successfulSelector;
      try {
        const result = await this.executeStep(step, context);
        // Update cache
        this.updateCache(step, cached.successfulSelector, true);
        return result;
      } catch {
        // Cached selector also failed, continue to search
      }
    }

    // 2. Search Memory for similar successful selectors
    const similar = await memory.searchSimilarSelectors(
      step.selector,
      step.type,
      context.currentUrl
    );
    for (const candidate of similar) {
      step.selector = candidate.selector;
      try {
        const result = await this.executeStep(step, context);
        // Save to cache and memory
        this.updateCache(step, candidate.selector, true);
        await memory.saveSuccessfulSelector(step, candidate.selector, context);
        return result;
      } catch {
        continue;
      }
    }

    // 3. Use embedding/LLM to find similar element
    const candidates = await this.findCandidatesByEmbedding(
      step.selector,
      step.type,
      context
    );
    for (const candidate of candidates) {
      step.selector = candidate.selector;
      try {
        const result = await this.executeStep(step, context);
        // Save to cache and memory
        this.updateCache(step, candidate.selector, true);
        await memory.saveSuccessfulSelector(step, candidate.selector, context);
        return result;
      } catch {
        continue;
      }
    }

    // 4. Fallback: Use classic strategies (text, role, aria-label)
    const fallback = await this.findByClassicStrategies(step, context);
    if (fallback) {
      step.selector = fallback;
      const result = await this.executeStep(step, context);
      this.updateCache(step, fallback, true);
      return result;
    }

    // All strategies failed
    throw new Error(`Cannot find element for step: ${step.description}`);
  }

  /**
   * Find candidates using embedding/LLM
   */
  private static async findCandidatesByEmbedding(
    originalSelector: string,
    elementType: string,
    context: TestRunContext
  ): Promise<Array<{ selector: string; similarity: number }>> {
    // 1. Get DOM context around original selector
    const domContext = await this.getDOMContext(originalSelector, context);

    // 2. Use LLM to find similar elements
    const prompt = `
Find elements similar to this selector in the DOM:

ORIGINAL SELECTOR: ${originalSelector}
ELEMENT TYPE: ${elementType}
DOM CONTEXT: ${domContext}

Return array of alternative selectors with similarity scores.
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a selector expert.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    const candidates = JSON.parse(response.choices[0].message.content);
    return candidates.alternatives || [];
  }
}
```

**Оценка:** 12-16 часов

---

### 6. Smart Waiting

**Текущее состояние:** ⚠️ Частично (только для network)

**Реализация:**

```typescript
// src/agent/smart-waiting/smart-waiter.service.ts

export class SmartWaiterService {
  /**
   * Wait intelligently before step execution
   */
  static async waitForStep(
    step: TestStep,
    context: TestRunContext
  ): Promise<void> {
    // 1. Wait for page load (if navigation step)
    if (step.type === 'goto' || step.type === 'navigate') {
      await context.currentPage.waitForLoadState('domcontentloaded');
    }

    // 2. Wait for network idle (if step needs data)
    if (this.needsNetworkData(step)) {
      await this.waitForNetworkIdle(context, 5000); // Max 5s
    }

    // 3. Wait for element (if step has selector)
    if (step.selector) {
      await this.waitForElement(step.selector, context, step.timeout);
    }

    // 4. Wait for URL (if step expects URL change)
    if (step.expectedUrl) {
      await this.waitForURL(step.expectedUrl, context, step.timeout);
    }

    // 5. Wait for custom condition (if specified)
    if (step.waitCondition) {
      await this.waitForCondition(step.waitCondition, context, step.timeout);
    }
  }

  /**
   * Wait for network idle (smart - only API requests)
   */
  private static async waitForNetworkIdle(
    context: TestRunContext,
    maxWait: number
  ): Promise<void> {
    const startTime = Date.now();
    let lastRequestTime = Date.now();

    return new Promise((resolve) => {
      const checkIdle = () => {
        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;

        // If no requests for 500ms, consider idle
        if (timeSinceLastRequest > 500) {
          resolve();
          return;
        }

        // If max wait exceeded, resolve anyway
        if (now - startTime > maxWait) {
          resolve();
          return;
        }

        setTimeout(checkIdle, 100);
      };

      // Track requests
      context.currentPage.on('request', () => {
        lastRequestTime = Date.now();
      });

      checkIdle();
    });
  }
}
```

**Оценка:** 4-6 часов

---

### 7. Memory (память AI решений)

**Текущее состояние:** ❌ Нет

**Реализация:**

```typescript
// src/services/memory/memory.service.ts

export class MemoryService {
  /**
   * Search for similar successful plans
   */
  async searchSimilarGoals(
    goal: string,
    url: string
  ): Promise<MemoryPlan[]> {
    // 1. Search by goal embedding
    const goalEmbedding = await this.embedText(goal);
    const similar = await this.vectorSearch(goalEmbedding, {
      limit: 5,
      threshold: 0.7,
    });

    // 2. Filter by URL similarity
    const filtered = similar.filter(p =>
      this.urlSimilarity(p.url, url) > 0.8
    );

    return filtered;
  }

  /**
   * Save successful plan to memory
   */
  async saveSuccessfulPlan(
    goal: string,
    context: TestRunContext,
    plan: ValidatedPlan,
    results: AiActionResult
  ): Promise<void> {
    // 1. Compress context (remove screenshots, keep structure)
    const compressedContext = this.compressContext(context);

    // 2. Create memory entry
    const entry: MemoryEntry = {
      id: randomUUID(),
      goal,
      url: context.currentUrl,
      goalEmbedding: await this.embedText(goal),
      pageEmbedding: await this.embedText(compressedContext.dom),
      plan,
      results,
      context: compressedContext,
      createdAt: new Date(),
      ttl: 30, // days
    };

    // 3. Save to database (with vector index)
    await this.saveToDatabase(entry);
  }

  /**
   * Vector search using embeddings
   */
  private async vectorSearch(
    queryEmbedding: number[],
    options: { limit: number; threshold: number }
  ): Promise<MemoryPlan[]> {
    // Use Supabase pgvector or similar
    const { data } = await supabaseAdmin.rpc('search_memory', {
      query_embedding: queryEmbedding,
      match_threshold: options.threshold,
      match_count: options.limit,
    });

    return data || [];
  }
}
```

**Database schema:**

```sql
-- supabase-migrations/features/ai-memory.sql

CREATE TABLE ai_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  project_id TEXT,

  -- Goal and context
  goal TEXT NOT NULL,
  goal_embedding VECTOR(1536), -- OpenAI embedding
  url TEXT,
  page_embedding VECTOR(1536),

  -- Plan and results
  plan JSONB NOT NULL,
  results JSONB,
  context JSONB, -- Compressed context

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '30 days'),
  hit_count INTEGER DEFAULT 0,

  -- Indexes
  INDEX idx_goal_embedding USING ivfflat (goal_embedding vector_cosine_ops),
  INDEX idx_page_embedding USING ivfflat (page_embedding vector_cosine_ops),
  INDEX idx_url (url),
  INDEX idx_expires (expires_at)
);
```

**Оценка:** 16-20 часов

---

### 8. JSON/YAML DSL формат

**Реализация:**

```typescript
// src/agent/dsl/test-dsl-parser.ts

export interface TestDefinition {
  // Metadata
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  timeout?: number;

  // Configuration
  browser?: 'chrome' | 'firefox' | 'safari';
  viewport?: { width: number; height: number };
  baseUrl?: string;

  // Variables and secrets
  variables?: Record<string, any>;
  secrets?: Record<string, string>; // References to stored secrets

  // Steps
  steps: TestStep[];

  // Hooks
  beforeAll?: TestStep[];
  afterAll?: TestStep[];
  beforeEach?: TestStep[];
  afterEach?: TestStep[];
}

// Parser
export class TestDSLParser {
  static parse(jsonOrYaml: string): TestDefinition {
    // Parse JSON or YAML
    const parsed = jsonOrYaml.startsWith('{')
      ? JSON.parse(jsonOrYaml)
      : yaml.parse(jsonOrYaml);

    // Validate schema
    this.validateSchema(parsed);

    // Resolve variables and secrets
    return this.resolveReferences(parsed);
  }
}
```

**Пример теста:**

```yaml
# test.yaml
name: "Login and Check Dashboard"
description: "Test login flow and verify dashboard"
browser: chrome
baseUrl: "https://example.com"
timeout: 60000

variables:
  username: "test@example.com"

secrets:
  password: "secret:password" # Reference to stored secret

steps:
  # AI Action
  - type: ai_action
    goal: "Login as test@example.com"
    id: "login"

  # Primitive check
  - type: element_check
    selector: ".user-profile"
    description: "Verify user is logged in"

  # AI Check
  - type: ai_check
    description: "Dashboard should show welcome message with user name"

  # AI Extract
  - type: ai_extract
    description: "Extract user profile data"
    schema:
      type: object
      properties:
        name: { type: string }
        email: { type: string }
        role: { type: string }
    saveTo: "userProfile"

  # Visual Diff
  - type: visual_diff
    baseline: "screenshots/dashboard-baseline.png"
    threshold: 0.05

  # JavaScript
  - type: javascript
    script: |
      const state = window.__REDUX_STORE__.getState();
      return state.user.isAuthenticated === true;
    saveTo: "isAuthenticated"

  # Assert using extracted data
  - type: assert
    condition: "{{userProfile.role}} === 'admin'"
```

**Оценка:** 8-10 часов

---

### 9. CLI и Cloud Runtime

#### 9.1. CLI

```typescript
// cli/qait.ts

import { Command } from 'commander';
import { TestRunEngine } from '../src/agent/test-run-engine';
import { TestDSLParser } from '../src/agent/dsl/test-dsl-parser';

const program = new Command();

program
  .name('qait')
  .description('QAIT - AI-powered E2E testing platform')
  .version('1.0.0');

program
  .command('run')
  .description('Run test from file')
  .argument('<file>', 'Test file (JSON/YAML)')
  .option('-c, --config <path>', 'Config file path', 'qait.config.yaml')
  .option('-e, --env <env>', 'Environment', 'default')
  .option('--cloud', 'Run in cloud', false)
  .action(async (file, options) => {
    // 1. Load config
    const config = await loadConfig(options.config);

    // 2. Parse test
    const testContent = await fs.readFile(file, 'utf-8');
    const test = TestDSLParser.parse(testContent);

    // 3. Run test
    if (options.cloud) {
      // Send to cloud
      const result = await runInCloud(test, config);
    } else {
      // Run locally
      const engine = new TestRunEngine(config);
      const result = await engine.executeTest(test);
    }

    // 4. Exit code
    process.exit(result.success ? 0 : 1);
  });

program.parse();
```

**qait.config.yaml:**

```yaml
apiKey: ${QAIT_API_KEY}
orgId: ${QAIT_ORG_ID}
projectId: ${QAIT_PROJECT_ID}

defaults:
  browser: chrome
  timeout: 60000
  viewport:
    width: 1920
    height: 1080

memory:
  enabled: true
  ttl: 30 # days

autoHealing:
  enabled: true
  maxRetries: 3

smartWaiting:
  enabled: true
  networkIdleTimeout: 5000
```

**Оценка:** 10-12 часов

---

#### 9.2. Cloud Runtime API

```typescript
// src/api/qait/qait.controller.ts

export class QAITController {
  /**
   * POST /api/v1/qait/tests/run
   * Run test in cloud
   */
  async runTest(req: Request, res: Response) {
    const { test, config } = req.body;

    // 1. Validate test
    const validated = TestDSLParser.parse(JSON.stringify(test));

    // 2. Create test run
    const runId = await this.createTestRun(validated, req.user.id);

    // 3. Queue for execution
    await this.queueTestRun(runId);

    // 4. Return run ID
    res.json({
      success: true,
      runId,
      statusUrl: `/api/v1/qait/runs/${runId}`,
    });
  }

  /**
   * GET /api/v1/qait/runs/:runId
   * Get test run status
   */
  async getRunStatus(req: Request, res: Response) {
    const { runId } = req.params;
    const run = await this.getTestRun(runId, req.user.id);

    res.json({
      id: run.id,
      status: run.status,
      progress: run.progress,
      result: run.result,
      screenshots: run.screenshots,
      video: run.video,
    });
  }
}
```

**Оценка:** 8-10 часов

---

## 📋 План реализации (по приоритетам)

### Фаза 1: Критичные компоненты (40-50ч)

1. ✅ **TestRunEngine** (8-12ч) - Универсальный движок
2. ✅ **AI Extract** (6-8ч) - Извлечение данных
3. ✅ **AI Check (семантический)** (6-8ч) - Семантические ассерты
4. ✅ **Auto-healing** (12-16ч) - Восстановление локаторов
5. ✅ **Memory** (16-20ч) - Память AI решений
6. ✅ **JSON/YAML DSL** (8-10ч) - Формат тестов

### Фаза 2: Важные компоненты (20-24ч)

7. ✅ **Visual Diff** (10-12ч) - Визуальное сравнение
8. ✅ **Save/Load Auth** (4-6ч) - Сохранение состояния
9. ✅ **Расширение Primitive Steps** (4-6ч) - Новые действия
10. ✅ **Smart Waiting (универсальный)** (4-6ч) - Умные ожидания

### Фаза 3: Интеграция (18-22ч)

11. ✅ **CLI** (10-12ч) - Командная строка
12. ✅ **Cloud Runtime API** (8-10ч) - Облачный API

---

## 🎯 Итоговая оценка

| Фаза | Компоненты | Время | Приоритет |
|------|-----------|-------|-----------|
| 1 | TestRunEngine, AI Extract, AI Check, Auto-healing, Memory, DSL | 40-50ч | 🔴 Критично |
| 2 | Visual Diff, Auth State, Primitive Steps, Smart Waiting | 20-24ч | 🟡 Высокий |
| 3 | CLI, Cloud API | 18-22ч | 🟡 Высокий |
| **ИТОГО** | - | **78-96ч** | - |

---

## 📝 Следующие шаги

1. **Обсудить план** - уточнить приоритеты
2. **Начать с Фазы 1** - критичные компоненты
3. **Итеративная разработка** - по компонентам
4. **Тестирование** - после каждой фазы

---

**Дата создания:** 2024-11-27
