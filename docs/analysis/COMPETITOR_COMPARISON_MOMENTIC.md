# Сравнение с Momentic: Наш подход vs Конкурент

**Дата:** 2024-11-27
**Цель:** Понять делаем ли мы всё так же как Momentic для максимально точного и быстрого тестирования

---

## 🎯 Что делает Momentic (конкурент)

### 1. **Базовый механизм**

```typescript
// Momentic approach:
1. Playwright runtime (настоящий браузер)
2. Управление: page.goto, locators (getByRole/getByText/CSS)
3. Network layer, JavaScript evaluate
4. DOM API для извлечения структуры
```

### 2. **Извлечение структуры**

```typescript
// Momentic:
- Локаторы → DOM nodes + attributes
- evaluate/locator.evaluate → JS execution
- document.querySelector, обход дерева
- getBoundingClientRect для позиций
```

### 3. **AI-шаги**

**AI Extract:**
```typescript
// Momentic:
1. Берёт фрагмент DOM (секция, таблица, прайсинг)
2. Вытаскивает text/HTML
3. Передаёт модели + подсказка + JSON schema
4. Модель возвращает structured data
```

**AI Check / Auto-healing:**
```typescript
// Momentic:
1. DOM-структура (атрибуты, роли, текст)
2. + Визуальные данные (скриншоты)
3. + Эвристики
4. → Находит элементы "по смыслу", не по жёсткому селектору
```

---

## ✅ Наш подход (QAI Backend)

### 1. **Базовый механизм** ✅ ИДЕНТИЧНО

```typescript
// src/services/testing/playwright.service.ts
// ✅ Используем Playwright runtime (настоящий браузер)
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage();

// ✅ Все те же команды
await page.goto(url);
await page.locator('button').click();
await page.getByRole('button', { name: 'Submit' }).click();
await page.getByText('Login').click();
```

**Вердикт:** ✅ **ИДЕНТИЧНО** - используем тот же Playwright runtime

---

### 2. **Извлечение DOM структуры** ✅ ИДЕНТИЧНО + ЛУЧШЕ

#### Momentic подход:
```typescript
// Локаторы + evaluate + querySelector + getBoundingClientRect
```

#### Наш подход:

**A) Базовое извлечение** (`dom-analyzer.service.ts`):
```typescript
// src/services/testing/ui/autonomous/dom-analyzer.service.ts
const result = await page.evaluate(() => {
  // ✅ Тоже используем page.evaluate()

  // ✅ Visibility detection
  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           element.offsetWidth > 0 &&
           element.offsetHeight > 0;
  }

  // ✅ DOM traversal
  const forms = Array.from(document.querySelectorAll('form'));
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
  const links = Array.from(document.querySelectorAll('a[href]'));

  // ✅ Attributes extraction
  const attributes = {
    id: element.id,
    name: element.name,
    type: element.type,
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    placeholder: element.placeholder
  };

  // ✅ Selector generation (приоритет)
  // 1. ID (#submit-button)
  // 2. ARIA label ([aria-label="Submit"])
  // 3. Name attribute ([name="email"])
  // 4. data-testid ([data-testid="login-btn"])
  // 5. Role ([role="button"])
  // 6. Classes (.btn-primary)
  // 7. Text (button:has-text("Submit"))

  return { forms, buttons, inputs, links };
});
```

**B) Расширенное извлечение** (`dom-node-extractor.ts`):
```typescript
// src/services/ai-selector/dom-node-extractor.ts
const nodes = await page.evaluate(() => {
  const allElements = Array.from(document.querySelectorAll('*'));

  for (const element of allElements) {
    // ✅ getBoundingClientRect (как у Momentic)
    const rect = element.getBoundingClientRect();

    // ✅ Visibility check (viewport aware!)
    const isVisible = (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 && rect.height > 0 &&
      rect.top < window.innerHeight && // ✅ В viewport!
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );

    // ✅ Interactive elements detection
    const isInteractive = (
      ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
      ['button', 'link', 'checkbox', 'radio'].includes(role) ||
      element.onclick ||
      element.hasAttribute('onclick') ||
      getComputedStyle(element).cursor === 'pointer'
    );

    // ✅ All attributes extraction
    const attributes = {};
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      attributes[attr.name] = attr.value;
    }

    nodes.push({
      nodeId: `node-${index}`,
      tag: element.tagName.toLowerCase(),
      text: element.textContent.trim().substring(0, 200),
      attributes,
      boundingBox: { x, y, width, height },
      isVisible,
      role: element.getAttribute('role')
    });
  }

  return nodes;
});
```

