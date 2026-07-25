/**
 * Editor iterative test authoring (build-by-executing).
 *
 * Replaces "LLM guesses the whole step array from a text snapshot, then runs it
 * blind" with a grounded loop: snapshot → LLM picks a REAL element by ref →
 * execute on the LIVE preview → fresh snapshot → next step → until the goal is
 * met. Every step is therefore proven against the live DOM as it is authored,
 * and the resulting plan has ALREADY passed — the final user "save" persists it
 * without a re-run.
 *
 * This drives the EXISTING `TestPipeline` (Planner→Executor→Reviewer loop) —
 * the same engine exploration uses — directly against the preview session's live
 * Page. It deliberately does NOT pull in FlowRunner / BudgetTracker / FlowQueue
 * / Strategist: those are background-exploration concerns. Step extraction
 * (rounds → grounded steps + compiled locator plans) is the shared
 * `extractDiscoveredSteps` so authored cases hit replay's fast path identically
 * to exploration-discovered ones.
 *
 * Concurrency: holds the SAME per-session run lock as Run-All
 * (`PreviewRunService.acquireRunLock`), so recording / apply / Run-All correctly
 * reject while authoring is in flight (preview invariant #1).
 */

import { ActionExecutor } from '@/agent/core/lite/execution/action-executor';
import { NetworkTracker } from '@/agent/core/lite/collectors/network-tracker';
import { GoalDetector } from '@/agent/core/lite/analysis/goal-detector';
import { TestPipeline, type PipelineIntegrations } from '@/agent/core/lite/pipeline/test-pipeline';
import type { PipelineConfig, ExecutionRound } from '@/agent/core/lite/pipeline/types';
import {
  extractDiscoveredSteps,
  commandToStep,
  type SecretKeyForKind,
} from '@/agent/core/lite/exploration/pipeline-step-extractor';
import { KEY_RE as SECRET_KEY_RE } from '@/services/test-resource/adapters/secret.adapter';
import { isBoundSecretPlaceholder } from '@/utils/interpolation/redact-secrets';
import type { DiscoveredStep } from '@/agent/core/lite/exploration/types';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getPreviewSessionService } from './preview-session.service';
import { PreviewRunService } from './preview-run.service';

/** Upper bound on author rounds — keeps an open-ended goal from looping forever. */
const DEFAULT_MAX_ROUNDS = 12;
/** Hard wall-clock cap for an authoring session. */
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Binds the credentials used during authoring to a stored `secret` resource, so
 * the authored test is REPRODUCIBLE: each credential fill is frozen as
 * `{{secrets.<key>}}` and the test carries a `resource_bindings` entry that
 * makes replay resolve the real value from the encrypted store.
 *
 * Only key NAMES live here — never credential values.
 */
export interface CredentialSecretBinding {
  /** `test_resources` row id (kind `secret`) holding the credential values. */
  resourceId: string;
  /** Key inside the secret's `values` map for an email field. */
  emailKey?: string;
  /** Key for a password field. */
  passwordKey?: string;
  /** Key for a username field. Falls back to `emailKey` (mirrors the executor). */
  usernameKey?: string;
  /** Key for a phone field. */
  phoneKey?: string;
}

export interface AuthorTestParams {
  previewSessionId: string;
  userId: string;
  /** Natural-language goal, e.g. "test the login flow with valid credentials". */
  goal: string;
  /** Optional credentials surfaced to the Planner (never frozen into plans). */
  credentials?: PipelineConfig['credentials'];
  /**
   * Bind those credentials to a stored `secret` so the authored steps freeze
   * `{{secrets.*}}` placeholders instead of dropping the value. Without it,
   * credential fills stay value-less (previous behaviour).
   */
  credentialSecret?: CredentialSecretBinding;
  maxRounds?: number;
  timeoutMs?: number;
}

export interface AuthorTestResult {
  success: boolean;
  /** Grounded, already-executed steps (with compiled locator plans). */
  steps: DiscoveredStep[];
  /** Page URL the authoring started from (where the user was looking). */
  startUrl: string;
  /** Final URL after the authored flow ran. */
  endUrl: string;
  roundsExecuted: number;
  durationMs: number;
  /** Human-readable reason the loop stopped (goal met / blocked / timeout). */
  reason: string;
  /** Set when authoring could not start at all (no session / busy). */
  error?: string;
  /**
   * Resource bindings the authored test needs to replay. Present only when
   * `credentialSecret` was supplied AND at least one credential was actually
   * frozen — persist these onto the test case's `resource_bindings` or replay
   * will resolve the `{{secrets.*}}` placeholders to nothing.
   */
  resourceBindings?: Array<{ kind: 'secret'; resource_id: string; required: boolean }>;
}

