import {
  keyOfGlobal,
  keyOfTestCase,
  register,
  hasActive,
  cancel,
  unregister,
  isRequestAborted,
  __resetTestCaseRequestsForTests,
} from '../request-key';

let n = 0;
const uid = () => {
  n++;
  return { s: `key-sess-${n}`, u: `key-user-${n}` };
};

afterEach(() => {
  __resetTestCaseRequestsForTests();
});

describe('key builders', () => {
  it('build discriminated keys', () => {
    expect(keyOfGlobal('s')).toEqual({ kind: 'global', sessionId: 's' });
    expect(keyOfTestCase('s')).toEqual({ kind: 'testcase', sessionId: 's' });
  });
});

describe('test-case request path', () => {
  it('registers and reports active, then cancels', async () => {
    const { s, u } = uid();
    const ctrl = await register(keyOfTestCase(s), u, 'work');
    expect(ctrl).toBeInstanceOf(AbortController);
    expect(await hasActive(keyOfTestCase(s))).toBe(true);

    const res = await cancel(keyOfTestCase(s), u);
    expect(res).toEqual({ cancelled: true, message: 'work' });
    expect(ctrl.signal.aborted).toBe(true);
    expect(await hasActive(keyOfTestCase(s))).toBe(false);
  });

  it('returns cancelled:false when nothing is in flight', async () => {
    const { s, u } = uid();
    expect(await cancel(keyOfTestCase(s), u)).toEqual({ cancelled: false });
  });

  it('fails closed when a different user tries to cancel', async () => {
    const { s, u } = uid();
    const ctrl = await register(keyOfTestCase(s), u);
    const res = await cancel(keyOfTestCase(s), 'someone-else');
    expect(res.cancelled).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('unregister removes the entry without aborting', async () => {
    const { s, u } = uid();
    const ctrl = await register(keyOfTestCase(s), u);
    await unregister(keyOfTestCase(s), u);
    expect(await hasActive(keyOfTestCase(s))).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });
});

describe('global request path', () => {
  it('registers, reports active, and cancels via the legacy registry', async () => {
    const { s, u } = uid();
    await register(keyOfGlobal(s), u, 'g');
    expect(await hasActive(keyOfGlobal(s))).toBe(true);
    const res = await cancel(keyOfGlobal(s), u);
    expect(res.cancelled).toBe(true);
  });
});

describe('namespace isolation', () => {
  it('cancelling a test-case request does not touch a global request with the same session id', async () => {
    const { s, u } = uid();
    const gctrl = await register(keyOfGlobal(s), u, 'global');
    const tctrl = await register(keyOfTestCase(s), u, 'tc');

    expect(await hasActive(keyOfGlobal(s))).toBe(true);
    expect(await hasActive(keyOfTestCase(s))).toBe(true);

    await cancel(keyOfTestCase(s), u);

    expect(tctrl.signal.aborted).toBe(true);
    expect(gctrl.signal.aborted).toBe(false);
    expect(await hasActive(keyOfTestCase(s))).toBe(false);
    expect(await hasActive(keyOfGlobal(s))).toBe(true);

    await cancel(keyOfGlobal(s), u); // cleanup
  });
});

describe('re-exported helpers', () => {
  it('isRequestAborted reflects the signal', () => {
    const ac = new AbortController();
    expect(isRequestAborted(ac.signal)).toBe(false);
    ac.abort();
    expect(isRequestAborted(ac.signal)).toBe(true);
  });
});
