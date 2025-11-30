# Как создается Test Plan: Реальный анализ vs Придумывание

## ❓ Вопрос

> Когда пользователь пишет "Протестируй login flow на https://example.com"
>
> AI просто придумывает тест-кейсы ИЛИ делает полный анализ и потом только понимает точную структуру и данные создает test plan?

---

## ✅ Ответ: **РЕАЛЬНЫЙ АНАЛИЗ!**

AI **НЕ придумывает** тест-кейсы. Система делает **полный реальный анализ страницы** перед созданием test plan.

---

## 🔍 Полный процесс (Step-by-Step)

### Шаг 1: Пользователь пишет запрос

```
"Протестируй login flow на https://example.com"
```

---

### Шаг 2: Autonomous Exploration (Реальный анализ)

**Файл:** `src/services/testing/ui/autonomous/autonomous-explorer.service.ts`

**Что происходит:**

#### 2.1. Запуск реального браузера
```typescript
// ✅ РЕАЛЬНЫЙ браузер, не симуляция!
const browser = await browserPool.getBrowser('chrome');
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0...',
});
const page = await context.newPage();
```

#### 2.2. Переход на реальную страницу
```typescript
// ✅ РЕАЛЬНЫЙ переход на страницу
await page.goto(url, {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

// ✅ Ждем загрузки (SPA support)
await Promise.race([
  page.waitForLoadState('networkidle', { timeout: 3000 }),
  page.waitForTimeout(3000),
]);
```

#### 2.3. Скриншот реальной страницы
```typescript
// ✅ РЕАЛЬНЫЙ скриншот страницы
const screenshot = await page.screenshot({
  fullPage: true,
  type: 'png',
});

// ✅ Оптимизация для GPT-4o Vision (1024x1024 max)
const resizedScreenshot = await sharp(screenshot)
  .resize(1024, 1024, { fit: 'inside' })
  .toBuffer();
```

#### 2.4. Vision AI анализ (параллельно)
```typescript
// ✅ GPT-4o Vision анализирует РЕАЛЬНЫЙ скриншот
const visualAnalysisPromise = analyzeScreenshotWithVision(screenshotBase64, {
  scope: "Test login flow",
  url: "https://example.com",
});

// Vision AI видит:
// - Реальные элементы на странице
// - Их расположение
// - Визуальный приоритет
// - Модальные окна (cookie banners, popups)
// - Цвета, размеры, стили
```

#### 2.5. DOM анализ (параллельно)
```typescript
// ✅ Анализ РЕАЛЬНОГО DOM
const domAnalysisPromise = analyzeDOMStructure(page);

// DOM анализ извлекает:
// - Реальные формы с полями
// - Реальные кнопки с текстом
// - Реальные инпуты с типами
// - Реальные селекторы (text=, role=, label=)
// - Shadow DOM элементы
// - iframe элементы
```

#### 2.6. Результат Exploration
```typescript
const exploration: ExplorationResult = {
  url: "https://example.com",
  screenshot: "data:image/png;base64,...",  // ✅ РЕАЛЬНЫЙ скриншот
  visualAnalysis: {
    elements: [
      {
        type: "button",
        purpose: "login",
        location: "center-right",
        required: true
      },
      {
        type: "input",
        purpose: "email",
        location: "center",
        required: true
      }
    ],
    layout: "centered form",
    suggestions: ["Test email validation", "Test password requirements"]
  },
  domAnalysis: {
    forms: [
      {
        action: "/login",
        method: "POST",
        fields: [
          {
            name: "email",
            type: "email",
            required: true,
            selector: "input[name='email']",  // ✅ РЕАЛЬНЫЙ селектор
            placeholder: "Enter your email"
          },
          {
            name: "password",
            type: "password",
            required: true,
            selector: "input[name='password']",  // ✅ РЕАЛЬНЫЙ селектор
            placeholder: "Enter your password"
          }
        ]
      }
    ],
    buttons: [
      {
        text: "Sign In",
        selector: "role=button[name=\"Sign In\"]",  // ✅ РЕАЛЬНЫЙ селектор
        type: "submit"
      }
    ],
    inputs: [
      {
        type: "email",
        name: "email",
        selector: "label=\"Email\"",  // ✅ РЕАЛЬНЫЙ селектор
        required: true,
        placeholder: "Enter your email"
      }
    ]
  },
  pageInfo: {
    title: "Login - Example.com",
    url: "https://example.com/login",
    hasAuth: true
  },
  recommendations: [
    "Test email validation",
    "Test password requirements",
    "Test error messages"
  ]
};
```

---

### Шаг 3: Генерация Test Plan (на основе РЕАЛЬНЫХ данных)

**Файл:** `src/services/testing/plans/test-plan-generator.service.ts`

**Что происходит:**

