// extractJson is pure; callAiWithRetry calls the chat-completion client (mocked)
// and backs off via setTimeout (driven with fake timers). Logger is globally
// mocked in jest.setup.ts.
jest.mock('@/services/ai/core/openai.service', () => ({ getChatCompletionWithMessages: jest.fn() }));

import { extractJson, callAiWithRetry } from '../ai-json.util';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';

const aiMock = getChatCompletionWithMessages as jest.Mock;

describe('extractJson', () => {
  it('parses a clean JSON object directly', () => {
    expect(extractJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('parses a top-level JSON array directly', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('recovers a JSON object surrounded by reasoning text', () => {
    const content = 'Sure! Here is the result:\n{"ok": true}\nLet me know if that helps.';
    expect(extractJson(content)).toEqual({ ok: true });
  });

  it('recovers nested objects via the first/last brace span', () => {
    expect(extractJson('noise {"a":{"b":1}} trailing')).toEqual({ a: { b: 1 } });
  });

  it('recovers JSON from a ```json fenced block when brace-slicing fails', () => {
    // Leading invalid braces make the brace-span attempt fail, forcing the
    // markdown-code-block path.
    const content = 'oops { not json } then:\n```json\n{"x":2}\n```';
    expect(extractJson(content)).toEqual({ x: 2 });
  });

  it('recovers an array from an unlabeled code fence (no braces to slice)', () => {
    expect(extractJson('result:\n```\n[5,6]\n```')).toEqual([5, 6]);
  });

  it('recovers a plain ```json-fenced object with nothing else around it (Gemini 2.5 Flash vision incident, 2026-07-10)', () => {
    const content = '```json\n{\n"anomalyDetected": false,\n"category": null,\n"description": "",\n"confidence": 0\n}\n```';
    expect(extractJson(content)).toEqual({ anomalyDetected: false, category: null, description: '', confidence: 0 });
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('just some prose, nothing structured')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractJson('')).toBeNull();
  });

  it('returns null when every recovery strategy yields invalid JSON', () => {
    expect(extractJson('{ definitely : not, valid }')).toBeNull();
  });
});

describe('callAiWithRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the response content on the first successful attempt', async () => {
    aiMock.mockResolvedValueOnce({ content: 'hello' });
    await expect(callAiWithRetry([{ role: 'user', content: 'hi' }], {}, 'Agent')).resolves.toBe('hello');
    expect(aiMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a backoff and returns the eventual success', async () => {
    aiMock.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({ content: 'recovered' });
    const promise = callAiWithRetry([], {}, 'Agent');
    await jest.advanceTimersByTimeAsync(2000); // flush the 2s backoff + retry
    await expect(promise).resolves.toBe('recovered');
    expect(aiMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting the default retry budget (2 attempts)', async () => {
    aiMock.mockRejectedValue(new Error('boom'));
    const promise = callAiWithRetry([], {}, 'Agent');
    const assertion = expect(promise).rejects.toThrow('Agent failed after 2 attempts: boom');
    await jest.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(aiMock).toHaveBeenCalledTimes(2);
  });

  it('makes exactly one attempt and does not back off when retryCount is 0', async () => {
    aiMock.mockRejectedValueOnce(new Error('nope'));
    await expect(callAiWithRetry([], {}, 'Agent', 0)).rejects.toThrow('Agent failed after 1 attempts: nope');
    expect(aiMock).toHaveBeenCalledTimes(1);
  });
});
