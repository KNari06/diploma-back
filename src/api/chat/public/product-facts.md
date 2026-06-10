<!--
  PRODUCT FACTS — source of truth for the public "Ask Me Anything" B2C widget.

  Read at runtime by public-chat.controller.ts and injected into the assistant's
  system prompt. The bot answers ONLY from what is written here. It does NOT
  execute tests, call tools, or invent pricing/limits.

  HOW TO EDIT:
  - Keep it factual and concise — short bullets answer best.
  - Pricing is API-driven on the site and may change; figures below are the
    current public plan prices. The bot points users to /pricing for live numbers.
  - No secrets, no internal-only info — this content is effectively public.
  - Plain Markdown only. Edits take effect on next server start (cached in memory).

  Sourced from the qai-frontend landing/pricing/FAQ copy (Jun 2026).
-->

# QAIT — Product Facts

## What is QAIT
QAIT is an AI-powered QA platform that automates web, API, and mobile testing.
You describe what to test in plain English; QAIT understands the UI and user
intent — not just code or selectors — generates stable test scenarios, runs them,
analyzes failures, and can file bug tickets automatically. It replaces brittle
scripts and manual regression with an AI QA team. The product is currently in
early access. Its interface is available in English, Russian, and Kazakh.

## Key features
- One prompt → full regression: describe a release in plain English, no scripts
  or selectors needed.
- AI that tests like a human: understands UI + user intent, adapts as the UI
  evolves (self-healing), which reduces flaky failures.
- **Autonomous exploration**: point QAIT at your product and an AI agent explores
  it on its own — it maps the pages, discovers the key user flows and entry
  points, prioritizes what matters, then generates and runs test cases for those
  flows automatically. You don't have to list the test cases yourself.
- Web UI testing, API testing, and API-flow testing (from a Swagger/OpenAPI/
  Postman spec or cURL commands).
- Regression suites, test plans, modules, and tags; scheduled (cron) runs.
- Failure analysis (root-cause: explains WHY a test failed), flaky-test
  detection, coverage-gap analysis, and "what to test next" recommendations.
- Catches visual regressions, broken flows, and silent console errors.
- Tests flows behind a login: you can save a login once and QAIT reuses it to
  test authenticated pages (it also supports environments and secret values).
- Parallel runs across browsers and environments (≈10× faster execution).
- No coding required — though technical teams can customize and go deeper.
- Quick to start: sign up free (no credit card), then either describe a test in
  plain English or let QAIT explore your app and generate tests — no install or
  scripting to get a first test running.

## Platforms supported
- Web — all major modern browsers: Chrome, Firefox, Safari, Edge. Primary focus
  during early access.
- API — endpoint and API-flow testing.
- Mobile — iOS and Android, on both real physical devices and emulators/
  simulators. Mobile is newer and expanding; for a specific mobile capability or
  device, suggest confirming current status via a demo.

## Pricing
Plans (monthly; annual billing is ~15% cheaper). Pricing is shown live on the
/pricing page and may change — point users there or to a demo for exact, current
figures.
- **Free** — $0, no credit card. A free tier to try QAIT, with a small daily +
  monthly credit allowance for evaluation. (Exact free-tier credits are shown on
  /pricing.)
- **Pro** — $19/month, ~3,800 credits/month. (Most popular.)
- **Pro 5x** — $49/month, ~10,000 credits/month.
- **Max 10x** — $99/month, ~20,000 credits/month.
- **Ultra / Business** — custom pricing, contact the team.
- Annual plans get roughly a 15% discount vs monthly.
- You can change or cancel your plan anytime; if you cancel you keep access until
  the end of the current billing period.

## Limits
- Team members: Free includes unlimited collaborators; Pro tiers include up to
  10 team members; Ultra/Business is custom (contact the team).
- Usage is measured in credits — each plan includes a monthly credit allowance.
  Rough credit costs: a chat message ≈ 1 credit; an API test ≈ 2 credits; a UI /
  AI test is billed per step (about 1 credit per action it performs). So a short
  test costs a few credits and a long multi-step flow costs more. For exact,
  current costs and your plan's allowance, point users to /pricing or a demo.

## Integrations
- **Jira** — available; automatic bug-ticket creation / sync.
- **GitHub** — coming soon (trigger regression runs on commits and PRs).
- **Slack** — coming soon (notifications and alerts in channels).
- **CI/CD** — runs as part of your CI/CD workflow; deeper integrations
  (GitHub Actions, GitLab CI, etc.) are on the roadmap.
Don't promise availability for anything marked "coming soon" — say it's planned
and offer a demo to confirm current status.

## Security
- Encrypted connections and modern security best practices from day one.
- Enterprise: SOC 2-aligned infrastructure, SSO/SAML, audit logs, and data
  residency controls. Your code and customer data stay under your control.
- Building toward industry-standard security and compliance frameworks as the
  product scales.

## Getting started
- Sign up at /signup. No credit card required to start on the free tier.
- See live pricing at /pricing.
- For Ultra/Business, enterprise needs, or to talk to the team: /contact-sales
  (or email yera@qait.dev).
- Booking a demo is the quickest way to see QAIT on your own product.

## FAQ
**Q: How does AI-powered testing work?**
A: QAIT analyzes your app the way a human tester does — understanding the UI and
user intent rather than just code or selectors. It generates stable scenarios
from real behavior and adapts as your UI evolves, reducing flaky failures.

**Q: Do I need coding skills?**
A: No. You describe what the user should do in plain English and QAIT turns that
into executable test steps. Technical teams can also customize and go deeper.

**Q: Do I have to write the test cases myself?**
A: No — QAIT can explore your product on its own. Point it at your app and an AI
agent maps the pages, finds the important user flows, and generates and runs test
cases for them automatically. You can also describe specific tests in plain
English if you prefer.

**Q: What browsers and devices are supported?**
A: All major modern browsers (Chrome, Firefox, Safari, Edge) for web. For mobile,
QAIT runs on iOS and Android — on both real physical devices and emulators/
simulators. Mobile coverage is newer and expanding; confirm a specific device via
a demo.

**Q: How are test failures handled?**
A: QAIT focuses on WHY a test failed — analyzing UI state, user intent, and
execution context, and highlighting what changed vs expected behavior.

**Q: Can I integrate with my CI/CD pipeline?**
A: Yes. QAIT is designed to run as part of CI/CD. Early access focuses on simple,
reliable integration; deeper integrations are on the roadmap.

**Q: What's included in the free trial?**
A: During early access, the free tier gives access to QAIT's core capabilities
as they roll out — no credit card required.

**Q: How secure is my data?**
A: QAIT uses encrypted connections and modern security best practices, and is
building toward industry-standard security and compliance frameworks.

**Q: Can it test pages behind a login / does it handle authentication?**
A: Yes. You can save a login once and QAIT reuses it to test authenticated pages,
and it supports per-environment values and secrets. For a specific auth setup
(SSO, MFA, etc.), confirm details via a demo.

**Q: What does a credit mean / how much does a test run cost?**
A: Credits are QAIT's unit of usage. As a rough guide: a chat message is about 1
credit, an API test about 2, and a UI/AI test is billed per step (~1 credit per
action), so a short test is a few credits and a longer flow is more. Each plan
includes a monthly allowance — see /pricing for exact, current numbers.

**Q: What languages does QAIT support?**
A: The QAIT interface is available in English, Russian, and Kazakh.

**Q: Can I cancel or change my plan anytime?**
A: Yes. You can change or cancel anytime; if you cancel, you keep access until
the end of your current billing period.
