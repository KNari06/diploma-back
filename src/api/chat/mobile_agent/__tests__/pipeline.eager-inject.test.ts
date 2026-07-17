/**
 * Unit tests for runMobileAgentPipeline — Phase B4 eager-inject.
 *
 * Goal: verify that when `opts.snapshot` is provided, a SECOND system
 * message (the formatted snapshot block) lands in `messages` BEFORE
 * the user message. When `snapshot` is omitted/null, behaviour is
 * unchanged from Phase 3 (system + user only).
 *
 * We mock the OpenAI client so the test doesn't hit the network and
 * exits immediately on the first response (no tool_calls → done).
 */

// Mock OpenAI call FIRST.
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

beforeEach(() => {
  jest.clearAllMocks();
  // Default: LLM returns a plain text reply immediately, no tool calls.
  mockGetChatCompletion.mockResolvedValue({
    content: 'Hello, here is what I see',
    tool_calls: [],
  });
});

function bb() {
  return new MobileBlackboard({
    goal: 'привет, что ты видишь?',
    mobileSessionId: 'sess-1',
    userId: 'u1',
    chatSessionId: 'chat-1',
  });
}

function snapshot(overrides: Partial<MobileSnapshot> = {}): MobileSnapshot {
  return {
    sessionId: 'sess-1',
    platform: 'android',
    expectedApp: 'kz.kolesa',
    fingerprint: 'fp',
    screenSize: { width: 1080, height: 1920 },
    formattedTree: '## screen\n  Button "Login"',
    foregroundMismatch: null,
    recentDisruption: null,
    capturedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('runMobileAgentPipeline — eager snapshot inject', () => {
  it('injects snapshot as SECOND system message when provided', async () => {
    await runMobileAgentPipeline(bb(), { snapshot: snapshot() });

    expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    // Expected ordering: [base system, snapshot system, user]
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toMatch(/MOBILE SESSION CONTEXT/);
    expect(messages[1].content).toMatch(/kz\.kolesa/);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('привет, что ты видишь?');
  });

  it('SKIPS the snapshot system message when opts.snapshot is null', async () => {
    await runMobileAgentPipeline(bb(), { snapshot: null });

    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('SKIPS the snapshot when opts.snapshot is undefined (legacy callers)', async () => {
    // Old callers (Phase 3) passed { abortSignal } only. No snapshot field
    // means no behaviour change.
    await runMobileAgentPipeline(bb(), { abortSignal: undefined });

    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
  });

  it('surfaces foregroundMismatch warning into the injected block', async () => {
    await runMobileAgentPipeline(bb(), {
      snapshot: snapshot({
        foregroundMismatch: { expected: 'kz.kolesa', actual: 'kz.janapost' },
      }),
    });

    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toMatch(/FOREGROUND MISMATCH/);
    expect(messages[1].content).toMatch(/kz\.janapost/);
  });

  it('injects the app-skeleton block as a system message when provided [app-skeleton]', async () => {
    await runMobileAgentPipeline(bb(), {
      appSkeletonBlock: '## APP SKELETON\nbanking app. 3 screens mapped.',
    });
    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const skeleton = messages.find((m) => m.role === 'system' && m.content.includes('APP SKELETON'));
    expect(skeleton).toBeDefined();
    expect(skeleton?.content).toContain('3 screens mapped');
    // Must precede the user message (cache-local app context).
    const userIdx = messages.findIndex((m) => m.role === 'user');
    expect(messages.indexOf(skeleton!)).toBeLessThan(userIdx);
  });

  it('SKIPS the app-skeleton block when null (app not explored yet)', async () => {
    await runMobileAgentPipeline(bb(), { appSkeletonBlock: null });
    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.content.includes('APP SKELETON'))).toBe(false);
  });

  it('does not change role order — system messages must precede user', async () => {
    // Defensive: a prior implementation might be tempted to put the
    // snapshot last (closer to the user message). Don't — OpenAI's
    // prompt cache hashes from message[0], so we want the immutable
    // base system prompt at index 0 and only index 1 changes per turn.
    await runMobileAgentPipeline(bb(), { snapshot: snapshot() });
    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string }>;
    const systemIndices = messages.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0);
    const userIndices = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    expect(Math.max(...systemIndices)).toBeLessThan(Math.min(...userIndices));
  });
});
