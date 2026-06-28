/**
 * Tests for the AI tracking context (AsyncLocalStorage).
 *
 * This context drives billing attribution (workspaceId) and per-call AI-log
 * labelling, threaded invisibly through 20+ layers — so leakage across scopes
 * = mis-billing, and a wrong default source/entity = mislabelled activity rows.
 * Pure functions; no mocks.
 */

import {
  withAIContext,
  getAIContext,
  withAILogFields,
  deriveLogSource,
  deriveLogEntity,
  type AITrackingContext,
} from '../ai-context';

describe('withAIContext / getAIContext', () => {
  it('returns undefined outside any tracked scope', () => {
    expect(getAIContext()).toBeUndefined();
  });

  it('exposes the context inside the scope and returns the fn value', async () => {
    const ctx: AITrackingContext = { workspaceId: 'w1', userId: 'u1', operationType: 'lite-test' };
    const result = await withAIContext(ctx, async () => {
      expect(getAIContext()).toEqual(ctx);
      return 'done';
    });
    expect(result).toBe('done');
  });

  it('does not leak context after the scope ends', async () => {
    await withAIContext({ workspaceId: 'w1' }, async () => undefined);
    expect(getAIContext()).toBeUndefined();
  });
});

describe('withAILogFields', () => {
  it('merges fields onto the parent context (override wins, parent preserved)', async () => {
    await withAIContext({ workspaceId: 'w1', logActionType: 'plan', logSource: 'chat' }, async () => {
      await withAILogFields({ logActionType: 'intent' }, async () => {
        const ctx = getAIContext()!;
        expect(ctx.workspaceId).toBe('w1'); // preserved
        expect(ctx.logSource).toBe('chat'); // preserved
        expect(ctx.logActionType).toBe('intent'); // overridden
      });
    });
  });

  it('is a no-op pass-through when there is no parent context', async () => {
    let ran = false;
    const result = await withAILogFields({ logActionType: 'intent' }, async () => {
      ran = true;
      expect(getAIContext()).toBeUndefined(); // still no context
      return 7;
    });
    expect(ran).toBe(true);
    expect(result).toBe(7);
  });

  it('restores the parent context after the inner scope', async () => {
    await withAIContext({ workspaceId: 'w1', logActionType: 'plan' }, async () => {
      await withAILogFields({ logActionType: 'intent' }, async () => undefined);
      expect(getAIContext()!.logActionType).toBe('plan'); // back to parent
    });
  });
});

describe('deriveLogSource', () => {
  it('defaults to chat when there is no context', () => {
    expect(deriveLogSource(undefined)).toBe('chat');
  });

  it('prefers an explicit logSource', () => {
    expect(deriveLogSource({ workspaceId: 'w', logSource: 'ai-selector', operationType: 'chat' })).toBe('ai-selector');
  });

  it.each([
    ['chat', 'chat'],
    ['analysis', 'analysis'],
    ['lite-test', 'explorer-web'],
    ['pro-test', 'explorer-web'],
    ['api-test', 'analysis'],
    ['test-plan', 'analysis'],
    ['regression', 'analysis'],
  ] as const)('maps operationType=%s → %s', (op, expected) => {
    expect(deriveLogSource({ workspaceId: 'w', operationType: op })).toBe(expected);
  });

  it('falls back to chat for an unset / unknown operationType', () => {
    expect(deriveLogSource({ workspaceId: 'w' })).toBe('chat');
  });
});

describe('deriveLogEntity', () => {
  it('returns {} when there is no context', () => {
    expect(deriveLogEntity(undefined)).toEqual({});
  });

  it('prefers an explicit logEntityType + logEntityId', () => {
    expect(
      deriveLogEntity({ workspaceId: 'w', logEntityType: 'regression_run', logEntityId: 'r1', testId: 't1' }),
    ).toEqual({ entityType: 'regression_run', entityId: 'r1' });
  });

  it('falls back to the test execution when only testId is present', () => {
    expect(deriveLogEntity({ workspaceId: 'w', testId: 't1' })).toEqual({
      entityType: 'test_execution',
      entityId: 't1',
    });
  });

  it('returns {} when neither explicit entity nor testId is set', () => {
    expect(deriveLogEntity({ workspaceId: 'w' })).toEqual({});
  });

  it('does not use a partial explicit entity (type without id falls through to testId)', () => {
    expect(deriveLogEntity({ workspaceId: 'w', logEntityType: 'chat_session', testId: 't9' })).toEqual({
      entityType: 'test_execution',
      entityId: 't9',
    });
  });
});
