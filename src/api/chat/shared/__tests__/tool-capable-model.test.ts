/**
 * The Gemini guard: our shared OpenAI wrapper does not forward tool /
 * response_format params through the Gemini path, so a Gemini-configured `fast`
 * tier must be swapped for an OpenAI model before any tool call.
 *
 * Untested until now, because the rule lived as three byte-identical PRIVATE
 * copies. That mattered: no suite configures a Gemini model, so the branch never
 * ran, and a fallback resolving to `undefined` would have passed everything.
 */

const mockWarn = jest.fn();

jest.mock('@/utils/core/logger', () => ({
  logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

/** Load the helper with AI_MODELS mocked to the given tiers. */
const load = async (fast: string, smart = 'gpt-5.4-mini') => {
  jest.resetModules();
  mockWarn.mockClear();
  jest.doMock('@/config/ai/ai-models.config', () => ({ AI_MODELS: { fast, smart } }));
  const mod = await import('../tool-capable-model');
  return mod.chooseToolCapableModel;
};

describe('chooseToolCapableModel', () => {
  it('keeps an OpenAI fast model as-is, and stays quiet', async () => {
    const choose = await load('gpt-5.4-mini');
    expect(choose('TEST')).toBe('gpt-5.4-mini');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('swaps a Gemini fast model for the smart tier', async () => {
    const choose = await load('gemini-2.5-flash-lite', 'gpt-5.4-mini');
    expect(choose('TEST')).toBe('gpt-5.4-mini');
  });

  it('never returns an empty model id, even if the smart tier is missing', async () => {
    // The real regression risk: `undefined` reaches the OpenAI client AS the
    // model id and fails with an opaque 400. Must degrade to a usable model.
    const choose = await load('gemini-2.5-flash', undefined as unknown as string);
    const picked = choose('TEST');
    expect(picked).toBeTruthy();
    expect(picked).not.toMatch(/^gemini-/);
  });

  it('does not fall back onto ANOTHER Gemini model when smart is Gemini too', async () => {
    const choose = await load('gemini-2.5-flash', 'gemini-2.5-pro');
    expect(choose('TEST')).not.toMatch(/^gemini-/);
  });

  it('follows the CONFIGURED smart model rather than a hardcoded id', async () => {
    const choose = await load('gemini-2.5-flash', 'gpt-6-future');
    expect(choose('TEST')).toBe('gpt-6-future');
  });

  it('warns with the caller tag so the log says which surface degraded', async () => {
    const choose = await load('gemini-2.5-flash');
    choose('MOBILE_PLANNER');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('MOBILE_PLANNER'),
      expect.objectContaining({ configured: 'gemini-2.5-flash' }),
    );
  });

  it('tolerates a non-string configured model instead of throwing', async () => {
    const choose = await load(undefined as unknown as string);
    expect(() => choose('TEST')).not.toThrow();
  });
});
