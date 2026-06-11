-- Mirror the prod-only Stripe billing schema into the repo.
--
-- BACKGROUND: the `plans` table and the `users.stripe_*` columns have lived in
-- prod since 2026-01 but were never captured in a repo migration (schema
-- drift). The entire Stripe controller (src/api/stripe/stripe.controller.ts)
-- depends on them. This migration documents and reproduces that schema so a
-- fresh DB (CI, staging, a new env) matches prod. It is purely additive and
-- idempotent — every statement is IF NOT EXISTS guarded and will no-op against
-- the live prod DB where these objects already exist.
--
-- Schema verified live via Supabase MCP against project hzfcvwqjvdmynpqyjhls
-- on 2026-05-30. DO NOT recreate or alter existing rows — real paying users
-- exist (4 with stripe_customer_id, 20 with subscription).
--
-- `plans` holds purchasable credit-volume variants; each row points at a
-- pricing_plans row via plan_id. Stripe checkout looks plans up by `code`;
-- the invoice webhook looks them up by `stripe_price_id`.

-- 1. plans table — PK on code, UNIQUE on stripe_price_id, FK to pricing_plans
CREATE TABLE IF NOT EXISTS public.plans (
  code               text PRIMARY KEY,
  stripe_price_id    text NOT NULL UNIQUE,
  credits_per_period integer NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  plan_id            uuid REFERENCES public.pricing_plans(id) ON DELETE SET NULL
);

-- 2. Stripe identity columns on users (all nullable, no default — matches prod)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id    text,
  ADD COLUMN IF NOT EXISTS subscription       jsonb;
-- users.plan_id already added by 20241117_pricing_plans_migration.sql.

COMMENT ON TABLE public.plans IS
  'Stripe-purchasable credit-volume variants. code = checkout key, stripe_price_id = Stripe Price, credits_per_period = credits granted per billing period, plan_id -> pricing_plans.id. Mirror of prod schema (see 20260602 migration header).';
