/**
 * Confirm guard — the two-phase approval state machine.
 *
 * The guard downgrades an unbacked `confirm=true` to `false` so a WRITE tool
 * cannot run without the user having seen a preview first. The bug these tests
 * pin: the downgrade recorded nothing, so the NEXT `confirm=true` was also
 * unbacked and downgraded again. Since no prompt instructs the model to send an
 * explicit `confirm=false`, nothing ever recorded a preview and the sequence
 * never advanced — the user was asked to approve the same action indefinitely
 * (observed on `qa_author_test_iteratively`: five approvals, each answered
 * "yes", never authored).
 */

import { SkillRegistry } from '../skill-registry';
import type { SkillContext, SkillDefinition } from '../types';

jest.mock('@/db/supabase', () => ({ supabaseAdmin: {} }));

/** Records the `confirm` value the handler actually observed, per call. */
const seenConfirm: unknown[] = [];

const writeSkill: SkillDefinition = {
  id: 'test-write-skill',
  name: 'Test Write Skill',
  description: 'fixture',
  isAvailable: async () => true,
  tools: [
    {
      type: 'function',
      function: {
        name: 'test_write_tool',
        description: 'fixture write tool',
        parameters: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', description: 'user approved' },
          },
        },
      },
    },
  ],
  execute: async (_toolName: string, args: Record<string, unknown>) => {
    seenConfirm.push(args.confirm);
    return { success: true, message: 'ran', displayToUser: false };
  },
} as unknown as SkillDefinition;

const context = (chatSessionId: string): SkillContext =>
  ({ userId: 'user-1', chatSessionId, mode: 'editor' }) as unknown as SkillContext;

beforeEach(() => {
  seenConfirm.length = 0;
  SkillRegistry.clear();
  SkillRegistry.register(writeSkill);
});

afterAll(() => SkillRegistry.clear());

describe('confirm guard', () => {
  it('downgrades the first confirm=true so the handler returns its preview', async () => {
    await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('s1'));

    expect(seenConfirm).toEqual([false]);
  });

  it('honours the second confirm=true after the downgraded preview turn', async () => {
    // Turn 1: model calls confirm=true with no prior preview -> downgraded,
    // handler asks the user. Turn 2: user said yes, model calls again.
    await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('s2'));
    await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('s2'));

    expect(seenConfirm).toEqual([false, true]);
  });

  it('does not loop: three confirm=true calls never leave the tool unrun', async () => {
    for (let i = 0; i < 3; i++) {
      await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('s3'));
    }

    // The write reaches the handler. The pre-fix behaviour was
    // [false, false, false] — approved every time, never run.
    expect(seenConfirm).toContain(true);
  });

  it('answers a duplicate confirm=true with "already done" instead of re-running or re-asking', async () => {
    // Same args each time — the real case is one assistant message emitting
    // the same tool_call twice.
    const args = () => ({ goal: 'login', confirm: true });
    await SkillRegistry.executeTool('test_write_tool', args(), context('s4'));
    await SkillRegistry.executeTool('test_write_tool', args(), context('s4'));
    const dup = await SkillRegistry.executeTool('test_write_tool', args(), context('s4'));

    // The duplicate must not reach the handler (it would author the whole test
    // twice) and must not read as "needs approval" — that reply was the LAST
    // tool result the model saw, so it reported the run as never having
    // happened right after it succeeded.
    expect(seenConfirm).toEqual([false, true]);
    expect(dup.message).toMatch(/already approved and executed/i);
    expect(dup.message).not.toMatch(/requires confirmation/i);
  });

  it('still records a preview when the model sends confirm=false explicitly', async () => {
    await SkillRegistry.executeTool('test_write_tool', { confirm: false }, context('s5'));
    await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('s5'));

    expect(seenConfirm).toEqual([false, true]);
  });

  it('does not swallow a DIFFERENT request made soon after an approved one', async () => {
    // "author a login test" → approved → runs.
    await SkillRegistry.executeTool('test_write_tool', { goal: 'login', confirm: true }, context('s6'));
    await SkillRegistry.executeTool('test_write_tool', { goal: 'login', confirm: true }, context('s6'));
    expect(seenConfirm).toEqual([false, true]);

    // "now author a checkout test", seconds later. Same tool, same session,
    // inside the duplicate window — but a genuinely new request. It must be
    // gated normally, NOT answered "already executed" and dropped.
    const next = await SkillRegistry.executeTool(
      'test_write_tool',
      { goal: 'checkout', confirm: true },
      context('s6'),
    );
    expect(next.message).not.toMatch(/already approved and executed/i);
    expect(seenConfirm).toEqual([false, true, false]);

    // ...and it can then be approved on its own.
    await SkillRegistry.executeTool('test_write_tool', { goal: 'checkout', confirm: true }, context('s6'));
    expect(seenConfirm).toEqual([false, true, false, true]);
  });

  it('keeps previews separate per chat session', async () => {
    await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('a'));
    // A different session must not inherit session "a"'s preview.
    await SkillRegistry.executeTool('test_write_tool', { confirm: true }, context('b'));

    expect(seenConfirm).toEqual([false, false]);
  });
});
