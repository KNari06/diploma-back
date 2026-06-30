import crypto from 'crypto';
import { CompanionAuthService, RevokedDeviceError } from '../companion-auth.service';
import {
  createCompanionDevice,
  getCompanionDeviceByRefreshHash,
  revokeCompanionDevice,
  touchCompanionDeviceLastSeen,
} from '../db/companion.db';

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
  },
}));

// Explicit factory so Jest never loads companion.db (and therefore never loads
// supabase.ts, which throws at module-eval time when env vars are absent).
jest.mock('../db/companion.db', () => ({
  createCompanionDevice: jest.fn(),
  getCompanionDeviceByRefreshHash: jest.fn(),
  revokeCompanionDevice: jest.fn(),
  touchCompanionDeviceLastSeen: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/config/environment/env', () => ({
  env: { COMPANION_TOKEN_SECRET: 'test-companion-secret-32-bytes!!' },
}));

const { redisConnection } = require('@/config/infrastructure/queues') as {
  redisConnection: { set: jest.Mock; get: jest.Mock; del: jest.Mock };
};
const mockCreate = createCompanionDevice as jest.Mock;
const mockGetByHash = getCompanionDeviceByRefreshHash as jest.Mock;
const mockRevoke = revokeCompanionDevice as jest.Mock;
const mockTouchLastSeen = touchCompanionDeviceLastSeen as jest.Mock;

beforeEach(() => jest.clearAllMocks());

// ── generatePairingCode ───────────────────────────────────────────────────────

describe('generatePairingCode', () => {
  it('returns a 6-char uppercase alphanumeric code', async () => {
    const code = await CompanionAuthService.generatePairingCode('user-1');
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('stores userId in Redis with a 5-min TTL', async () => {
    const code = await CompanionAuthService.generatePairingCode('user-1');
    expect(redisConnection.set).toHaveBeenCalledWith(
      `companion:pair:${code}`,
      'user-1',
      'EX',
      300,
    );
  });
});

// ── createDevice ─────────────────────────────────────────────────────────────

describe('createDevice', () => {
  it('derives userId from Redis, burns the code, inserts a device row, and returns tokens', async () => {
    redisConnection.get.mockResolvedValue('user-1');
    mockCreate.mockResolvedValue({ id: 'device-1' });

    const result = await CompanionAuthService.createDevice({
      code: 'ABC123',
      deviceLabel: 'Pixel 7 Pro',
    });

    // Claim lock must be acquired before the GET.
    expect(redisConnection.set).toHaveBeenCalledWith(
      'companion:claim:ABC123', '1', 'EX', 60, 'NX',
    );
    expect(redisConnection.get).toHaveBeenCalledWith('companion:pair:ABC123');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      deviceLabel: 'Pixel 7 Pro',
      refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    // On success both the pair key and the claim key are deleted atomically.
    expect(redisConnection.del).toHaveBeenCalledWith(
      'companion:pair:ABC123', 'companion:claim:ABC123',
    );
    expect(result.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.accessToken).toMatch(/^.+\.\d+\.[a-f0-9]{64}$/);
  });

  it('throws when the claim lock cannot be acquired (TOCTOU)', async () => {
    // SET NX returns null when the key already exists.
    redisConnection.set.mockResolvedValueOnce(null);
    await expect(
      CompanionAuthService.createDevice({ code: 'ABC123', deviceLabel: 'Phone' }),
    ).rejects.toThrow(/invalid.*pairing.*code/i);
    expect(redisConnection.get).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws when the pairing code is not found in Redis', async () => {
    redisConnection.get.mockResolvedValue(null);
    await expect(
      CompanionAuthService.createDevice({ code: 'BADCOD', deviceLabel: 'Phone' }),
    ).rejects.toThrow(/invalid.*pairing.*code/i);
  });

  it('does not call createCompanionDevice when the code is invalid', async () => {
    redisConnection.get.mockResolvedValue(null);
    await CompanionAuthService.createDevice({ code: 'BADCOD', deviceLabel: 'Phone' }).catch(() => {});
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('releases the claim lock but preserves the pair key on DB failure', async () => {
    redisConnection.get.mockResolvedValue('user-1');
    const dbError = new Error('DB unavailable');
    mockCreate.mockRejectedValue(dbError);

    await expect(
      CompanionAuthService.createDevice({ code: 'ABC123', deviceLabel: 'Phone' }),
    ).rejects.toThrow('DB unavailable');

    // Only the claim key is released so the user can retry with the same code.
    expect(redisConnection.del).toHaveBeenCalledWith('companion:claim:ABC123');
    expect(redisConnection.del).not.toHaveBeenCalledWith(
      'companion:pair:ABC123', 'companion:claim:ABC123',
    );
  });
});

// ── refreshAccessToken ────────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('returns a new access token for a valid, unrevoked refresh token', async () => {
    mockGetByHash.mockResolvedValue({ id: 'device-1', userId: 'user-1', revokedAt: null });
    const result = await CompanionAuthService.refreshAccessToken('some-refresh-token');
    expect(result.accessToken).toMatch(/^.+\.\d+\.[a-f0-9]{64}$/);
  });

  it('looks up the device by SHA256 hash of the refresh token', async () => {
    mockGetByHash.mockResolvedValue({ id: 'device-1', userId: 'user-1', revokedAt: null });
    await CompanionAuthService.refreshAccessToken('raw-token');
    const expectedHash = crypto.createHash('sha256').update('raw-token').digest('hex');
    expect(mockGetByHash).toHaveBeenCalledWith(expectedHash);
  });

  it('throws when no device matches the refresh token hash', async () => {
    mockGetByHash.mockResolvedValue(null);
    await expect(CompanionAuthService.refreshAccessToken('bad-token'))
      .rejects.toThrow(/invalid.*refresh.*token/i);
  });

  it('stamps last_seen_at for the device on a successful refresh', async () => {
    mockGetByHash.mockResolvedValue({ id: 'device-7', userId: 'user-1', revokedAt: null });
    await CompanionAuthService.refreshAccessToken('tok');
    expect(mockTouchLastSeen).toHaveBeenCalledWith('device-7');
  });

  it('still returns a token if the last_seen_at write fails (fire-and-forget)', async () => {
    mockGetByHash.mockResolvedValue({ id: 'device-1', userId: 'user-1', revokedAt: null });
    mockTouchLastSeen.mockRejectedValueOnce(new Error('db down'));
    const result = await CompanionAuthService.refreshAccessToken('tok');
    expect(result.accessToken).toMatch(/^.+\.\d+\.[a-f0-9]{64}$/);
  });

  it('throws RevokedDeviceError when the device has been revoked', async () => {
    mockGetByHash.mockResolvedValue({ id: 'device-1', userId: 'user-1', revokedAt: new Date() });
    await expect(CompanionAuthService.refreshAccessToken('some-token'))
      .rejects.toBeInstanceOf(RevokedDeviceError);
    await expect(CompanionAuthService.refreshAccessToken('some-token'))
      .rejects.toThrow(/revoked/i);
  });
});

