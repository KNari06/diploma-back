# Handle modal dialogs and overlays

Modals change what the rest of the page can do. A click outside the modal is either ignored or closes it. Tests must treat the modal as a scope.

## Scope the locator to the dialog

```ts
const confirm = page.getByRole('dialog', { name: 'Confirm deletion' });

await expect(confirm).toBeVisible();
await confirm.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
await confirm.getByRole('button', { name: 'Delete forever' }).click();

// After the action — modal should close
await expect(confirm).toBeHidden();
```

Using the dialog locator as the scope guarantees the button clicked is the one inside the modal, not a background one behind the backdrop.

## Focus trap and Escape

Well-built modals trap focus and close on Escape. Test both:

```ts
const dialog = page.getByRole('dialog', { name: 'Settings' });
await page.getByRole('button', { name: 'Open settings' }).click();
await expect(dialog).toBeVisible();

// Escape should close
await page.keyboard.press('Escape');
await expect(dialog).toBeHidden();
```

## Unwanted modals: use addLocatorHandler

For modals that are not the subject of the test but appear and block progress (cookie banners, onboarding tours), register a handler so they dismiss automatically.

See: playwright-2026/locator-handler.md

## When the modal is inside a shadow DOM

Playwright locators pierce shadow DOM by default, so `getByRole('dialog')` finds it. If not, the modal is likely not using the `role="dialog"` attribute — add it to the component or fall back to `getByTestId`.

## Backdrop clicks

If the test needs to verify clicking outside closes the modal:

```ts
// Click the backdrop, not the dialog body
await page.locator('[data-testid="modal-backdrop"]').click({ position: { x: 5, y: 5 } });
await expect(page.getByRole('dialog')).toBeHidden();
```

## Nested modals

If modal B opens from modal A, scope to the innermost one. Do not rely on "latest dialog" heuristics:

```ts
const confirm = page.getByRole('dialog', { name: 'Confirm' });
await confirm.getByRole('button', { name: 'Yes, continue' }).click();
// Now the outer modal may or may not still be visible — assert explicitly
```
