/**
 * Phase B5 — pipeline vision-attach contract test.
 *
 * Bug found in audit: `take_screenshot` returns the base64 PNG in
 * `ToolResult.data.screenshotBase64`, but the OpenAI `tool` message
 * protocol only accepts a text string in `content`. Without an extra
 * step, the LLM never sees the pixels — the tool was essentially a
 * lying placeholder.
 *
 * Fix verified here: after every successful `take_screenshot` tool
 * execution, the pipeline pushes a follow-up `user` message with
 * multimodal content (text breadcrumb + image_url with the base64
 * data URL). Non-screenshot tools don't get this treatment.
 */

// ── Mocks (order matters: declare before importing the module under test) ──

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

const mockExecuteTool = jest.fn();
jest.mock('../tools', () => ({
  MOBILE_AGENT_TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

jest.mock('@/config/ai/ai-models.config', () => ({
  AI_MODELS: { fast: 'gpt-4.1-mini', smart: 'gpt-5.4-mini' },
}));

import { runMobileAgentPipeline } from '../pipeline';
import { MobileBlackboard } from '../blackboard';

function makeBlackboard(): MobileBlackboard {
  return new MobileBlackboard({
    goal: 'screenshot please',
    mobileSessionId: 'sess-1',
    userId: 'user-1',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runMobileAgentPipeline — take_screenshot vision attaching', () => {
  it('pushes a multimodal user message with image_url after a successful take_screenshot', async () => {
    // Round 1: LLM calls take_screenshot.
    // Round 2: LLM sees the screenshot and replies with text (no more tool calls).
    mockGetChatCompletion
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'take_screenshot', arguments: '{}' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'I see the home screen with three tabs.',
        tool_calls: [],
      });

    mockExecuteTool.mockResolvedValueOnce({
      ok: true,
      content: 'Captured screenshot at 2026-05-25T10:00:00Z.',
      data: {
        screenshotBase64: 'AAAA-fake-png-data',
        capturedAt: '2026-05-25T10:00:00Z',
        screenSize: { width: 1080, height: 1920 },
      },
    });

    await runMobileAgentPipeline(makeBlackboard());

    // Second LLM call should have received both:
    //   - the tool result (text)
    //   - a user message with the multimodal content array
    const secondCallMessages = mockGetChatCompletion.mock.calls[1][0];

    const userMultimodal = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(userMultimodal).toBeDefined();

    // Confirm the content array has exactly text + image_url parts.
    const parts = userMultimodal.content as Array<{ type: string }>;
    expect(parts.length).toBe(2);
    expect(parts.find((p) => p.type === 'text')).toBeDefined();
    const imagePart = parts.find((p) => p.type === 'image_url') as any;
    expect(imagePart.image_url.url).toBe('data:image/png;base64,AAAA-fake-png-data');
    expect(imagePart.image_url.detail).toBe('low');
  });

  it('does NOT push a multimodal message when take_screenshot fails (no data.screenshotBase64)', async () => {
    mockGetChatCompletion
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'take_screenshot', arguments: '{}' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'I could not take a screenshot.',
        tool_calls: [],
      });

    mockExecuteTool.mockResolvedValueOnce({
      ok: false,
      content: 'Screenshot budget exceeded for this turn (2/2).',
      // No data field → no vision attach.
    });

    await runMobileAgentPipeline(makeBlackboard());

    const secondCallMessages = mockGetChatCompletion.mock.calls[1][0];
    const userMultimodal = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(userMultimodal).toBeUndefined();
  });

  it('does NOT push a multimodal message for non-screenshot tools (e.g. get_foreground)', async () => {
    mockGetChatCompletion
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_foreground', arguments: '{}' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'You are on kz.kolesa.',
        tool_calls: [],
      });

    // Note: this tool happens to return some data too, but no
    // screenshotBase64 field — vision attach must not fire.
    mockExecuteTool.mockResolvedValueOnce({
      ok: true,
      content: 'screenState: awake\nprimary: kz.kolesa',
      data: { someOtherField: 'value' },
    });

    await runMobileAgentPipeline(makeBlackboard());

    const secondCallMessages = mockGetChatCompletion.mock.calls[1][0];
    const userMultimodal = secondCallMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(userMultimodal).toBeUndefined();
  });

  it('uses image_url.detail="low" to keep vision-token cost bounded', async () => {
    // Regression test against accidental "high" detail bumps that would
    // defeat the per-turn screenshot budget rationale.
    mockGetChatCompletion
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'take_screenshot', arguments: '{}' } },
        ],
      })
      .mockResolvedValueOnce({ content: 'done', tool_calls: [] });

    mockExecuteTool.mockResolvedValueOnce({
      ok: true,
      content: 'Captured.',
      data: { screenshotBase64: 'AAAA', capturedAt: 't' },
    });

    await runMobileAgentPipeline(makeBlackboard());
    const msgs = mockGetChatCompletion.mock.calls[1][0];
    const userMm = msgs.find((m: any) => m.role === 'user' && Array.isArray(m.content));
    const imagePart = (userMm.content as any[]).find((p) => p.type === 'image_url');
    expect(imagePart.image_url.detail).toBe('low');
  });
});
