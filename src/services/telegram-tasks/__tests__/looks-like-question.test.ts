/**
 * Unit tests for the Q&A-vs-action routing heuristic. Pure function; we mock the
 * service's heavy boundaries (db + LLM) only so the module imports offline.
 */
jest.mock('@/services/ai/core/openai.service', () => ({ getChatCompletionWithMessages: jest.fn() }));
jest.mock('../db/telegram-task.db', () => ({}));

import { looksLikeQuestion } from '../telegram-task.service';

describe('looksLikeQuestion', () => {
  it('treats explicit questions as questions', () => {
    expect(looksLikeQuestion('what is open?')).toBe(true);
    expect(looksLikeQuestion('which tasks are blocked')).toBe(true);
    expect(looksLikeQuestion('status of JP')).toBe(true);
    expect(looksLikeQuestion('сколько задач у @dara')).toBe(true);
  });

  it('treats clear closure/action statements as NOT questions (→ reconcile)', () => {
    expect(looksLikeQuestion('done')).toBe(false);
    expect(looksLikeQuestion('merged and deployed')).toBe(false);
    expect(looksLikeQuestion('готово, залил')).toBe(false);
    expect(looksLikeQuestion('закрыл #3')).toBe(false);
  });

  it('defaults ambiguous text to a question (safe: digest-line replies still close)', () => {
    expect(looksLikeQuestion('hey')).toBe(true);
    expect(looksLikeQuestion('the video one')).toBe(true);
  });

  it('a question that also contains an action word still routes to Q&A (? wins)', () => {
    expect(looksLikeQuestion('is the video task done?')).toBe(true);
  });
});
