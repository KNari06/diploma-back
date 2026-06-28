/**
 * Tests for the intent fast-path — the deterministic pre-LLM classifier.
 *
 * Its danger is over-matching: if it fast-paths a message that isn't truly
 * unambiguous, a genuine new request gets misrouted as chitchat/approval and
 * silently never runs. So the invariants under test are: EXACT match only
 * (after trim+lowercase) — no prefix/substring, a length guard, the
 * disabled-switch, and the rule that bare yes/no fast-paths ONLY when chat
 * history shows a pending confirmation.
 *
 * The keyword registry is mocked to give deterministic sets (it has its own
 * contract test per Hard invariant #17); env + logger mocked.
 */

import { tryIntentFastPath, logFastPathHit } from '../intent-fast-path';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import type { IntentParserContext } from '@/ai/prompts/index';

jest.mock('@/config/environment/env', () => ({ env: { INTENT_FAST_PATH_DISABLED: false } }));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/config/testing/intent-keywords', () => ({
  CHITCHAT: 'CHITCHAT',
  CANCEL: 'CANCEL',
  AFFIRMATIVE: 'AFFIRMATIVE',
  REJECTION: 'REJECTION',
  CONFIRMATION_MARKERS: 'CM',
  toLangSet: (k: string) =>
    (
      ({
        CHITCHAT: new Set(['hi', 'hello', 'thanks']),
        CANCEL: new Set(['cancel', 'stop']),
        AFFIRMATIVE: new Set(['yes', 'yep']),
        REJECTION: new Set(['no', 'nope']),
      }) as Record<string, Set<string>>
    )[k],
  flattenLangs: (k: string) => (k === 'CM' ? ['shall i run', 'do you want me to'] : []),
}));

const history = (turns: { role: string; content: string }[]) =>
  ({ chatHistory: turns } as unknown as IntentParserContext);

beforeEach(() => {
  jest.clearAllMocks();
  (env as { INTENT_FAST_PATH_DISABLED: boolean }).INTENT_FAST_PATH_DISABLED = false;
});

describe('chitchat / cancel branches', () => {
  it('fast-paths exact chitchat to general_chat with needsTools=false', () => {
    const hit = tryIntentFastPath('hello');
    expect(hit?.reason).toBe('chitchat');
    expect(hit?.result.intent).toBe('general_chat');
    expect(hit?.result.needsTools).toBe(false);
    expect(hit?.result.intent_confidence).toBeLessThan(0.9);
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(tryIntentFastPath('  Hello  ')?.reason).toBe('chitchat');
    expect(tryIntentFastPath('THANKS')?.reason).toBe('chitchat');
  });

  it('preserves the original (untrimmed) message in rawText', () => {
    expect(tryIntentFastPath('  Hello  ')?.result.rawText).toBe('  Hello  ');
  });

  it('fast-paths cancel/stop to general_chat', () => {
    expect(tryIntentFastPath('cancel')?.reason).toBe('cancel');
    expect(tryIntentFastPath('stop')?.result.intent).toBe('general_chat');
  });
});

describe('EXACT-match-only invariant', () => {
  it('does NOT match a prefix / substring of a whitelisted word', () => {
    expect(tryIntentFastPath('yes, also test /users')).toBeNull();
    expect(tryIntentFastPath('hello there, run my tests')).toBeNull();
    expect(tryIntentFastPath('stop the regression for project X')).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(tryIntentFastPath('')).toBeNull();
    expect(tryIntentFastPath('   ')).toBeNull();
  });

  it('returns null for an over-long message (>40 chars) even if it starts with a keyword', () => {
    expect(tryIntentFastPath('yes ' + 'x'.repeat(50))).toBeNull();
  });

  it('returns null for a non-whitelisted message (LLM path)', () => {
    expect(tryIntentFastPath('run the smoke suite')).toBeNull();
  });
});

describe('yes/no gating on pending confirmation', () => {
  it('does NOT fast-path bare yes/no without any context', () => {
    expect(tryIntentFastPath('yes')).toBeNull();
    expect(tryIntentFastPath('no')).toBeNull();
  });

  it('does NOT fast-path yes when the last assistant turn is not a question', () => {
    const ctx = history([{ role: 'ai', content: 'Here are your results.' }]);
    expect(tryIntentFastPath('yes', ctx)).toBeNull();
  });

  it('fast-paths yes when the last assistant turn ends with a question mark', () => {
    const ctx = history([
      { role: 'user', content: 'run it' },
      { role: 'ai', content: 'Shall I run the regression plan?' },
    ]);
    const hit = tryIntentFastPath('yes', ctx);
    expect(hit?.reason).toBe('approval');
    expect(hit?.result.needsTools).toBe(true); // may trigger saved-plan action
  });

  it('fast-paths no (rejection) when a confirmation is pending', () => {
    const ctx = history([{ role: 'ai', content: 'Do you want me to save this test?' }]);
    expect(tryIntentFastPath('no', ctx)?.reason).toBe('rejection');
  });

  it('detects a pending confirmation via a marker phrase (no question mark)', () => {
    const ctx = history([{ role: 'ai', content: 'shall i run this now' }]);
    expect(tryIntentFastPath('yep', ctx)?.reason).toBe('approval');
  });

  it('only inspects the LAST assistant turn (a stale earlier question does not count)', () => {
    const ctx = history([
      { role: 'ai', content: 'Shall I run it?' },
      { role: 'user', content: 'maybe later' },
      { role: 'ai', content: 'Okay, standing by.' }, // latest assistant — not a question
    ]);
    expect(tryIntentFastPath('yes', ctx)).toBeNull();
  });
});

describe('kill-switch + telemetry', () => {
  it('returns null entirely when INTENT_FAST_PATH_DISABLED is true', () => {
    (env as { INTENT_FAST_PATH_DISABLED: boolean }).INTENT_FAST_PATH_DISABLED = true;
    expect(tryIntentFastPath('hello')).toBeNull();
  });

  it('logFastPathHit logs the reason, intent, and a message preview', () => {
    const hit = tryIntentFastPath('hello')!;
    logFastPathHit(hit, 'hello');
    expect(logger.info).toHaveBeenCalledWith(
      '[INTENT_FAST_PATH] hit',
      expect.objectContaining({ reason: 'chitchat', intent: 'general_chat' }),
    );
  });
});
