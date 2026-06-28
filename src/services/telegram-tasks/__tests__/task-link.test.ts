/** Unit tests for taskLink — the t.me deep-link builder. Mock heavy boundaries
 *  so the service imports offline. */
jest.mock('@/services/ai/core/openai.service', () => ({ getChatCompletionWithMessages: jest.fn() }));
jest.mock('../db/telegram-task.db', () => ({}));

import { taskLink } from '../telegram-task.service';

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
