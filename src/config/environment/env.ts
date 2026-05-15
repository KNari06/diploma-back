import crypto from 'crypto';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import os from 'os';
import { resolve } from 'path';
import { z } from 'zod';

/**
 * Detect whether the process is running inside a Docker container.
 */
function isRunningInDocker(): boolean {
  // Common marker file created by Docker
  if (existsSync('/.dockerenv')) return true;

  // Optional explicit override (useful in CI / custom containers)
  if (process.env.DOCKER === 'true') return true;

  return false;
}

/**
 * Normalize `host.docker.internal` for non-Docker local execution.
 *
 * `host.docker.internal` usually resolves only from inside Docker containers.
 * When running directly on the host machine, prefer a loopback address.
 */
function normalizeHostForLocalExecution(hostname: string): string {
  if (!hostname) return hostname;
  if (hostname !== 'host.docker.internal') return hostname;
  // Never rewrite in production to avoid any accidental prod behavior change.
  if (process.env.NODE_ENV === 'production') return hostname;
  if (isRunningInDocker()) return hostname;
  return '127.0.0.1';
}

/**
 * Normalize Redis URL hostname for non-Docker local execution.
 */
function normalizeRedisUrlForLocalExecution(redisUrl: string): string {
  if (!redisUrl) return redisUrl;
  // Never rewrite in production to avoid any accidental prod behavior change.
  if (process.env.NODE_ENV === 'production') return redisUrl;

  try {
    const url = new URL(redisUrl);
    url.hostname = normalizeHostForLocalExecution(url.hostname);
    return url.toString();
  } catch {
    // If it's not a valid URL, keep it as-is (schema validation already ran).
    return redisUrl;
  }
}

// Load environment variables
// First load .env, then .env.local (if exists) which will override .env values
dotenv.config();
if (existsSync(resolve(process.cwd(), '.env.local'))) {
  dotenv.config({ path: '.env.local', override: true });
}

