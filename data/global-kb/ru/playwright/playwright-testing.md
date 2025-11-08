# Руководство по тестированию с Playwright

## Что такое Playwright?

Playwright — это современный фреймворк для end-to-end тестирования веб-приложений. Он позволяет автоматизировать взаимодействие с браузерами Chromium, Firefox и WebKit через единый API.

## Ключевые возможности

### Кроссбраузерное тестирование

- Chromium (Chrome, Edge)
- Firefox
- WebKit (Safari)
- Мобильные браузеры (эмуляция)

### Автоматическое ожидание

Playwright автоматически ждет готовности элементов перед выполнением действий:

```javascript
await page.click("button"); // Ждет, пока кнопка станет видимой и активной
await page.fill("input", "text"); // Ждет готовности поля ввода
```

### Перехват сетевых запросов

Мониторинг и изменение сетевых запросов:

```javascript
await page.route("**/api/data", (route) => {
  route.fulfill({ body: '{"mocked": true}' });
});
```

### Скриншоты и видео

```javascript
await page.screenshot({ path: "screenshot.png" });
await context.tracing.start({ screenshots: true, snapshots: true });
```

## Основные команды

### Навигация

```javascript
// Переход по URL
await page.goto("https://example.com");

// Ожидание навигации
await page.waitForNavigation();

// Назад
await page.goBack();
```

### Взаимодействие с элементами

#### Клик

```javascript
await page.click("button#submit");
await page.click("text=Войти");
await page.click('[data-testid="buy-button"]');
```

#### Заполнение форм

```javascript
await page.fill("input#email", "test@example.com");
await page.fill('input[name="password"]', "password123");
await page.type("textarea", "Длинный текст...");
```

#### Выбор

```javascript
await page.selectOption("select#country", "USA");
await page.selectOption("select", { label: "Синий" });
```

#### Чекбоксы и радиокнопки

```javascript
await page.check('input[type="checkbox"]');
await page.uncheck('input[type="checkbox"]');
await page.click('input[type="radio"][value="option1"]');
```

### Проверки (Assertions)

#### Видимость

```javascript
await expect(page.locator("text=Добро пожаловать")).toBeVisible();
await expect(page.locator(".error")).toBeHidden();
```

#### Текстовое содержимое

```javascript
await expect(page.locator("h1")).toHaveText("Панель управления");
await expect(page.locator(".message")).toContainText("Успешно");
```

#### Атрибуты

```javascript
await expect(page.locator("button")).toBeDisabled();
await expect(page.locator("button")).toBeEnabled();
await expect(page.locator("input")).toHaveValue("test@example.com");
```

#### Количество

```javascript
await expect(page.locator(".item")).toHaveCount(5);
```

### Ожидание

#### Ожидание селектора

```javascript
await page.waitForSelector(".content");
await page.waitForSelector("button", { state: "visible" });
```

#### Ожидание URL

```javascript
await page.waitForURL("**/dashboard");
```

#### Ожидание состояния загрузки

```javascript
await page.waitForLoadState("networkidle");
await page.waitForLoadState("domcontentloaded");
```

#### Пользовательское ожидание

```javascript
await page.waitForFunction(() => window.dataLoaded === true);
```

## Селекторы

### CSS селекторы

```javascript
"button#submit";
"input.email-field";
".container > .item";
'[data-testid="login-form"]';
```

### Текстовые селекторы

```javascript
"text=Войти";
'text="Точное совпадение"';
"text=/регулярное выражение/i";
```

### XPath

```javascript
'xpath=//button[contains(text(), "Отправить")]';
```

### Комбинированные

```javascript
"css=form >> text=Отправить";
```

## Лучшие практики

### Используйте Data Test ID

```html
<button data-testid="submit-button">Отправить</button>
```

```javascript
await page.click('[data-testid="submit-button"]');
```

### Используйте автоожидание

Не используйте ручные ожидания, когда это возможно:

```javascript
// ❌ Плохо
await page.waitForTimeout(5000);
await page.click("button");

// ✅ Хорошо
await page.click("button"); // Автоматическое ожидание
```

### Используйте локаторы

```javascript
// ✅ Лучше
const submitButton = page.locator("button#submit");
await submitButton.click();
await expect(submitButton).toBeVisible();
```

### Работа с множественными элементами

```javascript
const items = page.locator(".item");
const count = await items.count();

for (let i = 0; i < count; i++) {
  await items.nth(i).click();
}
```

## Файлы трассировки

Playwright может записывать трассировки для отладки:

```javascript
await context.tracing.start({ screenshots: true, snapshots: true });
// Выполнение тестов
await context.tracing.stop({ path: "trace.zip" });
```

Файлы трассировки содержат:

- Скриншоты каждого действия
- Снимки DOM
- Сетевые логи
- Логи консоли
- Информацию о времени выполнения

Просмотр трассировок:

```bash
npx playwright show-trace trace.zip
```

## Мобильное тестирование

```javascript
const iPhone = devices["iPhone 12"];

const context = await browser.newContext({
  ...iPhone,
});

const page = await context.newPage();
await page.goto("https://example.com");
```

## Обработка ошибок

### Try-Catch

```javascript
try {
  await page.click("button", { timeout: 5000 });
} catch (error) {
  console.log("Кнопка не найдена");
}
```

### Мягкие проверки

```javascript
await expect.soft(page.locator(".error")).toBeVisible();
// Тест продолжается, даже если проверка не прошла
```

## Частые проблемы

### Элемент не найден

- Проверьте правильность селектора
- Элемент может еще не загрузиться
- Элемент может быть в shadow DOM
- Элемент может быть скрыт CSS

### Клик перехвачен

- Другой элемент закрывает целевой
- Элемент не полностью видим
- Страница все еще загружается

### Ошибки таймаута

- Увеличьте таймаут: `{ timeout: 30000 }`
- Проверьте стабильность сети
- Селектор элемента может быть неправильным

## Конфигурация

### playwright.config.js

```javascript
export default {
  testDir: "./tests",
  timeout: 30000,
  retries: 2,
  use: {
    baseURL: "https://example.com",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
};
```

## Структура тестов

```javascript
import { test, expect } from "@playwright/test";

test.describe("Процесс входа", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("должен успешно войти в систему", async ({ page }) => {
    await page.fill("input#email", "test@example.com");
    await page.fill("input#password", "password123");
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL("/dashboard");
    await expect(page.locator("text=Добро пожаловать")).toBeVisible();
  });

  test("должен показать ошибку для неверных данных", async ({ page }) => {
    await page.fill("input#email", "wrong@example.com");
    await page.fill("input#password", "wrongpass");
    await page.click('button[type="submit"]');

    await expect(page.locator(".error")).toBeVisible();
    await expect(page.locator(".error")).toHaveText("Неверные данные");
  });
});
```
