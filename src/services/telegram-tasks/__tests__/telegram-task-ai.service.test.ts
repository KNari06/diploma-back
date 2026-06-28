/**
 * Unit tests for the QAIT Tasker AI layer — no network. We test the
 * safety-critical pure pieces: validateActions (narrows untrusted model output)
 * and the owner-alias resolution. The LLM call itself is mocked away.
 */

// Mock the LLM boundary so importing the AI service is cheap and offline.
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));

import { validateActions, type AiTaskView } from '../telegram-task-ai.service';

const task = (id: string, over: Partial<AiTaskView> = {}): AiTaskView => ({
  id,
  project: null,
  title: 't',
  owner: null,
  progress: 'none',
  progress_note: null,
  ...over,
});

describe('validateActions', () => {
  const open = [task('a1'), task('a2')];

  it('keeps a create with a non-empty title and trims it', () => {
    const out = validateActions([{ kind: 'create', title: '  Build login  ', project: 'JP', owner: '@x' }], open, 'r');
    expect(out).toEqual([{ kind: 'create', title: 'Build login', project: 'JP', owner: '@x' }]);
  });

  it('drops a create with no usable title', () => {
    expect(validateActions([{ kind: 'create', title: '   ' }], open, 'r')).toEqual([]);
  });

  it('carries an initial status onto a create', () => {
    const out = validateActions(
      [{ kind: 'create', title: 'Pointer', state: 'in_progress', note: '1-2 days' }],
      open,
      'r',
    );
    expect(out[0]).toMatchObject({ kind: 'create', initialState: 'in_progress', initialNote: '1-2 days' });
  });

  it('drops actions referencing a task id not in context (anti-hallucination)', () => {
    expect(validateActions([{ kind: 'close', task_id: 'ghost', reason: 'done' }], open, 'r')).toEqual([]);
  });

  it('accepts close/touch/reopen against a known id', () => {
    const out = validateActions(
      [
        { kind: 'close', task_id: 'a1', reason: 'merged' },
        { kind: 'touch', task_id: 'a2' },
        { kind: 'reopen', task_id: 'a1' },
      ],
      open,
      'r',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'close', task_id: 'a1', reason: 'merged' });
  });

  it('only accepts progress with a valid state', () => {
    const out = validateActions(
      [
        { kind: 'progress', task_id: 'a1', state: 'blocked', note: 'waiting' },
        { kind: 'progress', task_id: 'a2', state: 'bogus', note: 'x' },
      ],
      open,
      'fallback',
    );
    expect(out).toEqual([{ kind: 'progress', task_id: 'a1', state: 'blocked', note: 'waiting' }]);
  });

  it('falls back to the provided reason when close.reason is missing', () => {
    const out = validateActions([{ kind: 'close', task_id: 'a1' }], open, 'batch analysis');
    expect(out[0]).toEqual({ kind: 'close', task_id: 'a1', reason: 'batch analysis' });
  });

  it('ignores non-array / garbage entries gracefully', () => {
    const out = validateActions([{ kind: 'nonsense', task_id: 'a1' }, {}], open, 'r');
    expect(out).toEqual([]);
  });
});

describe('owner aliasing', () => {
  // owner-aliases reads env at import time; jest.setup provides test env (no
  // aliases configured), so canonicalOwner is identity/trim and isManager false.
  it('passes unknown owners through trimmed and null through', async () => {
    const { canonicalOwner } = await import('../owner-aliases');
    expect(canonicalOwner('  @gipardb ')).toBe('@gipardb');
    expect(canonicalOwner(null)).toBeNull();
    expect(canonicalOwner(undefined)).toBeNull();
  });
});
