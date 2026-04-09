/**
 * parse-trace — convert a LiteTraceWriter JSONL file into a structured,
 * step-by-step analysis.
 *
 * This is a CLI-only module. It reads the JSONL file, groups events into
 * logical steps, and computes per-step timing / quality / token breakdowns.
 *
 * Two event models coexist in the traces:
 *
 *   1. LEGACY LOOP (lite-engine.ts main iteration loop):
 *      iteration_start → snapshot → ai_prompt → ai_response →
 *      action_execute_start → action_execute_end → iteration_end
 *
 *   2. PIPELINE V2 (pipeline/test-pipeline.ts + executor-agent.ts):
 *      round_start → planner_start → planner_done → executor_start →
 *      executor_tool_calls* → executor_command_result* →
 *      executor_done → reviewer_start → reviewer_done
 *
 * Both are handled. The parser groups events into logical "steps" where
 * one step = one executed action (one command). Iterations/rounds may
 * contain multiple steps.
 *
 * Design principles:
 *   - Pure functions where possible (easy to unit test)
 *   - Tolerant of missing fields — traces can be truncated mid-run
 *   - Never throw on malformed lines — log a warning and skip
 *   - Zero runtime imports from the LiteEngine hot path
 */

import * as fs from 'fs/promises';
import * as readline from 'readline';
import { createReadStream } from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES (self-contained, no runtime imports from LiteEngine)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raw event shape as persisted by LiteTraceWriter. Kept loose with
 * `Record<string, any>` payload — we extract fields defensively.
 */
export interface RawTraceEvent {
  ts: string;
  testId: string;
  mode?: 'lite';
  iteration?: number;
  stage: string;
  eventType: string;
  spanId?: string;
  parentSpanId?: string;
  payload: Record<string, any>;
}

/** Aggregated timing breakdown per step (ms). All fields optional — gaps
 * are expected depending on which engine path produced the trace. */
export interface StepPhaseTiming {
  /** Observer agent LLM call (multi-agent brain path) */
  observerMs?: number;
  /** Strategist agent LLM call */
  strategistMs?: number;
  /** Actor agent LLM call */
  actorMs?: number;
  /** Critic agent LLM call */
  criticMs?: number;
  /** Total multi-agent pipeline time for this step (sum of above + overhead) */
  multiAgentTotalMs?: number;
  /** Pipeline v2 planner call */
  plannerMs?: number;
  /** Pipeline v2 executor tool-calling loop (single LLM call per sub-round) */
  executorMs?: number;
  /** Pipeline v2 reviewer call */
  reviewerMs?: number;
  /** Playwright action duration (browser work only, no LLM) */
  playwrightMs?: number;
  /** Time between events we couldn't attribute (waits, renders, etc.) */
  otherMs?: number;
}

/** Quality signals per step — what went right/wrong. */
export interface StepQuality {
  /** Action outcome, as classified by the engine */
  outcome: 'success' | 'no_effect' | 'error' | 'skipped' | 'unknown';
  /** Critic verdict (if multi-agent Critic was invoked) */
  criticVerdict?: 'approve' | 'reject' | 'override' | 'skipped';
  /** Number of warn-level policy violations (Critic or SafetyInterceptor) */
  criticWarnings: number;
  /** True if SafetyInterceptor blocked this command before execution */
  safetyBlocked: boolean;
  /** True if Supervisor recovery mode was active during this step */
  supervisorRecovery: boolean;
  /** True if stale ref / hallucinated ref was detected */
  staleRefDetected: boolean;
  /** True if multi-agent fell back to monolithic path for this decision */
  monolithicFallback: boolean;
  /** True if Pipeline v2 hit the "empty executor" or "same state" stuck detector */
  stuckFlagged: boolean;
  /** True if the action was a retry of a previously failed ref/command */
  wasRetry: boolean;
  /** Human-readable notes for the step (short, for the table output) */
  notes: string[];
}

