-- ─────────────────────────────────────────────────────────────────────────────
-- Pricing feature copy cleanup — Free / Pro / Business (June 2026)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Fixes content/bugs in the pricing_plans.features arrays surfaced on the live
-- pricing page (features are rendered raw from the DB by the API branch of
-- PricingSection — no i18n yet, so the DB string IS what users see):
--
--   Free    : dropped the misleading "All features included" (Free has NO
--             mobile / multi-browser / parallelism / team workspaces — all of
--             those live in Pro/Business). Replaced with an honest short list.
--   Pro     : removed "Up to 3,000 AI credits per month" — stale and wrong
--             (B2C tiers are 990 / 7000 / 18000, shown via the volume dropdown).
--   Business: (a) "Everything in Pro" moved to the FIRST line; (b) fixed the
--             two features glued into one string
--             ("...onboardingEnterprise-grade SLA...") → split into a single
--             "Dedicated support & onboarding · SLA 99% uptime" line;
--             (c) fixed the double space in "Custom credit  allocation";
--             (d) trimmed the redundant duplicate mobile line + the trailing
--             "(soon)" placeholders for a tight, sales-ready list.
--
-- Additive + idempotent: three targeted UPDATEs of existing rows, no recreation.
-- Mirrors the prod DB change applied the same day. Feature i18n (ru/kk) is a
-- separate follow-up — these strings stay English-only for now, like the rest.

UPDATE public.pricing_plans
SET features = ARRAY[
  '50 one-off trial credits',
  'AI-powered exploration & test runs',
  'Web UI + API testing · Chrome',
  'Email support'
], updated_at = NOW()
WHERE slug = 'free';

UPDATE public.pricing_plans
SET features = ARRAY[
  'Create tests with AI agent',
  'Autonomous test execution',
  'Web UI + API testing',
  'Run up to 1 test in parallel',
  'Real-time test visualization',
  'Regression plans & test suites',
  'Chrome browser testing',
  'Scheduled test runs',
  'Advanced analytics',
  'Git-triggered test automation',
  'Slack & Telegram notifications',
  'Jira integration (Trello, Notion soon)',
  'Priority email support'
], updated_at = NOW()
WHERE slug = 'pro';

UPDATE public.pricing_plans
SET features = ARRAY[
  'Everything in Pro',
  'AI QA multi-agent infrastructure layer',
  'Multi-browser testing (Chrome, Safari, Edge)',
  'Mobile app & viewport testing',
  'Run up to 10 tests in parallel',
  'Team workspaces with role management',
  'Custom knowledge base + continuous AI learning',
  'Custom credit allocation',
  'Dedicated support & onboarding · SLA 99% uptime',
  'Enterprise integrations & API access'
], updated_at = NOW()
WHERE slug = 'ultra';
