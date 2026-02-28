const mockCreate = jest.fn();

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

describe('parseUserIntent(api_test) robustness', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    mockCreate.mockReset();
    jest.resetModules();
  });

  it('keeps relative apiUrl and sets isRelativePath=true', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ intent: 'api_test', intent_confidence: 0.9, apiUrl: '/test', rawText: 'test this api /test' }) } }],
    });

    const { parseUserIntent } = require('@/services/ai/intent/intent-parser.service');
    const res = await parseUserIntent('test this api /test', {}, 'proj');

    expect(res.intent).toBe('api_test');
    expect(res.apiUrl).toBe('/test');
    expect(res.isRelativePath).toBe(true);
  });

  it('infers agentLevel from message even if model omits it', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ intent: 'api_test', intent_confidence: 0.9, apiUrl: '/test', rawText: 'test this api /test in light mode' }) } }],
    });

    const { parseUserIntent } = require('@/services/ai/intent/intent-parser.service');
    const res = await parseUserIntent('test this api /test in light mode', {}, 'proj');

    expect(res.intent).toBe('api_test');
    expect(res.apiUrl).toBe('/test');
    expect(res.metadata?.agentLevel).toBe('light');
  });

  it('normalizes method typos like pst → POST', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ intent: 'api_test', intent_confidence: 0.8, apiMethod: 'pst', apiUrl: '/api/v1/users', rawText: 'tset pst /api/v1/users' }) } }],
    });

    const { parseUserIntent } = require('@/services/ai/intent/intent-parser.service');
    const res = await parseUserIntent('tset pst /api/v1/users', {}, 'proj');

    expect(res.intent).toBe('api_test');
    expect(res.apiMethod).toBe('POST');
    expect(res.apiUrl).toBe('/api/v1/users');
    expect(res.isRelativePath).toBe(true);
  });

  it('extracts JSON when model adds extra text', async () => {
    mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content:
            'Sure. Here is the result:\n\n' +
            '{ "intent": "api_test", "intent_confidence": 0.9, "apiUrl": "/test", "rawText": "test /test" }',
        },
      }],
    });

    const { parseUserIntent } = require('@/services/ai/intent/intent-parser.service');
    const res = await parseUserIntent('test /test', {}, 'proj');

    expect(res.intent).toBe('api_test');
    expect(res.apiUrl).toBe('/test');
  });
});

describe('parseUserIntent(platform_test) executionStrategy normalization', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    mockCreate.mockReset();
    jest.resetModules();
  });

  it('keeps valid exploration executionStrategy', async () => {
    mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: 'platform_test',
            intent_confidence: 0.93,
            page: 'example.com',
            executionStrategy: 'exploration',
            rawText: 'explore example.com',
          }),
        },
      }],
    });

    const { parseUserIntent } = require('@/services/ai/intent/intent-parser.service');
    const res = await parseUserIntent('explore example.com', {}, 'proj');

    expect(res.intent).toBe('platform_test');
    expect(res.page).toBe('https://example.com');
    expect(res.executionStrategy).toBe('exploration');
  });

  it('normalizes invalid executionStrategy to standard', async () => {
    mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: 'platform_test',
            intent_confidence: 0.9,
            page: 'example.com',
            executionStrategy: 'crawl_everything',
            rawText: 'test example.com',
          }),
        },
      }],
    });

    const { parseUserIntent } = require('@/services/ai/intent/intent-parser.service');
    const res = await parseUserIntent('test example.com', {}, 'proj');

    expect(res.intent).toBe('platform_test');
    expect(res.executionStrategy).toBe('standard');
  });
});

