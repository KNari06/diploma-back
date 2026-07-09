/* eslint-disable no-case-declarations */
import { collectSecretValues, redactWithValues, redactSnapshotValues } from '@/utils/interpolation/redact-secrets';
import { AIExtractService } from '@/services/ai-extract';
import { SelfHealingService } from '@/services/ai-selector/self-healing.service';
import { AICostManager } from '@/services/ai/cost/ai-cost-manager.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import type { IntentPlaywrightCommand } from '@/services/testing/ui/preview/intent-step-converter.service';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import type { CompiledStepPlan, IntentStep, LocatorEntry, StepRuntimeMeta } from '@/services/testing/ui/preview/preview.types';
import { shouldSkipLookaheadAfter, waitForStepReadiness, type LookaheadResult } from '@/services/testing/ui/preview/step-readiness.service';
import { runV1WithShadow } from '@/services/testing/ui/preview/step-readiness-v2.service';
import { evaluateEvidenceShortcut } from '@/services/testing/ui/preview/evidence-shortcut.utils';
import { waitForPageInteractive } from '@/services/testing/ui/preview/page-interactive.utils';
import { shouldRecollectForReadiness, REPLAY_READINESS_MAX_WAIT_MS } from './replay-readiness';
import { isReplayReadinessRecollectEnabled } from '@/config/features/replay-readiness';
import { waitForHoverEffect } from '@/services/testing/ui/wait-phases/hover-effect-settle';
import { smartStepWait } from '@/services/testing/ui/smart-step-wait.service';
// eslint-disable-next-line no-duplicate-imports
import type { IntentActionType } from '@/services/testing/ui/preview/preview.types';
import { diagnoseStepBlocker, actOnDiagnosis } from '@/services/testing/ui/preview/step-blocker-diagnosis.service';
import { COMMAND_EXECUTOR_CONFIG, STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';
import { PlaywrightActionType, PlaywrightCommand } from '@/types';
import { logger, logAiCheckError } from '@/utils/core/logger';
import { Frame, Locator, Page } from 'playwright';
import { shouldPressEnterAfterFill } from '../utils/ai/enter-detection-ai';
import { getLocator, getSmartLocator, isSelectorRelatedError, normalizeSelector, validateAndGetLocator } from '../utils/selectors/selector-utils';
import { SelectorStabilityScore, SmartWaitService } from '../utils/selectors/smart-wait.service';
import type { ReplayTraceWriter } from '../playwright/core/replay-trace-writer';
import { executeCoordinateDrag, parseDragCoordinates } from '../playwright/core/drag-helpers';
import { buildRuntimeMeta, executeCompiledLocatorPlan, quickFingerprintCheck } from './compiled-locator-executor';
// Step.options.* helpers (forwarded from intent-step-options-forwarder).
// Field family: replaceContent, keyPressDelay, cssSelector,
// disableStabilityChecks, disableCaching — see ./step-options/* for docs.
import { typeWithOptionalClear } from './step-options/clear-before-type';
import { fillWithOptionalAppend } from './step-options/append-fill';
import { tryPinnedCssLocator } from './step-options/pinned-css-locator';
import { tryOpenAnchorAsNewTab } from '@/services/testing/ui/preview/new-tab-opener';
import {
  buildGlobWaitPayload,
  buildRegexWaitPayload,
  matchDomain,
  matchGlob,
  matchRegex,
  matchSubstring,
  parseRegexString,
} from './url-pattern-matcher';

/**
 * Smart screenshot: captures current viewport + buffer above/below for vision-based element resolution.
 * Instead of fullPage (5000px, expensive) or viewport-only (720px, misses nearby off-screen elements),
 * captures a ~1020px window around the current scroll position.
 *
 * Coverage: scrollY - 100px (sticky headers, just-scrolled-past elements)
 *        to scrollY + viewportH + 200px (elements just below fold)
 *
 * Size: ~150KB JPEG vs ~500KB fullPage — optimized for LLM vision tokens.
 */
async function captureSmartScreenshot(
  page: Page
): Promise<{ base64: string; clipPageTop: number; scrollY: number } | null> {
  try {
    const dims = await page.evaluate(() => ({
      scrollY: (globalThis as any).scrollY || 0,
      viewportH: (globalThis as any).innerHeight || 720,
      pageH: (globalThis as any).document?.documentElement?.scrollHeight || 720,
      viewportW: (globalThis as any).innerWidth || 1280,
    }));

    const clipTop = Math.max(0, dims.scrollY - 100);
    const clipBottom = Math.min(dims.pageH, dims.scrollY + dims.viewportH + 200);
    const clipHeight = clipBottom - clipTop;

    // Guard: clip must have meaningful dimensions
    // V15: Plain viewport screenshot — its (0,0) sits at page-Y=scrollY, so clipPageTop == scrollY.
    if (clipHeight < 100 || dims.viewportW < 100) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      return { base64: buf.toString('base64'), clipPageTop: dims.scrollY, scrollY: dims.scrollY };
    }

    const buf = await page.screenshot({
      clip: { x: 0, y: clipTop, width: dims.viewportW, height: clipHeight },
      type: 'jpeg',
      quality: 70,
    });
    return { base64: buf.toString('base64'), clipPageTop: clipTop, scrollY: dims.scrollY };
  } catch {
    // Fallback: plain viewport screenshot if clip fails (page navigating, crashed, etc.)
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      // Best-effort scrollY for fallback; if unreadable, assume 0 (clipPageTop == scrollY still holds).
      let scrollY = 0;
      try {
        scrollY = await page.evaluate(() => (globalThis as any).scrollY || 0);
      } catch { /* non-critical */ }
      return { base64: buf.toString('base64'), clipPageTop: scrollY, scrollY };
    } catch {
      return null;
    }
  }
}

// waitForHoverEffect used to be duplicated here — now imported from the
// shared wait-phases/hover-effect-settle.ts (see top of file).

/**
 * Dispatch a synthetic file drop event onto a target element.
 * Last-resort fallback for drag-and-drop-only upload zones without hidden <input type="file">.
 */
async function dispatchFileDrop(
  page: Page,
  locator: Locator,
  localFilePath: string,
  filename: string,
  contentType?: string,
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const fileBuffer = await fs.readFile(localFilePath);
  const base64Data = fileBuffer.toString('base64');
  const resolvedFilename = filename || path.basename(localFilePath);
  const resolvedContentType = contentType || 'application/octet-stream';

  await locator.evaluate(
    (el: any, { base64, fname, ctype }) => {
      const g = globalThis as any;
      const binaryStr = g.atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const file = new g.File([bytes], fname, { type: ctype });
      const dt = new g.DataTransfer();
      dt.items.add(file);
      const shared = { bubbles: true, cancelable: true, dataTransfer: dt };
      el.dispatchEvent(new g.DragEvent('dragenter', shared));
      el.dispatchEvent(new g.DragEvent('dragover', shared));
      el.dispatchEvent(new g.DragEvent('drop', shared));
    },
    { base64: base64Data, fname: resolvedFilename, ctype: resolvedContentType },
  );
}

/**
 * Upload via fileChooser interception with drag-drop fallback.
 * Tries fileChooser with a short 3s timeout; if it doesn't fire,
 * falls back to synthetic drop event for drag-only upload zones.
 */
async function uploadViaFileChooserOrDrop(
  page: Page,
  locator: Locator,
  localFilePath: string,
  filename: string,
  contentType?: string,
  timeout = 10_000,
): Promise<void> {
  const FILECHOOSER_QUICK_TIMEOUT = 3_000;

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: FILECHOOSER_QUICK_TIMEOUT }),
      locator.click({ timeout: FILECHOOSER_QUICK_TIMEOUT }),
    ]);
    await fileChooser.setFiles(localFilePath);
  } catch {
    logger.info('[COMMAND_EXECUTOR] FileChooser not triggered, falling back to synthetic drop', {
      filename,
    });
    await dispatchFileDrop(page, locator, localFilePath, filename, contentType);
  }
}

/**
 * V11: Accumulated state shared across retry attempts within a single step.
 * Enables graduated retry strategy: later retries skip stages that failed deterministically.
 */
interface RetryContext {
  /** Current attempt index (0, 1, 2) */
  attempt: number;
  /** Whether each stage failed deterministically (no transient error, just 0 results) */
  stageDeterministicFail: {
    compiled: boolean;
    resolver: boolean;
    smart: boolean;
    selfHeal: boolean;
  };
  /** Shared heal attempt count across all retries (NOT reset per call) */
  healAttempts: number;
  /** Timestamp of last DOM node collection (for reuse when delay is short) */
  lastDomCollectionTs: number;
  /** Cached DOM nodes from last collection (reuse if < 1.5s since last) */
  cachedDomNodes: any[] | null;
  /** Total candidates found across all stages on all previous attempts */
  totalCandidatesEver: number;
  /** Whether scroll-retry was already attempted for lazy content detection */
  scrollAttempted?: boolean;
}

/**
 * Map a PlaywrightActionType (command-level verb) to the IntentActionType
 * that smartStepWait's plan table keys on.
 *
 * - 'fill' collapses into 'type' (same semantics in our pipeline)
 * - 'selectOption' collapses into 'select'
 * - Read-only / navigation-only / unsupported verbs return null → caller skips
 *   the post-action settle entirely (no wasted work).
 */
function playwrightActionToIntent(
  action: PlaywrightActionType,
): IntentActionType | null {
  switch (action) {
    case 'click': return 'click';
    case 'dblclick': return 'dblclick';
    case 'type':
    case 'fill':
      return 'type';
    case 'select':
    case 'selectOption':
      return 'select';
    case 'check': return 'check';
    case 'uncheck': return 'uncheck';
    case 'toggle': return 'toggle';
    case 'open': return 'open';
    case 'close': return 'close';
    case 'hover': return 'hover';
    case 'press': return 'press';
    case 'scroll':
    case 'scrollIntoView':
      return 'scroll';
    case 'upload': return 'upload';
    case 'dragAndDrop': return 'drag_and_drop';
    // Everything else (goto, waitFor*, screenshot, assert*, getText, extract,
    // focus/blur, swipe/tap, download) has no mutating effect smartStepWait
    // needs to settle — skip the call.
    default: return null;
  }
}

/**
 * Build a minimal IntentStep-shaped object for smartStepWait's post-phase
 * call. We don't have a real IntentStep inside CommandExecutor — it works
 * with PlaywrightCommand objects — so we synthesize the minimum fields the
 * dispatcher and phase fastChecks read: id, type, description, plus compiled
 * (when available) so post-condition-met can verify postconditions.
 */
function buildPostStep(
  intentType: IntentActionType,
  intentCommand: IntentPlaywrightCommand | null,
): IntentStep {
  const meta = intentCommand?.intentMeta;
  return {
    id: meta?.stepId ?? `cmd-${intentType}-${Date.now()}`,
    type: intentType,
    description: meta?.intentDescription ?? '',
    ...(meta?.compiled ? { compiled: meta.compiled } : {}),
  } as IntentStep;
}

/**
 * Execute Playwright commands on a page
 * ✅ NEW: With AI self-healing support
 * ✅ V2: With compiled locator plan support for IntentStep execution
 */
export class CommandExecutor {
  private page: Page;
  private extractedData: Map<string, any> = new Map();
  /** Per-run budget for the LLM tier of blocking-overlay clearing (tier3). */
  private static readonly MAX_LLM_OVERLAY_CLEARS = 3;
  private llmOverlayClears = 0;
  /** Overall test goal — passed to the heal resolver as journey context. */
  private testGoal?: string;
  /**
   * Sliding window of recent SUCCESSFUL step descriptions (descriptions only —
   * never input values, which may carry secrets). Fed to the heal resolver so
   * it has the "user's narrative" (what was done before this failing step) and
   * can disambiguate drift. Capped at RECENT_STEPS_WINDOW.
   */
  private recentStepDescriptions: string[] = [];
  private static readonly RECENT_STEPS_WINDOW = 3;
  private selfHealingEnabled: boolean = true;
  private metadata: { url: string; projectId?: string; userId?: string };
  private abortController: AbortController;
  private isAborted: boolean = false;
  private costManager?: AICostManager;
  private externalAbortHandler?: () => void; // ✅ FIX 1: Store handler for cleanup
  private selfHealingConfidenceThreshold: number = COMMAND_EXECUTOR_CONFIG.selfHealingConfidenceThreshold;
  private maxHealAttempts: number = COMMAND_EXECUTOR_CONFIG.maxHealAttempts;
  // Heal-credit accounting. We charge EXACTLY ONCE per step that auto-heals
  // successfully — no more, no less:
  //   - `currentStepHealCharged` is reset at the start of every executeCommand
  //     and set true on the first successful auto-applied heal of THAT step.
  //     Both heal paths (intent-path getLocatorForIntentCommand + selector-path
  //     executeWithSelfHealing) consult it, so a single step is never charged
  //     twice even when both paths fire (the bug the old run-level cap guarded).
  //   - `instanceHealChargesSpent` is kept ONLY as an observability counter
  //     (logged), no longer a billing gate. The previous run-level cap
  //     (`< maxHealAttempts`) silently made every heal AFTER the Nth one FREE,
  //     under-charging long tests; per-step dedup fixes that while preserving
  //     the no-double-charge guarantee.
  private instanceHealChargesSpent: number = 0;
  /** Reset per executeCommand; true once this step's heal has been billed. */
  private currentStepHealCharged: boolean = false;
  private skipCompiledPlan: boolean = false; // Skip Stage 1 on retry attempts
  private maxDomNodes?: number; // Configurable DOM node limit (saves memory in replay mode)
  /** Runtime metadata for each step (keyed by stepId) */
  private stepRuntimeMeta: Map<string, StepRuntimeMeta> = new Map();
  /** V10: Current command index in executeCommands loop (for next-step lookahead) */
  private currentCommandIndex?: number;
  /** V10: Current commands list in executeCommands loop (for next-step lookahead) */
  private currentCommandsList?: PlaywrightCommand[];
  /** V14: Replay trace writer for local JSONL logging (optional) */
  private replayTrace?: ReplayTraceWriter;
  /** V14: Total steps count for trace events */
  private totalSteps?: number;
  /**
   * Phase 2: cached list of secret values for log redaction. Populated
   * once at run start by `setRunVariables` (called from test-executor
   * after applyBindingsToContext). Empty when no secret resources are
   * bound — `redactInLogs` then becomes a cheap no-op.
   *
   * We cache the array form (not the Map) because every logger call
   * iterates it; rebuilding from the Map per call would be wasteful.
   */
  private redactValues: readonly string[] = [];

  constructor(
    page: Page,
    options: {
      selfHealingEnabled?: boolean;
      metadata?: { url: string; projectId?: string; userId?: string };
      abortSignal?: AbortSignal;
      costManager?: AICostManager;
      selfHealingConfidenceThreshold?: number; // ✅ NEW: Configurable confidence
      skipCompiledPlan?: boolean; // Skip compiled locator plan (Stage 1) — used on retry attempts
      maxDomNodes?: number; // Limit DOM nodes collected (saves memory in replay mode)
      replayTrace?: ReplayTraceWriter; // V14: JSONL trace writer for local debugging
      totalSteps?: number; // V14: Total steps for trace events
      testGoal?: string; // Overall test goal — heal journey context
    } = {}
  ) {
    this.page = page;
    this.selfHealingEnabled = options.selfHealingEnabled ?? true;
    this.metadata = options.metadata || { url: '' };
    this.costManager = options.costManager;
    this.selfHealingConfidenceThreshold = options.selfHealingConfidenceThreshold ?? COMMAND_EXECUTOR_CONFIG.selfHealingConfidenceThreshold;
    this.skipCompiledPlan = options.skipCompiledPlan ?? false;
    this.maxDomNodes = options.maxDomNodes;
    this.replayTrace = options.replayTrace;
    this.totalSteps = options.totalSteps;
    this.testGoal = options.testGoal;

    this.abortController = new AbortController();

    // ✅ FIX 1: Store handler reference for cleanup
    if (options.abortSignal) {
      this.externalAbortHandler = () => this.abort();
      options.abortSignal.addEventListener('abort', this.externalAbortHandler, { once: true });
    }
  }

  /**
   * Reset per-run state (extractedData, stepRuntimeMeta).
   * Call between test flows to prevent data leaking across runs.
   */
  resetRunState(): void {
    this.extractedData.clear();
    this.stepRuntimeMeta.clear();
    this.recentStepDescriptions = [];
    this.llmOverlayClears = 0;
    logger.debug('[COMMAND_EXECUTOR] Run state reset');
  }

  /**
   * Get the current active page (may change if click opens a new tab)
   */
  getActivePage(): Page {
    return this.page;
  }

  /**
   * ✅ FIX 1: Cleanup resources (call when done with executor)
   */
  dispose(): void {
    // Cleanup is handled by { once: true } in addEventListener
    this.externalAbortHandler = undefined;
  }

  /**
   * V14: Write a trace event to local JSONL file (if trace writer is attached).
   * Non-blocking — never throws, never blocks execution.
   */
  private trace(eventType: string, step: number, payload: Record<string, any>): void {
    if (!this.replayTrace) return;
    try {
      this.replayTrace.write({
        eventType,
        step,
        totalSteps: this.totalSteps || 0,
        payload,
      });
    } catch { /* non-fatal */ }
  }

  /**
   * Abort all ongoing operations
   */
  abort(): void {
    if (this.isAborted) return;

    this.isAborted = true;
    this.abortController.abort();

    logger.info('[COMMAND_EXECUTOR] Aborted - all operations cancelled');
  }

  /**
   * Check if aborted before executing operations
   */
  private checkAborted(): void {
    if (this.isAborted) {
      throw new Error('Operation aborted by user');
    }
  }

  /**
   * ✅ FIX 2: Normalize selector once (consistent handling)
   */
  private prepareSelector(selector: string | undefined): string | undefined {
    if (!selector) return undefined;
    return normalizeSelector(selector);
  }

  /**
   * Get locator from normalized selector
   */
  private getLocatorInternal(selector: string): Locator {
    return getLocator(this.page, selector);
  }

  /**
   * ✅ Get context-aware locator (page or iframe)
   * If iframe selector is provided, creates a frameLocator chain
   * @param selector The element selector
   * @param iframeSelector Optional iframe selector for actions within iframes
   * @returns Locator for the element (either in page or iframe context)
   */
  private getContextLocator(selector: string, iframeSelector?: string): Locator {
    if (iframeSelector) {
      // Element is within an iframe - use frameLocator
      logger.debug('[COMMAND_EXECUTOR] Using frameLocator for iframe context', {
        iframeSelector: iframeSelector.substring(0, 50),
        selector: selector.substring(0, 50),
      });
      return this.page.frameLocator(iframeSelector).locator(selector);
    } else {
      // Element is in main page context
      return getLocator(this.page, selector);
    }
  }

  /**
   * ✅ Resolve iframe Frame from iframe element selector.
   * Uses ElementHandle.contentFrame() to get the underlying Playwright Frame.
   * @param iframeSelector CSS selector for the iframe element
   * @param timeout Maximum time to wait for iframe to be attached/ready
   */
  private async getFrameFromIframeSelector(iframeSelector: string, timeout: number = 10000): Promise<Frame> {
    // Wait for the iframe element to exist in DOM
    const iframeHandle = await this.page.waitForSelector(iframeSelector, { timeout });
    const frame = await iframeHandle.contentFrame();
    if (!frame) {
      throw new Error(`Iframe content frame not available for selector: ${iframeSelector}`);
    }
    return frame;
  }

