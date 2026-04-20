# Wait for a specific API response before asserting

Tests that assert on data rendered from an API call must wait for that specific request, not for "the page to be idle". Waiting for a specific request is fast and deterministic; `waitForLoadState('networkidle')` is slow and flaky.

## The recipe

```ts
// Trigger action AND wait for response in parallel
const responsePromise = page.waitForResponse(
  (res) => res.url().includes('/api/v1/orders') && res.request().method() === 'GET'
);

await page.getByRole('button', { name: 'Refresh orders' }).click();

const response = await responsePromise;
expect(response.status()).toBe(200);

// Now the UI has the data — assert on it
await expect(page.getByRole('listitem')).toHaveCount(5);
```

## Why the promise goes first

`waitForResponse` starts listening when you call it. Put the promise declaration before the action, not after. If you call it after the click, the request may already have fired, and the wait hangs.

## Match by pattern, not exact URL

Production URLs often carry tokens, cache-busting query strings, or IDs. Use a predicate:

```ts
await page.waitForResponse(
  (res) =>
    /\/api\/v1\/users\/\d+\/orders/.test(res.url()) &&
    res.status() === 200
);
```

## Handle loading states explicitly

```ts
// Wait for loading indicator to appear (optional — confirms request fired)
await expect(page.getByRole('progressbar')).toBeVisible();

// Wait for it to disappear — confirms response handled
await expect(page.getByRole('progressbar')).toBeHidden();

// Now assert on result
await expect(page.getByRole('listitem').first()).toContainText('Order #');
```

## Intercepting and modifying responses

When the test needs a specific payload regardless of server state, mock it:

```ts
await page.route('**/api/v1/orders', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: 1, total: 42 }]),
  })
);

await page.goto('/orders');
await expect(page.getByRole('listitem')).toHaveCount(1);
```

Use mocks sparingly. Real backend calls catch integration bugs; mocks catch only UI bugs.

## Never use networkidle

`page.waitForLoadState('networkidle')` waits for a 500ms quiet window with zero in-flight requests. On modern apps that poll, stream, or use long-lived sockets, this either never resolves or waits too long. Prefer waiting for the specific response you need.
