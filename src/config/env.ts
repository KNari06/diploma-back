import crypto from 'crypto';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

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
  REDIS_URL: z.string().default('redis://35.202.242.230:6379'),
  REDIS_HOST: z.string().default('35.202.242.230'),
  REDIS_PORT: z.string().transform(Number).default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  OPENAI_MAX_TOKENS: z.string().transform(Number).default('4000'),

  // Queue
  QUEUE_CONCURRENCY: z.string().transform(Number).default('5'),
  QUEUE_RETRY_ATTEMPTS: z.string().transform(Number).default('3'),
  QUEUE_RETRY_DELAY: z.string().transform(Number).default('5000'),

  // Agent
  AGENT_TIMEOUT: z.string().transform(Number).default('300000'),
  AGENT_MAX_RETRIES: z.string().transform(Number).default('3'),
  AGENT_BASE_URL: z.string().default('http://localhost:3001'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FORMAT: z.enum(['combined', 'common', 'dev', 'short', 'tiny']).default('combined'),

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

  // Integrations
  JIRA_CLIENT_ID: z.string().optional(),
  JIRA_CLIENT_SECRET: z.string().optional(),
  JIRA_CALLBACK_URL: z.string().url().optional(),
  JIRA_BASE_URL: z.string().optional(),
  JIRA_USERNAME: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
});

// Parse and validate environment variables
const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parseResult.error.format());
  process.exit(1);
}

// Generate secrets for development if not provided
let parsedEnv = parseResult.data;

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
