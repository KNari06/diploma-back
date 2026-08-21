/**
 * The formatted page snapshot is the largest LLM-facing string the pipeline
 * produces: it is embedded verbatim in the Planner / Executor / Reviewer
 * prompts and kept in round history. An app that renders a credential back
 * ("Welcome back, <email>") therefore leaks it into every subsequent round's
 * prompt unless `observe_page` redacts at the choke point.
 *
 * These assert the RESOLVED behaviour — a credential present in the page text
 * does not appear in what the blackboard stores — not merely that a redactor
 * was called.
 */

import { CommandExecutor } from '../command-executor';
import { TestBlackboard } from '../blackboard';
import type { LiteSnapshot } from '../../lite-types';
import { SnapshotCollector } from '../../collectors/snapshot-collector';
import { SnapshotRouter } from '@/services/testing/ui/preview/snapshot-router.service';

jest.mock('@/services/testing/ui/preview/snapshot-router.service', () => ({
  SnapshotRouter: { collect: jest.fn() },
}));

const PAGE_TEXT = 'Welcome back, agent@acme.test — signed in as qa_agent';

function makeSnapshot(): LiteSnapshot {
  return {
    url: 'https://x.test/dashboard',
    title: 'Dashboard',
    timestamp: 0,
    elements: [{ ref: 'e1', tag: 'div', role: 'text', name: PAGE_TEXT } as any],
  } as LiteSnapshot;
}

function makeExecutor(credentials?: Record<string, string>) {
  const snapshot = makeSnapshot();
  (SnapshotRouter.collect as jest.Mock).mockResolvedValue(snapshot);
  jest.spyOn(SnapshotCollector, 'format').mockReturnValue(`PAGE STATE\n${PAGE_TEXT}`);

  const page = { url: () => snapshot.url } as any;
  const blackboard = new TestBlackboard('log in', snapshot.url, 'test-1', !!credentials);
  const config = { enableHybridSafety: false, credentials } as any;
  return { exec: new CommandExecutor(page, {} as any, config, blackboard, {}), blackboard };
}

describe('observe_page — credential redaction of the stored snapshot', () => {
  afterEach(() => jest.restoreAllMocks());

  it('strips a configured credential out of the snapshot the agents read', async () => {
    const { exec, blackboard } = makeExecutor({
      email: 'agent@acme.test',
      username: 'qa_agent',
      password: 'hunter2',
    });

    await exec.execute('observe_page', {});

    const stored = blackboard.getCurrentSnapshot() ?? '';
    expect(stored).not.toContain('agent@acme.test');
    expect(stored).not.toContain('qa_agent');
    expect(stored).toContain('PAGE STATE'); // the rest of the snapshot survives
  });

  it('strips it from the command OUTPUT too — that string is the tool result', async () => {
    // The blackboard is not the only consumer: observe_page returns the same
    // formatted snapshot as its `output`, which goes back to the model as the
    // tool result and into the JSONL trace. Redacting only the blackboard copy
    // would leave the leak intact on the shorter path.
    const { exec } = makeExecutor({ email: 'agent@acme.test', username: 'qa_agent' });

    const res = await exec.execute('observe_page', {});

    expect(res.success).toBe(true);
    expect(res.output).not.toContain('agent@acme.test');
    expect(res.output).not.toContain('qa_agent');
    expect(res.output).toContain('PAGE STATE');
  });

  it('leaves the snapshot untouched when no credentials are configured (exploration is unaffected)', async () => {
    const { exec, blackboard } = makeExecutor(undefined);

    await exec.execute('observe_page', {});

    expect(blackboard.getCurrentSnapshot()).toBe(`PAGE STATE\n${PAGE_TEXT}`);
  });

  it('keeps the credential out of round history, which is stored from the same string', async () => {
    const { exec, blackboard } = makeExecutor({ email: 'agent@acme.test' });

    await exec.execute('observe_page', {});
    // executor-agent captures `getCurrentSnapshot()` as the round's
    // `pageSnapshotBefore`; redacting at the choke point is what covers it.
    expect(blackboard.getCurrentSnapshot()).not.toContain('agent@acme.test');
  });
});
