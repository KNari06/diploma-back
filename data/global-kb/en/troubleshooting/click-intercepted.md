# Troubleshooting: click intercepted

Symptom: the framework reports the target element exists and is visible, but the click fails with an "intercepted" or "obscured" error. Something else is in front of the element.

## Most likely causes

1. **Cookie banner, newsletter popup, or chat widget** covers the element
2. **Sticky header or floating CTA** overlaps the element after scroll
3. **Modal backdrop** is still animating in or out
4. **Tooltip or hover preview** from a previous action stays on screen
5. **A transparent overlay** from a recent state transition was not cleaned up

## How to confirm

Open the trace and look at the DOM snapshot at the moment of the failing click. Whatever is at the same coordinate as the target element is the culprit.

## Fixes, in order of preference

### 1. Dismiss the blocker with addLocatorHandler

If it is a recurring popup, register a handler once:

```ts
await page.addLocatorHandler(
  page.getByRole('dialog', { name: 'Accept cookies' }),
  async () => page.getByRole('button', { name: 'Accept' }).click()
);
```

The target action now proceeds automatically.

### 2. Scroll into view explicitly

Sticky headers often cover elements near the top of a scrolled section:

```ts
await target.scrollIntoViewIfNeeded();
await target.click();
```

### 3. Wait for the blocker to go away

Backdrop still animating? Wait for its absence:

```ts
await expect(page.locator('.modal-backdrop')).toBeHidden();
await target.click();
```

### 4. Click with force — only if the above cannot apply

```ts
await target.click({ force: true });
```

`force: true` skips actionability checks. It can succeed where a real user would too (e.g. element is behind a purely decorative, pointer-events-none layer). It can also mask real bugs. Use sparingly and comment why.

## Do not

- Do not pre-click blindly with `waitForTimeout(1000)`. The blocker either appears or does not; timing hides the problem.
- Do not switch the selector to `nth-child` or an XPath climb. The selector is correct — the blocker is the issue.
