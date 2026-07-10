import { sanitizeMobileSteps } from '../mobile-step-sanitizer';
import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';

/** Build a mobile step with sensible defaults; override what each test needs. */
function mkStep(partial: Partial<MobileIntentStep>): MobileIntentStep {
  return { id: 'step-1', type: 'type', description: '', ...partial } as MobileIntentStep;
}

const PLACEHOLDER = /^\{\{param_.+\}\}$/;

describe('sanitizeMobileSteps', () => {
  describe('non-sensitive input is preserved', () => {
    it('leaves a step untouched when the context has no sensitive keyword', () => {
      const step = mkStep({ description: 'Type username', value: 'alice' });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0]).toBe(step);
      expect(parametersSchema).toEqual({});
    });

    it('skips steps with a missing or empty value', () => {
      const noValue = mkStep({ description: 'Type password', value: undefined });
      const emptyValue = mkStep({ description: 'Type password', value: '' });
      const { steps, parametersSchema } = sanitizeMobileSteps([noValue, emptyValue]);
      expect(steps[0]).toBe(noValue);
      expect(steps[1]).toBe(emptyValue);
      expect(parametersSchema).toEqual({});
    });

    it('does not inspect the value itself (avoids false positives on "key")', () => {
      // "monkey" contains "key" but the context (description) is benign.
      const step = mkStep({ description: 'Type your nickname', value: 'monkey99' });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toBe('monkey99');
      expect(parametersSchema).toEqual({});
    });

    it('returns the step unchanged when there is no context at all', () => {
      const step = mkStep({ description: '', value: 'something', bindingHints: undefined });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0]).toBe(step);
    });

    it.each([
      ['bare "key" in a press step', 'Press key Enter', 'Enter'],
      ['"keyboard" in the description', 'Dismiss the keyboard hint', 'ok'],
      ['"keyword" in a search step', 'Type search keyword into search box', 'sneakers'],
      ['"Authorize" button label', 'Tap Authorize and confirm', 'confirm'],
      ['OAuth screen mention', 'Type username on the OAuth login screen', 'alice'],
      ['"author" field', 'Type name into author field', 'Tolstoy'],
      ['"pinch" gesture', 'Pinch to zoom on the map', 'out'],
      ['city containing "pin"', 'Type destination into Pinsk field', 'Pinsk'],
    ])('does NOT parameterize a benign step: %s', (_label, description, value) => {
      const { steps, parametersSchema } = sanitizeMobileSteps([mkStep({ description, value })]);
      expect(steps[0].value).toBe(value);
      expect(parametersSchema).toEqual({});
    });
  });

  describe('explicit isSensitive flag is the primary signal', () => {
    it('parameterizes a flagged value even when the description is benign', () => {
      const step = mkStep({
        description: 'Type into the second field',
        value: 'hunter2',
        isSensitive: true,
      });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
      expect(Object.keys(parametersSchema)).toHaveLength(1);
      expect(JSON.stringify(steps)).not.toContain('hunter2');
    });

    it('parameterizes a flagged value even with no context at all', () => {
      const step = mkStep({ id: 'otp-entry', description: '', value: '123456', isSensitive: true });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toBe('{{param_otp_entry}}');
      expect(parametersSchema.param_otp_entry).toBeDefined();
    });

    it('isSensitive=false does not suppress the regex fallback', () => {
      const step = mkStep({
        description: 'Type password into login field',
        value: 'qwerty123',
        isSensitive: false,
      });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
    });
  });

  describe('sensitive values are replaced with placeholders', () => {
    it('redacts a password value detected from the description', () => {
      const step = mkStep({ description: 'Type password into login field', value: 'qwerty123' });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
      const [paramName] = Object.keys(parametersSchema);
      expect(parametersSchema[paramName]).toEqual({
        type: 'string',
        description: 'Value for Type password into login field',
        required: true,
        sensitive: true,
      });
    });

    it('detects sensitivity from bindingHints when the description is empty', () => {
      const step = mkStep({
        description: '',
        value: 'hunter2',
        bindingHints: { label: 'Password' },
      });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
      expect(Object.keys(parametersSchema)).toHaveLength(1);
    });

    it.each([
      ['token', 'Enter the token'],
      ['secret', 'Type the secret'],
      ['api key', 'Provide api_key'],
      ['credential', 'Enter credential'],
      ['pin', 'Enter your PIN'],
      ['otp', 'Type the OTP code'],
      ['auth header', 'Paste the auth header'],
      ['auth code', 'Enter the authentication code'],
      ['passcode', 'Type your passcode'],
      ['passphrase', 'Enter the wallet passphrase'],
      ['passkey', 'Enter your passkey'],
      ['one-time code', 'Type the one-time code from SMS'],
      ['cvv', 'Enter card CVV'],
      ['russian password', 'Введите пароль'],
      ['kazakh password', 'Құпия сөзді енгізіңіз'],
    ])('redacts values flagged by the "%s" pattern', (_label, description) => {
      const { steps } = sanitizeMobileSteps([mkStep({ description, value: 'sensitive' })]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
    });

    it('matches credential compounds but not "author"/"authoring"', () => {
      const authoring = sanitizeMobileSteps([mkStep({ description: 'authoring notes', value: 'v' })]);
      expect(authoring.steps[0].value).toBe('v');
      const author = sanitizeMobileSteps([mkStep({ description: 'author bio', value: 'v' })]);
      expect(author.steps[0].value).toBe('v');
    });

    it('detects sensitivity from the bindingHints input type', () => {
      const step = mkStep({
        description: 'Type into the field',
        value: 's3cret',
        bindingHints: { type: 'password' },
      });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toMatch(PLACEHOLDER);
    });

    it('does not preserve the original secret anywhere in the output', () => {
      const secret = 'SuperSecret!42';
      const result = sanitizeMobileSteps([mkStep({ description: 'Type password', value: secret })]);
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  describe('idempotency', () => {
    it('leaves an already-templated value untouched but registers it in the schema', () => {
      const step = mkStep({ description: 'Type password', value: '{{param_password}}' });
      const { steps, parametersSchema } = sanitizeMobileSteps([step]);
      expect(steps[0]).toBe(step);
      // A pre-sanitised caller must still get a complete parameters_schema
      // persisted at the save boundary.
      expect(parametersSchema.param_password).toEqual({
        type: 'string',
        description: 'Value for Type password',
        required: true,
        sensitive: true,
      });
    });

    it('does not register non-parameter placeholders ({{secrets.*}}, {{extracted.*}})', () => {
      const { parametersSchema } = sanitizeMobileSteps([
        mkStep({ id: 'a', description: 'Type password', value: '{{secrets.login_password}}' }),
        mkStep({ id: 'b', description: 'Type code', value: '{{extracted.code}}' }),
      ]);
      expect(parametersSchema).toEqual({});
    });

    it('trims whitespace around an existing placeholder for a stable next pass', () => {
      const step = mkStep({ description: 'Type password', value: '  {{param_password}}  ' });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0].value).toBe('{{param_password}}');
    });

    it('produces an output that is stable under a second pass', () => {
      const once = sanitizeMobileSteps([mkStep({ description: 'Type password', value: 'p@ss' })]);
      const twice = sanitizeMobileSteps(once.steps);
      expect(twice.steps[0].value).toBe(once.steps[0].value);
    });
  });

  describe('parameter naming', () => {
    it('derives the param name from a slugified description', () => {
      const { parametersSchema } = sanitizeMobileSteps([
        mkStep({ description: 'My Password Field!', value: 'x' }),
      ]);
      expect(Object.keys(parametersSchema)[0]).toBe('param_my_password_field');
    });

    it('caps the slug length', () => {
      const longDesc = 'password ' + 'a'.repeat(80);
      const { parametersSchema } = sanitizeMobileSteps([mkStep({ description: longDesc, value: 'x' })]);
      const name = Object.keys(parametersSchema)[0];
      // "param_" prefix + up to 32 slug chars.
      expect(name.length).toBeLessThanOrEqual('param_'.length + 32);
    });

    it('falls back to the step id when the description has no slug chars', () => {
      const { parametersSchema } = sanitizeMobileSteps([
        mkStep({ id: 'login-secret', description: '!!!', value: 'x', bindingHints: { label: 'secret' } }),
      ]);
      expect(Object.keys(parametersSchema)[0]).toBe('param_login_secret');
    });

    it('falls back to a counter when neither description nor id yield a slug', () => {
      const { parametersSchema } = sanitizeMobileSteps([
        mkStep({ id: '', description: '', value: 'x', bindingHints: { label: 'password' } }),
      ]);
      expect(Object.keys(parametersSchema)[0]).toBe('param_field_1');
    });

    it('disambiguates colliding param names with a numeric suffix', () => {
      const { parametersSchema } = sanitizeMobileSteps([
        mkStep({ id: 'a', description: 'password', value: 'x' }),
        mkStep({ id: 'b', description: 'password', value: 'y' }),
      ]);
      const names = Object.keys(parametersSchema).sort();
      expect(names).toEqual(['param_password', 'param_password_2']);
    });
  });

  it('preserves order and other step fields, only mutating value', () => {
    const steps = [
      mkStep({ id: 'a', type: 'tap' as any, description: 'Tap login', value: 'go' }),
      mkStep({ id: 'b', description: 'Type password', value: 'secret', assertionText: 'keep me' }),
    ];
    const { steps: out } = sanitizeMobileSteps(steps);
    expect(out[0]).toBe(steps[0]); // untouched
    expect(out[1].id).toBe('b');
    expect(out[1].assertionText).toBe('keep me');
    expect(out[1].value).toMatch(PLACEHOLDER);
  });

  it('returns empty results for an empty input list', () => {
    expect(sanitizeMobileSteps([])).toEqual({ steps: [], parametersSchema: {} });
  });

  describe('assertionText redaction', () => {
    it('masks a secret quoted in the assertion text itself', () => {
      const step = mkStep({
        id: 'a',
        type: 'ai_check' as any,
        description: 'Confirm token is shown',
        assertionText: 'The screen shows the API token sk_live_abc123',
      });
      const { steps } = sanitizeMobileSteps([step]);
      // The assertion string contains "token" → masked.
      expect(steps[0].assertionText).toBe('{{param_secret}}');
      expect(steps[0].assertionText).not.toContain('sk_live_abc123');
    });

    it('preserves a benign assertion even when the step types a sensitive value', () => {
      // Keying off the description would wrongly mask this benign assertion.
      const step = mkStep({
        id: 'b',
        description: 'Type password',
        value: 'hunter2',
        assertionText: 'Home screen is visible',
      });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0].assertionText).toBe('Home screen is visible');
      expect(steps[0].value).toMatch(PLACEHOLDER); // value still parameterised
    });

    it('leaves an already-templated assertionText untouched', () => {
      const step = mkStep({
        id: 'c',
        type: 'assert_text' as any,
        description: 'check',
        assertionText: '{{param_expected}}',
      });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0].assertionText).toBe('{{param_expected}}');
    });
  });

  describe('always-secret option fields', () => {
    it('masks options.totpSecret unconditionally (no keyword gate)', () => {
      const step = mkStep({
        id: 'a',
        type: 'otp' as any,
        description: 'Sign in with authenticator',
        options: { otpAction: 'generate_totp', totpSecret: 'JBSWY3DPEHPK3PXP' } as any,
      });
      const { steps } = sanitizeMobileSteps([step]);
      const opts = steps[0].options as Record<string, unknown>;
      expect(opts.totpSecret).toBe('{{param_secret}}');
      expect(opts.otpAction).toBe('generate_totp'); // non-secret field preserved
    });

    it('masks options.otpCode', () => {
      const step = mkStep({
        id: 'b',
        type: 'otp' as any,
        description: 'Enter code',
        options: { otpAction: 'type_otp', otpCode: '123456' } as any,
      });
      const { steps } = sanitizeMobileSteps([step]);
      expect((steps[0].options as Record<string, unknown>).otpCode).toBe('{{param_secret}}');
    });

    it('does not clone options when there is no secret field', () => {
      const step = mkStep({
        id: 'c',
        type: 'swipe' as any,
        description: 'swipe',
        options: { startX: 1, startY: 2, endX: 3, endY: 4 } as any,
      });
      const { steps } = sanitizeMobileSteps([step]);
      expect(steps[0]).toBe(step); // identity preserved — no needless clone
    });
  });
});
