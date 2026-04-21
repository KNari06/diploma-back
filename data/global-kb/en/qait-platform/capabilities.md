# QAIT Platform Capabilities

QAIT is an AI-powered QA automation platform. It runs real tests on real browsers against real endpoints and returns real results. It is not a simulator.

## Test Execution

- UI tests on Chromium, Firefox, WebKit with live video streaming, screenshots, network logs, console logs
- API tests against any HTTP endpoint with automatic edge-case and security fuzzing
- Difficulty levels: light (fast smoke), medium (typical flows), hard (deep exploration)
- Test cases can be created, updated, deleted, bulk-tagged (up to 50 at a time)
- Organize tests into modules, flows, and regression plans
- Run a single test, a module, a flow, an entire regression plan, or filter by tag/priority

## Live Editor

- Control a real browser via chat (click, type, scroll)
- Record actions as reusable test steps
- Full DevTools access (HTML, accessibility tree, console, network)
- Rerecord individual steps without rebuilding the whole test

## AI Analysis

- Root-cause analysis for failed tests with severity and fix suggestions
- Test recommendations based on coverage gaps, recent failures, and usage patterns
- Coverage scoring (0–100) with stale-test detection
- Flaky test detection with flakiness rate
- Critical-path health monitoring (highest-priority tests first)

## Scheduling

- Cron-based recurring runs with timezone support
- Activate, deactivate, update, delete schedules
- Linked to regression plans, modules, or individual tests

## Analytics

- Pass/fail rates, average duration, top failures, heatmaps, time series
- Deployment tracking: webhook events linked to post-deploy test results
- AI token usage and cost tracking per workspace

## Knowledge Base

- Upload project docs (PDF, DOCX, TXT, MD, JSON, YAML/YML) for context-aware answers
- Format-aware ingestion: OpenAPI/Swagger specs become one chunk per endpoint + one per schema; Postman collections become one chunk per request (including GraphQL queries and test scripts); generic text/markdown fall back to section-based chunking
- Re-uploading the same filename creates a new version (v2, v3, ...) and retires the previous one atomically — retrieval only serves the current version, history is preserved for audit
- Retrieval is automatic during chat and test generation; responses include structured citations (file name, version, upload date) so users can trace why an answer was given
- Global KB is curated by admins; project KB is per-project and writable by the owner
- Hybrid retrieval (vector + BM25 keyword) with parent-section expansion for richer context

## Auto-Learn from Test Runs

- Optional per-project feature: after each successful test run, QAIT extracts stable facts from the trace (URL, clicked element role/name, API call + status) and stores them as auto-learned knowledge
- Dedup via fingerprint — the same interaction re-confirmed across runs updates `last_confirmed_at` instead of duplicating
- TTL: facts not re-confirmed within 30 days retire automatically (still visible in history, removed from retrieval)
- When AI answers questions about a page, it sees the actual selectors and APIs that worked in real runs — not just uploaded documentation
- Toggle per project; purge on disable if the owner wants an immediate clean slate

## Persistent Memory

- Remembers user preferences, working test patterns, and known bug patterns across conversations
- Semantic search over saved facts
- Can forget outdated information on request

## Safety Model

All write operations require explicit user approval before execution. Destructive actions (delete, overwrite) are warned as permanent.
