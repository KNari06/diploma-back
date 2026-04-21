# Troubleshooting: timeout errors

Symptom: a test fails with a timeout — action timeout, assertion timeout, or test timeout. The diagnosis depends on which.

## Kinds of timeout

- **Action timeout** — `locator.click({ timeout })` or the default action timeout. The element was not actionable within the window.
- **Assertion timeout** — `expect(locator)...` did not reach the expected state in the window (default 5s).
- **Navigation timeout** — `page.goto(url, { timeout })` did not complete.
- **Test timeout** — the whole test function exceeded the overall timeout (default 30s).

## First step: open the trace

Every type of timeout is trivially diagnosable from the trace. You see the DOM, the network, the console at the moment the test gave up. Before changing code, look at the trace.

## Action timeout

The element existed but was not actionable — not visible, not enabled, obscured, or detached.

- Not visible → is it hidden by CSS, or rendered in a collapsed section? Expand or scroll first.
- Not enabled → is the button disabled pending validation? Wait for the prerequisite state.
- Obscured → see troubleshooting/click-intercepted.md
- Detached → the DOM node was removed between the retry and the click. Usually a re-render. Re-locate and retry with the same web-first pattern.

## Assertion timeout

The element did not reach the expected state.

- `toBeVisible` timing out → is the element rendered after a network call? Wait for the response first (recipes/wait-for-api-then-assert.md).
- `toHaveText` timing out → the text is different. Log what it actually says: `console.log(await locator.textContent())`.
- `toHaveCount` timing out → pagination, filter, or data-load delay. Same fix: wait for the request.

Raise the timeout only after confirming the element *does* reach the state eventually and the page legitimately needs more time.

## Navigation timeout

`page.goto` failed to finish before the timeout.

- Slow server in CI → raise `navigationTimeout` in config to 45–60s
- Page uses long-running WebSocket that defers `load` → use `waitUntil: 'domcontentloaded'` for navigation, then a web-first assertion for readiness
- Network error → check trace's network panel for the failing request

Never paper over a real connectivity failure with a longer timeout.

## Test timeout

The whole test ran longer than the per-test limit.

- Is the test doing too much? Split into smaller tests.
- Are prerequisites (login, seed data) eating the time? Move them to fixtures or storageState.
- Is there a single slow step? Profile it — the trace shows duration of every step.

## Config tuning

```ts
// playwright.config.ts
export default defineConfig({
  timeout: 45_000,          // per-test
  expect: { timeout: 8_000 }, // per-assertion
  use: {
    actionTimeout: 15_000,     // per-action default
    navigationTimeout: 30_000, // per-navigation default
  },
});
```

## Rule of thumb

If raising the timeout "fixes" a test, it only hides the bug. A well-written test passes at the default timeout on a healthy system. Tune timeouts for CI realities, not to mask flakiness.
