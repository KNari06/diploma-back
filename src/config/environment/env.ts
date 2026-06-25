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

  // Azure Blob Storage — mobile app binaries (APK/IPA/AAB). Replaces Supabase
  // Storage for the `mobile-apps` container only. See DECISIONS.md ADR-0008.
  // `supabase` keeps the legacy behaviour; `azure` reads/writes Azure with a
  // Supabase read-fallback for not-yet-migrated objects (dual-read).
  MOBILE_APP_STORAGE_PROVIDER: z.enum(['supabase', 'azure']).default('supabase'),
  AZURE_STORAGE_ACCOUNT: z.string().optional(),
  AZURE_STORAGE_CONTAINER: z.string().default('mobile-apps'),
  // User-assigned Managed Identity client-id, so DefaultAzureCredential picks
  // the right identity on Azure Container Apps (multiple identities exist).
  AZURE_CLIENT_ID: z.string().optional(),
  // Max named APK variants (Production/Staging/Dev …) per project+platform.
  // Read only via getMaxMobileVariants() so the source can later become a
  // per-project/admin setting without touching call sites.
  MAX_MOBILE_VARIANTS: z.string().transform(Number).default('3'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform(Number).default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  OPENAI_MODEL_FAST: z.string().default('gpt-4.1-mini'),
  // Negative-test mutation generation. Reasoning-heavy (understand each field's
  // purpose, pick the highest-value attack) — defaults to the smart tier, NOT
  // the fast tier. Override only to pin a specific model for this task.
  OPENAI_MODEL_NEGATIVE_GEN: z.string().optional(),
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

  // When true, the worker process hosts the scheduler bundle (schedule sweeps +
  // retention jobs) behind a Redis leader lock — exactly one worker replica
  // runs them. Default OFF: local docker-compose runs a dedicated `scheduler`
  // container, so the worker stays out of scheduling there. Set true on the
  // prod worker (which is the only deployed long-lived process).
  SCHEDULER_IN_WORKER: z.string().transform(v => v === 'true').default('false'),

  // Agent
  AGENT_TIMEOUT: z.string().transform(Number).default('300000'),
  AGENT_MAX_RETRIES: z.string().transform(Number).default('3'),
  AGENT_BASE_URL: z.string().default('http://localhost:3001'),
  // Replay readiness recollect (default OFF). Background/regression replay
  // snapshots the DOM right before LLM element resolution. On redirect-heavy
  // flows (SSO/OAuth) that snapshot can land on a half-loaded / mid-redirect
  // page with only a handful of interactive nodes — the resolver then picks a
  // stray element and drifts the run onto the wrong page. When ON, a sparse
  // fresh snapshot triggers one `waitForPageInteractive` gate + recollect (the
  // same gate the editor/lite paths already use). Only fires on the first
  // attempt and only when the snapshot is sparse, so healthy pages pay no extra
  // wait. Validate before enabling broadly. See agent/execution/replay-readiness.ts.
  REPLAY_READINESS_RECOLLECT_ENABLED: z.string().transform(v => v === 'true').default('false'),
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
  SMTP_PASSWORD: z.string().optional(), // Gmail app password for yera@qait.dev

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
  // Self-serve PLG signup. Default false keeps the B2B flow intact
  // (manual admin approval + business-email gate). When true:
  //   - new users are provisioned approved on first auth (status set to
  //     'approved', overriding the users.status column default), with a
  //     default workspace + project so they skip the onboarding wizard
  //   - the business-email gate accepts personal domains (Gmail etc.);
  //     the disposable-domain block stays on as anti-abuse
  // The requireApproved middleware is left in place — flipping this off
  // restores gated behaviour with no code change.
  // ──────────────────────────────────────────────────────────────────
  AUTO_APPROVE_SIGNUP: z.string().transform(v => v === 'true').default('false'),

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
  // Shared HMAC secret used to mint per-request X-User-Token headers for the
  // mobile runner. Format mirrored from qait-mobile-runner/src/auth/user-token.ts:
  //   `<userId>.<expiresAtMs>.<HMAC-SHA256(secret, userId + '.' + expiresAtMs)>`
  // Empty in dev = don't mint tokens (legacy mode). When the runner flips to
  // RUNNER_REQUIRE_USER_ID=1 this MUST be set on every backend instance and
  // MUST match the runner's `RUNNER_USER_TOKEN_SECRET`. Rotate via deploy.
  RUNNER_USER_TOKEN_SECRET: z.string().optional().default(''),

  // Multi-user isolation: when ON, the runner creates a dedicated Android
  // user per backend user via `pm create-user` so apps installed by one
  // user are invisible to another. This costs 5-15s on the cold claim path
  // and is the source of "Maximum user limit is reached" failures on
  // long-running redroid containers. Default OFF — single shared workspace
  // mode where `pm clear` between sessions is sufficient. Flip per-deploy
  // for tenants that require strict isolation between backend users.
  MOBILE_MULTI_USER_ISOLATION: z.string().transform(v => v === 'true').default('false'),

  // Dedicated-emulator-per-workspace master switch. When ON, a mobile session
  // for a workspace that has an active `workspace_dedicated_device` row is
  // pinned to that runner_serial (skips the shared pool entirely). Default OFF
  // — the resolver short-circuits to null, so behaviour is unchanged until a
  // deploy flips this AND ops provisions a dedicated container + DB row.
  DEDICATED_MOBILE_EMULATOR_ENABLED: z.string().transform(v => v === 'true').default('false'),

  // Intent classifier fast-path — set to 'true' to disable the deterministic
  // whitelist that short-circuits trivial messages (greetings, cancels, yes/no
  // after pending confirmation). Kill-switch for the rare case the whitelist
  // misclassifies something.
  INTENT_FAST_PATH_DISABLED: z.string().transform(v => v === 'true').default('false'),

  // Intent classifier short-TTL cache — guards against double-submit and
  // instant retries by caching the full (message + context) pair for 60s.
  // Set to 'true' to disable.
  INTENT_CACHE_DISABLED: z.string().transform(v => v === 'true').default('false'),

  // ──────────────────────────────────────────────────────────────────
  // Per-step screenshot capture (web + mobile regression replay).
  // Captures a lightweight screenshot after EVERY step so passing/flaky
  // runs have visual evidence even when video/trace are disabled (video
  // only records on infra-retry attempts). Screenshots are uploaded to
  // the artifacts bucket as URLs — never stored as base64 in the DB.
  // ON by default; pair with the artifact-retention job (prunes old
  // screenshots) so storage doesn't grow unbounded.
  // ──────────────────────────────────────────────────────────────────
  SCREENSHOT_EACH_STEP_ENABLED: z.string().transform(v => v === 'true').default('true'),
  // Encoding format: 'webp' (smaller, via sharp) or 'jpeg' (Playwright-native).
  SCREENSHOT_FORMAT: z.enum(['webp', 'jpeg']).default('webp'),
  // Quality 1-100. Applies to both webp and jpeg. Clamped in ScreenshotCaptureFeature.
  SCREENSHOT_QUALITY: z.string().transform(Number).default('75'),
  // Screenshots older than this (days) are pruned by the artifact-retention job.
  SCREENSHOT_RETENTION_DAYS: z.string().transform(Number).default('30'),
  // Local editor / forensic logs in test_logs/editor/ older than this (days) are
  // pruned by the artifact-retention job's local sweep. These are debug artifacts
  // (editor traces + per-apply forensic jsonl/ds/html triplets) that otherwise
  // grow without bound — ~16 files per editor session, no upstream cleanup.
  EDITOR_LOG_RETENTION_DAYS: z.string().transform(Number).default('3'),

  // Phase B1: mobile-editor force-route. When `true` (default), chat
  // requests carrying `context.mobileEditorMode=true` with a non-empty
  // `mobileSessionId` skip the LLM intent classifier and route directly
  // to the `mobile_agent` handler. The frontend sets these fields in the
  // Mobile Session Debug surface, so every request there is BY DEFINITION
  // about the live mobile session — running the classifier just gives it
  // a chance to mis-route short chit-chat to `general_chat`, which has
  // no observe_mobile_page tool and produces the "I can help with UI/
  // API/regression…" generic reply (see user-reported screenshot trace).
  //
  // Set to `false` to revert to classifier-only routing if the force
  // path ever misbehaves. Mirrors how web's `mode === 'editor'` gates
  // `resolveEditorPageContext` in general/handler.ts.
  MOBILE_EDITOR_FORCE_ROUTE: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

  // Phase B2-B4: mobile-editor eager snapshot inject. When `true`
  // (default), the mobile_agent handler eagerly fetches the runner's
  // `/ui-state` snapshot BEFORE the first LLM call and injects it as a
  // system message — same pattern web uses with `getPageContext`. The
  // LLM gets device-fresh foreground + a11y tree without needing to
  // call the observe_mobile_page tool first.
  //
  // Set to `false` to revert to tool-only (PULL) mode. The
  // `observe_mobile_page` tool stays available either way; this only
  // controls whether the pre-fetch happens.
  MOBILE_CHAT_EAGER_SNAPSHOT: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

  // Phase B-SEC: redact email / phone / card (Luhn-validated) / OTP /
  // JWT-shaped tokens in the a11y tree BEFORE it lands in the LLM
  // prompt. Default ON — anything visible on the device screen could
  // contain personal data, and shipping it to OpenAI/Gemini in chat
  // turns is a compliance hazard. Set `false` only for evaluating the
  // unredacted output during internal QA — never disable in prod.
  // Patterns + replacements live in `src/services/chat/pii-redactor.ts`.
  MOBILE_CHAT_PII_REDACTION: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

  // Phase B-SEC: comma-separated allowlist of hostnames that
  // `MobileRunnerClient` is willing to call. Empty (default) = legacy
  // mode where the validator still blocks loopback / RFC1918 / link-
  // local addresses but accepts any other host (matches today's
  // operator-controlled env.MOBILE_RUNNER_URL). Set to e.g.
  // "runner-prod.qai.dev,10.0.5.20" when introducing per-session
  // runner routing so an attacker can't redirect us to
  // 169.254.169.254 or internal services. See
  // `src/services/mobile/validate-runner-url.ts`.
  MOBILE_RUNNER_ALLOWED_HOSTS: z.string().optional().default(''),

  // Mobile-agent reasoning persistence. When true (default), each turn's
  // think_aloud entries are written to chat_messages.metadata.reasoningTrace.
  // Set to 'false' for cost-sensitive deployments where JSONB bloat
  // matters more than the post-hoc "why did the agent do X" debug surface.
  // WebSocket streaming is unaffected by this flag.
  MOBILE_AGENT_PERSIST_REASONING: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

  // Full LLM prompt+completion persistence to ai_call_logs (for hallucination
  // debugging). OPT-IN and OFF by default — unlike the reasoning flag above —
  // because it stores the richest, most sensitive data (even after redaction)
  // and adds DB volume. Enable in dev/staging or per-incident to debug AI
  // failures. Text is always passed through redactForPersist first; rows carry
  // a 30-day TTL. Set to 'true' to enable.
  LLM_IO_PERSIST_ENABLED: z.string().transform(v => v.trim().toLowerCase() === 'true').default('false'),

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

  // Disable the dependency LEVEL BARRIER in a regression run (default OFF).
  // By default the orchestrator runs depends_on levels in order — a dependent
  // waits for its dependency's standalone run. But a dependent already INLINES
  // its dependency's steps as preconditions (collectPreconditionSteps), so that
  // wait is redundant for setup-style deps and just caps parallelism. When ON,
  // all (non-cyclic) tests dispatch together, bounded only by worker concurrency.
  // Inlining and cycle detection are unaffected. Trade-off: the fail-fast "skip a
  // dependent when its dependency failed" no longer fires — the dependent runs and
  // fails on its own inlined steps instead. Only yields parallelism when worker
  // concurrency (TEST_RUN_CONCURRENCY_MIN/MAX) > 1.
  REGRESSION_DISABLE_LEVEL_BARRIER: z.string().transform(v => v === 'true').default('false'),
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
