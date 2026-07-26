import { templateCredentialsInSteps } from '../credential-step-templater';
import type { DiscoveredStep } from '@/agent/core/lite/exploration/types';

const mk = (over: Partial<DiscoveredStep>): DiscoveredStep => ({
  stepNumber: 1,
  description: 'a step',
  action: 'click',
  pageUrl: 'https://app.test/dashboard',
  ...over,
} as DiscoveredStep);

const map = (entries: Array<[string, string]>) => new Map(entries);

const CREDS = map([
  ['demo@qait.dev', 'login_email'],
  ['s3cretpassword', 'login_password'],
]);

describe('templateCredentialsInSteps', () => {
  it('templates a credential the app rendered back into an assert value', () => {
    const steps = [mk({ action: 'verify', value: 'Welcome back, demo@qait.dev!' })];

    const [out] = templateCredentialsInSteps(steps, CREDS);

    expect(out.value).toBe('Welcome back, {{secrets.login_email}}!');
  });

  it('templates expectedOutcome (the ai_check assertionText channel) and description', () => {
    const steps = [mk({
      expectedOutcome: 'The page greets demo@qait.dev',
      description: 'Verify demo@qait.dev is shown',
    })];

    const [out] = templateCredentialsInSteps(steps, CREDS);

    expect(out.expectedOutcome).toBe('The page greets {{secrets.login_email}}');
    expect(out.description).toBe('Verify {{secrets.login_email}} is shown');
  });

  it('DROPS credential-quoting locator strategies instead of templating them', () => {
    // Locators are matched literally against the live DOM and are never
    // interpolated (Hard invariant #9 excludes selectors), so a templated
    // strategy is permanently unmatchable — the compiled fast path would miss
    // every time and the step would false-RED. Dropping it lets resolution fall
    // through to the structural strategies that don't quote the credential.
    const steps = [mk({
      action: 'verify',
      compiled: {
        locatorPlan: [
          { strategy: 'role', value: 'Welcome back, demo@qait.dev!', roleName: 'heading', confidence: 0.9 },
          { strategy: 'testId', value: 'welcome-message', confidence: 0.8 },
        ],
        action: { type: 'assert', value: 'Welcome back, demo@qait.dev!' },
        context: { pageUrl: 'https://app.test/dashboard', compiledAt: '2026-07-25T00:00:00Z' },
        targetFingerprint: {
          tag: 'h1',
          role: 'heading',
          testIdAttr: 'welcome-message',
          text: 'Welcome back, demo@qait.dev!',
          containerTitles: ['demo@qait.dev area', 'Dashboard'],
        },
      },
    } as Partial<DiscoveredStep>)];

    const [out] = templateCredentialsInSteps(steps, CREDS);
    const c = out.compiled as any;

    expect(c.locatorPlan).toHaveLength(1);
    expect(c.locatorPlan[0].strategy).toBe('testId');
    // The action value IS interpolated at replay, so templating is correct here.
    expect(c.action.value).toBe('Welcome back, {{secrets.login_email}}!');
    // Credential-bearing fingerprint channels are removed, structural ones kept.
    expect(c.targetFingerprint.text).toBeUndefined();
    expect(c.targetFingerprint.containerTitles).toEqual(['Dashboard']);
    expect(c.targetFingerprint.tag).toBe('h1');
    expect(c.targetFingerprint.testIdAttr).toBe('welcome-message');
  });

  it('templates the persisted page title, which a dashboard renders the account into', () => {
    const steps = [mk({
      compiled: {
        locatorPlan: [],
        action: { type: 'click' },
        context: { pageUrl: 'https://app.test/dashboard', pageTitle: 'demo@qait.dev — Dashboard', compiledAt: 'x' },
      },
    } as Partial<DiscoveredStep>)];

    const [out] = templateCredentialsInSteps(steps, CREDS);

    expect((out.compiled as any).context.pageTitle).toBe('{{secrets.login_email}} — Dashboard');
  });

  it('replaces the longest value first so a substring credential cannot half-replace', () => {
    const creds = map([['pass', 'short_key'], ['password123', 'login_password']]);
    const steps = [mk({ value: 'typed password123 here' })];

    const [out] = templateCredentialsInSteps(steps, creds);

    expect(out.value).toBe('typed {{secrets.login_password}} here');
  });

  it('does NOT rewrite inside an already-frozen placeholder whose KEY NAME contains the value', () => {
    // Run-proof regression (2026-07-25): the fixture password is the literal
    // word "password", which occurs inside the key name `login_password`. The
    // credential fill was already frozen to {{secrets.login_password}}, and
    // substituting there produced {{secrets.login_{{secrets.login_password}}}}
    // — no longer a bound placeholder, so toIntentSteps masked it to the legacy
    // {{password}} and the SAVED test typed that literal and 401'd. Authoring
    // looked perfect; only the replay caught it.
    const creds = map([['password', 'login_password'], ['demo@qait.dev', 'login_email']]);
    const steps = [mk({ value: '{{secrets.login_password}}', isSensitive: true } as Partial<DiscoveredStep>)];

    const [out] = templateCredentialsInSteps(steps, creds);

    expect(out.value).toBe('{{secrets.login_password}}');
  });

  it('is idempotent — templating already-templated text changes nothing', () => {
    const steps = [mk({ value: 'Welcome back, {{secrets.login_email}}!' })];

    const once = templateCredentialsInSteps(steps, CREDS);
    const twice = templateCredentialsInSteps(once, CREDS);

    expect(twice[0].value).toBe('Welcome back, {{secrets.login_email}}!');
  });

  it('still templates a literal that sits next to an existing placeholder', () => {
    const steps = [mk({ value: '{{secrets.login_password}} for demo@qait.dev' })];

    const [out] = templateCredentialsInSteps(steps, CREDS);

    expect(out.value).toBe('{{secrets.login_password}} for {{secrets.login_email}}');
  });

  it('skips values shorter than the minimum so short secrets cannot shred prose', () => {
    const steps = [mk({ description: 'Click the ok button' })];

    const [out] = templateCredentialsInSteps(steps, map([['ok', 'tiny']]));

    expect(out.description).toBe('Click the ok button');
  });

  it('skips a key that cannot round-trip into a resolvable placeholder', () => {
    const steps = [mk({ value: 'Welcome back, demo@qait.dev!' })];

    const [out] = templateCredentialsInSteps(steps, map([['demo@qait.dev', 'bad key!']]));

    expect(out.value).toBe('Welcome back, demo@qait.dev!');
  });

  it('returns the original step objects when nothing matched', () => {
    const step = mk({ description: 'Click submit' });

    const [out] = templateCredentialsInSteps([step], CREDS);

    expect(out).toBe(step);
  });

  it('is a no-op with an empty map', () => {
    const step = mk({ value: 'Welcome back, demo@qait.dev!' });
    const steps = [step];

    expect(templateCredentialsInSteps(steps, new Map())).toBe(steps);
  });
});
