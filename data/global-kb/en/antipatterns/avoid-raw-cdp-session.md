# Do not create raw CDP sessions

In QAIT, the video screencast subsystem holds its own Chrome DevTools Protocol (CDP) session on every running browser context. Creating a second CDP session or calling domain-enable methods like `Accessibility.enable` conflicts with that session and freezes the video recording.

## Wrong

```ts
// Conflicts with video screencast — breaks recordings
const cdp = await context.newCDPSession(page);
await cdp.send('Accessibility.enable');
const tree = await cdp.send('Accessibility.getFullAXTree');
```

## Right — use Playwright built-in APIs

The browser automation framework already exposes everything most tests need, without a raw CDP session.

```ts
// Accessibility tree
const snapshot = await page.accessibility.snapshot();

// Full HTML
const html = await page.content();

// Console log capture
page.on('console', (msg) => console.log(msg.text()));

// Network
page.on('request', (req) => console.log(req.method(), req.url()));
page.on('response', (res) => console.log(res.status(), res.url()));

// Performance metrics (via built-in API, no CDP)
const metrics = await page.evaluate(() => JSON.stringify(performance.getEntriesByType('navigation')));
```

## Why this rule exists

This was a real production bug: a preview DevTools collector opened its own CDP session to grab the accessibility tree. Video recording silently froze. The fix was to use `page.accessibility.snapshot()` — same data, no conflict.

## Resource check before changing code

Before touching anything that reads from the browser (CDP, WebSocket rooms, page context, shared Redis keys), search who else uses it:

```bash
rg "resourceName" src/ --type ts
```

If a resource is shared, your change must either coexist with other consumers or explicitly coordinate with them.

## Related anti-patterns

- Attaching multiple listeners to the same WebSocket event without checking existing handlers
- Mutating shared in-memory maps without a lock
- Calling `context.close()` on a context another test is still using
