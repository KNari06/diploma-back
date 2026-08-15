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
  // Max CI build publishes per project per hour, across `/ci/app/upload-url`
  // and `/ci/run`'s appUrl branch. A ceiling on a runaway pipeline, NOT a
  // storage budget — retention (BUILD_HISTORY_LIMIT) is what bounds stored
  // builds. A full matrix is one publish per lane per platform, so this must
  // stay comfortably above (named variants x platforms).
  MAX_CI_PUBLISHES_PER_HOUR: z.string().transform(Number).default('30'),
  // Orphan sweep: DELETING is opt-in. The job always reports what it would
  // reclaim; flipping this lets it actually remove blobs that no row
  // references. Default off so the numbers can be checked against production
  // before anything deletes from storage.
  MOBILE_ORPHAN_SWEEP_DELETE: z.string().transform(v => v === 'true').default('false'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform(Number).default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  // Deliberately the SAME model as OPENAI_MODEL: prod pins gpt-5.4-mini via
  // `var.openai_model_fast` in qait-infra, so a gpt-4.1-mini default here meant
  // local dev silently ran a different (10× cheaper, weaker) model than prod on
  // every `fast` task — the worst kind of environment drift, since it makes
  // local quality unrepresentative. Split the tiers only with measurements.
  OPENAI_MODEL_FAST: z.string().default('gpt-5.4-mini'),
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
  // PreflightCheck: a pre-action gate that inspects the Planner's plan before
  // the Executor runs it (catches loops / hallucinated refs / unreachable goals
  // BEFORE burning a round). Exploration-only. ON by default; flip to disable.
  EXPLORATION_PREFLIGHT_ENABLED: z.string().transform(v => v === 'true').default('true'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FORMAT: z.enum(['combined', 'common', 'dev', 'short', 'tiny']).default('combined'),

  // Monitoring — Sentry (errors + tracing + logs). Empty DSN ⇒ SDK disabled
  // (see src/instrument.ts). Traces rate is 0..1; lower it in production.
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.string().transform(Number).default('1.0'),

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
  // Admin dashboard (separate deployment, e.g. https://admin.qait.dev).
  // Used for admin-targeted notification links (new-user approval, etc.).
  ADMIN_URL: z.string().url().optional().default('http://localhost:3000'),
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

  // Jira task-readiness assessment before auto-running a ticket. OFF by default —
  // when off, runFromJiraViaChat behaves exactly as before (straight to the test).
  // When on: fetch the full issue + related tickets, assess readiness, and HARD-GATE
  // the run (not ready → post blocking questions + gaps, skip the auto-run).
  JIRA_READINESS_ASSESSMENT_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // Developer fix-prompt: after a run finds a bug, generate a paste-ready markdown
  // prompt (one LLM call) persisted to ai_summary.fixPrompt + attached to the Jira
  // feedback comment. OFF by default.
  DEVELOPER_FIX_PROMPT_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // Jira webhook auto-trigger: when a ticket enters a project's configured QA
  // column, auto-ASSESS it (readiness + handoff) — never auto-runs the test.
  // OFF by default; also gated per-project by qaColumnName + webhookSecret.
  JIRA_WEBHOOK_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // Query-driven retrieval planning: before assessing a Jira ticket, a cheap LLM
  // call expands it into search terms so context retrieval finds related work
  // by meaning (not just literal ticket words). OFF → assessment uses the raw
  // summary+description as the search query (current behavior).
  JIRA_QUERY_PLANNER_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // QAIT Tasker (Telegram task tracking). Feature-gated, OFF by default — when
  // off the webhook accepts-and-ignores and the sweep job doesn't start.
  TELEGRAM_TASKS_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // Shared secret echoed by Telegram in the X-Telegram-Bot-Api-Secret-Token
  // header (set when registering the webhook). Required for the webhook to act.
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // Comma-separated @usernames allowed to close/reopen ANYONE's task (digest author).
  TELEGRAM_TASK_MANAGERS: z.string().optional(),
  // Owner aliases: "@user = nick, nick; @user = nick" (nickname → canonical @username).
  TELEGRAM_TASK_ALIASES: z.string().optional(),
  // Local hour (Asia/Almaty, 0-23) to run the morning batch + status check.
  TELEGRAM_TASK_BATCH_HOUR: z.string().transform(Number).default('10'),
  // Bot's @username (without @), e.g. "qait_task". Lets the bot recognise when a
  // message @mentions it and switch to Q&A mode. Reply-to-bot is detected without
  // this; set it so plain @mentions also work.
  TELEGRAM_BOT_USERNAME: z.string().optional(),

  // Feature Flags - B2B Organization/Members
  // Staged rollout: enable reads first, then writes, then credits cutover
  FEATURE_ORG_MEMBERS_ENABLED: z.string().transform(v => v === 'true').default('true'),
  FEATURE_ORG_CREDITS_ENABLED: z.string().transform(v => v === 'true').default('true'),

  // ──────────────────────────────────────────────────────────────────
  // Self-serve PLG signup. Default TRUE — the product is now self-serve B2C:
  //   - new users are provisioned approved on first auth (status set to
  //     'approved', overriding the users.status column default), with a
  //     default workspace + project so they skip the onboarding wizard
  //   - the business-email gate accepts personal domains (Gmail etc.);
  //     the disposable-domain block stays on as anti-abuse
  // Set AUTO_APPROVE_SIGNUP=false to restore the gated B2B flow (manual admin
  // approval + business-email gate). The requireApproved middleware stays in
  // place, so flipping this off re-gates with no code change.
  // NOTE: default true means ANY env without an explicit value (staging, local,
  // a fork) also auto-approves — set it false there if you want manual review.
  // ──────────────────────────────────────────────────────────────────
  AUTO_APPROVE_SIGNUP: z.string().transform(v => v === 'true').default('true'),

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

  // ──────────────────────────────────────────────────────────────────
  // Referrals by link. Feature-gated, OFF by default — dark in prod until set
  // in the infra .env (see CLAUDE.md "Env vars: local vs prod"). When off:
  // attribution is not written, the reward is not granted, and the /referrals
  // routes return 404. Migration 20260713_referrals.sql is independent of the
  // flag (safe to apply first; tables stay empty until the flag flips on).
  // Reward is a time-windowed revenue share: the partner earns
  // REFERRAL_REWARD_RATE (0.50 = 50%) of the REAL amount a referred user pays,
  // for their first REFERRAL_REWARD_MONTHS (2) monthly payments, then 0%.
  // Owed balance accrues in the paid invoice's currency (cents).
  //
  // The rate is 50% (not the original 70%) because the referred USER now also
  // gets a benefit — the credit bonus below — so the margin covers both sides.
  //
  // REFERRAL_USER_BONUS_PLANS: the user-side benefit, per plan code. A referred
  // user's paid invoice grants `multiplier` × the plan's credits — same price,
  // more credits, which reads to the user as a price cut per credit. Format:
  //   <planCode>:<multiplier>:<payments>,...
  // `payments` is how many of that user's invoices get the multiplier;
  // `inf` = every invoice while they stay subscribed.
  //
  // The multiplier DECREASES with plan size on purpose: 2x on pro_19 is ~990
  // bonus credits, but 2x on pro_99 would be 18 000 — and we pay the partner
  // 50% of that same invoice. The bonus is unbounded on pro_19 (cheap, and a
  // bounded bonus would visibly DROP at renewal, reading as a takeaway) and
  // capped at 2 invoices on the larger plans, matching the partner window.
  //
  // A plan absent from this map gets no bonus, so a new plan is opt-in rather
  // than silently expensive. Empty string disables the user-side benefit.
  // B2B plans never reach this path (credited per workspace, not per user).
  // ──────────────────────────────────────────────────────────────────
  REFERRALS_ENABLED: z.string().transform(v => v === 'true').default('false'),
  REFERRAL_REWARD_RATE: z.string().transform(Number).default('0.5'),
  REFERRAL_REWARD_MONTHS: z.string().transform(Number).default('2'),
  REFERRAL_USER_BONUS_PLANS: z
    .string()
    .default('pro_19:2:inf,pro_49:1.5:2,pro_99:1.25:2'),

  // Mobile Runner (qait-mobile-runner microservice)
  MOBILE_RUNNER_URL: z.string().url().optional().default('http://localhost:4100'),
  // Optional iOS-host runner (the macOS runner from qait-infra/aws). Empty =
  // fall back to MOBILE_RUNNER_URL (local dev: one runner serves both pools).
  // Terraform already feeds this var on both clouds — this makes it read.
  MOBILE_RUNNER_IOS_URL: z.string().url().optional().or(z.literal('')).default(''),
  MOBILE_RUNNER_ENABLED: z.string().transform(v => v === 'true').default('false'),
  MOBILE_RUNNER_API_KEY: z.string().optional().default(''),
  // Shared HMAC secret used to mint per-request X-User-Token headers for the
  // mobile runner. Format mirrored from qait-mobile-runner/src/auth/user-token.ts:
  //   `<userId>.<expiresAtMs>.<HMAC-SHA256(secret, userId + '.' + expiresAtMs)>`
  // Empty in dev = don't mint tokens (legacy mode). When the runner flips to
  // RUNNER_REQUIRE_USER_ID=1 this MUST be set on every backend instance and
  // MUST match the runner's `RUNNER_USER_TOKEN_SECRET`. Rotate via deploy.
  RUNNER_USER_TOKEN_SECRET: z.string().optional().default(''),

  // Backend → runner proxy timeout for `POST /attach-flutter` (both the direct
  // MobileRunnerClient and the companion relay). The runner's attach is
  // force-stop → cold launch → VM detect (≤20s) → driver connect →
  // waitForReadableTree (≤ runner's FLUTTER_TREE_READY_TIMEOUT_MS, default 15s,
  // tunable up to 60s on slow physical devices). On a slow phone the whole
  // attach legitimately takes ~50s; a too-short backend timeout makes warmup
  // return TIMEOUT while the runner keeps going, the frontend retries, and the
  // retry's cold-start force-stops the app the runner just finished attaching —
  // an endless relaunch storm. Default 120s gives headroom over the worst case.
  MOBILE_ATTACH_FLUTTER_TIMEOUT_MS: z.string().transform(Number).default('120000'),

  // Max single Socket.IO message size (bytes). The companion relay carries full
  // runner HTTP responses, and a per-step apply result includes a base64 device
  // screenshot (several MB on a high-res phone) + a11y tree — the old 2MB cap
  // made engine.io drop the companion socket on send. 16MB default carries a
  // screenshot-bearing response with headroom; raise for very large screens.
  WS_MAX_HTTP_BUFFER_SIZE: z.string().transform(Number).default(String(16 * 1024 * 1024)),

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

  // Credential-bound test authoring (ADR-0023). The chat agent may author a
  // LOGIN test against a saved `secret`: the user names the login, the server
  // injects the real values for the live authoring run, and the steps freeze
  // `{{secrets.*}}` so the saved test replays.
  //
  // Default ON. It shipped default-OFF so it could be enabled deliberately from
  // the infra env, but that env is set in a separate repo — a flag nobody can
  // set leaves working code permanently dark, which is worse than no flag. The
  // path is opt-in by nature anyway: it only runs when a user NAMES a saved
  // login, so nothing changes for users who don't.
  //
  // Set to anything other than the literal `true` (conventionally `false`) to
  // disable without a deploy: the tool stops advertising
  // `credential_secret_name`, the prompts stop offering the path, and the
  // handler refuses it — behaviour matches pre-rung-5. The `=== 'true'`
  // comparison is deliberate, matching every other flag in this file; a
  // `!== 'false'` variant here would read identically but behave differently
  // for a typo'd value.
  CREDENTIAL_AUTHORING_ENABLED: z.string().transform(v => v === 'true').default('true'),

  // Companion relay — per-user launch-and-go physical device support (ADR-0009).
  // COMPANION_TOKEN_SECRET: separate HMAC secret from RUNNER_USER_TOKEN_SECRET
  // (separate audience — a companion token must not be replayable as a runner
  // request token). Empty = companion feature disabled (verifyAccessToken always
  // returns null, mintAccessToken throws). Rotate via deploy independently.
  COMPANION_ENABLED: z.string().transform(v => v === 'true').default('false'),
  COMPANION_TOKEN_SECRET: z.string().optional().default(''),

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
  // ──────────────────────────────────────────────────────────────────
  // Import credit charging (Allure ZIP / PDF / CSV → intent_test_cases).
  // AI-powered imports run multiple LLM calls; historically they charged 0
  // credits and logged 0 usage. When ON, a completed import deducts
  // IMPORT_CREDITS_PER_TEST × testsImported and logs AI usage. Default OFF so
  // it can dark-launch (usage logging fills first) before deduction flips on.
  // ──────────────────────────────────────────────────────────────────
  IMPORT_CREDITS_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // Credits charged per successfully imported test case. Decimal-safe.
  IMPORT_CREDITS_PER_TEST: z.string().transform(Number).default('1'),
  // ──────────────────────────────────────────────────────────────────
  // Authoring credit charging (step-editor Apply that needed the LLM).
  // Element resolution is a 5-stage waterfall; identity/evidence/compiled
  // resolve for free, only the LLM/vision stages (resolverPath 'llm'/'vision')
  // spend money. When ON, a successful Apply that used the LLM deducts
  // AUTHORING_CREDITS_PER_RESOLVE, deduped once per (session, step). Lint and
  // the background observer are NOT charged (too frequent / background).
  // Default OFF — independent of import's flag so each ships on its own.
  // ──────────────────────────────────────────────────────────────────
  AUTHORING_CREDITS_ENABLED: z.string().transform(v => v === 'true').default('false'),
  // Credits charged per AI-assisted (llm/vision) Apply. Decimal-safe.
  AUTHORING_CREDITS_PER_RESOLVE: z.string().transform(Number).default('1'),
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
  // A regression run / test is presumed dead after this many minutes with NO
  // observed progress (see config/testing/run-staleness.ts). Measured against
  // the last dispatch/start/completion in the run, never against how long the
  // run has been going — a legitimately long suite must not reap itself.
  STALE_RUN_THRESHOLD_MIN: z.string().transform(Number).default('30'),

  // ──────────────────────────────────────────────────────────────────
  // Release-readiness report — ADR-0012. The verdict itself is a free,
  // always-on deterministic function (release-verdict.util.ts) with no
  // flag. These two vars gate only the optional LLM narrative layered
  // on top of it. Default ON per explicit user decision 2026-07-07 (see
  // claude-plans/release-readiness-report-20260707.md §4.3) — the author's
  // own initial recommendation was default OFF, overridden by the user.
  // ──────────────────────────────────────────────────────────────────
  RELEASE_NARRATIVE_ENABLED: z.string().transform(v => v === 'true').default('true'),
  // Text-only model — the narrative call never receives images.
  RELEASE_NARRATIVE_MODEL: z.string().default('gemini-2.5-flash-lite'),

  // ──────────────────────────────────────────────────────────────────
  // Visual anomaly sweep — ADR-0012. Sampled vision-LLM pass over
  // already-stored step screenshots, looking for "common sense" defects
  // (placeholder text, broken images, structurally broken layout) no
  // specific assertion was written to catch. Default ON per the same
  // 2026-07-07 user decision as the narrative flags above.
  //
  // VISUAL_ANOMALY_MIN_RECURRENCE defaults to 1 (surface on first
  // detection) per explicit user decision 2026-07-10, overriding this
  // plan's original default of 2 (a cross-run recurrence gate, since a
  // single run's vision call was judged the least reliable signal in the
  // whole design). The gate mechanism itself is untouched — the DB status
  // enum still has 'below_threshold', VISUAL_ANOMALY_RECURRENCE_WINDOW_DAYS
  // still applies, and the value here is still fully configurable back up
  // — only the default changed.
  // ──────────────────────────────────────────────────────────────────
  VISUAL_ANOMALY_SWEEP_ENABLED: z.string().transform(v => v === 'true').default('true'),
  VISUAL_ANOMALY_SAMPLE_STRATEGY: z.enum(['final_and_failure', 'final_only', 'all_failures']).default('final_and_failure'),
  VISUAL_ANOMALY_MAX_SCREENSHOTS: z.string().transform(Number).default('2'),
  VISUAL_ANOMALY_MODEL: z.string().default('gemini-2.5-flash'),
  VISUAL_ANOMALY_MIN_RECURRENCE: z.string().transform(Number).default('1'),
  VISUAL_ANOMALY_RECURRENCE_WINDOW_DAYS: z.string().transform(Number).default('30'),

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

  // When `true` (default), an uploaded API spec / archive / Python source
  // (or a pasted cURL / Python script / Swagger URL) force-routes to the
  // api_flow_test handler instead of relying on the LLM intent classifier —
  // which is blind to attachments and silently sends a files-only upload to
  // general_chat (no flow ever built). Set to `false` to revert to
  // classifier-only routing.
  API_FLOW_FORCE_ROUTE: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

  // When `true` (default), a mobile-agent turn whose REPLY claims a step-level
  // draft revision ("changed step 5", "kept steps 1-3") while emitting NO draft
  // gets one forced extra tool round to actually emit it. Without this the
  // chat's changelog and the draft card disagree, and Save persists the card —
  // so a user who reads the reply saves the OLD steps believing they saved the
  // new ones. Costs at most one extra LLM round per turn, and only on a turn
  // that already made the claim. Set to `false` to disable the extra round.
  MOBILE_DRAFT_CLAIM_RECONCILE: z.string().transform(v => v.trim().toLowerCase() !== 'false').default('true'),

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

/**
 * ENCRYPTION_SECRET derives the AES-256-GCM key protecting everything stored
 * at rest and recoverable: `test_resources.sensitive` (login storageState,
 * TOTP seeds, credential maps) and `test_credentials`. Running production on
 * the schema default means every one of those envelopes is encrypted under a
 * key that is public in this repo.
 *
 * WARN, not exit: a hard failure here would refuse to boot an environment
 * that is already running on the default, and rotating the key makes anything
 * already encrypted under it undecryptable. Setting the real value in the
 * infra env + a data migration must come first — tracked as follow-up work.
 * Until then this line is the loud, greppable signal that the hole is open.
 */
if (parsedEnv.NODE_ENV === 'production') {
  const usingDefaultEncryptionKey =
    !parsedEnv.ENCRYPTION_SECRET ||
    parsedEnv.ENCRYPTION_SECRET === 'change-this-secret-in-production-minimum-32-characters';
  if (usingDefaultEncryptionKey) {
    console.error(
      '❌ SECURITY: ENCRYPTION_SECRET is unset or still the built-in default in production. ' +
      'Stored credentials and login state are encrypted with a publicly-known key. ' +
      'Set a high-entropy ENCRYPTION_SECRET in the infra environment (qait-infra/azure/terraform/.env) — ' +
      'note that rotating it makes existing encrypted rows undecryptable, so plan the migration.',
    );
  }
}

export const env = parsedEnv;

// Type-safe environment configuration
export type EnvConfig = typeof env;

// Helper functions
export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