  /**
   * Execute a single command
   *
   * For IntentPlaywrightCommand (has intentMeta), uses:
   * 1. compiled.locatorPlan first (with pageSignature check + TTL expiry)
   * 2. Fallback to smart-locator
   * 3. Self-healing (with maxHealAttempts=1)
   *
   * Records StepRuntimeMeta for reporting.
   */
  async executeCommand(command: PlaywrightCommand): Promise<{
    success: boolean;
    error?: string;
    screenshot?: string;
    extractedValue?: any;
    /** Runtime metadata for intent-based commands */
    runtimeMeta?: StepRuntimeMeta;
  }> {
    this.checkAborted();

    // Per-step heal-billing dedup: fresh for each command. The first successful
    // auto-applied heal of THIS step charges 1 credit and flips this true; any
    // second heal path on the same step then sees it and does not re-charge.
    this.currentStepHealCharged = false;

    const { action, value, url, timeout, continueOnError, description } = command;

    // ✅ V2: Check if this is an intent command (has intentMeta)
    const intentCommand = command as IntentPlaywrightCommand;
    const isIntentCommand = !!(intentCommand.intentMeta);

    // ✅ FIX 2: Normalize selector ONCE at the beginning
    const selector = this.prepareSelector(command.selector);
    const awaitNavigation = command.awaitNavigation ?? false; // ✅ FIX 3: Navigation flag

    // ✅ NEW: Log detailed command information before execution.
    // Phase 2: redact interpolated `{{secrets.X}}` values BEFORE they go
    // through logger.info — once a real Stripe key lands in JSONL trace
    // / log files / forwarded log streams it's effectively leaked.
    logger.info('[COMMAND_EXECUTOR] Executing command (FINAL)', {
      action,
      selector: {
        original: command.selector,
        normalized: selector,
      },
      value: this.redactInLogs(value),
      url: this.redactInLogs(url),
      description: this.redactInLogs(description),
      awaitNavigation,
      timeout,
      continueOnError,
      waitFor: command.waitFor,
      assertion: command.assertion ? {
        type: command.assertion.type,
        // assertion.expected is user-authored copy that may also have
        // gone through resolvePlaceholders, so mask it too.
        expected: this.redactInLogs(command.assertion.expected),
        operator: command.assertion.operator,
      } : undefined,
      isIntentCommand,
      intentStepId: intentCommand.intentMeta?.stepId,
      hasCompiledPlan: !!intentCommand.intentMeta?.compiled,
    });

    try {
      switch (action) {
        case 'goto':
          if (!url) throw new Error('URL is required for goto action');
          await this.page.goto(url, {
            waitUntil: command.waitFor || 'load',
            timeout: timeout || 30000,
          });
          break;

        case 'click':
          // ✅ FIX 3: Helper for click with optional navigation wait
          const performClick = async (locator: Locator) => {
            // New-tab path: if the click target is an <a> that should open
            // as a new tab (explicit `target` attribute OR cross-origin
            // anchor), we open it via `context.newPage(); newPage.goto(href)`
            // instead of `locator.click()`. The BrowserContext-level
            // `on('page')` listener (preview-session.attachPopupHandler)
            // pushes the new page to `session.pages` and broadcasts
            // `preview:tab:opened`, so the editor renders a real second tab.
            //
            // We do this BEFORE the scroll/overlay/enabled gates because
            // (a) those gates only make sense for an actual locator click,
            // and (b) skipping them on the new-tab path means a stale /
            // off-screen link still opens (matches user expectation: in a
            // real browser, middle-click works without scrolling).
            try {
              const tabOpen = await tryOpenAnchorAsNewTab(
                locator,
                this.page.context(),
                this.page.url(),
              );
              if (tabOpen) {
                // Swap active page so subsequent steps target the new tab,
                // mirroring the existing post-click tab-switch path below.
                this.page = tabOpen.newPage;
                logger.info('[COMMAND_EXECUTOR] Anchor click promoted to new tab', {
                  reason: tabOpen.reason,
                  href: tabOpen.href,
                  newTabUrl: tabOpen.newPage.url(),
                });
                return;
              }
            } catch (err) {
              // Probe failure must NEVER block a click — fall through to the
              // normal path on any unexpected error.
              logger.debug('[COMMAND_EXECUTOR] New-tab probe errored, proceeding with normal click', {
                error: err instanceof Error ? err.message : String(err),
              });
            }

            await this.forceScrollIntoView(locator);
            // ✅ Overlay guard: Ensure element is topmost before clicking
            await this.ensureTopMostAtCenter(locator, 2000);
            // ✅ Wait for enabled: Ensure element is not disabled
            await this.waitForEnabled(locator, 5000);

            // V13: Build Playwright modifiers array from command modifiers
            const cmdModifiers: ('Shift' | 'Control' | 'Alt' | 'Meta')[] = [];
            if (command.modifiers) {
              if (command.modifiers.shift) cmdModifiers.push('Shift');
              if (command.modifiers.ctrl) cmdModifiers.push('Control');
              if (command.modifiers.meta) cmdModifiers.push('Meta');
              if (command.modifiers.alt) cmdModifiers.push('Alt');
            }
            const clickOpts: Parameters<Locator['click']>[0] = {
              timeout: timeout || 30000,
              // V15.5: Mirror the preview-step-apply fix. Playwright's default
              // post-action stability wait can block 15-30s on animated elements
              // (modals opening, dropdowns expanding). We don't need it here:
              // the inter-step lookahead in waitForStepReadiness() handles
              // readiness for the NEXT step, and a small post-action settle is
              // applied via performPostActionBuffer() below.
              noWaitAfter: true,
              ...(cmdModifiers.length > 0 && { modifiers: cmdModifiers }),
            };

            if (awaitNavigation) {
              // Capture URL before click to detect navigation
              const urlBeforeClick = this.page.url();
              const pagesBefore = this.page.context().pages().length;
              // Promise.all: attach URL listener BEFORE click fires to avoid race condition
              // on fast SPAs where navigation completes during click processing
              try {
                await Promise.all([
                  this.page.waitForURL(
                    (url) => url.toString() !== urlBeforeClick,
                    { timeout: COMMAND_EXECUTOR_CONFIG.clickNavigationTimeoutMs, waitUntil: 'load' }
                  ),
                  locator.click(clickOpts),
                ]);
                logger.debug('[COMMAND_EXECUTOR] Navigation after click detected', {
                  from: urlBeforeClick,
                  to: this.page.url(),
                });
              } catch {
                // URL didn't change — check if a new tab/popup opened
                const allPages = this.page.context().pages();
                if (allPages.length > pagesBefore) {
                  // New tab opened — switch to it
                  const newPage = allPages[allPages.length - 1];
                  // Wait for new page to be ready
                  try {
                    await newPage.waitForLoadState('load', { timeout: COMMAND_EXECUTOR_CONFIG.newPageLoadTimeoutMs });
                  } catch {
                    // Fallback: at least wait for domcontentloaded
                    await newPage.waitForLoadState('domcontentloaded', { timeout: COMMAND_EXECUTOR_CONFIG.newPageFallbackTimeoutMs }).catch(() => {});
                  }
                  const newUrl = newPage.url();
                  logger.info('[COMMAND_EXECUTOR] Click opened new tab, switching page', {
                    urlBeforeClick,
                    newTabUrl: newUrl,
                    totalPages: allPages.length,
                  });
                  this.page = newPage;
                } else {
                  logger.warn('[COMMAND_EXECUTOR] No navigation or new tab detected after click within 15s', {
                    urlBeforeClick,
                    currentUrl: this.page.url(),
                  });
                }
              }
            } else {
              await locator.click(clickOpts);
            }
          };

          // ✅ V2: Use intent-based locator resolution for IntentPlaywrightCommand
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'click',
              timeout || 30000
            );
            await performClick(intentLocator);
            break;
          }

          // Standard flow for non-intent commands
          if (!selector) throw new Error('Selector is required for click action');

          // ✅ NEW: Use smart locator to select the right element based on action context
          // This fixes the issue where text="Математика" finds <span> instead of <button>
          // Pass description as intent for AI disambiguation if needed
          const smartResult = await getSmartLocator(
            this.page,
            selector,
            'click',
            description // Intent for AI context
          );

          if (smartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used', {
              selector: selector.substring(0, 50),
              totalMatches: smartResult.totalMatches,
              selectedIndex: smartResult.selectedIndex,
            });
          }

          // Wait for element to be visible first
          try {
            await smartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await performClick(smartResult.locator);
          } catch (clickError) {
            // Smart locator failed, try self-healing
            logger.warn('[COMMAND_EXECUTOR] Smart locator click failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: clickError instanceof Error ? clickError.message : String(clickError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'visible', timeout: timeout || 30000 });
                await performClick(locator);
              },
              {
                selector,
                intent: description || 'click element',
                action: 'click',
                timeout,
              }
            );
          }
          break;

        case 'type': {
          // NOTE: Uses page.type() for keyboard-event simulation (keydown/keypress/keyup per char).
          // This is important for sites that validate input via keyboard events (autocomplete, OTP, etc.)
          if (value === undefined) throw new Error('Value is required for type action');

          // ═══════════════════════════════════════════════════════════════
          // V10: Smart Enter key decision
          // Priority:
          //   1. Explicit pressEnter flag from step options → use it directly (no AI call)
          //   2. Next step is "press Enter" → skip auto-Enter (next step handles it)
          //   3. Deterministic fast-path for obvious cases (search, OTP)
          //   4. AI-powered detection (fallback)
          // ═══════════════════════════════════════════════════════════════
          const explicitPressEnter = isIntentCommand && intentCommand.intentMeta?.pressEnter;

          // Check if next command is "press Enter" to avoid double-Enter
          const nextCommandIndex = this.currentCommandIndex !== undefined ? this.currentCommandIndex + 1 : -1;
          const nextIsEnterPress = nextCommandIndex >= 0 && this.currentCommandsList
            ? (() => {
                const next = this.currentCommandsList[nextCommandIndex];
                return next && next.action === 'press' && (next.value === 'Enter' || next.value === 'enter');
              })()
            : false;

          /**
           * Decide whether to press Enter after fill.
           * Returns true/false. Only calls AI as last resort.
           */
          const decideEnterAfterType = async (locator: Locator): Promise<boolean> => {
            // 1. Explicit flag from step options — trust it completely
            if (explicitPressEnter === true) {
              logger.debug('[COMMAND_EXECUTOR] pressEnter=true from step options (no AI needed)');
              return true;
            }
            if (explicitPressEnter === false) {
              return false;
            }

            // 2. Next step is "press Enter" — skip to avoid double-Enter
            if (nextIsEnterPress) {
              logger.debug('[COMMAND_EXECUTOR] Next step is press Enter — skipping auto-Enter');
              return false;
            }

            // 3. Deterministic fast-path for obvious cases (no AI call needed)
            const fastResult = await this.fastEnterDetection(locator);
            if (fastResult !== null) {
              logger.debug('[COMMAND_EXECUTOR] Fast-path Enter detection', { shouldPress: fastResult });
              return fastResult;
            }

            // 4. AI-powered detection (last resort)
            return shouldPressEnterAfterFill(locator, this.page, description);
          };

          // ✅ V2: Use intent-based locator resolution for IntentPlaywrightCommand
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentTypeLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'type',
              timeout || 30000
            );

            // V13: Paste mode — clipboard write + Ctrl/Cmd+V to trigger paste event listeners
            if (intentCommand.intentMeta.isPaste) {
              await intentTypeLocator.click({ timeout: timeout || 30000 }); // Focus
              const ctx = this.page.context();
              await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
              // @ts-expect-error - navigator exists in browser context
              await this.page.evaluate((text) => navigator.clipboard.writeText(text), String(value)).catch(async () => {
                await this.page.evaluate((text) => {
                  // @ts-expect-error - document exists in browser context
                  const ta = document.createElement('textarea');
                  ta.value = text;
                  // @ts-expect-error - document exists in browser context
                  document.body.appendChild(ta);
                  ta.select();
                  // @ts-expect-error - document exists in browser context
                  document.execCommand('copy');
                  ta.remove();
                }, String(value));
              });
              const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
              await this.page.keyboard.press(`${mod}+v`);
            } else {
              await typeWithOptionalClear(
                intentTypeLocator,
                String(value),
                timeout || 30000,
                {
                  replaceContent: intentCommand.intentMeta.replaceContent,
                  keyPressDelay: intentCommand.intentMeta.keyPressDelay,
                },
              );
            }

            // V10: Smart Enter decision
            const shouldPressIntent = await decideEnterAfterType(intentTypeLocator);
            if (shouldPressIntent) {
              await intentTypeLocator.press('Enter', { timeout: timeout || 5000 });
            }
            break;
          }

          // Standard flow for non-intent commands
          if (!selector) throw new Error('Selector is required for type action');

          const typeSmartResult = await getSmartLocator(
            this.page,
            selector,
            'type',
            description
          );

          if (typeSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for type', {
              selector: selector.substring(0, 50),
              totalMatches: typeSmartResult.totalMatches,
              selectedIndex: typeSmartResult.selectedIndex,
            });
          }

          try {
            await typeSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            // Use pressSequentially to simulate real keyboard events
            // V15.5: noWaitAfter — skip post-type stability wait
            await typeSmartResult.locator.pressSequentially(String(value), { timeout: timeout || 30000, noWaitAfter: true });

            // V10: Smart Enter decision
            const shouldPress = await decideEnterAfterType(typeSmartResult.locator);
            if (shouldPress) {
              logger.info('[COMMAND_EXECUTOR] Pressing Enter after type', {
                selector: selector.substring(0, 50),
              });
              await typeSmartResult.locator.press('Enter', { timeout: timeout || 5000, noWaitAfter: true });
            }
          } catch (typeError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator type failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: typeError instanceof Error ? typeError.message : String(typeError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.pressSequentially(String(value), { timeout: timeout || 30000, noWaitAfter: true });

                const shouldPressHealed = await decideEnterAfterType(locator);
                if (shouldPressHealed) {
                  logger.info('[COMMAND_EXECUTOR] Pressing Enter after type (self-healing)');
                  await locator.press('Enter', { timeout: timeout || 5000, noWaitAfter: true });
                }
              },
              {
                selector,
                intent: description || `type with ${value}`,
                action: 'type',
                timeout,
                value,
              }
            );
          }
          break;
        }

        case 'select': {
          if (value === undefined) throw new Error('Value is required for select action');

          // ✅ V2: Use intent-based locator resolution for IntentPlaywrightCommand
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentSelectLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'select',
              timeout || 30000
            );
            const intentSelectValue = this.parseSelectValue(value);
            await this.waitForEnabled(intentSelectLocator, 5000);
            const isNativeIntent = await this.isNativeSelectLocator(intentSelectLocator);
            if (isNativeIntent) {
              await this.waitForSelectOptions(intentSelectLocator, 5000, 3);
              await intentSelectLocator.selectOption(intentSelectValue, { timeout: timeout || 30000 });
            } else {
              await this.selectFromCustomDropdown(intentSelectLocator, String(value), timeout || 30000);
            }
            break;
          }

          if (!selector) throw new Error('Selector is required for select action');

          // ✅ NEW: Use smart locator to select the right select element
          const selectSmartResult = await getSmartLocator(
            this.page,
            selector,
            'select',
            description // Intent for AI context
          );

          if (selectSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for select', {
              selector: selector.substring(0, 50),
              totalMatches: selectSmartResult.totalMatches,
              selectedIndex: selectSmartResult.selectedIndex,
            });
          }

          // ✅ FIX 5: Support multiple selectOption formats
          const selectValue = this.parseSelectValue(value);

          try {
            await selectSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            // ✅ Wait for enabled: Ensure select is not disabled
            await this.waitForEnabled(selectSmartResult.locator, 5000);

            // Detect native <select> vs custom dropdown
            const isNativeSelectCmd = await this.isNativeSelectLocator(selectSmartResult.locator);

            if (isNativeSelectCmd) {
              // ✅ Wait for options: Ensure select has options available
              await this.waitForSelectOptions(selectSmartResult.locator, 5000, 3);
              await selectSmartResult.locator.selectOption(selectValue, { timeout: timeout || 30000 });
            } else {
              // Custom dropdown: click-based selection
              await this.selectFromCustomDropdown(selectSmartResult.locator, String(value), timeout || 30000);
            }
          } catch (selectError) {
            // Smart locator failed, try self-healing
            logger.warn('[COMMAND_EXECUTOR] Smart locator select failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: selectError instanceof Error ? selectError.message : String(selectError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                // ✅ Wait for enabled in self-healing path too
                await this.waitForEnabled(locator, 5000);

                const isNativeSH = await this.isNativeSelectLocator(locator);
                if (isNativeSH) {
                  await this.waitForSelectOptions(locator, 5000, 3);
                  await locator.selectOption(selectValue, { timeout: timeout || 30000 });
                } else {
                  await this.selectFromCustomDropdown(locator, String(value), timeout || 30000);
                }
              },
              {
                selector,
                intent: description || `select ${value}`,
                action: 'select',
                timeout,
                value,
              }
            );
          }
          break;
        }

        case 'check': {
          const performCheck = async (checkLocator: Locator) => {
            await checkLocator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await this.waitForEnabled(checkLocator, 5000);
            const alreadyChecked = await checkLocator.isChecked().catch(() => false);
            if (!alreadyChecked) {
              await checkLocator.check({ timeout: timeout || 30000 });
            } else {
              logger.debug('[COMMAND_EXECUTOR] check: element already checked, skipping');
            }
          };

          // Intent command path — compiled plan → LLM resolver → smart → self-heal
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentCheckLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'check', timeout || 30000
            );
            await performCheck(intentCheckLocator);
            break;
          }

          if (!selector) throw new Error('Selector is required for check action');

          const checkSmartResult = await getSmartLocator(this.page, selector, 'check', description);

          if (checkSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for check', {
              selector: selector.substring(0, 50),
              totalMatches: checkSmartResult.totalMatches,
              selectedIndex: checkSmartResult.selectedIndex,
            });
          }

          try {
            await performCheck(checkSmartResult.locator);
          } catch (checkError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator check failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: checkError instanceof Error ? checkError.message : String(checkError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performCheck(locator);
              },
              { selector, intent: description || 'check checkbox', action: 'check', timeout }
            );
          }
          break;
        }

        case 'uncheck': {
          const performUncheck = async (uncheckLocator: Locator) => {
            await uncheckLocator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await this.waitForEnabled(uncheckLocator, 5000);
            const alreadyUnchecked = !(await uncheckLocator.isChecked().catch(() => true));
            if (!alreadyUnchecked) {
              await uncheckLocator.uncheck({ timeout: timeout || 30000 });
            } else {
              logger.debug('[COMMAND_EXECUTOR] uncheck: element already unchecked, skipping');
            }
          };

          // Intent command path
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentUncheckLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'uncheck', timeout || 30000
            );
            await performUncheck(intentUncheckLocator);
            break;
          }

          if (!selector) throw new Error('Selector is required for uncheck action');

          const uncheckSmartResult = await getSmartLocator(this.page, selector, 'check', description);
          if (uncheckSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for uncheck', {
              selector: selector.substring(0, 50),
              totalMatches: uncheckSmartResult.totalMatches,
              selectedIndex: uncheckSmartResult.selectedIndex,
            });
          }

          try {
            await performUncheck(uncheckSmartResult.locator);
          } catch (uncheckError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator uncheck failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: uncheckError instanceof Error ? uncheckError.message : String(uncheckError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performUncheck(locator);
              },
              { selector, intent: description || 'uncheck checkbox', action: 'uncheck', timeout }
            );
          }
          break;
        }

        case 'hover': {
          const performHover = async (hoverLocator: Locator) => {
            await hoverLocator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await hoverLocator.hover({ timeout: timeout || 30000 });
          };

          // Intent command path
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentHoverLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'hover', timeout || 30000
            );
            await performHover(intentHoverLocator);
            // Adaptive post-hover settle — wait for tooltips/submenus to appear and stabilize
            await waitForHoverEffect(this.page);
            break;
          }

          if (!selector) throw new Error('Selector is required for hover action');

          const hoverSmartResult = await getSmartLocator(this.page, selector, 'hover', description);
          if (hoverSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for hover', {
              selector: selector.substring(0, 50),
              totalMatches: hoverSmartResult.totalMatches,
              selectedIndex: hoverSmartResult.selectedIndex,
            });
          }

          try {
            await performHover(hoverSmartResult.locator);
          } catch (hoverError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator hover failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: hoverError instanceof Error ? hoverError.message : String(hoverError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performHover(locator);
              },
              { selector, intent: description || 'hover element', action: 'hover', timeout }
            );
          }
          // Adaptive post-hover settle — wait for tooltips/submenus to appear and stabilize
          await waitForHoverEffect(this.page);
          break;
        }

        case 'dblclick': {
          const performDblclick = async (dblLocator: Locator) => {
            await dblLocator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await dblLocator.dblclick({ timeout: timeout || 30000 });
          };

          // Intent command path
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentDblLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 30000
            );
            await performDblclick(intentDblLocator);
            break;
          }

          if (!selector) throw new Error('Selector is required for dblclick action');

          const dblclickSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (dblclickSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for dblclick', {
              selector: selector.substring(0, 50),
              totalMatches: dblclickSmartResult.totalMatches,
              selectedIndex: dblclickSmartResult.selectedIndex,
            });
          }

          try {
            await performDblclick(dblclickSmartResult.locator);
          } catch (dblclickError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator dblclick failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: dblclickError instanceof Error ? dblclickError.message : String(dblclickError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performDblclick(locator);
              },
              { selector, intent: description || 'double click element', action: 'dblclick', timeout }
            );
          }
          break;
        }

        case 'focus': {
          if (!selector) throw new Error('Selector is required for focus action');

          const focusSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (focusSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for focus', {
              selector: selector.substring(0, 50),
              totalMatches: focusSmartResult.totalMatches,
              selectedIndex: focusSmartResult.selectedIndex,
            });
          }

          try {
            await focusSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await focusSmartResult.locator.focus({ timeout: timeout || 30000 });
          } catch (focusError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator focus failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: focusError instanceof Error ? focusError.message : String(focusError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
                await locator.focus({ timeout: timeout || 30000 });
              },
              { selector, intent: description || 'focus element', action: 'focus', timeout }
            );
          }
          break;
        }

        case 'blur': {
          if (!selector) throw new Error('Selector is required for blur action');

          const blurSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (blurSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for blur', {
              selector: selector.substring(0, 50),
              totalMatches: blurSmartResult.totalMatches,
              selectedIndex: blurSmartResult.selectedIndex,
            });
          }

          try {
            await blurSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await blurSmartResult.locator.blur({ timeout: timeout || 30000 });
          } catch (blurError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator blur failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: blurError instanceof Error ? blurError.message : String(blurError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
                await locator.blur({ timeout: timeout || 30000 });
              },
              { selector, intent: description || 'blur element', action: 'blur', timeout }
            );
          }
          break;
        }

        case 'press': {
          if (!value) throw new Error('Key is required for press action');

          const performPress = async (locator: Locator) => {
            await locator.waitFor({ state: 'attached', timeout: timeout || 10000 });
            await this.ensureFocused(locator, 2000);
            // V15.5: noWaitAfter — skip post-press stability wait
            await locator.press(String(value), { timeout: timeout || 30000, noWaitAfter: true });
          };

          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentPressLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'press',
              timeout || 30000
            );
            await performPress(intentPressLocator);
            break;
          }

          if (selector) {
            const pressSmartResult = await getSmartLocator(this.page, selector, 'press' as any, description);
            try {
              await performPress(pressSmartResult.locator);
            } catch (pressError) {
              logger.warn('[COMMAND_EXECUTOR] Smart locator press failed, trying self-healing', {
                selector: selector.substring(0, 50),
                error: pressError instanceof Error ? pressError.message : String(pressError),
              });
              await this.executeWithSelfHealing(
                async () => {
                  const locator = getLocator(this.page, selector);
                  await performPress(locator);
                },
                { selector, intent: description || `press ${value}`, action: 'press', timeout, value }
              );
            }
          } else {
            // No selector — use page.keyboard.press (focus-dependent, warn)
            logger.warn('[COMMAND_EXECUTOR] Using page.keyboard.press without selector — focus-dependent', {
              key: String(value),
            });
            await this.page.keyboard.press(String(value));
          }
          break;
        }

        // V14: dragAndDrop moved below (unified handler with coordinate + selector + intent support)

        case 'tap':
          if (!selector) throw new Error('Selector is required for tap action');
          const tapLocator = this.getLocatorInternal(selector);
          await tapLocator.tap({ timeout: timeout || 30000 });
          break;

        // V18: real swipe handling lives below (mouse-drag simulation from {start,end} coords)

        case 'goBack':
          await this.page.goBack({ timeout: timeout || 30000 });
          break;

        case 'goForward':
          await this.page.goForward({ timeout: timeout || 30000 });
          break;

        case 'reload':
          await this.page.reload({ timeout: timeout || 30000 });
          break;

        case 'scrollIntoView':
          if (!selector) throw new Error('Selector is required for scrollIntoView action');
          const scrollIntoViewLocator = this.getLocatorInternal(selector);
          await scrollIntoViewLocator.scrollIntoViewIfNeeded({ timeout: timeout || 30000 });
          break;

        case 'wait':
          await this.page.waitForTimeout(timeout || 1000);
          break;

        case 'waitForSelector':
          if (!selector) throw new Error('Selector is required for waitForSelector action');
          const waitLocator = this.getLocatorInternal(selector);
          await waitLocator.waitFor({ state: 'visible', timeout: timeout || 30000 });
          break;

        case 'waitForNavigation':
          await this.page.waitForLoadState('networkidle', { timeout: timeout || 30000 });
          break;

        // V5: SPA-safe URL waiting (Momentic-like matchers)
        case 'waitFor': {
          const matcher = command.urlMatcher;
          // V5.2: urlMatcher.timeoutMs takes priority (set explicitly per matcher type)
          const waitForTimeout = matcher?.timeoutMs ?? timeout ?? 15000;
          await this.executeWaitFor(matcher, waitForTimeout);
          break;
        }

        // V13: Verify file download (wait for download event from previous click)
        case 'verifyDownload': {
          const dlOpts = command.download;
          const dlTimeout = dlOpts?.timeoutMs ?? timeout ?? 15000;
          const expectedName = dlOpts?.filename || (typeof command.value === 'string' ? command.value : undefined);

          const dl = await this.page.waitForEvent('download', { timeout: dlTimeout });
          const actualName = dl.suggestedFilename();

          if (expectedName && !actualName.toLowerCase().includes(expectedName.toLowerCase())) {
            await dl.cancel().catch(() => {});
            throw new Error(`Download filename mismatch. Expected: "${expectedName}", Got: "${actualName}"`);
          }
          await dl.cancel().catch(() => {});
          break;
        }

        // V13: Handle native dialog (alert/confirm/prompt/beforeunload)
        // Pre-installs a one-time dialog handler that fires when the next action triggers the dialog.
        case 'handleDialog': {
          const dialogOpts = command.dialog;
          if (!dialogOpts) throw new Error('handleDialog requires dialog options');

          this.page.once('dialog', async (dialog) => {
            try {
              if (dialogOpts.action === 'accept') {
                await dialog.accept(dialogOpts.promptText);
              } else {
                await dialog.dismiss();
              }
            } catch { /* dialog may already be handled */ }
          });
          // Return immediately — the handler is pre-installed and will fire
          // when the next command (e.g., click) triggers the dialog.
          break;
        }

        case 'scroll':
          if (selector) {
            const scrollLocator = this.getLocatorInternal(selector);
            await scrollLocator.scrollIntoViewIfNeeded();
          } else if (command.value) {
            // V14: Use deltaY,deltaX from step value
            const sParts = (typeof command.value === 'string' ? command.value : String(command.value)).split(',');
            const sDy = parseFloat(sParts[0] || '') || 300;
            const sDx = sParts.length > 1 ? (parseFloat(sParts[1] || '') || 0) : 0;

            // Container scroll support: use recorded container selector if available
            const scrollContainerSel = (command as any).intentMeta?.scrollContainer
              || (command as any).options?.scrollContainer;
            if (scrollContainerSel) {
              await this.page.evaluate(({ sel, dx, dy }: { sel: string; dx: number; dy: number }) => {
                // @ts-expect-error - browser context
                const container = document.querySelector(sel);
                if (container) {
                  container.scrollBy(dx, dy);
                } else {
                  // @ts-expect-error - browser context
                  window.scrollBy(dx, dy);
                }
              }, { sel: scrollContainerSel, dx: sDx, dy: sDy });
            } else {
              await this.page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
                // @ts-expect-error - browser context
                window.scrollBy(dx, dy);
              }, { dx: sDx, dy: sDy });
            }
          } else {
            await this.page.evaluate(() => {
              // @ts-expect-error - browser context
              window.scrollTo(0, document.body.scrollHeight);
            });
          }
          break;

        case 'screenshot': {
          const screenshot = await this.page.screenshot({ type: 'png', fullPage: false });
          return {
            success: true,
            screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
          };
        }

        case 'assertVisible': {
          const performAssertVisible = async (loc: Locator) => {
            const isVis = await loc.isVisible({ timeout: timeout || 5000 });
            if (!isVis) throw new Error(`Element not visible: ${selector}`);
          };

          // Intent command path — compiled plan → LLM resolver → smart → self-heal
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentAssertVisLoc } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 5000
            );
            await performAssertVisible(intentAssertVisLoc);
            logger.info('Assertion passed: Element is visible', { selector });
            break;
          }

          if (!selector) throw new Error('Selector is required for assertVisible action');

          const assertVisSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertVisSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assertVisible', {
              selector: selector.substring(0, 50),
              totalMatches: assertVisSmartResult.totalMatches,
              selectedIndex: assertVisSmartResult.selectedIndex,
            });
          }

          try {
            await performAssertVisible(assertVisSmartResult.locator);
          } catch (assertVisError) {
            if (assertVisError instanceof Error && assertVisError.message.startsWith('Element not visible')) throw assertVisError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assertVisible failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertVisError instanceof Error ? assertVisError.message : String(assertVisError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performAssertVisible(locator);
              },
              { selector, intent: description || 'assert element visible', action: 'assertVisible', timeout }
            );
          }
          logger.info('Assertion passed: Element is visible', { selector });
          break;
        }

        case 'assertText': {
          const performAssertText = async (locator: Locator) => {
            await locator.waitFor({ state: 'visible', timeout: timeout || 5000 });
            const actualText = await locator.textContent();
            const expectedText = String(command.assertion?.expected || '');
            const op = command.assertion?.operator || '=';
            const passed = this.compareValues(actualText || '', expectedText, op);
            if (!passed) {
              throw new Error(`Text assertion failed for ${selector}: expected "${expectedText}", got "${actualText}"`);
            }
            logger.info('Assertion passed: Text matches', { selector, expected: expectedText, actual: actualText });
          };

          // Intent command path — compiled plan → LLM resolver → smart → self-heal
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentAssertTxtLoc } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 5000
            );
            await performAssertText(intentAssertTxtLoc);
            break;
          }

          if (!selector) throw new Error('Selector is required for assertText action');

          const assertTxtSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertTxtSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assertText', {
              selector: selector.substring(0, 50),
              totalMatches: assertTxtSmartResult.totalMatches,
              selectedIndex: assertTxtSmartResult.selectedIndex,
            });
          }

          try {
            await performAssertText(assertTxtSmartResult.locator);
          } catch (assertTxtError) {
            if (assertTxtError instanceof Error && assertTxtError.message.startsWith('Text assertion failed')) throw assertTxtError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assertText failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertTxtError instanceof Error ? assertTxtError.message : String(assertTxtError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performAssertText(locator);
              },
              { selector, intent: description || `assert text ${command.assertion?.expected}`, action: 'assertText', timeout }
            );
          }
          break;
        }

        case 'assertValue': {
          const performAssertValue = async (locator: Locator) => {
            await locator.waitFor({ state: 'visible', timeout: timeout || 5000 });
            const actualValue = await locator.inputValue();
            const expectedValue = String(command.assertion?.expected || '');
            const valueOperator = command.assertion?.operator || '=';
            const valuePassed = this.compareValues(actualValue, expectedValue, valueOperator);
            if (!valuePassed) {
              throw new Error(`Value assertion failed for ${selector}: expected "${expectedValue}", got "${actualValue}"`);
            }
            logger.info('Assertion passed: Value matches', { selector, expected: expectedValue, actual: actualValue });
          };

          // Intent command path
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentAssertValLoc } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 5000
            );
            await performAssertValue(intentAssertValLoc);
            break;
          }

          if (!selector) throw new Error('Selector is required for assertValue action');

          const assertValSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertValSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assertValue', {
              selector: selector.substring(0, 50),
              totalMatches: assertValSmartResult.totalMatches,
              selectedIndex: assertValSmartResult.selectedIndex,
            });
          }

          try {
            await performAssertValue(assertValSmartResult.locator);
          } catch (assertValError) {
            if (assertValError instanceof Error && assertValError.message.startsWith('Value assertion failed')) throw assertValError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assertValue failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertValError instanceof Error ? assertValError.message : String(assertValError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performAssertValue(locator);
              },
              { selector, intent: description || `assert value ${command.assertion?.expected}`, action: 'assertValue', timeout }
            );
          }
          break;
        }

        case 'assertUrl':
          await this.assertUrl(command.assertion);
          break;

        case 'assertCount': {
          const performAssertCount = async (locator: Locator) => {
            const actualCount = await locator.count();
            const expectedCount = Number(command.assertion?.expected || 0);
            const countOp = command.assertion?.operator || '=';
            const countPassed = this.compareValues(actualCount, expectedCount, countOp);
            if (!countPassed) {
              throw new Error(`Count assertion failed for ${selector}: expected ${expectedCount}, got ${actualCount}`);
            }
            logger.info('Assertion passed: Count matches', { selector, expected: expectedCount, actual: actualCount });
          };

          // Intent command path
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentAssertCntLoc } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 5000
            );
            await performAssertCount(intentAssertCntLoc);
            break;
          }

          if (!selector) throw new Error('Selector is required for assertCount action');

          const assertCntSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertCntSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assertCount', {
              selector: selector.substring(0, 50),
              totalMatches: assertCntSmartResult.totalMatches,
              selectedIndex: assertCntSmartResult.selectedIndex,
            });
          }

          try {
            await performAssertCount(assertCntSmartResult.locator);
          } catch (assertCntError) {
            if (assertCntError instanceof Error && assertCntError.message.startsWith('Count assertion failed')) throw assertCntError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assertCount failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertCntError instanceof Error ? assertCntError.message : String(assertCntError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performAssertCount(locator);
              },
              { selector, intent: description || `assert count ${command.assertion?.expected}`, action: 'assertCount', timeout }
            );
          }
          break;
        }

        case 'extract': {
          if (!selector) throw new Error('Selector is required for extract action');
          if (!command.extract) throw new Error('Extract config is required for extract action');

          const extractSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (extractSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for extract', {
              selector: selector.substring(0, 50),
              totalMatches: extractSmartResult.totalMatches,
              selectedIndex: extractSmartResult.selectedIndex,
            });
          }

          try {
            await extractSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 5000 });
            const extractedValue = await this.extractDataWithLocator(extractSmartResult.locator, command.extract);
            this.extractedData.set(command.extract.name, extractedValue);
            return { success: true, extractedValue };
          } catch (extractError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator extract failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: extractError instanceof Error ? extractError.message : String(extractError),
            });
            let healedValue: any;
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'visible', timeout: timeout || 5000 });
                healedValue = await this.extractDataWithLocator(locator, command.extract!);
                this.extractedData.set(command.extract!.name, healedValue);
              },
              { selector, intent: description || `extract ${command.extract.name}`, action: 'extract', timeout }
            );
            return { success: true, extractedValue: healedValue };
          }
        }

        case 'fill': {
          // Alias for type — fill without keyboard events (faster)
          if (value === undefined) throw new Error('Value is required for fill action');

          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentFillLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'type',
              timeout || 30000
            );
            await fillWithOptionalAppend(
              intentFillLocator,
              String(value),
              timeout || 30000,
              intentCommand.intentMeta.replaceContent,
            );
            break;
          }

          if (!selector) throw new Error('Selector is required for fill action');

          const fillSmartResult = await getSmartLocator(this.page, selector, 'type', description);
          try {
            await fillSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await fillSmartResult.locator.fill(String(value), { timeout: timeout || 30000, noWaitAfter: true });
          } catch (fillError) {
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector!);
                await locator.fill(String(value), { timeout: timeout || 30000, noWaitAfter: true });
              },
              { selector, intent: description || `fill with ${value}`, action: 'fill', timeout, value }
            );
          }
          break;
        }

        // Alias: selectOption → select
        case 'selectOption': {
          if (!selector) throw new Error('Selector is required for selectOption action');
          if (value === undefined) throw new Error('Value is required for selectOption action');

          const soSmartResult = await getSmartLocator(this.page, selector, 'select', description);
          const soValue = this.parseSelectValue(value);
          try {
            await soSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await this.waitForEnabled(soSmartResult.locator, 5000);
            const isNativeSO = await this.isNativeSelectLocator(soSmartResult.locator);
            if (isNativeSO) {
              await this.waitForSelectOptions(soSmartResult.locator, 5000, 3);
              await soSmartResult.locator.selectOption(soValue, { timeout: timeout || 30000 });
            } else {
              await this.selectFromCustomDropdown(soSmartResult.locator, String(value), timeout || 30000);
            }
          } catch (soError) {
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector!);
                await this.waitForEnabled(locator, 5000);
                const isNative = await this.isNativeSelectLocator(locator);
                if (isNative) {
                  await this.waitForSelectOptions(locator, 5000, 3);
                  await locator.selectOption(soValue, { timeout: timeout || 30000 });
                } else {
                  await this.selectFromCustomDropdown(locator, String(value), timeout || 30000);
                }
              },
              { selector, intent: description || `select ${value}`, action: 'select', timeout, value }
            );
          }
          break;
        }

        // toggle: click only if current state doesn't match desired state
        case 'toggle': {
          const performToggle = async (toggleLocator: import('playwright').Locator) => {
            await toggleLocator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await this.waitForEnabled(toggleLocator, 5000);

            const isChecked = await toggleLocator.isChecked().catch(() => null);
            if (isChecked === null) {
              // Not a checkbox/radio — plain click
              await this.forceScrollIntoView(toggleLocator);
              await toggleLocator.click({ timeout: timeout || 30000 });
            } else {
              // value='true' → want checked, value='false' → want unchecked, undefined → flip
              const wantChecked = value !== undefined ? String(value).toLowerCase() !== 'false' : !isChecked;
              if (isChecked !== wantChecked) {
                await this.forceScrollIntoView(toggleLocator);
                await toggleLocator.click({ timeout: timeout || 30000 });
              } else {
                logger.debug('[COMMAND_EXECUTOR] Toggle skipped: already in desired state', {
                  selector, isChecked, wantChecked,
                });
              }
            }
          };

          // Intent command path
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentToggleLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 30000
            );
            await performToggle(intentToggleLocator);
            break;
          }

          if (!selector) throw new Error('Selector is required for toggle action');

          const toggleSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          try {
            await performToggle(toggleSmartResult.locator);
          } catch (toggleError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator toggle failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: toggleError instanceof Error ? toggleError.message : String(toggleError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performToggle(locator);
              },
              { selector, intent: description || 'toggle element', action: 'click', timeout }
            );
          }
          break;
        }

        // open / close: semantic click aliases — same resilience as click
        case 'open':
        case 'close': {
          if (!selector && !(isIntentCommand && intentCommand.intentMeta)) {
            throw new Error(`Selector is required for ${action} action`);
          }

          const performOpenClose = async (locator: Locator) => {
            await locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await this.forceScrollIntoView(locator);
            await this.waitForEnabled(locator, 5000);
            // V15.5: skip Playwright's 15-30s post-action stability wait
            await locator.click({ timeout: timeout || 30000, noWaitAfter: true });
          };

          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentOcLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'click',
              timeout || 30000
            );
            await performOpenClose(intentOcLocator);
            break;
          }

          const ocSmartResult = await getSmartLocator(this.page, selector!, 'click', description);
          try {
            await performOpenClose(ocSmartResult.locator);
          } catch (ocError) {
            logger.warn(`[COMMAND_EXECUTOR] Smart locator ${action} failed, trying self-healing`, {
              selector: selector!.substring(0, 50),
              error: ocError instanceof Error ? ocError.message : String(ocError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector!);
                await performOpenClose(locator);
              },
              { selector: selector!, intent: description || `${action} element`, action: 'click', timeout }
            );
          }
          break;
        }

        // assert: compound assertion — smart locator for element resolution, self-healing fallback
        case 'assert': {
          if (!selector) throw new Error('Selector is required for assert action');

          const assertSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assert', {
              selector: selector.substring(0, 50),
              totalMatches: assertSmartResult.totalMatches,
              selectedIndex: assertSmartResult.selectedIndex,
            });
          }

          const performAssert = async (assertLocator: Locator) => {
            if (command.assertion?.type) {
              switch (command.assertion.type) {
                case 'visible': {
                  const vis = await assertLocator.isVisible({ timeout: timeout || 5000 });
                  if (!vis) throw new Error(`Assertion failed: element not visible: ${selector}`);
                  break;
                }
                case 'hidden': {
                  const hid = await assertLocator.isHidden({ timeout: timeout || 5000 });
                  if (!hid) throw new Error(`Assertion failed: element not hidden: ${selector}`);
                  break;
                }
                case 'text': {
                  await assertLocator.waitFor({ state: 'visible', timeout: timeout || 5000 });
                  const txt = await assertLocator.textContent();
                  const exp = String(command.assertion.expected || '');
                  const op = command.assertion.operator || 'contains';
                  if (!this.compareValues(txt || '', exp, op)) {
                    throw new Error(`Text assertion failed: expected "${exp}", got "${txt}"`);
                  }
                  break;
                }
                case 'value': {
                  await assertLocator.waitFor({ state: 'visible', timeout: timeout || 5000 });
                  const val = await assertLocator.inputValue();
                  const expVal = String(command.assertion.expected || '');
                  const opVal = command.assertion.operator || '=';
                  if (!this.compareValues(val, expVal, opVal)) {
                    throw new Error(`Value assertion failed: expected "${expVal}", got "${val}"`);
                  }
                  break;
                }
                case 'enabled': {
                  const enabled = await assertLocator.isEnabled({ timeout: timeout || 5000 });
                  if (!enabled) throw new Error(`Assertion failed: element not enabled: ${selector}`);
                  break;
                }
                case 'disabled': {
                  const disabled = await assertLocator.isDisabled({ timeout: timeout || 5000 });
                  if (!disabled) throw new Error(`Assertion failed: element not disabled: ${selector}`);
                  break;
                }
                case 'count': {
                  const cnt = await assertLocator.count();
                  const expCnt = Number(command.assertion.expected ?? 0);
                  const cntOp = command.assertion.operator || '=';
                  if (!this.compareValues(cnt, expCnt, cntOp)) {
                    throw new Error(`Count assertion failed: expected ${expCnt} (${cntOp}), got ${cnt} for ${selector}`);
                  }
                  break;
                }
                case 'url': {
                  await this.assertUrl(command.assertion);
                  break;
                }
                default: {
                  const vis2 = await assertLocator.isVisible({ timeout: timeout || 5000 });
                  if (!vis2) throw new Error(`Assertion failed: element not visible: ${selector}`);
                }
              }
            } else {
              const vis3 = await assertLocator.isVisible({ timeout: timeout || 5000 });
              if (!vis3) throw new Error(`Assertion failed: element not visible: ${selector}`);
            }
          };

          try {
            await performAssert(assertSmartResult.locator);
          } catch (assertError) {
            // Re-throw actual assertion failures (element found but assertion logic failed)
            if (assertError instanceof Error && assertError.message.startsWith('Assertion failed')) throw assertError;
            if (assertError instanceof Error && assertError.message.includes('assertion failed')) throw assertError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assert failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertError instanceof Error ? assertError.message : String(assertError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await performAssert(locator);
              },
              { selector, intent: description || 'assert element', action: 'assert', timeout }
            );
          }
          logger.info('[COMMAND_EXECUTOR] Assertion passed', { action: 'assert', selector });
          break;
        }

        case 'assertHidden': {
          if (!selector) throw new Error('Selector is required for assertHidden action');
          // No smart locator — element is expected to be hidden, so visibility-based resolution is wrong.
          // Only self-healing to handle stale selectors.
          try {
            const assertHiddenLocator = this.getLocatorInternal(selector);
            const isHidden = await assertHiddenLocator.isHidden({ timeout: timeout || 5000 });
            if (!isHidden) {
              throw new Error(`Element is visible but expected to be hidden: ${selector}`);
            }
          } catch (assertHidError) {
            if (assertHidError instanceof Error && assertHidError.message.includes('expected to be hidden')) throw assertHidError;
            logger.warn('[COMMAND_EXECUTOR] assertHidden locator failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertHidError instanceof Error ? assertHidError.message : String(assertHidError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                const hid = await locator.isHidden({ timeout: timeout || 5000 });
                if (!hid) throw new Error(`Element is visible but expected to be hidden: ${selector}`);
              },
              { selector, intent: description || 'assert element hidden', action: 'assertHidden', timeout }
            );
          }
          logger.info('Assertion passed: Element is hidden', { selector });
          break;
        }

        case 'assertEnabled': {
          if (!selector) throw new Error('Selector is required for assertEnabled action');

          const assertEnSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertEnSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assertEnabled', {
              selector: selector.substring(0, 50),
              totalMatches: assertEnSmartResult.totalMatches,
              selectedIndex: assertEnSmartResult.selectedIndex,
            });
          }

          try {
            // Use 'attached' not 'visible' — disabled elements can be in DOM but hidden
            await assertEnSmartResult.locator.waitFor({ state: 'attached', timeout: timeout || 5000 });
            const isEnabled = await assertEnSmartResult.locator.isEnabled({ timeout: timeout || 5000 });
            if (!isEnabled) {
              throw new Error(`Element is disabled but expected to be enabled: ${selector}`);
            }
          } catch (assertEnError) {
            if (assertEnError instanceof Error && assertEnError.message.includes('expected to be enabled')) throw assertEnError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assertEnabled failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertEnError instanceof Error ? assertEnError.message : String(assertEnError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'attached', timeout: timeout || 5000 });
                const en = await locator.isEnabled({ timeout: timeout || 5000 });
                if (!en) throw new Error(`Element is disabled but expected to be enabled: ${selector}`);
              },
              { selector, intent: description || 'assert element enabled', action: 'assertEnabled', timeout }
            );
          }
          logger.info('Assertion passed: Element is enabled', { selector });
          break;
        }

        case 'assertDisabled': {
          if (!selector) throw new Error('Selector is required for assertDisabled action');

          const assertDisSmartResult = await getSmartLocator(this.page, selector, 'click', description);
          if (assertDisSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for assertDisabled', {
              selector: selector.substring(0, 50),
              totalMatches: assertDisSmartResult.totalMatches,
              selectedIndex: assertDisSmartResult.selectedIndex,
            });
          }

          try {
            // Use 'attached' not 'visible' — disabled elements can be in DOM but hidden
            await assertDisSmartResult.locator.waitFor({ state: 'attached', timeout: timeout || 5000 });
            const isDisabled = await assertDisSmartResult.locator.isDisabled({ timeout: timeout || 5000 });
            if (!isDisabled) {
              throw new Error(`Element is enabled but expected to be disabled: ${selector}`);
            }
          } catch (assertDisError) {
            if (assertDisError instanceof Error && assertDisError.message.includes('expected to be disabled')) throw assertDisError;
            logger.warn('[COMMAND_EXECUTOR] Smart locator assertDisabled failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: assertDisError instanceof Error ? assertDisError.message : String(assertDisError),
            });
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'attached', timeout: timeout || 5000 });
                const dis = await locator.isDisabled({ timeout: timeout || 5000 });
                if (!dis) throw new Error(`Element is enabled but expected to be disabled: ${selector}`);
              },
              { selector, intent: description || 'assert element disabled', action: 'assertDisabled', timeout }
            );
          }
          logger.info('Assertion passed: Element is disabled', { selector });
          break;
        }

        // waitForTimeout: alias for wait
        case 'waitForTimeout': {
          const rawMs = timeout ?? (value !== undefined ? Number(Array.isArray(value) ? value[0] : value) : undefined);
          const waitMs = Number.isFinite(rawMs) && (rawMs as number) > 0 ? Math.floor(rawMs as number) : 1000;
          await this.page.waitForTimeout(waitMs);
          break;
        }

        // waitForLoadState: wait for specific load state
        case 'waitForLoadState': {
          const loadState = (value as 'load' | 'domcontentloaded' | 'networkidle') || 'networkidle';
          await this.page.waitForLoadState(loadState, { timeout: timeout || 30000 });
          break;
        }

        // script: alias for evaluate
        case 'script': {
          if (!value) throw new Error('Script is required for script action');
          const scriptAlias = String(value);
          logger.debug('[COMMAND_EXECUTOR] Executing script (alias for evaluate)', {
            scriptPreview: scriptAlias.substring(0, 100) + (scriptAlias.length > 100 ? '...' : ''),
          });
          await this.page.evaluate(scriptAlias);
          break;
        }

        // download: read-only, just trigger the download event
        case 'download': {
          if (!selector) throw new Error('Selector is required for download action');
          const downloadLocator = this.getLocatorInternal(selector);
          await downloadLocator.waitFor({ state: 'visible', timeout: timeout || 10000 });
          // Start download — we don't save the file, just trigger and log
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: timeout || 30000 }),
            downloadLocator.click({ timeout: timeout || 30000 }),
          ]);
          logger.info('[COMMAND_EXECUTOR] Download triggered', {
            suggestedFilename: download.suggestedFilename(),
          });
          break;
        }

        case 'evaluate':
          // ✅ FIX 6: Log script (truncated) for security audit
          if (!value) throw new Error('Script is required for evaluate action');
          const script = String(value);
          logger.debug('[COMMAND_EXECUTOR] Executing evaluate script', {
            scriptPreview: script.substring(0, 100) + (script.length > 100 ? '...' : ''),
            scriptLength: script.length,
          });
          await this.page.evaluate(script);
          break;

        // ═══════════════════════════════════════════════════════════════
        // V3: AI CHECK (LLM-based assertion)
        // ═══════════════════════════════════════════════════════════════
        case 'aiCheck': {
          logger.info('[COMMAND_EXECUTOR] Executing aiCheck assertion', {
            stepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
            assertionText: isIntentCommand ? intentCommand.intentMeta?.assertionText : undefined,
          });

          if (!isIntentCommand || !intentCommand.intentMeta?.assertionText) {
            throw new Error('aiCheck requires intentMeta.assertionText');
          }

          try {
            // Import services
            const { evaluateAiCheck } = await import('@/services/testing/ui/preview/ai-check.service');
            const { buildSemanticHtmlFromPage } = await import('@/services/testing/ui/preview/html-context.service');

            // Determine context mode (default: html+a11y+screenshot)
            const contextMode = intentCommand.intentMeta.aiContextMode || 'html+a11y+screenshot';

            // Gather context based on mode
            let html: string | undefined;
            let a11yTree: any[] | undefined;
            let screenshotBase64: string | undefined;

            // Feature flag: use semantic HTML builder (default: ON)
            const useSemanticHtml = process.env.AI_CHECK_SEMANTIC_HTML !== '0';

            if (contextMode.includes('html')) {
              if (useSemanticHtml) {
                try {
                  // Use semantic HTML builder with token budgeting
                  const semanticResult = await buildSemanticHtmlFromPage(this.page, {
                    assertionText: intentCommand.intentMeta.assertionText,
                    tokenBudget: 8000,
                    expandForNegative: true,
                  });
                  html = semanticResult.html;
                  
                  logger.debug('[COMMAND_EXECUTOR] Using semantic HTML for aiCheck', {
                    stepId: intentCommand.intentMeta.stepId,
                    originalLength: semanticResult.originalLength,
                    semanticLength: semanticResult.semanticLength,
                    tokens: semanticResult.tokens,
                    reduction: `${Math.round((1 - semanticResult.semanticLength / semanticResult.originalLength) * 100)}%`,
                  });
                } catch (semanticError) {
                  // Fallback to raw HTML if semantic builder fails
                  logger.warn('[COMMAND_EXECUTOR] Semantic HTML builder failed, falling back to raw HTML', {
                    stepId: intentCommand.intentMeta.stepId,
                    error: semanticError instanceof Error ? semanticError.message : String(semanticError),
                  });
                  html = await this.page.content();
                  // Truncate if too large (100KB)
                  if (html.length > 100 * 1024) {
                    html = html.substring(0, 100 * 1024);
                  }
                }
              } else {
                // Legacy path: use raw HTML with truncation
                html = await this.page.content();
                // Truncate if too large (100KB)
                if (html.length > 100 * 1024) {
                  html = html.substring(0, 100 * 1024);
                }
              }
            }

            if (contextMode.includes('a11y')) {
              // Fetch accessibility tree via CDP
              const cdpSession = await this.page.context().newCDPSession(this.page);
              try {
                const { nodes } = await cdpSession.send('Accessibility.getFullAXTree');
                // Convert CDP nodes to our format (simplified)
                a11yTree = this.convertCdpA11yTree(nodes);
              } catch (a11yError) {
                logger.warn('[COMMAND_EXECUTOR] Failed to fetch accessibility tree', {
                  error: a11yError instanceof Error ? a11yError.message : String(a11yError),
                });
              } finally {
                await cdpSession.detach();
              }
            }

            if (contextMode.includes('screenshot')) {
              const screenshot = await this.page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
              screenshotBase64 = screenshot.toString('base64');
            }

            // Evaluate AI check
            const aiCheckResult = await evaluateAiCheck({
              assertionText: intentCommand.intentMeta.assertionText,
              url: this.page.url(),
              html,
              a11yTree,
              screenshotBase64,
            });

            logger.info('[COMMAND_EXECUTOR] aiCheck evaluation completed', {
              stepId: intentCommand.intentMeta.stepId,
              pass: aiCheckResult.pass,
              confidence: aiCheckResult.confidence,
            });

            // If check fails, throw error with explanation
            if (!aiCheckResult.pass) {
              // Audit (Loki): ONLY when the check ERRORED (couldn't produce a
              // trustworthy verdict). A confident pass:false is a legitimate
              // assertion failure — already a recorded failed step, not a system
              // failure. assertion + explanation go through redactString (Hard
              // invariant #10 — they can carry resolved {{secrets.*}} values).
              if (aiCheckResult.evaluationError) {
                logAiCheckError({
                  source: 'replay',
                  userId: this.metadata.userId,
                  projectId: this.metadata.projectId,
                  stepId: intentCommand.intentMeta?.stepId,
                  confidence: aiCheckResult.confidence,
                  redactedAssertion: this.redactString(intentCommand.intentMeta.assertionText ?? ''),
                  redactedExplanation: this.redactString(aiCheckResult.explanation),
                });
              }
              // Record failure in runtime meta
              if (isIntentCommand && intentCommand.intentMeta?.stepId) {
                this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                  runtimeStatus: 'failed',
                  source: 'resolver',
                  confidenceTier: 'high',
                  failedReason: 'assertion_failed',
                  failureExplanation: aiCheckResult.explanation,
                  resolutionPath: 'llm_resolver',
                });
              }
              throw new Error(aiCheckResult.explanation);
            }

            // Success - record in runtime meta
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'executed',
                source: 'resolver',
                confidenceTier: aiCheckResult.confidence && aiCheckResult.confidence >= 0.85 ? 'high' :
                                aiCheckResult.confidence && aiCheckResult.confidence >= 0.6 ? 'medium' : 'low',
                resolutionPath: 'llm_resolver',
              });
            }
          } catch (error) {
            // Record failure in runtime meta
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'failed',
                source: 'resolver',
                confidenceTier: 'low',
                failedReason: 'assertion_failed',
                failureExplanation: error instanceof Error ? error.message : String(error),
                resolutionPath: 'llm_resolver',
              });
            }
            throw error;
          }
          break;
        }

        // ═══════════════════════════════════════════════════════════════
        // V6: FILE UPLOAD
        // ═══════════════════════════════════════════════════════════════
        case 'upload': {
          logger.info('[COMMAND_EXECUTOR] Executing upload action', {
            stepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
            hasUploadConfig: !!command.upload,
            fileUrl: command.upload?.fileUrl?.substring(0, 100),
            sourceType: command.upload?.sourceType,
          });

          if (!command.upload?.fileUrl) {
            throw new Error('Upload config with fileUrl is required for upload action');
          }

          // Step 1: Download/prepare the file
          const { downloadFileForUpload, cleanupUploadTempFile } = await import('./file-download.service');
          let localFilePath: string;
          let downloadResult: Awaited<ReturnType<typeof downloadFileForUpload>> | undefined;

          try {
            // Both 'url' and 'storage' sources are public URLs — download to temp dir
            downloadResult = await downloadFileForUpload(command.upload.fileUrl, {
              filename: command.upload.filename,
              maxSizeBytes: command.upload.maxSizeBytes,
            });
            localFilePath = downloadResult.localPath;

            logger.info('[COMMAND_EXECUTOR] File prepared for upload', {
              localFilePath,
              sizeBytes: downloadResult?.sizeBytes,
            });

            // Step 2: Resolve the file input locator and upload
            // Supports both <input type="file"> and trigger-button patterns.
            const uploadToLocator = async (loc: Locator) => {
              const tagName = await loc.evaluate((el: any) => el.tagName?.toLowerCase()).catch(() => '');
              const elType = await loc.evaluate((el: any) => el.type?.toLowerCase()).catch(() => '');
              const isFileInput = tagName === 'input' && elType === 'file';

              if (isFileInput) {
                await loc.waitFor({ state: 'attached', timeout: timeout || 10000 });
                await loc.setInputFiles(localFilePath, { timeout: timeout || 30000 });
                return;
              }

              // Trigger-button pattern: find nearby hidden file input or use fileChooser
              // Searches children, open shadow DOM, parent containers (3 levels), label[for]
              const nearbyFileInput = await loc.evaluate((el: any) => {
                const findFileInput = (root: any): boolean => {
                  if (!root) return false;
                  if (root.querySelector?.('input[type="file"]')) return true;
                  const children = root.querySelectorAll?.('*') || [];
                  for (const child of children) {
                    if (child.shadowRoot?.querySelector('input[type="file"]')) return true;
                  }
                  return false;
                };
                if (findFileInput(el)) return true;
                if (el.shadowRoot && findFileInput(el.shadowRoot)) return true;
                let parent = el.parentElement;
                for (let i = 0; i < 3 && parent; i++) {
                  if (findFileInput(parent)) return true;
                  parent = parent.parentElement;
                }
                if (el.tagName === 'LABEL' && el.htmlFor) {
                  const target = el.ownerDocument.getElementById(el.htmlFor);
                  if (target?.type === 'file') return true;
                }
                return false;
              }).catch(() => false);

              if (nearbyFileInput) {
                // Find the hidden file input via Playwright locator (pierces open shadow DOM)
                const fileInputLoc = await (async () => {
                  const child = loc.locator('input[type="file"]');
                  if (await child.count() > 0) return child.first();
                  for (let i = 1; i <= 3; i++) {
                    const ancestor = loc.locator(`xpath=${'..'.concat('/..'.repeat(i - 1))}`);
                    const inp = ancestor.locator('input[type="file"]');
                    if (await inp.count() > 0) return inp.first();
                  }
                  // No page-level fallback — too risky with multiple file inputs
                  return null;
                })();

                if (fileInputLoc) {
                  await fileInputLoc.waitFor({ state: 'attached', timeout: timeout || 10000 });
                  await fileInputLoc.setInputFiles(localFilePath, { timeout: timeout || 30000 });
                } else {
                  // Nearby input found in evaluate but not reachable via locator
                  await uploadViaFileChooserOrDrop(
                    this.page, loc, localFilePath,
                    downloadResult?.filename || '', downloadResult?.contentType,
                    timeout || 30000,
                  );
                }
              } else {
                // No hidden file input found — fileChooser interception + drag-drop fallback
                await uploadViaFileChooserOrDrop(
                  this.page, loc, localFilePath,
                  downloadResult?.filename || '', downloadResult?.contentType,
                  timeout || 30000,
                );
              }
            };

            // Intent-based locator resolution
            if (isIntentCommand && intentCommand.intentMeta) {
              const { locator: intentLocator } = await this.getLocatorForIntentCommand(
                intentCommand,
                'upload',
                timeout || 30000
              );
              await uploadToLocator(intentLocator);
            } else {
              // Standard selector-based flow
              if (!selector) throw new Error('Selector is required for upload action');

              const uploadSmartResult = await getSmartLocator(
                this.page,
                selector,
                'upload',
                description
              );

              try {
                await uploadToLocator(uploadSmartResult.locator);
              } catch (uploadError) {
                logger.warn('[COMMAND_EXECUTOR] Smart locator upload failed, trying self-healing', {
                  selector: selector.substring(0, 50),
                  error: uploadError instanceof Error ? uploadError.message : String(uploadError),
                });

                await this.executeWithSelfHealing(
                  async () => {
                    const loc = getLocator(this.page, selector);
                    await uploadToLocator(loc);
                  },
                  {
                    selector,
                    intent: description || 'upload file',
                    action: 'upload',
                    timeout,
                    value: localFilePath,
                  }
                );
              }
            }

            // Step 3: Store env var if requested
            if (command.upload.envVar) {
              this.extractedData.set(command.upload.envVar, localFilePath);
              logger.debug('[COMMAND_EXECUTOR] Upload file path stored in env var', {
                envVar: command.upload.envVar,
                localFilePath,
              });
            }

            // Step 4: Schedule temp file cleanup (deferred to let Playwright finish reading)
            if (downloadResult) {
              const tempPath = downloadResult.localPath;
              setTimeout(() => {
                cleanupUploadTempFile(tempPath).catch(() => {});
              }, 10_000);
            }
          } catch (error) {
            // Record failure in runtime meta for intent commands
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'failed',
                source: 'resolver',
                confidenceTier: 'low',
                failedReason: 'unknown',
                failureExplanation: error instanceof Error ? error.message : String(error),
              });
            }
            throw error;
          }

          break;
        }

        // ═══════════════════════════════════════════════════════════════
        // V12: WAIT FOR EMAIL (IMAP polling + AI extraction)
        // ═══════════════════════════════════════════════════════════════
        case 'waitForEmail': {
          logger.info('[COMMAND_EXECUTOR] Executing waitForEmail', {
            stepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
          });

          if (!isIntentCommand) {
            throw new Error('waitForEmail requires intent command with intentMeta');
          }

          const emailFilter = intentCommand.intentMeta?.emailFilter;
          if (!emailFilter?.extractPrompt || !emailFilter?.extractVariable) {
            throw new Error('waitForEmail requires intentMeta.emailFilter with extractPrompt and extractVariable');
          }

          try {
            const { EmailInboxService } = await import('@/services/testing/email-inbox/email-inbox.service');

            if (!EmailInboxService.isConfigured()) {
              throw new Error('Email inbox not configured. Set IMAP_USER and IMAP_PASSWORD.');
            }

            // Generate inbox address using step ID for uniqueness
            const testRunId = intentCommand.intentMeta?.stepId || `run-${Date.now()}`;
            const recipient = EmailInboxService.generateAddress(testRunId);

            const timeoutMs = intentCommand.intentMeta?.emailTimeoutMs ?? 60_000;

            const extractionResult = await EmailInboxService.waitForEmail({
              recipient,
              filter: {
                subject: emailFilter.subject,
                from: emailFilter.from,
              },
              extractPrompt: emailFilter.extractPrompt,
              extractVariable: emailFilter.extractVariable,
              timeoutMs,
            });

            // Store extracted value for subsequent step interpolation
            if (extractionResult.value) {
              this.extractedData.set(`email.${emailFilter.extractVariable}`, extractionResult.value);
            }

            // Record success in runtime meta
            if (intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: extractionResult.value ? 'executed' : 'failed',
                source: 'resolver',
                confidenceTier: extractionResult.confidence >= 0.85 ? 'high' :
                                extractionResult.confidence >= 0.6 ? 'medium' : 'low',
                failedReason: extractionResult.value ? undefined : 'unknown',
                failureExplanation: extractionResult.value ? undefined : extractionResult.reasoning,
              });
            }

            if (!extractionResult.value) {
              throw new Error(`Email extraction returned empty value: ${extractionResult.reasoning}`);
            }

            logger.info('[COMMAND_EXECUTOR] waitForEmail succeeded', {
              extractVariable: emailFilter.extractVariable,
              valueLength: extractionResult.value.length,
              confidence: extractionResult.confidence,
            });
          } catch (error) {
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'failed',
                source: 'resolver',
                confidenceTier: 'low',
                failedReason: 'unknown',
                failureExplanation: error instanceof Error ? error.message : String(error),
              });
            }
            throw error;
          }

          break;
        }

        // V14: Context menu (right-click)
        case 'contextmenu': {
          const performRightClick = async (locator: Locator) => {
            await this.forceScrollIntoView(locator);
            // V15.5: skip stability wait (see noWaitAfter comment above)
            await locator.click({ button: 'right', timeout: timeout || 30000, noWaitAfter: true });
          };

          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 30000
            );
            await performRightClick(intentLocator);
            break;
          }

          if (!selector) throw new Error('Selector is required for contextmenu action');
          const ctxLocator = getLocator(this.page, selector);
          await performRightClick(ctxLocator);
          break;
        }

        // V14: Drag & Drop (coordinate-based from recording, or selector-based)
        case 'dragAndDrop': {
          const dragCoords = parseDragCoordinates(value);

          if (dragCoords) {
            await executeCoordinateDrag(this.page, dragCoords);
          } else if (isIntentCommand && intentCommand.intentMeta) {
            // Intent-based: resolve source element, use dropTarget or value as target
            const { locator: srcLocator } = await this.getLocatorForIntentCommand(
              intentCommand, 'click', timeout || 30000
            );
            const targetSel = command.dropTarget || String(value || '');
            if (!targetSel) throw new Error('dragAndDrop requires coordinate data or a target selector');
            const tgtLocator = this.getLocatorInternal(targetSel);
            await srcLocator.dragTo(tgtLocator, { timeout: timeout || 30000 });
          } else {
            // Pipeline-generated: selector-based
            if (!selector) throw new Error('Source selector is required for dragAndDrop action');
            if (!value) throw new Error('Target selector is required for dragAndDrop action');
            const dSrc = this.getLocatorInternal(selector);
            const dTgt = this.getLocatorInternal(this.prepareSelector(String(value)) || String(value));
            await dSrc.dragTo(dTgt, { timeout: timeout || 30000 });
          }
          break;
        }

        // V18: Multi-tab switch. Identity-first, index-fallback.
        //
        // The recorded step carries BOTH the tab index (`value`) and the URL of
        // the tab it switched to (`evidence.pageUrl`, stamped when the recorder
        // auto-emits switch_tab — see preview.handler.ts). Replaying by raw index
        // is fragile: if the runtime tab order/count diverges from record time
        // (an ad/tracking popup opened an extra tab, or a tab didn't open) index
        // N points at the WRONG page and every subsequent step runs in it.
        //
        // So we MATCH BY URL first (exact → origin+path → origin), and only fall
        // back to the index when there's no recorded URL or no tab matches it.
        // This makes multi-tab regression robust against unplanned popups while
        // staying backward-compatible with legacy steps that only have an index.
        case 'switchTab': {
          const targetTabIndex = parseInt(String(value || '0'), 10);
          const recordedUrl = intentCommand.intentMeta?.evidence?.pageUrl;

          // normalize for comparison — strip trailing slash + hash; lower-case host
          const norm = (u: string): { origin: string; originPath: string; full: string } | null => {
            try {
              const p = new URL(u);
              // Only real navigations count. about:blank / data: / chrome: all
              // collapse to an EMPTY host, so without this every such tab would
              // false-match any other on the bare-origin tier ("data://" ===
              // "data://") and switchTab would silently pick the wrong page.
              if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
              const host = p.host.toLowerCase();
              const path = p.pathname.replace(/\/$/, '') || '/';
              return { origin: `${p.protocol}//${host}`, originPath: `${p.protocol}//${host}${path}`, full: `${p.protocol}//${host}${path}${p.search}` };
            } catch { return null; }
          };

          // Wait up to 5s for the expected tab to exist (popup may still open).
          // The wait condition is "a URL match exists" when we have a recorded
          // URL, otherwise "the index is in range" (legacy behaviour).
          const want = recordedUrl ? norm(recordedUrl) : null;
          const findByUrl = (): Page | null => {
            if (!want) return null;
            const pages = this.page.context().pages();
            // exact full → origin+path, first match wins. Bare-origin is
            // intentionally NOT a tier: two tabs of the same app share an origin
            // but differ by path, so an origin-only match would grab the wrong
            // same-origin tab. If neither path-bearing tier matches we fall back
            // to index rather than guess. (Contrast hrefMatchesUrl in the newtab
            // path, which DOES allow origin — there a same-origin redirect is
            // still the clicked link's own destination.)
            for (const tier of ['full', 'originPath'] as const) {
              const hit = pages.find((pg) => { const n = norm(pg.url()); return n && n[tier] === want[tier]; });
              if (hit) return hit;
            }
            return null;
          };

          let targetPage: Page | null = findByUrl();
          if (!targetPage) {
            // No URL match yet (or no recorded URL) — wait for either a URL match
            // or the index to come into range, then resolve.
            for (let w = 0; w < 10 && !targetPage; w++) {
              await new Promise(r => setTimeout(r, 500));
              targetPage = findByUrl();
              if (!targetPage) {
                const current = this.page.context().pages();
                if (!want && targetTabIndex >= 0 && targetTabIndex < current.length) {
                  targetPage = current[targetTabIndex];
                }
              }
            }
          }

          // Final fallback: index (covers legacy/no-URL and "URL never appeared").
          if (!targetPage) {
            const pages = this.page.context().pages();
            if (targetTabIndex >= 0 && targetTabIndex < pages.length) {
              targetPage = pages[targetTabIndex];
              if (want) {
                logger.warn('[COMMAND_EXECUTOR] switchTab URL not found, fell back to index', {
                  recordedUrl, targetTabIndex, totalPages: pages.length,
                });
              }
            }
          }

          if (!targetPage) {
            throw new Error(`Tab not available (index=${targetTabIndex}, recordedUrl=${recordedUrl || 'none'}, ${this.page.context().pages().length} tabs open)`);
          }

          // Wait for page to be ready before switching
          try { await targetPage.waitForLoadState('load', { timeout: 10_000 }); } catch {
            try { await targetPage.waitForLoadState('domcontentloaded', { timeout: 3_000 }); } catch { /* proceed */ }
          }
          this.page = targetPage;
          logger.info('[COMMAND_EXECUTOR] Switched to tab', {
            matchedBy: want && findByUrl() === targetPage ? 'url' : 'index',
            targetTabIndex, recordedUrl: recordedUrl || undefined, url: targetPage.url(),
          });
          break;
        }

        // Multi-tab close — symmetric replay of a recording-time × click.
        // Soft-success: if the tab is already gone (popup auto-closed, never
        // opened on this run because an earlier step diverged) the user's
        // intent "this tab should not exist" is already true. We don't fail
        // the step. Hard-fail only when Playwright itself refuses to close
        // (e.g. attempting to close the very last page in the context).
        //
        // Deliberately index-based (NOT URL-matched like switchTab): closing
        // the wrong tab is self-healing here (soft no-op when out of range),
        // whereas URL-matching could close a legitimately-still-open tab that
        // happens to share a URL. switchTab needs URL identity because picking
        // the wrong tab silently redirects EVERY later step; closeTab doesn't.
        case 'closeTab': {
          const targetTabIndex = parseInt(String(value || '0'), 10);
          const pages = this.page.context().pages();
          if (targetTabIndex < 0 || targetTabIndex >= pages.length) {
            logger.info('[COMMAND_EXECUTOR] closeTab no-op — target tab not present', {
              targetTabIndex,
              totalPages: pages.length,
            });
            break;
          }
          if (pages.length <= 1) {
            throw new Error(
              `closeTab refused — cannot close the last remaining tab (target=${targetTabIndex})`,
            );
          }
          const targetPage = pages[targetTabIndex];
          const wasActive = targetPage === this.page;
          try { await targetPage.close(); } catch { /* page may already be closing */ }
          // If we closed the page we were operating on, swap `this.page` to
          // the nearest survivor — same rule as PreviewSessionService.closeTab.
          if (wasActive) {
            const remaining = this.page.context().pages();
            const nextIdx = Math.min(targetTabIndex, remaining.length - 1);
            this.page = remaining[Math.max(0, nextIdx)];
          }
          logger.info('[COMMAND_EXECUTOR] Closed tab', {
            targetTabIndex,
            wasActive,
            remainingPages: this.page.context().pages().length,
          });
          break;
        }

        // Multi-tab open — create a new page in the context, navigate it to
        // `value` (URL), and make it the active page so subsequent steps target
        // it. Mirrors live-preview `open_tab` (PreviewSessionService.openTab).
        case 'openTab': {
          const url = String(value || '').trim();
          if (!url) {
            throw new Error('openTab requires a URL in value');
          }
          const ctx = this.page.context();
          const newPage = await ctx.newPage();
          try {
            await newPage.goto(url, { waitUntil: 'load', timeout: timeout || 30000 });
          } catch {
            // Page is committed even if subresources stalled — fall back to a
            // short domcontentloaded wait rather than failing the whole step.
            try { await newPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }); } catch { /* proceed */ }
          }
          this.page = newPage;
          logger.info('[COMMAND_EXECUTOR] Opened new tab', {
            url,
            totalPages: ctx.pages().length,
          });
          break;
        }

        // V18: Scratchpad — store key-value for cross-step memory (no browser action)
        case 'store': {
          const storeKey = description?.trim() || '';
          const storeValue = value || '';
          if (storeKey) {
            this.extractedData.set(storeKey, storeValue);
            logger.debug('[COMMAND_EXECUTOR] Stored scratchpad value', { key: storeKey, value: storeValue?.toString().slice(0, 50) });
          }
          break;
        }

        // V18: Coordinate-based click (canvas, maps, charts — no element selector)
        case 'clickAt': {
          // `value` is a JSON-stringified {x, y}. Wrapping JSON.parse in
          // try/catch so a user-typed garbage value (e.g. "500, 300" with a
          // space — not valid JSON) produces an actionable error rather
          // than a cryptic SyntaxError bubbling out of the executor.
          let coords: { x?: unknown; y?: unknown } | null = null;
          try {
            coords = value ? JSON.parse(String(value)) : null;
          } catch (parseErr) {
            throw new Error(
              `clickAt: value must be JSON {x, y} — got "${String(value).slice(0, 60)}" (${parseErr instanceof Error ? parseErr.message : 'parse error'})`,
            );
          }
          if (!coords || !Number.isFinite(coords.x) || !Number.isFinite(coords.y)) {
            throw new Error('clickAt requires {x, y} coordinates in value');
          }
          await this.page.mouse.click(coords.x as number, coords.y as number);
          break;
        }

        // V18: Swipe gesture (mobile web — mouse drag simulation)
        case 'swipe': {
          let swipeData: any = null;
          try {
            swipeData = value ? JSON.parse(String(value)) : null;
          } catch (parseErr) {
            throw new Error(
              `swipe: value must be JSON {start:{x,y}, end:{x,y}} — got "${String(value).slice(0, 60)}" (${parseErr instanceof Error ? parseErr.message : 'parse error'})`,
            );
          }
          if (!swipeData || !swipeData.start || !swipeData.end) {
            throw new Error('swipe requires {start: {x,y}, end: {x,y}} in value');
          }
          const duration = swipeData.durationMs || 300;
          await this.page.mouse.move(swipeData.start.x, swipeData.start.y);
          await this.page.mouse.down();
          // Simulate gradual swipe with intermediate points
          const steps = Math.max(5, Math.round(duration / 50));
          for (let s = 1; s <= steps; s++) {
            const ratio = s / steps;
            const mx = swipeData.start.x + (swipeData.end.x - swipeData.start.x) * ratio;
            const my = swipeData.start.y + (swipeData.end.y - swipeData.start.y) * ratio;
            await this.page.mouse.move(mx, my);
            await new Promise(r => setTimeout(r, duration / steps));
          }
          await this.page.mouse.up();
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // Take screenshot if requested (but not if already took one)
      if (command.screenshot && action !== 'screenshot' as PlaywrightActionType) {
        const screenshot = await this.page.screenshot({ type: 'png', fullPage: false });
        return {
          success: true,
          screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
          runtimeMeta: isIntentCommand ? this.stepRuntimeMeta.get(intentCommand.intentMeta?.stepId || '') : undefined,
        };
      }

      // V16: Post-action settle delegated to smartStepWait('post').
      //
      // Replaces the V15.7 hardcoded 1s buffer. smartStepWait runs the
      // per-action-type plan (dom-settle + loading-clear + optional
      // spa-nav-detect / challenge-clear) with fast-path skips when the
      // page is already quiet, so well-behaved sites pay less than 1s.
      // Only mutating actions go through it; read-only (assert/wait/getText)
      // skip the call entirely to stay fast.
      const intentType = playwrightActionToIntent(action);
      // Honour step.options.disableStabilityChecks (see
      // ./step-options/* for the field family). Mirrors
      // preview-step-apply.service.ts:2451.
      const stabilityDisabled = isIntentCommand
        && intentCommand.intentMeta?.disableStabilityChecks === true;
      if (intentType !== null && !stabilityDisabled) {
        try {
          await smartStepWait({
            page: this.page,
            step: buildPostStep(intentType, intentCommand),
            // locator intentionally undefined: the element has already been
            // acted upon; post-phases that need one (animation-done on the
            // target, state-reflected) will skip via requiresLocator.
            phase: 'post',
          });
        } catch {
          // Non-fatal — page may be navigating.
        }
      }

      // ✅ V2: Include runtime metadata for intent-based commands
      const runtimeMeta = isIntentCommand
        ? this.stepRuntimeMeta.get(intentCommand.intentMeta?.stepId || '')
        : undefined;

      // Record this successful step's DESCRIPTION (never its value/secrets) into
      // the journey buffer so a LATER step's heal can see "what was done before".
      const stepDesc = intentCommand.intentMeta?.intentDescription;
      if (stepDesc) {
        this.recentStepDescriptions.push(stepDesc.slice(0, 80));
        if (this.recentStepDescriptions.length > CommandExecutor.RECENT_STEPS_WINDOW) {
          this.recentStepDescriptions.shift();
        }
      }

      return { success: true, runtimeMeta };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // ✅ FIX: Enhanced error logging with full context
      logger.error(`[COMMAND_EXECUTOR] Command execution failed: ${action}`, {
        action,
        selector,
        value: value ? String(value).substring(0, 100) : undefined,
        url,
        timeout,
        description,
        currentUrl: this.page.url(),
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
        intentStepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
      });

      if (continueOnError) {
        logger.warn(`Continuing despite error due to continueOnError flag`);
        const runtimeMeta = isIntentCommand
          ? this.stepRuntimeMeta.get(intentCommand.intentMeta?.stepId || '')
          : undefined;
        return { success: false, error: errorMessage, runtimeMeta };
      }

      throw error;
    }
  }

  /**
   * Execute multiple commands in sequence
   * V6: Includes lookahead wait between commands for inter-step stability
   */
  async executeCommands(commands: PlaywrightCommand[]): Promise<{
    success: boolean;
    results: Array<{ command: PlaywrightCommand; result: any }>;
    errors: Array<{ command: PlaywrightCommand; error: string }>;
  }> {
    const results: Array<{ command: PlaywrightCommand; result: any }> = [];
    const errors: Array<{ command: PlaywrightCommand; error: string }> = [];

    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];

      // V10: Track current command index and list for Enter-key double-press prevention
      this.currentCommandIndex = index;
      this.currentCommandsList = commands;

      // Capture URL before executing — used by lookahead to detect SPA navigation
      const urlBeforeStep = this.page.url();

      try {
        const result = await this.executeCommand(command);
        results.push({ command, result });

        if (!result.success && !command.continueOnError) {
          throw new Error(result.error || 'Command failed');
        }

        // ─────────────────────────────────────────────────────────────────────
        // Lookahead wait: check next command's element readiness before executing
        // Uses fast Playwright checks only (no AI/LLM).
        // Passes prevActionType + prevUrl so the service can:
        //   1. Detect SPA navigation (URL changed after click/open/close/toggle)
        //   2. Calibrate DOM stability threshold dynamically
        //   3. Apply blind settle when no locator is available
        // ─────────────────────────────────────────────────────────────────────
        if (result.success && index < commands.length - 1) {
          const nextCommand = commands[index + 1];
          const intentCommand = command as IntentPlaywrightCommand;
          const nextIntentCommand = nextCommand as IntentPlaywrightCommand;

          // Only apply lookahead if both commands are intent-based (have intentMeta)
          if (intentCommand.intentMeta && nextIntentCommand.intentMeta) {
            const prevActionType = intentCommand.intentMeta.actionType as any;

            // Skip lookahead only for truly non-targeting prev actions (navigate/wait/ai_check)
            if (!shouldSkipLookaheadAfter(prevActionType)) {
              // Build IntentStep-like object for lookahead
              const nextStepForLookahead: IntentStep = {
                id: nextIntentCommand.intentMeta.stepId || `cmd-${index + 1}`,
                type: nextIntentCommand.intentMeta.actionType as any,
                description: nextIntentCommand.description || '',
                compiled: nextIntentCommand.intentMeta.compiled,
                evidence: nextIntentCommand.intentMeta.evidence,
                options: {
                  disableLookaheadWait: nextIntentCommand.intentMeta.disableLookaheadWait,
                },
              };

              try {
                const lookahead: LookaheadResult = await runV1WithShadow(
                  () => waitForStepReadiness(
                    this.page,
                    nextStepForLookahead,
                    {
                      maxWaitMs: 10000,
                      settleMs: 3000,
                      autoWaitThresholdMs: 2000,
                      prevActionType,
                      prevUrl: urlBeforeStep,
                    }
                  ),
                  this.page,
                  nextStepForLookahead,
                  {
                    maxWaitMs: STEP_READINESS_CONFIG.v2.backgroundMaxWaitMs,
                    prevActionType,
                    prevUrl: urlBeforeStep,
                  },
                );

                // Update runtime meta if significant wait occurred
                if (lookahead.autoWaitApplied && nextIntentCommand.intentMeta.stepId) {
                  const existingMeta = this.stepRuntimeMeta.get(nextIntentCommand.intentMeta.stepId);
                  this.stepRuntimeMeta.set(nextIntentCommand.intentMeta.stepId, {
                    ...existingMeta,
                    runtimeStatus: existingMeta?.runtimeStatus || 'executed',
                    source: existingMeta?.source || 'resolver',
                    confidenceTier: existingMeta?.confidenceTier || 'medium',
                    autoWaitApplied: true,
                    autoWaitMs: lookahead.waited,
                  } as StepRuntimeMeta & { autoWaitApplied?: boolean; autoWaitMs?: number });

                  logger.info('[COMMAND_EXECUTOR] Lookahead auto-wait applied', {
                    currentIndex: index,
                    nextStepId: nextIntentCommand.intentMeta.stepId,
                    waitedMs: lookahead.waited,
                    navigationDetected: lookahead.navigationDetected,
                  });
                } else if (lookahead.skipReason) {
                  logger.debug('[COMMAND_EXECUTOR] Lookahead skipped', {
                    nextStepId: nextIntentCommand.intentMeta.stepId,
                    reason: lookahead.skipReason,
                  });
                }
              } catch (lookaheadError) {
                // Lookahead failure is non-fatal, log and continue
                logger.warn('[COMMAND_EXECUTOR] Lookahead wait failed, continuing', {
                  nextIndex: index + 1,
                  error: lookaheadError instanceof Error ? lookaheadError.message : String(lookaheadError),
                });
              }
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // ── LLM Blocker Diagnosis: diagnose + wait + final retry ──
        // Only for intent-based commands (have step context for diagnosis)
        const intentCmd = command as IntentPlaywrightCommand;
        if (!command.continueOnError && intentCmd.intentMeta) {
          try {
            const diagStep: IntentStep = {
              id: intentCmd.intentMeta.stepId || `cmd-${index}`,
              type: intentCmd.intentMeta.actionType as any,
              description: command.description || '',
              bindingHints: intentCmd.intentMeta.bindingHints,
              compiled: intentCmd.intentMeta.compiled,
            };

            const diagnosis = await diagnoseStepBlocker(this.page, diagStep, errorMessage);

            if (diagnosis && diagnosis.shouldRetry) {
              logger.info('[COMMAND_EXECUTOR] LLM diagnosis suggests retry', {
                index, action: command.action, blocker: diagnosis.blocker,
                confidence: diagnosis.confidence,
              });

              await actOnDiagnosis(this.page, diagnosis);
              const retryResult = await this.executeCommand(command);

              if (retryResult.success) {
                logger.info('[COMMAND_EXECUTOR] LLM-guided retry succeeded', {
                  index, action: command.action, blocker: diagnosis.blocker,
                });
                results.push({ command, result: retryResult });
                continue; // Recovered — proceed to next command
              }
            }
          } catch (diagError) {
            logger.warn('[COMMAND_EXECUTOR] LLM diagnosis failed', {
              index, error: diagError instanceof Error ? diagError.message : String(diagError),
            });
          }
        }

        errors.push({ command, error: errorMessage });

        if (!command.continueOnError) {
          logger.error('[COMMAND_EXECUTOR] Command execution stopped due to error', {
            command: {
              action: command.action,
              selector: command.selector,
              description: command.description,
              index: index,
            },
            totalCommands: commands.length,
            currentUrl: this.page.url(),
            error: error instanceof Error ? {
              message: error.message,
              name: error.name,
              stack: error.stack,
            } : String(error),
          });
          break;
        }
      }
    }

    const success = errors.length === 0;
    logger.info(`Executed ${commands.length} commands`, {
      successful: results.length,
      failed: errors.length,
    });

    return { success, results, errors };
  }

  /**
   * ✅ REMOVED: assertVisible, assertText, assertValue methods
   * Now handled directly in executeCommand() using getLocator()
   */

  /**
   * Assert URL
   */
  private async assertUrl(assertion: PlaywrightCommand['assertion']): Promise<void> {
    if (!assertion) throw new Error('Assertion config is required');
    if (assertion.expected === undefined || assertion.expected === null) {
      throw new Error('URL assertion requires an expected value');
    }

    const actualUrl = this.page.url();
    const expectedUrl = String(assertion.expected);
    const operator = assertion.operator || 'contains';

    const passed = this.compareValues(actualUrl, expectedUrl, operator);

    if (!passed) {
      throw new Error(
        `URL assertion failed (operator: "${operator}"): expected "${expectedUrl}", got "${actualUrl}"`
      );
    }

    logger.info(`Assertion passed: URL matches`, { operator, expected: expectedUrl, actual: actualUrl });
  }

  /**
   * ✅ REMOVED: assertCount method
   * Now handled directly in executeCommand() using getLocator()
   */

  /**
   * Extract data from element using locator
   * Supports both traditional extraction and AI-powered extraction with JSON schema
   */
  private async extractDataWithLocator(
    locator: import('playwright').Locator,
    config: NonNullable<PlaywrightCommand['extract']>
  ): Promise<any> {
    // ✅ NEW: AI Extract with JSON schema
    if (config.useAI && config.schema) {
      logger.info('[COMMAND_EXECUTOR] Using AI extraction with schema', {
        mode: config.mode || 'auto',
        hasCostManager: !!this.costManager,
      });

      // ✅ IMPROVED: Get element HTML instead of passing empty selector
      // This gives AI more context for extraction
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      const elementHTML = await locator.evaluate((el: any) => el.outerHTML).catch(() => '');

      // ✅ FIX 9: Pass cost manager to AI extraction
      const result = await AIExtractService.extract(this.page, {
        selector: '', // Keep empty for page context
        schema: config.schema,
        mode: config.mode,
        instructions: config.instructions
          ? `${config.instructions}\n\nElement HTML: ${elementHTML.substring(0, 500)}`
          : `Extract from element: ${elementHTML.substring(0, 500)}`,
      }, this.costManager); // ✅ FIX 9: Pass cost manager

      if (!result.success) {
        throw new Error(`AI extraction failed: ${result.error}`);
      }

      logger.info('[COMMAND_EXECUTOR] AI extraction successful', {
        confidence: result.confidence,
        tokensUsed: result.metadata.tokensUsed,
      });

      return result.data;
    }

    // Traditional extraction (backwards compatible)
    await locator.waitFor({ state: 'visible', timeout: 5000 });

    if (config.attribute) {
      return await locator.getAttribute(config.attribute);
    }

    if (config.property === 'text') {
      return await locator.textContent();
    }

    if (config.property === 'value') {
      return await locator.inputValue();
    }

    if (config.property === 'innerHTML') {
      return await locator.innerHTML();
    }

    return await locator.textContent();
  }

  /**
   * Compare values based on operator.
   *
   * For 'matches' / 'regex': supports /pattern/flags syntax.
   *   "foo\d+"     → case-insensitive by default
   *   "/foo\d+/i"  → explicit flags, wins over default
   *   "/foo\d+/s"  → dotAll flag, matches newlines too
   */
  private compareValues(actual: any, expected: any, operator: string = '='): boolean {
    switch (operator) {
      case '=':
        return String(actual) === String(expected);
      case '!=':
        return String(actual) !== String(expected);
      case '>':
        return Number(actual) > Number(expected);
      case '<':
        return Number(actual) < Number(expected);
      case '>=':
        return Number(actual) >= Number(expected);
      case '<=':
        return Number(actual) <= Number(expected);
      case 'contains':
        return String(actual).toLowerCase().includes(String(expected).toLowerCase());
      case 'startsWith':
        return String(actual).toLowerCase().startsWith(String(expected).toLowerCase());
      case 'endsWith':
        return String(actual).toLowerCase().endsWith(String(expected).toLowerCase());
      case 'matches':
      case 'regex': {
        // Supports /pattern/flags syntax; default: case-insensitive
        const { pattern, flags } = parseRegexString(String(expected), /* caseSensitive= */ false);
        try {
          return new RegExp(pattern, flags).test(String(actual));
        } catch {
          return false;
        }
      }
      case 'glob':
        // URL-aware glob: * [^/]*, ** .*, ? heuristic, no wildcards → substring
        return matchGlob(String(actual), String(expected), { caseSensitive: false });
      default:
        return actual === expected;
    }
  }

  /**
   * ✅ FIX 5: Parse selectOption value to support multiple formats
   * Supports: string, array, JSON object { value/label/index }
   */
  private parseSelectValue(value: any): string | string[] | { value?: string; label?: string; index?: number } {
    if (Array.isArray(value)) {
      return value.map(v => String(v));
    }

    const strValue = String(value);

    // Try to parse as JSON (object or array)
    if (strValue.startsWith('{') || strValue.startsWith('[')) {
      try {
        return JSON.parse(strValue);
      } catch {
        // Not valid JSON, treat as string
      }
    }

    // Check for comma-separated values (e.g., "option1,option2")
    // Only split if there are no spaces adjacent to commas (avoids "First Last, Second Last" splitting incorrectly)
    // and the value is not a quoted string
    if (strValue.includes(',') && !strValue.includes('"') && !strValue.includes("'")) {
      const parts = strValue.split(',').map(v => v.trim()).filter(Boolean);
      // If every part looks like a simple token (no inner whitespace), treat as multi-select
      if (parts.every(p => !/\s/.test(p))) {
        return parts;
      }
    }

    return strValue;
  }

  /**
   * V3: Convert CDP accessibility tree to our PreviewAccessibilityNode format
   * Simplified converter for ai_check runtime execution
   */
  private convertCdpA11yTree(nodes: any[]): any[] {
    if (!nodes || nodes.length === 0) return [];

    const result: any[] = [];
    const maxNodes = 500;
    let nodeCount = 0;

    const convertNode = (node: any): any | null => {
      if (nodeCount >= maxNodes) return null;
      if (!node.role || node.role.value === 'none' || node.role.value === 'ignored') return null;

      nodeCount++;

      const converted: any = {
        role: node.role?.value || 'unknown',
      };

      if (node.name?.value) converted.name = node.name.value;
      if (node.value?.value) converted.value = node.value.value;
      if (node.description?.value) converted.description = node.description.value;

      if (node.childIds && node.childIds.length > 0) {
        const children: any[] = [];
        for (const childId of node.childIds) {
          const childNode = nodes.find((n: any) => n.nodeId === childId);
          if (childNode) {
            const convertedChild = convertNode(childNode);
            if (convertedChild) children.push(convertedChild);
          }
        }
        if (children.length > 0) converted.children = children;
      }

      return converted;
    };

    // Find root nodes (nodes without parents)
    const rootNodes = nodes.filter((node: any) => {
      const hasParent = nodes.some((n: any) => n.childIds?.includes(node.nodeId));
      return !hasParent;
    });

    for (const rootNode of rootNodes) {
      const converted = convertNode(rootNode);
      if (converted) result.push(converted);
      if (nodeCount >= maxNodes) break;
    }

    return result;
  }

  /**
   * Get extracted data (cross-step scratchpad)
   */
  getExtractedData(): Map<string, any> {
    return this.extractedData;
  }

  /**
   * Set extracted data from external callers (e.g., auto-populate from step results).
   * Used by test-executor.ts to store values for cross-step interpolation.
   */
  setExtractedData(key: string, value: any): void {
    if (key && value != null) {
      this.extractedData.set(key, value);
    }
  }

  /**
   * Phase 2: register the workspace `runVariables` Map so log lines that
   * happen to embed an interpolated `{{secrets.X}}` value get masked
   * before they hit logger / WebSocket / trace files.
   *
   * Called once per run from test-executor after `applyBindingsToContext`.
   * Idempotent — passing `undefined` resets the cache. Cheap on the
   * no-secrets case: `collectSecretValues` returns [] and `redactInLogs`
   * short-circuits.
   */
  setRunVariables(runVariables: Map<string, unknown> | null | undefined): void {
    this.redactValues = collectSecretValues(runVariables);
  }

  /**
   * Apply secret-value redaction to any string we're about to log.
   * Use this when an interpolated step body (value / url / assertionText)
   * is being logged in plaintext — the resolver may have substituted a
   * `{{secrets.X}}` value before this point. No-op when no secrets
   * are registered.
   */
  private redactInLogs<T>(value: T): T {
    if (typeof value !== 'string' || this.redactValues.length === 0) return value;
    return redactWithValues(value, this.redactValues) as unknown as T;
  }

  /**
   * Public form of `redactInLogs` for callers that hold an executor
   * reference and want to redact arbitrary strings (e.g. test-executor
   * builds `replayTrace.write(...)` payloads outside this class but
   * needs the same secret-value list). Empty list / non-string input
   * fast-paths to identity.
   */
  redactString(value: string): string {
    if (typeof value !== 'string' || this.redactValues.length === 0) return value;
    return redactWithValues(value, this.redactValues);
  }

  /**
   * Read-only view of the secret values list for callers that want to
   * pass the array onwards (e.g. ReplayTraceWriter could redact at
   * write-time given a pre-built list). Returns the same array
   * reference each call — do not mutate.
   */
  getRedactValues(): readonly string[] {
    return this.redactValues;
  }

  /**
   * Phase 2.5 — redact known string fields on a `StepRuntimeMeta` value
   * before it goes out via `webSocketService.emitTestStepCompleted`.
   * The fields covered are the ones that historically embed the
   * interpolated value:
   *   - `failureExplanation` (LLM-generated; can quote step.value)
   *   - `healedFrom`, `healedTo`, `healWhatChanged` (raw selector or
   *     synthesised text strings, sometimes quoting fill values)
   * Anything else (numeric metrics, booleans, nested arrays of network
   * evidence) is preserved as-is. Returns the same reference when no
   * secrets are registered (cheap fast path).
   */
  redactRuntimeMeta<T extends Record<string, unknown>>(meta: T | undefined): T | undefined {
    if (!meta) return meta;
    if (this.redactValues.length === 0) return meta;
    const FIELDS = ['failureExplanation', 'healedFrom', 'healedTo', 'healWhatChanged'] as const;
    let cloned: T | undefined;
    for (const f of FIELDS) {
      const v = (meta as Record<string, unknown>)[f];
      if (typeof v !== 'string') continue;
      const r = redactWithValues(v, this.redactValues);
      if (r === v) continue;
      if (!cloned) cloned = { ...meta };
      (cloned as Record<string, unknown>)[f] = r;
    }
    // link_test_case output capture (extractedDataSnapshot) — the FULL
    // per-run scratchpad, which can legitimately hold a resolved
    // {{secrets.*}} value written via a `store`/`extract` step (that's
    // exactly what makes it useful as a link_test_case output binding).
    // Redact every VALUE in the map (not just the fixed FIELDS above,
    // since keys are dynamic variable names) before it's persisted or
    // broadcast — Hard invariant #10.
    const snapshot = (meta as Record<string, unknown>).extractedDataSnapshot;
    if (snapshot && typeof snapshot === 'object') {
      const result = redactSnapshotValues(snapshot as Record<string, string>, this.redactValues);
      if (result) {
        if (!cloned) cloned = { ...meta };
        (cloned as Record<string, unknown>).extractedDataSnapshot = result.snapshot;
        // linked-test-case-runner.service.ts's readFinalVariables needs to
        // know WHICH keys were masked so an outputBinding sourcing a
        // redacted key can fail loudly instead of silently resolving to the
        // literal '***' mask as if it were the real value.
        (cloned as Record<string, unknown>).redactedSnapshotKeys = result.redactedKeys;
      }
    }
    return cloned ?? meta;
  }

  /**
   * Get runtime metadata for all executed steps
   * Useful for reporting and debugging intent-based test execution
   */
  getStepRuntimeMeta(): Map<string, StepRuntimeMeta> {
    return this.stepRuntimeMeta;
  }

  /**
   * Get runtime metadata for a specific step
   */
  getStepRuntimeMetaById(stepId: string): StepRuntimeMeta | undefined {
    return this.stepRuntimeMeta.get(stepId);
  }

  /**
   * V2: Persist healed compiled plan to DB after high-confidence heal
   * This updates the IntentTestCase so future runs use the new selector
   *
   * NOTE: Only updates locatorPlan and context, preserves existing action
   */
  private async persistHealedCompiled(params: {
    intentTestCaseId?: string;
    stepId: string;
    newSelector: string;
    healConfidence: number;
    pageUrl: string;
    existingCompiled?: CompiledStepPlan;
  }): Promise<void> {
    const { intentTestCaseId, stepId, newSelector, healConfidence, pageUrl, existingCompiled } = params;

    if (!intentTestCaseId) {
      logger.debug('[COMMAND_EXECUTOR] No intentTestCaseId, skipping heal persistence');
      return;
    }

    // Build new locator plan from healed selector
    // Add healed selector as primary, keep old selectors as fallback
    const healedEntry: LocatorEntry = {
      strategy: 'css',
      value: newSelector,
      confidence: healConfidence,
    };

    // Merge with existing locator plan (healed first, then old ones as fallback)
    const existingLocators = existingCompiled?.locatorPlan || [];
    const newLocatorPlan: LocatorEntry[] = [
      healedEntry,
      ...existingLocators.filter(e => e.value !== newSelector), // Avoid duplicates
    ];

    // Preserve existing action, update locators and context
    const newCompiled: CompiledStepPlan = {
      locatorPlan: newLocatorPlan,
      action: existingCompiled?.action || { type: 'click' },
      targetFingerprint: existingCompiled?.targetFingerprint, // Preserve fingerprint
      context: {
        ...existingCompiled?.context,
        pageUrl,
        compiledAt: new Date().toISOString(),
        pageSignature: undefined, // Clear signature - will be regenerated on next lint
      },
      meta: {
        compiledVersion: existingCompiled?.meta?.compiledVersion || '1.0.0',
        resolverVersion: '3.0.0-healed',
      },
    };

    const newEvidence = {
      lastSuccessSelector: newSelector,
      confidence: healConfidence,
      // V15.7: Timestamp so evidence TTL check can reject stale refs after
      // long gaps (page reload, server restart). Preview-step-apply also
      // writes this — here background stays in parity.
      capturedAt: new Date().toISOString(),
    };

    await IntentTestCaseService.updateStepAfterHeal({
      intentTestCaseId,
      stepId,
      compiled: newCompiled,
      evidence: newEvidence,
    });

    logger.info('[COMMAND_EXECUTOR] Persisted healed compiled to DB', {
      intentTestCaseId,
      stepId,
      healConfidence,
      locatorCount: newLocatorPlan.length,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPILED LOCATOR PLAN EXECUTION (for IntentStep-based commands)
  // ═══════════════════════════════════════════════════════════════════════════

  /** V2: Retry configuration for element resolution */
  private static readonly RETRY_CONFIG = {
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoffMultiplier: 1.5,
  };

  /**
   * V11: Check if all stages failed deterministically (zero candidates, no transient errors).
   * Used for fail-fast: if element truly doesn't exist, don't waste time retrying.
   */
  private allStagesDeterministicFail(ctx: RetryContext): boolean {
    const s = ctx.stageDeterministicFail;
    return s.compiled && s.resolver && s.smart && s.selfHeal;
  }

  /**
   * Get locator for an intent-based command with retry logic
   *
   * Priority order:
   * 1. compiled.locatorPlan (if present, not expired, signature matches)
   * 2. Smart locator from selector (if provided)
   * 3. Self-healing (if enabled and maxHealAttempts not exceeded)
   *
   * V2: Includes retry logic (2-3 attempts with backoff delay)
   *
   * Records runtime metadata for reporting.
   */
  private async getLocatorForIntentCommand(
    command: IntentPlaywrightCommand,
    actionType: string,
    timeout: number
  ): Promise<{
    locator: Locator;
    runtimeMeta: StepRuntimeMeta;
  }> {
    const { maxRetries, retryDelayMs, retryBackoffMultiplier } = CommandExecutor.RETRY_CONFIG;
    let lastError: Error | undefined;

    // V11: Shared retry context — accumulated state across attempts
    const retryCtx: RetryContext = {
      attempt: 0,
      stageDeterministicFail: { compiled: false, resolver: false, smart: false, selfHeal: false },
      healAttempts: 0,
      lastDomCollectionTs: 0,
      cachedDomNodes: null,
      totalCandidatesEver: 0,
    };

    // Graduated retry loop
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      retryCtx.attempt = attempt;

      if (attempt > 0) {
        // V11: FAIL-FAST — if zero candidates ever found and all stages failed deterministically, skip retries
        if (retryCtx.totalCandidatesEver === 0 && this.allStagesDeterministicFail(retryCtx)) {
          logger.info('[COMMAND_EXECUTOR] Fail-fast: all stages returned 0 candidates deterministically', {
            stepId: command.intentMeta?.stepId,
            attempt,
          });
          break; // Fall through to throw
        }

        // Wait before retry with exponential backoff
        const delay = retryDelayMs * Math.pow(retryBackoffMultiplier, attempt - 1);
        logger.info('[COMMAND_EXECUTOR] Retrying element resolution (graduated)', {
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          delayMs: Math.round(delay),
          skippedStages: Object.entries(retryCtx.stageDeterministicFail)
            .filter(([, v]) => v).map(([k]) => k),
        });
        await this.page.waitForTimeout(delay);
      }

      try {
        return await this.tryGetLocatorForIntentCommand(command, actionType, timeout, retryCtx);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn('[COMMAND_EXECUTOR] Element resolution attempt failed', {
          attempt: attempt + 1,
          error: lastError.message,
          totalCandidatesEver: retryCtx.totalCandidatesEver,
        });

        this.trace('element_resolution_retry', attempt + 1, {
          stepId: command.intentMeta?.stepId,
          attempt: attempt + 1,
          error: lastError.message,
          totalCandidatesEver: retryCtx.totalCandidatesEver,
          stageFails: { ...retryCtx.stageDeterministicFail },
        });
      }
    }

    // All retries failed
    throw lastError || new Error('Element not found after retries');
  }

  /**
   * Single attempt to get locator for intent command (called by retry wrapper)
   * V11: Accepts RetryContext for graduated strategy — shares state across retries.
   */
  private async tryGetLocatorForIntentCommand(
    command: IntentPlaywrightCommand,
    actionType: string,
    timeout: number,
    retryCtx: RetryContext
  ): Promise<{
    locator: Locator;
    runtimeMeta: StepRuntimeMeta;
  }> {
    const startTime = Date.now();
    const intentMeta = command.intentMeta;
    const stepId = intentMeta?.stepId || 'unknown';
    const iframeSelector = intentMeta?.iframeSelector;

    // User-pinned CSS selector short-circuit (step.options.cssSelector).
    // See ./step-options/pinned-css-locator.ts for details.
    const pinnedCssResult = await tryPinnedCssLocator(
      command,
      this.page,
      (iframeSel, t) => this.getFrameFromIframeSelector(iframeSel, t),
      timeout,
      startTime,
    );
    if (pinnedCssResult) {
      this.stepRuntimeMeta.set(stepId, pinnedCssResult.runtimeMeta);
      return pinnedCssResult;
    }

    // V11: If no compiled plan exists, pre-mark compiled as deterministic fail so
    // allStagesDeterministicFail() can return true for intent-only steps (no compiled plan).
    // Without this, fail-fast is silently disabled for all intent-only steps.
    // Force vision-only steps skip the compiled fast-path (pre-mark it as a
    // deterministic fail so fail-fast logic stays correct).
    if (!intentMeta?.compiled || this.skipCompiledPlan || intentMeta?.useScreenshotOnly) {
      retryCtx.stageDeterministicFail.compiled = true;
    }

    // 1. Try compiled locator plan first (skip if deterministic fail on previous attempt)
    if (intentMeta?.compiled && !this.skipCompiledPlan && !retryCtx.stageDeterministicFail.compiled && !intentMeta?.useScreenshotOnly) {
      const compiledContext = iframeSelector
        ? await this.getFrameFromIframeSelector(iframeSelector, Math.min(timeout, 10000))
        : this.page;
      const compiledResult = await executeCompiledLocatorPlan(
        compiledContext,
        intentMeta.compiled,
        actionType,
        timeout
      );

      if (compiledResult.success && compiledResult.locator) {
        const runtimeMeta = buildRuntimeMeta(compiledResult, Date.now() - startTime);
        this.stepRuntimeMeta.set(stepId, runtimeMeta);

        logger.info('[COMMAND_EXECUTOR] Using compiled locator', {
          stepId,
          strategy: compiledResult.usedStrategy,
          confidence: compiledResult.confidence,
          iframe: !!iframeSelector,
        });

        this.trace('element_resolution', intentMeta?.stepIndex ?? retryCtx.attempt + 1, {
          stepId, stage: 'compiled', success: true,
          strategy: compiledResult.usedStrategy,
          confidence: compiledResult.confidence,
          signatureMatched: compiledResult.signatureMatched,
          durationMs: Date.now() - startTime,
        });

        return { locator: compiledResult.locator, runtimeMeta };
      }

      // Log why compiled failed and store runtime meta for trace
      logger.info('[COMMAND_EXECUTOR] Compiled locator failed, falling back', {
        stepId,
        skipReason: compiledResult.skipReason,
        expired: compiledResult.expired,
        signatureMatched: compiledResult.signatureMatched,
      });

      this.trace('element_resolution', intentMeta?.stepIndex ?? retryCtx.attempt + 1, {
        stepId, stage: 'compiled', success: false,
        skipReason: compiledResult.skipReason,
        expired: compiledResult.expired,
        signatureMatched: compiledResult.signatureMatched,
        durationMs: Date.now() - startTime,
      });

      // Store failure meta so replay trace includes compiled plan failure info
      // (even when subsequent healing succeeds, the compiled failure is useful for debugging)
      const compiledFailureMeta = buildRuntimeMeta(compiledResult, Date.now() - startTime);
      this.stepRuntimeMeta.set(stepId, compiledFailureMeta);

      // V11: Mark compiled as deterministic failure (don't retry on next attempt)
      retryCtx.stageDeterministicFail.compiled = true;
    }

    // 2. Try LLM-based resolution (intent-aware, accurate)
    // Collect fresh DOM + use LLM resolver for element resolution
    if (intentMeta?.intentDescription && intentMeta?.actionType) {
      try {
        logger.info('[COMMAND_EXECUTOR] Trying LLM-based resolution', {
          stepId,
          intent: intentMeta.intentDescription.slice(0, 80),
          actionType: intentMeta.actionType,
        });

        // V11: Reuse cached DOM nodes if collected recently (< 1.5s), or force fresh on attempt >= 2
        const { collectInteractiveNodes } = await import('./background-dom-collector');
        const shouldCollectFresh = retryCtx.attempt >= 2 ||
          !retryCtx.cachedDomNodes ||
          (Date.now() - retryCtx.lastDomCollectionTs > 1500);

        let domNodes = shouldCollectFresh
          ? await collectInteractiveNodes(this.page, this.maxDomNodes)
          : retryCtx.cachedDomNodes!;

        if (shouldCollectFresh) {
          retryCtx.cachedDomNodes = domNodes;
          retryCtx.lastDomCollectionTs = Date.now();
        }

        // Replay readiness recollect (flag-gated, default OFF): a sparse fresh
        // snapshot usually means the page is still mid-load / mid-redirect
        // (SSO/OAuth chains), and resolving on it makes the LLM pick a stray
        // element. Run the SAME page-interactive gate the editor/lite paths use,
        // then recollect once. Never regress the node set on a worse recollect.
        if (
          shouldCollectFresh
          && shouldRecollectForReadiness({
            enabled: isReplayReadinessRecollectEnabled(),
            domNodeCount: domNodes.length,
            attempt: retryCtx.attempt,
          })
        ) {
          const readiness = await waitForPageInteractive(this.page, { maxWaitMs: REPLAY_READINESS_MAX_WAIT_MS });
          const recollected = await collectInteractiveNodes(this.page, this.maxDomNodes);
          logger.info('[COMMAND_EXECUTOR] Replay readiness recollect', {
            stepId,
            before: domNodes.length,
            after: recollected.length,
            waited: readiness.waited,
            ready: readiness.ready,
            finalUrl: readiness.finalUrl,
          });
          if (recollected.length > domNodes.length) {
            domNodes = recollected;
            retryCtx.cachedDomNodes = domNodes;
            retryCtx.lastDomCollectionTs = Date.now();
          }
        }

        if (domNodes.length === 0) {
          logger.warn('[COMMAND_EXECUTOR] No interactive nodes collected', { stepId });
        } else {
          // Evidence shortcut: if lastSuccessRef exists in current DOM, use it directly (skip LLM)
          // V15.7: TTL + URL + semantic checks are centralized in
          // evidence-shortcut.utils.ts (shared with preview pipeline). This
          // keeps policy identical across both pipelines; only placement and
          // result-shape differ (preview returns LintResult during lint phase,
          // background returns {locator, runtimeMeta} during execute phase).
          // Saves 1-2s LLM call when element hasn't changed between runs.
          if (
            intentMeta.evidence?.lastSuccessRef
            && retryCtx.attempt === 0
            // step.options.disableCaching — see ./step-options/* for the
            // field family. Mirrors intent-step-lint.service.ts:1227.
            && !intentMeta.disableCaching
            // Force vision-only steps skip the evidence shortcut.
            && !intentMeta.useScreenshotOnly
          ) {
            const shortcut = evaluateEvidenceShortcut({
              evidence: intentMeta.evidence,
              domNodes,
              currentUrl: this.page.url(),
              description: intentMeta.intentDescription,
              bindingHints: intentMeta.bindingHints,
              compiledPageUrl: intentMeta.compiled?.context?.pageUrl,
              actionType: intentMeta.actionType,
            });

            if (!shortcut.ok) {
              const level = (shortcut.reason === 'ttl_expired'
                || shortcut.reason === 'url_mismatch'
                || shortcut.reason === 'semantic_mismatch'
                || shortcut.reason === 'node_disabled') ? 'info' : 'debug';
              logger[level]('[COMMAND_EXECUTOR] Evidence shortcut bypass', {
                stepId,
                cachedRef: intentMeta.evidence.lastSuccessRef,
                reason: shortcut.reason,
                ...(shortcut.details || {}),
              });
            } else if (shortcut.node.isVisible === false) {
              // Background has an additional visibility gate that preview handles
              // via its action-type compat check. Keep it here so we never return
              // a locator pointing at a hidden element from the background path.
              logger.debug('[COMMAND_EXECUTOR] Evidence shortcut bypass — cached node not visible', {
                stepId, cachedRef: shortcut.ref,
              });
            } else {
              const { node: cachedNode, ref: cachedRef } = shortcut;
              const refLocator = (iframeSelector
                ? this.page.frameLocator(iframeSelector).locator(`[data-agent-ref="${cachedRef}"]`)
                : this.page.locator(`[data-agent-ref="${cachedRef}"]`)
              ).first();

              try {
                await refLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 3000) });

                logger.info('[COMMAND_EXECUTOR] Evidence shortcut hit — skipping LLM', {
                  stepId, cachedRef,
                  nodeTag: cachedNode.tag,
                  nodeLabel: (cachedNode.labelText || cachedNode.ariaLabel || '').slice(0, 40),
                  semanticSource: shortcut.semanticSource,
                });

                const runtimeMeta: StepRuntimeMeta = {
                  runtimeStatus: 'executed',
                  source: 'resolver',
                  confidenceTier: 'high',
                  executionMs: Date.now() - startTime,
                  usedLocatorStrategy: 'evidence_shortcut',
                  resolutionPath: 'evidence',
                };
                this.stepRuntimeMeta.set(stepId, runtimeMeta);

                return { locator: refLocator, runtimeMeta };
              } catch {
                // Evidence ref not visible at action time — fall through to full LLM resolution
                logger.debug('[COMMAND_EXECUTOR] Evidence shortcut failed (not visible)', { stepId, cachedRef });
              }
            }
          }

          // Run LLM-based element resolution.
          // V22: regression / replay path → use HEAL prompt that biases
          // toward finding the closest match using recordedFingerprint.
          // The element existed before; returning null breaks the test.
          const { resolveElement } = await import('@/services/testing/ui/preview/element-resolver.service');
          // V14: Lazy screenshot callback for vision rescue when 0 candidates match
          const pageForScreenshot = this.page;
          const resolveResult = await resolveElement({
            previewSessionId: 'background', // Not a preview session
            mode: 'heal',
            stepDraft: {
              id: stepId,
              type: intentMeta.actionType as any,
              description: intentMeta.intentDescription,
              bindingHints: intentMeta.bindingHints,
              evidence: intentMeta.evidence,
              // Strong recorded identity for the heal resolver. Previously
              // omitted — regression heals ran blind on description + soft
              // hints only. With this, heal uses the same id/testId/name/text/
              // ancestor fingerprint the editor captured (heal-context #2 fix).
              recordedFingerprint: intentMeta.recordedFingerprint,
              recordedDescription: intentMeta.recordedDescription,
              // Force vision-only resolution when the step opted in — the gate
              // at the top of resolveElement reads stepDraft.options.
              ...(intentMeta.useScreenshotOnly ? { options: { useScreenshotOnly: true } } : {}),
            },
            domNodes,
            pageUrl: this.page.url(),
            includeAlternatives: false,
            // V26 parity with the lint path: real viewport makes
            // buildAllowedSets' modal-coverage ratio accurate on long
            // scrollable pages. Null (no emulation) falls back to the
            // bbox high-water-mark heuristic, same as before.
            viewport: this.page.viewportSize() ?? undefined,
            screenshot: () => captureSmartScreenshot(pageForScreenshot),
            // Journey context: the user's narrative (test goal + the steps
            // completed before this failing one) so heal can disambiguate
            // drift (e.g. "we just logged in → this is login submit, not
            // settings submit"). Descriptions only — never input values.
            healContext: {
              testGoal: this.testGoal,
              priorSteps: this.recentStepDescriptions.slice(-CommandExecutor.RECENT_STEPS_WINDOW),
              stepIndex: intentMeta.stepIndex,
              totalSteps: this.totalSteps,
            },
          });

          if (resolveResult.status === 'resolved' && resolveResult.candidates.length > 0) {
            const topCandidate = resolveResult.candidates[0];

            if (topCandidate.ref) {
              // Build locator from resolved ref (temporary data-agent-ref="bg-X")
              const locator = this.page.locator(`[data-agent-ref="${topCandidate.ref}"]`).first();

              // Apply iframe context if needed
              const finalLocator = iframeSelector
                ? this.page.frameLocator(iframeSelector).locator(`[data-agent-ref="${topCandidate.ref}"]`).first()
                : locator;

              await finalLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

              // Validate element fingerprint: full 8-attribute check (same as Stage 1 compiled plan)
              // Catches race conditions where DOM changed between collection and resolution
              const expectedNode = topCandidate.node;
              if (expectedNode) {
                const fpScore = await quickFingerprintCheck(this.page, finalLocator, {
                  tag: expectedNode.tag,
                  role: expectedNode.role,
                  ariaLabel: expectedNode.ariaLabel,
                  placeholder: expectedNode.placeholder,
                  labelText: expectedNode.labelText,
                  testIdAttr: expectedNode.testIdAttr,
                  containerTitles: expectedNode.containerTitles,
                  boundingBox: expectedNode.boundingBox,
                });
                if (fpScore < 0.3) {
                  logger.warn('[COMMAND_EXECUTOR] Element fingerprint mismatch after LLM resolution', {
                    stepId,
                    ref: topCandidate.ref,
                    fpScore,
                    expectedTag: expectedNode.tag,
                    expectedLabel: expectedNode.labelText || expectedNode.ariaLabel,
                  });
                  throw new Error(`Fingerprint validation failed: score ${fpScore} < 0.3 for <${expectedNode.tag}>`);
                }
              }

              // LLM resolution is the resolver FALLBACK path (source: 'resolver',
              // resolutionPath: 'llm_resolver'), NOT self-healing. "Healed" must be
              // reserved for an actual locator rewrite via the self_heal path
              // (source: 'self_heal') — otherwise every AI-resolved step in a
              // regression run (where compiled plans routinely miss on a drifted
              // page) falsely lights up a "healed" badge. So this is 'executed'.
              const runtimeMeta: StepRuntimeMeta = {
                runtimeStatus: 'executed',
                source: 'resolver',
                confidenceTier: topCandidate.confidence >= 0.85 ? 'high' :
                               topCandidate.confidence >= 0.6 ? 'medium' : 'low',
                executionMs: Date.now() - startTime,
                usedLocatorStrategy: 'llm_resolver',
                resolutionPath: 'llm_resolver',
                needsReview: topCandidate.confidence < 0.85,
                flaky: topCandidate.confidence < 0.75,
              };
              this.stepRuntimeMeta.set(stepId, runtimeMeta);

              logger.info('[COMMAND_EXECUTOR] LLM resolution succeeded', {
                stepId,
                ref: topCandidate.ref,
                confidence: topCandidate.confidence,
                label: topCandidate.label?.slice(0, 50),
                resolutionPath: 'llm_resolver',
              });

              this.trace('element_resolution', intentMeta?.stepIndex ?? retryCtx.attempt + 1, {
                stepId, stage: 'llm_resolver', success: true,
                confidence: topCandidate.confidence,
                candidateCount: resolveResult.candidates.length,
                domNodesCollected: domNodes.length,
                ref: topCandidate.ref,
                label: topCandidate.label?.slice(0, 80),
                durationMs: Date.now() - startTime,
              });

              // TODO P1: Persist healed ref back to intent test case for future runs
              // if (topCandidate.confidence >= 0.85 && intentMeta.intentTestCaseId) {
              //   await IntentTestCaseService.updateStep(...)
              // }

              return { locator: finalLocator, runtimeMeta };
            }
          }

          // V11: Track candidate count for fail-fast heuristic
          if (resolveResult.candidates.length > 0) {
            retryCtx.totalCandidatesEver += resolveResult.candidates.length;
          } else if (!retryCtx.scrollAttempted) {
            // 0 candidates: element may be lazy-loaded below fold.
            // Scroll down once, re-collect DOM, retry resolution before giving up.
            retryCtx.scrollAttempted = true;
            try {
              const scrolled = await this.page.evaluate(() => {
                const before = (globalThis as any).scrollY;
                (globalThis as any).scrollBy(0, (globalThis as any).innerHeight * 0.8);
                return (globalThis as any).scrollY !== before;
              });

              if (scrolled) {
                await this.page.waitForTimeout(500); // Wait for lazy content to render

                const freshNodes = await collectInteractiveNodes(this.page, this.maxDomNodes);
                if (freshNodes.length > domNodes.length) {
                  logger.info('[COMMAND_EXECUTOR] Scroll revealed new elements, retrying resolution', {
                    stepId,
                    beforeNodes: domNodes.length,
                    afterNodes: freshNodes.length,
                  });

                  retryCtx.cachedDomNodes = freshNodes;
                  retryCtx.lastDomCollectionTs = Date.now();

                  const scrollResolve = await resolveElement({
                    previewSessionId: 'background',
                    mode: 'heal', // V22: regression heal path
                    stepDraft: {
                      id: stepId,
                      type: intentMeta.actionType as any,
                      description: intentMeta.intentDescription,
                      bindingHints: intentMeta.bindingHints,
                      evidence: intentMeta.evidence,
                      // Parity with the primary heal call above: below-the-fold
                      // heals must NOT run blind. Forward the same strong recorded
                      // identity so the resolver's identity fast-path can fire on
                      // the freshly-revealed nodes (was missing — scroll heals
                      // resolved on description + soft hints only).
                      recordedFingerprint: intentMeta.recordedFingerprint,
                      recordedDescription: intentMeta.recordedDescription,
                    },
                    domNodes: freshNodes,
                    pageUrl: this.page.url(),
                    includeAlternatives: false,
                    // Same viewport parity as the primary heal call above.
                    viewport: this.page.viewportSize() ?? undefined,
                    screenshot: () => captureSmartScreenshot(this.page),
                    // Same journey context as the primary heal so a scroll-revealed
                    // step is disambiguated with the test goal + prior steps too.
                    healContext: {
                      testGoal: this.testGoal,
                      priorSteps: this.recentStepDescriptions.slice(-CommandExecutor.RECENT_STEPS_WINDOW),
                      stepIndex: intentMeta.stepIndex,
                      totalSteps: this.totalSteps,
                    },
                  });

                  if (scrollResolve.status === 'resolved' && scrollResolve.candidates.length > 0) {
                    const scrollCandidate = scrollResolve.candidates[0];
                    if (scrollCandidate.ref) {
                      const scrollLocator = (iframeSelector
                        ? this.page.frameLocator(iframeSelector).locator(`[data-agent-ref="${scrollCandidate.ref}"]`)
                        : this.page.locator(`[data-agent-ref="${scrollCandidate.ref}"]`)
                      ).first();

                      await scrollLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

                      // Same as the LLM-resolver path above: this is resolver
                      // fallback, not self-healing → 'executed', no heal badge.
                      const runtimeMeta: StepRuntimeMeta = {
                        runtimeStatus: 'executed',
                        source: 'resolver',
                        confidenceTier: scrollCandidate.confidence >= 0.85 ? 'high' : 'medium',
                        executionMs: Date.now() - startTime,
                        usedLocatorStrategy: 'llm_resolver_scroll',
                        resolutionPath: 'llm_resolver',
                        needsReview: scrollCandidate.confidence < 0.85,
                      };
                      this.stepRuntimeMeta.set(stepId, runtimeMeta);

                      logger.info('[COMMAND_EXECUTOR] Scroll + LLM resolution succeeded', {
                        stepId,
                        ref: scrollCandidate.ref,
                        confidence: scrollCandidate.confidence,
                      });

                      return { locator: scrollLocator, runtimeMeta };
                    }
                  }
                }
              }
            } catch (scrollError) {
              logger.debug('[COMMAND_EXECUTOR] Scroll-retry failed (non-fatal)', {
                stepId,
                error: scrollError instanceof Error ? scrollError.message : String(scrollError),
              });
            }

            retryCtx.stageDeterministicFail.resolver = true;
          } else {
            retryCtx.stageDeterministicFail.resolver = true;
          }

          logger.info('[COMMAND_EXECUTOR] LLM resolution unsuccessful', {
            stepId,
            status: resolveResult.status,
            candidateCount: resolveResult.candidates.length,
            message: resolveResult.message,
          });

          this.trace('element_resolution', intentMeta?.stepIndex ?? retryCtx.attempt + 1, {
            stepId, stage: 'llm_resolver', success: false,
            status: resolveResult.status,
            candidateCount: resolveResult.candidates.length,
            domNodesCollected: domNodes.length,
            message: resolveResult.message,
            durationMs: Date.now() - startTime,
          });
        }
      } catch (resolverError) {
        logger.warn('[COMMAND_EXECUTOR] LLM resolution failed', {
          stepId,
          error: resolverError instanceof Error ? resolverError.message : String(resolverError),
        });
        // Transient error (network, timeout) — do NOT mark as deterministic fail
      }
    }

    // 3. Try smart locator from selector (legacy fallback)
    // V11: Skip on retry if it failed deterministically on previous attempt
    if (command.selector && !(retryCtx.attempt >= 1 && retryCtx.stageDeterministicFail.smart)) {
      try {
        const smartResult = await getSmartLocator(
          this.page,
          command.selector,
          actionType as any,
          command.description
        );

        if (smartResult.locator) {
          // Apply iframe context if needed
          const finalLocator = iframeSelector
            ? this.page.frameLocator(iframeSelector).locator(command.selector)
            : smartResult.locator;

          await finalLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

          const runtimeMeta: StepRuntimeMeta = {
            runtimeStatus: 'executed',
            source: 'resolver',
            confidenceTier: 'medium',
            executionMs: Date.now() - startTime,
            usedLocatorStrategy: 'smart',
            // getSmartLocator() uses deterministic scoring (separate from LLM resolver).
            resolutionPath: smartResult.usedAI ? 'llm_resolver' : 'rule_fallback',
          };
          this.stepRuntimeMeta.set(stepId, runtimeMeta);

          logger.info('[COMMAND_EXECUTOR] Using smart locator', {
            stepId,
            wasSmartSelected: smartResult.wasSmartSelected,
            totalMatches: smartResult.totalMatches,
            resolutionPath: runtimeMeta.resolutionPath,
            iframe: !!iframeSelector,
          });

          return { locator: finalLocator, runtimeMeta };
        } else {
          // V11: No locator returned — deterministic fail
          retryCtx.stageDeterministicFail.smart = true;
        }
      } catch (smartError) {
        const smartErrMsg = smartError instanceof Error ? smartError.message : String(smartError);
        logger.warn('[COMMAND_EXECUTOR] Smart locator failed', {
          stepId,
          error: smartErrMsg,
        });
        // V11: Only mark smart as deterministic fail if it's a "not found" condition,
        // NOT for transient errors (Playwright timeouts, detached frame, etc.).
        // Transient errors may resolve on the next retry with fresh DOM.
        const isTransientSmartError =
          smartErrMsg.includes('Timeout') ||
          smartErrMsg.includes('timeout') ||
          smartErrMsg.includes('Target closed') ||
          smartErrMsg.includes('detached') ||
          smartErrMsg.includes('navigating');
        if (!isTransientSmartError) {
          retryCtx.stageDeterministicFail.smart = true;
        }
      }
    }

    // 3. Try self-healing (if enabled and not exceeded max attempts)
    // V11: Uses shared healAttempts from RetryContext (persists across retries)
    if (this.selfHealingEnabled && retryCtx.healAttempts < this.maxHealAttempts) {
      retryCtx.healAttempts++;

      // NOTE: Credit deduction moved below — we only charge on SUCCESSFUL auto-applied
      // heals (confidence threshold met), not on every attempt. Failed/blocked heals
      // are free, matching executeWithSelfHealing's behavior and preventing per-attempt
      // overcharge during retries.

      try {
        // Fast mode first
        let healingResult = await SelfHealingService.healSelector({
          oldSelector: command.selector || '',
          intent: intentMeta?.intentDescription || command.description || '',
          page: this.page,
          errorMessage: 'Element not found via compiled or smart locator',
          metadata: {
            url: this.metadata.url || this.page.url(),
            projectId: this.metadata.projectId,
            userId: this.metadata.userId,
          },
          mode: 'fast',
        });

        // Phase 1: Escalate to accurate mode if fast fails
        if (!healingResult.success || (!healingResult.newSelector && !healingResult.coordinates)) {
          logger.info('[COMMAND_EXECUTOR] Intent healing fast failed, escalating to accurate', {
            intent: intentMeta?.intentDescription?.substring(0, 80),
          });
          healingResult = await SelfHealingService.healSelector({
            oldSelector: command.selector || '',
            intent: intentMeta?.intentDescription || command.description || '',
            page: this.page,
            errorMessage: 'Element not found via compiled or smart locator (escalated)',
            metadata: {
              url: this.metadata.url || this.page.url(),
              projectId: this.metadata.projectId,
              userId: this.metadata.userId,
            },
            mode: 'accurate',
          });
          healingResult.escalated = true;
        }

        if (healingResult.success && (healingResult.newSelector || healingResult.coordinates)) {
          const healConfidence = healingResult.diff?.confidence ?? 0;

          // GUARD RAILS: Check confidence threshold before auto-applying healed selector
          // This prevents "quietly wrong heal" - a key safety feature
          if (healConfidence >= this.selfHealingConfidenceThreshold && healingResult.newSelector) {
            const healedSelector = healingResult.newSelector;

            // ── Phase 8: Post-selection verification for intent healing path ──
            if (SelfHealingService.shouldVerify({
              confidence: healConfidence,
              escalated: healingResult.escalated,
              visionUsed: healingResult.visionUsed,
              hasCoordinates: !!healingResult.coordinates,
            })) {
              logger.info('[COMMAND_EXECUTOR] Running verification on intent-healed selector', {
                stepId,
                confidence: healConfidence,
                escalated: healingResult.escalated,
              });

              const verification = await SelfHealingService.verifySelectedElement({
                page: this.page,
                selector: healedSelector,
                intent: intentMeta?.intentDescription || command.description || '',
                actionType: actionType,
                confidence: healConfidence,
              });

              healingResult.verified = verification.verified;
              healingResult.verificationConfidence = verification.confidence;

              if (!verification.verified) {
                logger.warn('[COMMAND_EXECUTOR] Verification rejected intent-healed selector', {
                  stepId,
                  reason: verification.reason,
                  confidence: verification.confidence,
                });
                // Don't return this locator — fall through to error handling below
              }
            }

            // If verification was run and rejected, skip this result
            if (healingResult.verified === false) {
              logger.warn('[COMMAND_EXECUTOR] Skipping rejected healed selector', { stepId });
            } else {
            // Apply iframe context if needed
            const locator = iframeSelector
              ? this.page.frameLocator(iframeSelector).locator(healedSelector)
              : getLocator(this.page, healedSelector);

            await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

            // Determine if this healed step needs review
            // Even successful heals with medium confidence should be flagged
            const needsReview = healConfidence < 0.9;
            const flaky = healConfidence < 0.9;

            const runtimeMeta: StepRuntimeMeta = {
              runtimeStatus: 'healed',
              source: 'self_heal',
              confidenceTier: healConfidence >= 0.9 ? 'high' : 'medium',
              executionMs: Date.now() - startTime,
              usedLocatorStrategy: 'healed',
              healConfidence,
              resolutionPath: 'self_heal',
              // Self-heal provenance — surfaces before/after to the run report UI.
              // healingResult.oldSelector is always populated; newSelector is present
              // on success (guarded here by the surrounding `if success` branch).
              // `diff.what_changed` is a short human-readable description.
              ...(healingResult.oldSelector ? { healedFrom: healingResult.oldSelector } : {}),
              ...(healingResult.newSelector ? { healedTo: healingResult.newSelector } : {}),
              ...(healingResult.diff?.what_changed
                ? { healWhatChanged: healingResult.diff.what_changed }
                : {}),
              // GUARD RAILS: Flag for review even when heal succeeds
              needsReview,
              flaky,
            };
            this.stepRuntimeMeta.set(stepId, runtimeMeta);

            // Deduct 1 credit per healed STEP. `currentStepHealCharged` makes
            // it exactly-once per step across BOTH heal paths (no double-charge),
            // while still charging every distinct step that heals (no free-after-N).
            if (this.metadata.userId && !this.currentStepHealCharged) {
              this.currentStepHealCharged = true;
              this.instanceHealChargesSpent++;
              await CreditCostTrackerService.deductStepCredit(
                this.metadata.userId,
                `heal_intent_${Date.now()}`,
                `Intent self-heal: ${intentMeta?.intentDescription?.substring(0, 50)}`
              );
            }

            logger.info('[COMMAND_EXECUTOR] Self-healing succeeded', {
              stepId,
              newSelector: healingResult.newSelector,
              confidence: healConfidence,
              resolutionPath: 'self_heal',
              needsReview,
              flaky,
              verified: healingResult.verified,
              healChargesSpent: this.instanceHealChargesSpent,
            });

            this.trace('element_resolution', intentMeta?.stepIndex ?? retryCtx.attempt + 1, {
              stepId, stage: 'self_heal', success: true,
              confidence: healConfidence,
              newSelector: healingResult.newSelector,
              escalated: healingResult.escalated,
              verified: healingResult.verified,
              needsReview, flaky,
              durationMs: Date.now() - startTime,
            });

            // V2: Update compiled in DB if high-confidence heal (≥0.9)
            // This persists the healed selector for future runs
            if (healConfidence >= 0.9 && intentMeta?.stepId && intentMeta?.intentTestCaseId) {
              this.persistHealedCompiled({
                intentTestCaseId: intentMeta.intentTestCaseId,
                stepId: intentMeta.stepId,
                newSelector: healedSelector,
                healConfidence,
                pageUrl: this.page.url(),
                existingCompiled: intentMeta.compiled, // Pass existing for merging
              }).catch(err => {
                // Don't fail the action if persistence fails
                logger.warn('[COMMAND_EXECUTOR] Failed to persist healed compiled', {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }

            return { locator, runtimeMeta };
            }
          } else {
            // GUARD RAILS: Low confidence - block auto-healing entirely
            // Don't auto-update compiled/evidence when semantic match is low
            logger.warn('[COMMAND_EXECUTOR] Self-healing BLOCKED due to low confidence (guard rails)', {
              stepId,
              confidence: healConfidence,
              threshold: this.selfHealingConfidenceThreshold,
              reason: 'heal_blocked',
            });

            // Record that healing was attempted but blocked
            const blockedMeta: StepRuntimeMeta = {
              runtimeStatus: 'failed',
              source: 'self_heal',
              confidenceTier: 'low',
              executionMs: Date.now() - startTime,
              failedReason: 'heal_blocked',
              failureExplanation: `Self-healing was blocked due to low confidence (${Math.round(healConfidence * 100)}% < ${Math.round(this.selfHealingConfidenceThreshold * 100)}%). Cannot auto-apply potentially incorrect selector.`,
              healConfidence,
              resolutionPath: 'self_heal',
              needsReview: true,
              flaky: true,
            };
            this.stepRuntimeMeta.set(stepId, blockedMeta);
            // V11: Blocked heal = deterministic fail (same element, same low confidence on retry)
            retryCtx.stageDeterministicFail.selfHeal = true;
          }
        }
      } catch (healError) {
        const healErrMsg = healError instanceof Error ? healError.message : String(healError);
        logger.warn('[COMMAND_EXECUTOR] Self-healing failed', {
          stepId,
          error: healErrMsg,
        });
        // V11: Only mark self-heal as deterministic fail if it's NOT a transient AI/network error.
        // Transient errors (API rate limits, network timeouts) may resolve on retry.
        const isTransientHealError =
          healErrMsg.includes('rate limit') ||
          healErrMsg.includes('Rate limit') ||
          healErrMsg.includes('ECONNRESET') ||
          healErrMsg.includes('ETIMEDOUT') ||
          healErrMsg.includes('fetch failed') ||
          healErrMsg.includes('network') ||
          healErrMsg.includes('timeout') ||
          healErrMsg.includes('Timeout') ||
          healErrMsg.includes('overloaded') ||
          healErrMsg.includes('503');
        if (!isTransientHealError) {
          retryCtx.stageDeterministicFail.selfHeal = true;
        }
      }
    }

    // 4. All attempts failed
    const runtimeMeta: StepRuntimeMeta = {
      runtimeStatus: 'failed',
      source: intentMeta?.compiled ? 'compiled' : 'resolver',
      confidenceTier: 'low',
      executionMs: Date.now() - startTime,
      failedReason: 'element_not_found',
      failureExplanation: `Element not found after trying all resolution methods (compiled → smart locator → self-healing). ${intentMeta?.intentDescription || command.description || 'Element'} may not exist on current page or selector may be invalid.`,
      needsReview: true,
      resolutionPath: 'rule_fallback', // Failed all methods, no resolution path succeeded
    };
    this.stepRuntimeMeta.set(stepId, runtimeMeta);

    throw new Error(`Element not found for step: ${intentMeta?.intentDescription || command.description || 'unknown'}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART WAIT & FLAKINESS PREVENTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ✅ NEW: Wait for element with smart strategies (anti-flakiness)
   * Uses adaptive waiting based on selector stability
   */
  private async waitForElementSmart(
    selector: string,
    options: {
      timeout?: number;
      actionType?: 'click' | 'fill' | 'type' | 'select' | 'other';
    } = {}
  ): Promise<{
    success: boolean;
    locator?: Locator;
    stabilityScore?: SelectorStabilityScore;
    error?: string;
  }> {
    const { timeout = 10000, actionType = 'other' } = options;

    // Use SmartWaitService for intelligent waiting
    const waitResult = await SmartWaitService.waitForElement(
      this.page,
      selector,
      {
        timeout,
        strategy: 'auto', // Auto-detect best strategy
        retries: 3,
        retryDelay: 300,
      }
    );

    // Log stability info for flaky selectors
    if (waitResult.stabilityScore?.isFlaky) {
      logger.warn('[COMMAND_EXECUTOR] Flaky selector detected', {
        selector: selector.substring(0, 50),
        stabilityScore: waitResult.stabilityScore.score,
        reasons: waitResult.stabilityScore.reasons,
        recommendation: waitResult.stabilityScore.recommendation,
      });
    }

    if (!waitResult.success) {
      return {
        success: false,
        stabilityScore: waitResult.stabilityScore,
        error: waitResult.error,
      };
    }

    // Validate the locator is actionable
    const locator = waitResult.locator!;

    // Additional check for specific action types
    if (actionType === 'click' || actionType === 'fill') {
      try {
        // Check if element is actually interactable (runs in browser context)
        const isActionable = await locator.evaluate((el: any) => {
          const rect = el.getBoundingClientRect();
          // @ts-expect-error - window.getComputedStyle exists in browser context
          const style = window.getComputedStyle(el);

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none'
          );
        }).catch(() => true); // Assume true if check fails

        if (!isActionable) {
          return {
            success: false,
            locator,
            stabilityScore: waitResult.stabilityScore,
            error: 'Element exists but is not actionable',
          };
        }
      } catch {
        // Check failed, continue anyway
      }
    }

    return {
      success: true,
      locator,
      stabilityScore: waitResult.stabilityScore,
    };
  }

  /**
   * ✅ NEW: Analyze selector before action for flakiness detection
   * Returns stability score and recommendations
   */
  private analyzeSelector(selector: string): SelectorStabilityScore {
    return SmartWaitService.analyzeSelectorStability(selector);
  }

  /**
   * Execute an action with smart locator disambiguation + self-healing fallback.
   * Encapsulates the common pattern: getSmartLocator → try action → catch → executeWithSelfHealing.
   */
  private async executeWithSmartLocatorAndHealing(opts: {
    selector: string;
    actionType: string;
    description?: string;
    timeout?: number;
    value?: any;
    waitState?: 'visible' | 'attached';
    performAction: (locator: Locator) => Promise<void>;
  }): Promise<void> {
    const { selector, actionType, description: desc, timeout: to, value: val, waitState = 'visible' } = opts;

    const smartResult = await getSmartLocator(this.page, selector, actionType as any, desc);

    if (smartResult.wasSmartSelected) {
      logger.info(`[COMMAND_EXECUTOR] Smart element selection used for ${actionType}`, {
        selector: selector.substring(0, 50),
        totalMatches: smartResult.totalMatches,
        selectedIndex: smartResult.selectedIndex,
      });
    }

    try {
      await smartResult.locator.waitFor({ state: waitState, timeout: to || 10000 });
      await opts.performAction(smartResult.locator);
    } catch (error) {
      logger.warn(`[COMMAND_EXECUTOR] Smart locator ${actionType} failed, trying self-healing`, {
        selector: selector.substring(0, 50),
        error: error instanceof Error ? error.message : String(error),
      });

      await this.executeWithSelfHealing(
        async () => {
          const locator = getLocator(this.page, selector);
          if (waitState === 'visible') {
            await locator.waitFor({ state: 'visible', timeout: to || 30000 });
          } else if (waitState === 'attached') {
            await locator.waitFor({ state: 'attached', timeout: to || 30000 });
          }
          await opts.performAction(locator);
        },
        { selector, intent: desc || `${actionType} element`, action: actionType, timeout: to, value: val }
      );
    }
  }

  /**
   * ✅ CRITICAL FIX: Execute action with self-healing support
   * If selector fails, attempt to heal it using AI Selector Engine
   * Applies healed selector according to action type (click, fill, select, etc.)
   */
  private async executeWithSelfHealing(
    action: () => Promise<void>,
    context: {
      selector: string;
      intent: string;
      action: string;
      timeout?: number;
      value?: any; // ✅ NEW: Value for fill/type/select actions
    }
  ): Promise<void> {
    try {
      // Try original selector first
      await action();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // ✅ IMPROVED: More robust selector error detection
      // Check error type (Playwright errors) + message patterns
      const isSelectorError = isSelectorRelatedError(error);

      if (!isSelectorError || !this.selfHealingEnabled) {
        // Not a selector error or self-healing disabled → re-throw
        throw error;
      }

      logger.warn('[COMMAND_EXECUTOR] Selector failed, attempting self-healing', {
        selector: context.selector,
        intent: context.intent,
        error: errorMessage,
      });

      // Attempt self-healing: fast mode first
      let healingResult = await SelfHealingService.healSelector({
        oldSelector: context.selector,
        intent: context.intent,
        page: this.page,
        errorMessage,
        metadata: {
          url: this.metadata.url || this.page.url(),
          projectId: this.metadata.projectId,
          userId: this.metadata.userId,
        },
        mode: 'fast',
      });

      // ── Phase 1: Escalate to accurate mode (screenshot + vision) if fast fails ──
      if (!healingResult.success || (!healingResult.newSelector && !healingResult.coordinates)) {
        logger.info('[COMMAND_EXECUTOR] Fast healing failed, escalating to accurate mode (vision)', {
          oldSelector: context.selector,
          intent: context.intent,
        });

        healingResult = await SelfHealingService.healSelector({
          oldSelector: context.selector,
          intent: context.intent,
          page: this.page,
          errorMessage,
          metadata: {
            url: this.metadata.url || this.page.url(),
            projectId: this.metadata.projectId,
            userId: this.metadata.userId,
          },
          mode: 'accurate', // Screenshot + Gemini Vision
        });
        healingResult.escalated = true;
      }

      if (!healingResult.success || (!healingResult.newSelector && !healingResult.coordinates)) {
        logger.error('[COMMAND_EXECUTOR] Self-healing failed (fast + accurate)', {
          oldSelector: context.selector,
          suggestion: healingResult.suggestion,
        });
        // Re-throw original error
        throw error;
      }

      // Healing successful - log and retry with new selector
      const healConfidence = healingResult.diff?.confidence ?? 0;
      logger.info('[COMMAND_EXECUTOR] Self-healing successful', {
        oldSelector: context.selector,
        newSelector: healingResult.newSelector,
        autoApplied: healingResult.autoApplied,
        confidence: healConfidence,
      });

      // ✅ FIX 7: Use configurable confidence threshold
      const meetsConfidenceThreshold = healConfidence >= this.selfHealingConfidenceThreshold;

      if (healingResult.autoApplied && meetsConfidenceThreshold) {
        // Deduct 1 credit per healed STEP. `currentStepHealCharged` ensures the
        // same step isn't charged twice when the intent-path heal already
        // charged it; each new step that heals is still charged once.
        if (this.metadata.userId && !this.currentStepHealCharged) {
          this.currentStepHealCharged = true;
          this.instanceHealChargesSpent++;
          await CreditCostTrackerService.deductStepCredit(
            this.metadata.userId,
            `heal_${Date.now()}`,
            `Self-heal retry: ${context.selector?.substring(0, 50)}`
          );
        }

        // ── Phase 1: Coordinate-based click (vision fallback) ──────────
        if (healingResult.coordinates && !healingResult.newSelector) {
          const { x, y } = healingResult.coordinates;
          logger.info('[COMMAND_EXECUTOR] Using coordinate-based click from vision', {
            x, y,
            action: context.action,
            confidence: healingResult.diff.confidence,
            escalated: healingResult.escalated,
          });

          if (context.action === 'click' || context.action === 'tap') {
            await this.page.mouse.click(x, y);
          } else {
            // For non-click actions with coordinates, click first to focus, then act
            await this.page.mouse.click(x, y);
            if (context.action === 'type' && context.value) {
              await this.page.keyboard.type(String(context.value));
            }
          }

          logger.info('[COMMAND_EXECUTOR] Coordinate-based action succeeded', {
            x, y, action: context.action,
          });
          return;
        }

        logger.info('[COMMAND_EXECUTOR] Auto-applying healed selector', {
          newSelector: healingResult.newSelector,
          whatChanged: healingResult.diff.what_changed,
          action: context.action,
          confidence: healingResult.diff.confidence,
          threshold: this.selfHealingConfidenceThreshold,
          escalated: healingResult.escalated,
          visionUsed: healingResult.visionUsed,
        });

        // ── Phase 8: Post-selection verification agent ──────────────────
        // Verify the healed element is correct before executing the action.
        // Only runs in "grey zone" (0.70–0.90 confidence) or when escalated.
        // Fail-open: verification errors don't block execution.
        if (healingResult.newSelector && SelfHealingService.shouldVerify({
          confidence: healConfidence,
          escalated: healingResult.escalated,
          visionUsed: healingResult.visionUsed,
          hasCoordinates: !!healingResult.coordinates,
        })) {
          logger.info('[COMMAND_EXECUTOR] Running post-selection verification', {
            confidence: healConfidence,
            escalated: healingResult.escalated,
            selector: healingResult.newSelector.slice(0, 80),
          });

          const verification = await SelfHealingService.verifySelectedElement({
            page: this.page,
            selector: healingResult.newSelector,
            intent: context.intent,
            actionType: context.action,
            confidence: healConfidence,
          });

          healingResult.verified = verification.verified;
          healingResult.verificationConfidence = verification.confidence;

          if (!verification.verified) {
            logger.warn('[COMMAND_EXECUTOR] Verification rejected healed selector', {
              reason: verification.reason,
              confidence: verification.confidence,
              selector: healingResult.newSelector?.slice(0, 80),
            });
            // Verification rejected → re-throw original error (don't execute wrong action)
            throw error;
          }

          logger.info('[COMMAND_EXECUTOR] Verification confirmed healed selector', {
            confidence: verification.confidence,
            reason: verification.reason,
          });
        }

        // Apply healed selector according to action type
        // Phase 3: Pass iframe context if element was found in an iframe
        await this.applyHealedSelector(
          healingResult.newSelector!,
          context.action,
          context.value,
          context.timeout,
          healingResult.iframeContext
        );

        logger.info('[COMMAND_EXECUTOR] Healed selector worked successfully', {
          newSelector: healingResult.newSelector,
          action: context.action,
          escalated: healingResult.escalated,
          visionUsed: healingResult.visionUsed,
          verified: healingResult.verified,
          inIframe: !!healingResult.iframeContext,
        });
      } else {
        // Low confidence - log suggestion but don't auto-apply
        logger.warn('[COMMAND_EXECUTOR] Healing below confidence threshold - not auto-applying', {
          suggestion: healingResult.suggestion,
          confidence: healingResult.diff.confidence,
          threshold: this.selfHealingConfidenceThreshold,
          reason: !meetsConfidenceThreshold ? 'below_threshold' : 'auto_apply_disabled',
        });
        throw error; // Re-throw original error
      }
    }
  }

  /**
   * ✅ FIX 2 & 4: Use centralized error classification (removed duplication)
   */
  // Removed: isSelectorRelatedError() - now using utils/selector-utils.ts

  /**
   * ✅ COMPLETE: Apply healed selector according to action type
   * Supports ALL Playwright actions (30+ actions)
   * ✅ FIX 3: Always validate before applying healed selector
   */
  private async applyHealedSelector(
    selector: string,
    actionType: string,
    value: any,
    timeout?: number,
    /** Phase 3: If element is in an iframe, pass iframe context for frame locator */
    iframeContext?: { frameName?: string; frameUrl?: string }
  ): Promise<void> {
    // Phase 3: If iframe context, use frame locator
    const targetPage = iframeContext
      ? (() => {
          const frame = this.page.frames().find(f =>
            (iframeContext.frameName && f.name() === iframeContext.frameName) ||
            (iframeContext.frameUrl && f.url() === iframeContext.frameUrl)
          );
          return frame || this.page;
        })()
      : this.page;

    // ✅ FIX 3: Dry-run validation before applying healed selector
    const validation = await validateAndGetLocator(targetPage as any, selector, {
      actionType: actionType as any,
      timeout: timeout || 2000,
    });

    if (!validation.success || !validation.locator) {
      throw new Error(`Healed selector validation failed: ${validation.error}`);
    }

    const locator = validation.locator; // ✅ FIX 1: Use validated locator to avoid race conditions

    // ✅ Post-heal ambiguity check: Ensure healed selector matches exactly 1 element
    const elementCount = await locator.count();
    if (elementCount !== 1) {
      const errorMsg = elementCount === 0
        ? `Healed selector matches 0 elements (element disappeared)`
        : `Healed selector is ambiguous: matches ${elementCount} elements (expected exactly 1)`;

      logger.error('[COMMAND_EXECUTOR] Post-heal ambiguity check failed', {
        selector: selector.substring(0, 100),
        elementCount,
        actionType,
      });

      // Record this as a failure requiring review
      throw new Error(errorMsg);
    }

    logger.debug('[COMMAND_EXECUTOR] Post-heal count check passed', {
      selector: selector.substring(0, 100),
      elementCount,
    });

    const defaultTimeout = timeout || 30000;

    // Wait for element to be visible first (except for assertions and waits)
    const skipVisibilityCheck = [
      'wait', 'waitForSelector', 'waitForTimeout', 'waitForLoadState', 'waitForNavigation',
      'assertHidden', 'assertDisabled', 'screenshot', 'evaluate', 'extract',
      'upload' // File inputs are often hidden via CSS
    ];
    if (!skipVisibilityCheck.includes(actionType)) {
      await locator.waitFor({ state: 'visible', timeout: defaultTimeout }).catch(() => {
        // Element might not be visible for some actions (e.g., assertHidden)
        logger.debug('[COMMAND_EXECUTOR] Element not visible, continuing anyway', { actionType });
      });
    }

    switch (actionType) {
      // ═══════════════════════════════════════════════════════════════
      // INTERACTIONS
      // ═══════════════════════════════════════════════════════════════
      case 'click':
        // ✅ FIX: Force scroll into view before clicking (handles viewport issues)
        await this.forceScrollIntoView(locator);
        // ✅ Overlay guard: Ensure element is topmost before clicking
        await this.ensureTopMostAtCenter(locator, 2000);
        // ✅ Wait for enabled: Ensure element is not disabled
        await this.waitForEnabled(locator, 5000);
        // V15.5: noWaitAfter — skip Playwright's 15-30s post-click stability wait.
        // Lookahead + per-step post-buffer handle readiness for the next step.
        await locator.click({ timeout: defaultTimeout, noWaitAfter: true });
        break;

      case 'dblclick':
        await locator.dblclick({ timeout: defaultTimeout, noWaitAfter: true });
        break;

      case 'contextmenu':
        await this.forceScrollIntoView(locator);
        await locator.click({ button: 'right', timeout: defaultTimeout, noWaitAfter: true });
        break;

      case 'type':
        if (value === undefined) throw new Error('Value is required for type action');
        // Use pressSequentially (not fill) to match main handler — fires keydown/keypress/keyup per char
        // Important for autocomplete, OTP, and sites that listen to keyboard events
        await locator.pressSequentially(String(value), { timeout: defaultTimeout, noWaitAfter: true });
        break;

      case 'select':
      case 'selectOption': {
        if (value === undefined) throw new Error('Value is required for select action');
        // ✅ Wait for enabled: Ensure select is not disabled
        await this.waitForEnabled(locator, 5000);

        const isNativeHeal = await this.isNativeSelectLocator(locator);
        if (isNativeHeal) {
          // ✅ Wait for options: Ensure select has options available
          await this.waitForSelectOptions(locator, 5000, 3);
          await locator.selectOption(String(value), { timeout: defaultTimeout, noWaitAfter: true });
        } else {
          // Custom dropdown: click-based selection
          await this.selectFromCustomDropdown(locator, String(value), defaultTimeout);
        }
        break;
      }

      case 'check':
        // ✅ Wait for enabled: Ensure checkbox is not disabled
        await this.waitForEnabled(locator, 5000);
        await locator.check({ timeout: defaultTimeout, noWaitAfter: true });
        break;

      case 'uncheck':
        // ✅ Wait for enabled: Ensure checkbox is not disabled
        await this.waitForEnabled(locator, 5000);
        await locator.uncheck({ timeout: defaultTimeout, noWaitAfter: true });
        break;

      case 'hover':
        await locator.hover({ timeout: defaultTimeout });
        // Mirror the non-heal hover path: wait for hover-triggered DOM effects
        // (tooltips, submenus, popovers) to appear and stabilize. Without this,
        // a healed hover returns before the tooltip has anchored to the correct
        // trigger, leaving the next snapshot/capture with a stale tooltip ↔
        // trigger binding (see main hover case at the top of this file).
        await waitForHoverEffect(this.page);
        break;

      case 'focus':
        await locator.focus({ timeout: defaultTimeout });
        break;

      case 'blur':
        await locator.blur({ timeout: defaultTimeout });
        break;

      case 'press':
        if (value === undefined) throw new Error('Key is required for press action');
        // ✅ Ensure focus: Verify element is focused before pressing key
        await this.ensureFocused(locator, 2000);
        // V15.5: noWaitAfter — same rationale as click
        await locator.press(String(value), { timeout: defaultTimeout, noWaitAfter: true });
        break;

      // ═══════════════════════════════════════════════════════════════
      // DRAG & DROP / MOBILE
      // ═══════════════════════════════════════════════════════════════
      case 'dragAndDrop': {
        const dragCoords = parseDragCoordinates(value);
        if (dragCoords) {
          await executeCoordinateDrag(this.page, dragCoords);
        } else if (value) {
          // Selector-based drag (target selector in value)
          const targetLocator = this.getLocatorInternal(String(value));
          await locator.dragTo(targetLocator, { timeout: defaultTimeout });
        } else {
          throw new Error('dragAndDrop requires coordinate data (JSON value) or a target selector');
        }
        break;
      }

      case 'tap':
        await locator.tap({ timeout: defaultTimeout });
        break;

      case 'swipe':
        // Swipe is typically implemented as dragTo with offset
        logger.warn('[COMMAND_EXECUTOR] Swipe action not fully supported, using tap', { actionType });
        await locator.tap({ timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // SCROLL
      // ═══════════════════════════════════════════════════════════════
      case 'scroll':
      case 'scrollIntoView':
        if (locator) {
          await locator.scrollIntoViewIfNeeded({ timeout: defaultTimeout });
        } else if (value) {
          // V14: Use deltaY,deltaX from step value
          const scrollParts = (typeof value === 'string' ? value : String(value)).split(',');
          const sdy = parseFloat(scrollParts[0] || '') || 300;
          const sdx = scrollParts.length > 1 ? (parseFloat(scrollParts[1] || '') || 0) : 0;
          await this.page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
            // @ts-expect-error - browser context
            window.scrollBy(dx, dy);
          }, { dx: sdx, dy: sdy });
        }
        break;

      // ═══════════════════════════════════════════════════════════════
      // WAIT
      // ═══════════════════════════════════════════════════════════════
      case 'wait':
      case 'waitForTimeout':
        await this.page.waitForTimeout(defaultTimeout);
        break;

      case 'waitForSelector':
        await locator.waitFor({ state: 'visible', timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // ASSERTIONS
      // ═══════════════════════════════════════════════════════════════
      case 'assertVisible':
        const isVisible = await locator.isVisible({ timeout: defaultTimeout });
        if (!isVisible) throw new Error(`Element not visible: ${selector}`);
        break;

      case 'assertHidden':
        const isHidden = await locator.isHidden({ timeout: defaultTimeout });
        if (!isHidden) throw new Error(`Element not hidden: ${selector}`);
        break;

      case 'assertEnabled':
        const isEnabled = await locator.isEnabled({ timeout: defaultTimeout });
        if (!isEnabled) throw new Error(`Element not enabled: ${selector}`);
        break;

      case 'assertDisabled':
        const isDisabled = await locator.isDisabled({ timeout: defaultTimeout });
        if (!isDisabled) throw new Error(`Element not disabled: ${selector}`);
        break;

      case 'assertText':
        const actualText = await locator.textContent({ timeout: defaultTimeout });
        if (value && !String(actualText).includes(String(value))) {
          throw new Error(`Text assertion failed: expected "${value}", got "${actualText}"`);
        }
        break;

      case 'assertValue':
        const actualValue = await locator.inputValue({ timeout: defaultTimeout });
        if (value && actualValue !== String(value)) {
          throw new Error(`Value assertion failed: expected "${value}", got "${actualValue}"`);
        }
        break;

      case 'assertCount':
        const count = await locator.count();
        if (value && count !== Number(value)) {
          throw new Error(`Count assertion failed: expected ${value}, got ${count}`);
        }
        break;

      // ═══════════════════════════════════════════════════════════════
      // DATA EXTRACTION
      // ═══════════════════════════════════════════════════════════════
      case 'extract':
        // Extract is handled separately in executeCommand
        logger.warn('[COMMAND_EXECUTOR] Extract action in self-healing not fully supported', {
          actionType,
        });
        break;

      case 'upload':
        // Upload in self-healing context: value holds the local file path
        if (value) {
          const filePath = String(value);
          const elTag = await locator.evaluate((el: any) => el.tagName?.toLowerCase()).catch(() => '');
          const elInputType = await locator.evaluate((el: any) => el.type?.toLowerCase()).catch(() => '');
          if (elTag === 'input' && elInputType === 'file') {
            await locator.setInputFiles(filePath, { timeout: defaultTimeout });
          } else {
            // Trigger-button: fileChooser → synthetic drop fallback
            await uploadViaFileChooserOrDrop(
              this.page, locator, filePath, '', undefined, defaultTimeout,
            );
          }
        } else {
          logger.warn('[COMMAND_EXECUTOR] Upload action in self-healing has no file path', { actionType });
        }
        break;

      case 'evaluate':
        if (value) {
          await locator.evaluate(String(value));
        }
        break;

      // ═══════════════════════════════════════════════════════════════
      // SCREENSHOT
      // ═══════════════════════════════════════════════════════════════
      case 'screenshot':
        await locator.screenshot({ timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // NAVIGATION (no selector needed, but included for completeness)
      // ═══════════════════════════════════════════════════════════════
      case 'goto':
      case 'goBack':
      case 'goForward':
      case 'reload':
      case 'waitForNavigation':
      case 'waitForLoadState':
      case 'waitFor': // V5: SPA-safe URL waiting (no selector needed)
      case 'waitForEmail': // V12: Email inbox polling (no selector needed)
        logger.warn('[COMMAND_EXECUTOR] Navigation action in self-healing - no selector needed', {
          actionType,
        });
        break;

      // ═══════════════════════════════════════════════════════════════
      // UNKNOWN
      // ═══════════════════════════════════════════════════════════════
      default:
        // ✅ IMPROVED: Don't fallback to click - throw error for unknown actions
        throw new Error(`Unknown action type for self-healing: ${actionType}. Cannot apply healed selector.`);
    }
  }

  /**
   * V5: Execute wait_for using SPA-safe approach (page.waitForFunction)
   * Works for both full navigations AND SPA client-side routing (React Router, Next.js, etc.)
   *
   * Matcher precedence:
   * 1. changedFrom: wait until URL != changedFrom value (used by auto-insert)
   * 2. regex: match URL against regex pattern
   * 3. glob: match URL against glob pattern (converted to regex)
   * 4. substring: URL contains substring
   * 5. domain: URL domain equals value (strict host match)
   *
   * @param matcher URL matcher configuration
   * @param timeoutMs Timeout in milliseconds
   */
  private async executeWaitFor(
    matcher: import('@/types').PlaywrightUrlMatcher | undefined,
    timeoutMs: number
  ): Promise<void> {
    if (!matcher) {
      // No matcher specified - simple wait for duration (like 'wait' action)
      logger.debug('[COMMAND_EXECUTOR] No URL matcher specified, waiting for duration', { timeoutMs });
      await this.page.waitForTimeout(timeoutMs);
      return;
    }

    const negate = matcher.negate ?? false;
    const caseSensitive = matcher.caseSensitive ?? false;

    logger.debug('[COMMAND_EXECUTOR] Executing waitFor', {
      matcher: Object.keys(matcher).filter(k => (matcher as any)[k] !== undefined),
      timeoutMs,
    });

    // Priority: changedFrom > regex > glob > substring > domain

    if (matcher.changedFrom) {
      const currentUrl = this.page.url();

      // V16: If URL already differs from the recorded changedFrom value,
      // navigation already happened (e.g., preceding click with awaitNavigation).
      // Just wait for page to settle instead of waiting for another URL change.
      const { normalizeUrlForComparison } = await import(
        '@/services/testing/ui/preview/auto-wait-for.utils'
      );
      if (normalizeUrlForComparison(currentUrl) !== normalizeUrlForComparison(matcher.changedFrom)) {
        logger.debug('[COMMAND_EXECUTOR] changedFrom: URL already changed, waiting for page settle', {
          recorded: matcher.changedFrom,
          current: currentUrl,
        });
        await this.page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {
          // load may not fire on SPA — fallback to domcontentloaded
          return this.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
        });
        return;
      }

      // URL hasn't changed yet — wait for it to change from current
      logger.debug('[COMMAND_EXECUTOR] changedFrom using runtime URL', {
        recorded: matcher.changedFrom,
        runtime: currentUrl,
      });
      await this.page.waitForURL(
        (url) => url.toString() !== currentUrl,
        { timeout: timeoutMs, waitUntil: 'load' }
      );
      logger.debug('[COMMAND_EXECUTOR] URL changed from previous value', {
        prevUrl: currentUrl,
        newUrl: this.page.url(),
      });
      return;
    }

    if (matcher.regex) {
      // Parse /pattern/flags syntax + validate in Node.js before sending to browser
      const payload = buildRegexWaitPayload(matcher.regex, caseSensitive, negate);
      await this.page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          try {
            const re = new RegExp(pattern, flags);
            const href = String((globalThis as any).location?.href ?? '');
            const matches = re.test(href);
            return negate ? !matches : matches;
          } catch {
            return false;
          }
        },
        payload,
        { timeout: timeoutMs }
      );
      return;
    }

    if (matcher.glob) {
      // Convert glob to regex using URL-aware semantics:
      //   *   → [^/]*  (segment wildcard)
      //   **  → .*     (path globstar)
      //   ?   → [^/] or \? (query-string heuristic)
      //   No wildcards → substring match (no anchors)
      //   With protocol prefix → full anchor ^...$
      //   Partial glob → suffix anchor only
      const payload = buildGlobWaitPayload(matcher.glob, caseSensitive, negate);
      await this.page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          try {
            const re = new RegExp(pattern, flags);
            const href = String((globalThis as any).location?.href ?? '');
            const matches = re.test(href);
            return negate ? !matches : matches;
          } catch {
            return false;
          }
        },
        payload,
        { timeout: timeoutMs }
      );
      return;
    }

    if (matcher.substring) {
      const sub = matcher.substring;
      await this.page.waitForFunction(
        ({ sub, caseSensitive, negate }: { sub: string; caseSensitive: boolean; negate: boolean }) => {
          const hrefRaw = String((globalThis as any).location?.href ?? '');
          const url = caseSensitive ? hrefRaw : hrefRaw.toLowerCase();
          const search = caseSensitive ? sub : sub.toLowerCase();
          const matches = url.includes(search);
          return negate ? !matches : matches;
        },
        { sub, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return;
    }

    if (matcher.domain) {
      const domain = matcher.domain;
      await this.page.waitForFunction(
        ({ domain, caseSensitive, negate }: { domain: string; caseSensitive: boolean; negate: boolean }) => {
          const hostRaw = String((globalThis as any).location?.hostname ?? '');
          const host = caseSensitive ? hostRaw : hostRaw.toLowerCase();
          const target = caseSensitive ? domain : domain.toLowerCase();
          const matches = host === target;
          return negate ? !matches : matches;
        },
        { domain, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return;
    }

    // No specific matcher - return
  }

  // ═══════════════════════════════════════════════════════════════════════
  // V10: DETERMINISTIC ENTER KEY DETECTION (fast-path, no AI call)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Deterministic fast-path for Enter key detection.
   * Returns:
   *   true  — definitely press Enter (search field, OTP, single input, etc.)
   *   false — definitely don't press Enter (form with submit button, multi-line textarea)
   *   null  — unsure, fall through to AI detection
   *
   * Avoids a GPT-4o-mini API call for obvious cases.
   */
  private async fastEnterDetection(locator: Locator): Promise<boolean | null> {
    try {
      const context = await locator.evaluate((el: any) => {
        const tag = el.tagName?.toLowerCase() || '';
        const type = (el.type || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const autocomplete = (el.autocomplete || '').toLowerCase();
        const maxLength = el.maxLength || -1;
        const role = (el.getAttribute('role') || '').toLowerCase();

        // Multi-line textarea → NEVER press Enter
        const rows = parseInt(el.getAttribute('rows') || '0', 10);
        if (tag === 'textarea' && (rows > 1 || role !== 'textbox')) {
          return { decision: false, reason: 'multi-line-textarea' };
        }

        // Search keywords (multi-language)
        const searchTerms = ['search', 'find', 'query', 'filter', 'поиск', 'искать', 'recherche', 'suche', 'buscar'];
        const allText = `${placeholder} ${name} ${id} ${ariaLabel} ${autocomplete}`;
        const isSearch = type === 'search' || searchTerms.some(t => allText.includes(t));

        // OTP / verification code
        const codeTerms = ['code', 'otp', 'pin', 'verification', 'подтверждение', 'код', 'token'];
        const isCode = (maxLength >= 1 && maxLength <= 10) && codeTerms.some(t => allText.includes(t));

        // Form context
        const form = el.form || el.closest('form');
        const hasSubmitBtn = form
          ? !!form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
          : false;

        // Total inputs on page
        const doc = el.ownerDocument;
        const totalInputs = doc.querySelectorAll(
          'input[type="text"], input[type="email"], input[type="search"], input[type="password"], input:not([type]), textarea'
        ).length;

        // Single input on page (likely search or single-field form)
        const isSingleInput = totalInputs === 1;

        return {
          tag, type, isSearch, isCode, hasSubmitBtn, isSingleInput,
          maxLength, role, rows,
          decision: null as boolean | null,
          reason: '',
        };
      }).catch(() => null);

      if (!context) return null;

      // Already decided by browser-side evaluation
      if (context.decision !== null && context.decision !== undefined) {
        logger.debug('[FAST_ENTER] Browser-side decision', { decision: context.decision, reason: context.reason });
        return context.decision;
      }

      // ── Definite YES ──
      // Search field → always Enter
      if (context.isSearch) return true;

      // OTP / code field → always Enter
      if (context.isCode) return true;

      // Single input on page without submit button → Enter
      if (context.isSingleInput && !context.hasSubmitBtn) return true;

      // ── Definite NO ──
      // Form with visible submit button → don't press (let user click)
      if (context.hasSubmitBtn) return false;

      // ── Unsure → let AI decide ──
      return null;
    } catch {
      return null; // Error → fall through to AI
    }
  }

  /**
   * ✅ FIX: Force scroll element into viewport using multiple strategies
   * Handles cases where scrollIntoViewIfNeeded() fails
   */
  private async forceScrollIntoView(locator: Locator): Promise<void> {
    try {
      // Strategy 1: Try scrollIntoViewIfNeeded first (Playwright's built-in)
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {
        logger.debug('[COMMAND_EXECUTOR] scrollIntoViewIfNeeded failed, trying manual scroll');
      });

      // Strategy 2: Check if element is in viewport, if not - use manual scroll
      const isInViewport = await locator.evaluate((el) => {
        // @ts-ignore - browser context
        const rect = el.getBoundingClientRect();
        // @ts-ignore - browser context
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        // @ts-ignore - browser context
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= viewportHeight &&
          rect.right <= viewportWidth
        );
      }).catch(() => false);

      if (!isInViewport) {
        logger.debug('[COMMAND_EXECUTOR] Element not in viewport, using manual scroll');

        // Strategy 3: Manual scroll using JavaScript
        await locator.evaluate((el) => {
          // @ts-ignore - browser context
          const rect = el.getBoundingClientRect();
          // @ts-ignore - browser context
          const elementTop = rect.top + window.scrollY;
          // @ts-ignore - browser context
          const elementLeft = rect.left + window.scrollX;

          // Scroll to element with some offset from top
          const offset = 100; // Leave some space from top
          // @ts-ignore - browser context
          window.scrollTo({
            top: elementTop - offset,
            left: elementLeft,
            behavior: 'instant', // 'instant' more reliable than 'smooth' in headless
          });
        });

        // Wait a bit for smooth scroll to complete
        await this.page.waitForTimeout(300);

        // Strategy 4: If still not in viewport, try scrollIntoView with block: 'center'
        const stillNotInViewport = await locator.evaluate((el) => {
          // @ts-ignore - browser context
          const rect = el.getBoundingClientRect();
          // @ts-ignore - browser context
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
          // @ts-ignore - browser context
          const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

          return !(
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= viewportHeight &&
            rect.right <= viewportWidth
          );
        }).catch(() => true);

        if (stillNotInViewport) {
          logger.debug('[COMMAND_EXECUTOR] Still not in viewport, using scrollIntoView with block: center');
          await locator.evaluate((el) => {
            // @ts-ignore - browser context
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          });
          await this.page.waitForTimeout(300);
        }
      }
    } catch (error) {
      // If all scroll strategies fail, log but don't throw - element might still be clickable
      logger.warn('[COMMAND_EXECUTOR] Failed to force scroll into view', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * ✅ Overlay/interception guard: Ensure element is topmost at its center point
   * Prevents clicks on elements that are covered by overlays, modals, sticky headers, etc.
   * @param locator The locator to check
   * @param timeout Maximum time to wait for element to become topmost (default: 2000ms)
   * @throws Error if element is not topmost after timeout
   */
  private async ensureTopMostAtCenter(locator: Locator, timeout: number = 2000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 250;
    // Use a temporary data attribute to identify the element inside browser context
    // (ElementHandle cannot be compared by reference across evaluate boundary)
    const marker = `data-agent-topmost-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      await locator.evaluate((el, attr) => el.setAttribute(attr, '1'), marker);
    } catch {
      // If we can't set attribute (e.g., SVG, iframe cross-origin) — skip overlay check silently
      logger.debug('[COMMAND_EXECUTOR] Cannot set topmost marker, skipping overlay check');
      return;
    }

    // Deterministic obstacle-clear (regression path): we attempt to dismiss a
    // BLOCKING overlay AT MOST ONCE per call, only when the target is actually
    // covered. This unblocks unexpected modals/cookie banners/onboarding that
    // would otherwise fail the step, WITHOUT disturbing steps that legitimately
    // target a modal (if the step's own element is the modal, it IS topmost and
    // we never enter the clear branch). `flow` mode is conservative — it never
    // touches sticky headers/footers, chat widgets, tooltips, toasts or
    // unclassified containers (see OverlayDismisser.filterDismissible). Fail-open:
    // any error in the clear path leaves the original timeout/throw behaviour.
    let obstacleClearTried = false;

    try {
      while (Date.now() - startTime < timeout) {
        try {
          const box = await locator.boundingBox();
          if (!box) {
            await this.page.waitForTimeout(pollInterval);
            continue;
          }

          const centerX = box.x + box.width / 2;
          const centerY = box.y + box.height / 2;

          const isTopMost = await this.page.evaluate(
            ({ x, y, attr }: { x: number; y: number; attr: string }) => {
              // @ts-ignore - browser context
              const elementAtPoint = document.elementFromPoint(x, y);
              if (!elementAtPoint) return false;
              // Walk up from hit element to see if our marked element is an ancestor or self
              // @ts-ignore - browser context
              return elementAtPoint.closest(`[${attr}]`) !== null;
            },
            { x: centerX, y: centerY, attr: marker }
          );

          if (isTopMost) {
            logger.debug('[COMMAND_EXECUTOR] Element is topmost at center point');
            return;
          }

          // Target is covered. Try clearing a blocking overlay once before we
          // keep polling toward the timeout. This is the deterministic
          // "clear-on-block" recovery — no LLM, conservative flow mode.
          if (!obstacleClearTried) {
            obstacleClearTried = true;
            await this.tryClearBlockingOverlay();
            // Loop continues → re-checks topmost on the next iteration.
            continue;
          }

          logger.debug('[COMMAND_EXECUTOR] Element not topmost, waiting...', {
            elapsed: Date.now() - startTime,
          });
          await this.page.waitForTimeout(pollInterval);
        } catch (error) {
          logger.debug('[COMMAND_EXECUTOR] Error checking topmost status', {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.page.waitForTimeout(pollInterval);
        }
      }

      throw new Error(
        `Element is not clickable: it is covered by another element (overlay, modal, sticky header, etc.). ` +
        `Waited ${timeout}ms but the element at the click point is still not the target element.`
      );
    } finally {
      // Always clean up the marker attribute
      await locator.evaluate((el, attr) => el.removeAttribute(attr), marker).catch(() => {});
    }
  }

  /**
   * Best-effort, deterministic clearing of a BLOCKING overlay that is covering
   * the current target. Reuses the LLM-free `OverlayDismisser` in `flow` mode
   * (only modal / cookie_consent / loading_overlay / onboarding / paywall — never
   * sticky chrome, chat widgets, tooltips, toasts, or unclassified containers).
   * One pass, short budget. Fully fail-open: never throws, so the caller's
   * timeout/throw contract is unchanged when nothing can be cleared.
   */
  private async tryClearBlockingOverlay(): Promise<void> {
    // 2-tier escalation, both LANGUAGE-AGNOSTIC (no hardcoded close-word lists).
    // Each tier is best-effort; the method is fully fail-open — a covered target
    // that can't be cleared just falls back to the original timeout/throw in
    // ensureTopMostAtCenter.
    //
    //   Tier 1 (deterministic): OverlayDismisser flow-mode — type-classified
    //           recovery (Escape / click-away / type-specific) for genuinely-
    //           blocking overlays only. Classification is geometry + ARIA based,
    //           not word-matching.
    //   Tier 2 (LLM, last resort, capped): ask the resolver to find a
    //           "close the blocking popup" control and click it. Language- and
    //           structure-agnostic; runs ONLY after tier 1 failed AND at most
    //           `MAX_LLM_OVERLAY_CLEARS` times per run to bound cost/latency.
    //
    // NOTE: a previous text-pattern "generic close-button" tier was REMOVED —
    // it hardcoded close-word lists (close/закрыть/жабу/…) which can never be
    // complete across languages/sites. Structural (tier1) + LLM (tier2) cover
    // the same ground without a brittle wordlist.
    try {
      const { OverlayDismisser } = await import('@/agent/core/lite/exploration/overlay-dismisser');
      const result = await OverlayDismisser.dismissOverlays(this.page, {
        mode: 'flow',
        maxPasses: 1,
        maxTimeMs: 2500,
      });
      const dismissed = result?.attempts?.filter((a) => a.dismissed).length ?? 0;
      if (dismissed > 0) {
        logger.warn('[COMMAND_EXECUTOR] Auto-dismissed a blocking overlay (tier1 deterministic)', {
          dismissed,
          overlaysDetected: result.overlaysDetected,
        });
        return;
      }
    } catch (err) {
      logger.debug('[COMMAND_EXECUTOR] Tier1 overlay clear failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Tier 2 — LLM last resort, capped per run.
    if (this.llmOverlayClears >= CommandExecutor.MAX_LLM_OVERLAY_CLEARS) {
      logger.debug('[COMMAND_EXECUTOR] LLM overlay-clear budget exhausted, skipping tier2');
      return;
    }
    try {
      this.llmOverlayClears++;
      const cleared = await this.clearOverlayWithLLM();
      if (cleared) {
        logger.warn('[COMMAND_EXECUTOR] Auto-dismissed a blocking overlay (tier2 LLM)', {
          llmClearsUsed: this.llmOverlayClears,
        });
      }
    } catch (err) {
      logger.debug('[COMMAND_EXECUTOR] Tier2 LLM overlay clear failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Tier 2 — LLM last resort. Re-resolve a "close the blocking popup" control
   * via the same resolver the self-heal path uses, then click it. Language- and
   * structure-agnostic (no hardcoded close-word list). Capped by the caller.
   * Returns true if it clicked a resolved element.
   */
  private async clearOverlayWithLLM(): Promise<boolean> {
    const { resolveElement } = await import('@/services/testing/ui/preview/element-resolver.service');
    const { collectInteractiveNodes } = await import('./background-dom-collector');
    const nodes = await collectInteractiveNodes(this.page, this.maxDomNodes);
    const res = await resolveElement({
      previewSessionId: 'background',
      mode: 'heal',
      stepDraft: { id: 'overlay-clear', type: 'click', description: 'close or dismiss the blocking popup / modal / cookie banner' } as IntentStep,
      domNodes: nodes,
      pageUrl: this.page.url(),
      includeAlternatives: false,
      // Viewport parity with the heal calls: overlay-coverage math needs the
      // real viewport, especially here where the target IS the overlay layer.
      viewport: this.page.viewportSize() ?? undefined,
    });
    const ref = res.highlight?.find((h) => h.type === 'success')?.ref ?? res.candidates?.[0]?.ref;
    if (res.status !== 'resolved' || !ref) return false;
    await this.page.locator(`[data-agent-ref="${ref}"]`).first().click({ timeout: 2000 }).catch(() => {});
    return true;
  }

  /**
   * ✅ Wait for element to be enabled (not disabled)
   * Checks both the 'disabled' property and 'aria-disabled' attribute (for custom components)
   * @param locator The locator to check
   * @param timeout Maximum time to wait for element to become enabled (default: 5000ms)
   * @throws Error if element is still disabled after timeout
   */
  private async waitForEnabled(locator: Locator, timeout: number = 5000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 250;

    while (Date.now() - startTime < timeout) {
      try {
        // Check if element is enabled (both native and ARIA disabled)
        const isEnabled = await locator.evaluate((el) => {
          // Check native disabled property (for native form elements)
          if ('disabled' in el && (el as any).disabled === true) {
            return false;
          }

          // Check aria-disabled attribute (for custom components)
          const ariaDisabled = el.getAttribute('aria-disabled');
          if (ariaDisabled === 'true') {
            return false;
          }

          // Element is enabled
          return true;
        });

        if (isEnabled) {
          logger.debug('[COMMAND_EXECUTOR] Element is enabled');
          return; // Success
        }

        // Element is still disabled, wait and retry
        logger.debug('[COMMAND_EXECUTOR] Element disabled, waiting...', {
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      } catch (error) {
        // If we can't evaluate, element might be gone
        logger.debug('[COMMAND_EXECUTOR] Error checking enabled status', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.page.waitForTimeout(pollInterval);
      }
    }

    // Timeout reached - element is still disabled
    throw new Error(
      `Element is disabled and cannot be interacted with. ` +
      `Waited ${timeout}ms but the element remained disabled.`
    );
  }

  /**
   * ✅ Wait for select element to have options available
   * Checks that the select element has at least one option element
   * @param locator The select locator to check
   * @param timeout Maximum time to wait for options to appear (default: 5000ms)
   * @param maxRetries Maximum number of retries (default: 3)
   * @throws Error if options don't appear after timeout and retries
   */
  private async isNativeSelectLocator(locator: Locator): Promise<boolean> {
    try {
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
      return tagName === 'select';
    } catch {
      return false;
    }
  }

  /**
   * Click-based select for custom (non-native) dropdowns.
   * Strategy: click trigger to open → find option by text → click option.
   * Uses page-level search to handle portal-rendered menus.
   */
  private async selectFromCustomDropdown(
    locator: Locator,
    value: string,
    timeout: number
  ): Promise<void> {
    // Custom dropdown: click trigger → wait for dropdown to open → find visible option → click option
    await locator.click({ timeout });

    // Wait for any API calls triggered by dropdown open (async options loading)
    await this.waitForFetchIdle(1500);

    // Wait for any ARIA dropdown container to appear (up to 3s), instead of hardcoded 300ms
    // This is resilient to slow networks / animations
    const dropdownOpenedAt = Date.now();
    const dropdownWaitMs = Math.min(timeout, 3000);
    const ariaContainerSelector = '[role="listbox"],[role="menu"],[role="dialog"],[role="combobox"] [role="option"]';
    await this.page
      .locator(ariaContainerSelector)
      .first()
      .waitFor({ state: 'visible', timeout: dropdownWaitMs })
      .catch(() => {
        // Dropdown may be non-ARIA — fall through to text-based strategies
        logger.debug('[COMMAND_EXECUTOR] No ARIA dropdown container appeared after click', {
          elapsedMs: Date.now() - dropdownOpenedAt,
        });
      });

    // Phase 1: Scoped search inside visible ARIA container (safest — avoids same-text elsewhere)
    const containers = [
      this.page.locator('[role="listbox"]:visible'),
      this.page.locator('[role="menu"]:visible'),
    ];

    for (const container of containers) {
      try {
        const isVisible = await container.first().isVisible().catch(() => false);
        if (!isVisible) continue;

        const scopedOpt = container.first().getByText(value, { exact: true }).first();
        await scopedOpt.waitFor({ state: 'visible', timeout: 2000 });
        await scopedOpt.click({ timeout: 2000 });
        return;
      } catch {
        // Try next container
      }
    }

    // Phase 2: Page-level ARIA role search (handles portals)
    const roleStrategies = [
      this.page.getByRole('option', { name: value, exact: true }),
      this.page.getByRole('menuitem', { name: value, exact: true }),
      this.page.getByRole('option', { name: value, exact: false }),
      this.page.getByRole('menuitem', { name: value, exact: false }),
    ];

    for (const strategy of roleStrategies) {
      try {
        const opt = strategy.first();
        await opt.waitFor({ state: 'visible', timeout: 2000 });
        await opt.click({ timeout: 2000 });
        return;
      } catch {
        // Try next
      }
    }

    // Phase 3: Universal text fallback (non-ARIA dropdowns, :visible filters hidden)
    const textStrategies = [
      this.page.getByText(value, { exact: true }).and(this.page.locator(':visible')),
      this.page.getByText(value, { exact: false }).and(this.page.locator(':visible')),
    ];

    for (const strategy of textStrategies) {
      try {
        const opt = strategy.first();
        await opt.waitFor({ state: 'visible', timeout: 2000 });
        await opt.click({ timeout: 2000 });
        return;
      } catch {
        // Try next
      }
    }

    throw new Error(`Could not find option "${value}" in dropdown`);
  }

  private async waitForSelectOptions(locator: Locator, timeout: number = 5000, maxRetries: number = 3): Promise<void> {
    let attempt = 0;
    const backoffMs = 500; // Short backoff between retries

    while (attempt < maxRetries) {
      try {
        const startTime = Date.now();
        const pollInterval = 250;

        while (Date.now() - startTime < timeout) {
          // Check if select has at least one option
          const optionsCount = await locator.locator('option').count();

          if (optionsCount > 0) {
            logger.debug('[COMMAND_EXECUTOR] Select has options available', { optionsCount });
            return; // Success
          }

          // No options yet, wait and retry
          logger.debug('[COMMAND_EXECUTOR] Waiting for select options...', {
            elapsed: Date.now() - startTime,
            attempt: attempt + 1,
          });
          await this.page.waitForTimeout(pollInterval);
        }

        // Timeout reached for this attempt - retry with backoff
        logger.debug('[COMMAND_EXECUTOR] No options found, retrying with backoff', {
          attempt: attempt + 1,
          maxRetries,
        });
        await this.page.waitForTimeout(backoffMs);
        attempt++;
      } catch (error) {
        logger.debug('[COMMAND_EXECUTOR] Error checking select options', {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
        });
        await this.page.waitForTimeout(backoffMs);
        attempt++;
      }
    }

    // All retries exhausted - select has no options
    throw new Error(
      `Select element has no options available. ` +
      `Waited ${timeout}ms with ${maxRetries} retries but no <option> elements appeared.`
    );
  }

  /**
   * ✅ Ensure element has focus before pressing keys
   * Verifies that document.activeElement is the target element
   * @param locator The locator to focus
   * @param timeout Maximum time to wait for focus (default: 2000ms)
   * @throws Error if element cannot be focused after timeout
   */
  private async ensureFocused(locator: Locator, timeout: number = 2000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 250;
    let lastError: string | undefined;

    while (Date.now() - startTime < timeout) {
      try {
        // Focus the element
        await locator.focus({ timeout: 1000 });

        // Wait a bit for focus to take effect
        await this.page.waitForTimeout(100);

        // Verify that the element is now the active element
        const isFocused = await this.page.evaluate(
          (targetElement) => {
            // @ts-ignore - browser context
            return document.activeElement === targetElement;
          },
          await locator.elementHandle()
        );

        if (isFocused) {
          logger.debug('[COMMAND_EXECUTOR] Element has focus');
          return; // Success
        }

        lastError = 'Element is not document.activeElement after focus() call';
        logger.debug('[COMMAND_EXECUTOR] Element not focused, retrying...', {
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger.debug('[COMMAND_EXECUTOR] Error focusing element', {
          error: lastError,
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      }
    }

    // Timeout reached - element cannot be focused
    throw new Error(
      `Element cannot be focused for press action. ` +
      `Waited ${timeout}ms but the element is not document.activeElement. ` +
      `Last error: ${lastError || 'unknown'}`
    );
  }

  /**
   * Lightweight fetch/xhr idle wait — attaches listeners, polls until
   * no pending requests for QUIET_MS, then cleans up.
   * Used after dropdown trigger clicks where options may load from server.
   */
  private async waitForFetchIdle(timeoutMs: number): Promise<void> {
    const QUIET_MS = 200;
    let pending = 0;
    let lastActivity = Date.now() - QUIET_MS;

    const onRequest = (req: { resourceType: () => string }) => {
      const type = req.resourceType();
      if (type === 'fetch' || type === 'xhr') {
        pending++;
        lastActivity = Date.now();
      }
    };
    const onDone = (req: { resourceType: () => string }) => {
      const type = req.resourceType();
      if (type === 'fetch' || type === 'xhr') {
        pending = Math.max(0, pending - 1);
        lastActivity = Date.now();
      }
    };

    this.page.on('request', onRequest);
    this.page.on('requestfinished', onDone);
    this.page.on('requestfailed', onDone);

    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pending === 0 && (Date.now() - lastActivity) >= QUIET_MS) {
          return;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      try {
        this.page.off('request', onRequest);
        this.page.off('requestfinished', onDone);
        this.page.off('requestfailed', onDone);
      } catch {
        // Page may be closed
      }
    }
  }
}