/** Token / cost info per step. All optional — not every LLM call emits usage. */
export interface StepLLMUsage {
  /** Number of LLM calls attributed to this step (agents + auditor + executor) */
  calls: number;
  /** Sum of input tokens across all calls in this step */
  inputTokens: number;
  /** Sum of output tokens across all calls in this step */
  outputTokens: number;
  /** Sum of totalTokens (may differ from in+out due to truncation / reasoning tokens) */
  totalTokens: number;
  /** Rough USD cost estimate (best-effort, see COST_TABLE) */
  estimatedCostUsd: number;
  /** Set of models invoked during this step (for audit) */
  models: string[];
}

/** One logical step = one executed action (or one iteration if no action ran). */
export interface ParsedStep {
  /** 1-based step index across the whole test */
  index: number;
  /** Iteration (legacy) or round (pipeline v2) this step belongs to */
  iteration: number;
  /** Which engine path produced this step */
  engine: 'legacy' | 'pipeline_v2' | 'preview_run' | 'unknown';
  /** Short human description (from command/action/plan) */
  description: string;
  /** Action details */
  action: {
    type: string;
    ref?: string;
    value?: string;
    url?: string;
  };
  /** Wall-clock duration of this step in ms (from first to last event in the step) */
  durationMs: number;
  /** Event timeline for debugging (eventType, relative offset from step start) */
  timeline: Array<{ eventType: string; offsetMs: number }>;
  /** Timing breakdown by phase */
  phases: StepPhaseTiming;
  /** Quality signals */
  quality: StepQuality;
  /** LLM usage */
  llm: StepLLMUsage;
}

export interface ParsedTrace {
  /** testId from the first run_start event */
  testId: string;
  /** Path to the source JSONL file */
  filePath: string;
  /** ISO timestamp of run_start (or first event) */
  startedAt: string;
  /** ISO timestamp of run_end (or last event) */
  endedAt: string;
  /** Total wall-clock duration in ms */
  totalDurationMs: number;
  /** Raw event count (for sanity check) */
  eventCount: number;
  /** Number of malformed lines skipped */
  malformedLines: number;
  /** Engine path(s) observed — a single test may span multiple paths via fall-through */
  enginePathsObserved: Array<'legacy' | 'pipeline_v2' | 'preview_run'>;
  /** Execution path (from run_end payload if present, e.g. "hybrid_success") */
  executionPath?: string;
  /** Final success flag (from run_end payload) */
  success?: boolean;
  /** Final reason string (from run_end payload) */
  reason?: string;
  /** Parsed steps in chronological order */
  steps: ParsedStep[];
  /** Roll-up summary across all steps */
  summary: {
    stepCount: number;
    iterationCount: number;
    /** Sum of durations by phase */
    timingByPhase: Record<string, number>;
    quality: {
      successfulActions: number;
      noEffectActions: number;
      errorActions: number;
      criticWarnings: number;
      safetyBlocks: number;
      supervisorRecoveryRounds: number;
      staleRefRetries: number;
      monolithicFallbacks: number;
    };
    cost: {
      llmCalls: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
      models: string[];
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COST TABLE (rough, for human-readable USD estimates)
//
// These are approximate per-million-token prices. Exact cost depends on
// model tier and cache discounts; the CLI only needs order-of-magnitude
// accuracy for debugging. Update as pricing changes.
// ═══════════════════════════════════════════════════════════════════════════

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const COST_TABLE: Record<string, ModelPricing> = {
  // OpenAI — rough estimates
  'gpt-4o-mini':     { inputPerMillion: 0.15,  outputPerMillion: 0.60 },
  'gpt-4o':          { inputPerMillion: 2.50,  outputPerMillion: 10.00 },
  'gpt-5-mini':      { inputPerMillion: 0.25,  outputPerMillion: 2.00 },
  'gpt-5':           { inputPerMillion: 1.25,  outputPerMillion: 10.00 },
  // Anthropic
  'claude-3-5-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet':     { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-opus':       { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  // Gemini
  'gemini-2.5-flash-lite': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-2.5-flash':      { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  'gemini-2.5-pro':        { inputPerMillion: 1.25, outputPerMillion: 10.00 },
};

/** Best-effort USD estimate for a single LLM call. */
function estimateCost(model: string | undefined, inputTokens: number, outputTokens: number): number {
  if (!model) return 0;
  // Try exact match first, then substring (tolerates version suffixes)
  let pricing = COST_TABLE[model];
  if (!pricing) {
    const key = Object.keys(COST_TABLE).find((k) => model.includes(k));
    if (key) pricing = COST_TABLE[key];
  }
  if (!pricing) return 0; // unknown model → don't pretend to know cost
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// JSONL STREAMING READER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stream a JSONL file line-by-line, yielding parsed events. Malformed
 * lines are counted and skipped (we report the count in ParsedTrace.malformedLines).
 */
export async function readTraceEvents(filePath: string): Promise<{
  events: RawTraceEvent[];
  malformedLines: number;
}> {
  const events: RawTraceEvent[] = [];
  let malformedLines = 0;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && parsed.eventType && parsed.ts) {
        events.push(parsed as RawTraceEvent);
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }

  return { events, malformedLines };
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP GROUPING — turn a stream of events into a list of steps
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract optional token usage from a payload. Two shapes are supported:
 *   - `payload.tokensUsed: { inputTokens, outputTokens, totalTokens }` (preferred)
 *   - `payload.tokensUsed: number` (legacy, only total)
 *   - flat `payload.inputTokens / outputTokens / totalTokens`
 */
function extractTokens(payload: Record<string, any>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const model = typeof payload.model === 'string' ? payload.model : undefined;

  const tu = payload.tokensUsed;
  if (tu && typeof tu === 'object') {
    return {
      inputTokens: Number(tu.inputTokens) || 0,
      outputTokens: Number(tu.outputTokens) || 0,
      totalTokens: Number(tu.totalTokens) || Number(tu.inputTokens || 0) + Number(tu.outputTokens || 0),
      model: typeof tu.model === 'string' ? tu.model : model,
    };
  }
  if (typeof tu === 'number') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: tu, model };
  }

  if (
    typeof payload.inputTokens === 'number' ||
    typeof payload.outputTokens === 'number' ||
    typeof payload.totalTokens === 'number'
  ) {
    const input = Number(payload.inputTokens) || 0;
    const output = Number(payload.outputTokens) || 0;
    const total = Number(payload.totalTokens) || input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total, model };
  }

  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model };
}

/** Create an empty step template with zero'd counters. */
function blankStep(index: number, iteration: number, engine: ParsedStep['engine']): ParsedStep {
  return {
    index,
    iteration,
    engine,
    description: '',
    action: { type: 'unknown' },
    durationMs: 0,
    timeline: [],
    phases: {},
    quality: {
      outcome: 'unknown',
      criticWarnings: 0,
      safetyBlocked: false,
      supervisorRecovery: false,
      staleRefDetected: false,
      monolithicFallback: false,
      stuckFlagged: false,
      wasRetry: false,
      notes: [],
    },
    llm: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      models: [],
    },
  };
}

