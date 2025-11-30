# Standard Mode - Примеры команд от пользователя

## 📋 Что такое Standard Mode?

**Standard Mode** = Выполнение **предопределенных команд** (Playwright commands)

Пользователь (или AI) создает список команд **до** запуска теста, и система выполняет их последовательно.

---

## 🎯 Способ 1: Прямой API вызов

### Пример 1: Простой тест (Login flow)

**Запрос:**
```bash
POST /api/v1/manual-test/run
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://example.com",
  "browsers": ["chrome"],
  "projectId": "b8ff4957-252e-4ea1-81de-6ef43638b802",
  "intelligentMode": false,  // ← Standard Mode
  "commands": [               // ← Команды предопределены
    {
      "action": "goto",
      "url": "https://example.com",
      "description": "Navigate to homepage"
    },
    {
      "action": "click",
      "selector": "text=\"Sign In\"",
      "description": "Click Sign In button"
    },
    {
      "action": "fill",
      "selector": "input[name='email']",
      "value": "test@example.com",
      "description": "Fill email field"
    },
    {
      "action": "fill",
      "selector": "input[name='password']",
      "value": "password123",
      "description": "Fill password field"
    },
    {
      "action": "click",
      "selector": "button[type='submit']",
      "description": "Click login button"
    },
    {
      "action": "waitForSelector",
      "selector": "text=\"Welcome\"",
      "timeout": 5000,
      "description": "Wait for welcome message"
    }
  ]
}
```

**Ответ:**
```json
{
  "success": true,
  "data": {
    "id": "8510af12-30d8-49a9-9874-d1e93d6910f3",
    "url": "https://example.com",
    "status": "pending",
    "browsers": ["chrome"],
    "intelligent_mode": false,
    "commands": [...]
  },
  "message": "Test created successfully"
}
```

---

### Пример 2: E-commerce тест (Add to cart)

**Запрос:**
```bash
POST /api/v1/manual-test/run
Authorization: Bearer <token>

{
  "url": "https://shop.example.com",
  "browsers": ["chrome", "firefox"],
  "projectId": "...",
  "intelligentMode": false,
  "commands": [
    {
      "action": "goto",
      "url": "https://shop.example.com/products"
    },
    {
      "action": "click",
      "selector": "text=\"Laptop\"",
      "description": "Click on Laptop product"
    },
    {
      "action": "waitForSelector",
      "selector": "button:has-text('Add to Cart')",
      "timeout": 5000
    },
    {
      "action": "click",
      "selector": "button:has-text('Add to Cart')",
      "description": "Add product to cart"
    },
    {
      "action": "waitForSelector",
      "selector": ".cart-count",
      "timeout": 3000
    },
    {
      "action": "assertText",
      "selector": ".cart-count",
      "expected": "1",
      "description": "Verify cart count is 1"
    }
  ]
}
```

---

### Пример 3: Форма с валидацией

**Запрос:**
```bash
POST /api/v1/manual-test/run
Authorization: Bearer <token>

{
  "url": "https://form.example.com",
  "browsers": ["chrome"],
  "projectId": "...",
  "intelligentMode": false,
  "commands": [
    {
      "action": "goto",
      "url": "https://form.example.com/contact"
    },
    {
      "action": "fill",
      "selector": "input[name='name']",
      "value": "John Doe",
      "description": "Fill name field"
    },
    {
      "action": "fill",
      "selector": "input[name='email']",
      "value": "john@example.com",
      "description": "Fill email field"
    },
    {
      "action": "fill",
      "selector": "textarea[name='message']",
      "value": "This is a test message",
      "description": "Fill message field"
    },
    {
      "action": "check",
      "selector": "input[type='checkbox'][name='agree']",
      "description": "Check agreement checkbox"
    },
    {
      "action": "click",
      "selector": "button[type='submit']",
      "description": "Submit form"
    },
    {
      "action": "waitForSelector",
      "selector": "text=\"Thank you\"",
      "timeout": 5000,
      "description": "Wait for success message"
    }
  ]
}
```

---

## 🎯 Способ 2: Через Chat API (AI генерирует commands)

### ⚠️ ВАЖНО: AI делает ПОЛНЫЙ АНАЛИЗ реальной страницы

Когда пользователь пишет:
```
"Протестируй login flow на https://example.com"
```

