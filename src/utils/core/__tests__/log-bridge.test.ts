// The log bridge resolves PROCESS_KIND at import time from process.argv[1] and
// keeps module-level Redis singletons, so each scenario re-imports the module
// fresh inside jest.isolateModules() with argv[1] set first.

const mockRedisInstances: any[] = [];

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const instance = {
      on: jest.fn((evt: string, cb: (...args: any[]) => void) => {
        handlers[evt] = cb;
      }),
      subscribe: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      __handlers: handlers,
    };
    mockRedisInstances.push(instance);
    return instance;
  }),
);

jest.mock('@/config/infrastructure/queues', () => ({ connection: { host: 'localhost' } }));
jest.mock('../log-buffer', () => ({ logBuffer: { push: jest.fn() } }));

import { logBuffer } from '../log-buffer';

const CHANNEL = 'system:logs';
const pushMock = logBuffer.push as jest.Mock;

type Bridge = typeof import('../log-bridge');

function loadBridge(argv1: string): Bridge {
  let mod: Bridge;
  jest.isolateModules(() => {
    process.argv[1] = argv1;
    mod = require('../log-bridge');
  });
  return mod!;
}

const originalArgv1 = process.argv[1];

beforeEach(() => {
  mockRedisInstances.length = 0;
});

afterAll(() => {
  process.argv[1] = originalArgv1;
});

describe('PROCESS_KIND detection', () => {
  it('detects the worker process from a ts-node path', () => {
    expect(loadBridge('/app/src/worker/index.ts').PROCESS_KIND).toBe('worker');
  });

  it('detects the scheduler process from a built path', () => {
    expect(loadBridge('/app/dist/scheduler/index.js').PROCESS_KIND).toBe('scheduler');
  });

  it('defaults to the api process for anything else', () => {
    expect(loadBridge('/app/src/index.ts').PROCESS_KIND).toBe('api');
  });

  it('normalizes Windows backslash paths', () => {
    expect(loadBridge('C:\\app\\src\\worker\\index.js').PROCESS_KIND).toBe('worker');
  });
});

describe('publishLogEntry', () => {
  const entry = { timestamp: '2026-06-21T00:00:00Z', level: 'info', message: 'hello' };

  it('is a no-op in the api process (no self round-trip)', () => {
    const bridge = loadBridge('/app/src/index.ts');
    bridge.publishLogEntry(entry);
    expect(mockRedisInstances).toHaveLength(0);
  });

  it('publishes to the system:logs channel from a worker', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    bridge.publishLogEntry(entry);
    const pub = mockRedisInstances[0];
    expect(pub.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = pub.publish.mock.calls[0];
    expect(channel).toBe(CHANNEL);
    expect(JSON.parse(raw)).toMatchObject({ message: 'hello', source: 'worker' });
  });

  it('defaults source to the process kind but keeps an explicit source', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    bridge.publishLogEntry({ ...entry, source: 'custom' });
    const [, raw] = mockRedisInstances[0].publish.mock.calls[0];
    expect(JSON.parse(raw).source).toBe('custom');
  });

  it('reuses a single publisher across calls', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    bridge.publishLogEntry(entry);
    bridge.publishLogEntry(entry);
    expect(mockRedisInstances).toHaveLength(1);
    expect(mockRedisInstances[0].publish).toHaveBeenCalledTimes(2);
  });

  it('truncates oversized payloads instead of dropping them', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    const huge = 'x'.repeat(70 * 1024);
    bridge.publishLogEntry({ ...entry, message: huge, meta: { big: huge } });
    const [, raw] = mockRedisInstances[0].publish.mock.calls[0];
    const parsed = JSON.parse(raw);
    expect(parsed.message.endsWith('…[bridge-truncated]')).toBe(true);
    expect(parsed.meta).toBeUndefined();
    expect(raw.length).toBeLessThan(70 * 1024);
  });

  it('never throws when serialization fails (circular payload)', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    const circular: any = { ...entry };
    circular.meta = { self: circular };
    expect(() => bridge.publishLogEntry(circular)).not.toThrow();
    // Publisher exists but nothing was published.
    expect(mockRedisInstances[0].publish).not.toHaveBeenCalled();
  });

  it('returns safely when the publisher cannot be constructed', () => {
    (require('ioredis') as jest.Mock).mockImplementationOnce(() => {
      throw new Error('redis ctor failed');
    });
    const bridge = loadBridge('/app/src/worker/index.ts');
    expect(() => bridge.publishLogEntry(entry)).not.toThrow();
    expect(mockRedisInstances).toHaveLength(0);
  });

  it('swallows publisher connection errors via the error handler', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    bridge.publishLogEntry(entry);
    const onError = mockRedisInstances[0].__handlers.error;
    expect(() => onError(new Error('ECONNREFUSED'))).not.toThrow();
  });
});

describe('initLogBridge', () => {
  it('eagerly creates a publisher (no subscriber) in non-api processes', () => {
    const bridge = loadBridge('/app/src/worker/index.ts');
    bridge.initLogBridge();
    expect(mockRedisInstances).toHaveLength(1);
    expect(mockRedisInstances[0].subscribe).not.toHaveBeenCalled();
  });

  it('subscribes to the channel once in the api process and is idempotent', () => {
    const bridge = loadBridge('/app/src/index.ts');
    bridge.initLogBridge();
    bridge.initLogBridge();
    expect(mockRedisInstances).toHaveLength(1);
    expect(mockRedisInstances[0].subscribe).toHaveBeenCalledWith(CHANNEL);
  });

  it('logs a warning but does not throw when the subscriber cannot start', () => {
    (require('ioredis') as jest.Mock).mockImplementationOnce(() => {
      throw new Error('subscriber ctor failed');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = loadBridge('/app/src/index.ts');
    expect(() => bridge.initLogBridge()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('swallows subscriber connection errors via the error handler', () => {
    const bridge = loadBridge('/app/src/index.ts');
    bridge.initLogBridge();
    const onError = mockRedisInstances[0].__handlers.error;
    expect(() => onError(new Error('ECONNREFUSED'))).not.toThrow();
  });

  describe('api subscriber message handling', () => {
    function loadApiAndGetMessageHandler() {
      const bridge = loadBridge('/app/src/index.ts');
      bridge.initLogBridge();
      return mockRedisInstances[0].__handlers.message as (ch: string, raw: string) => void;
    }

    const valid = { timestamp: '2026-06-21T00:00:00Z', level: 'warn', message: 'from worker' };

    it('pushes well-formed entries into the local ring buffer', () => {
      const onMessage = loadApiAndGetMessageHandler();
      onMessage(CHANNEL, JSON.stringify(valid));
      expect(pushMock).toHaveBeenCalledWith(expect.objectContaining(valid));
    });

    it('ignores messages from other channels', () => {
      const onMessage = loadApiAndGetMessageHandler();
      onMessage('other:channel', JSON.stringify(valid));
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('ignores malformed JSON without throwing', () => {
      const onMessage = loadApiAndGetMessageHandler();
      expect(() => onMessage(CHANNEL, '{not json')).not.toThrow();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('ignores entries missing required fields', () => {
      const onMessage = loadApiAndGetMessageHandler();
      onMessage(CHANNEL, JSON.stringify({ level: 'info', message: 'no timestamp' }));
      expect(pushMock).not.toHaveBeenCalled();
    });
  });
});
