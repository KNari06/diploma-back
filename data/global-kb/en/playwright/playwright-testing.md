# Playwright Testing Guide

## What is Playwright?

Playwright is a modern end-to-end testing framework for web applications. It allows you to automate browser interactions across Chromium, Firefox, and WebKit with a single API.

## Key Features

### Cross-Browser Testing

- Chromium (Chrome, Edge)
- Firefox
- WebKit (Safari)
- Mobile browsers (emulation)

### Automatic Waiting

Playwright automatically waits for elements to be ready before performing actions:

```javascript
await page.click("button"); // Waits for button to be visible and enabled
await page.fill("input", "text"); // Waits for input to be ready
```

### Network Interception

Monitor and modify network requests:

```javascript
await page.route("**/api/data", (route) => {
  route.fulfill({ body: '{"mocked": true}' });
});
```

### Screenshots and Videos

```javascript
await page.screenshot({ path: "screenshot.png" });
await context.tracing.start({ screenshots: true, snapshots: true });
```

## Common Commands

### Navigation

```javascript
// Go to URL
await page.goto("https://example.com");

// Wait for navigation
await page.waitForNavigation();

// Go back
await page.goBack();
```

### Element Interaction

#### Click

```javascript
await page.click("button#submit");
await page.click("text=Login");
await page.click('[data-testid="buy-button"]');
```

#### Fill Forms

```javascript
await page.fill("input#email", "test@example.com");
await page.fill('input[name="password"]', "password123");
await page.type("textarea", "Long text...");
```

#### Select

```javascript
await page.selectOption("select#country", "USA");
await page.selectOption("select", { label: "Blue" });
```

#### Checkbox and Radio

```javascript
await page.check('input[type="checkbox"]');
await page.uncheck('input[type="checkbox"]');
await page.click('input[type="radio"][value="option1"]');
```

### Assertions

#### Visibility

```javascript
await expect(page.locator("text=Welcome")).toBeVisible();
await expect(page.locator(".error")).toBeHidden();
```

#### Text Content

```javascript
await expect(page.locator("h1")).toHaveText("Dashboard");
await expect(page.locator(".message")).toContainText("Success");
```

#### Attributes

```javascript
await expect(page.locator("button")).toBeDisabled();
await expect(page.locator("button")).toBeEnabled();
await expect(page.locator("input")).toHaveValue("test@example.com");
```

#### Count

```javascript
await expect(page.locator(".item")).toHaveCount(5);
```

### Waiting

#### Wait for Selector

```javascript
await page.waitForSelector(".content");
await page.waitForSelector("button", { state: "visible" });
```

#### Wait for URL

```javascript
await page.waitForURL("**/dashboard");
```

#### Wait for Load State

```javascript
await page.waitForLoadState("networkidle");
await page.waitForLoadState("domcontentloaded");
```

#### Custom Wait

```javascript
await page.waitForFunction(() => window.dataLoaded === true);
```

## Selectors

### CSS Selectors

```javascript
"button#submit";
"input.email-field";
".container > .item";
'[data-testid="login-form"]';
```

### Text Selectors

```javascript
"text=Login";
'text="Exact match"';
"text=/regex pattern/i";
```

### XPath

```javascript
'xpath=//button[contains(text(), "Submit")]';
```

### Combined

```javascript
"css=form >> text=Submit";
```

## Best Practices

### Use Data Test IDs

```html
<button data-testid="submit-button">Submit</button>
```

```javascript
await page.click('[data-testid="submit-button"]');
```

### Use Auto-Waiting

Don't use manual waits when possible:

```javascript
// ❌ Bad
await page.waitForTimeout(5000);
await page.click("button");

// ✅ Good
await page.click("button"); // Auto-waits
```

### Use Locators

```javascript
// ✅ Better
const submitButton = page.locator("button#submit");
await submitButton.click();
await expect(submitButton).toBeVisible();
```

### Handle Multiple Elements

```javascript
const items = page.locator(".item");
const count = await items.count();

for (let i = 0; i < count; i++) {
  await items.nth(i).click();
}
```

## Trace Files

Playwright can record traces for debugging:

```javascript
await context.tracing.start({ screenshots: true, snapshots: true });
// Run tests
await context.tracing.stop({ path: "trace.zip" });
```

Trace files contain:

- Screenshots of each action
- DOM snapshots
- Network logs
- Console logs
- Timing information

View traces:

```bash
npx playwright show-trace trace.zip
```

## Mobile Testing

```javascript
const iPhone = devices["iPhone 12"];

const context = await browser.newContext({
  ...iPhone,
});

const page = await context.newPage();
await page.goto("https://example.com");
```

## Error Handling

### Try-Catch

```javascript
try {
  await page.click("button", { timeout: 5000 });
} catch (error) {
  console.log("Button not found");
}
```

### Soft Assertions

```javascript
await expect.soft(page.locator(".error")).toBeVisible();
// Test continues even if assertion fails
```

## Common Issues

### Element Not Found

- Check selector is correct
- Element might not be loaded yet
- Element might be in shadow DOM
- Element might be hidden by CSS

### Click Intercepted

- Another element is covering the target
- Element is not fully visible
- Page is still loading

### Timeout Errors

- Increase timeout: `{ timeout: 30000 }`
- Check network is stable
- Element selector might be wrong

## Configuration

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

## Test Structure

```javascript
import { test, expect } from "@playwright/test";

test.describe("Login Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("should login successfully", async ({ page }) => {
    await page.fill("input#email", "test@example.com");
    await page.fill("input#password", "password123");
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL("/dashboard");
    await expect(page.locator("text=Welcome")).toBeVisible();
  });

  test("should show error for invalid credentials", async ({ page }) => {
    await page.fill("input#email", "wrong@example.com");
    await page.fill("input#password", "wrongpass");
    await page.click('button[type="submit"]');

    await expect(page.locator(".error")).toBeVisible();
    await expect(page.locator(".error")).toHaveText("Invalid credentials");
  });
});
```
