import {
  beginCompound,
  clearPendingCompound,
  completeStep,
  isCompoundCancel,
  peekCurrentStep,
  toCompoundSteps,
  type CompoundStep,
} from '../compound-queue';

const store = new Map<string, string>();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => { store.delete(k); }),
  },
}));

beforeEach(() => store.clear());

const STEPS: CompoundStep[] = [
  { text: 'test login', order: 1, dependsOnPrevious: false },
  { text: 'test signup', order: 2, dependsOnPrevious: false },
  { text: 'save both as a plan', order: 3, dependsOnPrevious: true },
];

describe('toCompoundSteps', () => {
  it('returns [] when not compound or <2 steps', () => {
    expect(toCompoundSteps(undefined)).toEqual([]);
    expect(toCompoundSteps({ isCompound: false, subRequests: [{ text: 'a' }, { text: 'b' }] })).toEqual([]);
    expect(toCompoundSteps({ isCompound: true, subRequests: [{ text: 'only' }] })).toEqual([]);
  });

  it('sorts by order and drops empties', () => {
    const s = toCompoundSteps({
      isCompound: true,
      subRequests: [{ text: 'b', order: 2 }, { text: '  ', order: 5 }, { text: 'a', order: 1 }],
    });
    expect(s.map((x) => x.text)).toEqual(['a', 'b']);
  });
});

describe('isCompoundCancel', () => {
  it('matches explicit abandon phrases (EN + RU)', () => {
    for (const m of ['stop', 'cancel', 'отмена', 'хватит', 'forget it']) {
      expect(isCompoundCancel(m)).toBe(true);
    }
  });
  it('does not match normal continuation', () => {
    for (const m of ['yes', 'test signup', 'да']) {
      expect(isCompoundCancel(m)).toBe(false);
    }
  });
});

describe('begin / peek / complete (advance-after-success)', () => {
  it('beginCompound keeps step 1 as the current step (peek returns it)', async () => {
    const first = await beginCompound('s1', STEPS);
    expect(first?.text).toBe('test login');
    expect(first?.index).toBe(1);
    expect(first?.total).toBe(3);

    const peek = await peekCurrentStep('s1');
    expect(peek?.text).toBe('test login'); // NOT advanced yet
    expect(peek?.index).toBe(1);
  });

  it('beginCompound returns null for <2 steps or missing session', async () => {
    expect(await beginCompound('s1', STEPS.slice(0, 1))).toBeNull();
    expect(await beginCompound('', STEPS)).toBeNull();
  });

  it('completeStep advances only when called; peek is idempotent until then', async () => {
    await beginCompound('s1', STEPS);

    // peeking repeatedly never advances
    expect((await peekCurrentStep('s1'))?.text).toBe('test login');
    expect((await peekCurrentStep('s1'))?.text).toBe('test login');

    // complete step 1 → current becomes step 2
    const next1 = await completeStep('s1');
    expect(next1?.text).toBe('test signup');
    expect(next1?.index).toBe(2);
    expect((await peekCurrentStep('s1'))?.text).toBe('test signup');

    // complete step 2 → current becomes step 3
    const next2 = await completeStep('s1');
    expect(next2?.text).toBe('save both as a plan');

    // complete step 3 (last) → queue cleared, no next
    const next3 = await completeStep('s1');
    expect(next3).toBeNull();
    expect(await peekCurrentStep('s1')).toBeNull();
  });

  it('NOT calling completeStep leaves the same step current (clarification retry)', async () => {
    await beginCompound('s1', STEPS);
    // simulate a clarification turn: peek the step, do NOT complete
    expect((await peekCurrentStep('s1'))?.text).toBe('test login');
    // next turn still sees step 1
    expect((await peekCurrentStep('s1'))?.text).toBe('test login');
  });

  it('clearPendingCompound abandons the queue', async () => {
    await beginCompound('s1', STEPS);
    await clearPendingCompound('s1');
    expect(await peekCurrentStep('s1')).toBeNull();
  });

  it('peek/complete are no-ops without a session id', async () => {
    expect(await peekCurrentStep('')).toBeNull();
    expect(await completeStep('')).toBeNull();
  });
});