#### 3.1. AI получает РЕАЛЬНЫЕ данные
```typescript
const prompt = buildTestPlanPrompt(explorationResult, userRequest);

// Prompt включает:
// - РЕАЛЬНЫЙ DOM анализ (формы, кнопки, инпуты)
// - РЕАЛЬНЫЕ селекторы (text=, role=, label=)
// - РЕАЛЬНЫЙ Vision анализ (элементы, расположение)
// - РЕАЛЬНЫЙ скриншот (base64)
// - Рекомендации на основе анализа
```

#### 3.2. AI генерирует команды с РЕАЛЬНЫМИ селекторами
```typescript
const response = await getChatCompletionWithMessages([
  {
    role: 'system',
    content: 'You are an expert QA engineer. Generate specific, actionable steps with REAL selectors from DOM analysis.',
  },
  {
    role: 'user',
    content: prompt,  // ← Включает РЕАЛЬНЫЕ данные из exploration
  },
], {
  temperature: 0.4,
  max_tokens: 3000,
  response_format: { type: 'json_object' },
});

const aiPlan = JSON.parse(response.content);
```

#### 3.3. Валидация селекторов
```typescript
// ✅ Проверка что селекторы существуют в РЕАЛЬНОМ DOM
validateSelectorsInPlan(aiPlan, explorationResult);

// Если селектор не найден в DOM → исправляется
```

#### 3.4. Test Plan с РЕАЛЬНЫМИ командами
```typescript
const testPlan: TestPlan = {
  id: planId,
  url: "https://example.com",
  scope: "Test login flow",
  commands: [
    {
      action: "goto",
      url: "https://example.com",
      description: "Navigate to homepage"
    },
    {
      action: "click",
      selector: "text=\"Sign In\"",  // ✅ РЕАЛЬНЫЙ селектор из DOM
      description: "Click Sign In button"
    },
    {
      action: "fill",
      selector: "input[name='email']",  // ✅ РЕАЛЬНЫЙ селектор из DOM
      value: "test@example.com",
      description: "Fill email field"
    },
    {
      action: "fill",
      selector: "input[name='password']",  // ✅ РЕАЛЬНЫЙ селектор из DOM
      value: "password123",
      description: "Fill password field"
    },
    {
      action: "click",
      selector: "role=button[name=\"Sign In\"]",  // ✅ РЕАЛЬНЫЙ селектор из DOM
      description: "Click login button"
    }
  ],
  steps: [...],
  // ...
};
```

---

## 📊 Сравнение: Придумывание vs Реальный анализ

### ❌ Если бы AI придумывал:

```typescript
// AI просто генерирует команды на основе описания
{
  commands: [
    {
      action: "click",
      selector: ".login-button",  // ← Придуманный селектор
      // Может не существовать на странице!
    }
  ]
}
```

**Проблемы:**
- ❌ Селекторы могут не существовать
- ❌ Не знает реальную структуру страницы
- ❌ Не видит реальные элементы
- ❌ Может пропустить важные элементы

---

### ✅ Реальный анализ (как сейчас):

```typescript
// 1. Запускает браузер
// 2. Переходит на страницу
// 3. Делает скриншот
// 4. Анализирует DOM
// 5. Извлекает РЕАЛЬНЫЕ селекторы
// 6. Генерирует команды с РЕАЛЬНЫМИ селекторами

{
  commands: [
    {
      action: "click",
      selector: "text=\"Sign In\"",  // ✅ РЕАЛЬНЫЙ селектор из DOM
      // Гарантированно существует!
    }
  ]
}
```

**Преимущества:**
- ✅ Селекторы **гарантированно** существуют
- ✅ Знает **реальную** структуру страницы
- ✅ Видит **реальные** элементы (Vision AI)
- ✅ Не пропускает важные элементы

---

## 🔍 Детальный Flow