**Система НЕ придумывает тесткейсы!** Вместо этого:

1. **Запускает реальный браузер** (Playwright)
2. **Переходит на URL** (`page.goto()`)
3. **Делает скриншот** страницы
4. **Анализирует DOM структуру** (`analyzeDOMStructure()`):
   - Извлекает **реальные селекторы** всех кнопок, форм, инпутов
   - Определяет типы полей, required/optional
   - Находит все интерактивные элементы
5. **Анализирует визуально** (`analyzeScreenshotWithVision()`):
   - GPT-4o Vision анализирует скриншот
   - Определяет layout, элементы, их расположение
6. **Генерирует test plan** на основе **РЕАЛЬНЫХ данных**:
   - AI получает промпт с **реальными селекторами** из DOM анализа
   - Промпт явно говорит: "USE THESE EXACT SELECTORS - DO NOT INVENT NEW ONES"
   - AI создает commands используя **только реальные селекторы**

**Пример exploration result:**
```json
{
  "domAnalysis": {
    "buttons": [
      {
        "text": "Sign In",
        "selector": "button.auth-btn",  // ← РЕАЛЬНЫЙ селектор
        "type": "submit"
      }
    ],
    "inputs": [
      {
        "name": "email",
        "type": "email",
        "selector": "input[name='email']",  // ← РЕАЛЬНЫЙ селектор
        "required": true
      }
    ],
    "forms": [...]
  },
  "visualAnalysis": {
    "elements": [...],
    "layout": "login form centered"
  }
}
```

**AI генерирует testPlan с commands используя РЕАЛЬНЫЕ селекторы:**
```json
{
  "id": "plan-123",
  "url": "https://example.com",
  "scope": "Test login flow",
  "intelligentMode": false,  // ← Standard Mode (т.к. есть commands)
  "commands": [
    {
      "action": "goto",
      "url": "https://example.com",
      "description": "Navigate to homepage"
    },
    {
      "action": "click",
      "selector": "text=\"Sign In\"",
      "description": "Click Sign In button"
    },
    {
      "action": "fill",
      "selector": "input[name='email']",
      "value": "test@example.com",
      "description": "Fill email field"
    },
    {
      "action": "fill",
      "selector": "input[name='password']",
      "value": "password123",
      "description": "Fill password field"
    },
    {
      "action": "click",
      "selector": "button[type='submit']",
      "description": "Click login button"
    }
  ],
  "steps": [
    {
      "id": "step_1",
      "description": "Navigate to homepage",
      "action": "goto"
    },
    {
      "id": "step_2",
      "description": "Click Sign In",
      "action": "click"
    },
    {
      "id": "step_3",
      "description": "Fill login form",
      "action": "fill"
    },
    {
      "id": "step_4",
      "description": "Submit form",
      "action": "click"
    }
  ]
}
```

**Пользователь одобряет:**
```
"Да, запускай"
```

**Система запускает тест:**
```typescript
// В chat.controller.ts
const testRequest = {
  url: plan.url,
  browsers: ['chrome'],
  projectId: project_id,
  intelligentMode: false,  // ← Standard Mode
  commands: plan.commands,  // ← Команды из плана (с РЕАЛЬНЫМИ селекторами)
  intent: plan.scope,
};

await ManualTestService.runTest(testRequest);
```

---

## 🔍 Как работает анализ страницы (exploration)

### Шаг 1: Запуск браузера
```typescript
// autonomous-explorer.service.ts
const browser = await browserPool.getBrowser('chrome');
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
```

### Шаг 2: Сбор данных
```typescript
// 1. Скриншот
const screenshot = await page.screenshot({ fullPage: true });

// 2. DOM анализ (ПАРАЛЛЕЛЬНО)
const domAnalysis = await analyzeDOMStructure(page);
// Результат:
// {
//   buttons: [{ text: "Sign In", selector: "button.auth-btn" }],
//   inputs: [{ name: "email", selector: "input[name='email']" }],
//   forms: [...]
// }

// 3. Визуальный анализ (ПАРАЛЛЕЛЬНО)
const visualAnalysis = await analyzeScreenshotWithVision(screenshot, { scope, url });
// Результат:
// {
//   elements: [{ type: "button", purpose: "login", location: "center" }],
//   layout: "login form centered",
//   suggestions: ["Test form validation"]
// }
```

