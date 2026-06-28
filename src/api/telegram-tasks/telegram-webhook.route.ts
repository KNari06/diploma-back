import { Router } from 'express';
import { handleTelegramWebhook } from './telegram-webhook.controller';

/**
 * QAIT Tasker Telegram webhook. Mounted PUBLIC (no requireAuth) — authentication
 * is Telegram's secret-token header, checked in the controller. The raw-body
 * parser for this path is registered in index.ts BEFORE express.json(), so the
 * controller receives a Buffer.
 */
const router = Router();

router.post('/webhook', handleTelegramWebhook);

export default router;
