/**
 * Mobile-agent Planner (Phase 5).
 *
 * Role: one-shot LLM call that turns a user goal ("create a login test",
 * "sign up and add an item to cart") into a structured FlowPlan — an
 * ordered list of high-level sub-goals the executor can walk through.
 *
 * Design:
 *   - The planner is NOT a sub-agent with its own loop; it's a single
 *     `getChatCompletionWithMessages` call with a strict JSON response
 *     schema. Output validated via Zod; on parse failure we return null
 *     and the caller surfaces a user-facing hint.
 *   - The plan is ADVISORY. The executor LLM may deviate from it when the
 *     observed screen makes a step unnecessary or when the order needs to
 *     change. Plans exist to give the agent a spine, not a script.
 *   - Credentials NEVER appear in plan steps. Plans reference the user's
 *     prompt ("the email the user provided") — the executor fills them
 *     at execution time, with isSensitive=true where appropriate.
 *
 * Why this matters:
 *   - Without a plan, a request like "log in and add something to cart"
 *     becomes an unbounded observe/tap loop. The LLM drifts after 5-7
 *     rounds. A 4-step plan gives the loop a finite checklist.
 *   - The `verify` field per step is what lets the reviewer (Phase 5.5+)
 *     decide if the flow passed or failed. Without it we just have a
 *     sequence of actions with no assertion.
 */

import { z } from 'zod';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { chooseToolCapableModel as pickToolCapableModel } from '../shared/tool-capable-model';
import { logger } from '@/utils/core/logger';
import type { MobileUiState } from '@/services/mobile/mobile-runner.types';
import { redactPii } from '@/services/chat/pii-redactor';
import { wrapUntrusted, UNTRUSTED_CONTENT_INSTRUCTION } from '@/services/chat/untrusted-content-wrapper';
import { env } from '@/config/environment/env';

// ─────────────────────────────────────────────────────────────────────────
// Schema — every field the executor needs to drive one step.
// Keep it narrow: the LLM produces fewer hallucinated fields when schema
// is small.
// ─────────────────────────────────────────────────────────────────────────

export const FlowPlanStepSchema = z.object({
  id: z.number().int().positive(),
  intent: z
    .string()
    .min(3)
    .max(200)
    .describe('High-level sub-goal in plain English — "Open login screen", "Fill email field".'),
  verify: z
    .string()
    .min(3)
    .max(200)
    .describe(
      'Observable condition after the step. Must be checkable via the a11y tree: ' +
        '"Submit button visible", "Home screen shows cart icon", "Password field focused".',
    ),
  requiresConfirmation: z
    .boolean()
    .optional()
    .describe(
      'True for destructive or irreversible actions (delete account, submit payment, ' +
        'uninstall). Executor must STOP and ask the user before running.',
    ),
  notes: z.string().max(200).optional(),
});

export const FlowPlanSchema = z
  .object({
    goal: z.string().min(3).max(200),
    // Steps are optional ONLY on the clarification path: when the goal is too
    // vague to plan (no target flow, no acceptance criteria), the planner
    // returns needsClarification=true + clarifyingQuestion and NO steps. On
    // the happy path steps is required and non-empty — enforced by the
    // refine() below so the executor never installs an empty plan.
    steps: z.array(FlowPlanStepSchema).max(15).optional(),
    assumesCredentialsFromUser: z.boolean().optional(),
    needsClarification: z
      .boolean()
      .optional()
      .describe(
        'True when the goal is underspecified (no concrete target flow / no ' +
          'acceptance criteria) and planning would mean guessing. When true, ' +
          'omit steps and provide clarifyingQuestion instead.',
      ),
    clarifyingQuestion: z
      .string()
      .min(5)
      .max(300)
      .optional()
      .describe(
        'A single focused question to disambiguate the goal. Required when ' +
          'needsClarification is true. Example: "Which flow should I test — ' +
          'login, sign-up, or something else? And what counts as success?"',
      ),
  })
  .refine(
    (p) =>
      p.needsClarification
        ? typeof p.clarifyingQuestion === 'string' && p.clarifyingQuestion.length >= 5
        : Array.isArray(p.steps) && p.steps.length >= 1,
    {
      message:
        'Either provide a non-empty steps[] (concrete plan) OR set ' +
        'needsClarification=true with a clarifyingQuestion (vague goal).',
    },
  );