// Environment schema validation
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  API_VERSION: z.string().default('v1'),
  API_BASE_URL: z.string().optional(),

  // Supabase
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_BUCKET_NAME: z.string().default('qai-assets'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform(Number).default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  OPENAI_MODEL_FAST: z.string().default('gpt-4.1-mini'),
  OPENAI_MAX_TOKENS: z.string().transform(Number).default('4000'),

  // Google Gemini
  GEMINI_API_KEY: z.string().optional(),

  // Phase 2.3 — KB reranker. Off by default; safe to leave disabled in prod
  // until evals prove a lift. When 'cohere', COHERE_API_KEY must be set.
  // 'bge' is a placeholder for a future self-hosted adapter.
  KB_RERANKER: z.enum(['off', 'cohere', 'bge']).default('off'),
  COHERE_API_KEY: z.string().optional(),
  KB_RERANKER_MODEL: z.string().default('rerank-english-v3.0'),
  KB_RERANKER_TIMEOUT_MS: z.string().transform(Number).default('500'),

  // AI Provider Configuration
  // Which provider to use for fast tasks (keyword extraction, classification)
  AI_PROVIDER_FAST: z.enum(['gemini', 'openai']).default('gemini'),
  // Which provider to use for smart tasks (complex analysis, code generation)
  AI_PROVIDER_SMART: z.enum(['openai', 'gemini']).default('openai'),

  // Queue
  QUEUE_CONCURRENCY: z.string().transform(Number).default('5'),
  QUEUE_RETRY_ATTEMPTS: z.string().transform(Number).default('3'),
  QUEUE_RETRY_DELAY: z.string().transform(Number).default('5000'),
  // BullMQ prefix (namespace) to avoid cross-environment collisions when sharing Redis
  QUEUE_PREFIX: z.string().min(1).optional(),

  // Dynamic test-run worker scaling
  TEST_RUN_CONCURRENCY_MIN: z.string().transform(Number).default('2'),
  TEST_RUN_CONCURRENCY_MAX: z.string().transform(Number).default('20'),
  SCALE_ENABLED: z.string().transform(v => v === 'true').default('true'),
  SCALE_CHECK_INTERVAL_MS: z.string().transform(Number).default('15000'),
  SCALE_MAX_MEMORY_PERCENT: z.string().transform(Number).default('80'),

  // Agent
  AGENT_TIMEOUT: z.string().transform(Number).default('300000'),
  AGENT_MAX_RETRIES: z.string().transform(Number).default('3'),
  AGENT_BASE_URL: z.string().default('http://localhost:3001'),
  EXPLORATION_TIMEOUT_MS: z.string().transform(Number).default('300000'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FORMAT: z.enum(['combined', 'common', 'dev', 'short', 'tiny']).default('combined'),

  // Documentation
  DOCS_PASSWORD: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('100'),

  // Security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').optional(),
  API_KEY_SECRET: z.string().min(32, 'API_KEY_SECRET must be at least 32 characters').optional(),
  ENCRYPTION_SECRET: z.string().min(32, 'ENCRYPTION_SECRET must be at least 32 characters for AES-256').default('change-this-secret-in-production-minimum-32-characters'),

  // Billing (Future)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Frontend
  FRONTEND_URL: z.string().url().optional().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z.string().optional(),

  // Backend URL (used for OAuth callbacks)
  BACKEND_URL: z.string().optional(),

  // Email / SMTP
  SMTP_PASSWORD: z.string().optional(), // Gmail app password for noreply@qait.dev

  // Email Inbox (IMAP for test email reception — catch-all inbox)
  IMAP_HOST: z.string().default('imap.gmail.com'),
  IMAP_PORT: z.string().transform(Number).default('993'),
  IMAP_USER: z.string().optional(),       // inbox@qait.dev (catch-all account)
  IMAP_PASSWORD: z.string().optional(),   // App Password for IMAP access

  // Integrations
  JIRA_CLIENT_ID: z.string().optional(),
  JIRA_CLIENT_SECRET: z.string().optional(),
  JIRA_CALLBACK_URL: z.string().url().optional(),
  JIRA_BASE_URL: z.string().optional(),
  JIRA_USERNAME: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),

  // GitHub OAuth
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  // GitLab OAuth (gitlab.com)
  GITLAB_CLIENT_ID: z.string().optional(),
  GITLAB_CLIENT_SECRET: z.string().optional(),

  // Notion OAuth
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Feature Flags - B2B Organization/Members
  // Staged rollout: enable reads first, then writes, then credits cutover
  FEATURE_ORG_MEMBERS_ENABLED: z.string().transform(v => v === 'true').default('true'),
  FEATURE_ORG_CREDITS_ENABLED: z.string().transform(v => v === 'true').default('true'),

  // ──────────────────────────────────────────────────────────────────
  // Per-test-case chat (Phase 1-8 backend, frontend integration TBD).
  //
  // When false (default), POST /chat with `testCaseId` returns 404
  // and the per-test-case routes / WS subscribe channel are
  // unreachable. The legacy global chat path is unaffected. This lets
  // us merge backend changes ahead of frontend without exposing the
  // half-wired surface to clients.
  //
  // Migration `20260429_test_case_chat.sql` is independent of this
  // flag — it can be applied first; tables stay empty until the flag
  // flips on.
  //
  // To enable: set ENABLE_TEST_CASE_CHAT=true in the deployment env.
  //   - Per-test-case REST endpoints become live
  //   - POST /chat accepts testCaseId
  //   - WS subscribe:chat:testcase begins responding
  // ──────────────────────────────────────────────────────────────────
  ENABLE_TEST_CASE_CHAT: z.string().transform(v => v === 'true').default('false'),

  // Mobile Runner (qait-mobile-runner microservice)
  MOBILE_RUNNER_URL: z.string().url().optional().default('http://localhost:4100'),
  MOBILE_RUNNER_ENABLED: z.string().transform(v => v === 'true').default('false'),
  MOBILE_RUNNER_API_KEY: z.string().optional().default(''),

  // Intent classifier fast-path — set to 'true' to disable the deterministic
  // whitelist that short-circuits trivial messages (greetings, cancels, yes/no
  // after pending confirmation). Kill-switch for the rare case the whitelist
  // misclassifies something.
  INTENT_FAST_PATH_DISABLED: z.string().transform(v => v === 'true').default('false'),

  // Intent classifier short-TTL cache — guards against double-submit and
  // instant retries by caching the full (message + context) pair for 60s.
  // Set to 'true' to disable.
  INTENT_CACHE_DISABLED: z.string().transform(v => v === 'true').default('false'),

  // Mobile-agent reasoning persistence. When true (default), each turn's
  // think_aloud entries are written to chat_messages.metadata.reasoningTrace.
  // Set to 'false' for cost-sensitive deployments where JSONB bloat
  // matters more than the post-hoc "why did the agent do X" debug surface.
  // WebSocket streaming is unaffected by this flag.
  MOBILE_AGENT_PERSIST_REASONING: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

  // ──────────────────────────────────────────────────────────────────
  // Phase 4 (May 2026): mobile regression concurrency cap.
  //
  // The cap is decided per-run by `decideMaxMobileInFlight` in
  // `src/services/testing/regression/concurrency-decision.ts`. Each
  // env below is a tunable input, not a hard switch.
  //
  // IMPORTANT: env values are read via `process.env[name]` inside the
  // decision module (NaN-safe parser there); the schema registrations
  // here exist so (a) Zod refuses to start with garbage values and
  // (b) the env list is discoverable in one place. All defaults
  // match `readEnvInt` defaults inside concurrency-decision.ts —
  // changing them in only one place would create silent drift.
  //
  // Bump these ONLY after Phase 3 (host-ADB mutex) is live in the
  // runner — without it, MAX_CONCURRENCY>1 racing the daemon socket
  // causes the `Client aborted` / `pm create-user failed` regressions
  // documented at regression-run.service.ts:2079-2087.
  // ──────────────────────────────────────────────────────────────────

  // Hard ceiling for mobile in-flight tests per regression run.
  // Default 1 preserves pre-Phase-4 serial behaviour. Raise to 2 after
  // Phase 3 stress-tested for 7 days with zero race failures.
  //
  // No regex constraint here on purpose — we let garbage values through
  // schema validation so the app still boots on a misconfigured env.
  // The actual parsing happens in `readEnvInt` inside
  // `concurrency-decision.ts`, which is NaN-safe (validates
  // Number.isFinite + >=1, falls back to 1 otherwise). A strict regex
  // here would turn a typo'd env into a startup crash, which is worse
  // than silently falling back to safe serial behaviour.
  REGRESSION_MOBILE_MAX_CONCURRENCY: z.string().optional().default('1'),

  // Test-count threshold separating "small batch" (use SMALL_CAP) from
  // "large batch" (use LARGE_CAP). testCount <= threshold → SMALL_CAP.
  // Same parsing strategy as REGRESSION_MOBILE_MAX_CONCURRENCY above —
  // schema accepts any string, NaN-safe parse happens at use site.
  REGRESSION_MOBILE_SMALL_BATCH_THRESHOLD: z.string().optional().default('5'),

  // Desired cap for small batches (testCount <= SMALL_BATCH_THRESHOLD).
  // Final cap = min(MAX_CONCURRENCY, poolIdle, SMALL_CAP).
  REGRESSION_MOBILE_SMALL_CAP: z.string().optional().default('2'),

  // Desired cap for large batches (testCount > SMALL_BATCH_THRESHOLD).
  // Final cap = min(MAX_CONCURRENCY, poolIdle, LARGE_CAP).
  REGRESSION_MOBILE_LARGE_CAP: z.string().optional().default('3'),
});

