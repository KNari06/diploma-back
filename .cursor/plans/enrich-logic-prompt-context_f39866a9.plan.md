---
name: Enrich-logic-prompt-context
overview: Enhance page+logic prompts with richer context to improve causal understanding, navigation decisions (e.g., skip onboarding to reach registration), and proactive user clarification when data is missing.
todos:
  - id: audit-flow
    content: Review current logic prompt inputs in analyzer/analyzeLogic
    status: completed
  - id: audit-page-prompt
    content: Review current buildPageAnalysisPrompt outputs and gaps
    status: completed
  - id: design-fields
    content: Define added fields & aggregation for page+logic prompts
    status: completed
  - id: update-prompt
    content: Revise buildLogicAnalysisPrompt template/schema
    status: completed
  - id: update-page-prompt
    content: Enrich buildPageAnalysisPrompt outputs for downstream logic (CTA detection, payment/onboarding detection via Vision AI)
    status: completed
  - id: error-collector-service
    content: Create ErrorCollectorService for console/network/UI/accessibility errors
    status: completed
  - id: wire-context
    content: Pass richer context into analyzeLogic and page prompt call sites
    status: completed
  - id: context-compression
    content: Add smart context compression utility for large prompts (summarize old history if >8000 tokens)
    status: completed
  - id: clarify-user
    content: Add user-clarification step when critical data (URLs/creds/test data) is missing
    status: completed
  - id: websocket-clarification
    content: Implement WebSocket events for clarification (test:clarification:request/response)
    status: completed
  - id: clarification-handler
    content: Add handler for waiting and processing user clarification responses
    status: completed
  - id: edge-cases
    content: "Validate cases: onboarding skip, paywall/captcha, empty page, multi-step forms"
    status: completed
---

## Goal

Improve `buildPageAnalysisPrompt` and `buildLogicAnalysisPrompt` so the system has richer, structured context (goal, history, navigation hints, critical elements, warnings/modals, CTA summary, UI/UX/console/network signals, payment blockers) and can proactively ask the user for missing critical data. This should help infer action sequences, when to skip/continue (e.g., onboarding vs registration), and when to stop at payment steps.

## Plan

1. Audit current data flow (read-only)

- Confirm what `analyzeLogic` receives and passes to `buildLogicAnalysisPrompt` in [`src/agent/intelligent-page-analyzer.ts`](src/agent/intelligent-page-analyzer.ts).
- Note available fields in `PageContext` and state (goal, history, vision.description, warnings/modals, criticalElements, DOM buttons/links/forms, nav candidates like skip/next/continue/login/register).
- Review current `buildPageAnalysisPrompt` inputs/outputs and how Vision results are parsed and sanitized for selectors/modals.

2. Design enriched prompt inputs

- Define additional fields to pass to both prompts: `goal`, `historySummary` (recent actions/pages/errors), `pageDescription` (vision), `warnings/modals`, `criticalElements`, `navButtonsSummary` (CTA/skip/next/continue/register/login/skip onboarding), `formsSummary` (required fields/disabled), `url/meta` (title/host/path), `hints` (from test plan), UI/UX/console/network signals, payment blockers, and indicators for empty/blocked pages.
- Specify concise aggregation (counts + key texts/selectors) to avoid token bloat.
- **CTA/Payment/Onboarding Detection**: Trust Vision AI to identify these patterns. Extend `PageElement` interface in [`src/agent/types/intelligent-testing.types.ts`](src/agent/types/intelligent-testing.types.ts) with `isCTA?: boolean` field. Update `buildPageAnalysisPrompt` to explicitly ask Vision AI to mark CTA buttons, payment forms, and onboarding pages.
- **Error Collection**: Create separate `ErrorCollectorService` in [`src/agent/utils/error-collector.service.ts`](src/agent/utils/error-collector.service.ts) to collect console.errors, network failed requests (404, 500, timeout), UI errors (red error texts), and accessibility warnings. Integrate with page listeners in `IntelligentTestOrchestrator`.

3. Update logic prompt builder (no code yet)

- Expand `buildLogicAnalysisPrompt` template to include new sections (Goal, History, Navigation cues, Forms/required/disabled, Modals/Warnings, Critical elements, CTA summary, Page description/meta, Hints, Error signals).
- Tighten response schema to optionally include `skipHints`/`navigationActions` if needed.
- Include explicit guidance for: onboarding skip when goal is registration; booking/payment flows where automation should stop and ask for human/test data; when to ask the user for missing URL/credentials/test data.
- **Smart context compression**: Use full context by default, but if prompt exceeds ~8000 tokens (estimated), apply intelligent summarization:
  - Keep recent pages/actions (last 5-10) in full detail
  - Summarize older history (pages visited >10 iterations ago) into concise summary
  - Always keep: goal, current page context, recent errors, critical elements
  - Use AI summarization for old history if needed (optional, can use simple truncation first)