/**
 * The grouping algorithm walks events in order and carries "current step"
 * state. A new step starts on:
 *   - LEGACY: `iteration_start`
 *   - PIPELINE V2: `round_start`
 *
 * Within a step, events contribute to the step's timing / quality / llm
 * fields. On the next step-start event, the previous step is finalized.
 */
function groupIntoSteps(events: RawTraceEvent[]): ParsedStep[] {
  const steps: ParsedStep[] = [];
  let current: ParsedStep | null = null;
  let currentStart: number | null = null;
  let stepIndex = 0;

  const finalizeCurrent = (endTs: number) => {
    if (!current || currentStart === null) return;
    current.durationMs = Math.max(0, endTs - currentStart);
    // Compute "other" time = wall-clock - sum of known phase times
    const knownMs =
      (current.phases.observerMs ?? 0) +
      (current.phases.strategistMs ?? 0) +
      (current.phases.actorMs ?? 0) +
      (current.phases.criticMs ?? 0) +
      (current.phases.plannerMs ?? 0) +
      (current.phases.executorMs ?? 0) +
      (current.phases.reviewerMs ?? 0) +
      (current.phases.playwrightMs ?? 0);
    if (current.durationMs > knownMs) {
      current.phases.otherMs = current.durationMs - knownMs;
    }
    // Dedupe models, drop zero-cost rows
    current.llm.models = Array.from(new Set(current.llm.models));
    current.llm.estimatedCostUsd = Math.round(current.llm.estimatedCostUsd * 10_000) / 10_000;
    steps.push(current);
    current = null;
    currentStart = null;
  };

  const startNewStep = (event: RawTraceEvent, engine: ParsedStep['engine']) => {
    finalizeCurrent(Date.parse(event.ts));
    stepIndex++;
    const iterationNum =
      typeof event.iteration === 'number'
        ? event.iteration
        : (event.payload?.round ?? stepIndex - 1);
    current = blankStep(stepIndex, iterationNum, engine);
    currentStart = Date.parse(event.ts);
    current.timeline.push({ eventType: event.eventType, offsetMs: 0 });
  };

  for (const event of events) {
    const eventTime = Date.parse(event.ts);
    if (Number.isNaN(eventTime)) continue;

    // ── Step start triggers ──
    if (event.eventType === 'iteration_start') {
      startNewStep(event, 'legacy');
      continue;
    }
    if (event.eventType === 'round_start') {
      startNewStep(event, 'pipeline_v2');
      continue;
    }
    // Preview run has its own scheme: step_start/step_result pairs.
    // Each step_start opens a new logical step; we finalize on next
    // step_start or file end. Payload fields are captured via the
    // freshly-created step inside startNewStep.
    if (event.eventType === 'step_start') {
      startNewStep(event, 'preview_run');
      const p = event.payload ?? {};
      // Runtime guard (not a type guard — TS control flow narrows `current`
      // to `null` after startNewStep because the helper assigns to the
      // closure variable in a way TS can't track).
      const freshStep = current as unknown as ParsedStep | null;
      if (freshStep) {
        if (typeof p.stepType === 'string') {
          freshStep.action.type = p.stepType;
        }
        if (typeof p.description === 'string') {
          freshStep.description = String(p.description).slice(0, 60);
        }
        if (typeof p.stepIndex === 'number') {
          freshStep.iteration = p.stepIndex;
        }
      }
      continue;
    }

    // If we haven't seen any step-start yet, skip standalone events
    // (initialization, run_start, adaptive_timeouts, etc.)
    if (!current || currentStart === null) continue;

    // Capture a locally-typed non-null reference for the rest of this iteration.
    // TypeScript's flow analysis can't prove `current` stays non-null because
    // it's a closure variable mutated by helper functions; the local alias
    // keeps narrowing stable throughout the block.
    const step: ParsedStep = current;
    const stepStart: number = currentStart;

    // Record the event in the timeline
    step.timeline.push({
      eventType: event.eventType,
      offsetMs: eventTime - stepStart,
    });

    // ── Multi-agent phase timings (expected when A3 enrichment lands) ──
    // For now, fallback: look for durationMs on any agent-specific event.
    const p = event.payload ?? {};

    // ── LEGACY PATH: ai_* events, action_execute_* events ──
    if (event.eventType === 'ai_prompt' || event.eventType === 'ai_response') {
      const tokens = extractTokens(p);
      if (tokens.totalTokens > 0 || tokens.inputTokens > 0 || tokens.outputTokens > 0) {
        step.llm.calls += event.eventType === 'ai_response' ? 1 : 0; // count only responses
        step.llm.inputTokens += tokens.inputTokens;
        step.llm.outputTokens += tokens.outputTokens;
        step.llm.totalTokens += tokens.totalTokens;
        if (tokens.model) step.llm.models.push(tokens.model);
        step.llm.estimatedCostUsd += estimateCost(tokens.model, tokens.inputTokens, tokens.outputTokens);
      }
    }

    if (event.eventType === 'multi_agent_debug') {
      // New event from multi-agent orchestrator (existing). Try to pull phase ms.
      const debug = p.debug ?? {};
      if (typeof debug.observerMs === 'number') step.phases.observerMs = debug.observerMs;
      if (typeof debug.strategistMs === 'number') step.phases.strategistMs = debug.strategistMs;
      if (typeof debug.actorMs === 'number') step.phases.actorMs = debug.actorMs;
      if (typeof debug.criticMs === 'number') step.phases.criticMs = debug.criticMs;
      if (typeof debug.totalMs === 'number') step.phases.multiAgentTotalMs = debug.totalMs;
      if (debug.criticVerdict) step.quality.criticVerdict = debug.criticVerdict;
      if (debug.criticSkippedLowRisk) step.quality.notes.push('critic skipped (low-risk)');
      if (debug.circuitBreakerSkipped) step.quality.monolithicFallback = true;
      if (debug.supervisorRecoveryMode) step.quality.supervisorRecovery = true;
      if (debug.skipPathSafetyBlocked) step.quality.safetyBlocked = true;
      if (debug.reStrategized) step.quality.notes.push('re-strategized');
    }

    if (event.eventType === 'action_execute_start') {
      const cmd = p.command ?? {};
      step.action = {
        type: cmd.action ?? 'unknown',
        ref: cmd.ref,
        value: cmd.value,
        url: cmd.url,
      };
      step.description = `${cmd.action ?? 'unknown'}${cmd.ref ? `(${cmd.ref})` : ''}`;
    }

    if (event.eventType === 'action_execute_end') {
      if (typeof p.durationMs === 'number') step.phases.playwrightMs = p.durationMs;
      if (typeof p.outcome === 'string') {
        const outcome = p.outcome.toLowerCase();
        if (outcome === 'success' || outcome === 'no_effect' || outcome === 'error') {
          step.quality.outcome = outcome as StepQuality['outcome'];
        }
      }
    }

    // ── PIPELINE V2 PATH ──
    if (event.eventType === 'planner_done') {
      if (typeof p.durationMs === 'number') step.phases.plannerMs = p.durationMs;
      if (typeof p.summary === 'string' && !step.description) {
        step.description = String(p.summary).slice(0, 60);
      }
    }

    if (event.eventType === 'executor_done') {
      // Not a precise per-call timing but a useful aggregate
      if (typeof p.durationMs === 'number') {
        step.phases.executorMs = (step.phases.executorMs ?? 0) + p.durationMs;
      }
    }

    if (event.eventType === 'executor_tool_calls' || event.eventType === 'executor_no_tools') {
      const tokens = extractTokens(p);
      if (event.eventType === 'executor_tool_calls') step.llm.calls++;
      step.llm.inputTokens += tokens.inputTokens;
      step.llm.outputTokens += tokens.outputTokens;
      step.llm.totalTokens += tokens.totalTokens;
      if (tokens.model) step.llm.models.push(tokens.model);
      step.llm.estimatedCostUsd += estimateCost(tokens.model, tokens.inputTokens, tokens.outputTokens);
    }

    if (event.eventType === 'executor_command_result') {
      const cmd = p.command ?? '';
      const args = p.args ?? {};
      const isTerminal = cmd === 'mark_done' || cmd === 'report_blocked';
      if (!isTerminal) {
        step.action = {
          type: String(cmd),
          ref: args.ref,
          value: args.value,
          url: args.url,
        };
        step.description = `${cmd}${args.ref ? `(${args.ref})` : ''}`;
        if (typeof p.durationMs === 'number') {
          step.phases.playwrightMs = (step.phases.playwrightMs ?? 0) + p.durationMs;
        }
        if (p.success === true) step.quality.outcome = 'success';
        else if (p.success === false) step.quality.outcome = 'error';
        if (typeof p.error === 'string' && p.error.startsWith('SAFETY_INTERCEPTOR')) {
          step.quality.safetyBlocked = true;
          step.quality.notes.push('safety interceptor block');
        }
      }
      if (p.done === true) step.quality.notes.push('mark_done');
      if (p.blocked === true) step.quality.notes.push('report_blocked');
    }

    if (event.eventType === 'reviewer_done' || event.eventType === 'reviewer_audit_done' || event.eventType === 'reviewer_ai_response') {
      if (typeof p.durationMs === 'number') {
        step.phases.reviewerMs = (step.phases.reviewerMs ?? 0) + p.durationMs;
      }
      if (typeof p.verdict === 'string') {
        if (p.verdict === 'replan') step.quality.notes.push('replan requested');
        else if (p.verdict === 'blocked') step.quality.notes.push('reviewer: blocked');
      }
      const tokens = extractTokens(p);
      if (tokens.totalTokens > 0) {
        step.llm.calls++;
        step.llm.inputTokens += tokens.inputTokens;
        step.llm.outputTokens += tokens.outputTokens;
        step.llm.totalTokens += tokens.totalTokens;
        if (tokens.model) step.llm.models.push(tokens.model);
        step.llm.estimatedCostUsd += estimateCost(tokens.model, tokens.inputTokens, tokens.outputTokens);
      }
    }

    if (event.eventType === 'planner_response' || event.eventType === 'planner_prompt') {
      const tokens = extractTokens(p);
      if (event.eventType === 'planner_response' && tokens.totalTokens > 0) {
        step.llm.calls++;
        step.llm.inputTokens += tokens.inputTokens;
        step.llm.outputTokens += tokens.outputTokens;
        step.llm.totalTokens += tokens.totalTokens;
        if (tokens.model) step.llm.models.push(tokens.model);
        step.llm.estimatedCostUsd += estimateCost(tokens.model, tokens.inputTokens, tokens.outputTokens);
      }
    }

    // ── SUPERVISOR SIGNALS ──
    if (event.eventType === 'supervisor_tier1' || event.eventType === 'supervisor_tier1_seed') {
      if (p.recoveryMode === true) step.quality.supervisorRecovery = true;
      if (typeof p.currentBlocker === 'string' && p.currentBlocker) {
        step.quality.notes.push(`blocker: ${p.currentBlocker}`);
      }
    }

    if (event.eventType === 'safety_interceptor_auto_disabled') {
      step.quality.notes.push('safety interceptor auto-disabled');
    }

    // ── PREVIEW RUN PATH ──
    // Each step is a pre-recorded IntentStep replayed by the editor preview
    // runner. Events: step_start → step_result. Rich payload on step_result.
    if (event.eventType === 'step_result') {
      // Outcome mapping (preview uses "pass" / "fail", sometimes "skipped")
      const status = String(p.status ?? '').toLowerCase();
      if (status === 'pass' || status === 'success') step.quality.outcome = 'success';
      else if (status === 'fail' || status === 'error') step.quality.outcome = 'error';
      else if (status === 'skipped') step.quality.outcome = 'skipped';

      // Compiled plan + evidence signals
      if (p.retried === true) step.quality.wasRetry = true;
      if (typeof p.attempts === 'number' && p.attempts > 1) {
        step.quality.wasRetry = true;
        step.quality.notes.push(`${p.attempts} attempts`);
      }
      if (p.urlChanged === true) step.quality.notes.push('url changed');
      if (p.verified === true) step.quality.notes.push('verified');
      if (typeof p.fallback === 'string' && p.fallback) {
        step.quality.notes.push(`fallback: ${p.fallback}`);
      }
      if (typeof p.error === 'string' && p.error) {
        step.quality.notes.push(`error: ${String(p.error).slice(0, 60)}`);
      }
    }

    // ── TERMINAL ITERATION/ROUND END ──
    if (event.eventType === 'iteration_end' || event.eventType === 'reviewer_done') {
      // These don't strictly end the step — next iteration_start / round_start
      // will finalize it. But we record the outcome reason if present.
      if (typeof p.reason === 'string' && p.reason && p.reason !== 'completed' && p.reason !== 'continue') {
        step.quality.notes.push(`iter_end: ${p.reason}`);
      }
    }
  }

  // Finalize the last step using the timestamp of the last event
  if (current && events.length > 0) {
    const lastTs = Date.parse(events[events.length - 1].ts);
    finalizeCurrent(lastTs);
  }

  return steps;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOP-LEVEL PARSE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a JSONL trace file into a structured ParsedTrace.
 *
 * Pure async function: reads file → parses → groups into steps → computes
 * summary. Safe to call on in-progress files (best-effort for truncated
 * tail events).
 */
export async function parseTrace(filePath: string): Promise<ParsedTrace> {
  // Sanity check the file exists and is non-empty
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Trace file is empty: ${filePath}`);
  }

  const { events, malformedLines } = await readTraceEvents(filePath);
  if (events.length === 0) {
    throw new Error(`No parseable events found in ${filePath}`);
  }

  // ── Extract run-level metadata from run_start / run_end ──
  const runStart = events.find((e) => e.eventType === 'run_start');
  const runEnd = events.find((e) => e.eventType === 'run_end');
  const testId = runStart?.testId ?? runEnd?.testId ?? events[0].testId ?? 'unknown';
  const startedAt = runStart?.ts ?? events[0].ts;
  const endedAt = runEnd?.ts ?? events[events.length - 1].ts;

  // NaN guard: Date.parse returns NaN on malformed ISO strings. Even though
  // readTraceEvents filters events missing `ts`, it doesn't validate that `ts`
  // is parseable. A NaN here would propagate into formatMs / summary rollup
  // and produce "NaNms" output. Guard explicitly and fall back to 0.
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  const rawDuration = endMs - startMs;
  const totalDurationMs = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;
  const executionPath = typeof runEnd?.payload?.executionPath === 'string'
    ? runEnd.payload.executionPath
    : undefined;
  const success = typeof runEnd?.payload?.success === 'boolean' ? runEnd.payload.success : undefined;
  const reason = typeof runEnd?.payload?.reason === 'string' ? runEnd.payload.reason : undefined;

  // ── Group into steps ──
  const steps = groupIntoSteps(events);

  // ── Determine engine paths observed ──
  const enginePathsObserved: Array<'legacy' | 'pipeline_v2' | 'preview_run'> = [];
  if (steps.some((s) => s.engine === 'legacy')) enginePathsObserved.push('legacy');
  if (steps.some((s) => s.engine === 'pipeline_v2')) enginePathsObserved.push('pipeline_v2');
  if (steps.some((s) => s.engine === 'preview_run')) enginePathsObserved.push('preview_run');

  // ── Compute summary ──
  const timingByPhase: Record<string, number> = {};
  const addPhase = (key: keyof StepPhaseTiming, value?: number) => {
    if (typeof value !== 'number' || value <= 0) return;
    timingByPhase[key] = (timingByPhase[key] ?? 0) + value;
  };

  let successfulActions = 0;
  let noEffectActions = 0;
  let errorActions = 0;
  let criticWarnings = 0;
  let safetyBlocks = 0;
  let supervisorRecoveryRounds = 0;
  let staleRefRetries = 0;
  let monolithicFallbacks = 0;
  const iterationsSeen = new Set<number>();
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  const modelsSeen = new Set<string>();

  for (const step of steps) {
    iterationsSeen.add(step.iteration);
    addPhase('observerMs', step.phases.observerMs);
    addPhase('strategistMs', step.phases.strategistMs);
    addPhase('actorMs', step.phases.actorMs);
    addPhase('criticMs', step.phases.criticMs);
    addPhase('plannerMs', step.phases.plannerMs);
    addPhase('executorMs', step.phases.executorMs);
    addPhase('reviewerMs', step.phases.reviewerMs);
    addPhase('playwrightMs', step.phases.playwrightMs);
    addPhase('otherMs', step.phases.otherMs);

    if (step.quality.outcome === 'success') successfulActions++;
    else if (step.quality.outcome === 'no_effect') noEffectActions++;
    else if (step.quality.outcome === 'error') errorActions++;

    criticWarnings += step.quality.criticWarnings;
    if (step.quality.safetyBlocked) safetyBlocks++;
    if (step.quality.supervisorRecovery) supervisorRecoveryRounds++;
    if (step.quality.staleRefDetected) staleRefRetries++;
    if (step.quality.monolithicFallback) monolithicFallbacks++;

    llmCalls += step.llm.calls;
    inputTokens += step.llm.inputTokens;
    outputTokens += step.llm.outputTokens;
    totalTokens += step.llm.totalTokens;
    estimatedCostUsd += step.llm.estimatedCostUsd;
    step.llm.models.forEach((m) => modelsSeen.add(m));
  }

  return {
    testId,
    filePath,
    startedAt,
    endedAt,
    totalDurationMs,
    eventCount: events.length,
    malformedLines,
    enginePathsObserved,
    executionPath,
    success,
    reason,
    steps,
    summary: {
      stepCount: steps.length,
      iterationCount: iterationsSeen.size,
      timingByPhase,
      quality: {
        successfulActions,
        noEffectActions,
        errorActions,
        criticWarnings,
        safetyBlocks,
        supervisorRecoveryRounds,
        staleRefRetries,
        monolithicFallbacks,
      },
      cost: {
        llmCalls,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10_000) / 10_000,
        models: Array.from(modelsSeen),
      },
    },
  };
}