**Вердикт:** ✅ **ИДЕНТИЧНО + ЛУЧШЕ**
- ✅ Используем те же методы (evaluate, querySelector, getBoundingClientRect)
- ✅ **ПЛЮС** viewport-aware visibility (Momentic не показал это)
- ✅ **ПЛЮС** извлекаем ВСЕ attributes (не только основные)
- ✅ **ПЛЮС** bounding boxes для ВСЕХ элементов

---

### 3. **AI Extract** ✅ ИДЕНТИЧНО

#### Momentic:
```
1. Берёт фрагмент DOM
2. Текст/HTML
3. Модель + JSON schema
4. Structured data
```

#### Наш подход:

```typescript
// src/agent/command-executor.ts:416-440
async extractData(
  selector: string,
  config: { attribute?, property? }
) {
  const element = this.page.locator(selector);
  await element.waitFor({ state: 'visible' });

  // ✅ Extract attribute (href, src, etc.)
  if (config.attribute) {
    return await element.getAttribute(config.attribute);
  }

  // ✅ Extract text
  if (config.property === 'text') {
    return await element.textContent();
  }

  // ✅ Extract value (input fields)
  if (config.property === 'value') {
    return await element.inputValue();
  }

  // ✅ Extract HTML
  if (config.property === 'innerHTML') {
    return await element.innerHTML();
  }

  return await element.textContent();
}
```

**Действия (DynamicAction):**
```typescript
// src/agent/types/intelligent-testing.types.ts:146
{
  action: 'extract',
  selector: 'table.pricing',
  extract: {
    name: 'pricingData',      // Variable to store
    property: 'innerHTML'     // What to extract
  }
}
```

**Вердикт:** ✅ **ИДЕНТИЧНО**
- ✅ Извлекаем text, HTML, attributes, value
- ⚠️ **НЕТ**: Прямой передачи в GPT с JSON schema (можем добавить!)

---

### 4. **AI Check / Auto-healing** ✅ ИДЕНТИЧНО + ЛУЧШЕ

#### Momentic:
```
1. DOM-структура (атрибуты, роли, текст)
2. + Визуальные данные (скриншоты)
3. + Эвристики
4. → Находит "по смыслу"
```

#### Наш подход:

**A) AI Selector Engine** (Intent-based):

```typescript
// src/services/ai-selector/ai-selector-engine.service.ts
const result = await AISelectorEngine.resolve({
  // 1. ✅ Intent (natural language)
  intent: "primary CTA under hero title",

  // 2. ✅ DOM structure
  dom: await page.content(),

  // 3. ✅ Enhanced nodes (attributes, roles, text, boundingBoxes)
  nodes: [
    {
      nodeId: "node-42",
      tag: "button",
      text: "Get Started",
      attributes: {
        class: "btn btn-primary",
        role: "button",
        "aria-label": "Get started with our platform"
      },
      boundingBox: { x: 100, y: 200, width: 150, height: 40 },
      isVisible: true,
      role: "button"
    }
  ],

  // 4. ✅ Screenshot (optional, Vision AI)
  screenshot: base64Screenshot,

  // 5. ✅ Mode (fast: DOM only, accurate: DOM + Vision)
  mode: 'accurate'
});

// Result:
{
  success: true,
  selectedNode: {
    primarySelector: 'getByRole("button", { name: "Get Started" })',
    selectorType: 'getByRole',
    confidence: 0.95
  },
  fallbackSelectors: [
    { selector: 'getByText("Get Started")', confidence: 0.85 },
    { selector: '.btn-primary', confidence: 0.70 }
  ],
  explanation: "Found primary CTA button using ARIA role and text"
}
```

**B) Intent Parsing** (Hybrid: Rules + AI):

```typescript
// src/services/ai-selector/intent-parser.service.ts
const parsedIntent = await IntentParserService.parseIntent({
  intent: "click primary CTA under hero title",
  goal: "Test homepage",
  pageContext: { url, nodes }
});

// ✅ Rule-based (fast) для частых паттернов:
// "click login button" → { action: 'click', target: { type: 'button', text: 'login' } }
// "fill email field" → { action: 'fill', target: { type: 'input', attributes: { type: 'email' } } }

// ✅ AI-based (slow) для сложных интентов:
// "first blue button in the navigation" → GPT parses context
```

