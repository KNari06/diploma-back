/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LiteEngine v2: Pipeline Types
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Core type definitions for the collaborative agent pipeline.
 * Shared across: Blackboard, Planner, Executor, Reviewer, CommandExecutor.
 *
 * Terminology:
 * - "Commands" = Playwright browser actions (fill, click, scroll, etc.)
 * - "Pipeline" = The agent team loop (Planner → Executor → Reviewer)
 * - "Blackboard" = Shared mutable state between all agents
 */

import type { CredentialKind } from '@/config/testing/credential-field-patterns';
import type { AICommand, LiteSnapshot, LiteElement } from '../lite-types';
// Type-only import (erased at compile time → no runtime cycle) for the overlay
// dismissal record the blackboard accumulates.
import type { RecordedDismissal } from '../exploration/overlay-step.util';

// ═══════════════════════════════════════════════════════════════════════════
// PLAYWRIGHT COMMANDS (what the Executor LLM calls to control the browser)
// ═══════════════════════════════════════════════════════════════════════════

/** All available Playwright command names */
export type CommandName =
  | 'observe_page'       // take a snapshot of current page state
  | 'fill_field'         // fill a form field with a value
  | 'click_element'      // click a button, link, or interactive element
  | 'select_option'      // select dropdown option
  | 'toggle_element'     // toggle switch, checkbox, or radio button
  | 'set_range'          // set slider/range input value
  | 'select_date'        // set date/time/datetime-local input
  | 'clear_field'        // clear an input field's value
  | 'press_key'          // press keyboard key (Enter, Escape, Tab, etc.)
  | 'hover_element'      // hover over element (tooltips, menus)
  | 'scroll_page'        // scroll by amount in a direction
  | 'scroll_to_element'  // scroll specific element into view
  | 'navigate_to'        // go to a URL
  | 'wait_for_page'      // wait for page to settle (network idle)
  | 'mark_done'          // signal test goal achieved
  | 'report_blocked'     // signal test blocked (CAPTCHA, 2FA, etc.)
  | 'assert_text';       // deterministic assertion: element text contains expected value (editor authoring only)

/** A command the LLM wants to execute */
export interface PlaywrightCommand {
  name: CommandName;
  args: Record<string, any>;
}

/** Result returned to the LLM after command execution */
export interface CommandResult {
  /** Whether the command executed successfully */
  success: boolean;
  /** Structured text the LLM reads (page snapshot, action result, etc.) */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Terminal: goal achieved — pipeline should stop */
  done?: boolean;
  /** Terminal: test is blocked — pipeline should stop */
  blocked?: boolean;
  /**
   * The snapshot element this command acted on. Set on success for targeting
   * actions (click/fill/…) so the exploration step recorder can freeze a
   * compiled locator plan from the element's stable attributes without a
   * second resolution pass. Undefined for non-targeting / failed commands.
   */
  resolvedElement?: LiteElement;
  /**
   * Which credential kind the executor actually injected into this fill
   * (`overrideCredentialFillValue`). Set ONLY when a real credential replaced
   * the LLM's throwaway placeholder. Authoring reads it to freeze the matching
   * `{{secrets.<key>}}` placeholder into the persisted step, so the frozen
   * placeholder and the injected value agree by construction. Undefined when
   * the field wasn't identified as a credential — such a field is never frozen
   * as one.
   */
  injectedCredentialKind?: CredentialKind;
}

// ═══════════════════════════════════════════════════════════════════════════
// BLACKBOARD (shared context between all agents)
// ═══════════════════════════════════════════════════════════════════════════

/** Pipeline phase — tracks where we are in the Planner→Executor→Reviewer cycle */
export type PipelinePhase = 'planning' | 'executing' | 'reviewing' | 'done' | 'blocked';

/** The full shared state container — read/written by all agents */
export interface TestBlackboardState {
  // ── Immutable context (set once at pipeline start) ──
  goal: string;
  url: string;
  testId: string;
  hasCredentials: boolean;

  // ── Pipeline state ──
  phase: PipelinePhase;
  pipelineStartedAt: number;

  // ── Planner output (read by Executor) ──
  plan?: TestPlan;

  // ── Execution state (written by Executor, read by Reviewer & Planner) ──
  rounds: ExecutionRound[];
  currentSnapshot?: string;           // latest formatted page state
  currentUrl?: string;                // latest URL after actions
  currentPageSnapshot?: LiteSnapshot; // raw snapshot for ref validation

