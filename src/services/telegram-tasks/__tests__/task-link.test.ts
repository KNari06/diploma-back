/** Unit tests for taskLink — the t.me deep-link builder. Mock heavy boundaries
 *  so the service imports offline. */
jest.mock('@/services/ai/core/openai.service', () => ({ getChatCompletionWithMessages: jest.fn() }));
jest.mock('../db/telegram-task.db', () => ({}));

import { taskUrl, renderReplyTokens } from '../telegram-task.service';

const row = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, chat_id: -1001234567890, source_msg_id: 42, project: 'JP', title: 'T', ...over }) as never;

describe('renderReplyTokens', () => {
  it('replaces a known task token with a code-built <a> link', () => {
    const out = renderReplyTokens('1. [[t:abc123]][JP] Video[[/t]]', [row('abc123')]);
    expect(out).toBe('1. <a href="https://t.me/c/1234567890/42">[JP] Video</a>');
  });

  it('falls back to plain (escaped) label for an unknown (hex) id', () => {
    expect(renderReplyTokens('[[t:dead00]]X & Y[[/t]]', [row('abc123')])).toBe('X &amp; Y');
  });

  it('falls back to plain label when the chat is not deep-linkable', () => {
    const out = renderReplyTokens('[[t:abc123]]Video[[/t]]', [row('abc123', { chat_id: 555 })]);
    expect(out).toBe('Video');
  });

  it('escapes free text outside tokens', () => {
    expect(renderReplyTokens('a < b & c', [])).toBe('a &lt; b &amp; c');
  });
});

describe('taskUrl', () => {
  it('builds a t.me/c url for a supergroup', () => {
    expect(taskUrl(-1001234567890, 42)).toBe('https://t.me/c/1234567890/42');
  });
  it('is null for a non-supergroup chat or missing source message', () => {
    expect(taskUrl(123456, 42)).toBeNull();
    expect(taskUrl(-1001234567890, null)).toBeNull();
  });
});
