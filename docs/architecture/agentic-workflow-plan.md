# From Today's Code to a Real Agentic QA Workflow

> Status: investigation + design. No code changes proposed in this document.
> Every claim below is anchored to a file path + line in the current tree.
> If a statement here disagrees with the code, **trust the code** and update this doc.

---

## 0. Why this document exists

You asked the right uncomfortable question: *do we already have an agent, and does it see the whole picture?*

After reading the code, the honest answer is two-part:

1. **An agentic runtime already exists.** It lives in [src/api/chat/general/sub-agents/](../../src/api/chat/general/sub-agents/) — Router → Planner → Executor → Reviewer → Responder, with a Blackboard, parallel sub-executors, circuit breaker, loop detection, and 97 callable tools across a skill registry.
2. **It is wired to exactly one of seventeen intent branches.** The other sixteen (`platform_test`, `mobile_test`, `api_test`, `run_regression`, `editor_action`, …) bypass the agent entirely and run hardcoded handlers. The agent literally cannot start a test today.

So the work is not "build an agent." The work is:

- finish wiring what's already there,
- give it durable state per mission,
- thread context that's collected but discarded,
- put a control plane around it.

Everything in this document is sized accordingly: most steps are deletions and consolidations, not new modules.

**How to read this document — two stages:**

The work splits cleanly into two stages. Stage 2 *requires* Stage 1 to land first; it cannot ship standalone because it relies on the mission orchestrator, the tool registry, and the unified pipeline introduced in Stage 1.

- **Stage 1 — Agentic workflow runtime** (§1-§12): turn today's mixed architecture into one durable, tool-driven agent that can run any QA mission. This is the engineering backbone.
- **Stage 2 — User-facing surface on top of Stage 1** (§13-§14): how a new user actually meets that agent and walks away with a tangible result in <5 minutes. Mission #0 (guided chat onboarding) + Workflow object (packaged output).

