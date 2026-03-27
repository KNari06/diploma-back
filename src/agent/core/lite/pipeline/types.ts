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

import type { AICommand, LiteSnapshot } from '../lite-types';

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
  | 'report_blocked';    // signal test blocked (CAPTCHA, 2FA, etc.)

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

  // ── Progress tracking ──
  progressScore: number;              // 0-100, updated by observe_page via GoalDetector

  // ── Goal expansion (from GoalExpander, set once at pipeline start) ──
  expandedGoalKeywords?: string[];    // combined action+object keywords for Planner hints

  // ── Contextual hints (from GoalDetector, updated per round) ──
  contextualHints?: string[];         // navigation hints (e.g. "registration form not visible, click Sign Up")
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
  /** Final page snapshot (for reporting) */
  finalSnapshot?: LiteSnapshot;
  /** Blocked info if test was blocked */
  blockedReason?: string;
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
