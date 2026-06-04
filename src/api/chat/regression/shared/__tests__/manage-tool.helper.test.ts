import {
  buildPreviewMessage,
  buildSkillContext,
  isConfirmRequired,
  resolveConfirmation,
} from '../manage-tool.helper';

describe('resolveConfirmation', () => {
  it('honors an explicit structured confirm flag from the frontend', () => {
    expect(resolveConfirmation({ answers: { confirm: true } })).toBe(true);
    expect(resolveConfirmation({ answers: { confirm: false }, message: 'yes' })).toBe(false);
  });

  it('treats affirmative free-text as confirmation (EN + RU)', () => {
    for (const m of ['yes', 'OK', 'go ahead', 'proceed', 'да', 'давай', 'подтверждаю']) {
      expect(resolveConfirmation({ message: m })).toBe(true);
    }
  });

  it('does not confirm on ambiguous or negative text', () => {
    for (const m of ['', 'maybe', 'what will it do?', 'no', 'нет', 'wait']) {
      expect(resolveConfirmation({ message: m })).toBe(false);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveConfirmation({ message: '  Confirm  ' })).toBe(true);
  });
});

describe('buildSkillContext', () => {
  it('maps handler params to a SkillContext', () => {
    const ctx = buildSkillContext({
      userId: 'u1',
      workspace_id: 'w1',
      chatSessionId: 's1',
      context: { projectId: 'p1', mode: 'lite' },
    });
    expect(ctx).toEqual({
      userId: 'u1',
      workspaceId: 'w1',
      chatSessionId: 's1',
      projectId: 'p1',
      mode: 'lite',
    });
  });

  it('tolerates a missing context object', () => {
    const ctx = buildSkillContext({ userId: 'u1', workspace_id: 'w1' });
    expect(ctx.userId).toBe('u1');
    expect(ctx.workspaceId).toBe('w1');
    expect(ctx.projectId).toBeUndefined();
  });
});

describe('isConfirmRequired', () => {
  it('detects the tool\'s confirm-required preview signal', () => {
    expect(isConfirmRequired({
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe...',
    })).toBe(true);
    // also matches the shorter variant used by some tools
    expect(isConfirmRequired({
      success: false,
      message: 'WRITE operation requires confirmation. Describe the exact changes...',
    })).toBe(true);
  });

  it('is false for a real success or a different failure', () => {
    expect(isConfirmRequired({ success: true, message: 'Created schedule' })).toBe(false);
    expect(isConfirmRequired({ success: false, message: 'Missing required field: name' })).toBe(false);
  });
});

describe('buildPreviewMessage', () => {
  it('embeds the human description and asks for confirmation', () => {
    const msg = buildPreviewMessage('create schedule "Nightly" at 0 9 * * *');
    expect(msg).toContain('create schedule "Nightly" at 0 9 * * *');
    expect(msg.toLowerCase()).toContain('yes');
    // never leaks the LLM-targeted instruction
    expect(msg).not.toContain('You MUST');
  });

  it('falls back to a generic prompt without a description', () => {
    const msg = buildPreviewMessage();
    expect(msg.toLowerCase()).toContain('go ahead');
    expect(msg).not.toContain('You MUST');
  });
});
