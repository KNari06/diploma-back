/** Unit tests for taskLink — the t.me deep-link builder. Mock heavy boundaries
 *  so the service imports offline. */
jest.mock('@/services/ai/core/openai.service', () => ({ getChatCompletionWithMessages: jest.fn() }));
jest.mock('../db/telegram-task.db', () => ({}));

import { taskLink, taskUrl, renderReplyTokens } from '../telegram-task.service';

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

describe('taskLink', () => {
  it('builds a t.me/c link for a supergroup, stripping the -100 prefix', () => {
    expect(taskLink(-1001234567890, 42, 'Video')).toBe(
      '<a href="https://t.me/c/1234567890/42">Video</a>',
    );
  });

  it('escapes the label inside the link', () => {
    expect(taskLink(-1001234567890, 42, '<b>x</b> & y')).toBe(
      '<a href="https://t.me/c/1234567890/42">&lt;b&gt;x&lt;/b&gt; &amp; y</a>',
    );
  });

  it('returns plain escaped label (no link) for a non-supergroup chat', () => {
    expect(taskLink(123456, 42, 'Video')).toBe('Video');
    expect(taskLink(123456, 42, 'a & b')).toBe('a &amp; b');
  });

  it('returns plain label when there is no source message', () => {
    expect(taskLink(-1001234567890, null, 'Video')).toBe('Video');
  });
});
