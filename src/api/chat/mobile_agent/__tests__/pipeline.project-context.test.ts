/**
 * Unit tests for runMobileAgentPipeline — eager project-context inject.
 *
 * When the handler resolved a project context onto the blackboard, the
 * pipeline must add it as a system message AFTER the static base prompt
 * and BEFORE the (per-turn) device snapshot, so the LLM knows the app
 * under test / open test case from the first token. Without a context,
 * behaviour is unchanged.
 */

const mockGetChatCompletion = jest.fn();
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: unknown[]) => mockGetChatCompletion(...args),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../progress', () => ({
  emitMobileAgentThinking: jest.fn(),
  emitMobileToolStep: jest.fn(),
  mobileToolProgress: jest.fn().mockReturnValue({ before: 50, after: 60 }),
}));

jest.mock('../tools', () => ({
  MOBILE_AGENT_TOOLS: [],
  executeTool: jest.fn(),
}));

jest.mock('@/config/ai/ai-models.config', () => ({
  AI_MODELS: { fast: 'gpt-4.1-mini' },
}));

import { runMobileAgentPipeline } from '../pipeline';
import { MobileBlackboard } from '../blackboard';
import type { MobileSnapshot } from '@/services/chat/mobile-context.service';
import type { MobileProjectContext } from '@/services/chat/mobile-project-context.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatCompletion.mockResolvedValue({
    content: 'done',
    tool_calls: [],
  });
});

function bb(projectContext?: MobileProjectContext) {
  const board = new MobileBlackboard({
    goal: 'create a login test',
    mobileSessionId: 'sess-1',
    userId: 'u1',
    chatSessionId: 'chat-1',
  });
  if (projectContext) board.setProjectContext(projectContext);
  return board;
}

const projectContext: MobileProjectContext = {
  projectId: 'proj-1',
  projectName: 'Kolesa App',
  appPackage: 'kz.kolesa',
  detectedFramework: 'flutter',
  source: 'chat_session',
};

const snapshot: MobileSnapshot = {
  sessionId: 'sess-1',
  platform: 'android',
  expectedApp: 'kz.kolesa',
  fingerprint: 'fp',
  screenSize: { width: 1080, height: 1920 },
  formattedTree: '## screen',
  foregroundMismatch: null,
  recentDisruption: null,
  capturedAt: '2026-07-07T10:00:00.000Z',
};

function sentMessages(): Array<{ role: string; content: string }> {
  return mockGetChatCompletion.mock.calls[0][0];
}

describe('runMobileAgentPipeline — project-context inject', () => {
  it('injects the project block as a system message between base prompt and snapshot', async () => {
    await runMobileAgentPipeline(bb(projectContext), { snapshot });

    const messages = sentMessages();
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'system', 'user']);
    expect(messages[1].content).toContain('--- PROJECT CONTEXT ---');
    expect(messages[1].content).toContain('kz.kolesa');
    expect(messages[2].content).toContain('--- MOBILE SESSION CONTEXT ---');
  });

  it('injects the project block even without a snapshot (PULL fallback)', async () => {
    await runMobileAgentPipeline(bb(projectContext), { snapshot: null });

    const messages = sentMessages();
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(messages[1].content).toContain('--- PROJECT CONTEXT ---');
  });

  it('keeps legacy shape when no project context resolved', async () => {
    await runMobileAgentPipeline(bb(), { snapshot });

    const messages = sentMessages();
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(messages[1].content).toContain('--- MOBILE SESSION CONTEXT ---');
    for (const m of messages) {
      expect(m.content).not.toContain('--- PROJECT CONTEXT ---');
    }
  });
});
