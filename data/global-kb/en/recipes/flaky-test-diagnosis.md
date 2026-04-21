# Diagnosing a flaky test

A flaky test is one that sometimes passes and sometimes fails with no code change. The goal is not to retry it away — it is to find the race condition or shared state that causes the flake, and fix it.

## Step 1: make the failure reproducible

Run the test in isolation, many times, with traces on:

```bash
npx playwright test tests/flaky-spec.ts --repeat-each=20 --workers=1 --trace=on
```

If it fails at least once, you have a reproducer. If it passes 20 times isolated but fails in the suite, the problem is cross-test state, not the test itself.

## Step 2: open the trace of the failing run

```bash
npx playwright show-trace test-results/.../trace.zip
```

The trace shows:
- Every action, with DOM snapshot before and after
- Network log at each moment
- Console log at each moment
- Exact time between steps

Look for:
- A long gap between two actions (suggests the app was busy, but the test did not wait)
- A console error around the failure time (app-side exception)
- A network request in flight at the moment of the failing assertion (data not ready)

## Step 3: common causes and fixes

### Race between navigation and assertion

```ts
// Flaky — assertion may run before navigation completes
await page.getByRole('link', { name: 'Settings' }).click();
await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
```

Usually not flaky because of the web-first assertion. If it is, the heading is rendered async after data load. Wait for the data:

```ts
const responsePromise = page.waitForResponse(/\/api\/v1\/settings/);
await page.getByRole('link', { name: 'Settings' }).click();
await responsePromise;
await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
```

### Shared state between tests

Tests mutating a shared user or shared entity step on each other when parallelized. Fixes:
- Create a fresh entity per test (via API)
- Use `test.describe.serial` only as a last resort — it kills parallelism
- Assign each worker its own user: `test.use({ storageState: `./.auth/user-${process.env.TEST_WORKER_INDEX}.json` })`

### Unstable selector

If `getByRole('button', { name: 'Save' })` sometimes matches the wrong button, there are two buttons with the same name. Scope to a container: `dialog.getByRole('button', { name: 'Save' })`.

### Animation timing

Tooltips, toasts, transitions — web-first assertions handle most of this, but if a test fails because it clicked during a CSS transition, wait for the end state, not the start:

```ts
// Wait for transition to settle by asserting on the final state
await expect(page.getByRole('dialog')).toBeVisible();
await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
```

### Third-party scripts

Analytics, chat widgets, ads — they can cover the element being clicked. Register `addLocatorHandler` for the widget or block the script:

```ts
await page.route(/intercom\.io/, (route) => route.abort());
```

## Step 4: verify the fix

Re-run 20 times. If it passes 20/20, ship it. If not, the root cause is deeper — keep digging.

## Last resort: quarantine and track

If you cannot root-cause it now and the test is blocking CI, tag it and run it non-blocking:

```ts
test.fixme('flaky test: tracking in TICKET-123', async ({ page }) => { /* ... */ });
```

`test.fixme` is stronger than `test.skip`: it signals intent to repair.
