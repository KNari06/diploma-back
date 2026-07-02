/**
 * Sentry initialization.
 *
 * MUST be the very first import in the process entry point (see the top of
 * src/index.ts) so the SDK can instrument `http` / `express` before they load.
 * Keep this file dependency-light and do NOT import application modules here —
 * it runs before the rest of the app is wired up.
 *
 * DSN + sample rate come from the environment (Zod-validated list lives in
 * src/config/environment/env.ts). An empty DSN keeps the SDK disabled, which is
 * the expected state for local dev and tests.
 *
 * Docs: https://docs.sentry.io/platforms/javascript/guides/express/
 */
import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load env the same way src/config/environment/env.ts does. This file runs
// before that module is imported, so it must load .env itself.
dotenv.config();
if (existsSync(resolve(process.cwd(), '.env.local'))) {
  dotenv.config({ path: '.env.local', override: true });
}

const dsn = process.env.SENTRY_DSN?.trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Send structured logs to Sentry.
    enableLogs: true,
    // Performance tracing. 1.0 captures all transactions; lower in production.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
  });
  console.log(`✅ Sentry enabled (env: ${process.env.NODE_ENV || 'development'})`);
}
