// Test setup file
import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });

// Mock external services for testing
jest.mock('@/db/supabase', () => ({
  dbService: {
    getTest: jest.fn(),
    getTestResults: jest.fn(),
    getTestsByProject: jest.fn(),
    getProject: jest.fn(),
    getUser: jest.fn(),
    createTest: jest.fn(),
    updateTest: jest.fn(),
    createTestResult: jest.fn(),
    updateTestResult: jest.fn(),
    supabaseAdmin: {
      rpc: jest.fn(),
    },
  },
  dbAdminService: {
    getTest: jest.fn(),
    getTestResults: jest.fn(),
    createTest: jest.fn(),
    updateTest: jest.fn(),
    createTestResult: jest.fn(),
    updateTestResult: jest.fn(),
    supabaseAdmin: {
      rpc: jest.fn(),
    },
  },
  testSupabaseConnection: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/services/ai.service', () => ({
  aiService: {
    analyzeTestResults: jest.fn(),
    generateTestSummary: jest.fn(),
    generateBugReport: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ status: 'healthy', latency: 100 }),
  },
}));

jest.mock('@/config/queues', () => ({
  QueueManager: {
    addTestRunJob: jest.fn(),
    addTestResultJob: jest.fn(),
    addAIAnalysisJob: jest.fn(),
    addNotificationJob: jest.fn(),
    addWebhookJob: jest.fn(),
    getQueueStats: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ status: 'healthy' }),
  },
  testRunQueue: {
    add: jest.fn(),
    close: jest.fn(),
  },
  testResultQueue: {
    add: jest.fn(),
    close: jest.fn(),
  },
  aiAnalysisQueue: {
    add: jest.fn(),
    close: jest.fn(),
  },
  notificationQueue: {
    add: jest.fn(),
    close: jest.fn(),
  },
  webhookQueue: {
    add: jest.fn(),
    close: jest.fn(),
  },
}));

// Global test timeout
jest.setTimeout(10000);

// Mock console methods in tests
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
