import { handleCreateTestCase } from '../qa-tool-handlers';
import type { SkillContext } from '../../types';

/**
 * In a per-test-case editor chat, "save" must land on the test case the user
 * has open. The executor prompt says so explicitly — and the model ignored it:
 * a live session on test case 7ee865c6 answered "save" with two
 * `qa_create_test_case` calls under invented names. A prompt rule the model can
 * ignore is not an enforcement point, so the tool itself refuses.
 *
 * The guard sits above every other check in the handler, so these cases return
 * before any DB access.
 */
const tcContext = (over: Partial<SkillContext> = {}): SkillContext => ({
  userId: 'u1',
  workspaceId: 'w1',
  chatSessionId: 's1',
  projectId: 'p1',
  storeKind: 'testcase',
  testCaseId: 'tc1',
  ...over,
});

const args = { project_id: 'p1', name: 'Login flow', confirm: true };

describe('qa_create_test_case — test-case scope guard', () => {
  it('refuses to create a duplicate while a test case is open', async () => {
    const result = await handleCreateTestCase({ ...args }, tcContext());

    expect(result.success).toBe(false);
    expect(result.message).toContain('qa_update_test_case_steps');
    expect(result.message).toContain('tc1');
  });

  it('does not surface the refusal to the user — it is a redirect for the model', async () => {
    const result = await handleCreateTestCase({ ...args }, tcContext());
    expect(result.displayToUser).toBe(false);
  });

  it('is not a confirmation refusal, so no "yes" can replay it', async () => {
    const result = await handleCreateTestCase({ ...args }, tcContext());
    expect(result.needsConfirmation).toBeUndefined();
  });

  it('fires before the confirm gate, so the user is never asked to approve a blocked write', async () => {
    const result = await handleCreateTestCase({ ...args, confirm: false }, tcContext());
    expect(result.message).toContain('qa_update_test_case_steps');
    expect(result.message).not.toContain('WRITE operation requires confirmation');
  });

  it('lets an explicit "make another test" through to the normal validation path', async () => {
    const result = await handleCreateTestCase(
      { ...args, new_separate_test: true },
      tcContext(),
    );
    // Falls through the guard; stops at the next check (no steps supplied).
    expect(result.message).not.toContain('qa_update_test_case_steps');
    expect(result.message).toContain('steps');
  });

  it('does not apply in global chat, where creating IS the point', async () => {
    const result = await handleCreateTestCase(
      { ...args },
      { userId: 'u1', workspaceId: 'w1', chatSessionId: 's1', projectId: 'p1', storeKind: 'global' },
    );
    expect(result.message).not.toContain('qa_update_test_case_steps');
  });
});
