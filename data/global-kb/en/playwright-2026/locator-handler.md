# addLocatorHandler: dismiss overlays automatically

Cookie banners, intercom chat bubbles, newsletter popups, "you have unsaved changes" dialogs — these appear at unpredictable moments and break tests that do not expect them. `page.addLocatorHandler` registers a dismissal routine that fires whenever the overlay is visible, so the rest of the test never sees it.

## Basic usage

```ts
await page.addLocatorHandler(
  page.getByRole('dialog', { name: 'Accept cookies' }),
  async () => {
    await page.getByRole('button', { name: 'Accept all' }).click();
  }
);

// From here on, any action that would be blocked by the cookie dialog
// triggers the handler first, then continues.
await page.getByRole('link', { name: 'Pricing' }).click();
```

## When to register

Register handlers right after `page.goto` (or in `beforeEach`), before any action that might be interrupted. Handlers stay active for the page's lifetime.

## Multiple overlays

Register one handler per overlay. Playwright runs the matching one on demand.

```ts
await page.addLocatorHandler(
  page.getByRole('dialog', { name: 'Accept cookies' }),
  async () => page.getByRole('button', { name: 'Accept' }).click()
);

await page.addLocatorHandler(
  page.getByRole('dialog', { name: 'Subscribe to newsletter' }),
  async () => page.getByRole('button', { name: 'No thanks' }).click()
);

await page.addLocatorHandler(
  page.getByRole('button', { name: 'Chat with us' }),
  async () => page.getByRole('button', { name: 'Close chat' }).click()
);
```

## Removing a handler

If a handler was only relevant for one flow, remove it:

```ts
await page.removeLocatorHandler(page.getByRole('dialog', { name: 'Accept cookies' }));
```

## Why this beats manual dismissal

- Manual `if (await banner.isVisible()) await banner.close()` only works at the exact line where it is written; the banner can appear later and block the next action
- Handlers are declarative: describe what blocks the user, describe how to unblock, let the framework handle timing
- No polling loops, no race conditions

## When not to use

Do not use handlers to dismiss things the test actually needs to verify. If the point of the test is "does the cookie banner appear", assert on it directly instead of registering a handler.
