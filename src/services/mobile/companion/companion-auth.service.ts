import crypto from 'crypto';
import { redisConnection } from '@/config/infrastructure/queues';
import { env } from '@/config/environment/env';
import {
  createCompanionDevice,
  getCompanionDeviceByRefreshHash,
  revokeCompanionDevice,
  touchCompanionDeviceLastSeen,
} from './db/companion.db';

const PAIRING_CODE_TTL_S = 300; // 5 minutes, single-use
const ACCESS_TOKEN_TTL_MS = 30 * 60_000; // 30 minutes
const PAIRING_PREFIX = 'companion:pair:';
const CLAIM_PREFIX = 'companion:claim:';
const CLAIM_TTL_S = 60; // auto-release on crash; well beyond any DB call
const PAIRING_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PAIRING_CODE_LENGTH = 6;

export class RevokedDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevokedDeviceError';
  }
}

export class InvalidPairingCodeError extends Error {
  constructor() {
    super('Invalid or expired pairing code');
    this.name = 'InvalidPairingCodeError';
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('Invalid refresh token');
    this.name = 'InvalidRefreshTokenError';
  }
}

function generatePairingCodeStr(): string {
  let code = '';
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_CHARS[bytes[i] % PAIRING_CODE_CHARS.length];
  }
  return code;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class CompanionAuthService {
  static async generatePairingCode(userId: string): Promise<string> {
    const code = generatePairingCodeStr();
    await redisConnection.set(`${PAIRING_PREFIX}${code}`, userId, 'EX', PAIRING_CODE_TTL_S);
    return code;
  }

  static async createDevice(params: {
    code: string;
    deviceLabel: string;
  }): Promise<{ refreshToken: string; accessToken: string }> {
    const { code, deviceLabel } = params;

    const pairKey = `${PAIRING_PREFIX}${code}`;
    const claimKey = `${CLAIM_PREFIX}${code}`;

    // Atomically claim the code with SET NX — only one concurrent request can proceed.
    // The TTL auto-releases the claim if the server crashes mid-flight.
    const claimed = await redisConnection.set(claimKey, '1', 'EX', CLAIM_TTL_S, 'NX');
    if (!claimed) throw new InvalidPairingCodeError();

    // userId is authoritative from Redis — the code was minted under the
    // user's authenticated session, so possessing it proves identity.
    const userId = await redisConnection.get(pairKey);
    if (!userId) {
      await redisConnection.del(claimKey);
      throw new InvalidPairingCodeError();
    }

    const refreshToken = crypto.randomBytes(32).toString('hex');
    try {
      await createCompanionDevice({ userId, deviceLabel, refreshTokenHash: hashToken(refreshToken) });
    } catch (err) {
      // DB failed — release the claim so the user can retry with the same code.
      await redisConnection.del(claimKey);
      throw err;
    }

    // Success: atomically consume both the pairing code and the claim lock.
    await redisConnection.del(pairKey, claimKey);
    return { refreshToken, accessToken: CompanionAuthService.mintAccessToken(userId) };
  }

  static async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string }> {
    const device = await getCompanionDeviceByRefreshHash(hashToken(refreshToken));
    if (!device) throw new InvalidRefreshTokenError();
    if (device.revokedAt) throw new RevokedDeviceError('Device has been revoked');
    // Best-effort activity stamp (gives last_seen_at a writer). Fire-and-forget
    // and fully swallowed — a write hiccup must never break a token refresh.
    void touchCompanionDeviceLastSeen(device.id).catch(() => {});
    return { accessToken: CompanionAuthService.mintAccessToken(device.userId) };
  }

  static async revokeDevice(deviceId: string, userId: string): Promise<void> {
    const ok = await revokeCompanionDevice(deviceId, userId);
    if (!ok) throw new Error('Device not found or not owned by user');
  }

  static mintAccessToken(userId: string): string {
    const secret = env.COMPANION_TOKEN_SECRET;
    if (!secret) throw new Error('COMPANION_TOKEN_SECRET is not set');
    const expiresAtMs = Date.now() + ACCESS_TOKEN_TTL_MS;
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(`${userId}.${expiresAtMs}`)
      .digest('hex');
    return `${userId}.${expiresAtMs}.${hmac}`;
  }

  static verifyAccessToken(token: string): { userId: string } | null {
    try {
      const secret = env.COMPANION_TOKEN_SECRET;
      if (!secret || !token) return null;

      // Parse from the right so userId can contain dots in theory
      const lastDot = token.lastIndexOf('.');
      const secondLastDot = token.lastIndexOf('.', lastDot - 1);
      if (lastDot === -1 || secondLastDot === -1 || lastDot === secondLastDot) return null;

      const userId = token.substring(0, secondLastDot);
      const expiresAtStr = token.substring(secondLastDot + 1, lastDot);
      const providedHmac = token.substring(lastDot + 1);

      const expiresAtMs = parseInt(expiresAtStr, 10);
      if (!userId || isNaN(expiresAtMs) || Date.now() > expiresAtMs) return null;

      const expectedHmac = crypto
        .createHmac('sha256', secret)
        .update(`${userId}.${expiresAtMs}`)
        .digest('hex');

      const providedBuf = Buffer.from(providedHmac, 'hex');
      const expectedBuf = Buffer.from(expectedHmac, 'hex');
      if (providedBuf.length !== expectedBuf.length) return null;
      if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return null;

      return { userId };
    } catch {
      return null;
    }
  }
}