**Section map:**
- §1 — what's in our code today, verified
- §2-§3 — the actual bugs and gaps
- §4 — **research foundations** (industry-settled patterns + standards in 2026) — every architectural choice below references this section
- §5 — target architecture (Stage 1)
- §6 — phased migration (Stage 1); each phase explicitly cites which §4 pattern it implements
- §7-§10 — walk-through, what stays, risks, timeline (Stage 1)
- §11 — **behavioral spec** (20 scenarios) — acceptance test suite spanning both stages
- §12 — user impact in one sentence (Stage 1 outcome)
- §13 — **Stage 2: Fast Onboarding** (Mission #0, guided chat, hybrid rails — pattern R8)
- §14 — **Stage 2: Workflows** (how agent output is packaged as a first-class user object)

---

## 1. What exists today, in code

Verified counts (May 2026):

| Surface | Count | Source |
|---|---|---|
| Chat routes | 12 | [chat.route.ts](../../src/api/chat/chat.route.ts) |
| Intent branches in routing switch | 17 | [routing.ts:125-160](../../src/api/chat/shared/routing.ts) |
| Intent handlers in registry | 17 | [handler-registry.ts:4-21](../../src/api/chat/shared/handler-registry.ts) |
| BullMQ workers in worker process | 12 | [worker/index.ts](../../src/worker/index.ts) |
| QueueManager job types | 12 | [queues.ts:461-844](../../src/config/infrastructure/queues.ts) |
| Skill manifest entries | 8 | [skills/manifest.ts:18-34](../../src/services/skills/manifest.ts) |
| Callable tools registered (sum across skills) | **97** | qa(49) + jira(12) + notion(10) + github(8) + telegram(8) + slack(7) + kb(2) + memory(1) |
| Sub-agents in pipeline | 6 | router, planner, executor, sub-executor, reviewer, responder, step-validator |

### 1.1 The two architectures running side by side

There are **two distinct runtime styles** inside one chat controller. This is the single most important fact in the codebase.

```
POST /api/v1/chat  ─►  handleChat (chat.controller.ts:52)
                          │
                          ├─ STEP 5  parseIntent  ── LLM #1, classifies into one of 17 labels
                          │                          (intent-parsing.ts, 783 LOC)
                          ▼
                       routeToHandler (routing.ts:15)
                          │
                          ▼
                  switch (intent) {
                    │
                    ├─ general_chat   ─►  SubAgentPipeline.execute()  ◄── AGENT
                    │                     (general/sub-agents/pipeline.ts, 968 LOC
                    │                      + 6 agents + blackboard + spawner)
                    │
                    ├─ platform_test  ─►  ai_test/handler.ts          ◄── HARDCODED
                    ├─ api_test       ─►  api_test/handler.ts         ◄── HARDCODED
                    ├─ mobile_test    ─►  mobile_test/handler.ts      ◄── HARDCODED
                    ├─ mobile_action  ─►  mobile_action/handler.ts    ◄── HARDCODED
                    ├─ mobile_agent   ─►  mobile_agent/handler.ts     (its own mini-pipeline)
                    ├─ editor_action  ─►  editor_action/handler.ts    ◄── HARDCODED
                    ├─ run_regression ─►  regression/run-regression.handler.ts
                    ├─ run_plan       ─►  regression/run-plan.handler.ts
                    ├─ run_module     ─►  regression/run-module.handler.ts
                    ├─ run_by_tag     ─►  regression/run-by-tag.handler.ts
                    ├─ save_test      ─►  regression/save-test.handler.ts
                    ├─ analyze_failure
                    ├─ coverage_analysis
                    ├─ test_recommendations
                    ├─ create_plan
                    └─ add_to_plan
                  }
```

When a user types **"запусти регрессию"** today:

- `parseIntent` (LLM call #1) classifies → `intent = 'run_regression'`.
- Router agent inside the pipeline (LLM call that would have done the same classification) **never runs**.
- The 12 tools for QA execution (49 in `qa.skill.ts`) **never get offered** to anyone.
- The hardcoded handler runs its own logic.

Result: tools and agent are bypassed for every QA-execution intent.

### 1.2 The agent that already works

For `general_chat`, the pipeline is real and quite sophisticated. From [pipeline.ts:80-100](../../src/api/chat/general/sub-agents/pipeline.ts):

```
simple_chat:  Router → Responder                                  (gemini-flash-lite, zero blackboard)
single_tool:  Router → Executor → [Reviewer] → Responder          (filtered tools)
multi_tool:   Router → Planner → Executor(s) → Reviewer → Responder  (planned, possibly parallel)
```

It already has:

- **Blackboard** ([blackboard.ts:35](../../src/api/chat/general/sub-agents/blackboard.ts)) — typed shared state across agents; mutable; per-execute scope.
- **Parallel sub-executors** ([spawner.ts](../../src/api/chat/general/sub-agents/spawner.ts)) — for independent plan steps.
- **Reviewer** (double-blind verification, modeled after LiteEngine's Critic) — verdicts `approved | needs_retry | needs_clarification` with `planCompletionRate`, `failedSteps`, `goalAlignment` scores.
- **Loop detection** (`config.ts:loopDetection.exactRepeatBlock`, `oscillationWindow`).
- **Circuit breaker** ([circuit-breaker.ts](../../src/api/chat/general/sub-agents/circuit-breaker.ts)).
- **Step validator** for editor mode (validates AI-generated IntentSteps before showing to the user).
- **Quick actions injector** for synthesizing UI affordances from tool results.

This is state-of-the-art Plan-and-Execute with a Reflexion-style reviewer — what the papers describe. It's just trapped in `general_chat`.

### 1.3 The execution layer (LiteEngine)

Inside `platform_test` handler, the path lands in:

```
manual-test-run.job.ts → LiteEngine.execute
   → MultiAgentOrchestrator → Observer → Strategist → [Critic.quickSafetyCheck] → Actor → Critic
```

Verified Input shapes from [agents/types.ts](../../src/agent/core/lite/agents/types.ts):

- `ObserverInput` (line 180): `snapshot`, `url`, `title`, `goal`, `previousSnapshot`, `networkActivity`, `lastAction`, `pageMetadata`, `pageStructure`, `blackboard`, `obstacleFacts`, …
- `StrategistInput` (line 394): `observation`, `goal`, `history`, `taskPlanSummary`, `failedActions`, `iteration`, `workingMemory`, `criticFeedback`, `currentUrl`, `urgencyLevel`, …
- `ActorInput` (line 474): `strategy`, `structuredStrategy`, `relevantElements` (top 30), `formAnalysis`, `goal`, `hasCredentials`.
- `CriticInput` (line 536): `proposedCommand`, `actorReasoning`, `goal`, `availableElements`, `observation`, `currentUrl`, `formAnalysis`, `reasoningHistory`, `parsedSnapshot`, …

**Fields NOT present in any of these inputs:** KB chunks, similar past bugs, prior runs of this same test, attached resources (logins/env/secrets), mission/correlation id, budget remaining, Jira ticket text.

This is what we mean when we say "LiteEngine sees only the page." Not metaphorical — literally absent from the type signatures.

### 1.4 Context that is collected and discarded

[jira-qa-orchestrator.service.ts:198-235](../../src/services/integrations/jira-qa-orchestrator.service.ts) does five parallel fetches:

```
Promise.all([
  searchKB(query, projectId, top=5),                       // 5 KB chunks
  TestCaseResolverService.resolve({...}),                  // similar test cases
  searchProjectFindings(query, projectId),                 // past bugs vector match
  WorkspaceMemoryService.getMemoryForContext(ws, 1500),    // user notes
  IntegrationTokenService.getIntegrationSummary(u, ws),    // available channels
])
```

All five are sent to one LLM call ([jira-qa-orchestrator.service.ts:272](../../src/services/integrations/jira-qa-orchestrator.service.ts)) that returns one of three labels (`CAN_RUN_AUTO | NEEDS_REWORK | PREPARE_MANUAL`). After that returns, the context is gone. `createTest({ url, goal, mode, metadata: { sourceJiraIssueKey } })` is enqueued. LiteEngine receives `goal: string` and nothing else from those five sources.

Same pattern in `handleChat`: [chat.controller.ts:390-433](../../src/api/chat/chat.controller.ts) runs `TestCaseResolverService.resolve` and stores `parsedIntent.resolvedContext = { prefilledSteps, sourceTestCases, resolverStrategy }`. Then `routeToHandler` dispatches and the `resolvedContext` is consumed only by the immediate handler — never reaches LiteEngine.

### 1.5 Triggers — only pull

Current entry points that can start agent work:

| Channel | Path | Status |
|---|---|---|
| Web/Desktop chat | `POST /api/v1/chat` → [chat.controller.ts:52](../../src/api/chat/chat.controller.ts) | works |
| Live editor | `WS preview:*` → [websocket/handlers/preview.handler.ts](../../src/websocket/handlers/preview.handler.ts) | works (editor-only, not for missions) |
| Jira board manual | `POST /api/v1/jira/qa-analyze` → [jira.controller.ts:1026](../../src/api/jira/jira.controller.ts) | pull-only |
| Cron scheduler | `setInterval(60s)` in [scheduler/index.ts](../../src/scheduler/index.ts) → `claimDueSchedule` → `RegressionRunService.runPlan` | works (regression schedules) |
| Regression API | `POST /regression/run`, `/run-plan` | works |
| Git push | `git-webhook.service.ts` → BullMQ `gitWebhookWorker` ([worker/index.ts:233](../../src/worker/index.ts)) | ingested, NOT propagated to LiteEngine |
| Telegram inbound | — | **does not exist** |
| ClickUp / Linear / Slack inbound | — | **does not exist** |
| Jira webhook | — | **does not exist** (only outbound comments) |

### 1.6 Telegram — outbound only

Confirmed by reading [telegram.service.ts:105-275](../../src/services/api/telegram.service.ts): the module exports `sendMessage`, `getChat`, `sendDocument`, `getMe`, `pinMessage`. Zero `setWebhook` call, zero `/webhooks/telegram` route in [chat.route.ts](../../src/api/chat/chat.route.ts) or anywhere in `src/api/`. The bot can shout, it cannot listen.

### 1.7 What the agent does NOT see right now

| Available in code | Reaches the agent? |
|---|---|
| `kb_chunks` via `searchKB()` ([kb.service.ts:596](../../src/services/kb/kb.service.ts)) | No, only `intent-parser` and `jira-qa-orchestrator` |
| `intelligent_test_findings` (past bugs) via `searchProjectFindings` RPC | No, only one-shot in `jira-qa-orchestrator` |
| `workspace_memory` via `WorkspaceMemoryService` | No, only one-shot in `jira-qa-orchestrator` |
| `TestCaseResolverService` (similar test cases) | Partially — `prefilledSteps` plug-in for handler, not for LiteEngine |
| Past auto-learned patterns (KB chunks tagged `auto-learn`) | Written by [auto-learn.job.ts](../../src/jobs/auto-learn.job.ts), never read at runtime |
| Prior runs of the same test (`test_executions`, `ai_summary` of last run) | No |
| Attached resources (logins/env/secrets via Phase 1–3 of test-resources) | Applied pre-test, but agent isn't told what was applied |
| Jira issue text that spawned the test | Stored in `tests.metadata.sourceJiraIssueKey`, but only the `goal` string reaches LiteEngine |
| Mid-mission budget / credits remaining | No |
| Other tests in the same logical "mission" | No concept of mission exists |
| Code changes from the git push that triggered the run | git event lands in BullMQ, dies there |

---

## 2. Concrete bugs and smells

Each item is something I would write a real ticket for. Anchored to file:line.

| # | Severity | Location | Issue |
|---|---|---|---|
| B1 | high | [chat.controller.ts:425](../../src/api/chat/chat.controller.ts) | `parsedIntent.resolvedContext` (prefilled steps, source test cases, resolver strategy) is assembled but no path threads it into `TestRunRequest.metadata`. LiteEngine never sees it. |
| B2 | high | [jira-qa-orchestrator.service.ts:198-272](../../src/services/integrations/jira-qa-orchestrator.service.ts) | Five expensive context fetches → one LLM → result discarded. The same context never reaches the worker that will actually run the test. |
| B3 | medium | [ai-analysis.job.ts:611](../../src/jobs/ai-analysis.job.ts) | Slack channel hardcoded `'#qa-alerts'` for all critical bugs. No project/owner routing. |
| B4 | medium | [lite-state.ts](../../src/agent/core/lite/lite-state.ts) | `WorkingMemory` lives in RAM only. Worker crash mid-test = context lost; nothing to resume from. |
| B5 | low (time-bomb) | [ai-analysis.job.ts:50](../../src/jobs/ai-analysis.job.ts) | `testResultId ?? resultId` — two field names for the same thing, both accepted downstream. Drift waiting to happen. |
| B6 | medium | [test-completion-handler.service.ts:725](../../src/services/testing/results/test-completion-handler.service.ts) | Telegram notify only if `test.user_id` connected Telegram. Co-owners / reviewers never get pinged. |
| B7 | medium | [intent-parsing.ts](../../src/api/chat/shared/intent-parsing.ts) vs [router-agent.ts](../../src/api/chat/general/sub-agents/agents/router-agent.ts) | `parseIntent` (LLM call) classifies into 17 labels; in `general_chat`, Router (another LLM call) does **the same classification job**. One redundant LLM per chat turn for ~60% of traffic. |
| B8 | low UX | [chat.controller.ts:300](../../src/api/chat/chat.controller.ts) | 409 on concurrent request rejects the user. Fine for SPA, hostile for chat-channel clients (Telegram) where a user can't see prior in-flight requests. |
| B9 | high | Cross-cutting | No `mission_id` / `correlation_id` threaded through logs, WS events, BullMQ jobs, AI logs. Cannot reconstruct *"what did the agent do for ticket PROJ-123"* without manual grepping. |
| B10 | low | [jira-qa-orchestrator.service.ts:380](../../src/services/integrations/jira-qa-orchestrator.service.ts) | `searchProjectFindings` RPC duplicated as a private method. Should live in [patterns-query.service.ts](../../src/services/kb/patterns-query.service.ts) — single funnel for similar-bug search. |
| B11 | high | [auto-learn.service.ts](../../src/services/kb/auto-learn.service.ts) | Auto-learn writes patterns to KB; **no agent reads them at runtime**. Closed loop is broken. |
| B12 | medium | [ai-analysis.job.ts:712](../../src/jobs/ai-analysis.job.ts) | `extractBugPatterns` writes to `intelligent_test_findings` but doesn't dedupe — same fingerprint across runs creates N rows. |
| B13 | medium | [git-webhook.service.ts](../../src/services/integrations/git-webhook.service.ts) → [worker/index.ts:233](../../src/worker/index.ts) | Git push ingested by the worker, no path from "code changed on `/checkout`" → "re-run tests touching `/checkout`". The trigger arrives and dies. |
| B14 | low | [lite-engine.ts:789](../../src/agent/core/lite/lite-engine.ts) | `LITE_ENGINE_FLAGS.enableCriticAgent` silently skips Critic if off. No telemetry on % of runs without Critic. |
| B15 | medium | [chat.controller.ts:201](../../src/api/chat/chat.controller.ts) | Credit check at chat-start is 1 credit. `multi_tool` path can fan out to 5+ tool calls, each costing more. No mid-execution budget gate — one turn can blow through credits. |
| B16 | low | repeated | `intent_test_cases.platform.startsWith('mobile_')` string-match used in 5+ places. Deserves a helper, e.g. `isMobilePlatform(p)`. |
| B17 | medium | [ai-analysis.job.ts:104-130](../../src/jobs/ai-analysis.job.ts) | `bugReportChargedAt` idempotency marker is good. No parallel marker for `telegramNotifiedAt`/`slackNotifiedAt` — BullMQ retries can re-spam channels. |
| B18 | high | [chat.controller.ts:52-475](../../src/api/chat/chat.controller.ts) | `handleChat` is tightly bound to `req/res`. Blocks every non-HTTP entry point (Telegram, cron-triggered chat, internal mission ticks) from reusing the same logic cleanly. |

---

## 3. Architectural gaps (in plain words)

1. **Two architectures in one controller.** Agent for `general_chat`; switch for everything else. Composition impossible (*"run tests and notify Slack"*).
2. **No QA-execution tools.** `run_web_test`, `run_mobile_test`, `run_api_test`, `run_plan`, `save_test_case` don't exist in the skill registry. Agent cannot start a test even if asked.
3. **No durable mission state.** Tests are jobs. There is no first-class "mission" object that owns a multi-step goal, survives restarts, and can be resumed.
4. **No runtime knowledge access in LiteEngine.** Strategist/Critic never consult KB, past bugs, prior runs, or the workspace memory.
5. **Pull-only triggers.** No Jira/Telegram/Slack/ClickUp/Linear webhook. Git push is half-wired.
6. **No HITL loop.** Agent posts rework questions to Jira; replies don't come back.
7. **No control plane.** No per-mission kill-switch, no per-tool policy gate, no per-mission budget cap, no immutable audit log of decisions.
8. **No owner-aware routing.** Notifications route to `test.user_id` only; no CODEOWNERS / Jira-component → team map.
9. **No mission/correlation id.** Logs, WS, jobs, AI-logs all live in their own ID universes. Can't replay a mission end-to-end.

---

## 4. Research foundations — what the industry settled on in 2026

Before the target architecture, this section pins what we are building against, with sources. Every architectural choice further down references this section by name (e.g. "Phase 3 follows Pattern R4"). Pinning the patterns up front means future contributors don't have to re-derive them.

### 4.1 Single-agent patterns (where ours stands)

These four patterns are the well-known agent-loop shapes. They have known cost / robustness tradeoffs.

| Pattern | One-line | Strength | Weakness | Cost |
|---|---|---|---|---|
| **ReAct** | Think → act → observe, each step | Cheap, simple | Drifts on long tasks; no upfront plan | Baseline |
| **Plan-and-Execute** | Plan once, then dispatch a cheap executor through the steps | Best baseline for multi-step tasks | Brittle if plan assumptions wrong | Baseline |
| **ReWOO** | One plan, parallel tool calls, one solver | Fewest LLM calls (2 total) | Fragile when steps depend on prior results | Cheapest |
| **Reflexion** | After failure, self-critique → retry with the lesson in memory | Recovers from one-shot mistakes | +50% cost vs baseline | High |
| **LATS** | Tree-search over plans + reflection | Highest quality on hard tasks | **~50× cost vs ReAct** | Prohibitive |

Source: [ReAct vs Plan-and-Execute vs ReWOO vs Reflexion (TheAIEngineer)](https://theaiengineer.substack.com/p/the-4-single-agent-patterns), [ReWOO paper (arxiv 2305.18323)](https://arxiv.org/pdf/2305.18323), [Breaking Down 5 LLM Agent Architectures](https://clipzag.com/watch?v=ZJlfF1ESXVw).

**Our choice (already implemented in [sub-agents/pipeline.ts](../../src/api/chat/general/sub-agents/pipeline.ts)):**
- `simple_chat` path = effectively ReAct (degenerate, no tools).
- `single_tool` path = ReAct with one tool.
- `multi_tool` path = **Plan-and-Execute with Reflexion-style Reviewer** (Phase 2 → unify everything onto this path).

We deliberately do not adopt LATS — for QA workflows the 50× cost is uneconomic. Reflexion-on-failure (one retry) is the right tradeoff.

### 4.2 Multi-agent orchestration patterns (R-series — referenced by phases below)

| Ref | Pattern | What it means | Source |
|---|---|---|---|
| **R1** | Orchestrator-Worker (Supervisor) | One supervisor agent receives the request, delegates to specialized workers, synthesizes the result. The most widely used architecture in production deployments. | [LangGraph Supervisor docs](https://reference.langchain.com/python/langgraph/supervisor/), [TrueFoundry Multi-Agent](https://www.truefoundry.com/blog/multi-agent-architecture) |
| **R2** | Supervisor-via-tools | Newer recommendation: don't use a dedicated supervisor library — implement the supervisor as a tool-calling LLM. Gives more control over context engineering. | [LangChain Multi-Agent Guide](https://docs.langchain.com/oss/python/langgraph/workflows-agents) |
| **R3** | Blackboard / shared state | All agents read/write one typed state object. Lets a Reviewer second-guess an Executor without re-deriving context. | LiteEngine's own `WorkingMemory` + [sub-agents/blackboard.ts](../../src/api/chat/general/sub-agents/blackboard.ts) already use this. |
| **R4** | Checkpointed state machine | Persist agent state at every step. Resume from the last checkpoint on failure. 92% of production LangGraph deployments use this. | [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [Indium 2026 — 7 State Persistence Strategies](https://www.indium.tech/blog/7-state-persistence-strategies-ai-agents-2026/) |
| **R5** | Durable execution (Temporal-style) | Stronger than R4: each tool call is an idempotent activity, replay is event-sourced, retries are automatic at the runtime level. | [Diagrid: Checkpoints Are Not Durable Execution](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows), [AgentMarketCap: Temporal + LangGraph](https://agentmarketcap.ai/blog/2026/04/10/durable-agent-execution-production-temporal-modal-event-sourced) |
| **R6** | Confidence-based escalation / HITL | Agent runs autonomously while confidence > threshold; otherwise escalates to a human with diagnostic context. The Atos / IBM "bounded autonomy" pattern. | [Atos whitepaper (private)], [IBM Agentic Reasoning](https://www.ibm.com/think/topics/agentic-reasoning) |
| **R7** | Control plane sidecar | Policy, budget, kill-switch, immutable audit live *around* the agent, intercepting every tool call. Not inside the agent loop. | Atos Polaris pattern, mirrored in LangGraph's checkpointer hooks. |
| **R8** | Agent-initiated dialog with hybrid rails | Agent speaks first. Each turn returns 2-4 quick-action buttons + a free-text input as fallback. Skeleton of the flow is fixed; button text + ranking is LLM-generated under current context. Replaces forms for onboarding and complex setup. | [Manus Agent Skills onboarding](https://manus.im/features/agent-skills), [Robylon: AI Chatbot for SaaS Onboarding](https://www.robylon.ai/blog/ai-chatbot-saas-onboarding), v0 / Lovable "first artifact" pattern. |
| **R9** | Content-readiness escalation ladder | When a page returns empty/minimal content, escalate through: L1 `waitForLoadState('load')` → L2 wait for known selector → L3 `evaluate()` for shadow/iframe targeted extract → L4 vision (screenshot + coordinate-based action) → L5 scroll-discover with `scrollHeight` stability detect. Maps onto our existing 3-stage resolver + `visionHints`; the gap is the **auto-escalation between levels** when one fails silently. | [k-kolomeitsev/agent-browser-workspace](https://github.com/k-kolomeitsev/agent-browser-workspace) (MIT). Our own [project_iframe_aware_probe](memory) and Documentolog ONLYOFFICE incident validate the need. |

**R4 vs R5 honest note:** in the original Phase 3 of this document I wrote "durable missions via Postgres rows" — that is technically R4 (checkpointing), not R5 (full durable execution). For our scale and BullMQ background it is sufficient. The [Diagrid critique](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows) is correct in principle (checkpoints lose in-flight side effects on crash), but adopting Temporal would be a separate, much larger lift. We note the gap and ship R4. Upgrade to R5 stays on the table for the future.

### 4.3 Memory taxonomy (consensus in 2026)

Industry has converged on a three-tier model, inspired by cognitive science and operationalized by [MemGPT / Letta](https://docs.letta.com/concepts/memgpt/). All major memory frameworks (Mem0, LangMem, MemMachine) implement variants of this.

| Tier | Letta name | Role | Our equivalent today | Gap |
|---|---|---|---|---|
| **Working memory** | Core | Always in-context window, like RAM. Holds the current goal, last few observations, plan. | `WorkingMemory` in [lite-state.ts](../../src/agent/core/lite/lite-state.ts) | Lives in RAM only — Phase 3 moves to Postgres |
| **Episodic memory** | Recall | "What happened" — logs of past runs, decisions, bugs found | `intelligent_test_findings` table, `test_logs/*.jsonl` | Written but **not read** by agent — Phase 6 closes loop |
| **Semantic memory** | n/a (third tier sometimes split) | "What I know about the world" — product docs, OpenAPI, KB | `kb_chunks` table + `searchKB()` | Read only in `intent-parser` + `jira-qa-orchestrator`, **not in LiteEngine** — Phase 0 fixes |
| **Procedural memory** | Archival (vector) | "How I usually do X" — skills, recipes, learned patterns | `services/skills/` registry + auto-learn-job | Skill registry exists; auto-learn writes back but isn't queried — Phase 6 |

Source: [Memory in the Age of AI Agents survey (arxiv 2603.07670)](https://arxiv.org/html/2603.07670v1), [Letta Docs: Memory Management](https://docs.letta.com/advanced/memory-management/), [State of AI Agent Memory 2026 (Mem0)](https://mem0.ai/blog/state-of-ai-agent-memory-2026).

**Key Letta insight we adopt:** agents do not passively receive context — they explicitly call memory management functions to move information between tiers. This means **memory access is a tool**, not a hidden retrieval step. In our system: `search_kb`, `search_past_bugs`, `recall_similar_missions` are first-class tools the Planner/Executor invoke explicitly. The agent reasons about *what to remember*.

### 4.4 Interop standards we adopt

| Standard | What it is | Status (May 2026) | Our use |
|---|---|---|---|
| **MCP (Model Context Protocol)** | Anthropic-led open standard for how an LLM client connects to external tools and data sources. Three primitives: tools (actions), resources (read-only context), prompts (reusable templates). Supported by Anthropic, OpenAI, Google, Microsoft, AWS. ~97M monthly SDK downloads. | Spec dated `2025-11-25`, governed by [Anthropic + working groups](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/). 2026 roadmap adds OAuth 2.1, MCP Gateways, formal audit. | **Expose our skill registry as an MCP server.** Then Cursor / Claude Desktop / any MCP client can drive our QA agent directly. Tool registry shape (name, description, JSON-schema args) is already compatible with [tool-executor.ts:103](../../src/services/skills/tool-executor.ts). Adapter = thin transport layer. |
| **A2A (Agent-to-Agent)** | Google-originated, now [Linux Foundation Agentic AI Foundation](https://a2a-protocol.org/latest/), v1.2. ~150 organizations. Agents discover each other, negotiate modalities, collaborate on long-running tasks **without exposing internal state**. Complementary to MCP: MCP = agent ↔ tools; A2A = agent ↔ agent. | Production at 150+ orgs (Atlassian, SAP, ServiceNow, Salesforce, MongoDB, …). Signed agent cards. | Defer. We don't have a customer-facing peer-agent boundary yet. Note in roadmap so we don't paint ourselves into a corner with a custom protocol. |
| **OpenAI tool-use spec** | De-facto wire format: `tools: [{ type:'function', function:{ name, parameters }}]`, response `tool_calls[]`. Most providers (Gemini, Anthropic) accept this shape via adapters. | Already used in [openai.service.ts:149](../../src/services/ai/core/openai.service.ts) | Keep. MCP servers internally translate to/from this. |

Source: [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25), [Anthropic MCP announcement](https://www.anthropic.com/news/model-context-protocol), [A2A docs](https://a2a-protocol.org/latest/), [Google A2A announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/), [IBM: What Is A2A](https://www.ibm.com/think/topics/agent2agent-protocol).

### 4.5 Framework comparison (which framework would we copy if starting today)

We are not adopting a framework — we have our own runtime. But the framework comparison is the cleanest map of what good looks like in production, and we cherry-pick patterns from each.

| Framework | Strength to copy | Where we already do it |
|---|---|---|
| **LangGraph** | Graph-based state machine, checkpointing, time-travel debugging. Used in production at **Uber, Klarna, LinkedIn, Replit, AppFolio**. | Our pipeline is graph-shaped (Router → Planner → Executor → Reviewer → Responder). Checkpointing is the Phase 3 add. |
| **CrewAI** | Role-based agents (each agent has a persona + tools). 40% faster time-to-production for standard workflows. | Already done: Observer/Strategist/Actor/Critic in LiteEngine; Router/Planner/Executor/Reviewer in sub-agents. |
| **OpenAI Swarm** | Lowest latency — tool calls go straight to the model. | We use OpenAI tool-use directly ([executor-agent.ts](../../src/api/chat/general/sub-agents/agents/executor-agent.ts)). |
| **AutoGen** | Conversational consensus building between agents. Slowest in production. | We deliberately do NOT use chat-style consensus — too token-heavy. Reviewer agent is the one approximation. |
| **Letta** | Three-tier memory with self-editing function calls. The production fork of MemGPT. | Phase 0 + Phase 6 import this directly: memory access as tools, episodic loop closure. |

Source: [LangGraph + MCP 2026 Guide](https://techbytes.app/posts/langgraph-mcp-multi-agent-workflow-guide-2026/), [BSWEN: Which AI Agent Framework for Production](https://docs.bswen.com/blog/2026-04-29-agent-framework-production-comparison/), [Turing: Top 6 AI Agent Frameworks 2026](https://www.turing.com/resources/ai-agent-frameworks).

### 4.6 Mapping our phases to research patterns

The phases in section 5 are not invented — each one operationalizes a known pattern.

| Phase | Implements pattern | Source ref |
|---|---|---|
| Phase 0 — context to LiteEngine | Memory access as explicit retrieval before action (Letta principle) | §4.3 |
| Phase 1 — wrap QA execution as tools | MCP tool primitive; OpenAI tool-use spec | §4.4 |
| Phase 2 — unify pipeline | Supervisor-via-tools (R2) replaces hardcoded routing | §4.2 |
| Phase 3 — durable missions | Checkpointed state machine (R4) | §4.2 — honest gap vs R5 noted |
| Phase 4 — webhook triggers | Standard event-driven trigger surface; no novel research | — |
| Phase 5 — control plane | Bounded autonomy + R7 sidecar | §4.2, Atos whitepaper |
| Phase 6 — memory loop | Three-tier memory write-back, episodic recall as tool | §4.3 |

This mapping is the single most important thing in this section. If a future PR proposes deviating from any phase, it should also propose deviating from the pattern it implements, and cite why.

---

## 5. Target architecture (operationalizes patterns from §4)

One agent loop. Durable state. Every layer addressable as a tool. Control plane around it.

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │  TRIGGERS  (every input normalizes to a TaskEvent or ChatTurn)         │
   │                                                                        │
   │  Web · Desktop · Editor · Telegram · Jira/ClickUp/Linear · Git · Cron  │
   │  · Slack inbound · Email                                               │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
                       ┌─────────────────────────┐
                       │ MissionOrchestrator     │  durable in `missions` table
                       │ (Router → Planner →     │  resumable on any worker
                       │  Executor → Reviewer →  │  replayable from step_log
                       │  Responder)             │
                       └────────────┬────────────┘
                                    │ every tool call
                                    ▼
                       ┌─────────────────────────┐
                       │ MissionGovernor sidecar │  policy · budget · kill
                       │ (intercepts every call) │  immutable audit log
                       └────────────┬────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  TOOL REGISTRY (skills) — single surface                               │
   │                                                                        │
   │  Today (97 tools, registered):                                         │
   │    qa(49) · jira(12) · notion(10) · github(8) · telegram(8) ·          │
   │    slack(7) · kb(2) · memory(1)                                        │
   │                                                                        │
   │  Added by this plan (~14):                                             │
   │    qa_execution(12): run_web_test, run_mobile_test, run_api_test,      │
   │      run_regression_by_id, run_plan, run_module, run_by_tag,           │
   │      save_test_case, analyze_failure, wait_for_run, cancel_run,        │
   │      get_run_status (2 last already exist in qa.skill — reused)        │
   │    qa_context(2): search_past_bugs, recall_similar_missions            │
   │    qa_collab(1+): notify_owner (owner-aware), ask_human                │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  DOMAIN WORKERS (unchanged)                                            │
   │                                                                        │
   │  testRunWorker · mobileTestRunWorker · aiAnalysisWorker ·              │
   │  notificationWorker · webhookWorker · gitWebhookWorker ·               │
   │  explorationWorker · regressionDoctorWorker · allureImportWorker ·     │
   │  autoLearnWorker · negativeGenerationWorker · testResultWorker         │
   │                                                                        │
   │  Backed by: LiteEngine · mobile-runner · api-test · Playwright ·       │
   │  Supabase · OpenAI/Gemini                                              │
   └────────────────────────────────────────────────────────────────────────┘
```

Three properties this gives us:

- **Every layer is addressable** — because every layer has a tool.
- **Every action is auditable** — because every tool goes through `MissionGovernor`.
- **Every mission survives** — because state is in Postgres, not in process memory.

---

## 6. The phased migration

The phases are deliberately ordered so each one delivers user-visible value standalone. Most weeks are deletion, not new code.

### Phase 0 — Stop the bleeding (3 days)

> **Pattern reference:** §4.3 three-tier memory — semantic memory must be accessible from working memory at planning time. Today it isn't.

Goal: today's agent sees the context it already collects.

| Step | File | Change |
|---|---|---|
| 0.1 | [chat.controller.ts:425](../../src/api/chat/chat.controller.ts), [test-creator.ts:11](../../src/services/testing/ui/manual/test-creator.ts) | Thread `parsedIntent.resolvedContext` into `TestRunRequest.metadata.priorKnowledge`. Pass through `QueueManager.addTestRunJob`. Fixes **B1**. |
| 0.2 | LiteEngine entry | Read `priorKnowledge` from job data → seed `lite-state.initialContext` (new field). Strategist/Critic prompts gain a new `priorKnowledge` block (1-2 paragraphs of KB + similar bugs + similar tests). Fixes the "agent sees only the page" complaint. |
| 0.3 | Cross-cutting | Introduce `correlation_id` (UUID) at the chat entry. Propagate through logs / BullMQ job data / WS payloads / `test_runs` / `test_results` (new column on each). Fixes **B9**. |
| 0.4 | [ai-analysis.job.ts:50](../../src/jobs/ai-analysis.job.ts) | Codemod `resultId` → `testResultId` everywhere. Fixes **B5**. |
| 0.5 | [auto-learn.service.ts](../../src/services/kb/auto-learn.service.ts) | Add fingerprint dedupe (`UPSERT ON CONFLICT (project_id, fingerprint)`) before writing to `intelligent_test_findings`. Fixes **B12**. |
| 0.6 | [step-readiness-v2.service.ts](../../src/services/testing/ui/preview/step-readiness-v2.service.ts) | Add `pageContentStable` detector: poll `document.body.innerText.length` 3 × 300ms; declare stable on 3 consecutive equal readings, soft-fail (continue) on timeout. Closes the gap between `waitForLoadState('load')` and Strategist running on a half-rendered page. Implements R9 level L1→L2 transition. |

**Exit criterion:** in a manual run, KB chunks and similar bugs appear inside LiteEngine prompts. Verified by grepping JSONL traces for the new `priorKnowledge:` block.

### Phase 1 — Wrap QA execution as tools (5–7 days)

> **Pattern reference:** §4.4 MCP tool primitive; §4.3 Letta principle "memory access is a tool". Every layer of the system becomes addressable through a tool the Planner can invoke.

Goal: collapse the 17-intent switch into something the agent can call.

| Step | New file | Implements |
|---|---|---|
| 1.1 | `src/services/skills/qa/qa-execution.skill.ts` | `run_web_test(url, goal, mode)` → wraps `createTest` + `QueueManager.addTestRunJob` ([queues.ts:461](../../src/config/infrastructure/queues.ts)). Returns `{ testId, jobId, correlationId }`. |
| 1.2 | same file | `run_mobile_test(...)` → uses mobile dispatch path. Wraps `QueueManager.addMobileTestRunJob` ([queues.ts:707](../../src/config/infrastructure/queues.ts)). |
| 1.3 | same file | `run_api_test(endpoint, level)` → wraps API test service. |
| 1.4 | same file | `run_regression_by_id(test_case_id)` → wraps `RegressionRunService.runSavedTestCase`. |
| 1.5 | same file | `run_plan(plan_id)`, `run_module(module_id)`, `run_by_tag(tag)` → wraps `RegressionRunService.runPlan/runModule/runByTag`. |
| 1.6 | same file | `save_test_case(intent_steps)` → wraps `IntentTestCaseService.create`. |
| 1.7 | same file | `analyze_failure(test_result_id)` → joins `ai_summary` + `intelligent_test_findings` for one consolidated view. |
| 1.8 | same file | `wait_for_run(run_id, timeout_ms)` → polls `regression_runs.state` until completed/failed/cancelled. Lets a plan continue after a test finishes. |
| 1.9 | `src/services/skills/qa/qa-context.skill.ts` | `search_past_bugs(query, projectId)` — promote `searchProjectFindings` from `jira-qa-orchestrator` into a public tool. Fixes **B10** by making `patterns-query.service.ts` the single funnel. |
| 1.10 | same file | `recall_similar_missions(query, limit=5)` — once missions exist, reads from `missions` table. Returns plan + outcome of nearest past missions. Closes **B11** loop. |
| 1.11 | `src/services/skills/qa/qa-collab.skill.ts` | `notify_owner(owner_ref, payload)`. `owner_ref` accepts `jira:component:payments` or `codeowner:/checkout` or `user:<id>`. Resolves channel + recipient internally. Replaces hardcoded `#qa-alerts`. Fixes **B3, B6**. |
| 1.12 | same file | `ask_human(question, urgency, options?)` — emits WS + sends to user's preferred channel (Telegram/Slack/in-app). Resolves on reply via channel webhook. |
| 1.13 | `src/services/skills/qa/qa-browser.skill.ts` | `escalate_to_vision(step_id)` — Critic-callable when DOM-resolver returned 0 candidates AND `pageMetadata.isDOMWeak=true`. Routes to coordinate-based fallback via existing `visionHints`. Implements R9 level L3→L4 transition. Closes the Documentolog-class regression where canvas/heavy-SPA pages have unreachable elements. |
| 1.14 | [manifest.ts](../../src/services/skills/manifest.ts) | Register the four new skill files (`qa-execution`, `qa-context`, `qa-collab`, `qa-browser`). |
| 1.15 | [router-prompt.ts](../../src/api/chat/general/sub-agents/prompts/router-prompt.ts), [planner-prompt.ts](../../src/api/chat/general/sub-agents/prompts/planner-prompt.ts) | Teach Router about category `qa_execution` and Planner about how to compose `run_*` with `wait_for_run` and `notify_owner`. |

**No legacy handler is touched in this phase.** All wrappers run alongside the existing code path under a feature flag (off by default).

**Exit criterion:** with the flag on, a user can type *"запусти регрессию на плане Q2-smoke и пни owner в slack если упадёт"* and the agent composes 3 tool calls in one turn. Verified by Reviewer output `goalAlignment > 0.8`.

### Phase 2 — Unify the pipeline (5–7 days, then canary)

> **Pattern reference:** §4.2 R2 — Supervisor-via-tools. Router agent IS the supervisor; routing is just tool-category selection, not a hardcoded switch. Matches LangChain's current production guidance.

Goal: kill `parseIntent` switch. One pipeline for all chat turns.

| Step | Where | Change |
|---|---|---|
| 2.1 | [chat.controller.ts:52](../../src/api/chat/chat.controller.ts) | Extract body into `processChatTurn(input, ctx)`. `handleChat(req, res)` becomes a thin HTTP wrapper. Removes req/res coupling. Fixes **B18**. |
| 2.2 | env / config | Feature flag `UNIFIED_AGENT_PIPELINE=true`. When on: `parseIntent` is skipped, every turn goes straight to `SubAgentPipeline.execute()`. Fixes **B7**. |
| 2.3 | rollout | Canary at 5% of workspaces, monitor Reviewer verdicts (`approved` vs `needs_retry` rate), tool execution failure rate, latency p50/p95, credit spend per turn. Ramp to 25% → 50% → 100% over 2 weeks. |
| 2.4 | cleanup | Remove handlers one by one as their tool wrappers prove stable. Order of removal (by traffic, low first): `coverage_analysis`, `test_recommendations`, `analyze_failure`, `create_plan`, `add_to_plan`, `save_test`, `run_by_tag`, `run_module`, `run_plan`, `run_regression`, `editor_action` (most complex — keep for last), `mobile_action`, `mobile_test`, `mobile_agent`, `api_test`, `platform_test`. |
| 2.5 | mid-execution credits | [pipeline.ts](../../src/api/chat/general/sub-agents/pipeline.ts) — before each tool dispatch, call `MissionGovernor.beforeToolCall` (Phase 5 stub OK for now) that checks `spent + tool.estimated_cost <= budget`. Fixes **B15**. |

**Exit criterion:** all 17 intents flow through the same pipeline. `parseIntent` and 16 handlers deleted. Bug fix once → applies to all entry points.

### Phase 3 — Durable missions (2 weeks)

> **Pattern reference:** §4.2 R4 — Checkpointed state machine (not R5 — see §4.2 honest note). LangGraph's `PostgresSaver` thread-based persistence pattern, recreated on our existing Supabase. 92% of production LangGraph deployments use this exact shape.

Goal: missions are first-class, survive crashes, are replayable.

| Step | Where | Change |
|---|---|---|
| 3.1 | new migration | `missions` table: `id, workspace_id, project_id, source, source_external_id, state, goal, plan jsonb, blackboard_snapshot jsonb, step_log jsonb, budget_credits, spent_credits, confidence, owner_user_id, correlation_id, created_at, updated_at`. Indexes on `(workspace_id, state)`, `(source, source_external_id)`. |
| 3.2 | `src/services/missions/mission.service.ts` | CRUD + state machine: `planning → awaiting_approval → running → reflecting → blocked → done/killed`. |
| 3.3 | `src/services/missions/mission-orchestrator.ts` | `start(triggerEvent)` → INSERT row, planning state. `tick(missionId)` → load state, run one Router/Planner/Executor cycle of `SubAgentPipeline`, persist blackboard, return. Reentrant — any worker can `tick` any mission. |
| 3.4 | `SubAgentPipeline` | Refactor so it can be invoked with a *resumed* blackboard, not only a fresh one. Pipeline serializes blackboard to a stable JSON shape (already mostly there in [blackboard.ts](../../src/api/chat/general/sub-agents/blackboard.ts)). Fixes **B4**. |
| 3.5 | tools | `run_*_test` tools now accept `mission_id` and propagate it through BullMQ job data. AI-analysis posts results back as a tick trigger. |
| 3.6 | new BullMQ queue | `mission-tick` queue with one worker. Anything that produces a result for a mission enqueues a tick. The tick runs `MissionOrchestrator.tick(missionId)`. |
| 3.7 | new API | `GET /api/v1/missions/:id`, `GET /api/v1/missions/:id/log` (immutable), `POST /api/v1/missions/:id/kill`, `POST /api/v1/missions/:id/approve`. |

**Exit criterion:** restart any process mid-mission. Mission resumes on the next tick. Audit log shows every Router/Planner/Executor decision with `correlation_id`.

### Phase 4 — Triggers from the world (1 week)

> **Pattern reference:** Event-driven multi-channel input. No novel research here — standard webhook surface with HMAC verify and idempotency keys. The `TaskEvent` abstraction is the moment we earn future ClickUp/Linear support for ~80 LOC each.

Goal: missions wake up on real events.

| Step | New file | Implements |
|---|---|---|
| 4.1 | `src/api/webhooks/jira-webhook.controller.ts` | `POST /webhooks/jira` — HMAC verify → normalize to `TaskEvent` → `MissionOrchestrator.start({source:'jira',...})`. |
| 4.2 | `src/api/webhooks/telegram-webhook.controller.ts` | `POST /webhooks/telegram` — verify `X-Telegram-Bot-Api-Secret-Token`. For text messages → bridge into `processChatTurn(ChatInput)`. For `callback_query` (button clicks) → resolve `callback_data` like `approve:<mission_id>` → `MissionService.approve(missionId)`. |
| 4.3 | new table | `telegram_links(tg_user_id, qait_user_id, active_workspace_id)` — populated by `/start <one-time-code>` flow. |
| 4.4 | bot setup | One-time `setWebhook` call against Telegram Bot API; secret token stored in env. |
| 4.5 | [git-webhook.service.ts](../../src/services/integrations/git-webhook.service.ts) | Wire git events to mission start. Resolve changed files → `intelligent_test_findings` rows touching those paths → `MissionOrchestrator.start({source:'git', goal:"regression on changed surface", scope: filePaths})`. Fixes **B13**. |
| 4.6 | future | ClickUp/Linear/Slack inbound — same pattern as `jira-webhook.controller.ts`. Each is ~80 LOC because `TaskEvent` is already abstract. |

**Exit criterion:** push to `main` on a tracked path → mission starts in <5s, visible in `/missions` list. Telegram message "запусти регрессию" → same mission lifecycle as web chat.

### Phase 5 — Control plane (1 week)

> **Pattern reference:** §4.2 R6 (confidence-based escalation / bounded autonomy) + R7 (sidecar). Atos Polaris model recreated as middleware around our existing `tool-executor.ts`. Critically: starts in **audit-only** mode for 2 weeks before any policy enforces.

Goal: bounded autonomy. The Atos word, concrete code.

| Step | New file | Implements |
|---|---|---|
| 5.1 | `src/services/missions/mission-governor.ts` | Decorator/middleware around `tool-executor.ts`. **Before**: policy check (is this tool allowed for `workspace`/`role`?), budget check, destructive-action confidence gate (if tool has side effects and Planner confidence < 0.7 → `state='awaiting_approval'`, notify owner, return). **After**: append `{tool, args, result_summary, decided_by, confidence, ms, mission_id}` to `mission.step_log` (append-only, never UPDATE). |
| 5.2 | [tool-executor.ts:103](../../src/services/skills/tool-executor.ts) | `registerToolHook` already exists — `MissionGovernor` registers as a hook. No invasive change. |
| 5.3 | kill-switch | `POST /missions/:id/kill` flips state. Each tool checks `mission.state === 'killed'` at start; in-flight tools check before enqueuing follow-ups. |
| 5.4 | new table | `team_routing(workspace_id, key, channel, recipients[])` where `key` is `jira:component:payments` or `codeowner:/checkout`. Read by `notify_owner` tool. |
| 5.5 | budget gate | `MissionGovernor.beforeToolCall` blocks if `mission.spent_credits + tool.estimated_cost > mission.budget_credits`. Mission transitions to `blocked`; owner receives `ask_human` request. Fixes **B15**. |
| 5.6 | retry idempotency | `MissionGovernor.afterToolCall` writes `step_log[i].notifiedAt` markers per channel. Notification tools skip if marker exists. Fixes **B17**. |

**Exit criterion:** simulate a runaway plan (100 tool calls in a loop) — Governor stops it at budget. Kill button works mid-run.

### Phase 6 — Memory and reflection (ongoing)

> **Pattern reference:** §4.3 episodic memory write-back. Closes the auto-learn loop by making "find similar past missions" a Planner-callable tool. Mirrors the [Letta self-editing memory model](https://docs.letta.com/advanced/memory-management/) — the agent decides what's worth remembering.

Goal: closed-loop learning.

| Step | Where | Change |
|---|---|---|
| 6.1 | Reviewer agent | When it sees recurring failure patterns (same `fingerprint` across N missions in M days), upsert into `intelligent_test_findings` with `mission_id`. Closes **B11**. |
| 6.2 | Planner | Before planning, call `recall_similar_missions(goal)` automatically. Plan can reference past mission ids in its `summary`. |
| 6.3 | Reviewer prompt | Add explicit instruction: cite prior missions when proposing a retry strategy. |
| 6.4 | Auto-learn job | Tag stored patterns with `mission_id`. Retirement job ([auto-learn-retire.job.ts](../../src/jobs/auto-learn-retire.job.ts)) gains a "supersedes" link so older patterns don't pollute search. |

**Exit criterion:** the same recurring bug ("checkout button covered by banner") gets detected on the second occurrence, and the third mission's plan references missions 1 and 2 in its reasoning.

---

## 7. End-to-end mission walk-through (post-Phase 5)

A concrete trace, mapped to real file paths, to make the design feel like code.

```
T+0s   Jira webhook delivers ticket "PROJ-457: checkout 500 after deploy"
       POST /webhooks/jira (Phase 4, new)
        → MissionOrchestrator.start({ source:'jira', externalId:'PROJ-457', summary, description })
        → INSERT INTO missions (..., state='planning', correlation_id=uuid)
        → enqueue mission-tick

T+1s   tick #1: Router (general/sub-agents/agents/router-agent.ts)
        → classification='multi_tool'
        → toolCategories=['qa_context', 'qa_execution', 'qa_collab']
       tick #1: Planner (planner-agent.ts)
        → calls search_past_bugs("checkout 500")    [via qa-context.skill]
            → 2 hits: PROJ-201 (89% sim), PROJ-318 (74% sim)
        → calls recall_similar_missions(...)
            → 1 hit: mission abc-123 from 3 weeks ago, same component
        → plan:
            [1] run_regression_by_id(tc-checkout-smoke)
            [2] wait_for_run(run_id from step 1, timeout=10min)
            [3] if step 2 failed: search_past_bugs(...) for context
            [4] if step 2 failed: notify_owner('jira:component:checkout', summary)
            [5] update Jira PROJ-457 with results
            confidence=0.86, budget=80 credits
        → MissionGovernor.checkPolicy(plan) — APPROVED (confidence > 0.7)
        → state='running', persist blackboard

T+2s   tick #2: Executor begins
        → MissionGovernor.beforeToolCall(run_regression_by_id) — OK, spent=2
        → qa-execution.skill run_regression_by_id → createTest + addTestRunJob
        → BullMQ job enqueued with { missionId, correlationId }
        → tick returns, mission idle

T+95s  manual-test-run.job.ts finishes (real existing path):
        → addAIAnalysisJob(resultId, testId)  [queues.ts:527]
        → TestCompletionHandlerService.handleTestCompletion(testId)
       AIAnalysisJobHandler.process:
        → ai_summary with bugs=[{ severity:'critical', step:3, msg:'pay button never clickable' }]
        → emit AIBugFound × N
        → on job completion: enqueue mission-tick(missionId)   [new in Phase 3]

T+97s  tick #3: Executor continues from step 2
        → result = step1 failed, root cause matches PROJ-201 (cached from Planner)
        → Reviewer (reviewer-agent.ts) verdict='approved', confidence=0.91
        → Executor calls notify_owner('jira:component:checkout', {bugs, similarPRs:['PROJ-201']})
            → resolves via team_routing table → Slack #payments-eng + Jira assignee
            → MissionGovernor.afterToolCall marks notifiedAt
        → Executor calls Jira-skill update_issue(PROJ-457, comment + transition='Done by QA')

T+98s  Responder writes the user-facing summary (if a human is watching)
       Reviewer writes final verdict to step_log
       Auto-learn job (existing) writes fingerprint to intelligent_test_findings (deduped)
       state='done', persist final blackboard

       Total log entries in missions.step_log: ~14 immutable rows
       Anyone with /missions/:id/log can replay every decision byte-for-byte
```

What changed vs today:

- One persistent object (`missions`) — vs today's scattered (test row + jira comment + ai_summary).
- Owner-aware notify — vs today's `#qa-alerts` hardcode.
- Planner saw past bug context up front — vs today's LiteEngine seeing only the page.
- Replay is possible — vs today's "grep test_logs/*.jsonl manually."
- Governor caught runaway risk — vs today's silent token burn.

---

## 8. What stays the same (deliberately)

The point of this plan is to delete more than we add. Things that don't change:

- **LiteEngine internals** — Observer/Strategist/Actor/Critic stay. We only thread `priorKnowledge` into their inputs (Phase 0).
- **BullMQ workers and queues** — all 12 stay. Tools wrap their existing producers.
- **Skill registry mechanics** — already supports tool hooks, auto-categorization, approval flow ([tool-executor.ts:84](../../src/services/skills/tool-executor.ts)).
- **Sub-agent pipeline** — Router/Planner/Executor/Reviewer/Responder stay. Just used everywhere instead of `general_chat` only.
- **AI analysis** — `aiSummary`, `bugs[]`, `failureClassification`, `rootCauseStep` unchanged. New code reads more from it, doesn't rewrite it.
- **Test resources** (logins/env/secrets) — Phase 1–3 already shipped. Tools call `enrichBindingsWithDefaults` the same way handlers do today.
- **Credits / cost tracker** — same. Mission budget is a new layer above, not a replacement.

---

## 9. Honest risks and unknowns

| Risk | Mitigation |
|---|---|
| Unified pipeline regresses some intent (e.g. `editor_action`) | Canary rollout. Keep legacy handlers behind feature flag until Phase 2 exit. Run shadow comparison for 2 weeks. |
| Mission table grows unbounded | Add partition by `created_at` month; archive `done`/`killed` missions > 90 days; `step_log` is the volume — keep it slim (summary, not full prompts). |
| Governor blocks legitimate work | Phase 5.1 launches with policy = "allow all, log all" — pure audit mode. Tighten policies only after 2 weeks of data on what tools fire how often. |
| Tool count explosion → context window blowout | Router's `toolCategories` filter already trims the tool list per turn. Continues to work. |
| Telegram bridge identity confusion | One-time-code linking flow; no implicit account creation; require explicit `/start <code>`. |
| Reviewer false negatives — approves bad plan | Already has `goalAlignment` threshold + retries (max 1). Add per-tool "low confidence destructive action" gate in Governor as second line. |
| LiteEngine throws inside a tool | `executeTool` already returns `SkillResult` with `success: false`. Mission orchestrator treats this as a step failure, not a crash. |
| `parseIntent` removal misses an edge case | Phase 2.3 canary monitors Reviewer `needs_clarification` rate — if it spikes for any intent, that's the canary signal. |
| Webhook abuse | Standard: HMAC signature verify, per-source rate limit, idempotency key on `(source, externalId, eventId)`. |

Two genuine unknowns I'd want to derisk in a spike before committing:

1. **Can SubAgentPipeline be initialized with a *resumed* blackboard?** [blackboard.ts](../../src/api/chat/general/sub-agents/blackboard.ts) is currently constructed empty in [pipeline.ts:106](../../src/api/chat/general/sub-agents/pipeline.ts). Looks straightforward but needs a 1-day spike to confirm no hidden state.
2. **Will `editor_action` survive unification?** It's the most coupled to live preview WS state. Might justify keeping a thin handler that the pipeline delegates to via a tool, rather than full inlining. Defer the call until Phase 2 cleanup.

---

## 10. Suggested timeline

Optimistic, one focused engineer:

| Week | Phase | Concrete deliverable |
|---|---|---|
| 1 | 0 | `correlation_id` threaded; `priorKnowledge` reaches LiteEngine; auto-learn dedupes |
| 2 | 1 | `qa-execution.skill.ts` + `qa-context.skill.ts` shipped, agent can `run_web_test` end-to-end behind flag |
| 3 | 1 | `qa-collab.skill.ts` shipped; owner-aware `notify_owner` works |
| 4–5 | 2 | Unified pipeline behind `UNIFIED_AGENT_PIPELINE`, canary at 25% |
| 6 | 2 cleanup | First 8 legacy handlers deleted |
| 7–8 | 3 | `missions` table + `MissionOrchestrator.tick` + reentrant resume |
| 9 | 4 | Jira webhook + Telegram bridge live |
| 10 | 5 | `MissionGovernor` in audit mode; budget gate; kill-switch |
| 11 | 5 hardening | Policies tightened from real audit data |
| 12+ | 6 | Memory loop closed; Planner reads past missions automatically |

Twelve weeks end-to-end, with the system measurably better at week 2 (priorKnowledge in LiteEngine) and at week 4 (one-turn composition like *"run + notify"*).

---

## 11. Behavioral spec — 15 scenarios

This section is a contract for what "done" looks like. Each scenario describes a user input and how the target system (post-Phase 5) should respond. Treated as the acceptance test suite for the migration: a phase is complete when its associated scenarios work end-to-end.

> **Today status legend:**
> - ✅ works end-to-end now
> - 🟡 works partially (wrong path / missing context)
> - ❌ impossible in current code

### Scenario 1 — Plain test request
> *"Test login at app.acme.com"*

Router → `single_tool`. `search_past_bugs("login app.acme.com")` → 0 hits. `run_web_test(url, goal='login flow', mode='lite')`. Waits for completion, reports result.

**Today:** 🟡 — works via `platform_test` handler but bypasses agent; no `search_past_bugs` enrichment.

---

### Scenario 2 — Composition in one message
> *"Run regression plan Q2-smoke and ping #payments-eng on Slack if anything fails"*

Router → `multi_tool`. Plan: `run_plan("Q2-smoke")` → `wait_for_run` → conditional branch: if failed → `search_past_bugs` → `notify_owner('jira:component:checkout')`. Reviewer verifies all branches executed.

**Today:** ❌ — composition impossible. `parseIntent` picks one intent; second clause is dropped.

---

### Scenario 3 — Vague request, missing data
> *"Test the new checkout"*

Planner sees no URL. Calls `search_kb("checkout")` → finds both `/checkout` and `/cart/checkout`. Planner confidence < 0.7 on which to use → `ask_human("Which one — /checkout or /cart/checkout?")` via user's active channel. Mission state = `awaiting_approval`. Resumes on reply.

**Today:** ❌ — `parseIntent` returns generic clarification or fallback; no HITL resume path.

---

### Scenario 4 — Question about past work (no execution)
> *"What broke yesterday?"*

Router → `single_tool`. `qa_get_last_runs(since=24h, status=failed)` → Responder summarizes (count, top-3 by severity). No test created. ~1 credit total.

**Today:** ✅ — works inside `general_chat` pipeline. Other intents may misroute to `analyze_failure` and ask for IDs.

---

### Scenario 5 — Jira webhook (no human in chat)
> Jira: PROJ-457 moved to "QA" column.

`POST /webhooks/jira` → `MissionOrchestrator.start({source:'jira', externalId:'PROJ-457'})`. Planner runs with full context (KB + `search_past_bugs` + `WorkspaceMemory`). If `CAN_RUN_AUTO`: runs test, posts result back to Jira via `update_issue`, transitions ticket. If not: posts rework questions; reply (next webhook on Jira comment) resumes the same mission.

**Today:** ❌ — no Jira webhook, only pull-mode `/jira/qa-analyze`; no resume path.

---

### Scenario 6 — Git push triggers regression
> Developer pushes commit touching `src/checkout/*`.

`gitWebhookWorker` resolves changed paths → queries `intelligent_test_findings` for tests touching `/checkout` → `MissionOrchestrator.start({source:'git', scope: ['/checkout', '/cart']})`. Runs the smallest regression set covering those paths. Owner notified only on red.

**Today:** ❌ — `gitWebhookWorker` exists but the path from "changed files" → "tests touching those files" → "mission" is not wired.

---

### Scenario 7 — Telegram one-liner from non-developer
> *"PM ping: is yesterday's nightly green?"*

Telegram webhook → `processChatTurn`. Router → `single_tool`. `qa_get_run_status(latest, plan='nightly')` → Responder replies in Telegram with one-line green/red + bug count.

**Today:** ❌ — Telegram is outbound-only. No `/webhooks/telegram` route.

---

### Scenario 8 — Destructive action with confidence gate
> *"Cancel all running regressions in this workspace"*

Planner picks `qa_cancel_run` × N. `MissionGovernor.beforeToolCall` flags multi-target destructive action with confidence 0.65 → `state='awaiting_approval'`. Telegram inline keyboard: `[Approve all] [Pick which] [Cancel]`. Nothing fires until user taps.

**Today:** ❌ — `qa_cancel_run` exists in `qa.skill.ts` but no Governor, no confidence gate, no HITL keyboard. Would just fire.

---

### Scenario 9 — Mid-run kill
> Telegram user: *"stop mission abc123, false alarm"*

Bridge resolves intent via Planner → calls internal `mission_kill(abc123)` (privileged tool) → `POST /missions/abc123/kill` → state=`killed`. In-flight tool calls check `mission.state` on completion and refuse to enqueue follow-ups. Audit log records `killed_by=user:<id>` with timestamp.

**Today:** ❌ — no `missions` table, no kill-switch.

---

### Scenario 10 — Repeated failure across runs (memory loop)
> Third time this week the same selector breaks on `/dashboard`.

Reviewer fingerprints the failure across missions, sees 3 hits → upserts `intelligent_test_findings` with `recurrence_count=3` (deduped, not 3 new rows). On next mission planning, Planner automatically calls `recall_similar_missions` → prefixes its plan with *"3rd recurrence; trying alternative selector strategy first."*

**Today:** 🟡 — `extractBugPatterns` writes findings but doesn't dedupe (B12); no `recall_similar_missions` tool; Planner doesn't consult prior missions.

---

### Scenario 11 — Multi-platform compose
> *"Verify the new SDK works on web, iOS and the public API"*

Router → `multi_tool`. Planner emits 3 parallel calls: `run_web_test`, `run_mobile_test`, `run_api_test`. `wait_for_run` × 3 (parallel barrier). Reviewer compares results, flags only the platforms where behavior diverges. One unified report.

**Today:** ❌ — each intent goes to a different hardcoded handler; no shared orchestration; no parallel barrier across platforms.

---

### Scenario 12 — Budget overrun
> *"Run exploratory test on the entire admin panel"*

Planner estimates ~200 credits but `mission.budget_credits = 80`. Governor blocks at plan-approval gate → state=`blocked`. Notification: *"Estimated 200 credits, budget 80. [Approve 200] [Trim to highest-priority pages] [Cancel]"*. User picks "trim" → Planner re-plans within budget.

**Today:** ❌ — credits checked once at chat start (1 credit), no plan-level estimate, no mid-run gate (B15).

---

### Scenario 13 — Inbound Slack thread
> Slack: *"@qai why did the nightly fail?"*

Slack webhook → `processChatTurn({source:'slack', threadTs})`. Planner: `analyze_failure(latestNightly)` → `search_past_bugs(similar)` → reply in-thread with `rootCauseStep` + 2 similar bugs + inline buttons `[Re-run] [Open in dashboard]`. Conversation stays in Slack.

**Today:** ❌ — Slack is outbound-only (and hardcoded `#qa-alerts` channel — B3).

---

### Scenario 14 — Cross-mission knowledge query
> *"Show me everything we tried last quarter for payment-flow flakiness"*

Router → `single_tool`. `recall_similar_missions("payment flakiness", since=90d, limit=20)` → returns missions with their plans, tools used, outcomes. Responder formats as a timeline. Pure read, no tests run.

**Today:** ❌ — no `missions` table, no `recall_similar_missions` tool.

---

### Scenario 15 — Sovereign / on-prem variant
> User: *"Run this but don't send anything outside our infra"*

Mission opens with policy tag `sovereign=true`. Governor rejects any tool call whose target is external SaaS (Jira cloud, Slack, Telegram, OpenAI). Falls back to local LLM + in-app notifications only. Audit log marks every blocked call with reason `policy:sovereign`.

**Today:** ❌ — no Governor, no policy tags, no local-LLM fallback path wired.

---

### Scenario 16 — First-time user drops APK on landing page (Stage 2)
> User just signed up. Lands on `/start`. Drags `myapp.apk` onto the chat.

Agent (initiating, not waiting for user): *"Got it — 'MyApp' v2.4. I see 14 screens declared."* + 3 quick actions: `[Auto-explore main flow (free, 2 min)] [I'll walk you through what to test] [Find login + signup myself]`. User taps option 1. Agent runs `analyze_apk` → `auto_explore_mobile(depth=light)`. At T+90s hits a login screen → emits `ask_human` quick action `[Use test account] [Paste credentials] [Skip — public only]`. Completes at T+3min with a **Workflow** card pinned in `/workflows`.

**Today:** ❌ — no `/start` route, no agent-initiated welcome, APK upload exists but isn't wired to onboarding.

---

### Scenario 17 — Paste URL with no further input (Stage 2)
> *"https://example.com"* — single line, no verb.

Agent infers intent: `crawl_site(url, depth=1, budget=10pages)` runs in parallel with `discover_openapi(url)` and `discover_kb_urls(url)`. After 15s replies with what it found + 3 quick actions: `[Try the happy path] [Focus on one page] [Find broken links — no creds needed]`. User taps option 3 (cheapest). Workflow built at T+2min, zero credentials asked. Re-engage prompt: *"want to dig deeper with login?"*.

**Today:** ❌ — same as 16, plus `crawl_site` / `discover_openapi` tools don't exist.

---

### Scenario 18 — Drop swagger.json in chat (Stage 2)
> User drops OpenAPI spec into onboarding chat.

[format-adapters/openapi.adapter.ts](../../src/services/kb/format-adapters/openapi.adapter.ts) parses it (existing code). Post-ingest hook on Mission #0 emits `list_endpoints` + `classify_by_risk`. Agent: *"23 endpoints — 5 write, 18 read. I can:"* + `[Smoke all 23 (needs token)] [Public only (no auth, ~3 min)] [Generate Postman collection]`. Picks option 2 → parallel `run_api_test` × 18 → finds 1 real bug (500 on `GET /orders/:id`). Workflow created with the bug attached.

**Today:** 🟡 — swagger ingests into KB chunks but **dies there**; no post-ingest hook to start a mission.

---

### Scenario 19 — User goes off-rails mid-onboarding (Stage 2)
> Onboarding screen 2. User types *"расскажи анекдот про QA"*.

Off-rail handler kicks in. Agent: one-line answer (*"программист и тестировщик заходят в бар…"*) + soft return: *"но мы тут настраиваем твой первый workflow — продолжим?"* + the same 3 quick actions from before, in their original order. Free-text input stays available. If user goes off-rails twice in a row, agent escalates: *"hey, this onboarding takes 3 minutes — want to skip to free chat, or shall I just pick smoke defaults?"*.

**Today:** ❌ — no off-rail detection; `general_chat` would just engage in the joke and never resume onboarding.

---

### Scenario 20 — Agent re-engages on critical bugs (Stage 2, Stage 1)
> User finished onboarding 3 days ago. Scheduled smoke runs daily. Today it found 5 critical bugs in one run.

Agent (initiating, not waiting): pushes to user's active channel (Telegram if linked, else in-app + email). Message: *"⚠️ Daily smoke just found 5 critical bugs in your `example.com` workflow — that's unusual. Want me to:"* + `[Increase frequency to hourly] [Pin issues to your Slack #qa] [Investigate root cause — I'll run a deeper exploration] [Just show me]`. User taps option 3 from Telegram → new mission spawns with the failing flows as scope. **Re-engagement is bounded:** agent only initiates on (a) first signup, (b) critical-bug spike (statistical anomaly vs baseline), (c) workflow paused >7 days. NOT on idle dashboard, NOT on every run.

**Today:** ❌ — no agent-initiated outbound dialog; notifications today are one-way fire-and-forget without quick-action buttons.

---

### What ties these 20 together

- **Same pipeline for all** — web, Telegram, Slack, Jira webhook, git push, onboarding all enter `processChatTurn` or `MissionOrchestrator.start`. One agent, many doors.
- **Governor decides risk** (8, 9, 12, 15) — not the agent, not hardcoded rules.
- **Memory closes the loop** (10, 14) — past missions actively shape new plans.
- **Composition is free** (2, 6, 11, 13) — because every operation is a tool, not a fixed handler.
- **Agent initiates with rails** (16, 17, 18, 19, 20) — Stage 2 scenarios where the agent speaks first with quick actions; free text always available as fallback.
- **Today only Scenarios 1 (partial), 4, and 7 work** end-to-end. The other 17 unlock progressively as Phase 1 → 5 land, plus §13-§14 for the Stage 2 set.

### Mapping scenarios to phases / stages

| Scenario | Unblocked by |
|---|---|
| 1 | Phase 0 (priorKnowledge into LiteEngine) |
| 2, 11 | Phase 1 (`run_*` tools) + Phase 2 (unified pipeline) |
| 3 | Phase 1 (`ask_human` tool) + Phase 3 (mission resume) |
| 4 | already works; Phase 2 makes it consistent across phrasings |
| 5 | Phase 4 (Jira webhook) + Phase 3 (mission state) |
| 6 | Phase 4 (git → mission wiring) |
| 7, 13 | Phase 4 (Telegram + Slack inbound) |
| 8, 12, 15 | Phase 5 (Governor + confidence/budget/policy gates) |
| 9 | Phase 3 (mission state) + Phase 5 (kill-switch) |
| 10, 14 | Phase 6 (memory loop) — partially Phase 1 (`recall_similar_missions`) |
| **16, 17, 18, 19** | **§13 Stage 2 (Mission #0 onboarding) — depends on Phase 1 + Phase 2** |
| **20** | **§13 (re-engagement triggers) + §14 (Workflow object) — depends on Phase 3** |

This table doubles as a PM checklist: ship a phase, run its scenarios, count working ones. Stage 2 cannot ship before Stage 1's Phase 1+2 land.

---

## 12. What this gives a user, in one sentence (end of Stage 1)

After Phase 4: a user writes one Telegram message — *"check checkout flow, if 500s, ping payments team"* — and the system creates a durable mission that plans, runs the test, analyses bugs against prior incidents, notifies the right owner via the right channel, lets the user approve risky actions inline, and leaves a full replayable audit trail. Every step uses code that already exists today; the plan above is mostly the work of getting that code to talk to itself.

**This is necessary but not sufficient.** A new user still has to *know* to type that Telegram message. Stage 2 (§13-§14) answers "how does a first-time user actually meet this system and get value in their first 5 minutes?".

---

# STAGE 2 — User-facing surface

Stage 1 built the engine. Stage 2 is how the user touches it. Two pieces:

- **§13 Mission #0 — Fast Onboarding** (the *front door*): replace the post-signup form with an agent-initiated guided chat that produces a tangible result in <5 minutes.
- **§14 Workflows** (the *output container*): everything the agent produces — test cases, schedule, alerts, credentials — gets packaged into one named, share-able, reviewable object called a Workflow. This is what the user sees in their dashboard.

**Why these two are coupled:** Mission #0 needs a tangible artifact to point at when it finishes. That artifact is a Workflow. Without §14, Mission #0 would end with "here are 5 test cases, 1 plan, 1 schedule, 3 alerts" scattered across separate screens — same problem as today. Without §13, §14 is an empty dashboard widget. Ship them in the same release.

---

## 13. Stage 2: Fast Onboarding (Mission #0)

> **Pattern reference:** §4.2 R8 — agent-initiated dialog with hybrid rails. Manus pattern: agent speaks first, returns 2-4 quick actions + free-text fallback. Skeleton fixed, button text generated under context.
>
> **Goal:** time-to-first-value under 5 minutes. Top-quartile SaaS in 2026 hits this; we're aiming for the upper bound of "aggressive" (under 15 minutes per [SaaS onboarding benchmarks 2026](https://www.robylon.ai/blog/ai-chatbot-saas-onboarding)). Today: >30 minutes typical, frequently abandoned.

### 13.1 The problem with today's onboarding

[onboarding.controller.ts:15-477](../../src/api/workspace/onboarding.controller.ts) is a 477-line form validator that demands `name + baseUrls[] + environments + browser` before the user sees anything. After it passes, the user lands on the dashboard and has to discover Repository → New Test Case → Add Steps → Run. Median time to first run is 30+ minutes; abandonment is highest at "what do I do now?" on the dashboard.

The form gives us nothing the agent couldn't elicit by chat, when it actually needs each datum. Browser choice is irrelevant until first run. Environment URLs are irrelevant until the user wants more than one. baseUrls are inferable from the URL the user pastes. Workspace name is auto-generatable.

### 13.2 The replacement: agent-initiated guided chat

After signup, redirect to `/start` (new route, not `/dashboard`). Single-screen split-view: chat on the left, **artifact pane** on the right (Manus-style — see §13.6 below for what fills it). Agent posts the first message before the user types anything.

```
Screen 1 — Welcome (agent initiates):
  "Hi! I'm your QA agent. Let's set up your first test run in 3 minutes.
   What are we testing today?"
  Quick actions: [🌐 Website] [📱 Mobile app] [🔌 API]
  Free-text input below: "or just type / drop anything here"

Screen 2 — Branch on choice (e.g. user picked Website):
  "Cool! What's the URL?"
  Inline URL input + buttons:
    [Public site, no login] [Has login — I'll guide you] [Internal/staging]

Screen 3 — Scope:
  "Before we run, let me scope this. Pick what matters most:"
  [Just see if anything is broken (3 min, no credentials)]
  [Test the main happy-path flow (5 min, ask for credentials when needed)]
  [Deep exploration — all main pages (10-15 min)]
  Optional checkboxes: ☐ checkout ☐ signup ☐ payments ☐ + custom

Screen 4 — Approval:
  "Here's my plan for the next ~5 min:
     ✓ Crawl example.com surface (12 pages found in sitemap)
     ✓ Run smoke checks on key pages
     ✓ Generate 3-5 test cases you can edit later"
  [▸ Start (15 credits)] [✕ Cancel]
  Advanced: ☐ I'll review every test before it runs

Screen 5 — Live progress (split-view active):
  Left: chat updates from emitProcessingStep
  Right: live screenshots, page list with status dots, progress bar
  Inline ask_human card pops up when credentials needed.

Screen 6 — Review:
  "Done in 4m 23s. I created Workflow 'example.com Daily Smoke'.
   Found 2 issues. Now it's your turn to review:"
  [Looks good — activate workflow] [Let me edit tests first]
  [Show me how a test step looks] [Re-run with different focus]

Screen 7 — Activation:
  Workflow card appears at /workflows. User now has access to
  the full app (Repository, Plans, Runs) but doesn't have to use it.
  Agent stays available in sidebar for follow-ups.
```

### 13.3 Hybrid rails — what's fixed, what's LLM-generated

| Layer | Fixed in config | LLM-generated under context |
|---|---|---|
| Screen sequence (1→2→3→4→5→6→7) | ✅ yes | — |
| Which screen to show next given user choice | ✅ deterministic state machine | — |
| **Text of welcome message** | greeting structure | localized phrasing, time-of-day, user name |
| **Quick action labels** | the *kind* (e.g. "scope choice") | exact wording adapted to artifact ("Test the checkout flow" vs "Test the API endpoints") |
| **Ordering of quick actions** | typically 3 options per screen | LLM ranks by inferred user intent + cost |
| Approval card content | structure | plan summary, credit estimate, ETA — all from Planner output |
| Off-rail response | always 1-line answer + soft return | the actual answer to whatever user said |
| Re-engagement triggers | 3 events only (see §13.5) | the wording of the nudge |

This is the *hybrid rails* answer to the design question. Skeleton is fixed; voice is generated.

### 13.4 Off-rail handling

User on Screen 2 types *"расскажи анекдот"*. Detector (cheap rules: not a URL, not matching any quick-action keyword, no file attached, length < 100 chars and doesn't contain http/api/test) flags as off-topic. Agent responds with **one-line answer** + soft return + the *same* quick actions from before.

```
🤖 Программист и тестировщик заходят в бар…
   But we're setting up your first workflow — shall we continue?
   [🌐 Website] [📱 Mobile app] [🔌 API]
```

Escalation: if user goes off-rails **twice in a row**, agent offers an exit: *"This onboarding takes 3 min — want to skip to free chat, or shall I just pick smoke defaults for you?"* with `[Continue setup] [Skip to free chat] [Pick smoke defaults]`. Never traps the user.

If user provides a *valid* freetext that maps to a quick action (e.g. types "find broken links" instead of clicking the button), Planner routes it through the same branch. Quick actions are convenience, not requirement.

### 13.5 Re-engagement — when agent speaks first AFTER onboarding

Three triggers only. Anything beyond these is spam.

| Trigger | Channel | Action |
|---|---|---|
| **First signup, screen 1** | in-app `/start` | Welcome message + first quick actions (covered above) |
| **Critical-bug spike** | Telegram if linked, else in-app + email | Anomaly: today's run found N critical bugs where baseline is 0-1. Agent: *"Workflow X just found 5 critical bugs — unusual. Want me to: [investigate] [increase frequency] [pin to Slack]"* |
| **Workflow paused >7 days** | in-app banner only (no push) | Soft prompt: *"Your `example.com` workflow has been paused for 8 days. Resume, archive, or rebuild?"* |

Explicitly **not** triggers:
- Idle on dashboard (annoying — Manus tried, dropped it)
- Each run completion (notifications are user-configured via Workflow alerts)
- Per-LLM-call cost spike (Governor handles, doesn't dialog)

### 13.6 Code reuse — what already exists

| Capability | File | Reuse for |
|---|---|---|
| `QuickAction[]` in chat response | [quick-actions-injector.ts:56](../../src/api/chat/general/sub-agents/quick-actions-injector.ts) | All quick actions on screens 1-7 |
| Quick-action whitelist | [src/api/preview/quick-action-endpoints.ts] | Approval card, scope picker |
| Live progress streaming | `emitProcessingStep` → WS [shared/utils.ts:180](../../src/api/chat/shared/utils.ts) | Screen 5 right pane |
| ExplorationEngine | [exploration-engine.ts:57](../../src/agent/core/lite/exploration/exploration-engine.ts) | The actual crawl/test execution |
| Exploration storage + read API | [explorations.route.ts](../../src/api/explorations/explorations.route.ts) | Showing artifacts on screen 5/6 |
| Chat attachments | [chat.controller.ts:103](../../src/api/chat/chat.controller.ts) | APK/swagger drop on screen 1 |
| Format adapters (OpenAPI, Postman, PDF) | [format-adapters/](../../src/services/kb/format-adapters/) | Parsing dropped files |
| APK/IPA/AAB upload | [mobile-app-storage.service.ts:20](../../src/services/storage/mobile-app-storage.service.ts) | Mobile branch screen 1 |
| Test Resources Phase 1-3 (auth/env/secrets) | `src/services/test-resource/` | JIT credential elicitation on screen 5 |
| Sub-agent pipeline | `src/api/chat/general/sub-agents/` | Drives the whole onboarding chat |
| Mobile app analysis | [mobile-app-prep.service.ts:278](../../src/services/mobile/mobile-app-prep.service.ts) | Scenario 16 (`analyze_apk`) |

### 13.7 What to add

Backend (3 endpoints + 1 prompt + ~5 tools):

| New file / change | Implements |
|---|---|
| `src/api/onboarding/onboarding.controller.ts` — `POST /api/v1/missions/onboarding/start` | Creates chat session with `metadata.onboarding=true`, emits welcome message with first quick actions, returns `{ sessionId, firstMessage, quickActions[] }` |
| same — `POST /api/v1/missions/onboarding/answer` | Routes quick-action click or freetext into `SubAgentPipeline.execute` with onboarding-aware system prompt; returns next screen |
| same — `POST /api/v1/missions/onboarding/approve` | Starts `ExplorationEngine` with collected config; returns `{ explorationId, jobId }` |
| `src/api/chat/general/sub-agents/prompts/onboarding-prompt.ts` | Onboarding-aware system prompt: "NEVER ask open-ended questions. ALWAYS return 2-4 quick actions. Free text is fallback. Goal: produce one runnable Workflow in <5 minutes." |
| Off-rail detector | Cheap rules in [routing.ts] before pipeline dispatch; flips `onboarding_off_rail=true` on session |
| Tool `analyze_apk(file_id)` | Wraps `mobile-app-prep` manifest extract |
| Tool `auto_explore_mobile(app_id, depth)` | Wraps existing exploration in 'scout' mode for mobile |
| Tool `crawl_site(url, depth, budget)` | Light wrapper over `ExplorationEngine` for screen 5 |
| Tool `discover_openapi(base_url)` | Probes `/openapi.json`, `/swagger.json`, `/api-docs` |
| Tool `discover_kb_urls(url)` | Parses meta tags / sitemap for docs links |
| Tool `build_workflow_from_mission(mission_id)` | Mission #0 finalizer — see §14 |
| Two new quick-action types: `onboarding_pick_mode`, `onboarding_approve_plan` | Added to whitelist; carry budget + plan summary |

Frontend (1 route + 1 layout + quick-action rendering):

| Change | What |
|---|---|
| Route `/start` | Split-view layout (chat left, artifact pane right) |
| Quick-action rendering for `onboarding_*` types | Buttons with appropriate styling; click → `POST /missions/onboarding/answer` |
| Artifact pane | Live exploration progress (page list + screenshots + status dots) |
| Drag-drop handler on chat input | APK / IPA / swagger / Postman → uploads + auto-sends in chat |

### 13.8 What to remove (carefully)

Today's `POST /api/v1/workspaces/onboarding` ([onboarding.controller.ts:15-477](../../src/api/workspace/onboarding.controller.ts)) does **not** get sunset on day one.

Rollout:

1. New users (post-deploy) → redirected to `/start`.
2. Workspace still auto-created at signup with sensible defaults (`name = first part of user email`, `baseUrls = []`). The first URL the user pastes in `/start` populates `baseUrls`. Environment URLs added via `ask_human` quick action when needed.
3. Old form available as `/settings/workspace/advanced-setup` for power users.
4. After 2 weeks of telemetry showing >95% of new users complete via `/start`: delete controller, delete route, delete frontend.

### 13.9 Mission #0 in DB (before Stage 1 Phase 3 lands)

Phase 3 of Stage 1 introduces the `missions` table. Stage 2 can ship **before** that — we use existing tables with a marker:

```
chat_sessions.metadata = {
  onboarding: true,
  onboarding_state: 'screen_1' | 'screen_2' | ... | 'screen_7' | 'completed',
  onboarding_artifact_kind: 'apk' | 'url' | 'swagger' | 'postman' | 'text',
  onboarding_collected: { url?, mode?, focus?, credentials_ref?, ... }
}

intent_test_cases.metadata = {
  is_onboarding_seed: true,
  onboarding_session_id: <chatSessionId>,
  needs_user_review: true   // blocks auto-run until user approves on screen 6
}
```

When Phase 3 lands, migrate this to `missions.kind = 'onboarding_first_value'`. No data loss — same fields, different shape.

### 13.10 Hard rules for code review

These are non-negotiable:

1. **No free-text-only screens 1-4.** Every screen returns ≥2 quick actions OR an inline structured input (URL field, file dropzone). PRs adding a bare textarea on these screens — rejected.
2. **No blocking form before any agent message.** The agent must speak first on `/start`. PRs adding "complete your profile" walls — rejected.
3. **Credentials JIT, never upfront.** Test Resources adapter is the only place credentials enter; they enter when the agent's `ask_human` tool emits a credentials-quick-action, not at signup.
4. **Mission #0 result is always a Workflow.** Not "5 test cases + 1 plan + 1 schedule scattered." See §14.

---

## 14. Stage 2: Workflows — packaging agent output

> **Goal:** turn what the agent produces (a bundle of test cases + plan + schedule + alerts + credentials) into one named, share-able, reviewable object the user actually sees in their dashboard. Eliminates the "where did everything go?" confusion of today.
>
> **Why "Workflow":** the word is recognised across SaaS (Zapier, n8n, Notion, Make), translates cleanly, describes a *process* not a static set, and reads naturally in chat ("share my QA workflow"). One word, used everywhere — no aliases, no synonyms in UI / email / notifications.

### 14.1 The problem today

Mission #0 (or any agent task) produces:
- 5 rows in `intent_test_cases`
- 1 row in `regression_plans`
- 1 row in `schedules`
- 0-3 rows in `automation_actions` (Slack/email alerts)
- 0-N rows in `test_resources` (login, env vars)
- 1+ rows in `regression_runs` (the first run)
- Screenshots scattered in `test_results.evidence`

The user has to find each one separately in Repository / Plans / Schedules / Settings. None of them have a parent. The bundle has no name, no card, no preview. Asking *"what did the agent set up for me?"* requires a manual cross-table query.

### 14.2 The Workflow object

One row groups everything:

```sql
create table workflows (
  id uuid primary key,
  workspace_id uuid not null,
  project_id uuid not null,
  name text not null,                          -- "example.com Daily Smoke"
  slug text not null,                          -- url-safe; unique per workspace
  icon text,                                   -- favicon URL / APK icon URL / '🔌'
  description text,
  source_mission_id uuid,                      -- null until Stage 1 Phase 3 lands
  source_chat_session_id uuid,                 -- works before Phase 3
  status text not null,                        -- draft | active | paused | archived
  created_by text not null,                    -- 'agent' | 'user'
  needs_user_review boolean default true,      -- blocks auto-run until approved
  test_case_ids uuid[],
  regression_plan_id uuid,
  schedule_id uuid,
  automation_action_ids uuid[],
  resource_ids uuid[],
  last_run_id uuid,
  cover_screenshot_url text,                   -- first screenshot from exploration
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index workflows_slug_workspace on workflows(workspace_id, slug);
create index workflows_workspace_status on workflows(workspace_id, status);
```

9 columns + 5 foreign-key arrays. Not a monster — a deliberate aggregator.

### 14.3 What you can do with a Workflow

| Action | Endpoint | Maps to existing code |
|---|---|---|
| List | `GET /api/v1/workflows` | new |
| Detail | `GET /api/v1/workflows/:id` | new — joins existing tables |
| Rename / pause / archive | `PATCH /api/v1/workflows/:id` | new |
| Run now | `POST /api/v1/workflows/:id/run-now` | calls `RegressionRunService.runPlan(workflow.regression_plan_id)` |
| Approve (clear `needs_user_review`) | `POST /api/v1/workflows/:id/approve` | toggles flag, activates schedule |
| Share (read-only link) | `POST /api/v1/workflows/:id/share` | optional, similar to existing `qa_share_result` skill |
| Delete | `DELETE /api/v1/workflows/:id` | cascades: drops the row, leaves the underlying test cases (they may be referenced elsewhere) |

Five endpoints total. The schedule, alerts, and test cases continue to live in their own tables and are editable via existing UI — Workflow is a view + identity over them.

### 14.4 Gallery view (the new landing for first-run users)

After Mission #0 approval (screen 6 → 7), user lands on `/workflows`, not `/dashboard`. Three states:

| User state | What they see |
|---|---|
| First-ever (just approved Workflow #0) | One large card front-and-centre with "Created 4 min ago by AI agent" badge. Status dot pulsing green. Side panel: *"Want another one? [Add Workflow]"* |
| Returning, 2-10 Workflows | Grid of cards sorted by `last_run_id` desc. Each card: icon, name, status dot, last-run summary, "Run now" CTA |
| Power user, >10 Workflows | Compact list with filters by status / project / last-run-result. Cards still available via toggle |

Card structure (already shown in conversation, repeating for spec):

```
┌─ Workflow: "example.com Daily Smoke" ─────────────────────┐
│  🌐  example.com         created 4 min ago · by AI agent   │
│                                                            │
│  📋  5 test cases  🔐  1 login  📅  Daily 9am  🔔  Slack    │
│                                                            │
│  Last run · 2 min ago    ✓ 4 passed  ⚠ 1 issue             │
│  Issue: /pricing — "Compare" link returns 404              │
│                                                            │
│  [▸ Run now]   📝 Edit   📤 Share   🤖 Ask agent           │
└────────────────────────────────────────────────────────────┘
```

One primary CTA (Run now). Everything else secondary. AI-agent badge is open: when shared, the receiver sees "AI made this in 4 min" — sells the product implicitly.

### 14.5 Naming convention

- **Auto-generated name on creation:** `<target> <mode>`. Examples: `example.com Daily Smoke`, `MyApp Happy-path Regression`, `Stripe API Smoke`.
- **User can rename anytime** via PATCH. Old slug kept as redirect for 30 days.
- **Icon resolution:**
  - Website: `https://<domain>/favicon.ico` (cached in our storage)
  - Mobile: APK icon extracted via `mobile-app-prep` (already done for app cards today)
  - API: literal emoji `🔌` or first letter of API name in a coloured circle
- **Cover screenshot:** first screenshot from the first successful run. Refreshed weekly.

### 14.6 Status indicators (the colour dot)

| Status | Dot | Meaning |
|---|---|---|
| `draft` | grey, pulsing | Created by agent, awaiting user approval (Mission #0 just finished) |
| `active`, last run green | solid green | Healthy |
| `active`, last run had issues | amber | Workflow running, but findings need review |
| `active`, last run failed entirely | red | Schedule still on, but execution broke (infra issue) |
| `paused` | grey | User-paused; schedule suspended |
| `archived` | hidden by default, shown in archive filter | Read-only |

The dot is cheap UX that reads in 0.5s. Replace any "Status: foo" text with the dot.

### 14.7 Lifecycle (code-level)

```
[Mission #0 reaches screen 6 'review']
  ↓
build_workflow_from_mission(missionId) tool fires (or post-Mission #0 hook
                                                    before Stage 1 Phase 3)
  ↓
INSERT workflows (status='draft', needs_user_review=true,
                  created_by='agent', cover_screenshot_url=<first screen>)
  ↓
Frontend shows card with overlay 'Review & approve'
  ↓
User clicks 'Approve' → PATCH workflows.status='active',
                                  needs_user_review=false
  ↓
Schedule activates (if workflow.schedule_id is set)
Alerts arm (workflow.automation_action_ids)
  ↓
[Time passes; scheduled runs execute via existing RegressionRunService]
  ↓
Each run UPDATE workflows.last_run_id, workflows.updated_at
If run fails → automation_actions fire (existing path)
If anomaly (Stage 1 Phase 6) → agent re-engages via §13.5 trigger
  ↓
[User may pause / archive / edit anytime; schedule respects status]
```

### 14.8 Workflow vs existing entities — what's the difference

| Concept | Lives in | Used by | Workflow does |
|---|---|---|---|
| `intent_test_cases` | Repository | Test authoring, manual runs | Includes references; does not duplicate |
| `regression_plans` | Plans | Bulk scheduling | Owns at most one plan |
| `schedules` | Schedules tab | Cron-style triggers | Owns at most one schedule |
| `automation_actions` | Settings → Automations | Notification rules | Owns the actions; user can add more via Settings |
| `test_resources` | Settings → Resources | Auth/env/secrets | Owns the references; resources can be shared across Workflows |
| `regression_runs` | Runs tab | Execution history | Workflow links to the latest one |
| **Workflow** | `/workflows` | **First-touch user view + bundle identity** | **New aggregator object** |

Power users can still edit each underlying entity from its tab. The Workflow row reflects current state via JOINs at read time — never duplicates source-of-truth data.

### 14.9 Hard rules for code review

1. **Workflow is never source-of-truth for its children.** Test cases are owned by Repository, schedules by Schedules tab, etc. Workflow joins. Drop the row → underlying entities survive.
2. **Status transitions are exhaustive.** `draft → active`, `active → paused`, `paused → active`, `* → archived`. No silent state.
3. **`created_by` is honest.** If user creates manually via wizard later, set `'user'`. Don't fake the AI badge.
4. **AI agent never marks `needs_user_review=false` automatically.** Approval is always a human action. Exception: if Mission #0 ran in "auto-activate" advanced mode (off by default, requires opt-in checkbox on screen 4).
5. **Name auto-gen uses the registered convention.** PRs proposing different formats need a design discussion first — consistency >> cleverness.

### 14.10 Integration into Stage 1 phases

Stage 2 (§13 + §14) depends on Stage 1 but can ship earlier than Phase 3-6:

| Stage 1 dependency | Why |
|---|---|
| Phase 0 (priorKnowledge) | Mission #0's exploration benefits from KB enrichment |
| Phase 1 (run_*, ask_human, build_workflow_from_mission tools) | Required — onboarding's planner needs these |
| Phase 2 (unified pipeline) | Strongly recommended — otherwise onboarding chat fights with the `parseIntent` switch |
| Phase 3 (durable missions) | Helpful for resume-after-tab-close on screen 5; can use `chat_sessions.metadata` as stopgap (see §13.9) |
| Phase 4 (webhooks) | Not required; §13.5 trigger #2 (critical-bug spike) needs §14 + Phase 6 |
| Phase 5 (Governor) | Not required for ship; recommended for budget gate on screen 4 approval |
| Phase 6 (memory loop) | Required for §13.5 trigger #2 anomaly detection |

**Earliest ship:** end of Phase 2. Ship `/start` + Workflow gallery with chat-session metadata in place of missions table. Migrate to missions when Phase 3 lands.

---

## 15. Two-stage summary

**Stage 1** (engineering): one durable agent runtime, every layer is a tool, control plane around it, can run any QA mission. Backbone.

**Stage 2** (product): a new user lands on `/start`, has a 90-second chat where the agent does most of the talking via quick actions, drops their APK / URL / swagger, and walks away in <5 minutes with a Workflow they can run, edit, schedule, and share. The agent stays in the sidebar for follow-ups.

After both stages: a user types one Telegram message *or* drops one file on signup, and the system delivers value end-to-end without forms, without configuration screens, without the user having to know what a "test case" or "regression plan" is until they want to.