// ── mintAccessToken / verifyAccessToken ───────────────────────────────────────

describe('mintAccessToken / verifyAccessToken', () => {
  it('round-trips: mint then verify returns the userId', () => {
    const token = CompanionAuthService.mintAccessToken('user-42');
    expect(CompanionAuthService.verifyAccessToken(token)).toEqual({ userId: 'user-42' });
  });

  it('verifyAccessToken returns null for a tampered HMAC', () => {
    const token = CompanionAuthService.mintAccessToken('user-1');
    const [head, ts] = token.split('.');
    const tampered = `${head}.${ts}.${'0'.repeat(64)}`;
    expect(CompanionAuthService.verifyAccessToken(tampered)).toBeNull();
  });

  it('verifyAccessToken returns null for an expired token', () => {
    const secret = 'test-companion-secret-32-bytes!!';
    const userId = 'user-1';
    const expiresAtMs = Date.now() - 1000;
    const hmac = crypto.createHmac('sha256', secret).update(`${userId}.${expiresAtMs}`).digest('hex');
    expect(CompanionAuthService.verifyAccessToken(`${userId}.${expiresAtMs}.${hmac}`)).toBeNull();
  });

  it('verifyAccessToken returns null for a malformed token', () => {
    expect(CompanionAuthService.verifyAccessToken('not-a-token')).toBeNull();
    expect(CompanionAuthService.verifyAccessToken('')).toBeNull();
    expect(CompanionAuthService.verifyAccessToken('a.b')).toBeNull();
  });
});

// ── revokeDevice ─────────────────────────────────────────────────────────────

describe('revokeDevice', () => {
  it('revokes successfully when the device belongs to the user', async () => {
    mockRevoke.mockResolvedValue(true);
    await expect(CompanionAuthService.revokeDevice('device-1', 'user-1')).resolves.not.toThrow();
    expect(mockRevoke).toHaveBeenCalledWith('device-1', 'user-1');
  });

  it('throws when the device is not found or does not belong to the user', async () => {
    mockRevoke.mockResolvedValue(false);
    await expect(CompanionAuthService.revokeDevice('device-x', 'user-1'))
      .rejects.toThrow(/not found/i);
  });
});
