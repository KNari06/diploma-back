import { ClientLogService } from '../client-log.service';
import { logger } from '@/utils/core/logger';

describe('ClientLogService.record', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(undefined as never);
    errorSpy = jest.spyOn(logger, 'error').mockReturnValue(undefined as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('forces userId from the auth context, ignoring any client-supplied id', () => {
    ClientLogService.record(
      [{ event: 'session.expired', severity: 'warning', userId: 'attacker' } as never],
      { userId: 'real-user' },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[CLIENT] reported failure',
      expect.objectContaining({ userId: 'real-user' }),
    );
  });

  it('namespaces the event as client.* so it cannot impersonate a server event', () => {
    ClientLogService.record([{ event: 'session.expired', severity: 'warning' }], { userId: 'u' });
    expect(warnSpy).toHaveBeenCalledWith(
      '[CLIENT] reported failure',
      expect.objectContaining({ event: 'client.session.expired' }),
    );
  });

  it('falls back to client.unknown for a malformed event name', () => {
    ClientLogService.record([{ event: 'has spaces & symbols!', severity: 'warning' }], { userId: 'u' });
    expect(warnSpy).toHaveBeenCalledWith(
      '[CLIENT] reported failure',
      expect.objectContaining({ event: 'client.unknown' }),
    );
  });

  it('allowlists severity (unknown → error) and source (unknown → web)', () => {
    ClientLogService.record([{ event: 'x', severity: 'fatal', source: 'mainframe' } as never], { userId: 'u' });
    expect(errorSpy).toHaveBeenCalledWith(
      '[CLIENT] reported failure',
      expect.objectContaining({ severity: 'error', source: 'web' }),
    );
  });

  it('routes error/critical to logger.error and warning/info to logger.warn', () => {
    ClientLogService.record([{ event: 'a', severity: 'critical' }], { userId: 'u' });
    ClientLogService.record([{ event: 'b', severity: 'info' }], { userId: 'u' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('caps the batch at 20 entries', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ event: `e${i}`, severity: 'warning' }));
    const { accepted } = ClientLogService.record(entries, { userId: 'u' });
    expect(accepted).toBe(20);
    expect(warnSpy).toHaveBeenCalledTimes(20);
  });

  it('truncates an over-long message', () => {
    ClientLogService.record([{ event: 'x', severity: 'warning', message: 'z'.repeat(5000) }], { userId: 'u' });
    const payload = warnSpy.mock.calls[0][1] as { message: string };
    expect(payload.message.length).toBe(1000);
  });

  it('does not throw on non-array input', () => {
    expect(() => ClientLogService.record(undefined as never, { userId: 'u' })).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never throws even when the logger itself throws (invariant: telemetry must not fail the request)', () => {
    errorSpy.mockImplementation(() => { throw new Error('loki transport down'); });
    expect(() =>
      ClientLogService.record([{ event: 'test', severity: 'error' }], { userId: 'u' }),
    ).not.toThrow();
  });
});
