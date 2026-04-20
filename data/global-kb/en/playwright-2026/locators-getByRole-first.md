# Locators: getByRole first

Role-based locators are the most resilient because they mirror how users and assistive technologies perceive the page. Always try `getByRole` before any other strategy.

## Priority order

1. `getByRole(role, { name })` — buttons, links, headings, form fields by accessible role + name
2. `getByLabel(text)` — form inputs tied to a `<label>`
3. `getByPlaceholder(text)` — form inputs with a placeholder but no label
4. `getByText(text)` — static visible text (assertions only, not for clicking navigation)
5. `getByTestId(id)` — last resort when no semantic option exists. Requires `data-testid` in markup.

## Examples

```ts
// Preferred — accessible, stable, reads like user intent
await page.getByRole('button', { name: 'Submit' }).click();
await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
await page.getByRole('heading', { name: 'Dashboard' }).isVisible();
await page.getByRole('link', { name: 'Sign out' }).click();

// Form by label — when role alone is ambiguous
await page.getByLabel('Password').fill('secret');

// Test ID — only when nothing above works
await page.getByTestId('advanced-filters').click();
```

## Avoid

- CSS selectors like `button.submit-btn` — break on any style refactor
- Text selectors with `text=` string syntax — superseded by `getByText`/`getByRole({ name })`
- XPath — brittle and unreadable
- Position-based selectors (`nth-child`, `:first-of-type`) — change with layout tweaks

## Filtering and chaining

When a role returns multiple matches, narrow with `.filter()` or chain into a scoped container:

```ts
// Scope by a container
const dialog = page.getByRole('dialog', { name: 'Confirm deletion' });
await dialog.getByRole('button', { name: 'Delete' }).click();

// Filter by text content
await page.getByRole('listitem').filter({ hasText: 'Invoice #42' }).click();

// Filter by nested locator
await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Active' }) });
```

## Why this matters

If a test breaks, it should be because behavior changed, not because someone renamed a CSS class. Role-based locators fail only when the user-visible surface actually changes, which is exactly what tests should catch.
