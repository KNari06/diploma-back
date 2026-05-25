import crypto from 'crypto';
import { mintRunnerUserToken } from '../user-token';

describe('mintRunnerUserToken', () => {
  const secret = 'test-secret-do-not-use-in-prod';
  const userId = 'user-abc-123';

  it('produces `<userId>.<expiresAtMs>.<hex64>` shape', () => {
    const token = mintRunnerUserToken(userId, secret);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(userId);
    expect(parts[1]).toMatch(/^\d+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs HMAC-SHA256 over `userId + "." + expiresAtMs` (runner-verifiable)', () => {
    const token = mintRunnerUserToken(userId, secret);
    const [tUserId, tExpiresAtMs, tHmac] = token.split('.');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${tUserId}.${tExpiresAtMs}`)
      .digest('hex');
    expect(tHmac).toBe(expected);
  });

  it('honours custom ttlMs (expiresAtMs = now + ttl)', () => {
    const before = Date.now();
    const token = mintRunnerUserToken(userId, secret, 10_000);
    const after = Date.now();
    const expiresAtMs = Number(token.split('.')[1]);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 10_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 10_000);
  });

  it('defaults TTL to ~5 minutes', () => {
    const before = Date.now();
    const token = mintRunnerUserToken(userId, secret);
    const after = Date.now();
    const expiresAtMs = Number(token.split('.')[1]);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 5 * 60_000);
  });

  it('throws on empty secret (defense in depth — Node\'s HMAC silently accepts it)', () => {
    expect(() => mintRunnerUserToken(userId, '')).toThrow(/secret is empty/);
  });

  it('throws on empty userId', () => {
    expect(() => mintRunnerUserToken('', secret)).toThrow(/userId is empty/);
  });

  it('different secrets produce different HMACs for the same userId+expiry', () => {
    // Pin expiry deterministically.
    const realNow = Date.now;
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;
    try {
      const a = mintRunnerUserToken(userId, 'secret-a');
      const b = mintRunnerUserToken(userId, 'secret-b');
      expect(a.split('.')[1]).toBe(b.split('.')[1]);
      expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    } finally {
      Date.now = realNow;
    }
  });
});
