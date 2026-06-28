/**
 * Tests for the in-memory AI action-log ring buffer.
 *
 * This is the backing store the AI-actions GET endpoint reads, so its
 * filtering, newest-first ordering, limit clamping, eviction (cap 500), and
 * cross-process dedup (pushExisting) all directly shape what the user sees in
 * the AI activity panel. A dedup or eviction bug shows duplicate/ghost rows or
 * silently drops recent activity.
 *
 * The buffer is a module singleton, so each test re-requires a fresh module.
 */

import type { AIActionEntry } from '../ai-log-buffer';

type Buffer = typeof import('../ai-log-buffer').aiLogBuffer;
let buffer: Buffer;

beforeEach(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  buffer = require('../ai-log-buffer').aiLogBuffer;
});

function input(over: Partial<AIActionEntry> = {}): Omit<AIActionEntry, 'id' | 'created_at'> {
  return {
    user_id: 'u1',
    workspace_id: 'w1',
    source: 'chat',
    action_type: 'click',
    status: 'succeeded',
    summary: 'Clicked the button',
    detail: {},
    entity_type: 'test_execution',
    entity_id: 'e1',
    iteration: null,
    duration_ms: null,
    model: null,
    provider: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    error: null,
    ...over,
  };
}

describe('push', () => {
  it('assigns an id + created_at and returns the stored entry', () => {
    const stored = buffer.push(input());
    expect(stored.id).toBeTruthy();
    expect(stored.created_at).toBeTruthy();
    expect(stored.summary).toBe('Clicked the button');
    expect(buffer.size()).toBe(1);
  });
});

describe('query — filtering', () => {
  it('returns only the requesting user’s entries', () => {
    buffer.push(input({ user_id: 'u1', summary: 'mine' }));
    buffer.push(input({ user_id: 'u2', summary: 'theirs' }));
    const out = buffer.query({ userId: 'u1' });
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe('mine');
  });

  it('filters by source / status / entityType / entityId', () => {
    buffer.push(input({ source: 'chat', status: 'succeeded', entity_type: 'test_execution', entity_id: 'e1' }));
    buffer.push(input({ source: 'analysis', status: 'failed', entity_type: 'regression_run', entity_id: 'e2' }));

    expect(buffer.query({ userId: 'u1', source: 'analysis' }).map((e) => e.source)).toEqual(['analysis']);
    expect(buffer.query({ userId: 'u1', status: 'failed' }).map((e) => e.status)).toEqual(['failed']);
    expect(buffer.query({ userId: 'u1', entityType: 'regression_run' })).toHaveLength(1);
    expect(buffer.query({ userId: 'u1', entityId: 'e1' })).toHaveLength(1);
  });

  it('does a case-insensitive substring search on summary via q', () => {
    buffer.push(input({ summary: 'Logged into the Dashboard' }));
    buffer.push(input({ summary: 'Filled the form' }));
    expect(buffer.query({ userId: 'u1', q: 'dashboard' })).toHaveLength(1);
    expect(buffer.query({ userId: 'u1', q: 'FORM' })).toHaveLength(1);
    expect(buffer.query({ userId: 'u1', q: 'missing' })).toHaveLength(0);
  });
});

describe('query — ordering and limit', () => {
  it('returns newest first', () => {
    buffer.push(input({ summary: 'first' }));
    buffer.push(input({ summary: 'second' }));
    buffer.push(input({ summary: 'third' }));
    expect(buffer.query({ userId: 'u1' }).map((e) => e.summary)).toEqual(['third', 'second', 'first']);
  });

  it('clamps limit to [1, 200] and defaults to 50', () => {
    for (let i = 0; i < 60; i++) buffer.push(input({ summary: `e${i}` }));
    expect(buffer.query({ userId: 'u1' })).toHaveLength(50); // default
    expect(buffer.query({ userId: 'u1', limit: 5 })).toHaveLength(5);
    expect(buffer.query({ userId: 'u1', limit: 0 })).toHaveLength(1); // min 1
    expect(buffer.query({ userId: 'u1', limit: 999 })).toHaveLength(60); // capped at 200, only 60 exist
  });
});

describe('eviction (cap 500, oldest first)', () => {
  it('caps the buffer at 500 entries and drops the oldest', () => {
    for (let i = 0; i < 505; i++) buffer.push(input({ summary: `entry-${i}`, entity_id: `id-${i}` }));
    expect(buffer.size()).toBe(500);
    // The 5 oldest (entry-0..entry-4) were evicted.
    expect(buffer.query({ userId: 'u1', entityId: 'id-0' })).toHaveLength(0);
    expect(buffer.query({ userId: 'u1', entityId: 'id-4' })).toHaveLength(0);
    expect(buffer.query({ userId: 'u1', entityId: 'id-5' })).toHaveLength(1);
  });
});

describe('pushExisting — cross-process dedup', () => {
  function full(id: string, over: Partial<AIActionEntry> = {}): AIActionEntry {
    return { id, created_at: '2026-06-27T00:00:00.000Z', ...input(over) } as AIActionEntry;
  }

  it('ingests an entry that already has id/created_at', () => {
    buffer.pushExisting(full('abc', { summary: 'from worker' }));
    expect(buffer.size()).toBe(1);
    expect(buffer.query({ userId: 'u1' })[0].id).toBe('abc');
  });

  it('drops a redelivered entry with the same id (idempotent)', () => {
    buffer.pushExisting(full('dup'));
    buffer.pushExisting(full('dup'));
    expect(buffer.size()).toBe(1);
  });

  it('allows distinct ids through', () => {
    buffer.pushExisting(full('a'));
    buffer.pushExisting(full('b'));
    expect(buffer.size()).toBe(2);
  });
});
