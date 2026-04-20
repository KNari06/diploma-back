# File upload: fallback chain

Not every upload field is a plain `<input type="file">`. Drag-and-drop zones, styled buttons with hidden inputs, and custom shadow-DOM widgets all need different techniques. Follow this waterfall:

## Stage 1 — setInputFiles (preferred)

Works when the page has a visible or hidden `<input type="file">`.

```ts
await page.getByLabel('Upload resume').setInputFiles('./fixtures/resume.pdf');
```

Multiple files:

```ts
await page.getByLabel('Upload photos').setInputFiles([
  './fixtures/photo1.jpg',
  './fixtures/photo2.jpg',
]);
```

Clear selection:

```ts
await page.getByLabel('Upload resume').setInputFiles([]);
```

## Stage 2 — locate the hidden input nearby

Many UIs wrap the real input in a styled button. Find the input by association, not by the decorative button.

```ts
// Visible "Choose file" button + adjacent hidden input
const input = page.locator('input[type="file"][name="resume"]');
await input.setInputFiles('./fixtures/resume.pdf');
```

If the input is inside a shadow root, Playwright's default piercing usually works. If not, query through the host element.

## Stage 3 — fileChooser for click-triggered dialogs

When the page only exposes a button that programmatically opens a file picker:

```ts
const fileChooserPromise = page.waitForEvent('filechooser');
await page.getByRole('button', { name: 'Attach file' }).click();
const fileChooser = await fileChooserPromise;
await fileChooser.setFiles('./fixtures/resume.pdf');
```

The promise must be declared before the click.

## Stage 4 — synthetic drag-and-drop

For drop zones with no underlying input:

```ts
const dropzone = page.getByRole('region', { name: 'Drop files here' });
const buffer = await fs.readFile('./fixtures/resume.pdf');

await dropzone.dispatchEvent('drop', {
  dataTransfer: await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    const file = new File([data], 'resume.pdf', { type: 'application/pdf' });
    dt.items.add(file);
    return dt;
  }, buffer),
});
```

Use only as a last resort. It bypasses any file-picker-based validation the app does.

## After upload — verify

```ts
await expect(page.getByText('resume.pdf')).toBeVisible();
await expect(page.getByText('Upload complete')).toBeVisible();
```

Never assume the upload succeeded just because the call returned. Assert on the visible outcome.

## Common pitfalls

- Using a relative path that does not resolve — always pass an absolute path or a path relative to the test file
- Uploading to a stale input after the UI reset — locate the input fresh each time
- Missing `fileChooser` timing — the promise must exist before the click that triggers the picker
