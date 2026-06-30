import type { Request, Response } from 'express';
import {
  CompanionAuthService,
  InvalidPairingCodeError,
  InvalidRefreshTokenError,
  RevokedDeviceError,
} from '@/services/mobile/companion/companion-auth.service';
import { companionRegistry } from '@/services/mobile/companion/companion-registry';
import { logger } from '@/utils/core/logger';

export async function generatePairingCode(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const code = await CompanionAuthService.generatePairingCode(userId);
  res.json({ code });
}

// GET /api/v1/companion/status
// Lets the web client know whether the user's companion is currently connected
// and bootstrap its device picker from the last forwarded device snapshot.
export async function getCompanionStatus(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const connected = companionRegistry.isConnected(userId);
  const snapshot = connected ? companionRegistry.getDeviceSnapshot(userId) : null;
  res.json({ connected, snapshot });
}

export async function pairDevice(req: Request, res: Response): Promise<void> {
  const { code, deviceLabel } = req.body as { code?: string; deviceLabel?: string };
  if (!code || !deviceLabel) {
    res.status(400).json({ error: 'code and deviceLabel are required' });
    return;
  }
  try {
    const { refreshToken, accessToken } = await CompanionAuthService.createDevice({ code, deviceLabel });
    res.json({ refreshToken, accessToken });
  } catch (err) {
    if (err instanceof InvalidPairingCodeError) {
      res.status(400).json({ error: err.message });
    } else {
      logger.warn('[COMPANION] pairDevice unexpected error', { err });
      res.status(500).json({ error: 'Failed to pair device, please try again' });
    }
  }
}

export async function refreshToken(req: Request, res: Response): Promise<void> {
  const { refreshToken: rt } = req.body as { refreshToken?: string };
  if (!rt) {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }
  try {
    const { accessToken } = await CompanionAuthService.refreshAccessToken(rt);
    res.json({ accessToken });
  } catch (err) {
    if (err instanceof RevokedDeviceError) {
      res.status(403).json({ error: 'Device has been revoked' });
    } else if (err instanceof InvalidRefreshTokenError) {
      res.status(401).json({ error: err.message });
    } else {
      logger.warn('[COMPANION] refreshToken unexpected error', { err });
      res.status(500).json({ error: 'Failed to refresh token, please try again' });
    }
  }
}

export async function revokeDevice(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id: deviceId } = req.params;
  try {
    await CompanionAuthService.revokeDevice(deviceId, userId);
    res.status(204).send();
  } catch (err) {
    logger.warn('[COMPANION] revokeDevice failed', { deviceId, userId, err });
    res.status(404).json({ error: 'Device not found' });
  }
}
