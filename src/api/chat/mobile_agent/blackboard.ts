/**
 * Mobile Blackboard — shared state for a single mobile-agent turn.
 *
 * Scope: ONE invocation of the pipeline (user sends a message → agent
 * replies). Not cached across turns — the next message builds a fresh
 * blackboard.
 *
 * What it holds:
 *   - the user's goal (their raw message)
 *   - the last `observe_mobile_page` result (so a second tool call within
 *     the same turn can read the freshest snapshot without re-fetching)
 *   - a running list of tool invocations for telemetry / debugging
 *   - (Phase 5) a FlowPlan produced by the planner tool, plus per-step
 *     execution status so the LLM can resume after partial progress
 *
 * What it does NOT hold:
 *   - chat history across turns (that's in the DB)
 *   - persistent mobile session state (that lives on the runner)
 *   - LLM conversation messages (built by the pipeline on each LLM call)
 *   - history compaction state — current models all have ≥256k context
 *     and 30 rounds top out around ~90k tokens, so compaction is not
 *     needed yet. Add back if/when telemetry shows real pressure.
 */

import type { MobileUiState } from '@/services/mobile/mobile-runner.types';
import type { MobileProjectContext } from '@/services/chat/mobile-project-context.service';
import type { ConcreteFlowPlan, FlowPlanStep } from './planner';
import type { ReasoningEntry } from './reasoning-trace';
import { TRACE_MAX_ENTRIES } from './reasoning-trace';

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs: number;
  at: number;
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface PlanStepState {
  status: PlanStepStatus;
  attempts: number;
  lastError?: string;
  startedAt?: number;
  finishedAt?: number;
}

export class MobileBlackboard {
  readonly goal: string;
  readonly mobileSessionId: string;
  readonly userId: string;
  readonly chatSessionId?: string;
  /**
   * Project the chat is scoped to, resolved by the controller BEFORE the
   * handler runs (test-case access check / warmup binding). Threaded here so
   * the save tool (mobile_create_test_case) doesn't have to look it up from
   * chat_sessions.project_id — which is NULL in workspace scope and matches no
   * row in test-case scope, making save dead-end. Prefer this over the lookup.
   */
  readonly projectId?: string;
  /** Workspace of the chat request — scopes list_project_options. */
  readonly workspaceId?: string;
  /** Saved test case the mobile editor is scoped to, when any. */
  readonly testCaseId?: string;

  // ── Project context (eager, resolved by the handler) ─────────────
  // Project + app-under-test + open-test-case info resolved BEFORE the
  // first LLM call so (a) mobile_create_test_case never dead-ends on a
  // missing project and (b) the system prompt can name the app under
  // test while authoring. Null when resolution failed — the save tool
  // then falls back to its legacy lazy lookup.
  private projectContext: MobileProjectContext | null = null;

  private lastSnapshot: MobileUiState | null = null;
  private lastSnapshotAt: number | null = null;
  private readonly toolInvocations: ToolInvocation[] = [];

  // ── Plan state (phase 5) ──────────────────────────────────────────
  // A plan is optional — only set when the LLM calls the `plan_flow` tool.
  // Once set, stepStates tracks progress; the LLM reads it back to know
  // what's next and whether the prior step succeeded.
  // Always a plan WITH steps — the clarification-only outcome (no steps) is
  // handled in runPlanFlow and never reaches setPlan, so `plan.steps` is
  // guaranteed defined here.
  private plan: ConcreteFlowPlan | null = null;
  private readonly stepStates = new Map<number, PlanStepState>();

  // ── Reasoning trace (Phase 7+) ────────────────────────────────────
  // The LLM emits these via `think_aloud` (see tools.ts). Each entry is
  // already sanitised + truncated by the executor before it lands here;
  // the blackboard's only job is to bound the array length so a runaway
  // agent can't blow up JSONB row size.
  private readonly reasoningTrace: ReasoningEntry[] = [];

  // ── WebView context (Phase 8) ─────────────────────────────────────
  // Tracks whether the runner session is currently in NATIVE (default)
  // or WEB context. Mutated by switch_to_webview / switch_to_native
  // tools. Read by action tools so they know whether to dispatch a
  // native command or a web_* command on the runner.
  private webContext: 'NATIVE' | 'WEB' = 'NATIVE';
  private webContextUrl: string | undefined;

