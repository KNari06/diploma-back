describe('preview.handler helper functions', () => {
  let acquireDomTickGuard: (sessionId: string, inFlight: Set<string>) => boolean;
  let releaseDomTickGuard: (sessionId: string, inFlight: Set<string>) => void;
  let waitForFileSelectionConfirmation: (
    element: { evaluate: <T>(fn: (el: { files?: { length: number } | null }) => T) => Promise<T> },
    wait: (ms: number) => Promise<void>,
    maxAttempts?: number,
    intervalMs?: number
  ) => Promise<boolean>;

  beforeAll(() => {
    jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as NodeJS.Timeout);

    const mod = require('../preview.handler');
    acquireDomTickGuard = mod.acquireDomTickGuard;
    releaseDomTickGuard = mod.releaseDomTickGuard;
    waitForFileSelectionConfirmation = mod.waitForFileSelectionConfirmation;
  });

  afterAll(() => {
    (global.setInterval as jest.Mock).mockRestore();
  });

  it('prevents overlapping dom ticks until released', () => {
    const inFlight = new Set<string>();
    const sessionId = 's1';

    expect(acquireDomTickGuard(sessionId, inFlight)).toBe(true);
    expect(acquireDomTickGuard(sessionId, inFlight)).toBe(false);
    releaseDomTickGuard(sessionId, inFlight);
    expect(acquireDomTickGuard(sessionId, inFlight)).toBe(true);
  });

  it('confirms file selection only after files are present', async () => {
    const element = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const wait = jest.fn().mockResolvedValue(undefined);

    const selected = await waitForFileSelectionConfirmation(element as any, wait, 5, 10);
    expect(selected).toBe(true);
    expect(element.evaluate).toHaveBeenCalledTimes(3);
  });

  it('returns false when chooser is canceled (no files selected)', async () => {
    const element = {
      evaluate: jest.fn().mockResolvedValue(false),
    };
    const wait = jest.fn().mockResolvedValue(undefined);

    const selected = await waitForFileSelectionConfirmation(element as any, wait, 3, 5);
    expect(selected).toBe(false);
    expect(element.evaluate).toHaveBeenCalledTimes(3);
  });
});
