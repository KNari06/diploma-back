/**
 * Unit tests for the QAIT Tasker AI layer — no network. We test the
 * safety-critical pure pieces: validateActions (narrows untrusted model output)
 * and the owner-alias resolution. The LLM call itself is mocked away.
 */

// Mock the LLM boundary so importing the AI service is cheap and offline.
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));

import { validateActions, renderDeadline, type AiTaskView } from '../telegram-task-ai.service';

const task = (id: string, over: Partial<AiTaskView> = {}): AiTaskView => ({
  id,
  project: null,
  title: 't',
  owner: null,
  progress: 'none',
  progress_note: null,
  has_deadline: false,
  due_text: null,
  due_at: null,
  link: null,
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

  // ── authority guard (the "I didn't check" bug): a non-owner non-manager must
  //    not mutate a task; status changes downgrade to a harmless touch ──────────
  describe('authority guard', () => {
    const owned = [task('t1', { owner: '@ndarkhans' })];

    it('downgrades progress from a NON-owner to touch', () => {
      const out = validateActions(
        [{ kind: 'progress', task_id: 't1', state: 'in_progress', note: "I didn't check" }],
        owned,
        'r',
        { owner: '@yerassylospan', isManager: false },
      );
      expect(out).toEqual([{ kind: 'touch', task_id: 't1' }]);
    });

    it('allows progress from the OWNER', () => {
      const out = validateActions(
        [{ kind: 'progress', task_id: 't1', state: 'in_progress', note: 'on it' }],
        owned,
        'r',
        { owner: '@ndarkhans', isManager: false },
      );
      expect(out[0]).toMatchObject({ kind: 'progress', state: 'in_progress' });
    });

    it('allows a MANAGER to close anyone’s task', () => {
      const out = validateActions(
        [{ kind: 'close', task_id: 't1', reason: 'shipped' }],
        owned,
        'r',
        { owner: '@someone_else', isManager: true },
      );
      expect(out[0]).toMatchObject({ kind: 'close', task_id: 't1' });
    });

    it('downgrades a non-owner CLOSE to touch (still resets staleness)', () => {
      const out = validateActions(
        [{ kind: 'close', task_id: 't1', reason: 'done?' }],
        owned,
        'r',
        { owner: '@yerassylospan', isManager: false },
      );
      expect(out).toEqual([{ kind: 'touch', task_id: 't1' }]);
    });

    it('with no actor (batch path) applies status changes without an authority check', () => {
      const out = validateActions(
        [{ kind: 'progress', task_id: 't1', state: 'blocked', note: 'x' }],
        owned,
        'r',
      );
      expect(out[0]).toMatchObject({ kind: 'progress', state: 'blocked' });
    });

    it('owner claim survives; non-owner claim downgrades to touch', () => {
      const ownerOut = validateActions([{ kind: 'claim', task_id: 't1' }], owned, 'r', { owner: '@ndarkhans', isManager: false });
      expect(ownerOut).toEqual([{ kind: 'claim', task_id: 't1' }]);
      const strangerOut = validateActions([{ kind: 'claim', task_id: 't1' }], owned, 'r', { owner: '@x', isManager: false });
      expect(strangerOut).toEqual([{ kind: 'touch', task_id: 't1' }]);
    });
  });

  describe('clarify', () => {
    const many = [task('c1'), task('c2'), task('c3')];

    it('keeps a clarify with 2+ real candidate ids (deduped)', () => {
      const out = validateActions([{ kind: 'clarify', candidate_ids: ['c1', 'c2', 'c1'] }], many, 'r');
      expect(out).toEqual([{ kind: 'clarify', candidate_ids: ['c1', 'c2'] }]);
    });

    it('drops a clarify with fewer than 2 valid candidates', () => {
      expect(validateActions([{ kind: 'clarify', candidate_ids: ['c1'] }], many, 'r')).toEqual([]);
      expect(validateActions([{ kind: 'clarify', candidate_ids: ['ghost', 'nope'] }], many, 'r')).toEqual([]);
    });
  });

  describe('ambiguous-reply guard (reply maps to 2+ tasks, e.g. a digest)', () => {
    const owner = { owner: '@x', isManager: true };
    const many = [task('c1', { owner: '@x' }), task('c2', { owner: '@x' }), task('c3', { owner: '@x' })];

    it('rewrites a guessed single-target claim into a clarify over the reply candidates', () => {
      // "this task on me" replying to a digest → reply resolves to c1+c2; the
      // model picked c1, but it cannot know which → ask instead.
      const out = validateActions([{ kind: 'claim', task_id: 'c1' }], many, 'r', owner, ['c1', 'c2']);
      expect(out).toEqual([{ kind: 'clarify', candidate_ids: ['c1', 'c2'] }]);
    });

    it('also guards close / progress / set_deadline', () => {
      for (const a of [
        { kind: 'close', task_id: 'c1', reason: 'done' },
        { kind: 'progress', task_id: 'c2', state: 'in_progress' },
        { kind: 'set_deadline', task_id: 'c1', due_text: 'Friday', due_at: null },
      ]) {
        const out = validateActions([a], many, 'r', owner, ['c1', 'c2']);
        expect(out).toEqual([{ kind: 'clarify', candidate_ids: ['c1', 'c2'] }]);
      }
    });

    it('does NOT guard when the reply maps to a single task (unambiguous)', () => {
      const out = validateActions([{ kind: 'claim', task_id: 'c1' }], many, 'r', owner, ['c1']);
      expect(out).toEqual([{ kind: 'claim', task_id: 'c1' }]);
    });

    it('does NOT guard a target outside the ambiguous set', () => {
      const out = validateActions([{ kind: 'claim', task_id: 'c3' }], many, 'r', owner, ['c1', 'c2']);
      expect(out).toEqual([{ kind: 'claim', task_id: 'c3' }]);
    });

    it('lets update/touch through (explicit edit / harmless) even when ambiguous', () => {
      const out = validateActions([{ kind: 'touch', task_id: 'c1' }], many, 'r', owner, ['c1', 'c2']);
      expect(out).toEqual([{ kind: 'touch', task_id: 'c1' }]);
    });

    it('does not double-ask when the model already emitted a clarify', () => {
      const out = validateActions(
        [{ kind: 'clarify', candidate_ids: ['c1', 'c2'] }, { kind: 'claim', task_id: 'c1' }],
        many, 'r', owner, ['c1', 'c2'],
      );
      expect(out.filter((x) => x.kind === 'clarify')).toHaveLength(1);
    });
  });

  describe('set_deadline', () => {
    const owned = [task('t1', { owner: '@ndarkhans' })];

    it('keeps due_text + due_at from the owner', () => {
      const out = validateActions(
        [{ kind: 'set_deadline', task_id: 't1', due_text: 'by Friday', due_at: '2026-07-03T09:00:00Z' }],
        owned,
        'r',
        { owner: '@ndarkhans', isManager: false },
      );
      expect(out[0]).toEqual({ kind: 'set_deadline', task_id: 't1', due_text: 'by Friday', due_at: '2026-07-03T09:00:00Z' });
    });

    it('allows a null due_at (unparseable date) but requires due_text', () => {
      const ok = validateActions([{ kind: 'set_deadline', task_id: 't1', due_text: 'к концу недели', due_at: null }], owned, 'r');
      expect(ok[0]).toMatchObject({ kind: 'set_deadline', due_at: null });
      const dropped = validateActions([{ kind: 'set_deadline', task_id: 't1', due_text: '  ', due_at: null }], owned, 'r');
      expect(dropped).toEqual([]);
    });

    it('downgrades a non-owner set_deadline to touch', () => {
      const out = validateActions(
        [{ kind: 'set_deadline', task_id: 't1', due_text: 'tomorrow', due_at: null }],
        owned,
        'r',
        { owner: '@x', isManager: false },
      );
      expect(out).toEqual([{ kind: 'touch', task_id: 't1' }]);
    });
  });

  it('ignores non-array / garbage entries gracefully', () => {
    const out = validateActions([{ kind: 'nonsense', task_id: 'a1' }, {}], open, 'r');
    expect(out).toEqual([]);
  });
});