export type FlowPlanStep = z.infer<typeof FlowPlanStepSchema>;
export type FlowPlan = z.infer<typeof FlowPlanSchema>;

/**
 * A plan that is guaranteed to carry executable steps — the non-clarification
 * outcome. `runPlanFlow` narrows a validated `FlowPlan` to this after the
 * `needsClarification` gate; the blackboard's `setPlan` requires it so the
 * plan-walking tools never face an undefined `steps`.
 */
export type ConcreteFlowPlan = FlowPlan & { steps: FlowPlanStep[] };

// ─────────────────────────────────────────────────────────────────────────
// Prompt — static, cacheable. Keep it narrow: describe the goal, the
// current screen, and the output contract. No action tool list here —
// the plan is abstract; the executor maps steps to tools.
// ─────────────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = [
  'You are QAIT\u2019s mobile test planner. Decompose the user goal into 2–10 ordered',
  'sub-goals that a mobile test executor can attempt one at a time on a live device.',
  '',
  'Rules:',
  '1. Each step is ONE observable action or small action-group ("Open login", "Fill',
  '   email", "Tap submit"). Do not collapse a multi-screen flow into one step.',
  '2. Every step has a `verify` field — a POST-CONDITION that can be read from the',
  '   a11y tree. Examples: "home screen shows welcome banner", "error toast',
  '   visible". Without verify, the executor cannot tell success from noise.',
  '3. NEVER put credentials, OTPs, or personal data in the `intent` or `verify` text.',
  '   Refer to them as "the email the user provided", "the password supplied by',
  '   the user". The executor will substitute at run time.',
  '4. Mark `requiresConfirmation: true` for destructive/irreversible steps:',
  '   submitting payment, deleting data, uninstalling, purchasing.',
  '5. Order matters — steps run sequentially. No parallelism.',
  '6. Use the CURRENT SCREEN context to decide the FIRST step. If the user is already',
  '   on the login screen, don\u2019t plan "navigate to login".',
  '7. Keep plans short. 3–6 steps is typical. Max 10.',
  '8. AMBIGUITY GATE — check BEFORE planning. If the goal is underspecified —',
  '   no concrete target flow (e.g. "create some test steps", "test the app",',
  '   "make a test") and no acceptance criteria you could write a `verify`',
  '   against — do NOT invent a flow. Return needsClarification=true, omit',
  '   steps, and put ONE focused question in clarifyingQuestion asking what to',
  '   test and what success looks like. A goal that names a flow ("login test",',
  '   "sign up and add to cart") is specific enough — plan it, do not ask.',
  '',
  'Output ONLY valid JSON. Concrete goal → steps (no markdown):',
  '{',
  '  "goal": "<restated user goal>",',
  '  "steps": [',
  '    { "id": 1, "intent": "...", "verify": "...", "requiresConfirmation": false, "notes": "..." }',
  '  ],',
  '  "assumesCredentialsFromUser": true|false',
  '}',
  '',
  'Vague goal → clarification (no steps):',
  '{',
  '  "goal": "<restated user goal>",',
  '  "needsClarification": true,',
  '  "clarifyingQuestion": "Which flow should I test, and what counts as success?"',
  '}',
  '',
  UNTRUSTED_CONTENT_INSTRUCTION,
].join('\n');

// ─────────────────────────────────────────────────────────────────────────
// Entry point — one LLM call, one validated plan (or null).
// ─────────────────────────────────────────────────────────────────────────

export interface GeneratePlanArgs {
  userGoal: string;
  currentScreen?: MobileUiState | null;
  abortSignal?: AbortSignal;
  model?: string;
}

export interface PlannerResult {
  ok: boolean;
  plan?: FlowPlan;
  error?: string;
  rawResponse?: string;
  durationMs: number;
}

