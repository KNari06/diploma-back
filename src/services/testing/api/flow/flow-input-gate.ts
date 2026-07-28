/**
 * Mid-run "needs input" gate for API flow execution.
 *
 * Some values a flow needs cannot be obtained by the platform on its own:
 *   - an out-of-band OTP that only exists AFTER a `/otp/send` step runs,
 *   - a secret no endpoint produces,
 *   - an auth token whose login step failed.
 *
 * Rather than fire a doomed request (and cascade 401s across the rest of the
 * flow), the executor pauses and asks the user. The run is a long-lived
 * in-process async loop (fire-and-forget from the controller), so a pause is
 * just an `await` on a deferred promise held here, keyed by `flowRunId`. The
 * REST endpoint `POST …/runs/:runId/provide-input` resolves it; a per-wait
 * timeout rejects it so a never-answered pause fails the run gracefully.
 *
 * In-memory ONLY, by design: a pause is ephemeral. If the API process restarts
 * mid-pause the run is lost — the same failure mode as any in-process run dying,
 * and acceptable because these pauses are short (a user typing an SMS code).
 * The DB run status stays `running` throughout; "awaiting input" is signalled
 * purely over WebSocket + this gate, so no schema change is needed.
 *
 * This module is deliberately free of WebSocket/DB deps: the executor emits the
 * `api:flow:needs-input` event and then awaits {@link requestFlowInput}. That
 * keeps the gate a pure, unit-testable state machine.
 */

import type { FlowInputQuestion } from './flow.types';

/** Default time a run will wait for the user before giving up. */
export const DEFAULT_INPUT_TIMEOUT_MS = 5 * 60 * 1000;

export class FlowInputTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for user input');
    this.name = 'FlowInputTimeoutError';
  }
}

export class FlowInputCancelledError extends Error {
  constructor(reason = 'Input request cancelled') {
    super(reason);
    this.name = 'FlowInputCancelledError';
  }
}

interface Pending {
  resolve: (values: Record<string, string>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  questions: FlowInputQuestion[];
}

const pending = new Map<string, Pending>();

/** True while a run is paused waiting for the user. */
export function isAwaitingInput(flowRunId: string): boolean {
  return pending.has(flowRunId);
}

/** The questions a paused run is currently waiting on (for reconnect/inspection). */
export function getPendingQuestions(flowRunId: string): FlowInputQuestion[] | undefined {
  return pending.get(flowRunId)?.questions;
}

/**
 * Pause the run until the user provides the requested values (or the wait times
 * out / is cancelled). Resolves with a `{ name: value }` map to merge into the
 * run context. At most one wait per `flowRunId` — a second request supersedes
 * the first (rejects it), which never happens in normal single-loop execution.
 */
export function requestFlowInput(
  flowRunId: string,
  questions: FlowInputQuestion[],
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const existing = pending.get(flowRunId);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(flowRunId);
    existing.reject(new FlowInputCancelledError('Superseded by a new input request'));
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS;
  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(flowRunId);
      reject(new FlowInputTimeoutError());
    }, timeoutMs);
    // Don't keep the event loop alive solely for a pending prompt.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    pending.set(flowRunId, { resolve, reject, timer, questions });
  });
}

/**
 * Supply the values a paused run is waiting for; resumes it. Returns false if no
 * run is currently awaiting input under this id (already answered, timed out, or
 * finished) so the caller can 404.
 */
export function provideFlowInput(flowRunId: string, values: Record<string, string>): boolean {
  const p = pending.get(flowRunId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(flowRunId);
  p.resolve(values || {});
  return true;
}

/**
 * Abandon a paused run's wait (cancellation / abort). No-op if nothing is
 * waiting. The awaiting executor sees a {@link FlowInputCancelledError}.
 */
export function cancelFlowInput(flowRunId: string, reason?: string): void {
  const p = pending.get(flowRunId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(flowRunId);
  p.reject(new FlowInputCancelledError(reason));
}