  // ── Per-turn cost guards (Phase B5) ───────────────────────────────
  // `take_screenshot` is the priciest observation tool — a base64 PNG
  // costs ~1500-3000 vision tokens at OpenAI's image input rate. Capping
  // per turn keeps a chatty LLM from rage-snapshotting and blowing the
  // budget. The guard is informational here; tools.ts enforces it.
  private screenshotsThisTurn = 0;

  constructor(init: {
    goal: string;
    mobileSessionId: string;
    userId: string;
    chatSessionId?: string;
    projectId?: string;
    workspaceId?: string;
    testCaseId?: string;
  }) {
    this.goal = init.goal;
    this.mobileSessionId = init.mobileSessionId;
    this.userId = init.userId;
    this.chatSessionId = init.chatSessionId;
    this.projectId = init.projectId;
    this.workspaceId = init.workspaceId;
    this.testCaseId = init.testCaseId;
  }

  // ── Project context ───────────────────────────────────────────────

  setProjectContext(ctx: MobileProjectContext | null): void {
    this.projectContext = ctx;
  }

  getProjectContext(): MobileProjectContext | null {
    return this.projectContext;
  }

  // ── Snapshot state ────────────────────────────────────────────────

  setSnapshot(snap: MobileUiState): void {
    this.lastSnapshot = snap;
    this.lastSnapshotAt = Date.now();
  }

  /**
   * Drop the cached snapshot — called by mutating action tools (tap,
   * swipe, type, scroll, press_key, launch_app) so the next observe_mobile_page
   * returns FRESH state instead of the pre-action screen.
   */
  invalidateSnapshot(): void {
    this.lastSnapshot = null;
    this.lastSnapshotAt = null;
  }

  getSnapshot(): MobileUiState | null {
    return this.lastSnapshot;
  }

  /**
   * How fresh is the current snapshot? A turn typically completes inside
   * a few seconds, so staleness is rare — but if we later add action
   * tools, the executor should re-observe after each mutation. Returning
   * age lets the tool dispatcher decide.
   */
  getSnapshotAgeMs(): number | null {
    return this.lastSnapshotAt === null
      ? null
      : Date.now() - this.lastSnapshotAt;
  }

  // ── Tool trail ────────────────────────────────────────────────────

  recordToolCall(invocation: ToolInvocation): void {
    this.toolInvocations.push(invocation);
  }

  getToolInvocations(): readonly ToolInvocation[] {
    return this.toolInvocations;
  }

  // ── Reasoning trace ──────────────────────────────────────────────

  /**
   * Append one sanitised reasoning entry. Caller (think_aloud executor)
   * is responsible for sanitisation/truncation; this method only enforces
   * the per-turn length cap so the persisted array stays bounded.
   */
  appendReasoning(entry: ReasoningEntry): void {
    this.reasoningTrace.push(entry);
    if (this.reasoningTrace.length > TRACE_MAX_ENTRIES) {
      // Drop the oldest entry. We keep the tail because later thoughts
      // tend to be more relevant when the user asks "why".
      this.reasoningTrace.shift();
    }
  }

  getReasoningTrace(): readonly ReasoningEntry[] {
    return this.reasoningTrace;
  }

  // ── WebView context (Phase 8) ────────────────────────────────────

  getWebContext(): 'NATIVE' | 'WEB' {
    return this.webContext;
  }

  /** URL of the active WebView, when known. Set when entering WEB. */
  getWebContextUrl(): string | undefined {
    return this.webContextUrl;
  }

  /**
   * Move into WEB context. Idempotent: re-calling with the same url
   * just updates the recorded url.
   */
  enterWebContext(url?: string): void {
    this.webContext = 'WEB';
    this.webContextUrl = url;
    // The screen we cached pre-switch is now stale (a11y tree was
    // native, future observe should hit the DOM). Drop it.
    this.invalidateSnapshot();
  }

  /** Move back to NATIVE context. Idempotent. */
  exitWebContext(): void {
    this.webContext = 'NATIVE';
    this.webContextUrl = undefined;
    this.invalidateSnapshot();
  }

  // ── Plan state (phase 5) ──────────────────────────────────────────

  /**
   * Install a freshly-generated plan. Overwrites any existing plan —
   * deliberately: the LLM may decide to re-plan mid-flow if the observed
   * state diverges enough from expectations. All step states reset.
   */
  setPlan(plan: ConcreteFlowPlan): void {
    this.plan = plan;
    this.stepStates.clear();
    for (const step of plan.steps) {
      this.stepStates.set(step.id, { status: 'pending', attempts: 0 });
    }
  }

