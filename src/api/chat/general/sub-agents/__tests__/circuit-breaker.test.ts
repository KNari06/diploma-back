// The module exports a singleton whose state persists, so each test re-imports
// a fresh instance via jest.isolateModules. Config is mocked with deterministic
// thresholds. Logger is globally mocked in jest.setup.ts.
jest.mock('../config', () => ({
  SUB_AGENT_CONFIG: {
    circuitBreakerWindowSize: 4,
    circuitBreakerFailThreshold: 0.5,
    circuitBreakerRetryInterval: 3,
  },
}));

type Breaker = {
  shouldSkip(): boolean;
  recordResult(success: boolean): void;
  getState(): 'closed' | 'open' | 'half-open';
};

function freshBreaker(): Breaker {
  let cb: Breaker;
  jest.isolateModules(() => {
    cb = require('../circuit-breaker').chatCircuitBreaker;
  });
  return cb!;
}

/** Drive a closed breaker to the open state (4 failures over a window of 4). */
function open(cb: Breaker) {
  for (let i = 0; i < 4; i++) cb.recordResult(false);
}

describe('ChatCircuitBreaker — closed state', () => {
  it('starts closed and never skips', () => {
    const cb = freshBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.shouldSkip()).toBe(false);
    expect(cb.shouldSkip()).toBe(false);
  });

  it('stays closed while the failure rate is at or below the threshold', () => {
    const cb = freshBreaker();
    [false, false, true, true].forEach((r) => cb.recordResult(r)); // 2/4 = 0.50, not > 0.50
    expect(cb.getState()).toBe('closed');
  });

  it('does not open before the window is full, even if all results fail', () => {
    const cb = freshBreaker();
    cb.recordResult(false);
    cb.recordResult(false);
    cb.recordResult(false); // length 3 < window 4
    expect(cb.getState()).toBe('closed');
  });

  it('opens once the failure rate exceeds the threshold', () => {
    const cb = freshBreaker();
    [false, false, false, true].forEach((r) => cb.recordResult(r)); // 3/4 = 0.75 > 0.50
    expect(cb.getState()).toBe('open');
  });

  it('evaluates the failure rate over a sliding window', () => {
    const cb = freshBreaker();
    [true, true, true, true].forEach((r) => cb.recordResult(r)); // full window, 0% fail
    expect(cb.getState()).toBe('closed');
    cb.recordResult(false); // window [T,T,T,F] → 0.25
    cb.recordResult(false); // window [T,T,F,F] → 0.50 (not > 0.50)
    expect(cb.getState()).toBe('closed');
    cb.recordResult(false); // window [T,F,F,F] → 0.75 → open
    expect(cb.getState()).toBe('open');
  });
});

describe('ChatCircuitBreaker — open state', () => {
  it('skips requests until the retry interval allows a trial', () => {
    const cb = freshBreaker();
    open(cb);
    expect(cb.shouldSkip()).toBe(true); // request 1
    expect(cb.shouldSkip()).toBe(true); // request 2
    expect(cb.shouldSkip()).toBe(false); // request 3 → half-open trial
    expect(cb.getState()).toBe('half-open');
  });
});

describe('ChatCircuitBreaker — half-open state', () => {
  function toHalfOpen(): Breaker {
    const cb = freshBreaker();
    open(cb);
    cb.shouldSkip();
    cb.shouldSkip();
    cb.shouldSkip(); // transitions to half-open
    return cb;
  }

  it('does not skip the trial request', () => {
    const cb = toHalfOpen();
    expect(cb.getState()).toBe('half-open');
    expect(cb.shouldSkip()).toBe(false);
  });

  it('closes the circuit when the trial succeeds', () => {
    const cb = toHalfOpen();
    cb.recordResult(true);
    expect(cb.getState()).toBe('closed');
  });

  it('re-opens the circuit when the trial fails', () => {
    const cb = toHalfOpen();
    cb.recordResult(false);
    expect(cb.getState()).toBe('open');
  });
});
