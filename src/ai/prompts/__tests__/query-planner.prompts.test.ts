import { buildQueryPlanMessages, QUERY_PLANNER_SYSTEM_PROMPT } from '../query-planner.prompts';

describe('QUERY_PLANNER_SYSTEM_PROMPT', () => {
  it('asks for the three plan fields as JSON', () => {
    for (const k of ['searchTerms', 'entities', 'hypotheses']) {
      expect(QUERY_PLANNER_SYSTEM_PROMPT).toContain(k);
    }
  });

  it('carries the anti-hallucination "do not invent" instruction', () => {
    expect(QUERY_PLANNER_SYSTEM_PROMPT.toLowerCase()).toContain('do not invent');
    expect(QUERY_PLANNER_SYSTEM_PROMPT.toLowerCase()).toContain('do not pad');
  });
});

describe('buildQueryPlanMessages', () => {
  it('includes the ticket summary + description in the user message', () => {
    const { user } = buildQueryPlanMessages({ summary: 'Payment broken', description: 'on checkout' });
    expect(user).toContain('Payment broken');
    expect(user).toContain('on checkout');
  });

  it('renders "(none)" when there is no description', () => {
    const { user } = buildQueryPlanMessages({ summary: 'x' });
    expect(user).toContain('(none)');
  });
});
