import { EventEmitter } from 'events';

// Mock the Redis connection the cache util depends on. Importing the real
// queues module would open a live Redis connection, which we never want in a
// unit test. The logger is already globally mocked in jest.setup.ts.
const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  scanStream: jest.fn(),
  pipeline: jest.fn(),
};

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: mockRedis,
}));

import { cache } from '../redis-cache';

/** A fake ioredis scanStream that emits the given key batches then ends. */
function fakeScanStream(batches: string[][], failWith?: Error) {
  const stream = new EventEmitter();
  setImmediate(() => {
    if (failWith) {
      stream.emit('error', failWith);
      return;
    }
    for (const batch of batches) stream.emit('data', batch);
    stream.emit('end');
  });
  return stream;
}

describe('cache.get', () => {
  it('parses and returns a stored JSON value on hit', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ a: 1 }));
    await expect(cache.get<{ a: number }>('k')).resolves.toEqual({ a: 1 });
    expect(mockRedis.get).toHaveBeenCalledWith('k');
  });

  it('returns null on a cache miss', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    await expect(cache.get('missing')).resolves.toBeNull();
  });

  it('returns null (never throws) when the value is not valid JSON', async () => {
    mockRedis.get.mockResolvedValueOnce('{not json');
    await expect(cache.get('bad')).resolves.toBeNull();
  });

  it('returns null (never throws) when Redis errors', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('conn refused'));
    await expect(cache.get('k')).resolves.toBeNull();
  });
});

describe('cache.set', () => {
  it('serializes the value and sets it with an EX TTL', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    await cache.set('k', { a: 1 }, 60);
    expect(mockRedis.set).toHaveBeenCalledWith('k', JSON.stringify({ a: 1 }), 'EX', 60);
  });

  it('swallows Redis errors without throwing', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('down'));
    await expect(cache.set('k', 1, 10)).resolves.toBeUndefined();
  });
});

describe('cache.del', () => {
  it('deletes the given keys', async () => {
    mockRedis.del.mockResolvedValueOnce(2);
    await cache.del('a', 'b');
    expect(mockRedis.del).toHaveBeenCalledWith('a', 'b');
  });

  it('is a no-op when called with no keys', async () => {
    await cache.del();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('swallows Redis errors without throwing', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('down'));
    await expect(cache.del('a')).resolves.toBeUndefined();
  });
});

describe('cache.delByPattern', () => {
  it('deletes every scanned key and executes the pipeline', async () => {
    const pipelineDel = jest.fn();
    const pipelineExec = jest.fn().mockResolvedValue([]);
    mockRedis.pipeline.mockReturnValueOnce({ del: pipelineDel, exec: pipelineExec });
    mockRedis.scanStream.mockReturnValueOnce(fakeScanStream([['k1', 'k2'], ['k3']]));

    await cache.delByPattern('prefix:*');

    expect(mockRedis.scanStream).toHaveBeenCalledWith({ match: 'prefix:*', count: 100 });
    expect(pipelineDel).toHaveBeenCalledTimes(3);
    expect(pipelineDel).toHaveBeenCalledWith('k1');
    expect(pipelineDel).toHaveBeenCalledWith('k3');
    expect(pipelineExec).toHaveBeenCalledTimes(1);
  });

  it('does not execute the pipeline when no keys match', async () => {
    const pipelineExec = jest.fn().mockResolvedValue([]);
    mockRedis.pipeline.mockReturnValueOnce({ del: jest.fn(), exec: pipelineExec });
    mockRedis.scanStream.mockReturnValueOnce(fakeScanStream([]));

    await cache.delByPattern('prefix:*');

    expect(pipelineExec).not.toHaveBeenCalled();
  });

  it('swallows scan-stream errors without throwing', async () => {
    mockRedis.pipeline.mockReturnValueOnce({ del: jest.fn(), exec: jest.fn() });
    mockRedis.scanStream.mockReturnValueOnce(fakeScanStream([], new Error('scan failed')));

    await expect(cache.delByPattern('prefix:*')).resolves.toBeUndefined();
  });
});
