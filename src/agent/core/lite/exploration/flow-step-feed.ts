/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LIVE `flow_step` FEED — payload construction
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns one executed pipeline command into the `flow_step` payload the web
 * store consumes. Pure and dependency-free ON PURPOSE: `FlowRunner` imports
 * Playwright and the OpenAI client, so a test that reaches this logic through
 * the class cannot run (the import graph alone exceeds the jest timeout) —
 * exactly the reason `prior-learnings.ts` was extracted too.
 *
 * The payload SHAPE is a contract with the frontend, not a convenience:
 * `explorationStore.addFlowStep` dedups on (stepNumber, action, description)
 * and uses `stepNumber` as its React key, so a missing or repeated number
 * makes a second identical action silently vanish from the feed.
 */

import { redactCredentialValues } from '@/utils/interpolation/redact-secrets';
import type { RedactableCredentials } from '@/utils/interpolation/redact-secrets';
import type { ExecutedCommand } from '../pipeline/types';

/**
 * Commands that must NOT be reported as user-visible steps.
 *
 * Mirrors the set `commandToStep` ([pipeline-step-extractor.ts](pipeline-step-extractor.ts))
 * returns null for, so the live feed and the persisted step list describe the
 * same flow. Emitting `wait_for_page` or `report_blocked` reads as "the agent
 * did something" when it did not.
 */
export const FEED_EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
  'observe_page',
  'wait_for_page',
  'report_blocked',
]);

export interface FlowStepPayload {
  stepNumber: number;
  roundNumber: number;
  action: string;
  description?: string;
  value?: string;
  pageUrl?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

/**
 * Build the payload for one executed command, or null when the command is not
 * a user-visible step.
 *
 * EVERY model-authored string here is credential-redacted, not just `value`:
 * an Executor describing its own action writes "Fill password with hunter2secret",
 * `mark_done`'s evidence routinely names the account it logged in as, and a
 * failure message echoes the page and the locator. Hard invariant #10 covers any
 * string that is emitted, logged or persisted — the obvious field is not the
 * only one.
 */
export function buildFlowStepPayload(
  executed: ExecutedCommand,
  ctx: {
    stepNumber: number;
    roundNumber: number;
    pageUrl?: string;
    credentials?: RedactableCredentials | null;
  },
): FlowStepPayload | null {
  const commandName = executed?.command?.name;
  if (!commandName || FEED_EXCLUDED_COMMANDS.has(commandName)) return null;

  const args = (executed.command?.args ?? {}) as Record<string, unknown>;
  const redact = (s: string) => redactCredentialValues(s, ctx.credentials);

  // `mark_done` carries its text in `evidence`, not `description` — the step
  // extractor renders it as "Verify: <evidence>", so mirror that rather than
  // emitting the flow's final step with no label at all.
  const rawDescription =
    commandName === 'mark_done'
      ? `Verify: ${typeof args.evidence === 'string' && args.evidence ? args.evidence : 'Goal achieved'}`
      : typeof args.description === 'string'
        ? args.description
        : '';

  const failed = executed.result?.success === false;

  return {
    stepNumber: ctx.stepNumber,
    roundNumber: ctx.roundNumber,
    action: commandName,
    description: redact(rawDescription) || undefined,
    value: typeof args.value === 'string' ? redact(args.value) : undefined,
    pageUrl: ctx.pageUrl,
    success: executed.result?.success === true,
    error: failed ? redact(executed.result?.error || '') || undefined : undefined,
    durationMs: executed.durationMs,
  };
}