4. Update call site wiring (no code yet)

- Prepare to pass new fields from `analyzeLogic` using existing context/state (goal, recent actions/pages/errors, vision/dom summaries, hints if available, nav CTA extraction).
- Ensure fallbacks (empty arrays/strings) to keep prompt stable.
- Add pass-through of richer Vision outputs from `buildPageAnalysisPrompt` to logic prompt (CTA summary with `isCTA` flags, blockers, payment/onboarding detection, UI/UX/console/network signals from ErrorCollectorService).
- Add a user-clarification trigger when critical data is missing (URL, credentials, payment/test data) before proceeding.
- Integrate ErrorCollectorService results into PageContext for logic analysis.
- **Smart context compression**: Create utility function `compressContextForPrompt()` in [`src/agent/utils/context-compressor.ts`](src/agent/utils/context-compressor.ts) that:
  - Estimates token count of prompt (rough: ~4 chars per token)
  - If >8000 tokens: keep recent 5-10 pages/actions in full, summarize older history
  - Always preserve: goal, current page, recent errors, critical elements
  - Use simple truncation first (keep last N items), AI summarization as fallback if still too large
  - Apply compression before building `buildLogicAnalysisPrompt` and `buildActionGenerationPrompt`

5. WebSocket clarification mechanism

- Add new Server → Client event `test:clarification:request` in [`src/websocket/types.ts`](src/websocket/types.ts):
  ```typescript
  'test:clarification:request': (data: {
    testId: string;
    questionId: string; // unique ID for this question
    question: string;
    type: 'url' | 'credentials' | 'test_data' | 'payment_approval';
    required: boolean;
    options?: string[]; // optional predefined choices
    timeout?: number; // max wait time in ms
  }) => void;
  ```

- Add new Client → Server event `test:clarification:response` in [`src/websocket/types.ts`](src/websocket/types.ts):
  ```typescript
  'test:clarification:response': (data: {
    testId: string;
    questionId: string; // matches request questionId
    answer: string;
  }) => void;
  ```

- Add handler in [`src/websocket/handlers/subscription.handler.ts`](src/websocket/handlers/subscription.handler.ts) to process `test:clarification:response` events.

- Add clarification service/helper in [`src/agent/utils/clarification.service.ts`](src/agent/utils/clarification.service.ts) to:

  - Emit clarification request via WebSocket
  - Wait for user response (with configurable timeout, default 60s)
  - Store pending questions per testId (in-memory Map or Redis for multi-instance)
  - Resume test execution with received answer
  - Handle timeout: retry question once (1 retry), then use fallback or stop test
  - Support configurable timeout via `IntelligentTestConfig` or environment variable

- Integrate clarification trigger in `decideNextStep` when `wait_for_user` decision is made:

  - Detect what data is missing (URL, credentials, test data, payment approval)
  - Emit `test:clarification:request` with appropriate question
  - Pause test execution (set flag or use Promise-based wait)
  - Resume when `test:clarification:response` received or timeout

- Add clarification payload types in [`src/websocket/types.ts`](src/websocket/types.ts):
  ```typescript
  export interface TestClarificationRequestPayload {
    testId: string;
    questionId: string;
    question: string;
    type: "url" | "credentials" | "test_data" | "payment_approval";
    required: boolean;
    options?: string[];
    timeout?: number;
    timestamp: string;
  }
  
  export interface TestClarificationResponsePayload {
    testId: string;
    questionId: string;
    answer: string;
    timestamp: string;
  }
  ```

- Add WebSocketService method `emitTestClarificationRequest()` in [`src/websocket/websocket.service.ts`](src/websocket/websocket.service.ts).

- Update Redis subscriber to handle clarification events in [`src/websocket/redis-subscriber.ts`](src/websocket/redis-subscriber.ts).

6. Edge-case coverage checklist

- Onboarding/welcome flow with Skip/Next → recommend skipping when goal is registration.
- Paywall/captcha/modal without close → classify as blocker.
- Empty/blocked pages → suggest navigation CTA if present, else stop/skip.
- Multi-step forms (requiredBeforeMain) → enforce required/disabled logic from DOM.
- A/B or redirect loops → use history/visited pages to avoid cycles.
- Booking/checkout flows → stop before payment, request test/payment data or human approval via clarification.
- UI/UX/console/network error signals → surface in warnings/blockers when relevant.
- Missing URL for flow → ask user via clarification before proceeding.
- Missing credentials → ask user via clarification before login/registration.
- Missing test data → ask user via clarification before form submission.

(Execution will involve editing prompt + analyzeLogic wiring + WebSocket clarification mechanism once plan is approved.)