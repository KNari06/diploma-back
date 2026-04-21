# Web-first assertions

Web-first assertions auto-retry until the expected condition is met or the assertion timeout expires (default 5s). They are the correct way to wait for UI state — never use `waitForTimeout` for this.

## Canonical patterns

```ts
// Visibility
await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
await expect(page.getByText('Loading...')).toBeHidden();

// Text content
await expect(page.getByRole('alert')).toHaveText('Saved successfully');
await expect(page.getByRole('status')).toContainText('3 items');

// Input state
await expect(page.getByLabel('Email')).toHaveValue('user@example.com');
await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
await expect(page.getByRole('checkbox', { name: 'Agree' })).toBeChecked();

// Count
await expect(page.getByRole('listitem')).toHaveCount(5);

// URL
await expect(page).toHaveURL(/\/dashboard$/);
await expect(page).toHaveTitle('Dashboard — QAIT');

// Attribute
await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
```

## Custom retry window

If one specific assertion legitimately needs longer, pass `timeout`:

```ts
await expect(page.getByRole('status')).toHaveText('Completed', { timeout: 15000 });
```

Do not raise the global assertion timeout to paper over flakiness. Find the real slow step.

## Polling with expect.poll

For non-locator values (API response, storage, computed state), use `expect.poll`:

```ts
await expect.poll(async () => (await api.get('/status')).status).toBe('ready');
await expect.poll(() => window.localStorage.getItem('token')).not.toBe(null);
```

## Soft assertions for report-style tests

Use `expect.soft` when you want the test to continue collecting failures instead of stopping on the first one:

```ts
await expect.soft(page.getByRole('heading')).toHaveText('Dashboard');
await expect.soft(page.getByRole('navigation')).toBeVisible();
// both run even if the first fails; test ends as failed
```

## Rule of thumb

If you find yourself writing `await page.waitForTimeout(X)` before an assertion, replace it with the right web-first assertion. The framework already waits for you.