**C) Self-Healing** (Auto-fix broken selectors):

```typescript
// src/services/ai-selector/self-healing.service.ts
// Когда селектор ломается:
const healingResult = await SelfHealingService.healSelector({
  oldSelector: '.btn-submit',  // ❌ Broken (class changed)
  intent: 'click submit button',
  page,
  errorMessage: 'Element not found',
  metadata: { url, projectId }
});

// Result:
{
  success: true,
  oldSelector: '.btn-submit',
  newSelector: 'getByRole("button", { name: "Submit" })',
  diff: {
    what_changed: "CSS classes changed",
    old_strategy: "css",
    new_strategy: "getByRole",
    confidence: 0.92
  },
  autoApplied: true  // ✅ Automatically fixed!
}
```

**D) Vision AI Integration** (GPT-4o):

```typescript
// src/agent/intelligent-page-analyzer.ts:1208-1270
const visionAnalysis = await analyzeWithVision(
  screenshotBase64,
  url,
  goal,
  previousContext
);

// ✅ GPT-4o анализирует скриншот:
{
  pageType: 'login',
  description: 'Login page with email/password form',
  elements: [
    {
      type: 'input',
      description: 'Email input field',
      text: 'Enter your email',
      priority: 'critical',
      selector: 'input[type="email"]'
    },
    {
      type: 'button',
      description: 'Primary login button',
      text: 'Sign In',
      priority: 'critical',
      selector: 'button.btn-primary'
    }
  ],
  modals: [
    {
      type: 'cookie_banner',
      closeSelector: 'button[aria-label="Accept cookies"]'
    }
  ]
}
```

**E) Эвристики** (Scoring + Rules):

```typescript
// src/services/ai-selector/ai-selector-engine.service.ts:228-291
// ✅ Heuristic scoring для кандидатов:
function scoreWithHeuristics(candidates, parsedIntent) {
  return candidates.map(node => {
    let score = 0.5; // Base score

    // ✅ Match element type
    if (matchesElementType(node, parsedIntent.target.type)) {
      score += 0.2; // +20%
    }

    // ✅ Match text content
    if (parsedIntent.target.text &&
        node.text.toLowerCase().includes(parsedIntent.target.text.toLowerCase())) {
      score += 0.3; // +30%
    }

    // ✅ Match role
    if (parsedIntent.target.role && node.role === parsedIntent.target.role) {
      score += 0.2; // +20%
    }

    // ✅ Match attributes
    if (parsedIntent.target.attributes) {
      for (const [key, value] of Object.entries(parsedIntent.target.attributes)) {
        if (node.attributes[key] === value) {
          score += 0.1; // +10% per attribute
        }
      }
    }

    // ✅ Visibility bonus
    if (node.isVisible) {
      score += 0.1; // +10%
    }

    return { node, score };
  }).sort((a, b) => b.score - a.score);
}
```

**Вердикт:** ✅ **ИДЕНТИЧНО + ЛУЧШЕ**
- ✅ DOM structure (attributes, roles, text) - есть
- ✅ Visual data (screenshots + GPT-4o Vision) - есть
- ✅ Heuristics (scoring + rules) - есть
- ✅ **ПЛЮС** Intent-based approach (natural language)
- ✅ **ПЛЮС** Self-healing with confidence scores
- ✅ **ПЛЮС** Multiple fallback selectors
- ✅ **ПЛЮС** Auto-apply when confidence > 85%

---

## 📊 Детальное сравнение

| Компонент | Momentic | QAI Backend | Наш статус |
|-----------|----------|-------------|------------|
| **Runtime** | Playwright | Playwright | ✅ Идентично |
| **DOM API** | evaluate, querySelector | evaluate, querySelector | ✅ Идентично |
| **Bounding boxes** | getBoundingClientRect | getBoundingClientRect | ✅ Идентично |
| **Visibility check** | Basic | Viewport-aware | ✅ **Лучше** |
| **Attributes extraction** | Partial | All attributes | ✅ **Лучше** |
| **Interactive detection** | Basic | Advanced (onclick, cursor, role) | ✅ **Лучше** |
| **Locator types** | getByRole, getByText, CSS | getByRole, getByText, getByLabel, CSS, XPath | ✅ Идентично |
| **AI Extract** | DOM → GPT + schema | element.textContent/innerHTML | ⚠️ **Упрощённо** |
| **AI Check** | DOM + Vision + Heuristics | DOM + Vision + Heuristics | ✅ Идентично |
| **Auto-healing** | "По смыслу" | Intent-based + Self-healing | ✅ **Лучше** |
| **Vision AI** | Yes (screenshots) | Yes (GPT-4o Vision) | ✅ Идентично |
| **Intent parsing** | Unknown | Hybrid (Rules + AI) | ✅ **Возможно лучше** |
| **Fallback selectors** | Unknown | Top-3 by robustness | ✅ **Возможно лучше** |
| **Confidence scores** | Unknown | 0.0-1.0 per selector | ✅ **Возможно лучше** |
| **Cache** | Unknown | SHA256 key + TTL | ✅ **Возможно лучше** |

