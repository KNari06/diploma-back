import { buildFixPromptMessages } from '../fix-prompt.prompts';

describe('buildFixPromptMessages', () => {
  it('system prompt enforces black-box (no source access, no invented paths)', () => {
    const { system } = buildFixPromptMessages({ bugTitle: 'x', bugDescription: '', severity: 'high' });
    expect(system.toLowerCase()).toContain('no access to the application');
    expect(system.toLowerCase()).toContain('do not invent file paths');
    expect(system.toLowerCase()).toContain('markdown');
  });

  it('user message folds in the provided evidence', () => {
    const { user } = buildFixPromptMessages({
      bugTitle: 'Checkout 500',
      bugDescription: 'server error',
      severity: 'high',
      pageUrl: 'https://app.example.com/checkout',
      failingSelector: '#submit',
      expectedResult: 'order placed',
      actualResult: '500',
      reproSteps: ['open', 'submit'],
      consoleErrors: ['TypeError'],
      networkErrors: ['POST /api/checkout → 500'],
    });
    expect(user).toContain('Checkout 500');
    expect(user).toContain('#submit');
    expect(user).toContain('order placed');
    expect(user).toContain('POST /api/checkout → 500');
    expect(user).toContain('1. open');
  });

  it('omits sections with no data', () => {
    const { user } = buildFixPromptMessages({ bugTitle: 'x', bugDescription: '', severity: 'low' });
    expect(user).not.toContain('Failing element selector');
    expect(user).not.toContain('Network failures');
  });
});
