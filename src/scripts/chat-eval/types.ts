/**
 * Shared types for the chat authoring eval harness (Tier-2a, deterministic).
 *
 * The harness replays a natural-language authoring request through the real
 * Planner→Executor→Reviewer pipeline (headless, no frontend) and scores the
 * authored step set structurally — no app run, no LLM judge (those are Tier-2b,
 * added later once a fixture app is chosen). See
 * claude-plans/qait-agents-to-be-state-20260718.md §3.
 */

/** 'add' = global create flow; 'edit' = per-test-case scope (bound to one case). */
export type ScenarioScope = 'add' | 'edit';

/** How a step set reached us — the tool-choice signal we score against. */
export type AuthoredVia = 'create' | 'update' | 'run_draft';

/**
 * Grounding requirement of a request.
 * - 'none': no external data needed to be runnable.
 * - 'credentials': needs login credentials. With NO credential store today, the
 *   only runnable move is to ASK the user (or leave an explicit placeholder) —
 *   NEVER fabricate a value. Inventing "a valid email" produces an unrunnable
 *   test that still looks structurally fine (a false-green Tier-2a must catch).
 */
export type Grounding = 'none' | 'credentials';

/** Shape of a step's `value` — captured instead of the raw value (secret-safe). */
export type ValueShape = 'placeholder' | 'literal' | 'empty';

/** A single bootstrap scenario. NOTE: hand-written = biased; replace with a
 * mined corpus from test_logs/chat_test/ before treating any baseline as
 * ground truth (plan §3, "Honest corpus"). */
export interface Scenario {
  id: string;
  name: string;
  scope: ScenarioScope;
  /** The user's message to the agent. */
  userMessage: string;
  /** Edit scenarios only — the existing case the chat is bound to. */
  boundTestCaseName?: string;
  /** Whether we expect the agent to author at least one step for this request. */
  expectsSteps: boolean;
  /** Grounding requirement (default 'none'). 'credentials' → must ask/placeholder, never fabricate. */
  grounding?: Grounding;
  /** Free-text note on what this scenario probes. */
  note?: string;
}

/** One replay of one scenario — the raw capture the scorer consumes. */
export interface CapturedRun {
  scenarioId: string;
  /** Replay completed without throwing (an LLM/infra error sets ok=false). */
  ok: boolean;
  error?: string;
  /** Pipeline path taken: simple_chat | single_tool | multi_tool | fallback. */
  pipelinePath?: string;
  /** The agent's final reply text. */
  content?: string;
  /** True when the agent asked a clarifying question instead of authoring. */
  needsClarification?: boolean;
  /**
   * The agent invoked an authoring tool whose steps CANNOT be captured headless
   * (today: `qa_author_test_iteratively` — it builds steps live on a preview the
   * headless replay doesn't have, and bails at its confirm-gate before producing
   * any). Distinguishes "authored via an uninstrumented tool" from "authored
   * nothing": the scorer treats such a run as UNCAPTURABLE (excluded from the
   * pass-rate), not a failure. Removing this needs Tier-2b (a live/stub preview).
   */
  uninstrumentedAuthoring?: boolean;
  /** Tools that authored a step set this turn (from trace source + draftSteps). */
  authoredVia: AuthoredVia[];
  /** The authored steps. `valueShape` classifies the value without storing it. */
  steps: Array<{ type?: string; description?: string; valueShape?: ValueShape }>;
}

/** Deterministic score for a single captured run. */
export interface ScenarioScore {
  scenarioId: string;
  producedSteps: boolean;
  /** edit → used update (not create); add → used create/run_draft (not update). */
  toolChoiceCorrect: boolean;
  /** edit scope never spawned a duplicate via create. */
  noDuplicate: boolean;
  /** Every authored step has a known type and a non-empty description. */
  stepsWellFormed: boolean;
  /** Credential requests were grounded (asked / placeholder), not fabricated. */
  grounded: boolean;
  /**
   * The agent authored via an uninstrumented tool the headless harness can't see
   * (`qa_author_test_iteratively`) — the step set is genuinely unmeasurable here,
   * NOT absent. Such a run is neither a pass nor a fail: `aggregate` drops it from
   * the pass-rate denominator so a valid tool choice never reads as a false-red.
   */
  uncapturable: boolean;
  passed: boolean;
  reasons: string[];
}
