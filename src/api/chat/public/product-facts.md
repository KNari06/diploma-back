<!--
  PRODUCT FACTS — source of truth for the public "Ask Me Anything" B2C widget.

  This file is read at runtime by public-chat.controller.ts and injected into
  the assistant's system prompt. The bot answers ONLY from what is written here
  (plus general product framing). It does NOT execute tests, call tools, or
  invent pricing/limits.

  HOW TO EDIT:
  - Replace every {{PLACEHOLDER}} with real, approved values.
  - Keep it factual and concise — short bullet points answer best.
  - If a number isn't final, leave the "book a demo" guidance instead of guessing.
  - No secrets, no internal-only info — this content is effectively public.
  - Plain Markdown only. Edits take effect on next server start (cached in memory).

  NOTE: Content below was drafted from the public landing page copy (hero,
  product, enterprise, FAQ). Pricing & hard limits are intentionally left as
  guidance ("book a demo") because the landing states no concrete prices —
  fill {{PLACEHOLDERS}} once final numbers are approved.
-->

# QAIT — Product Facts

## What is QAIT
QAIT is an AI-powered QA platform that automates web, mobile, and API testing.
You describe what to test in plain English and QAIT turns it into test cases,
runs them in real browsers and on real devices, analyzes failures, and can file
bug tickets automatically. It replaces brittle test scripts and manual
regression with an AI QA team that runs 24/7.

## Key features
- One prompt, full regression: describe a release in plain English and QAIT
  generates many test cases across web and mobile — no scripts, no selectors.
- Self-healing selectors: tests adapt automatically when layouts, data-testids,
  or IDs change, cutting maintenance toward zero.
- Catches visual regressions, broken flows, and silent console errors before
  they reach production.
- Parallel execution across browsers, devices, and environments — full
  regression in minutes (≈10× faster release cycles).
- A team of specialized AI agents that plan, explore, test, analyze, and report,
  and learn your product over time.
- AI chat: describe a test in natural language and QAIT creates and runs it.
- Smart failure analysis: explains *why* a test failed (UI state, intent,
  context) instead of surfacing brittle-selector noise.

## Platforms supported
- Web — all major modern browsers (Chrome, Firefox, Safari, Edge). Primary focus
  during early access.
- API — endpoint testing.
- Mobile (iOS and Android) — supported on real devices; expanding through the
  roadmap. If asked whether a specific mobile capability is live, suggest a demo
  to confirm current coverage.

## Integrations
- Jira — automatic bug-ticket creation.
- CI/CD pipelines — runs as part of your CI/CD workflow; deeper integrations
  (e.g. GitHub Actions, GitLab CI) are on the roadmap.
- Other tools (GitHub, Slack, Notion, Linear, Telegram) are referenced on the
  roadmap/marketing — if asked, say they're planned/early and suggest a demo to
  confirm current status. Do not promise availability.

## Pricing
<!-- The landing page states NO concrete prices. Do not invent any. Fill these
     once approved; until then the bot will guide users to a demo. -->
- Plans & prices: {{PLAN_NAMES_AND_PRICES}}
- Billing model: {{USAGE_OR_SEAT_BASED}}
- Free trial: available during early access, no credit card required. It gives
  access to QAIT's core capabilities as they roll out.
- For an exact quote tailored to your team, the fastest path is to book a demo
  or contact the QAIT team.

## Limits
<!-- No hard per-plan limits are published on the landing page. Keep generic
     until finalized; fill in when approved. -->
- Concurrent / parallel runs: runs execute in parallel across browsers, devices,
  and environments. Exact per-plan concurrency: {{CONCURRENCY_LIMIT}}
- Monthly run / credit limits: {{MONTHLY_RUN_LIMIT}}
- Team seats: {{SEAT_LIMIT}}

## Security (Enterprise)
- Encrypted connections and modern security best practices from day one.
- SOC 2-aligned infrastructure, SSO/SAML, audit logs, and data-residency
  controls are part of the enterprise offering.
- Your code and customer data stay under your control.

## Getting started
- Start free during early access — no credit card required.
- Sign up at {{SIGNUP_URL_OR_INSTRUCTIONS}}, or book a demo (the quickest way to
  see QAIT on your own product). Enterprises can contact sales.

## FAQ
**Q: How does AI-powered testing work?**
A: QAIT analyzes your app the way a human tester does — understanding the UI and
user intent rather than just code or selectors. It generates stable scenarios
from real behavior and adapts as your UI evolves, reducing flaky failures.

**Q: Do I need coding skills?**
A: No. You describe what the user should do in plain English and QAIT turns that
into executable test steps. Technical teams can also customize and go deeper.

**Q: What browsers and devices are supported?**
A: All major modern browsers (Chrome, Firefox, Safari, Edge). Web is the primary
focus during early access; mobile testing for iOS and Android is supported and
expanding through the roadmap.

**Q: How are test failures handled?**
A: QAIT focuses on *why* a test failed — analyzing UI state, user intent, and
execution context, and highlighting what changed versus expected behavior.

**Q: Can I integrate with my CI/CD pipeline?**
A: Yes. QAIT is designed to run as part of CI/CD. Early access focuses on simple,
reliable integration; deeper integrations are on the roadmap.

**Q: What's included in the free trial?**
A: During early access, the free trial gives access to QAIT's core capabilities
as they become available — no credit card required.

**Q: How secure is my data?**
A: QAIT uses encrypted connections and modern security best practices, and is
building toward industry-standard security and compliance frameworks.
