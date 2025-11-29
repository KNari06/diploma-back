# 🔍 AI Action Flow - Детальный Анализ

## 📋 Полный Flow от Извлечения до Выполнения

### **STEP 1: Извлечение данных из страницы** ✅ РАБОТАЕТ

**Файл:** `src/services/testing/ui/autonomous/dom-analyzer.service.ts`

**Что извлекается:**
```typescript
// Генерирует правильные Playwright селекторы:
{
  forms: [{ fields: [{ selector: "label=\"Email\"", type: "email" }] }],
  buttons: [{ text: "Login", selector: "role=button[name=\"Login\"]" }],
  links: [{ text: "Sign Up", selector: "text=\"Sign Up\"" }],
  inputs: [{ type: "text", selector: "label=\"Username\"" }],
  checkboxes: [{ label: "Remember me", selector: "role=checkbox[name=\"Remember me\"]" }],
  radios: [{ label: "Option 1", selector: "role=radio[name=\"Option 1\"]" }],
  interactiveElements: [{ tag: "div", selector: ".clickable", role: "button" }]
}
```

**Статус:** ✅ **ПРАВИЛЬНО** - генерирует Playwright API формат

---

### **STEP 2: Передача данных в AI** ✅ РАБОТАЕТ

**Файл:** `src/agent/contextual-action-generator.ts:83-99`

**Что передается:**
```typescript
const prompt = buildActionGenerationPrompt({
  pageType: context.pageType,
  goal: state.goal,
  pageDescription: context.vision.description,
  availableElements: elementsSummary,  // ✅ Включает селекторы
  history: historySummary,
  domSummary,                          // ✅ Включает селекторы
  actualHTML,                          // ✅ Реальный HTML
});
```

**Пример промпта:**
```
Available Elements:
Critical Elements:
- button: Login | Text: "Login" | Selector: "role=button[name=\"Login\"]"
- input: Email field | Text: "" | Selector: "label=\"Email\""

DOM Summary:
Buttons (3):
  - "Login" | Selector: "role=button[name=\"Login\"]"
  - "Sign Up" | Selector: "text=\"Sign Up\""
  - "Cancel" | Selector: "role=button[name=\"Cancel\"]"

Inputs (2):
  - Email: email | Selector: "label=\"Email\""
  - Password: password | Selector: "label=\"Password\""
```

**Статус:** ✅ **ПРАВИЛЬНО** - AI видит правильные селекторы

---

### **STEP 3: AI генерирует действия** ✅ РАБОТАЕТ

**Файл:** `src/agent/contextual-action-generator.ts:101-116`

**AI модель:** GPT-4o (лучшая для кода)

**Ожидаемый ответ от AI:**
```json
{
  "reasoning": "User wants to login, need to fill credentials and click login button",
  "actions": [
    {
      "action": "fill",
      "selector": "label=\"Email\"",
      "value": "user@example.com",
      "description": "Fill email field",
      "expectedResult": "Email field contains value",
      "optional": false,
      "timeout": 10000
    },
    {
      "action": "fill",
      "selector": "label=\"Password\"",
      "value": "password123",
      "description": "Fill password field",
      "expectedResult": "Password field contains value",
      "optional": false,
      "timeout": 10000
    },
    {
      "action": "click",
      "selector": "role=button[name=\"Login\"]",
      "description": "Click login button",
      "expectedResult": "Navigate to dashboard",
      "optional": false,
      "timeout": 10000
    }
  ],
  "confidence": 0.95
}
```

**Статус:** ✅ **ПРАВИЛЬНО** - AI использует точные селекторы из промпта

---

### **STEP 4: Санитизация действий** ⚠️ **ПРОБЛЕМА НАЙДЕНА!**

**Файл:** `src/agent/contextual-action-generator.ts:499-549`

**Проблема:**
```typescript
const validActions = [
  'goto',
  'click',
  'fill',
  'type',
  'select',
  'check',
  'uncheck',
  'hover',
  'press',
  'wait',
  'waitForSelector',
  'waitForNavigation',
  'scroll',
  'assertVisible',
  'assertText',
  'assertValue',
  'assertUrl',
  'assertCount',
  'extract',
  'screenshot',
];
// ❌ НЕТ: dblclick, focus, blur, dragAndDrop, tap, swipe, goBack, goForward, reload, scrollIntoView!
```

