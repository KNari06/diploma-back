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
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import type { MobileUiState } from '@/services/mobile/mobile-runner.types';

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

export const FlowPlanSchema = z.object({
  goal: z.string().min(3).max(200),
  steps: z.array(FlowPlanStepSchema).min(1).max(15),
  assumesCredentialsFromUser: z.boolean().optional(),
});

export type FlowPlanStep = z.infer<typeof FlowPlanStepSchema>;
export type FlowPlan = z.infer<typeof FlowPlanSchema>;

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
  '',
  'Output ONLY valid JSON matching this shape (no prose, no markdown):',
  '{',
  '  "goal": "<restated user goal>",',
  '  "steps": [',
  '    { "id": 1, "intent": "...", "verify": "...", "requiresConfirmation": false, "notes": "..." }',
  '  ],',
  '  "assumesCredentialsFromUser": true|false',
  '}',
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

    // Re-number ids to 1..N regardless of what the LLM produced — the
    // executor indexes by stepState.id and accidental duplicates or gaps
    // would break lookup.
    const normalized: FlowPlan = {
      ...validation.data,
      steps: validation.data.steps.map((step, idx) => ({
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
  // Feed only a trimmed tree — the planner operates at a higher level than
  // the executor and doesn't need every leaf.
  const treePreview = snap.formattedTree.slice(0, 2000);
  return `${header}\n${treePreview}${snap.formattedTree.length > 2000 ? '\n…(tree truncated for planner)' : ''}`;
}

/**
 * Same guard the pipeline uses — fall back off Gemini because our shared
 * OpenAI wrapper doesn't forward tool/response_format params through the
 * Gemini path reliably.
 */
function chooseToolCapableModel(): string {
  const configured = AI_MODELS.fast;
  if (configured.startsWith('gemini-')) {
    logger.warn(
      '[MOBILE_PLANNER] Configured fast model is Gemini; falling back to gpt-4.1-mini for JSON-mode planning.',
      { configured },
    );
    return 'gpt-4.1-mini';
  }
  return configured;
}
