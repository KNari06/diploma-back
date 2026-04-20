/**
 * Regression Doctor — drift-agent LLM wrapper
 *
 * One call per drift group. Takes the pattern, 3 sample failures, KB
 * chunks most relevant to the pattern, and the count of affected tests.
 * Asks the LLM to produce a diagnosis in plain English and a structured
 * patch suggestion the Bulk Fix UI (Phase-2) will apply with one click.
 *
 * Why separate from kb.service + Bug Inspector:
 *   • Bug Inspector analyzes ONE test end-to-end with full logs/DOM.
 *     Doctor analyzes a PATTERN across tests — shorter per-test context
 *     but wider across runs. Different prompt shape entirely.
 *   • Keeping the prompt here (not in src/ai/prompts/*) keeps this feature
 *     self-contained for easy excision / testing.
 */

import OpenAI from 'openai';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { getSharedOpenAIClient } from '@/services/ai/core/openai.service';
import { expandChunkForLLM, type KBChunk } from '@/services/kb/kb.service';
import type { DriftFailureInput, DriftGroup } from './grouping';

/**
 * Structured patch proposal. The Bulk Fix UI will materialize this into
 * an actual edit (insert step / replace selector / delete step / update
 * value) on every test in `affected_test_ids`.
 *
 * Kept deliberately small — the LLM is prone to over-specifying. Phase-2
 * may extend with e.g. `bindingHints` once we have real-world patches
 * to validate against.
 */
export interface DriftProposedPatch {
  action: 'insert_before' | 'replace_selector' | 'delete_step' | 'update_value';
  /** 0-based index in the test's steps_json. */
  targetStepIndex?: number;
  /**
   * For `insert_before` — the new step to insert. Minimal IntentStep
   * shape (type + description + optional value); the runner fills in
   * the rest via the normal lint pipeline.
   */
  insertStep?: {
    type: string;
    description: string;
    value?: string;
  };
  /** For `replace_selector` — the new CSS/text selector. */
  newSelector?: string;
  /** Short human-readable justification for the patch. */
  reason: string;
}

export interface DriftAgentVerdict {
  diagnosis: string;           // 1-2 sentence explanation for the UI
  confidence: number;          // 0.00 — 1.00, rounded to 2 decimals
  proposedPatch: DriftProposedPatch | null;
}

export interface AnalyzeDriftGroupInput {
  group: DriftGroup;
  sampleFailures: DriftFailureInput[];
  kbChunks: KBChunk[];
  affectedTestCount: number;
}

const MODEL = env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TOKENS = 800;
const TEMPERATURE = 0.2; // drift analysis should be conservative

/**
 * Primary entry point. Returns a safe fallback verdict on LLM errors so
 * the Doctor job never crashes — the finding will still get persisted
 * with whatever (low-confidence) diagnosis the fallback produces, and
 * the Bulk Fix UI can filter `confidence < 0.5` if it wants to hide
 * those.
 */
