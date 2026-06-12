/**
 * Slice A — the agent must KNOW about mobile exploration so it can answer
 * "what can you do?", "how does mobile testing work?", and "why won't it
 * start?". The capability knowledge is a single shared constant injected
 * into BOTH answer paths (monolithic chat prompt + sub-agent responder),
 * so they can't drift. These tests pin that wiring.
 */

import {
  MOBILE_EXPLORATION_KNOWLEDGE,
  buildChatSystemPrompt,
} from '../intent-and-chat-prompts';
import { buildSimpleChatPrompt } from '@/api/chat/general/sub-agents/prompts/responder-prompt';

describe('mobile exploration agent knowledge', () => {
  it('the shared knowledge block covers capability, build requirement, and blockers', () => {
    const k = MOBILE_EXPLORATION_KNOWLEDGE;
    expect(k).toMatch(/mobile/i);
    expect(k).toMatch(/emulator|simulator/i);
    expect(k).toMatch(/\.apk|\.ipa/i);
    // Flutter debug-build requirement — the #1 mobile gotcha.
    expect(k).toMatch(/flutter/i);
    expect(k).toMatch(/debug/i);
    // Plain-language blocker guidance (no internal jargon leaking).
    expect(k).toMatch(/offline|contact support|device|upload/i);
    expect(k).not.toMatch(/runner|LLM key/);
  });

  it('the monolithic chat system prompt includes the mobile knowledge', () => {
    expect(buildChatSystemPrompt()).toContain(MOBILE_EXPLORATION_KNOWLEDGE);
  });

  it('the sub-agent responder prompt includes the mobile knowledge', () => {
    expect(buildSimpleChatPrompt('')).toContain(MOBILE_EXPLORATION_KNOWLEDGE);
  });
});