### Шаг 3: Генерация test plan
```typescript
// test-plan-generator.service.ts
const prompt = buildTestPlanPrompt(explorationResult, userRequest);
// Промпт содержит:
// - РЕАЛЬНЫЕ селекторы из DOM анализа
// - Визуальную информацию
// - Явную инструкцию: "USE THESE EXACT SELECTORS - DO NOT INVENT NEW ONES"

const aiPlan = await getChatCompletionWithMessages([...]);
// AI генерирует commands используя ТОЛЬКО реальные селекторы

// Валидация
validateSelectorsInPlan(aiPlan, explorationResult);
// Проверяет что все селекторы из плана есть в DOM анализе
```

### Шаг 4: Результат
```json
{
  "commands": [
    {
      "action": "goto",
      "url": "https://example.com"
    },
    {
      "action": "click",
      "selector": "button.auth-btn",  // ← РЕАЛЬНЫЙ селектор из DOM анализа
      "description": "Click Sign In button"
    },
    {
      "action": "fill",
      "selector": "input[name='email']",  // ← РЕАЛЬНЫЙ селектор из DOM анализа
      "value": "test@example.com"
    }
  ]
}
```

---

## ✅ Ключевые моменты

1. **AI НЕ придумывает селекторы** - использует только реальные из DOM анализа
2. **Полный анализ страницы** - браузер, скриншот, DOM, визуальный анализ
3. **Валидация селекторов** - `validateSelectorsInPlan()` проверяет что все селекторы валидны
4. **Промпт явно запрещает** изобретать селекторы: "DO NOT INVENT NEW ONES"

---

## 📝 Поддерживаемые действия (Playwright commands)

### Navigation:
```typescript
{
  "action": "goto",
  "url": "https://example.com",
  "waitFor": "domcontentloaded" | "load" | "networkidle",
  "timeout": 30000
}
```

### Interactions:
```typescript
// Click
{
  "action": "click",
  "selector": "button[type='submit']",
  "timeout": 30000
}

// Fill input
{
  "action": "fill",
  "selector": "input[name='email']",
  "value": "test@example.com",
  "timeout": 30000
}

// Type (with events)
{
  "action": "type",
  "selector": "input[name='search']",
  "value": "search query",
  "delay": 100  // Delay between keystrokes
}

// Select dropdown
{
  "action": "select",
  "selector": "select[name='country']",
  "value": "US"  // or { label: "United States" }
}

// Checkbox
{
  "action": "check",
  "selector": "input[type='checkbox'][name='agree']"
}

// Uncheck
{
  "action": "uncheck",
  "selector": "input[type='checkbox'][name='newsletter']"
}

// Hover
{
  "action": "hover",
  "selector": ".menu-item"
}
```

### Wait:
```typescript
// Wait for selector
{
  "action": "waitForSelector",
  "selector": "text=\"Loading complete\"",
  "timeout": 5000,
  "state": "visible" | "hidden" | "attached" | "detached"
}

// Wait for navigation
{
  "action": "waitForNavigation",
  "timeout": 30000,
  "waitUntil": "domcontentloaded" | "load" | "networkidle"
}

// Wait timeout
{
  "action": "wait",
  "timeout": 2000  // milliseconds
}
```

### Assertions:
```typescript
// Assert element is visible
{
  "action": "assertVisible",
  "selector": "text=\"Success\"",
  "timeout": 5000
}

// Assert text content
{
  "action": "assertText",
  "selector": ".title",
  "expected": "Welcome",
  "operator": "=" | "contains" | "startsWith" | "endsWith"
}

// Assert input value
{
  "action": "assertValue",
  "selector": "input[name='email']",
  "expected": "test@example.com"
}

// Assert URL
{
  "action": "assertUrl",
  "expected": "https://example.com/dashboard"
}

// Assert count
{
  "action": "assertCount",
  "selector": ".product-item",
  "expected": 5,
  "operator": "=" | ">" | "<"
}
```

### Data Extraction:
```typescript
// Extract text
{
  "action": "extract",
  "selector": ".price",
  "property": "text",
  "name": "productPrice"
}

// Extract attribute
{
  "action": "extract",
  "selector": "img.product-image",
  "attribute": "src",
  "name": "productImageUrl"
}

// Extract with AI (JSON schema)
{
  "action": "extract",
  "selector": ".product-card",
  "useAI": true,
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "price": { "type": "number" },
      "rating": { "type": "number" }
    }
  },
  "name": "productData"
}
```

