import { traced, TRACER_ENABLED } from '../pipeline-tracer';

// PIPELINE_TRACE is unset in the test environment, so the tracer is disabled and
// `traced` must be a fully transparent pass-through. That is the contract every
// production call site relies on (tracing off by default).

describe('traced (tracing disabled)', () => {
  it('reports tracing as disabled by default', () => {
    expect(TRACER_ENABLED).toBe(false);
  });

  it('returns the synchronous result of the wrapped function', () => {
    expect(traced('m', () => 42)).toBe(42);
  });

  it('returns the resolved value of an async wrapped function', async () => {
    await expect(traced('m', async () => 'done')).resolves.toBe('done');
  });

  it('propagates a synchronous throw', () => {
    expect(() =>
      traced('m', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('propagates an async rejection', async () => {
    await expect(
      traced('m', async () => {
        throw new Error('bad');
      }),
    ).rejects.toThrow('bad');
  });

  it('invokes the wrapped function exactly once', () => {
    const fn = jest.fn(() => 'x');
    traced('m', fn, 'trace-1');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