  // ── Reviewer output (read by Planner for replanning) ──
  review?: ReviewResult;

  // ── Shared insights (any agent can append, bounded to MAX_INSIGHTS) ──
  insights: string[];

  // ── Overlay dismissals recorded during the flow (pre-pipeline + intra-round)
  //    so the flow runner can prepend them as replayable steps. Bounded to
  //    MAX_DISMISSALS. ──
  dismissals: RecordedDismissal[];

  // ── Progress tracking ──
  progressScore: number;              // 0-100, updated by observe_page via GoalDetector

  // ── Goal expansion (from GoalExpander, set once at pipeline start) ──
  expandedGoalKeywords?: string[];    // combined action+object keywords for Planner hints

  // ── Contextual hints (from GoalDetector, updated per round) ──
  contextualHints?: string[];         // navigation hints (e.g. "registration form not visible, click Sign Up")

  // ── Page health (from CommandExecutor via page-health classifier) ──
  // Technical-health verdict so Planner/Reviewer can tell "server broke" /
  // "logged out" from "goal not yet reached". Best-effort; may be absent.
  pageHealth?: import('../collectors/page-health').PageHealth;

  // ── Round budget awareness (set by TestPipeline before each Planner call) ──
  // Lets the Planner trade thoroughness for speed when rounds run low.
  roundInfo?: { current: number; max: number };

  // ── No-progress counter (set by TestPipeline same-state detection) ──
  // Consecutive rounds where page state did not meaningfully change. Lets the
  // Reviewer tell "the action had no effect, stop repeating it" from "progressing".
  noProgressRounds?: number;

  // ── Prior cross-flow learnings (set once at pipeline start from config) ──
  // Compact summary of what OTHER flows already accomplished / got blocked on
  // + the active strategy focus. Read-only context for the Planner so it reuses
  // sibling flows' outcomes instead of re-discovering them. Absent for flow #1.
  priorLearnings?: string;

  // ── Structured blocker info (set by report_blocked via CommandExecutor) ──
  // Carries the Executor's explicit blocker_type + can_user_help so the caller
  // (FlowRunner) can route to the right clarification instead of keyword-guessing
  // the blocked reason. Absent unless the Executor reported a blocker.
  blockedInfo?: { blockerType: string; canUserHelp: boolean; reason: string };

  // ══════════════════════════════════════════════════════════════════════
  // HYBRID EXECUTOR FIELDS (only populated when enableHybridExecutor=true)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * PR-Hybrid: Most recent Supervisor blackboard (Tier 1 deterministic +
   * optional Tier 2 AI diagnosis). Refreshed at the start of each pipeline
   * round. Readable by CommandExecutor for forbidden-action enforcement
   * and by ExecutorAgent for prompt hints (currently unused — future).
   */
  supervisorBlackboard?: import('../agents/types').SupervisorBlackboard;

  /**
   * PR-Hybrid: Goal URL for Supervisor's wrong-page detection (pathname
   * comparison vs currentUrl). Optional — if absent, wrong-page detection
   * is skipped, which is the current Pipeline v2 behavior.
   */
  goalUrl?: string;

  /**
   * Deterministic-assertion authoring enabled (from
   * PipelineConfig.enableAssertAuthoring). When true the Executor is offered the
   * `assert_text` command + assertion guidance. Set once at pipeline start;
   * absent/false for exploration. Read by ExecutorAgent + the prompt builders.
   */
  assertAuthoring?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST PLAN (written by Planner, read by Executor)
// ═══════════════════════════════════════════════════════════════════════════

