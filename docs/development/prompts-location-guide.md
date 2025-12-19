# Расположение AI промптов в проекте

## Основной файл: `src/ai/prompts/index.ts`

**✅ БОЛЬШИНСТВО промптов централизованы здесь.**

### Структура промптов в `index.ts`:

1. **Intent Parser Prompts**

   - `buildIntentPrompt()` - основной промпт для парсинга намерений

2. **API Test Plan Prompts**

   - `buildApiTestPlanPrompt()` - генерация планов для API тестов

3. **Chat/Conversation Prompts**

   - `buildChatSystemPrompt()` - системный промпт для чата

4. **Approval Detection Prompts**

   - `buildApprovalDetectionPrompt()` - детекция approval/rejection

5. **API Fuzzing Prompts**

   - `buildApiFuzzingPrompt()` - промпты для фаззинга

6. **Intelligent Testing Prompts**

   - `buildPageAnalysisPrompt()` - анализ страницы
   - `buildActionGenerationPrompt()` - генерация действий
   - `buildNextStepPrompt()` - следующий шаг
   - `buildLogicAnalysisPrompt()` - анализ логики

7. **Vision Analysis Prompts**

   - `buildVisionPrompt()` - промпты для vision API

8. **Test Plan Generator Prompts**

   - `buildTestPlanPrompt()` - генерация тест-планов

9. **Dynamic Question Generation Prompts**

   - `buildDynamicQuestionPrompt()` - динамические вопросы

10. **Utilities**
    - `buildContextString()` - форматирование контекста

### Экспорт:

```typescript
export const Prompts = {
  buildIntentPrompt,
  buildApiTestPlanPrompt,
  buildChatSystemPrompt,
  buildApprovalDetectionPrompt,
  buildApiFuzzingPrompt,
  buildPageAnalysisPrompt,
  buildActionGenerationPrompt,
  buildNextStepPrompt,
  buildLogicAnalysisPrompt,
  buildVisionPrompt,
  buildTestPlanPrompt,
  buildDynamicQuestionPrompt,
  buildContextString,
};
```

---

## ⚠️ Промпты ВНЕ централизованного файла

### 1. `src/services/ai/ai-helpers.service.ts`

**Промпты:**

#### Login Page Detection (строка 163)

```typescript
const prompt = `You are analyzing a website to find the login page.

Base URL: ${baseUrl}

Available links:
${links
  .slice(0, 20)
  .map((l: any, i: number) => `${i + 1}. "${l.text}" → ${l.href}`)
  .join("\n")}

Which link is most likely the login page? Return ONLY the href value, nothing else.
If none look like login, return "null".

Response:`;
```

**Использование:** `detectLoginPage()`

---

#### Selector Validation (строка 234)

```typescript
const prompt = `You are a Playwright selector expert.

Task: Validate this CSS selector for reliability and suggest improvements if needed.

Selector: "${selector}"
Element purpose: "${elementPurpose}"
${domContext ? `\nDOM context:\n${domContext.substring(0, 500)}` : ""}

Response format (JSON):
{
  "isValid": true/false,
  "confidence": 0.0-1.0,
  "suggestion": "improved selector" (optional),
  "reasoning": "why this selector is good/bad"
}`;
```

**Использование:** `validateSelector()`

---

#### Parse User Answers (строка 310)

```typescript
const prompt = `Parse user's natural language response into structured answers.

Questions asked:
${questions.map((q) => `- ${q.id} (${q.type}): ${q.question}`).join("\n")}

User's response:
"${userMessage}"

Extract answers in JSON format:
{
  "answers": [
    { "questionId": "url", "answer": "https://example.com" },
    { "questionId": "scope", "answer": "full" }
  ]
}`;
```

**Использование:** `parseUserAnswers()`

---

#### Navigation Helper (строка 414)

```typescript
const prompt = `Current page: ${currentUrl}
User wants to navigate to: "${targetDescription}"

Available navigation options:
${navigationOptions
  .map(
    (opt: any, i: number) =>
      `${i + 1}. ${opt.text} (${opt.type}) → ${opt.href || opt.selector}`
  )
  .join("\n")}

Which option best matches the user's navigation intent?
Return ONLY the number (1-based index) or "null" if none match.`;
```

**Использование:** `detectBestNavigationOption()`

---

### 2. `src/agent/post-action-analyzer.ts`

**Промпт:**

#### Post-Action Analysis (строка 385)

```typescript
const prompt = `You are a QA automation expert analyzing a web page after an action was executed.