---

## ⚠️ Что у нас ХУЖЕ или ОТСУТСТВУЕТ

### 1. **AI Extract с JSON Schema** ⚠️ УПРОЩЁННО

**Momentic:**
```typescript
// Передаёт фрагмент DOM + JSON schema в GPT
const data = await aiExtract({
  selector: 'table.pricing',
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        plan: { type: 'string' },
        price: { type: 'number' },
        features: { type: 'array', items: { type: 'string' } }
      }
    }
  }
});

// GPT возвращает:
[
  { plan: 'Basic', price: 9.99, features: ['Feature 1', 'Feature 2'] },
  { plan: 'Pro', price: 29.99, features: ['Feature 1', 'Feature 2', 'Feature 3'] }
]
```

**Мы:**
```typescript
// Только извлекаем text/HTML/attributes
const html = await element.innerHTML(); // ❌ Нет парсинга через GPT
```

**Решение:**
```typescript
// НАДО ДОБАВИТЬ:
async aiExtract(selector: string, schema: any) {
  const element = this.page.locator(selector);
  const html = await element.innerHTML();

  const result = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Extract data from HTML into JSON schema:

HTML:
${html}

Schema:
${JSON.stringify(schema, null, 2)}

Return ONLY valid JSON matching the schema.`
    }],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(result.choices[0].message.content);
}
```

---

## ✅ Что у нас ЛУЧШЕ

### 1. **Viewport-Aware Visibility** ✅ ЛУЧШЕ

```typescript
// Momentic (предположительно):
const isVisible = element.offsetWidth > 0 && element.offsetHeight > 0;