export async function generateFlowPlan(args: GeneratePlanArgs): Promise<PlannerResult> {
  const startedAt = Date.now();

  const userContext = args.currentScreen
    ? formatScreenForPlanner(args.currentScreen)
    : '(no current screen available — plan from scratch)';

  const userMessage =
    `User goal:\n${args.userGoal.slice(0, 1000)}\n\n` +
    `Current screen context:\n${userContext}`;

  const model = args.model ?? chooseToolCapableModel();

  try {
    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      {
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        abortSignal: args.abortSignal,
      },
    );

    const raw = (response.content ?? '').trim();
    if (!raw) {
      return { ok: false, error: 'Planner returned empty response.', durationMs: Date.now() - startedAt };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn('[MOBILE_PLANNER] Planner returned non-JSON', {
        rawPreview: raw.slice(0, 200),
      });
      return {
        ok: false,
        error: `Planner response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        rawResponse: raw,
        durationMs: Date.now() - startedAt,
      };
    }

    const validation = FlowPlanSchema.safeParse(parsed);
    if (!validation.success) {
      logger.warn('[MOBILE_PLANNER] Plan schema validation failed', {
        issues: validation.error.issues.slice(0, 3),
        rawPreview: raw.slice(0, 200),
      });
      return {
        ok: false,
        error: `Plan did not match required shape: ${validation.error.issues[0]?.message ?? 'unknown'}`,
        rawResponse: raw,
        durationMs: Date.now() - startedAt,
      };
    }

    // Clarification path: the goal was too vague to plan. Return the plan as
    // validated (no steps) — the caller (runPlanFlow) detects
    // needsClarification and surfaces the question instead of installing a
    // plan. Skip id re-numbering since there are no steps.
    if (validation.data.needsClarification) {
      return { ok: true, plan: validation.data, durationMs: Date.now() - startedAt };
    }

    // Re-number ids to 1..N regardless of what the LLM produced — the
    // executor indexes by stepState.id and accidental duplicates or gaps
    // would break lookup. `steps` is guaranteed present here by the schema
    // refine (non-clarification path).
    const normalized: ConcreteFlowPlan = {
      ...validation.data,
      steps: (validation.data.steps ?? []).map((step, idx) => ({
        ...step,
        id: idx + 1,
      })),
    };

    return { ok: true, plan: normalized, durationMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[MOBILE_PLANNER] Planner call threw', { error: message });
    return { ok: false, error: message, durationMs: Date.now() - startedAt };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function formatScreenForPlanner(snap: MobileUiState): string {
  const header = [
    `platform: ${snap.platform}`,
    snap.app ? `app: ${snap.app}` : null,
    snap.activity ? `activity: ${snap.activity}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  // The a11y tree is user-controlled content from arbitrary apps — it may
  // carry PII (emails / OTPs / cards inside EditText) AND prompt-injection
  // payloads. Mirror the observe path (tools.ts:formatSnapshotForLlm):
  // redact FIRST (so PII never survives into the prompt, even truncated),
  // then trim, then wrap so the markers frame the final body. The header is
  // OUR text (runner-controlled fields), so it is not wrapped.
  let tree = snap.formattedTree ?? '';
  if (env.MOBILE_CHAT_PII_REDACTION) {
    tree = redactPii(tree);
  }
  // Feed only a trimmed tree — the planner operates at a higher level than
  // the executor and doesn't need every leaf.
  const truncated = tree.length > 2000;
  const treePreview = tree.slice(0, 2000);
  const wrappedTree = wrapUntrusted(
    `${treePreview}${truncated ? '\n…(tree truncated for planner)' : ''}`,
  );
  return `${header}\n${wrappedTree}`;
}

/**
 * Same guard the pipeline uses — fall back off Gemini because our shared
 * OpenAI wrapper doesn't forward tool/response_format params through the
 * Gemini path reliably.
 */
const chooseToolCapableModel = (): string => pickToolCapableModel('MOBILE_PLANNER');
