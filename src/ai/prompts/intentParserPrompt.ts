
/**
 * Build intent parsing prompt for OpenAI
 * @param userMessage - User's natural language message
 * @returns Formatted prompt for intent parsing
 */
export function buildIntentPrompt(userMessage: string): string {
  return `Ты AI-тестировщик на платформе QAI. Преобразуй пользовательский запрос в JSON-структуру для тестирования.

Рекомендуемые интенты (intent) - можно использовать свои если не подходят:
- "check_element" - проверить элемент (видимость, клик, состояние)
- "fill_form" - заполнить форму
- "login_flow" - авторизация/вход
- "assert_ui" - проверить UI/дизайн
- "navigate" - навигация по странице
- "api_test" - тестирование API/HTTP запросов (GET, POST, PUT, DELETE и т.д.)
- "general_chat" - обычный чат без тестирования

Рекомендуемые типы элементов (elementType) - можно использовать свои:
"button", "input", "text", "link", "image", "form", "select", "checkbox", "radio"

Вьюпорт (viewport): "mobile" | "desktop" (или свой если нужно)

Рекомендуемые действия (action) - можно использовать свои:
"click", "visible", "input", "submit", "check", "navigate"

ВАЖНО: Если запрос не подходит под категории - используй ближайшую или создай свою. Главное чтобы было полезно для тестирования.

Примеры:

Запрос: "Проверь, что кнопка Buy работает на мобильной версии"
Ответ:
{
  "intent": "check_element",
  "elementType": "button",
  "elementLabel": "Buy",
  "viewport": "mobile",
  "action": "click"
}

Запрос: "Проверь, что кнопка Add to Cart отображается на десктопе"
Ответ:
{
  "intent": "check_element",
  "elementType": "button",
  "elementLabel": "Add to Cart",
  "viewport": "desktop",
  "action": "visible"
}

Запрос: "Заполни форму регистрации"
Ответ:
{
  "intent": "fill_form",
  "elementType": "form",
  "action": "input"
}

Запрос: "Привет, как дела?"
Ответ:
{
  "intent": "general_chat"
}

Запрос: "Проверь, что GET запрос на /api/users возвращает статус 200"
Ответ:
{
  "intent": "api_test",
  "apiMethod": "GET",
  "apiUrl": "/api/users",
  "expectedStatus": 200
}

Запрос: "Проверь POST https://api.myapp.com/login с телом {\"email\":\"test@test.com\"} возвращает 401"
Ответ:
{
  "intent": "api_test",
  "apiMethod": "POST",
  "apiUrl": "https://api.myapp.com/login",
  "apiBody": {"email": "test@test.com"},
  "expectedStatus": 401
}

Запрос: "Сделай GET запрос на https://api.example.com/data"
Ответ:
{
  "intent": "api_test",
  "apiMethod": "GET",
  "apiUrl": "https://api.example.com/data"
}

Запрос: "${userMessage}"
Ответ (только JSON, без дополнительного текста):`;
}
