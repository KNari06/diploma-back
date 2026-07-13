/**
 * Unit tests for `extractContextProjectId`.
 *
 * The controller uses this to pull the UI-selected project out of the
 * request context so it can sync `chat_sessions.project_id` (Tier-0) and
 * stop the chat answering about a stale project. It must accept both the
 * parsed-object form and the JSON-string form (multipart uploads), and
 * reject anything that isn't a usable id. Access is validated separately
 * by the caller — this helper is pure extraction.
 */

import { extractContextProjectId } from '../chat.controller';

describe('extractContextProjectId', () => {
  it('reads projectId from an object context', () => {
    expect(extractContextProjectId({ projectId: 'proj-123' })).toBe('proj-123');
  });

  it('reads projectId from a JSON-string context (multipart uploads)', () => {
    expect(extractContextProjectId(JSON.stringify({ projectId: 'proj-123', environment: 'prod' }))).toBe('proj-123');
  });

  it('trims surrounding whitespace', () => {
    expect(extractContextProjectId({ projectId: '  proj-123  ' })).toBe('proj-123');
  });

  it('returns undefined when projectId is absent', () => {
    expect(extractContextProjectId({ environment: 'prod' })).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only projectId', () => {
    expect(extractContextProjectId({ projectId: '' })).toBeUndefined();
    expect(extractContextProjectId({ projectId: '   ' })).toBeUndefined();
  });

  it('returns undefined for a non-string projectId', () => {
    expect(extractContextProjectId({ projectId: 123 })).toBeUndefined();
    expect(extractContextProjectId({ projectId: { id: 'x' } })).toBeUndefined();
  });

  it('returns undefined for malformed JSON, null, arrays, and primitives', () => {
    expect(extractContextProjectId('{not json')).toBeUndefined();
    expect(extractContextProjectId(null)).toBeUndefined();
    expect(extractContextProjectId(undefined)).toBeUndefined();
    expect(extractContextProjectId(['projectId'])).toBeUndefined();
    expect(extractContextProjectId(42)).toBeUndefined();
  });
});
