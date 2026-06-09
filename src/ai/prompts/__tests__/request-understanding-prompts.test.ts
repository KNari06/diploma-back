import {
  buildEnrichPrompt,
  buildUnderstandingExtension,
} from '../request-understanding-prompts';

describe('buildUnderstandingExtension', () => {
  const ext = buildUnderstandingExtension();

  it('documents the four understanding fields', () => {
    expect(ext).toContain('isCompound');
    expect(ext).toContain('targetSelector');
    expect(ext).toContain('executionModifiers');
    expect(ext).toContain('routeHint');
  });

  it('instructs to keep the raw descriptor and not invent ids', () => {
    // normalize whitespace — the instruction wraps across lines in the prompt
    const flat = ext.toLowerCase().replace(/\s+/g, ' ');
    expect(flat).toContain('do not invent an id');
  });

  it('enumerates every selector type the resolver understands', () => {
    for (const t of ['tag', 'module', 'plan', 'flow', 'keyword', 'test_case', 'url', 'element', 'none']) {
      expect(ext).toContain(`"${t}"`);
    }
  });

  it('carries reasoning-style examples (context-first, not keyword-match)', () => {
    expect(ext).toContain('CONTEXT:');
  });

  it('documents runAt for one-time schedules and the cron-XOR-runAt rule', () => {
    expect(ext).toContain('runAt');
    const flat = ext.toLowerCase().replace(/\s+/g, ' ');
    expect(flat).toContain('one-time');
    expect(flat).toContain('cronexpression or runat, never both');
  });

  it('omits the CURRENT TIME anchor when no now-context is given', () => {
    expect(ext).not.toContain('CURRENT TIME:');
  });

  it('injects the CURRENT TIME anchor + timezone when now-context is provided', () => {
    const withNow = buildUnderstandingExtension({
      nowIso: '2026-06-08T12:00:00.000Z',
      timezone: 'Asia/Almaty',
    });
    expect(withNow).toContain('CURRENT TIME: 2026-06-08T12:00:00.000Z');
    expect(withNow).toContain('Asia/Almaty');
  });
});

describe('buildEnrichPrompt', () => {
  const base = {
    message: 'add my payment tests to the plan',
    descriptor: 'payment tests',
    candidates: [
      { id: 'tc_1', name: 'Checkout payment', url: 'https://app/checkout', tags: ['smoke'] },
      { id: 'tc_2', name: 'Refund payment' },
    ],
    session: { lastFailedTestId: 'tc_9', recentTestIds: ['tc_1', 'tc_2'] },
  };

  it('lists candidate ids the model must choose from', () => {
    const p = buildEnrichPrompt(base);
    expect(p).toContain('id=tc_1');
    expect(p).toContain('id=tc_2');
    expect(p).toContain('Checkout payment');
  });

  it('surfaces session context for referential resolution', () => {
    const p = buildEnrichPrompt(base);
    expect(p).toContain('lastFailedTestId: tc_9');
    expect(p).toContain('recentTestIds: tc_1, tc_2');
  });

  it('enforces the at-most-one-question rule', () => {
    const p = buildEnrichPrompt(base).toLowerCase();
    expect(p).toContain('only for the single most important field');
    expect(p).toContain('never ask two questions');
  });

  it('specifies the strict output schema', () => {
    const p = buildEnrichPrompt(base);
    expect(p).toContain('resolvedTargetIds');
    expect(p).toContain('needsClarification');
    expect(p).toContain('clarificationQuestion');
  });

  it('degrades gracefully when there are no candidates or context', () => {
    const p = buildEnrichPrompt({ message: 'run it', candidates: [], session: {} });
    expect(p).toContain('(none)');
    expect(p).toContain('(no session context)');
  });
});
