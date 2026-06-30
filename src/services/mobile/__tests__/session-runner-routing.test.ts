import { getMobileRunnerClientForSession, getSessionRunnerBinding, runnerUrlToSocketUrl, storeSessionRunnerBinding, SESSION_RUNNER_PREFIX } from '../session-runner-routing';
import { getMobileRunnerClient, MobileRunnerClient } from '../mobile-runner-client';
import { CompanionRunnerClient } from '../companion/companion-runner-client';

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock('../mobile-runner-client', () => ({
  getMobileRunnerClient: jest.fn(),
  MobileRunnerClient: jest.fn(),
}));

jest.mock('../companion/companion-runner-client', () => ({
  CompanionRunnerClient: jest.fn(),
}));

const { redisConnection } = require('@/config/infrastructure/queues') as {
  redisConnection: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
};
const mockGetClient = getMobileRunnerClient as jest.Mock;
const MockRunnerClient = MobileRunnerClient as jest.Mock;
const MockCompanionRunnerClient = CompanionRunnerClient as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runnerUrlToSocketUrl', () => {
  it('converts http to ws', () => {
    expect(runnerUrlToSocketUrl('http://runner.internal:3000')).toBe('ws://runner.internal:3000');
  });

  it('converts https to wss', () => {
    expect(runnerUrlToSocketUrl('https://runner.internal')).toBe('wss://runner.internal');
  });

  it('strips trailing slash', () => {
    expect(runnerUrlToSocketUrl('http://runner.internal/')).toBe('ws://runner.internal');
  });

  it('leaves ws:// URLs unchanged', () => {
    expect(runnerUrlToSocketUrl('ws://runner.internal:3000')).toBe('ws://runner.internal:3000');
  });
});

describe('getMobileRunnerClientForSession', () => {
  it('returns a dedicated MobileRunnerClient when binding has runnerUrl', async () => {
    const fakeClient = {};
    MockRunnerClient.mockReturnValue(fakeClient);
    redisConnection.get.mockResolvedValue(
      JSON.stringify({ runnerUrl: 'http://dedicated.runner:3000', runnerApiKey: 'key-abc' }),
    );

    const result = await getMobileRunnerClientForSession('sess-123');

    expect(redisConnection.get).toHaveBeenCalledWith(`${SESSION_RUNNER_PREFIX}sess-123`);
    expect(MockRunnerClient).toHaveBeenCalledWith({ baseUrl: 'http://dedicated.runner:3000', apiKey: 'key-abc' });
    expect(result).toBe(fakeClient);
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it('falls back to the singleton when binding runnerUrl is null', async () => {
    const singleton = {};
    mockGetClient.mockReturnValue(singleton);
    redisConnection.get.mockResolvedValue(JSON.stringify({ runnerUrl: null, runnerApiKey: null }));

    const result = await getMobileRunnerClientForSession('sess-null');

    expect(MockRunnerClient).not.toHaveBeenCalled();
    expect(mockGetClient).toHaveBeenCalled();
    expect(result).toBe(singleton);
  });

  it('returns a companion runner client when binding is companion-backed', async () => {
    const fakeClient = {};
    MockCompanionRunnerClient.mockReturnValue(fakeClient);
    redisConnection.get.mockResolvedValue(JSON.stringify({ kind: 'companion', userId: 'user-123' }));

    const result = await getMobileRunnerClientForSession('sess-companion');

    expect(redisConnection.get).toHaveBeenCalledWith(`${SESSION_RUNNER_PREFIX}sess-companion`);
    expect(MockCompanionRunnerClient).toHaveBeenCalledWith('user-123');
    expect(result).toBe(fakeClient);
    expect(MockRunnerClient).not.toHaveBeenCalled();
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it('falls back to the singleton when no binding exists in Redis', async () => {
    const singleton = {};
    mockGetClient.mockReturnValue(singleton);
    redisConnection.get.mockResolvedValue(null);

    const result = await getMobileRunnerClientForSession('sess-absent');

    expect(MockRunnerClient).not.toHaveBeenCalled();
    expect(result).toBe(singleton);
  });

  it('falls back to the singleton on Redis error (non-fatal)', async () => {
    const singleton = {};
    mockGetClient.mockReturnValue(singleton);
    redisConnection.get.mockRejectedValue(new Error('Redis blip'));

    const result = await getMobileRunnerClientForSession('sess-err');

    expect(result).toBe(singleton);
  });

  it('falls back to the singleton when binding JSON is malformed', async () => {
    const singleton = {};
    mockGetClient.mockReturnValue(singleton);
    redisConnection.get.mockResolvedValue('not-valid-json{');

    const result = await getMobileRunnerClientForSession('sess-bad-json');

    expect(MockRunnerClient).not.toHaveBeenCalled();
    expect(result).toBe(singleton);
  });

  it('uses empty string apiKey when binding runnerApiKey is null', async () => {
    MockRunnerClient.mockReturnValue({});
    redisConnection.get.mockResolvedValue(
      JSON.stringify({ runnerUrl: 'http://dedicated.runner:3000', runnerApiKey: null }),
    );

    await getMobileRunnerClientForSession('sess-no-key');

    expect(MockRunnerClient).toHaveBeenCalledWith({ baseUrl: 'http://dedicated.runner:3000', apiKey: '' });
  });
});

describe('getSessionRunnerBinding', () => {
  it('returns the parsed companion binding', async () => {
    redisConnection.get.mockResolvedValue(JSON.stringify({ kind: 'companion', userId: 'user-9' }));
    const binding = await getSessionRunnerBinding('sess-c');
    expect(binding).toEqual({ kind: 'companion', userId: 'user-9' });
  });

  it('returns the parsed direct binding', async () => {
    redisConnection.get.mockResolvedValue(JSON.stringify({ runnerUrl: 'http://r:3000', runnerApiKey: 'k' }));
    const binding = await getSessionRunnerBinding('sess-d');
    expect(binding).toEqual({ runnerUrl: 'http://r:3000', runnerApiKey: 'k' });
  });

  it('returns null when no binding exists', async () => {
    redisConnection.get.mockResolvedValue(null);
    expect(await getSessionRunnerBinding('sess-none')).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    redisConnection.get.mockResolvedValue('nope{');
    expect(await getSessionRunnerBinding('sess-bad')).toBeNull();
  });

  it('returns null on Redis error (non-fatal)', async () => {
    redisConnection.get.mockRejectedValue(new Error('blip'));
    expect(await getSessionRunnerBinding('sess-err')).toBeNull();
  });
});

describe('storeSessionRunnerBinding', () => {
  it('writes the binding to Redis with the given TTL', async () => {
    await storeSessionRunnerBinding('sess-abc', { runnerUrl: 'http://r:3000', runnerApiKey: 'k' }, 900);

    expect(redisConnection.set).toHaveBeenCalledWith(
      `${SESSION_RUNNER_PREFIX}sess-abc`,
      JSON.stringify({ runnerUrl: 'http://r:3000', runnerApiKey: 'k' }),
      'EX',
      900,
    );
  });

  it('writes a companion binding to Redis with the given TTL', async () => {
    await storeSessionRunnerBinding('sess-companion', { kind: 'companion', userId: 'user-123' }, 900);

    expect(redisConnection.set).toHaveBeenCalledWith(
      `${SESSION_RUNNER_PREFIX}sess-companion`,
      JSON.stringify({ kind: 'companion', userId: 'user-123' }),
      'EX',
      900,
    );
  });
});
