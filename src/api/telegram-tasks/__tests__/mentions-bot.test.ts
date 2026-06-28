import { mentionsBot } from '../telegram-webhook.controller';

describe('mentionsBot', () => {
  it('matches an exact @mention of the bot', () => {
    expect(mentionsBot('@qait_task what is open?', 'qait_task')).toBe(true);
  });

  it('is case-insensitive and tolerates a leading @ in the configured name', () => {
    expect(mentionsBot('hey @QAIT_Task status?', '@qait_task')).toBe(true);
  });

  it('does NOT match a longer username with the bot name as a prefix', () => {
    // word-boundary guard: @qait_tasker must not trigger @qait_task
    expect(mentionsBot('ping @qait_tasker please', 'qait_task')).toBe(false);
  });

  it('does not match when the bot is not mentioned', () => {
    expect(mentionsBot('done, merged the fix', 'qait_task')).toBe(false);
  });

  it('returns false when no bot username is configured', () => {
    expect(mentionsBot('@qait_task hi', undefined)).toBe(false);
  });
});
