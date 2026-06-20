import {
  registerActiveRequest,
  hasActiveRequest,
  cancelActiveRequest,
  unregisterActiveRequest,
  isRequestAborted,
  checkRequestAborted,
} from '../request-cancellation';

// Module-level Maps persist across tests, so each test uses unique ids.
let n = 0;
const ids = () => {
  n++;
  return { s: `sess-${n}`, u: `user-${n}` };
};

describe('registerActiveRequest / hasActiveRequest', () => {
  it('registers a request and reports it as active', async () => {
    const { s, u } = ids();
    const ctrl = await registerActiveRequest(s, u, 'hello');
    expect(ctrl).toBeInstanceOf(AbortController);
    expect(ctrl.signal.aborted).toBe(false);
    expect(await hasActiveRequest(s, u)).toBe(true);
  });

  it('reports no active request for unknown ids', async () => {
    const { s, u } = ids();
    expect(await hasActiveRequest(s, u)).toBe(false);
  });

  it('tracks by user id when no chat session is provided', async () => {
    const { u } = ids();
    await registerActiveRequest(undefined, u, 'x');
    expect(await hasActiveRequest(undefined, u)).toBe(true);
  });
});

describe('cancelActiveRequest', () => {
  it('aborts the controller and clears the active request', async () => {
    const { s, u } = ids();
    const ctrl = await registerActiveRequest(s, u, 'doing work');
    const result = await cancelActiveRequest(s, u);
    expect(result.cancelled).toBe(true);
    expect(result.message).toBe('doing work');
    expect(ctrl.signal.aborted).toBe(true);
    expect(await hasActiveRequest(s, u)).toBe(false);
  });

  it('cancels a user-tracked request when no session is given', async () => {
    const { u } = ids();
    const ctrl = await registerActiveRequest(undefined, u, 'y');
    const result = await cancelActiveRequest(undefined, u);
    expect(result.cancelled).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('returns cancelled:false when there is nothing to cancel', async () => {
    const { s, u } = ids();
    expect(await cancelActiveRequest(s, u)).toEqual({ cancelled: false, message: undefined });
  });

  it('truncates the stored message to 50 characters', async () => {
    const { s, u } = ids();
    await registerActiveRequest(s, u, 'a'.repeat(120));
    const result = await cancelActiveRequest(s, u);
    expect(result.message).toHaveLength(50);
  });
});

describe('unregisterActiveRequest', () => {
  it('removes tracking without aborting the controller', async () => {
    const { s, u } = ids();
    const ctrl = await registerActiveRequest(s, u, 'z');
    await unregisterActiveRequest(s, u);
    expect(await hasActiveRequest(s, u)).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });
});

describe('abort signal helpers', () => {
  it('isRequestAborted reflects the signal state', () => {
    const ac = new AbortController();
    expect(isRequestAborted(ac.signal)).toBe(false);
    ac.abort();
    expect(isRequestAborted(ac.signal)).toBe(true);
  });

  it('checkRequestAborted throws only when aborted', () => {
    const ac = new AbortController();
    expect(() => checkRequestAborted(ac.signal)).not.toThrow();
    ac.abort();
    expect(() => checkRequestAborted(ac.signal)).toThrow('cancelled by user');
  });
});
