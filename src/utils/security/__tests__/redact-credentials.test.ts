import { redactCredentials, redactCredentialsDeep } from '../redact-credentials';

describe('redactCredentials', () => {
  it('masks credential-like assignments (=, :, is)', () => {
    expect(redactCredentials('password=qwerty123')).toBe('password: [REDACTED]');
    expect(redactCredentials('api_key is sk-live-abc123')).toBe('api_key: [REDACTED]');
    expect(redactCredentials('the otp = 482913 now')).toContain('otp: [REDACTED]');
    // Quoted value: the secret body is masked; trailing quote/punct may remain
    // (the value regex stops at terminal punctuation) — what matters is the
    // credential itself never survives.
    const quoted = redactCredentials("token: 'abc-def123!'");
    expect(quoted).toContain('token: [REDACTED]');
    expect(quoted).not.toContain('abc-def123');
  });

  it('masks bare-shape Telegram bot tokens (no keyword separator)', () => {
    expect(redactCredentials('8977713030:AAG4MhWRp0I67t_7cr3s5Tvd3f4XxY54zNU')).toBe(
      '[REDACTED_TELEGRAM_TOKEN]',
    );
    expect(
      redactCredentials('вот токен 8977713030:AAG4MhWRp0I67t_7cr3s5Tvd3f4XxY54zNU спасибо'),
    ).toBe('вот токен [REDACTED_TELEGRAM_TOKEN] спасибо');
  });

  it('masks bare Slack incoming-webhook URLs', () => {
    expect(redactCredentials('https://hooks.slack.com/services/T00/B00/XXXXXXXXXXXX')).toBe(
      '[REDACTED_SLACK_WEBHOOK]',
    );
  });

  it('does NOT mask time-like or short colon values, nor chat IDs', () => {
    expect(redactCredentials('встреча в 12:30, тест 9:45')).toBe('встреча в 12:30, тест 9:45');
    expect(redactCredentials('ID проекта 42:abc')).toBe('ID проекта 42:abc');
    expect(redactCredentials('my chat id is -1001234567890')).toBe('my chat id is -1001234567890');
  });

  it('leaves free-form prose untouched (no separator)', () => {
    const prose = 'type the password into the login field';
    expect(redactCredentials(prose)).toBe(prose);
    expect(redactCredentials('the password remains hidden')).toBe('the password remains hidden');
  });

  it('does not mask short plain-word values', () => {
    // "is the" — value "the" is short & wordy, no digit/special, < 6 chars
    expect(redactCredentials('password is the')).toBe('password is the');
  });

  it('handles nullish / non-string input safely', () => {
    expect(redactCredentials('')).toBe('');
    // @ts-expect-error testing runtime guard
    expect(redactCredentials(undefined)).toBe('');
    // @ts-expect-error testing runtime guard
    expect(redactCredentials(null)).toBe('');
  });

  it('masks multiple occurrences in one string', () => {
    const out = redactCredentials('password=aaa111 and token=bbb222');
    expect(out).toBe('password: [REDACTED] and token: [REDACTED]');
  });
});

describe('redactCredentialsDeep', () => {
  it('redacts strings nested in objects and arrays', () => {
    const input = {
      prompt: 'set password=qwerty123',
      meta: { items: ['token: sk-abc999', 'plain text'] },
      count: 5,
    };
    const out = redactCredentialsDeep(input);
    expect(out.prompt).toBe('set password: [REDACTED]');
    expect(out.meta.items[0]).toBe('token: [REDACTED]');
    expect(out.meta.items[1]).toBe('plain text');
    expect(out.count).toBe(5);
  });

  it('returns non-string leaves unchanged', () => {
    expect(redactCredentialsDeep(42)).toBe(42);
    expect(redactCredentialsDeep(true)).toBe(true);
    expect(redactCredentialsDeep(null)).toBe(null);
  });
});
