import { buildStrategyLocator, safeCountWithTimeout } from '../locator-resolution.util';
import type { LocatorEntry } from '../preview.types';

/**
 * A fake Page/Frame/Locator scope: every locator-building method is a spy that
 * returns a tagged sentinel so we can assert which method ran with which args.
 * No real Playwright needed — buildStrategyLocator is a pure dispatch table.
 */
function makeScope() {
  const methods = ['locator', 'getByRole', 'getByLabel', 'getByTestId', 'getByPlaceholder', 'getByTitle', 'getByText'];
  const scope: Record<string, jest.Mock> = {};
  for (const m of methods) {
    scope[m] = jest.fn((...args: unknown[]) => ({ __method: m, args }));
  }
  return scope;
}

// Strategy is a strict union on LocatorEntry; tests intentionally pass arbitrary
// strings (incl. an unknown strategy), so cast through unknown.
const entry = (e: { strategy: string; value: string; roleName?: string }): LocatorEntry =>
  e as unknown as LocatorEntry;

describe('buildStrategyLocator', () => {
  let scope: ReturnType<typeof makeScope>;
  beforeEach(() => {
    scope = makeScope();
  });

  const call = (e: LocatorEntry) => buildStrategyLocator(scope as any, e, scope as any) as any;

  it.each([
    ['css', '.btn'],
    ['ref', '#node'],
  ])('maps the "%s" strategy to scope.locator(value)', (strategy, value) => {
    const result = call(entry({ strategy, value }));
    expect(result).toEqual({ __method: 'locator', args: [value] });
  });

  it('maps "role" with a roleName to getByRole(role, { name })', () => {
    const result = call(entry({ strategy: 'role', value: 'Submit', roleName: 'button' }));
    expect(result).toEqual({ __method: 'getByRole', args: ['button', { name: 'Submit' }] });
  });

  it('falls back to locator(value) for a "role" entry without a roleName', () => {
    const result = call(entry({ strategy: 'role', value: '.fallback' }));
    expect(result).toEqual({ __method: 'locator', args: ['.fallback'] });
  });

  it('maps "label" to getByLabel', () => {
    expect(call(entry({ strategy: 'label', value: 'Email' }))).toEqual({ __method: 'getByLabel', args: ['Email'] });
  });

  it('maps "testId" to getByTestId', () => {
    expect(call(entry({ strategy: 'testId', value: 'login' }))).toEqual({ __method: 'getByTestId', args: ['login'] });
  });

  it('maps "placeholder" to getByPlaceholder', () => {
    expect(call(entry({ strategy: 'placeholder', value: 'Search' }))).toEqual({
      __method: 'getByPlaceholder',
      args: ['Search'],
    });
  });

  it('maps "title" to getByTitle', () => {
    expect(call(entry({ strategy: 'title', value: 'Close' }))).toEqual({ __method: 'getByTitle', args: ['Close'] });
  });

  it('maps "text" to getByText with exact:false', () => {
    expect(call(entry({ strategy: 'text', value: 'Click me' }))).toEqual({
      __method: 'getByText',
      args: ['Click me', { exact: false }],
    });
  });

  it('returns null for an unknown strategy (forward-compatible)', () => {
    expect(call(entry({ strategy: 'quantum', value: 'x' }))).toBeNull();
  });

  it('defaults the scope to the page when none is provided', () => {
    const page = makeScope();
    const result = buildStrategyLocator(page as any, entry({ strategy: 'css', value: '.x' })) as any;
    expect(page.locator).toHaveBeenCalledWith('.x');
    expect(result.__method).toBe('locator');
  });

  // Iframe replay: the compiled executor passes a FrameLocator as `scope` so
  // every strategy resolves INSIDE the frame. The page root must NOT be hit —
  // that's what makes `page.locator()`-can't-cross-frames a non-issue.
  it('resolves against the frame scope and leaves the page untouched', () => {
    const page = makeScope();
    const frame = makeScope();
    const result = buildStrategyLocator(
      page as any,
      entry({ strategy: 'placeholder', value: 'Card number' }),
      frame as any,
    ) as any;
    expect(frame.getByPlaceholder).toHaveBeenCalledWith('Card number');
    expect(page.getByPlaceholder).not.toHaveBeenCalled();
    expect(page.locator).not.toHaveBeenCalled();
    expect(result.__method).toBe('getByPlaceholder');
  });
});

describe('safeCountWithTimeout', () => {
  it('returns the actual count when count() resolves in time', async () => {
    const locator = { count: jest.fn().mockResolvedValue(3) };
    await expect(safeCountWithTimeout(locator as any)).resolves.toBe(3);
  });

  it('returns 0 (never throws) when count() rejects', async () => {
    const locator = { count: jest.fn().mockRejectedValue(new Error('frame detached')) };
    await expect(safeCountWithTimeout(locator as any)).resolves.toBe(0);
  });

  it('returns -1 when count() does not resolve before the timeout', async () => {
    const locator = { count: jest.fn().mockReturnValue(new Promise<number>(() => {})) }; // never resolves
    await expect(safeCountWithTimeout(locator as any, 5)).resolves.toBe(-1);
  });
});
