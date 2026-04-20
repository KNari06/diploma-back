# Do not use page.waitForTimeout

`page.waitForTimeout(ms)` pauses the test for a fixed number of milliseconds. It is almost always wrong.

## Why it is wrong

- If the wait is shorter than the actual page activity, the test is flaky
- If the wait is longer, every run wastes that time
- It hides the real dependency: what the test is actually waiting for

## What to do instead

### Waiting for an element to appear

```ts
// Wrong
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Submit' }).click();

// Right — web-first assertion waits until visible (up to 5s by default)
await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
await page.getByRole('button', { name: 'Submit' }).click();
```

### Waiting for a network request

```ts
// Wrong
await page.waitForTimeout(3000);
await expect(page.getByRole('listitem')).toHaveCount(5);

// Right — wait for the specific response
const res = page.waitForResponse(/\/api\/orders/);
await page.getByRole('button', { name: 'Refresh' }).click();
await res;
await expect(page.getByRole('listitem')).toHaveCount(5);
```

### Waiting for a navigation

```ts
// Wrong
await page.getByRole('link', { name: 'Settings' }).click();
await page.waitForTimeout(1000);

// Right — assert on the post-nav state
await page.getByRole('link', { name: 'Settings' }).click();
await expect(page).toHaveURL(/\/settings$/);
```

### Waiting for animation

```ts
// Wrong
await page.waitForTimeout(500); // guess transition duration

// Right — assert on final state
await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
```

## The only acceptable use

`waitForTimeout` is acceptable when the test genuinely needs to verify that *nothing happens for N seconds* — for example, testing debounce or rate-limit logic. Even then, prefer `expect.poll` with a negative assertion:

```ts
await expect.poll(
  () => consoleMessages.length,
  { timeout: 2000, intervals: [500] }
).toBe(0);
```

## Rule

If you find yourself typing `waitForTimeout`, stop and ask: what am I actually waiting for? Wait for that thing directly.
