/**
 * Jest global setup
 * - Mocks logger to silence output during tests
 * - Sets NODE_ENV to 'test'
 * - Provides global helpers
 */

/// <reference types="jest" />

// Set NODE_ENV before anything else
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Mock logger to silence console output during tests
jest.mock('@/utils/core/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    http: jest.fn(),
  },
  morganStream: { write: jest.fn() },
  logRequest: jest.fn(),
  logError: jest.fn(),
  logTestEvent: jest.fn(),
  logQueueEvent: jest.fn(),
  logAIAnalysis: jest.fn(),
  logAgentCommunication: jest.fn(),
  logDatabaseOperation: jest.fn(),
  logPerformance: jest.fn(),
}));

// Mock env config to provide test defaults
jest.mock('@/config/environment/env', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 3000,
    API_VERSION: 'v1',
    LOG_LEVEL: 'silent',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    SUPABASE_BUCKET_NAME: 'test-bucket',
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_MODEL: 'gpt-4o-mini',
    OPENAI_MAX_TOKENS: 1000,
    REDIS_URL: 'redis://localhost:6379',
  },
  isDevelopment: false,
  isProduction: false,
}));

// Clear all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Global test timeout
jest.setTimeout(10000);