export interface TestPlan {
  /** Brief summary of what the plan does (e.g. "Login with credentials") */
  summary: string;
  /** Ordered steps to complete the goal */
  steps: PlanStep[];
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanStep {
  /** Step number (1-based) */
  stepNumber: number;
  /** Human-readable description (e.g. "Fill email field with credentials") */
  description: string;
  /** Current status — updated by Executor as commands complete */
  status: PlanStepStatus;
  /** Error message if step failed */
  error?: string;
  /** Grounded element ref from page snapshot (e.g. "e1"). Optional — Executor falls back to description-based inference. */
  targetRef?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ROUNDS (written by Executor, read by Reviewer & Planner)
// ═══════════════════════════════════════════════════════════════════════════

/** One round of Executor's tool-calling loop */
export interface ExecutionRound {
  /** Round number within the pipeline (1-based) */
  roundNumber: number;
  /** Commands executed in this round */
  commands: ExecutedCommand[];
  /** Formatted page snapshot before this round's actions */
  pageSnapshotBefore: string;
  /** Formatted page snapshot after this round's actions */
  pageSnapshotAfter?: string;
  /** Total duration of this round in ms */
  durationMs: number;
}

/** A single command that was executed */
export interface ExecutedCommand {
  /** The command that was called */
  command: PlaywrightCommand;
  /** Result from CommandExecutor */
  result: CommandResult;
  /** Execution time in ms */
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// REVIEW RESULT (written by Reviewer, read by Planner)
// ═══════════════════════════════════════════════════════════════════════════

/** Reviewer verdict — determines next pipeline action */
export type ReviewVerdict = 'continue' | 'done' | 'blocked' | 'replan';

export interface ReviewResult {
  /** What should happen next */
  verdict: ReviewVerdict;
  /** Human-readable reason for the verdict */
  reason: string;
  /** Goal alignment score 0.0-1.0 */
  goalAlignment: number;
  /** Step numbers that failed and should be retried (for 'replan' verdict) */
  failedSteps?: number[];
  /** Guidance for Planner on how to fix the issue (for 'replan' verdict) */
  guidance?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PREFLIGHT RESULT (written by PreflightCheck agent, read by TestPipeline)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PreflightCheck verdict — a PRE-action gate that inspects the Planner's plan
 * BEFORE the Executor runs it. Reactive review (Reviewer) catches a bad action
 * only AFTER it burned a round; this catches it before.
 * - 'go'     → plan is sound, execute it.
 * - 'revise' → plan is flawed but fixable; replan next round with `guidance`.
 * - 'block'  → the goal is unreachable / plan is unsafe; stop the flow.
 */
export type PreflightVerdict = 'go' | 'revise' | 'block';

export interface PreflightResult {
  /** Gate decision. */
  verdict: PreflightVerdict;
  /** Human-readable reason (surfaced as an insight + trace). */
  reason: string;
  /** Guidance for the Planner on how to fix the plan (for 'revise'). */
  guidance?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export interface PipelineConfig {
  /** Test goal URL */
  url: string;
  /** User credentials (if available) */
  credentials?: {
    email?: string;
    username?: string;
    password: string;
    phone?: string;
  };
  /** Whether credentials are provided */
  hasCredentials: boolean;
  /** Unique test run ID */
  testId: string;
  /** Maximum pipeline rounds (Planner→Executor→Reviewer cycles) */
  maxRounds: number;
  /** Total timeout for the entire pipeline in ms */
  timeoutMs: number;
  /** Optional skills/context from user settings */
  skillsContext?: string;
  /** Connected integrations status */
  integrationContext?: string;
  /** Skip DB-based cancellation checks (exploration flows use non-UUID testIds) */
  skipDbCancellationCheck?: boolean;
  /**
   * External abort signal. When provided, its abort is forwarded to the
   * pipeline's internal AbortController so a caller (e.g. the editor preview
   * run-cancel) can stop an in-flight run that has no `tests` row to cancel via
   * the DB path. Optional — exploration omits it.
   */
  externalAbortSignal?: AbortSignal;
  /** Entry point ID for exploration flows — propagated to pipeline trace events for log correlation */
  entryPointId?: string;
  /**
   * PR-Hybrid: Original goal URL for Supervisor wrong-page detection.
   * Optional — if absent, Supervisor skips pathname comparison.
   */
  goalUrl?: string;
  /**
   * PR-Hybrid: Enable SafetyInterceptor + Supervisor wiring in Pipeline v2.
   * When true:
   *   - CommandExecutor runs SafetyInterceptor before executing each
   *     ref-based command (Critic Phase 1 deterministic checks).
   *   - TestPipeline runs SupervisorAgent at the start of each round
   *     (state hash, Jaccard, forbidden actions, Tier 2 AI diagnosis).
   * Default: false. Decided by LiteEngine based on enableHybridExecutor flag.
   */
  enableHybridSafety?: boolean;
  /**
   * Whether THIS flow is an auth/login flow. Used by the page-health check so
   * landing on a login URL is treated as the GOAL (not a "session lost"
   * regression). Exploration sets it from the entry point's category.
   */
  flowIsAuth?: boolean;
  /**
   * Enable deterministic-assertion authoring: offer the Executor the
   * `assert_text` command + assertion guidance so it can author a
   * `type:'assert'` step (a text-contains check the test re-verifies on replay)
   * when the goal implies a checkable value. Config-scoped — set true ONLY by
   * EditorIterativeAuthorService; exploration leaves it off so the shared
   * pipeline's behaviour is unchanged. Default: false.
   */
  enableAssertAuthoring?: boolean;
  /**
   * Condensed Cartographer page understanding (forms, entities, interactive
   * areas) for the flow's starting page. Threaded into the Planner's
   * contextual hints so it doesn't re-derive page structure from raw DOM.
   * Optional — absent for non-exploration callers.
   */
  pageInsightContext?: string;
  /**
   * Condensed cross-flow learnings from OTHER flows in the same exploration:
   * what's already been accomplished (cookies accepted, logged in), which
   * categories just got blocked and why, and the active strategy focus. Lets
   * this flow's Planner skip solved obstacles and avoid a dead end a sibling
   * flow already hit, instead of re-deriving everything per flow. Optional —
   * absent for non-exploration callers and for the very first flow.
   */
  priorLearnings?: string;
}

/** Result returned by the pipeline */
export interface TestPipelineResult {
  /** Whether the test goal was achieved */
  success: boolean;
  /** Final phase when pipeline stopped */
  phase: PipelinePhase;
  /** Human-readable reason for completion */
  reason: string;
  /** Total rounds executed */
  roundsExecuted: number;
  /** Total commands executed across all rounds */
  commandsExecuted: number;
  /** Final progress score 0-100 */
  progressScore: number;
  /** Total pipeline duration in ms */
  durationMs: number;
  /** All execution rounds for reporting */
  rounds: ExecutionRound[];
  /** Accumulated insights from all agents */
  insights: string[];
  /** Overlay dismissals recorded during the flow (intra-round) so the flow
   *  runner can prepend them as replayable steps. */
  dismissals: RecordedDismissal[];
  /** Final page snapshot (for reporting) */
  finalSnapshot?: LiteSnapshot;
  /** Blocked info if test was blocked */
  blockedReason?: string;
  /**
   * Structured blocker type from the Executor's report_blocked (e.g.
   * 'captcha' | '2fa' | 'needs_data' | 'login_wall'). Set only when the
   * Executor explicitly reported a blocker. FlowRunner prefers this over
   * keyword-guessing the blockedReason string.
   */
  blockerType?: string;
  /** Whether the reported blocker is user-resolvable (from report_blocked). */
  canUserHelp?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND-TO-AICOMMAND MAPPING (bridge to existing ActionExecutor)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maps a PlaywrightCommand to the existing AICommand format
 * used by ActionExecutor.execute()
 */
export function toAICommand(cmd: PlaywrightCommand): AICommand | null {
  switch (cmd.name) {
    case 'fill_field':
      return {
        action: 'fill',
        ref: cmd.args.ref,
        value: cmd.args.value || '',
        isSensitive: cmd.args.is_sensitive ?? false,
      };
    case 'click_element':
      return {
        action: 'click',
        ref: cmd.args.ref,
      };
    case 'select_option':
      return {
        action: 'select',
        ref: cmd.args.ref,
        value: cmd.args.value,
      };
    case 'press_key':
      return {
        action: 'press',
        key: cmd.args.key,
      };
    case 'hover_element':
      return {
        action: 'hover',
        ref: cmd.args.ref,
      };
    case 'scroll_page':
      return {
        action: 'scroll',
        direction: cmd.args.direction || 'down',
        amount: cmd.args.amount || 600,
      };
    case 'scroll_to_element':
      return {
        action: 'scroll',
        targetRef: cmd.args.ref,
      };
    case 'navigate_to':
      return {
        action: 'goto',
        url: cmd.args.url,
      };
    case 'wait_for_page':
      return {
        action: 'wait',
      };
    case 'toggle_element':
      return {
        action: 'toggle',
        ref: cmd.args.ref,
      };
    case 'set_range':
      return {
        action: 'setRange',
        ref: cmd.args.ref,
        value: cmd.args.value,
      };
    case 'select_date':
      return {
        action: 'selectDate',
        ref: cmd.args.ref,
        value: cmd.args.value,
      };
    case 'clear_field':
      return {
        action: 'clear',
        ref: cmd.args.ref,
      };
    // observe_page, mark_done, report_blocked are handled separately
    default:
      return null;
  }
}
