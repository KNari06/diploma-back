/**
 * OpenAI mock helpers for unit tests
 */

export interface MockChatCompletion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface MockEmbeddingResponse {
  object?: string;
  data?: Array<{
    object?: string;
    embedding?: number[];
    index?: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Create a mock chat completion response
 */
export function createChatCompletionMock(
  content: string = 'Test response',
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
): MockChatCompletion {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 100,
      completion_tokens: usage?.completion_tokens ?? 50,
      total_tokens: usage?.total_tokens ?? 150,
    },
  };
}

/**
 * Create a mock embedding response
 */
export function createEmbeddingMock(
  dimensions: number = 1536
): MockEmbeddingResponse {
  return {
    object: 'list',
    data: [
      {
        object: 'embedding',
        embedding: Array(dimensions).fill(0).map(() => Math.random()),
        index: 0,
      },
    ],
    model: 'text-embedding-3-small',
    usage: {
      prompt_tokens: 10,
      total_tokens: 10,
    },
  };
}

/**
 * Create a mock OpenAI client
 */
export function createOpenAIMock() {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue(createChatCompletionMock()),
      },
    },
    embeddings: {
      create: jest.fn().mockResolvedValue(createEmbeddingMock()),
    },
  };
}

/**
 * Mock OpenAI module
 * Usage: jest.mock('openai', () => ({ OpenAI: jest.fn(() => createOpenAIMock()) }))
 */
export function mockOpenAIModule() {
  const mockClient = createOpenAIMock();
  return {
    OpenAI: jest.fn(() => mockClient),
    __mockClient: mockClient, // Expose for assertions
  };
}
