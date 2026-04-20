# Troubleshooting: element not found

Symptom: the locator resolves to zero elements, or resolves to the wrong element, within the retry window.

## Most likely causes

1. The element is rendered async and has not appeared yet
2. The element is inside an iframe
3. The element is in a shadow DOM that the locator does not pierce
4. The page navigated, and the locator now points at a destroyed DOM
5. The selector names the wrong thing (e.g. two buttons with the same name, one in a hidden tab)
6. The page is a different page than expected (a redirect happened)

## How to confirm

Open the trace. Look at the DOM snapshot at the time of the failing action. The target either does not exist, exists elsewhere, or exists under a different name.

## Fixes

### Element appears async — rely on the retry, fix the dependency

Web-first assertions auto-retry up to `expect.timeout` (default 5s). If that is not enough, the element depends on a specific data load. Wait for that load, not for more time:

```ts
const res = page.waitForResponse(/\/api\/details/);
await page.getByRole('link', { name: 'Details' }).click();
await res;
await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
```

### Element is inside an iframe

```ts
const frame = page.frameLocator('iframe[title="Payment form"]');
await frame.getByLabel('Card number').fill('4242 4242 4242 4242');
```

### Element is in shadow DOM

Playwright locators pierce open shadow roots by default. For closed shadow DOM (rare in app code, common in third-party widgets), there is no supported workaround — use a different trigger.

### Multiple matches, wrong one selected

Scope to a container or filter:

```ts
// Scope
const dialog = page.getByRole('dialog', { name: 'Confirm' });
await dialog.getByRole('button', { name: 'Save' }).click();

// Filter
await page.getByRole('listitem').filter({ hasText: 'Invoice #42' }).click();
```

### Locator held across navigation

Locators are live — they re-query the page each time. But if a click triggers navigation and you await an action on the old page reference, the locator may not find the element because the page has changed.

Re-locate after navigation:

```ts
await page.getByRole('link', { name: 'Settings' }).click();
await expect(page).toHaveURL(/\/settings/);
// At this point, re-query — do not reuse a previous locator
await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
```

### Wrong page

If the test assumes a specific URL, assert on it before acting:

```ts
await expect(page).toHaveURL(/\/dashboard$/);
```

A redirect to `/login` (session expired) will then fail loudly instead of looking like a selector bug.

## Do not

- Do not add `waitForTimeout(5000)` hoping the element will eventually appear
- Do not switch to a brittle CSS or XPath selector just because `getByRole` failed. Investigate why it failed first.
