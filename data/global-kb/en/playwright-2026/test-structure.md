# Test structure and fixtures

Well-structured tests are short, independent, and readable by someone who did not write them.

## One test = one user-visible outcome

A test should describe one behavior in its title and verify it. If a test needs "and also" in its description, split it.

```ts
// Good
test('user sees welcome message after successful login', async ({ page }) => { ... });
test('user sees error on invalid password', async ({ page }) => { ... });

// Bad — two concerns in one test
test('login works and dashboard loads and logout redirects', async ({ page }) => { ... });
```

## Independence

Every test must pass when run alone. No ordering, no shared mutable state, no leftover data from the previous test.

Use fixtures or `beforeEach` for setup, not for wiring one test's output into another.

## describe / beforeEach

Group tests that share setup. Setup runs before every test, so the block stays self-contained.

```ts
test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('user@example.com');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('shows recent activity', async ({ page }) => {
    await expect(page.getByRole('region', { name: 'Recent activity' })).toBeVisible();
  });

  test('allows creating a new project', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('dialog', { name: 'Create project' })).toBeVisible();
  });
});
```

## Prefer storageState over repeated login

Logging in for every test wastes time. Save the authenticated state once, reuse it.

```ts
// auth.setup.ts (project dependency)
test('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.TEST_EMAIL!);
  await page.getByLabel('Password').fill(process.env.TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.context().storageState({ path: '.auth/user.json' });
});

// playwright.config.ts
use: {
  storageState: '.auth/user.json',
}
```

## Custom fixtures for domain objects

When many tests need the same entity, extract a fixture:

```ts
export const test = base.extend<{ authenticatedUser: Page }>({
  authenticatedUser: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: '.auth/user.json' });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});
```

## Keep the body short

If a test body grows past 20 lines, move part of it into a page object or a helper. A reader should see the intent in ten seconds.

## Configuration baseline

```ts
// playwright.config.ts
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
```

`trace: 'on-first-retry'` gives full debugging data only when needed. `screenshot: 'only-on-failure'` avoids cluttering passing runs.
