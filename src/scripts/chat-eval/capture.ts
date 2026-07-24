/**
 * Pure step-capture helpers for the chat authoring eval.
 *
 * Extracted from replay.ts so the grounding-critical value classifier and the
 * raw-step normalizers are unit-testable WITHOUT loading the heavy live
 * pipeline (replay.ts pulls in SubAgentPipeline + the whole skill registry).
 * No I/O, no LLM — mirrors the scoring.ts "pure core" split.
 */

import type { ValueShape } from './types';

/** Classify a step's value WITHOUT storing it (secret-safe). */
export function classifyValueShape(value: unknown): ValueShape {
  if (typeof value !== 'string' || value.trim() === '') return 'empty';
  if (/\{\{[^}]+\}\}/.test(value)) return 'placeholder';
  return 'literal';
}

/**
 * Coerce a raw step field to `string | undefined`. A non-string that slipped
 * through (malformed tool output) becomes undefined rather than reaching the
 * scorer, where `description.trim()` on a number/object would throw and abort
 * the whole run. Mirrors the guard in executor-agent.buildStepTrace.
 */
export function normalizeStepField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Map raw draftSteps (from a qa_run_draft_steps turn) to the captured shape. */
export function stepsFromDraft(
  draftSteps: unknown[] | undefined,
): Array<{ type?: string; description?: string; valueShape: ValueShape }> {
  if (!Array.isArray(draftSteps)) return [];
  return draftSteps.map((s: any) => ({
    type: normalizeStepField(s?.type),
    description: normalizeStepField(s?.description),
    valueShape: classifyValueShape(s?.value),
  }));
}