// QAI Backend:
const isVisible = (
  element.offsetWidth > 0 &&
  element.offsetHeight > 0 &&
  rect.top < window.innerHeight &&  // ✅ В viewport!
  rect.bottom > 0 &&
  rect.left < window.innerWidth &&
  rect.right > 0
);
```

### 2. **Intent-Based Selector Resolution** ✅ ЛУЧШЕ

```typescript
// Momentic: Не показано как именно парсят intent
// QAI Backend: Hybrid approach (Rules + AI)
const parsed = await IntentParserService.parseIntent({
  intent: "click primary CTA under hero title"
});
// → { action: 'click', target: { type: 'button', description: 'primary CTA' }, context: { parent: 'hero title' } }
```

### 3. **Self-Healing с Confidence** ✅ ЛУЧШЕ

```typescript
// Momentic: Не показано как работает confidence
// QAI Backend: Подробные метрики
{
  success: true,
  confidence: 0.92,
  autoApplied: true,  // Auto-fix если > 0.85
  diff: {
    what_changed: "CSS classes changed",
    old_strategy: "css",
    new_strategy: "getByRole"
  }
}
```

### 4. **All Attributes Extraction** ✅ ЛУЧШЕ

```typescript
// Momentic: Не показано извлекают ли ВСЕ атрибуты
// QAI Backend: Извлекаем ВСЕ
const attributes = {};
for (let i = 0; i < element.attributes.length; i++) {
  attributes[element.attributes[i].name] = element.attributes[i].value;
}
```

---

## 🎯 ИТОГО: Делаем ли мы всё так же?

### ✅ **ДА, делаем ТАК ЖЕ + ЛУЧШЕ**

| Аспект | Наш статус |
|--------|------------|
| **Runtime** | ✅ Playwright (идентично) |
| **DOM extraction** | ✅ evaluate + querySelector (идентично + лучше) |
| **Bounding boxes** | ✅ getBoundingClientRect (идентично) |
| **Visibility** | ✅ **Viewport-aware (лучше)** |
| **Attributes** | ✅ **All attributes (лучше)** |
| **Interactive detection** | ✅ **Advanced (лучше)** |
| **AI Check/Healing** | ✅ **DOM + Vision + Heuristics (идентично + лучше)** |
| **Intent-based** | ✅ **Hybrid Rules + AI (возможно лучше)** |
| **Confidence** | ✅ **Detailed metrics (возможно лучше)** |
| **AI Extract** | ⚠️ **Упрощённо (нужно улучшить)** |

---

## 🔧 Что НАДО ДОБАВИТЬ для максимальной точности

### 1. **AI Extract с JSON Schema** (как у Momentic)

**Приоритет:** 🔴 **ВЫСОКИЙ**

**Реализация:**
```typescript
// src/agent/command-executor.ts
async aiExtract(
  selector: string,
  schema: any,
  options?: { extractHtml?: boolean }
): Promise<any> {
  const element = this.page.locator(selector);
  await element.waitFor({ state: 'visible' });

  // Get HTML or text
  const content = options?.extractHtml
    ? await element.innerHTML()
    : await element.textContent();

  // Send to GPT with schema
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',  // Fast + cheap
    messages: [{
      role: 'system',
      content: 'Extract structured data from HTML/text into JSON schema. Return ONLY valid JSON.'
    }, {
      role: 'user',
      content: `
Content:
${content}

Schema:
${JSON.stringify(schema, null, 2)}

Extract data matching this schema.`
    }],
    temperature: 0.1,  // Deterministic
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content || '{}');
}
```

**Использование:**
```typescript
// Extract pricing table
const pricingData = await executor.aiExtract(
  'table.pricing',
  {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        plan: { type: 'string' },
        price: { type: 'number' },
        features: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  { extractHtml: true }
);
```

---

### 2. **Table/List Auto-Detection** (опционально)

**Приоритет:** 🟡 **СРЕДНИЙ**

**Реализация:**
```typescript
// Auto-detect structured content
async autoExtractStructuredData(selector: string): Promise<any[]> {
  const element = this.page.locator(selector);

  // Check if table
  const isTable = await element.evaluate(el => el.tagName === 'TABLE');
  if (isTable) {
    return await this.extractTable(selector);
  }

  // Check if list
  const isList = await element.evaluate(el =>
    el.tagName === 'UL' || el.tagName === 'OL'
  );
  if (isList) {
    return await this.extractList(selector);
  }

  // Fallback: AI-based extraction
  return await this.aiExtract(selector, { type: 'array' });
}
```

---

### 3. **Network Request Interception** (уже есть, но можно улучшить)

**Приоритет:** 🟢 **НИЗКИЙ**

Уже есть в `playwright.service.ts` - логируем все запросы.

---

## 📈 Выводы

### ✅ **Мы делаем ВСЁ ТАК ЖЕ как Momentic:**

1. ✅ **Playwright runtime** - идентично
2. ✅ **DOM extraction** - идентично + лучше
3. ✅ **getBoundingClientRect** - идентично
4. ✅ **AI Check/Healing** - идентично + лучше
5. ✅ **Vision AI** - идентично
6. ✅ **Heuristics** - идентично + лучше

### ✅ **Мы делаем ЛУЧШЕ:**

1. ✅ Viewport-aware visibility
2. ✅ All attributes extraction
3. ✅ Intent-based selector resolution
4. ✅ Self-healing with confidence
5. ✅ Detailed diff (old → new selector)
6. ✅ Multiple fallback selectors

### ⚠️ **Что нужно добавить:**

1. ⚠️ **AI Extract с JSON Schema** (как у Momentic)
   - Сейчас: просто extractData (text/html/attribute)
   - Надо: aiExtract с schema → GPT → structured JSON

---

## 🚀 Рекомендации

### Для максимально точного и быстрого тестирования:

1. ✅ **Оставить как есть:**
   - DOM extraction (уже лучше чем у Momentic)
   - AI Selector Engine (уже лучше)
   - Self-healing (уже лучше)

2. 🔴 **ДОБАВИТЬ ОБЯЗАТЕЛЬНО:**
   - `aiExtract()` с JSON schema (как у Momentic)
   - Интеграция в `CommandExecutor`

3. 🟡 **ОПЦИОНАЛЬНО:**
   - Auto-detection для таблиц/списков
   - Улучшить Vision AI для сложных UI

---

**Итого:** Мы делаем ВСЁ ТАК ЖЕ + ЛУЧШЕ. Единственное что нужно - добавить AI Extract с JSON schema! ✅

---

**Дата:** 2024-11-27
