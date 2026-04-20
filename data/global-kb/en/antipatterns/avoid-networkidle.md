# Do not wait for networkidle

`page.waitForLoadState('networkidle')` waits for a 500ms window with zero in-flight network requests. On any modern application, this is either too slow, too fragile, or both.

## Why it fails

- Apps that poll (notifications, presence, live feeds) never reach idle
- Long-lived connections (WebSocket, EventSource) never reach idle
- Analytics, ads, heatmap scripts fire continuously
- Service worker revalidation, retry logic — same problem
- Idle for 500ms is an arbitrary threshold that does not map to "ready for the user"

## What to do instead

### Wait for the specific request you care about

```ts
// Wrong
await page.goto('/dashboard');
await page.waitForLoadState('networkidle');
await expect(page.getByRole('listitem')).toHaveCount(5);

// Right
const res = page.waitForResponse(/\/api\/dashboard/);
await page.goto('/dashboard');
await res;
await expect(page.getByRole('listitem')).toHaveCount(5);
```

### Wait for the UI state you actually need

Most of the time you do not need to wait for "the network" at all. You need to wait for a specific element to render. Web-first assertions do this automatically:

```ts
await page.goto('/dashboard');
await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
// at this point the heading is rendered, that is the real readiness signal
```

### If you truly need "page loaded"

```ts
// 'load' fires when the browser emits the load event — all resources including
// images are loaded. Far more reliable than 'networkidle'.
await page.goto('/dashboard', { waitUntil: 'load' });
```

## The internal QAIT replay rule

The QAIT replay path uses `waitUntil: 'load'` everywhere. Do not switch to `'networkidle'` to "fix" a slow test. Find what the test really depends on.

## The only acceptable use

For a simple static site with no polling, no analytics, no WebSockets — `networkidle` may work. In practice, no modern product app fits that description.