export async function analyzeDriftGroup(input: AnalyzeDriftGroupInput): Promise<DriftAgentVerdict> {
  const openai = getSharedOpenAIClient();
  const prompt = buildPrompt(input);

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: prompt },
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      throw new Error('Empty response from LLM');
    }
    return parseVerdict(raw);
  } catch (err) {
    logger.warn('[DRIFT_AGENT] LLM call failed — using fallback verdict', {
      patternKey: input.group.patternKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      diagnosis: buildFallbackDiagnosis(input.group, input.sampleFailures.length),
      confidence: 0.2,
      proposedPatch: null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

function systemPrompt(): string {
  return `You are a regression test drift analyst. You receive:
- A failure pattern (URL + element + error shape) that affected N tests in one regression run
- 2-3 sample failures that exhibit the pattern
- Knowledge Base chunks from the user's project (product specs, release notes, API docs)
- Count of affected tests

Your job: output a ONE-paragraph diagnosis in plain English, a confidence score (0.0-1.0), and — when confident — a structured proposed patch.

Diagnosis guidelines:
- Name the PRODUCT change, not the test failure. "Login page added captcha" — not "15 tests failed".
- If KB chunks support the diagnosis, say so ("release_notes.pdf confirms captcha was added April 15").
- If KB says nothing relevant, say the diagnosis is based only on failure shape.
- Be concise. One paragraph, 2-3 sentences max.

Confidence guidelines:
- 0.9–1.0: KB explicitly describes the change AND error shape is unambiguous
- 0.6–0.89: Strong pattern evidence, KB corroborates partially
- 0.3–0.59: Pattern looks like drift but KB provides no corroboration
- 0.0–0.29: Ambiguous — could be flaky or bug; do NOT propose a patch

Proposed patch guidelines:
- Only include a patch when confidence >= 0.6.
- "insert_before" is the safe default — most drifts need a new intermediate step (close overlay, solve captcha, expand accordion, dismiss banner).
- "replace_selector" when an element was renamed but the flow is unchanged.
- "delete_step" when a step targets something removed outright.
- "update_value" when a step's typed value became invalid (rare).
- Always include a "reason" explaining why the patch addresses the root cause.

Output JSON:
{
  "diagnosis": "string",
  "confidence": 0.0,
  "proposedPatch": null | {
    "action": "insert_before" | "replace_selector" | "delete_step" | "update_value",
    "targetStepIndex": number,
    "insertStep": { "type": "string", "description": "string", "value": "string" } | null,
    "newSelector": "string" | null,
    "reason": "string"
  }
}`;
}

function buildPrompt(input: AnalyzeDriftGroupInput): string {
  const { group, sampleFailures, kbChunks, affectedTestCount } = input;

  const samples = sampleFailures
    .slice(0, 3)
    .map(
      (f, i) =>
        `  Sample ${i + 1}: testResultId=${f.testResultId}${f.testCaseId ? `, testCaseId=${f.testCaseId}` : ''}`,
    )
    .join('\n');

  const kbBlocks =
    kbChunks.length === 0
      ? '  (no relevant KB chunks found)'
      : kbChunks
          .slice(0, 5)
          .map((c, i) => {
            const src = c.file_name ?? c.source_file ?? `chunk_${i + 1}`;
            const text = expandChunkForLLM(c).slice(0, 600);
            return `  [${i + 1}] source=${src}\n  ${text.replace(/\n+/g, ' ')}`;
          })
          .join('\n');

  return `FAILURE PATTERN:
  urlPattern:        ${group.urlPattern}
  targetElementKey:  ${group.targetElementKey}
  errorShape:        ${group.errorShape}
  failures_in_run:   ${group.failures.length}
  affected_tests:    ${affectedTestCount}

SAMPLE FAILURES (${Math.min(sampleFailures.length, 3)} of ${group.failures.length}):
${samples || '  (none)'}

PROJECT KNOWLEDGE BASE (${kbChunks.length} chunks):
${kbBlocks}

Return the JSON verdict now.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseVerdict(raw: string): DriftAgentVerdict {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Models occasionally wrap JSON in markdown despite response_format.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in LLM response');
    parsed = JSON.parse(match[0]);
  }

  const diagnosis = typeof parsed.diagnosis === 'string' && parsed.diagnosis.trim().length > 0
    ? parsed.diagnosis.trim()
    : 'Unable to determine drift cause from available context.';

  const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const confidence = Math.max(0, Math.min(1, Number(rawConfidence.toFixed(2))));

  const proposedPatch = validatePatch(parsed.proposedPatch, confidence);

  return { diagnosis, confidence, proposedPatch };
}

function validatePatch(raw: any, confidence: number): DriftProposedPatch | null {
  // Drop the patch if confidence is below the safety threshold — we
  // don't want users applying low-confidence changes by accident.
  if (confidence < 0.6) return null;
  if (!raw || typeof raw !== 'object') return null;

  const validActions = ['insert_before', 'replace_selector', 'delete_step', 'update_value'] as const;
  if (!validActions.includes(raw.action)) return null;

  const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
    ? raw.reason.trim()
    : null;
  if (!reason) return null;

  const patch: DriftProposedPatch = { action: raw.action, reason };

  if (typeof raw.targetStepIndex === 'number' && raw.targetStepIndex >= 0) {
    patch.targetStepIndex = Math.floor(raw.targetStepIndex);
  }
  if (raw.action === 'insert_before' && raw.insertStep && typeof raw.insertStep === 'object') {
    const { type, description, value } = raw.insertStep;
    if (typeof type === 'string' && typeof description === 'string') {
      patch.insertStep = {
        type,
        description,
        ...(typeof value === 'string' ? { value } : {}),
      };
    }
  }
  if (raw.action === 'replace_selector' && typeof raw.newSelector === 'string') {
    patch.newSelector = raw.newSelector;
  }

  // Sanity: patches that say "insert_before" but have no insertStep, or
  // "replace_selector" but no newSelector, are incomplete. Better to drop
  // them entirely than persist half-data that the UI can't apply.
  if (patch.action === 'insert_before' && !patch.insertStep) return null;
  if (patch.action === 'replace_selector' && !patch.newSelector) return null;

  return patch;
}

function buildFallbackDiagnosis(group: DriftGroup, sampleCount: number): string {
  return `Detected a ${group.errorShape.replace(/_/g, ' ')} drift affecting ${
    group.failures.length
  } tests on ${group.urlPattern} (element: ${group.targetElementKey}). LLM analysis unavailable — review ${sampleCount} sample failures manually.`;
}

// Exported for unit-tests only — the main entry point is `analyzeDriftGroup`.
export const __testing = { parseVerdict, validatePatch, buildPrompt, systemPrompt };

// Silence unused-import warning in case OpenAI namespace isn't consumed directly —
// we use it indirectly via getSharedOpenAIClient return type.
export type _ = OpenAI;