**Что происходит:**
- AI генерирует `dblclick` → санитизация **ОТКЛОНЯЕТ** → действие **НЕ ВЫПОЛНЯЕТСЯ**
- AI генерирует `dragAndDrop` → санитизация **ОТКЛОНЯЕТ** → действие **НЕ ВЫПОЛНЯЕТСЯ**

**Статус:** ❌ **НЕПРАВИЛЬНО** - отклоняет валидные действия!

---

### **STEP 5: Выполнение действий** ✅ РАБОТАЕТ (после санитизации)

**Файл:** `src/agent/intelligent-test-orchestrator.ts:936-1384`

**Что происходит:**
```typescript
for (const action of actions) {
  // Нормализация селектора
  const normalizedSelector = this.normalizeSelector(action.selector);

  // Выполнение через CommandExecutor
  const executionResult = await this.commandExecutor.executeCommand({
    action: action.action,
    selector: normalizedSelector,
    value: action.value,
    // ...
  });
}
```

**Статус:** ✅ **ПРАВИЛЬНО** - выполняет действия корректно

---

### **STEP 6: CommandExecutor выполняет действие** ✅ РАБОТАЕТ

**Файл:** `src/agent/command-executor.ts:196-440`

**Что происходит:**
```typescript
switch (action) {
  case 'click':
    const locator = this.getLocator(normalizedSelector);
    await locator.click();
    break;
  case 'fill':
    const locator = this.getLocator(normalizedSelector);
    await locator.fill(value);
    break;
  // ... все 30+ действий
}
```

**Статус:** ✅ **ПРАВИЛЬНО** - поддерживает все действия

---

## 🚨 КРИТИЧЕСКАЯ ПРОБЛЕМА

### **Санитизация отклоняет валидные действия!**

**Проблема:**
```typescript
// AI может генерировать:
{
  "action": "dblclick",
  "selector": "role=button[name=\"Submit\"]",
  "description": "Double-click submit button"
}

// Санитизация отклоняет:
if (!validActions.includes(action.action)) {
  logger.warn('[ACTION_GENERATOR] Invalid action type', { action: action.action });
  continue; // ❌ Пропускает действие!
}
```

**Результат:**
- AI генерирует правильное действие
- Санитизация отклоняет его
- Действие НЕ выполняется
- Тест не работает как ожидалось

---

## 🔧 Что нужно исправить

### **1. Обновить список validActions в sanitizeActions**

**Файл:** `src/agent/contextual-action-generator.ts:510-531`

**Добавить:**
```typescript
const validActions = [
  // Navigation
  'goto', 'goBack', 'goForward', 'reload',
  // Interactions
  'click', 'dblclick', 'fill', 'type', 'select', 'check', 'uncheck',
  'hover', 'focus', 'blur', 'press',
  // Drag & Drop / Mobile
  'dragAndDrop', 'tap', 'swipe',
  // Wait & Scroll
  'wait', 'waitForSelector', 'waitForTimeout', 'waitForLoadState',
  'waitForNavigation', 'scroll', 'scrollIntoView',
  // Assertions
  'assertVisible', 'assertHidden', 'assertEnabled', 'assertDisabled',
  'assertText', 'assertValue', 'assertUrl', 'assertCount',
  // Data & Scripts
  'extract', 'evaluate', 'screenshot',
];
```

### **2. Обновить промпт для AI**

**Файл:** `src/ai/prompts/index.ts:735`

**Добавить все действия:**
```typescript
"action": "click|dblclick|fill|type|select|check|uncheck|hover|focus|blur|press|dragAndDrop|tap|swipe|wait|scroll|scrollIntoView|goBack|goForward|reload|assertVisible|assertText|extract|screenshot",
```

---

## 📊 Сводная таблица

| Step | Компонент | Статус | Проблема |
|------|-----------|--------|----------|
| 1 | DOM Extraction | ✅ Работает | - |
| 2 | Передача в AI | ✅ Работает | - |
| 3 | AI Generation | ✅ Работает | - |
| 4 | **Sanitization** | ❌ **НЕ РАБОТАЕТ** | **Отклоняет 11 валидных действий** |
| 5 | Orchestrator | ✅ Работает | - |
| 6 | CommandExecutor | ✅ Работает | - |

---

## ✅ Вывод

**Проблема:** Санитизация в `contextual-action-generator.ts` отклоняет валидные действия.

**Решение:** Обновить список `validActions` чтобы включить все 30+ действий.

**Влияние:**
- **До:** AI может генерировать только 20 действий из 30+
- **После:** AI сможет генерировать ВСЕ 30+ действий

---

**Статус:** Требуется исправление в `sanitizeActions()`
