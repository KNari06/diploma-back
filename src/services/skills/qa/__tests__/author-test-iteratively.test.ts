/**
 * Unit tests for `handleAuthorTestIteratively` — the chat tool that builds a
 * test by executing it live on the preview, then bills per AI round.
 *
 * Mocks at the service boundary (testing rule): the authoring engine, the draft
 * cache, the credit tracker, and the step converter are all stubbed. We assert
 * the handler's OWN business logic:
 *   • confirm-gate (no write without confirm=true)
 *   • required-field + preview-session validation
 *   • credits charged by AI rounds — never over/under, never on failure
 *   • grounded steps cached for the later "save"
 *   • engine errors surfaced cleanly
 */

const mockAuthorTest = jest.fn();
const mockDeductCredits = jest.fn();
const mockCacheSet = jest.fn();
const mockToIntentSteps = jest.fn();

jest.mock('@/services/testing/ui/preview/editor-iterative-author.service', () => ({
  EditorIterativeAuthorService: { authorTest: (...a: unknown[]) => mockAuthorTest(...a) },
}));
jest.mock('@/services/testing/ui/preview/draft-steps-cache', () => ({
  DraftStepsCache: { set: (...a: unknown[]) => mockCacheSet(...a) },
}));
jest.mock('@/services/core/credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductCreditsForTest: (...a: unknown[]) => mockDeductCredits(...a) },
}));
jest.mock('@/agent/core/lite/exploration/types', () => ({
  toIntentSteps: (...a: unknown[]) => mockToIntentSteps(...a),
}));

import { handleAuthorTestIteratively } from '../qa-tool-handlers';
import type { SkillContext } from '../../types';

const ctx = (over: Partial<SkillContext> = {}): SkillContext => ({
  userId: 'user-1',
  chatSessionId: 'chat-1',
  previewSessionId: 'preview_abc',
  mode: 'editor',
  ...over,
} as SkillContext);

/** Default engine result: a successful 3-round authoring run. */
function authoringResult(over: Record<string, unknown> = {}) {
  return {
    success: true,
    steps: [{ action: 'click', description: 'Click login' }],
    startUrl: 'https://x.test/login',
    endUrl: 'https://x.test/home',
    roundsExecuted: 3,
    durationMs: 4200,
    reason: 'Goal achieved',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockToIntentSteps.mockImplementation((steps: unknown[]) =>
    steps.map((_, i) => ({ id: `step-${i + 1}`, type: 'click', description: 'x' })),
  );
  mockDeductCredits.mockResolvedValue({ success: true, newBalance: 100 });
});

describe('confirm gate', () => {
  it('does NOT run authoring or charge when confirm is missing', async () => {
    const res = await handleAuthorTestIteratively({ goal: 'test login' }, ctx());
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/requires confirmation/i);
    expect(mockAuthorTest).not.toHaveBeenCalled();
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it('does NOT run authoring when confirm is false', async () => {
    await handleAuthorTestIteratively({ goal: 'test login', confirm: false }, ctx());
    expect(mockAuthorTest).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('rejects a missing/blank goal even with confirm=true', async () => {
    const res = await handleAuthorTestIteratively({ goal: '   ', confirm: true }, ctx());
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/goal/i);
    expect(mockAuthorTest).not.toHaveBeenCalled();
  });

  it('requires an active preview session', async () => {
    const res = await handleAuthorTestIteratively(
      { goal: 'test login', confirm: true },
      ctx({ previewSessionId: undefined }),
    );
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/preview session/i);
    expect(mockAuthorTest).not.toHaveBeenCalled();
  });
});

describe('happy path', () => {
  it('runs authoring, caches grounded steps, and reports success', async () => {
    mockAuthorTest.mockResolvedValue(authoringResult());
    const res = await handleAuthorTestIteratively(
      { goal: 'test login', suggested_name: 'Login Flow', confirm: true },
      ctx(),
    );

    expect(mockAuthorTest).toHaveBeenCalledWith(
      expect.objectContaining({ previewSessionId: 'preview_abc', userId: 'user-1', goal: 'test login' }),
    );
    expect(res.success).toBe(true);
    // grounded steps cached for the later save, with the suggested name.
    expect(mockCacheSet).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ startUrl: 'https://x.test/login', suggestedName: 'Login Flow' }),
    );
  });

  it('trims the goal before passing it to the engine', async () => {
    mockAuthorTest.mockResolvedValue(authoringResult());
    await handleAuthorTestIteratively({ goal: '  test login  ', confirm: true }, ctx());
    expect(mockAuthorTest).toHaveBeenCalledWith(expect.objectContaining({ goal: 'test login' }));
  });
});

describe('credit billing — never over/under-charge', () => {
  it('charges roundsExecuted-1 extra (base 1 is the chat turn) on success', async () => {
    mockAuthorTest.mockResolvedValue(authoringResult({ roundsExecuted: 3 }));
    await handleAuthorTestIteratively({ goal: 'g', confirm: true }, ctx());
    expect(mockDeductCredits).toHaveBeenCalledTimes(1);
    expect(mockDeductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', testType: 'chat', credits: 2, testId: 'preview_abc' }),
    );
  });

  it('charges NOTHING extra for a single-round run (base covers it)', async () => {
    mockAuthorTest.mockResolvedValue(authoringResult({ roundsExecuted: 1 }));
    await handleAuthorTestIteratively({ goal: 'g', confirm: true }, ctx());
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it('charges NOTHING when authoring did not succeed', async () => {
    mockAuthorTest.mockResolvedValue(authoringResult({ success: false, reason: 'blocked: CAPTCHA' }));
    const res = await handleAuthorTestIteratively({ goal: 'g', confirm: true }, ctx());
    expect(mockDeductCredits).not.toHaveBeenCalled();
    // still surfaces the run + reason to the user.
    expect(res.message).toMatch(/blocked: CAPTCHA/);
  });

  it('does not fail the (already-passed) run if credit deduction throws', async () => {
    mockAuthorTest.mockResolvedValue(authoringResult({ roundsExecuted: 4 }));
    mockDeductCredits.mockRejectedValue(new Error('billing down'));
    const res = await handleAuthorTestIteratively({ goal: 'g', confirm: true }, ctx());
    expect(res.success).toBe(true); // steps are real + cached; billing is best-effort
  });
});

describe('engine error handling', () => {
  it('surfaces an engine error (no session / busy) without caching or charging', async () => {
    mockAuthorTest.mockResolvedValue({
      success: false, steps: [], startUrl: '', endUrl: '', roundsExecuted: 0,
      durationMs: 0, reason: 'busy', error: 'A run is already in progress on this preview session.',
    });
    const res = await handleAuthorTestIteratively({ goal: 'g', confirm: true }, ctx());
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/run is already in progress/i);
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });
});