### Screenshots:
```typescript
{
  "action": "screenshot",
  "fullPage": false,
  "name": "before-login"
}
```

---

## 🔍 Примеры селекторов

### Playwright API селекторы (рекомендуется):
```typescript
// Text selector
"text=\"Login\""
"text=/Login/i"  // Case insensitive regex

// Role selector
"role=button[name=\"Submit\"]"
"role=textbox[name=\"Email\"]"

// Label selector
"label=\"Email address\""
"label=/email/i"

// CSS selector
".submit-button"
"#login-form"
"button[type='submit']"

// XPath
"xpath=//button[contains(text(), 'Login')]"

// Contextual (has-text)
"button:has-text('Login')"
".form:has-text('Sign In') >> button"
```

---

## 📊 Полный пример (из реального теста)

**Из логов (repetino.kz):**
```json
{
  "url": "https://repetino.kz",
  "browsers": ["chrome"],
  "projectId": "b8ff4957-252e-4ea1-81de-6ef43638b802",
  "intelligentMode": false,
  "commands": [
    {
      "action": "goto",
      "url": "https://repetino.kz",
      "description": "Navigate to the Repetino.kz homepage"
    },
    {
      "action": "fill",
      "selector": ".relative > input[placeholder=\"Поиск по предметам\"]",
      "value": "English",
      "description": "Fill the search input with the subject 'English'"
    },
    {
      "action": "click",
      "selector": ".space-y-4 > button:has-text(\"Найти репетитора\")",
      "description": "Click the 'Find a tutor' button"
    }
  ]
}
```

---

## 🎯 cURL пример

```bash
curl -X POST https://api.qai.so/api/v1/manual-test/run \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "browsers": ["chrome"],
    "projectId": "b8ff4957-252e-4ea1-81de-6ef43638b802",
    "intelligentMode": false,
    "commands": [
      {
        "action": "goto",
        "url": "https://example.com"
      },
      {
        "action": "click",
        "selector": "text=\"Sign In\""
      },
      {
        "action": "fill",
        "selector": "input[name=\"email\"]",
        "value": "test@example.com"
      },
      {
        "action": "fill",
        "selector": "input[name=\"password\"]",
        "value": "password123"
      },
      {
        "action": "click",
        "selector": "button[type=\"submit\"]"
      }
    ]
  }'
```

---

## 🎯 JavaScript пример

```javascript
const response = await fetch('https://api.qai.so/api/v1/manual-test/run', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    url: 'https://example.com',
    browsers: ['chrome'],
    projectId: 'b8ff4957-252e-4ea1-81de-6ef43638b802',
    intelligentMode: false,  // ← Standard Mode
    commands: [
      {
        action: 'goto',
        url: 'https://example.com',
        description: 'Navigate to homepage'
      },
      {
        action: 'click',
        selector: 'text="Sign In"',
        description: 'Click Sign In button'
      },
      {
        action: 'fill',
        selector: 'input[name="email"]',
        value: 'test@example.com',
        description: 'Fill email field'
      },
      {
        action: 'fill',
        selector: 'input[name="password"]',
        value: 'password123',
        description: 'Fill password field'
      },
      {
        action: 'click',
        selector: 'button[type="submit"]',
        description: 'Click login button'
      },
      {
        action: 'waitForSelector',
        selector: 'text="Welcome"',
        timeout: 5000,
        description: 'Wait for welcome message'
      }
    ]
  })
});

const result = await response.json();
console.log('Test ID:', result.data.id);
```

---

## ✅ Ключевые моменты

1. **`intelligentMode: false`** - явно указывает Standard Mode
2. **`commands: [...]`** - массив команд обязателен
3. **Команды выполняются последовательно** - как скрипт
4. **Self-healing работает** - если селектор не найден, AI пытается найти альтернативу
5. **Стоимость: 1 кредит** (vs 20 для Intelligent Mode)

---

## 📚 См. также

- `docs/development/STANDARD_VS_INTELLIGENT_MODE.md` - Полное сравнение режимов
- `docs/api/TEST_CONTROL_ENDPOINTS.md` - Управление тестами (cancel, retry, status)
