import { interpolateCommandPlaceholders } from '../interpolate-command';
import { mapSource } from '../resolve-placeholders';

/**
 * Regression guard for the replay-side assertion gap.
 *
 * The credential-store work froze `{{secrets.*}}` into authored steps. Replay
 * substituted `value` / `url` / top-level `assertionText` — but an
 * intent-converted command carries its assertion in `intentMeta.assertionText`
 * (ai_check) or `assertion.expected` (deterministic assert), neither of which
 * was touched. The literal placeholder then reached the comparison and
 * false-RED'd a passing login test. These tests assert the RESOLVED behaviour,
 * not the shape of the code.
 */
describe('interpolateCommandPlaceholders', () => {
  const sources = () => [
    mapSource(
      'runVariables',
      new Map<string, unknown>([
        ['secrets.login_email', 'demo@qait.dev'],
        ['secrets.login_password', 'password'],
      ]),
    ),
  ];

  it('resolves a secret placeholder in intentMeta.assertionText (the ai_check channel)', () => {
    const cmd: any = {
      action: 'aiCheck',
      intentMeta: { assertionText: 'Welcome back, {{secrets.login_email}}' },
    };

    interpolateCommandPlaceholders(cmd, sources());

    expect(cmd.intentMeta.assertionText).toBe('Welcome back, demo@qait.dev');
  });

  it('resolves a secret placeholder in assertion.expected (the deterministic assert channel)', () => {
    const cmd: any = {
      action: 'assert',
      assertion: { type: 'text', expected: 'Welcome back, {{secrets.login_email}}', operator: 'contains' },
    };

    interpolateCommandPlaceholders(cmd, sources());

    expect(cmd.assertion.expected).toBe('Welcome back, demo@qait.dev');
  });

  it('still resolves the fields replay already handled', () => {
    const cmd: any = {
      action: 'fill',
      value: '{{secrets.login_password}}',
      url: 'https://app.test/u/{{secrets.login_email}}',
      assertionText: 'hi {{secrets.login_email}}',
      intentMeta: { value: '{{secrets.login_password}}' },
    };

    interpolateCommandPlaceholders(cmd, sources());

    expect(cmd.value).toBe('password');
    expect(cmd.url).toBe('https://app.test/u/demo@qait.dev');
    expect(cmd.assertionText).toBe('hi demo@qait.dev');
    expect(cmd.intentMeta.value).toBe('password');
  });

  it('leaves selectors and other fields untouched', () => {
    const cmd: any = {
      action: 'click',
      selector: '[data-testid="{{secrets.login_email}}"]',
      elementDescription: 'the {{secrets.login_email}} button',
      assertion: { type: 'visible' },
    };

    interpolateCommandPlaceholders(cmd, sources());

    expect(cmd.selector).toBe('[data-testid="{{secrets.login_email}}"]');
    expect(cmd.elementDescription).toBe('the {{secrets.login_email}} button');
  });

  it('is a no-op on commands with no interpolatable fields', () => {
    const cmd: any = { action: 'assert', assertion: { type: 'visible' }, intentMeta: {} };

    expect(() => interpolateCommandPlaceholders(cmd, sources())).not.toThrow();
    expect(cmd.assertion.type).toBe('visible');
  });

  it('leaves an unknown placeholder namespace as a literal', () => {
    const cmd: any = { intentMeta: { assertionText: 'order {{_secret_step1}} done' } };

    interpolateCommandPlaceholders(cmd, sources());

    expect(cmd.intentMeta.assertionText).toBe('order {{_secret_step1}} done');
  });
});