  hasPlan(): boolean {
    return this.plan !== null && this.plan.steps.length > 0;
  }

  getPlan(): ConcreteFlowPlan | null {
    return this.plan;
  }

  getStepState(stepId: number): PlanStepState | undefined {
    return this.stepStates.get(stepId);
  }

  markStepStarted(stepId: number): void {
    const state = this.stepStates.get(stepId);
    if (!state) return;
    state.status = 'in_progress';
    state.attempts++;
    state.startedAt = Date.now();
  }

  markStepDone(stepId: number): void {
    const state = this.stepStates.get(stepId);
    if (!state) return;
    state.status = 'done';
    state.finishedAt = Date.now();
    state.lastError = undefined;
  }

  markStepFailed(stepId: number, error: string): void {
    const state = this.stepStates.get(stepId);
    if (!state) return;
    state.status = 'failed';
    state.finishedAt = Date.now();
    state.lastError = error;
  }

  markStepSkipped(stepId: number, reason: string): void {
    const state = this.stepStates.get(stepId);
    if (!state) return;
    state.status = 'skipped';
    state.finishedAt = Date.now();
    state.lastError = reason;
  }

  /**
   * Produce a compact text view of plan state — drops straight into the
   * LLM's tool-response message so it can see what's done, what's next,
   * and why anything failed.
   */
  formatPlanStatusForLlm(): string {
    if (!this.plan) return '(no active plan)';
    const lines: string[] = [`Plan: ${this.plan.goal}`];
    for (const step of this.plan.steps) {
      const state = this.stepStates.get(step.id);
      const statusTag = state?.status ?? 'pending';
      const attemptTag = state && state.attempts > 1 ? ` (attempt ${state.attempts})` : '';
      const errorTag = state?.lastError ? ` — error: ${state.lastError.slice(0, 120)}` : '';
      lines.push(`  [${statusTag}] #${step.id} ${step.intent}${attemptTag}${errorTag}`);
    }
    return lines.join('\n');
  }

  /**
   * Next step the executor should attempt — earliest pending or failed-with-
   * attempts-left. Returns null when plan is fully done / every retry
   * exhausted. The pipeline uses this to decide whether to keep looping.
   */
  getNextActionableStep(maxAttempts = 2): FlowPlanStep | null {
    if (!this.plan) return null;
    for (const step of this.plan.steps) {
      const state = this.stepStates.get(step.id);
      if (!state) continue;
      if (state.status === 'pending') return step;
      if (state.status === 'failed' && state.attempts < maxAttempts) return step;
    }
    return null;
  }

  // ── Telemetry snapshot (for logs / chat metadata) ─────────────────

  summary(): {
    goal: string;
    sessionId: string;
    toolCalls: number;
    observed: boolean;
    currentApp?: string;
    currentFingerprint?: string;
    planSteps?: number;
    planDone?: number;
    planFailed?: number;
  } {
    const base = {
      goal: this.goal.slice(0, 120),
      sessionId: this.mobileSessionId,
      toolCalls: this.toolInvocations.length,
      observed: this.lastSnapshot !== null,
      currentApp: this.lastSnapshot?.app,
      currentFingerprint: this.lastSnapshot?.fingerprint,
      reasoningCount: this.reasoningTrace.length,
    };
    if (!this.plan) return base;
    let done = 0;
    let failed = 0;
    for (const state of this.stepStates.values()) {
      if (state.status === 'done') done++;
      if (state.status === 'failed') failed++;
    }
    return {
      ...base,
      planSteps: this.plan.steps.length,
      planDone: done,
      planFailed: failed,
    };
  }

  // ── Per-turn cost guards (Phase B5) ───────────────────────────────

  /**
   * Returns the number of `take_screenshot` tool calls already made
   * this turn. Tools.ts consults this before issuing another
   * screenshot and short-circuits with an error result when the cap
   * is hit.
   */
  screenshotsTakenThisTurn(): number {
    return this.screenshotsThisTurn;
  }

  /**
   * Atomic "I just took a screenshot" hook. Bumps the counter — call
   * this AFTER a successful screenshot fetch so a failed call doesn't
   * burn budget.
   */
  recordScreenshot(): void {
    this.screenshotsThisTurn += 1;
  }
}