// Parse and validate environment variables
const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parseResult.error.format());
  process.exit(1);
}

// Generate secrets for development if not provided
const parsedEnv = parseResult.data;

// Normalize Docker-only hostname for local execution (host machine).
parsedEnv.REDIS_HOST = normalizeHostForLocalExecution(parsedEnv.REDIS_HOST);
parsedEnv.REDIS_URL = normalizeRedisUrlForLocalExecution(parsedEnv.REDIS_URL);

// When running locally (not in Docker), qait-redis-dev does not resolve; use localhost so the same .env works for server and local.
if (!isRunningInDocker() && parsedEnv.REDIS_HOST === 'qait-redis-dev') {
  parsedEnv.REDIS_HOST = 'localhost';
  const redisAuthPart = parsedEnv.REDIS_PASSWORD ? `:${encodeURIComponent(parsedEnv.REDIS_PASSWORD)}@` : '';
  parsedEnv.REDIS_URL = `redis://${redisAuthPart}${parsedEnv.REDIS_HOST}:${parsedEnv.REDIS_PORT}`;
}

// If REDIS_URL is not explicitly provided, build it from REDIS_HOST/REDIS_PORT.
// This avoids accidental localhost fallback in Cloud Run where only host/port are injected.
if (!process.env.REDIS_URL) {
  const redisAuthPart = parsedEnv.REDIS_PASSWORD ? `:${encodeURIComponent(parsedEnv.REDIS_PASSWORD)}@` : '';
  parsedEnv.REDIS_URL = `redis://${redisAuthPart}${parsedEnv.REDIS_HOST}:${parsedEnv.REDIS_PORT}`;
}

// Set default BullMQ prefix if not provided.
// IMPORTANT: Must be deterministic across processes on the same host (server + worker),
// otherwise queues won't match.
if (!parsedEnv.QUEUE_PREFIX) {
  parsedEnv.QUEUE_PREFIX = parsedEnv.NODE_ENV === 'production'
    ? 'qait'
    : `qait-dev-${os.hostname()}`;
}

if (parsedEnv.NODE_ENV === 'development') {
  if (!parsedEnv.JWT_SECRET) {
    parsedEnv.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    console.log('⚠️  JWT_SECRET not provided, generated random secret for development');
  }
  if (!parsedEnv.API_KEY_SECRET) {
    parsedEnv.API_KEY_SECRET = crypto.randomBytes(32).toString('hex');
    console.log('⚠️  API_KEY_SECRET not provided, generated random secret for development');
  }
} else {
  // In production, these are required
  if (!parsedEnv.JWT_SECRET || !parsedEnv.API_KEY_SECRET) {
    console.error('❌ JWT_SECRET and API_KEY_SECRET are required in production');
    process.exit(1);
  }
}

export const env = parsedEnv;

// Type-safe environment configuration
export type EnvConfig = typeof env;

// Helper functions
export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