describe('renderDeadline (what the model sees about a task deadline)', () => {
  const NOW = Date.parse('2026-06-29T12:00:00Z');
  const v = (over: Partial<AiTaskView>): AiTaskView => task('x', over);

  it('shows "no deadline" when none is set', () => {
    expect(renderDeadline(v({ has_deadline: false }), NOW)).toBe(' [no deadline]');
  });

  it('flags OVERDUE when due_at is in the past', () => {
    const out = renderDeadline(v({ has_deadline: true, due_text: 'к пятнице', due_at: '2026-06-26T10:00:00Z' }), NOW);
    expect(out).toContain('OVERDUE');
    expect(out).toContain('к пятнице');
    expect(out).toContain('2026-06-26T10:00:00Z');
  });

  it('does NOT flag OVERDUE when due_at is in the future', () => {
    const out = renderDeadline(v({ has_deadline: true, due_text: 'Friday', due_at: '2026-07-03T10:00:00Z' }), NOW);
    expect(out).not.toContain('OVERDUE');
    expect(out).toContain('2026-07-03T10:00:00Z');
  });

  it('shows the words but no overdue verdict when due_at is unknown/unparsed', () => {
    const out = renderDeadline(v({ has_deadline: true, due_text: 'soon', due_at: null }), NOW);
    expect(out).toBe(' [deadline "soon"]');
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
