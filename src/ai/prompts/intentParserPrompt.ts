
/**
 * Context for enriching intent parsing
 */
export interface IntentParserContext {
  documentation?: string[];
  knownSelectors?: Record<string, string>;
  tracesContext?: string;
  projectInfo?: string;
}

/**
 * Build intent parsing prompt for OpenAI
 * @param userMessage - User's natural language message
 * @param context - Additional context from RAG, traces, etc.
 * @returns Formatted prompt for intent parsing
 */
export function buildIntentPrompt(
  userMessage: string,
  context?: IntentParserContext
): string {
  let prompt = `Ты AI-тестировщик на платформе QAI. Преобразуй пользовательский запрос в JSON-структуру для автоматизации тестирования.

Твоя задача:
1. Определить intent (что хочет пользователь)
2. Сгенерировать массив команд Playwright для выполнения теста

Рекомендуемые интенты (intent):
- "check_element" - проверить элемент (видимость, клик, состояние)
- "fill_form" - заполнить форму
- "login_flow" - авторизация/вход
- "assert_ui" - проверить UI/дизайн
- "navigate" - навигация по странице
- "api_test" - тестирование API/HTTP запросов
- "general_chat" - обычный чат без тестирования

Доступные типы команд Playwright:
- "goto" - открыть страницу (url обязателен)
- "click" - кликнуть элемент (selector обязателен)
- "fill" - заполнить поле (selector и value обязательны)
- "type" - ввести текст медленно (selector и value обязательны)
- "check" - чекнуть чекбокс (selector обязателен)
- "select" - выбрать из dropdown (selector и value обязательны)
- "hover" - навестись на элемент
- "waitForSelector" - подождать появления элемента
- "screenshot" - сделать скриншот
- "assertVisible" - проверить что элемент видимый
- "assertText" - проверить текст элемента
- "assertUrl" - проверить URL
- "press" - нажать клавишу клавиатуры

Селекторы (примеры):
- CSS: "button", ".btn-primary", "#submit"
- Text: "text=Login", "button:has-text('Buy')"
- Aria: "button[aria-label='Close']"
- Placeholder: "input[placeholder='Email']"

ВАЖНО:
- Если URL не указан, НЕ добавляй команду "goto"
- Всегда добавляй проверки (assert) после действий
- Используй понятные description для каждой команды
- Если не уверен в селекторе - используй text selector

Примеры с командами:

Запрос: "Проверь кнопку Buy на https://shop.com/products"
Ответ:
{
  "intent": "check_element",
  "elementType": "button",
  "elementLabel": "Buy",
  "page": "https://shop.com/products",
  "viewport": "desktop",
  "commands": [
    {
      "action": "goto",
      "url": "https://shop.com/products",
      "waitFor": "networkidle",
      "description": "Open products page"
    },
    {
      "action": "waitForSelector",
      "selector": "button:has-text('Buy')",
      "timeout": 5000,
      "description": "Wait for Buy button to appear"
    },
    {
      "action": "assertVisible",
      "selector": "button:has-text('Buy')",
      "description": "Check that Buy button is visible"
    },
    {
      "action": "click",
      "selector": "button:has-text('Buy')",
      "description": "Click Buy button"
    },
    {
      "action": "screenshot",
      "description": "Take screenshot after click"
    }
  ]
}

Запрос: "Протестируй форму логина на https://app.example.com/login"
Ответ:
{
  "intent": "login_flow",
  "page": "https://app.example.com/login",
  "commands": [
    {
      "action": "goto",
      "url": "https://app.example.com/login",
      "description": "Navigate to login page"
    },
    {
      "action": "fill",
      "selector": "input[placeholder='Email']",
      "value": "test@example.com",
      "description": "Fill email field"
    },
    {
      "action": "fill",
      "selector": "input[type='password']",
      "value": "testpass123",
      "description": "Fill password field"
    },
    {
      "action": "click",
      "selector": "button:has-text('Login')",
      "description": "Click login button"
    },
    {
      "action": "waitForNavigation",
      "timeout": 5000,
      "description": "Wait for redirect after login"
    },
    {
      "action": "assertUrl",
      "assertion": {
        "type": "url",
        "expected": "/dashboard",
        "operator": "contains"
      },
      "description": "Check redirected to dashboard"
    }
  ]
}

Запрос: "Проверь что кнопка Add to Cart отображается"
Ответ:
{
  "intent": "check_element",
  "elementType": "button",
  "elementLabel": "Add to Cart",
  "commands": [
    {
      "action": "assertVisible",
      "selector": "button:has-text('Add to Cart')",
      "description": "Verify Add to Cart button is visible"
    },
    {
      "action": "screenshot",
      "description": "Take screenshot"
    }
  ]
}

Запрос: "Кликни на кнопку Submit"
Ответ:
{
  "intent": "check_element",
  "elementType": "button",
  "elementLabel": "Submit",
  "commands": [
    {
      "action": "click",
      "selector": "button:has-text('Submit')",
      "description": "Click Submit button"
    }
  ]
}

Запрос: "Привет, как дела?"
Ответ:
{
  "intent": "general_chat"
}

Запрос: "Проверь GET /api/users"
Ответ:
{
  "intent": "api_test",
  "apiMethod": "GET",
  "apiUrl": "/api/users",
  "expectedStatus": 200
}

Запрос: "${userMessage}"
Ответ (только JSON, без дополнительного текста):`;

  // Add context if provided
  if (context) {
    // Add project documentation
    if (context.documentation && context.documentation.length > 0) {
      prompt += `\n\n=== PROJECT DOCUMENTATION ===\n`;
      prompt += 'Use this documentation to understand the project context:\n\n';
      for (const doc of context.documentation.slice(0, 3)) {
        prompt += `${doc}\n\n`;
      }
    }

    // Add known selectors from traces
    if (context.knownSelectors && Object.keys(context.knownSelectors).length > 0) {
      prompt += `\n\n=== KNOWN SELECTORS FROM PREVIOUS TESTS ===\n`;
      prompt += '⚠️ IMPORTANT: Use these EXACT selectors when they match the user request!\n\n';

      for (const [label, selector] of Object.entries(context.knownSelectors)) {
        prompt += `- ${label}: "${selector}"\n`;
      }

      prompt += '\n💡 These selectors are from real tests and are guaranteed to work.\n';
      prompt += '🚫 DO NOT guess selectors if you have a matching one above!\n';
    }

    // Add traces context (example flows)
    if (context.tracesContext) {
      prompt += `\n\n${context.tracesContext}`;
    }
  }

  prompt += `\n\nUser request: "${userMessage}"\n`;
  prompt += `Response (ONLY JSON, no additional text):`;

  return prompt;
}