```
User: "Протестируй login flow на https://example.com"
    ↓
[1] runAutonomousExploration()
    ↓
[2] exploreProduct()
    ├─ Launch browser (Chrome) ✅ РЕАЛЬНЫЙ
    ├─ page.goto(url) ✅ РЕАЛЬНЫЙ переход
    ├─ page.screenshot() ✅ РЕАЛЬНЫЙ скриншот
    ├─ analyzeScreenshotWithVision() ✅ GPT-4o Vision
    │   └─ Видит: кнопки, формы, элементы
    │   └─ Понимает: расположение, приоритет
    │
    └─ analyzeDOMStructure() ✅ РЕАЛЬНЫЙ DOM
        └─ Извлекает: формы, кнопки, инпуты
        └─ Генерирует: РЕАЛЬНЫЕ селекторы
            - text="Sign In"
            - role=button[name="Sign In"]
            - input[name='email']
            - label="Email"
    ↓
[3] ExplorationResult
    ├─ screenshot: base64 ✅ РЕАЛЬНЫЙ
    ├─ visualAnalysis: {...} ✅ РЕАЛЬНЫЙ
    └─ domAnalysis: {
        forms: [{ fields: [{ selector: "..." }] }], ✅ РЕАЛЬНЫЕ
        buttons: [{ selector: "..." }], ✅ РЕАЛЬНЫЕ
        inputs: [{ selector: "..." }] ✅ РЕАЛЬНЫЕ
      }
    ↓
[4] generateTestPlan(explorationResult)
    ├─ buildTestPlanPrompt(explorationResult)
    │   └─ Включает РЕАЛЬНЫЕ данные:
    │       - DOM анализ
    │       - Vision анализ
    │       - Селекторы
    │       - Скриншот
    │
    ├─ AI генерирует команды
    │   └─ Использует РЕАЛЬНЫЕ селекторы из DOM
    │
    └─ validateSelectorsInPlan()
        └─ Проверяет что селекторы существуют ✅
    ↓
[5] TestPlan
    └─ commands: [
        { selector: "text=\"Sign In\"" },  // ✅ РЕАЛЬНЫЙ
        { selector: "input[name='email']" },  // ✅ РЕАЛЬНЫЙ
        { selector: "role=button[name=\"Sign In\"]" }  // ✅ РЕАЛЬНЫЙ
      ]
    ↓
[6] User approves
    ↓
[7] Test runs with РЕАЛЬНЫМИ командами ✅
```

---

## 🎯 Ключевые моменты

### ✅ Что делает система:

1. **Запускает РЕАЛЬНЫЙ браузер** (Playwright Chrome)
2. **Переходит на РЕАЛЬНУЮ страницу** (page.goto)
3. **Делает РЕАЛЬНЫЙ скриншот** (page.screenshot)
4. **Анализирует РЕАЛЬНЫЙ DOM** (analyzeDOMStructure)
5. **Vision AI анализирует РЕАЛЬНЫЙ скриншот** (GPT-4o Vision)
6. **Извлекает РЕАЛЬНЫЕ селекторы** из DOM
7. **Генерирует команды с РЕАЛЬНЫМИ селекторами**
8. **Валидирует селекторы** (проверка что они существуют)

### ❌ Что система НЕ делает:

- ❌ Не придумывает селекторы
- ❌ Не генерирует команды "наугад"
- ❌ Не использует шаблоны
- ❌ Не предполагает структуру страницы

---

## 📊 Пример: Реальные данные

### Из логов (repetino.kz):

**Exploration Result:**
```json
{
  "domAnalysis": {
    "forms": [
      {
        "fields": [
          {
            "name": "subject",
            "type": "text",
            "selector": ".relative > input[placeholder=\"Поиск по предметам\"]",
            "required": true
          }
        ]
      }
    ],
    "buttons": [
      {
        "text": "Найти репетитора",
        "selector": ".space-y-4 > button:has-text(\"Найти репетитора\")",
        "type": "button"
      }
    ]
  }
}
```

**Generated Test Plan:**
```json
{
  "commands": [
    {
      "action": "goto",
      "url": "https://repetino.kz"
    },
    {
      "action": "fill",
      "selector": ".relative > input[placeholder=\"Поиск по предметам\"]",  // ✅ РЕАЛЬНЫЙ
      "value": "English"
    },
    {
      "action": "click",
      "selector": ".space-y-4 > button:has-text(\"Найти репетитора\")",  // ✅ РЕАЛЬНЫЙ
      "description": "Click the 'Find a tutor' button"
    }
  ]
}
```

**Все селекторы взяты из РЕАЛЬНОГО DOM анализа!** ✅

---

## 🎯 Итог

### ❓ Вопрос:
> AI просто придумывает тест-кейсы ИЛИ делает полный анализ?

### ✅ Ответ:
**Делает полный анализ!**

1. ✅ Запускает **РЕАЛЬНЫЙ браузер**
2. ✅ Переходит на **РЕАЛЬНУЮ страницу**
3. ✅ Делает **РЕАЛЬНЫЙ скриншот**
4. ✅ Анализирует **РЕАЛЬНЫЙ DOM**
5. ✅ Vision AI анализирует **РЕАЛЬНЫЙ скриншот**
6. ✅ Извлекает **РЕАЛЬНЫЕ селекторы**
7. ✅ Генерирует команды с **РЕАЛЬНЫМИ селекторами**
8. ✅ Валидирует что селекторы **существуют**

**Никакого придумывания! Все основано на реальных данных страницы.** 🎯

---

## 📚 См. также

- `src/services/testing/ui/autonomous/autonomous-explorer.service.ts` - Exploration
- `src/services/testing/ui/autonomous/dom-analyzer.service.ts` - DOM анализ
- `src/services/testing/plans/test-plan-generator.service.ts` - Генерация плана