ACTION EXECUTED:
- Type: ${context.action.action}
- Target: ${context.action.selector || "N/A"}
- Value: ${context.inputValue || context.action.value || "N/A"}
- Description: ${context.action.description}
- Result: ${
  context.actionResult.success
    ? "Success"
    : "Failed: " + context.actionResult.error
}
${executedActionText ? `- Action text: "${executedActionText}"` : ""}

TESTING GOAL: ${context.goal}

CHANGES DETECTED AFTER ACTION:
${changesDescription}

VISIBLE CLICKABLE ELEMENTS:
${visibleElementsList || "None detected"}

TASK:
Decide if any follow-up action is needed to complete the current step.

Common scenarios requiring follow-up:
1. Autocomplete: After typing, a suggestion appeared → click it
2. Dropdown: After clicking, options appeared → select one
3. Validation: Error appeared → fix the input
4. Modal: Dialog appeared → close or interact
5. Button state: A submit button became enabled → ready to proceed

RESPONSE (JSON only):
{
  "needsFollowUp": true/false,
  "reason": "<brief explanation>",
  "stateChange": "<what changed on the page>",
  "followUpActions": [
    {
      "action": "click|fill|select",
      "selectorIndex": <index from visible elements list>,
      "description": "<what this does>"
    }
  ],
  "confidence": 0.0-1.0
}`;
```

**Использование:** `analyzePostAction()`

---

## Статистика

### Централизованные промпты (в `src/ai/prompts/index.ts`):

- ✅ **13 функций** (основные промпты проекта)
- Покрывают: intent parsing, test plans, chat, approval, fuzzing, intelligent testing, vision

### Нецентрализованные промпты:

- ⚠️ **5 промптов** в других файлах
  - `src/services/ai/ai-helpers.service.ts` - 4 промпта
  - `src/agent/post-action-analyzer.ts` - 1 промпт

---

## Рекомендации

### ✅ Что хорошо:

- Большинство промптов централизованы
- Есть экспорт `Prompts` для удобного импорта
- Хорошая структура и документация

### ⚠️ Что можно улучшить:

#### 1. Централизовать оставшиеся промпты

Перенести промпты из `ai-helpers.service.ts` в `src/ai/prompts/index.ts`:

```typescript
// Добавить в index.ts:

// 11. Helper Prompts
export function buildLoginDetectionPrompt(
  baseUrl: string,
  links: any[]
): string {
  return `You are analyzing a website to find the login page.

Base URL: ${baseUrl}

Available links:
${links
  .slice(0, 20)
  .map((l: any, i: number) => `${i + 1}. "${l.text}" → ${l.href}`)
  .join("\n")}

Which link is most likely the login page? Return ONLY the href value, nothing else.
If none look like login, return "null".`;
}

export function buildSelectorValidationPrompt(
  selector: string,
  elementPurpose: string,
  domContext?: string
): string {
  return `You are a Playwright selector expert.

Task: Validate this CSS selector for reliability and suggest improvements if needed.

Selector: "${selector}"
Element purpose: "${elementPurpose}"
${domContext ? `\nDOM context:\n${domContext.substring(0, 500)}` : ""}

Response format (JSON):
{
  "isValid": true/false,
  "confidence": 0.0-1.0,
  "suggestion": "improved selector" (optional),
  "reasoning": "why this selector is good/bad"
}`;
}

// И т.д.
```

#### 2. Обновить экспорт

```typescript
export const Prompts = {
  // ... existing prompts ...

  // 11. Helper prompts
  buildLoginDetectionPrompt,
  buildSelectorValidationPrompt,
  buildUserAnswersParsingPrompt,
  buildNavigationDetectionPrompt,

  // 12. Agent prompts
  buildPostActionAnalysisPrompt,
};
```

#### 3. Обновить импорты

```typescript
// Before
const prompt = `You are analyzing...`;

// After
import { buildLoginDetectionPrompt } from "@/ai/prompts/index";
const prompt = buildLoginDetectionPrompt(baseUrl, links);
```

---

## Текущий ответ на вопрос

**Вопрос:** Все промпты в одном месте (index)?

**Ответ:**

- ✅ **Большинство (13 из 18)** - да, в `src/ai/prompts/index.ts`
- ⚠️ **5 промптов** разбросаны по другим файлам:
  - 4 в `src/services/ai/ai-helpers.service.ts`
  - 1 в `src/agent/post-action-analyzer.ts`

**Рекомендация:** Централизовать оставшиеся 5 промптов для единообразия.
