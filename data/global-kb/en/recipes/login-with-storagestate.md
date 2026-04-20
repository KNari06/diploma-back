# Login once, reuse everywhere (storageState)

Logging in at the start of every test is the single biggest waste of time in most suites. Log in once, serialize the authenticated context, reuse it.

## The recipe

```ts
// tests/auth.setup.ts
import { test as setup, expect } from '@playwright/test';

const AUTH_FILE = '.auth/user.json';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.TEST_EMAIL!);
  await page.getByLabel('Password').fill(process.env.TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for something that only exists after successful login
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Persist cookies + localStorage to disk
  await page.context().storageState({ path: AUTH_FILE });
});
```

```ts
// playwright.config.ts
export default defineConfig({
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});
```

Every test in `chromium` project now starts already logged in. The `setup` project runs once before the suite.

## Multiple roles

When tests need different user roles (admin, member, guest), save each to its own file:

```ts
setup('authenticate as admin', async ({ page }) => { /* ... */
  await page.context().storageState({ path: '.auth/admin.json' });
});

setup('authenticate as member', async ({ page }) => { /* ... */
  await page.context().storageState({ path: '.auth/member.json' });
});
```

Then use the right one per project or per test via `test.use({ storageState: '.auth/admin.json' })`.

## Refreshing when sessions expire

Delete the auth file in CI if the token TTL is short, or add a `setup.beforeAll` that checks expiry and reauthenticates.

## Never commit auth files

Add `.auth/` to `.gitignore`. Auth files contain real session cookies.

## Why not an API-based login?

API-based login (POST to `/api/login`, then `context.addCookies`) is even faster. Use it when the login form is fragile or when you have an API account. The principle is the same: log in outside the test, reuse across tests.
