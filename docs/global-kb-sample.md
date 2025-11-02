# Playwright Testing Guide for QAI

## Что такое Playwright?

Playwright - это современный фреймворк для E2E (end-to-end) тестирования веб-приложений. Он поддерживает Chrome, Firefox, Safari и мобильные браузеры.

## Основы автоматизации

### Запуск браузера и навигация

```typescript
import { chromium, firefox, webkit } from 'playwright';

// Запуск браузера
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

// Навигация
await page.goto('https://example.com');
await page.goto('https://example.com', { waitUntil: 'networkidle' });
```

### Взаимодействие с элементами

```typescript
// Клик
await page.click('button.submit');
await page.click('text=Login');

// Заполнение форм
await page.fill('input[name="email"]', 'test@example.com');
await page.fill('#password', 'secret123');

// Выбор из dropdown
await page.selectOption('select#country', 'USA');

// Чекбоксы и радио кнопки
await page.check('input[type="checkbox"]');
await page.uncheck('input[type="checkbox"]');
```

### Ожидание элементов

```typescript
// Ждать элемент
await page.waitForSelector('div.content');

// Ждать загрузку страницы
await page.waitForLoadState('networkidle');

// Ждать навигацию
await Promise.all([
  page.waitForNavigation(),
  page.click('a.next')
]);
```

### Проверки (Assertions)

```typescript
import { expect } from '@playwright/test';

// Проверка текста
await expect(page.locator('h1')).toContainText('Welcome');
await expect(page.locator('.error')).toHaveText('Invalid email');

// Проверка видимости
await expect(page.locator('.modal')).toBeVisible();
await expect(page.locator('.spinner')).toBeHidden();

// Проверка URL
await expect(page).toHaveURL('https://example.com/dashboard');

// Проверка атрибутов
await expect(page.locator('button')).toHaveAttribute('disabled', '');
```

## API тестирование в Playwright

### GET запросы

```typescript
// Простой GET
const response = await page.request.get('https://api.example.com/users');
expect(response.status()).toBe(200);

const data = await response.json();
console.log(data);

// GET с параметрами
const response = await page.request.get('https://api.example.com/users', {
  params: {
    page: 1,
    limit: 10
  }
});
```

### POST запросы

```typescript
// POST с JSON
const response = await page.request.post('https://api.example.com/login', {
  data: {
    email: 'user@example.com',
    password: 'secret123'
  }
});

expect(response.status()).toBe(200);
const result = await response.json();
const token = result.token;
```

### PUT/PATCH запросы

```typescript
// Обновление данных
const response = await page.request.patch('https://api.example.com/users/123', {
  data: {
    name: 'Updated Name'
  },
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

expect(response.status()).toBe(200);
```

### DELETE запросы

```typescript
const response = await page.request.delete('https://api.example.com/users/123', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

expect(response.status()).toBe(204);
```

### Проверка API ответов

```typescript
// Проверка статуса
expect(response.status()).toBe(200);
expect(response.ok()).toBeTruthy();

// Проверка заголовков
expect(response.headers()['content-type']).toContain('application/json');

// Проверка тела ответа
const data = await response.json();
expect(data).toHaveProperty('id');
expect(data.email).toBe('test@example.com');
```

## UI тестирование - Best Practices

### 1. Используй data-testid для селекторов

```html
<button data-testid="submit-button">Submit</button>
```

```typescript
await page.click('[data-testid="submit-button"]');
```

### 2. Группируй тесты

```typescript
import { test, expect } from '@playwright/test';

test.describe('Login flow', () => {
  test('should login with valid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[data-testid="email"]', 'user@test.com');
    await page.fill('[data-testid="password"]', 'password123');
    await page.click('[data-testid="login-button"]');

    await expect(page).toHaveURL('/dashboard');
  });

  test('should show error with invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[data-testid="email"]', 'wrong@test.com');
    await page.fill('[data-testid="password"]', 'wrong');
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('.error')).toContainText('Invalid credentials');
  });
});
```

### 3. Используй beforeEach для setup

```typescript
test.describe('Dashboard tests', () => {
  test.beforeEach(async ({ page }) => {
    // Логин перед каждым тестом
    await page.goto('/login');
    await page.fill('[data-testid="email"]', 'user@test.com');
    await page.fill('[data-testid="password"]', 'password123');
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/dashboard');
  });

  test('should display user stats', async ({ page }) => {
    await expect(page.locator('.stats')).toBeVisible();
  });
});
```

### 4. Page Object Model (POM)

```typescript
// pages/LoginPage.ts
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.page.fill('[data-testid="email"]', email);
    await this.page.fill('[data-testid="password"]', password);
    await this.page.click('[data-testid="login-button"]');
  }

  async getErrorMessage() {
    return await this.page.locator('.error').textContent();
  }
}

// В тесте
import { LoginPage } from './pages/LoginPage';

test('login test', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('user@test.com', 'password123');
});
```

## Работа с мобильными устройствами

```typescript
import { devices } from '@playwright/test';

// iPhone 13
const iPhone = devices['iPhone 13'];
const browser = await chromium.launch();
const context = await browser.newContext({
  ...iPhone,
});

const page = await context.newPage();
await page.goto('https://example.com');
```

## Скриншоты и видео

```typescript
// Скриншот
await page.screenshot({ path: 'screenshot.png' });

// Скриншот элемента
await page.locator('.header').screenshot({ path: 'header.png' });

// Полная страница
await page.screenshot({ path: 'fullpage.png', fullPage: true });

// Видео (настроить в playwright.config.ts)
use: {
  video: 'on',
}
```

## Работа с файлами

```typescript
// Загрузка файла
await page.setInputFiles('input[type="file"]', 'path/to/file.pdf');

// Скачивание файла
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('a[download]')
]);

await download.saveAs('/path/to/save/file.pdf');
```

## Отладка тестов

```typescript
// Пауза для инспекции
await page.pause();

// Режим отладки
npx playwright test --debug

// Headed режим
npx playwright test --headed

// Slow motion
const browser = await chromium.launch({ slowMo: 1000 });
```

## Частые проблемы и решения

### Элемент не найден
```typescript
// Плохо
await page.click('button');

// Хорошо - явное ожидание
await page.waitForSelector('button', { state: 'visible' });
await page.click('button');
```

### Проверка несуществующего элемента
```typescript
// Проверка что элемент не отображается
await expect(page.locator('.modal')).toBeHidden();
await expect(page.locator('.modal')).not.toBeVisible();
```

### Работа с iframe
```typescript
const frame = page.frameLocator('iframe[name="myframe"]');
await frame.locator('button').click();
```

### Перехват сетевых запросов
```typescript
// Mock API response
await page.route('**/api/users', route => {
  route.fulfill({
    status: 200,
    body: JSON.stringify([
      { id: 1, name: 'Test User' }
    ])
  });
});
```

## Конфигурация playwright.config.ts

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 2,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
});
```
