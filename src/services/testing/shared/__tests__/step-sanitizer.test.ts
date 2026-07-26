import { sanitizeSteps, slugify, SECRET_OPTION_FIELDS } from '../step-sanitizer';

const PLACEHOLDER = /^\{\{param_.+\}\}$/;

// Loose step type so mixed-shape test arrays don't narrow to a per-object union.
type S = {
  id?: string;
  type?: string;
  description?: string;
  value?: string;
  assertionText?: string;
  bindingHints?: Record<string, unknown>;
  options?: Record<string, unknown>;
};
const mk = (s: S): S => s;

describe('sanitizeSteps (shared web + mobile)', () => {
  it('parameterises a sensitive value detected from the description', () => {
    const step = { id: 'a', type: 'type', description: 'Type the password', value: 'qwerty123' };
    const { steps, parametersSchema } = sanitizeSteps([step]);
    expect(steps[0].value).toMatch(PLACEHOLDER);
    expect(steps[0].value).not.toContain('qwerty123');
    const key = Object.keys(parametersSchema)[0];
    expect(parametersSchema[key]).toMatchObject({ sensitive: true, required: true });
  });

  it('leaves a benign value untouched (no schema entry)', () => {
    const step = { id: 'a', type: 'type', description: 'Type the username', value: 'alice' };
    const { steps, parametersSchema } = sanitizeSteps([step]);
    expect(steps[0].value).toBe('alice');
    expect(Object.keys(parametersSchema)).toHaveLength(0);
  });

  it('does not inspect the value itself (no false positive on "monkey"/"key")', () => {
    const step = { id: 'a', type: 'type', description: 'Type your nickname', value: 'monkey99' };
    const { steps } = sanitizeSteps([step]);
    expect(steps[0].value).toBe('monkey99');
  });

  it('detects sensitivity from bindingHints when description is empty (web selectors/labels)', () => {
    const step = { id: 'a', type: 'type', description: '', value: 's3cret', bindingHints: { label: 'API Token' } };
    const { steps } = sanitizeSteps([step]);
    expect(steps[0].value).toMatch(PLACEHOLDER);
  });

  it('is idempotent on the value but RE-REGISTERS a param_* placeholder into the schema', () => {
    // A value pre-sanitized before the save boundary (e.g. the web draft path)
    // must still contribute to the persisted parameters_schema — the schema is
    // derived here, so skipping it would persist null and the placeholder would
    // never resolve on replay. Value itself is left untouched.
    const step = { id: 'a', type: 'type', description: 'password', value: '{{param_password}}' };
    const { steps, parametersSchema } = sanitizeSteps([step]);
    expect(steps[0].value).toBe('{{param_password}}');
    expect(Object.keys(parametersSchema)).toEqual(['param_password']);
  });

  it('does NOT register non-parameter placeholders ({{secrets.*}} etc.)', () => {
    const step = { id: 'a', type: 'type', description: 'password', value: '{{secrets.PW}}' };
    const { steps, parametersSchema } = sanitizeSteps([step]);
    expect(steps[0].value).toBe('{{secrets.PW}}');
    expect(Object.keys(parametersSchema)).toHaveLength(0);
  });

  it('masks a secret quoted in assertionText but not a benign one', () => {
    const secret = mk({ id: 'a', type: 'ai_check', description: 'check', assertionText: 'shows API token sk_live_x' });
    const benign = mk({ id: 'b', type: 'type', description: 'Type password', value: 'p', assertionText: 'Home is visible' });
    const { steps } = sanitizeSteps([secret, benign]);
    expect(steps[0].assertionText).toBe('{{param_secret}}');
    expect(steps[1].assertionText).toBe('Home is visible'); // benign assertion preserved
    expect(steps[1].value).toMatch(PLACEHOLDER); // its sensitive value still parameterised
  });

  it('masks always-secret option fields unconditionally', () => {
    const step = { id: 'a', type: 'otp', description: 'auth', options: { otpAction: 'generate_totp', totpSecret: 'JBSWY3DPEHPK3PXP' } };
    const { steps } = sanitizeSteps([step]);
    const opts = steps[0].options as Record<string, unknown>;
    expect(opts.totpSecret).toBe('{{param_secret}}');
    expect(opts.otpAction).toBe('generate_totp');
  });

  it('preserves step shape + order for non-sensitive steps (identity)', () => {
    const a = mk({ id: 'a', type: 'click', description: 'Tap login' });
    const b = mk({ id: 'b', type: 'navigate', description: 'Go home' });
    const { steps } = sanitizeSteps([a, b]);
    expect(steps[0]).toBe(a);
    expect(steps[1]).toBe(b);
  });

  it('disambiguates colliding param names', () => {
    const { parametersSchema } = sanitizeSteps([
      { id: 'a', type: 'type', description: 'password', value: 'x' },
      { id: 'b', type: 'type', description: 'password', value: 'y' },
    ]);
    expect(Object.keys(parametersSchema).sort()).toEqual(['param_password', 'param_password_2']);
  });

  // ── Templated-against-a-stored-secret strings (credential-store binding) ──
  // These are already safe; re-parameterising them to {{param_*}} destroys the
  // binding and the step resolves to nothing at replay (a false RED).
  describe('values/assertions templated with {{secrets.*}}', () => {
    it('leaves an embedded secret placeholder in assertionText alone even when the KEY NAME looks sensitive', () => {
      const step = mk({
        id: 'a',
        type: 'ai_check',
        description: 'Check the greeting',
        assertionText: 'Welcome back, {{secrets.login_password}}',
      });
      const { steps } = sanitizeSteps([step]);
      expect(steps[0].assertionText).toBe('Welcome back, {{secrets.login_password}}');
    });

    it('leaves an embedded secret placeholder in an assert value alone despite a sensitive description', () => {
      const step = mk({
        id: 'a',
        type: 'assert',
        description: 'Assert the credential greeting is shown',
        value: 'Welcome back, {{secrets.login_email}}',
      });
      const { steps, parametersSchema } = sanitizeSteps([step]);
      expect(steps[0].value).toBe('Welcome back, {{secrets.login_email}}');
      expect(parametersSchema).toEqual({});
    });

    it('still parameterises a sensitive value that is NOT bound to a secret', () => {
      const step = mk({ id: 'a', type: 'type', description: 'Type the password', value: 'hunter2' });
      const { steps } = sanitizeSteps([step]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
    });

    it('still masks an assertionText that quotes a secret with no placeholder', () => {
      const step = mk({ id: 'a', type: 'ai_check', assertionText: 'the password is hunter2' });
      const { steps } = sanitizeSteps([step]);
      expect(steps[0].assertionText).toBe('{{param_secret}}');
    });
  });

  it('exports the secret option fields + slugify helper', () => {
    expect(SECRET_OPTION_FIELDS).toContain('totpSecret');
    expect(slugify('Type the Password!', 32)).toBe('type_the_password');
  });
});