export class EditorIterativeAuthorService {
  /**
   * Author a test by building-and-executing on the live preview. Returns the
   * grounded steps; the caller decides whether to persist them.
   */
  static async authorTest(params: AuthorTestParams): Promise<AuthorTestResult> {
    const { previewSessionId, userId, goal } = params;
    const empty = (error: string): AuthorTestResult => ({
      success: false, steps: [], startUrl: '', endUrl: '', roundsExecuted: 0, durationMs: 0,
      reason: error, error,
    });

    const sessionService = getPreviewSessionService();
    if (!sessionService.isSessionOwned(previewSessionId, userId)) {
      return empty('No active editor preview session for this user.');
    }
    const page = sessionService.getPage(previewSessionId, userId);
    if (!page) {
      return empty('Preview session has no live page. Start a device/page in the editor first.');
    }

    // Reuse the Run-All mutex — authoring is a run as far as the session cares.
    const lock = PreviewRunService.acquireRunLock(previewSessionId);
    if (!lock) {
      return empty('A run is already in progress on this preview session. Wait for it to finish or cancel it first.');
    }

    const startUrl = page.url();
    const startedAt = Date.now();
    let networkTracker: NetworkTracker | undefined;
    // Hoisted so the catch can finalize the progress bubble it started.
    let startedEmitted = false;
    let emittedStepIndex = 0;
    try {
      const actionExecutor = new ActionExecutor(page);
      networkTracker = new NetworkTracker(page);
      const goalDetector = new GoalDetector(goal, previewSessionId);

      // Seed the editor's draft-run progress bubble. totalSteps:0 — build-by-
      // executing has an UNKNOWN total; the FE grows the list as steps stream in.
      webSocketService.emitToUser(userId, 'preview:run:started', {
        previewSessionId,
        totalSteps: 0,
        startUrl,
        ephemeral: true,
      });
      startedEmitted = true;

      // Per-round → per-step WS bridge. Each successful command becomes one
      // `preview:run:step` so the user watches the test being built live, with
      // the SAME tap-to-expand bubble as Run-All. Secret values are masked
      // (commandToStep already drops is_sensitive values; we never emit raw
      // `value` for sensitive steps — invariant #12).
      const onRoundComplete = (round: ExecutionRound): void => {
        for (const executed of round.commands) {
          if (!executed.result.success) continue;
          const ds = commandToStep(executed, emittedStepIndex + 1, '');
          if (!ds) continue; // infra command (observe/wait/blocked) — not user-facing
          webSocketService.emitToUser(userId, 'preview:run:step', {
            previewSessionId,
            stepIndex: emittedStepIndex,
            stepId: ds.ref ?? null,
            status: 'pass',
            action: ds.action,
            description: ds.description,
            // value carried only for non-sensitive value-bearing steps.
            ...(ds.value && !ds.isSensitive ? { value: ds.value } : {}),
            timestamp: new Date().toISOString(),
          });
          emittedStepIndex++;
        }
      };

      // NOTE: intentionally NOT passing `browserContext`. The preview session
      // already owns a popup/new-tab handler on this context
      // (attachPopupHandler → preview:tab:opened); giving TestPipeline a second
      // `context.on('page')` via its PageWatcher would double-handle popups and
      // could race the preview's own tab adoption. Popup detection is the
      // preview's job here.
      const integrations: PipelineIntegrations = {
        page,
        actionExecutor,
        networkTracker,
        goalDetector,
        onRoundComplete,
      };

      const config: PipelineConfig = {
        url: startUrl,
        credentials: params.credentials,
        hasCredentials: !!params.credentials,
        testId: previewSessionId,
        maxRounds: Math.max(1, params.maxRounds ?? DEFAULT_MAX_ROUNDS),
        timeoutMs: Math.max(5_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        // A preview session has NO `tests` row — its id is `preview_<uuid>`, not
        // a UUID, so the DB cancellation check would error every round (22P02).
        // We cancel via externalAbortSignal instead.
        skipDbCancellationCheck: true,
        externalAbortSignal: lock.signal,
        // Editor-scoped: let the agent author deterministic assertions
        // (assert_text → type:'assert' steps). Exploration leaves this off, so
        // the shared lite pipeline is unchanged there.
        enableAssertAuthoring: true,
      };

      const pipeline = new TestPipeline(integrations);
      logger.info('[EDITOR_AUTHOR] Starting iterative authoring', {
        previewSessionId, startUrl, maxRounds: config.maxRounds, goalPreview: goal.slice(0, 80),
      });

      const result = await pipeline.run(goal, config);

      // Credential kind → secret key. Built from key NAMES only; no credential
      // value is read or compared here. `username` falls back to the email key,
      // mirroring the executor's own `username || email || phone` cascade.
      const cs = params.credentialSecret;
      const secretKeyForKind: SecretKeyForKind | undefined = cs
        ? (kind) => {
          const key = (() => {
            switch (kind) {
              case 'password': return cs.passwordKey;
              case 'email': return cs.emailKey;
              case 'username': return cs.usernameKey ?? cs.emailKey;
              case 'phone': return cs.phoneKey;
              default: return undefined;
            }
          })();
          // Reject a key the secret adapter would never have accepted. A typo'd
          // or malformed key produces a placeholder that resolves to nothing,
          // and replay then TYPES `{{secrets.…}}` into the live app's password
          // field — leaking the key name to that app's logs. Dropping the value
          // fails the test loudly instead.
          if (key && !SECRET_KEY_RE.test(key)) {
            logger.warn('[EDITOR_AUTHOR] Ignoring malformed secret key — not freezing a placeholder', {
              kind, key,
            });
            return undefined;
          }
          return key;
        }
        : undefined;

      // Rounds → grounded steps + compiled plans (shared with exploration).
      const { steps: extractedSteps } = await extractDiscoveredSteps(result, page, secretKeyForKind);

      // Editor-scoped guard (NOT in the shared toIntentSteps, which exploration
      // also uses): drop a terminal `verify` step (from mark_done) that carries
      // no evidence. Such a step converts to an ai_check with an undefined
      // assertionText, which THROWS at replay ("assertionText is required") and
      // false-REDs an otherwise-passing authored test. `mark_done` already
      // requires evidence in its schema, so this is defensive.
      const steps = extractedSteps.filter(
        (s) => !(s.action === 'verify' && !(s.expectedOutcome && s.expectedOutcome.trim())),
      );

      // Finalize the progress bubble (mirrors runStepsOnPreview's completed emit).
      webSocketService.emitToUser(userId, 'preview:run:completed', {
        previewSessionId,
        success: result.success,
        totalSteps: emittedStepIndex,
        passedSteps: emittedStepIndex, // only successful commands are emitted
        failedSteps: 0,
        skippedSteps: 0,
        duration: Date.now() - startedAt,
        ephemeral: true,
      });

      const endUrl = (() => { try { return page.url(); } catch { return startUrl; } })();

      // Only claim a binding if a credential was actually frozen — an unused
      // binding would make replay demand a resource the steps never reference.
      // Anchored check, not `startsWith`: a malformed key can yield something
      // like `{{secrets.a}}b}}`, which is NOT resolvable. Counting that would
      // emit a required binding for a step that references no secret.
      const frozeCredential = steps.some(
        (s) => s.isSensitive && isBoundSecretPlaceholder(s.value),
      );
      const resourceBindings = cs && frozeCredential
        ? [{ kind: 'secret' as const, resource_id: cs.resourceId, required: true }]
        : undefined;

      logger.info('[EDITOR_AUTHOR] Authoring finished', {
        previewSessionId,
        success: result.success,
        roundsExecuted: result.roundsExecuted,
        stepCount: steps.length,
        reason: result.reason,
        boundCredentialSecret: !!resourceBindings,
      });

      return {
        success: result.success,
        steps,
        startUrl,
        endUrl,
        roundsExecuted: result.roundsExecuted,
        durationMs: Date.now() - startedAt,
        reason: result.reason,
        ...(resourceBindings ? { resourceBindings } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[EDITOR_AUTHOR] Authoring failed', { previewSessionId, error: message });
      // If we already seeded the progress bubble, finalize it so the FE spinner
      // doesn't hang (FE clears on completed).
      if (startedEmitted) {
        webSocketService.emitToUser(userId, 'preview:run:completed', {
          previewSessionId,
          success: false,
          totalSteps: emittedStepIndex,
          passedSteps: emittedStepIndex,
          failedSteps: 0,
          skippedSteps: 0,
          duration: Date.now() - startedAt,
          ephemeral: true,
        });
      }
      return {
        success: false, steps: [], startUrl, endUrl: startUrl,
        roundsExecuted: 0, durationMs: Date.now() - startedAt,
        reason: `Authoring failed: ${message}`, error: message,
      };
    } finally {
      // Detach network listeners from the long-lived preview page — otherwise
      // each authoring run leaks 5 listeners on a page that outlives the run.
      try { networkTracker?.stopTracking(); } catch { /* best-effort */ }
      lock.release();
    }
  }
}
