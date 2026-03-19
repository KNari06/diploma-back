/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COMMAND EXECUTOR — Maps LLM Commands to Playwright Actions
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Bridge between the Executor agent's tool_calls and the existing
 * ActionExecutor (which wraps Playwright). Handles:
 *
 * - ALL 12 Playwright actions: click, fill, press, goto, scroll, select, hover, wait, toggle, setRange, clear, selectDate
 * - Deterministic safety checks (ref validation, navigation security)
 * - Credential auto-injection (never sends real creds to LLM)
 * - GoalDetector integration (progress scoring in observe_page)
 * - GraphBuilder integration (emit action nodes for visualization)
 * - Error collection (console/network errors enriched in output)
 * - Clarification gates (payment, file upload, download detection)
 * - Trace logging via LiteTraceWriter
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';
import { buildSnapshotSummary } from '../analysis/ai-goal-evaluator';
import { isDownloadText, isFileUploadTarget, isPaymentContext } from '../analysis/clarification-gates';
import { classifyField } from '../analysis/field-classifier';
import type { GoalDetector } from '../analysis/goal-detector';
import { SnapshotCollector } from '../collectors/snapshot-collector';
import type { ConsoleCollector } from '../collectors/console-collector';
import type { NetworkTracker } from '../collectors/network-tracker';
import { VisualStability } from '../collectors/visual-stability';
import { ActionExecutor } from '../execution/action-executor';
import type { AICommand, GoalContext, LiteSnapshot, StuckCheck } from '../lite-types';
import type { DynamicAction } from '@/agent/types/intelligent-testing.types';
import type { GraphBuilder, GraphActionResult } from '@/agent/utils/visualization/graph-builder.service';
import type { LiteTraceWriter } from '../trace/lite-trace-writer';
import { shouldRedactField } from '../analysis/field-classifier';
import { TestBlackboard } from './blackboard';
import type { CommandName, CommandResult, PipelineConfig } from './types';

/**
 * External integrations passed from TestPipeline.
 * These connect to existing LiteEngine subsystems.
 */
export interface CommandExecutorIntegrations {
  goalDetector?: GoalDetector;
  graphBuilder?: GraphBuilder;
  traceWriter?: LiteTraceWriter;
  networkTracker?: NetworkTracker;
  consoleCollector?: ConsoleCollector;
}

export class CommandExecutor {
  constructor(
    private page: Page,
    private actionExecutor: ActionExecutor,
    private config: PipelineConfig,
    private blackboard: TestBlackboard,
    private integrations: CommandExecutorIntegrations = {},
  ) {}

  /**
   * Execute a single Playwright command.
   * 1. Run deterministic safety checks
   * 2. Map to AICommand format
   * 3. Execute via ActionExecutor
   * 4. Update Blackboard + emit graph/trace
   * 5. Return structured result for LLM
   */
  async execute(commandName: string, args: Record<string, any>): Promise<CommandResult> {
    const name = commandName as CommandName;
    const startMs = Date.now();

    try {
      let result: CommandResult;

      switch (name) {
        case 'observe_page':
          result = await this.observePage();
          break;
        case 'fill_field':
          result = await this.fillField(args);
          break;
        case 'click_element':
          result = await this.clickElement(args);
          break;
        case 'select_option':
          result = await this.selectOption(args);
          break;
        case 'press_key':
          result = await this.pressKey(args);
          break;
        case 'hover_element':
          result = await this.hoverElement(args);
          break;
        case 'scroll_page':
          result = await this.scrollPage(args);
          break;
        case 'scroll_to_element':
          result = await this.scrollToElement(args);
          break;
        case 'navigate_to':
          result = await this.navigateTo(args);
          break;
        case 'wait_for_page':
          result = await this.waitForPage(args);
          break;
        case 'mark_done':
          result = this.markDone(args);
          break;
        case 'report_blocked':
          result = this.reportBlocked(args);
          break;
        case 'toggle_element':
          result = await this.toggleElement(args);
          break;
        case 'set_range':
          result = await this.setRange(args);
          break;
        case 'select_date':
          result = await this.selectDate(args);
          break;
        case 'clear_field':
          result = await this.clearField(args);
          break;
        default:
          result = { success: false, output: '', error: `Unknown command: ${commandName}` };
      }

      // Trace command execution
      this.traceCommand(name, args, result, Date.now() - startMs);

      // Emit graph action node (for non-meta commands)
      this.emitGraphActionNode(name, args, result, Date.now() - startMs);

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[CMD_EXECUTOR] Command error', { command: commandName, error: errorMsg });
      const result = { success: false, output: '', error: `Command failed: ${errorMsg}` };
      this.traceCommand(name, args, result, Date.now() - startMs);
      return result;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OBSERVE PAGE — Collects snapshot, runs GoalDetector, enriches with errors
  // ═══════════════════════════════════════════════════════════════════════

  private async observePage(): Promise<CommandResult> {
    try {
      const snapshot = await SnapshotCollector.collect(this.page);
      const formatted = SnapshotCollector.format(snapshot);

      // Update blackboard with current page state (all agents can read)
      this.blackboard.setCurrentSnapshot(formatted, snapshot.url, snapshot);

      // GoalDetector integration: run heuristic progress scoring
      let progressInfo = '';
      if (this.integrations.goalDetector) {
        try {
          // Build a GoalContext with all required fields
          // Some fields are simplified since we don't have full iteration state in the pipeline
          const goalContext: GoalContext = {
            goal: this.blackboard.getGoal(),
            page: { url: snapshot.url, title: snapshot.title },
            snapshotSummary: buildSnapshotSummary(snapshot.elements),
            history: this.blackboard.formatHistoryForPrompt(),
            stuckCheck: { stuck: false } as StuckCheck,
            consecutiveStuckCount: 0,
            recentErrors: [],
            iteration: this.blackboard.getRounds().length + 1,
          };
          const goalCheck = this.integrations.goalDetector.detectHeuristic(goalContext);
          // GoalDetectionResult.progressScore is 0-1, Blackboard expects 0-100
          const progressPct = Math.round((goalCheck.progressScore || 0) * 100);
          // ✅ FIX: Allow score to decrease on significant regression (>30% drop),
          // but prevent minor oscillation. Previously strictly monotonic, which meant
          // a false high score (e.g. 85%) would persist even on error pages.
          const currentProgress = this.blackboard.getProgressScore();
          if (progressPct > currentProgress) {
            this.blackboard.setProgressScore(progressPct);
          } else if (currentProgress - progressPct > 30) {
            // Significant regression (e.g. navigated to error page) — allow decrease
            this.blackboard.setProgressScore(progressPct);
          }
          if (progressPct > 0) {
            progressInfo = `\nPROGRESS: ${progressPct}%`;
          }
        } catch {
          // GoalDetector failure is non-critical
        }
      }

      // Enrich with network activity state
      let networkInfo = '';
      if (this.integrations.networkTracker) {
        try {
          const networkState = this.integrations.networkTracker.getNetworkActivityState();
          if (networkState.hasPendingRequests || networkState.asyncWorkTriggered) {
            const pending = networkState.hasPendingRequests ? 'pending requests' : '';
            const recent = networkState.recentRequests.length > 0
              ? `${networkState.recentRequests.length} recent requests`
              : '';
            const parts = [pending, recent].filter(Boolean).join(', ');
            networkInfo = `\nNETWORK: active (${parts})`;
          }
        } catch {
          // Non-critical
        }
      }

      // Enrich with recent console errors (helps LLM detect issues)
      let consoleInfo = '';
      if (this.integrations.consoleCollector) {
        try {
          const errorCount = this.integrations.consoleCollector.getErrorCount();
          if (errorCount > 0) {
            const recentErrors = this.integrations.consoleCollector.getFormattedErrors(3);
            if (recentErrors !== 'No console errors') {
              consoleInfo = `\nCONSOLE ERRORS:\n${recentErrors}`;
            }
          }
        } catch {
          // Non-critical
        }
      }

      // Emit graph page node for page observation
      if (this.integrations.graphBuilder) {
        try {
          const pageUpdate = this.integrations.graphBuilder.addPageNode(
            snapshot.url,
            'unknown',
            {
              title: snapshot.title,
              dom: {
                formsCount: snapshot.elements.filter(el => el.tag === 'form').length,
                buttonsCount: snapshot.elements.filter(el => el.role === 'button' || el.tag === 'button').length,
                linksCount: snapshot.elements.filter(el => el.tag === 'a').length,
                inputsCount: snapshot.elements.filter(el => el.tag === 'input' || el.tag === 'textarea').length,
              },
            },
          );
          // We don't emit page updates via WS here — the pipeline handles that
          // But we record the graph node for the final graph
          void pageUpdate;
        } catch {
          // Non-critical
        }
      }

      return {
        success: true,
        output: formatted + progressInfo + networkInfo + consoleInfo,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, output: '', error: `Failed to observe page: ${errorMsg}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FILL FIELD — With credential override for sensitive fields
  // ═══════════════════════════════════════════════════════════════════════

  private async fillField(args: Record<string, any>): Promise<CommandResult> {
    const { ref, value, is_sensitive } = args;

    if (!ref) {
      return { success: false, output: '', error: 'Missing required parameter: ref' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    // Build AICommand
    let command: AICommand = {
      action: 'fill',
      ref,
      value: value || '',
      isSensitive: is_sensitive ?? false,
    };

    // Credential override: replace placeholder with real credentials
    command = this.overrideCredentialFillValue(command);

    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);

    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const fieldDesc = element ? `"${element.name || element.type || element.tag}"` : ref;
      return {
        success: true,
        output: `Filled ${fieldDesc} with ${is_sensitive ? '[CREDENTIALS]' : `"${value}"`}`,
      };
    }

    return {
      success: false,
      output: '',
      error: result.error || `Failed to fill field ${ref}`,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLICK ELEMENT — With clarification gates for payment/download
  // ═══════════════════════════════════════════════════════════════════════

  private async clickElement(args: Record<string, any>): Promise<CommandResult> {
    const { ref } = args;

    if (!ref) {
      return { success: false, output: '', error: 'Missing required parameter: ref' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    // Clarification gate: detect payment context before click
    const element = snapshot.elements.find(el => el.ref === ref);
    const targetText = element?.name || '';
    if (isPaymentContext(snapshot, targetText)) {
      this.blackboard.addInsight(`Payment context detected on "${targetText}" — flagged for user`);
      return {
        success: false,
        output: '',
        error: `Payment action detected on "${targetText}". Payment forms require user approval. report_blocked if needed.`,
      };
    }

    // Clarification gate: detect file upload
    if (isFileUploadTarget(ref, snapshot)) {
      this.blackboard.addInsight(`File upload input detected at ${ref} — cannot automate`);
      return {
        success: false,
        output: '',
        error: `File upload detected at ${ref}. File uploads cannot be automated. Skip this step or report_blocked.`,
      };
    }

    // Clarification gate: detect download action
    if (isDownloadText(targetText)) {
      this.blackboard.addInsight(`Download action detected on "${targetText}" — flagged`);
      return {
        success: false,
        output: '',
        error: `Download action detected on "${targetText}". Downloads require user approval. Skip or report_blocked.`,
      };
    }

    const command: AICommand = { action: 'click', ref };
    const result = await this.actionExecutor.execute(command, snapshot);

    if (result.success) {
      const elementDesc = element ? `"${element.name || element.role}" (${element.tag})` : ref;
      const postAction = await this.collectPostActionContext(ref);
      return { success: true, output: `Clicked ${elementDesc}${postAction}` };
    }

    return { success: false, output: '', error: result.error || `Failed to click ${ref}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SELECT OPTION
  // ═══════════════════════════════════════════════════════════════════════

  private async selectOption(args: Record<string, any>): Promise<CommandResult> {
    const { ref, value } = args;

    if (!ref || !value) {
      return { success: false, output: '', error: 'Missing required parameters: ref, value' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'select', ref, value };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);

    if (result.success) {
      const postAction = await this.collectPostActionContext(ref);
      return { success: true, output: `Selected "${value}" from dropdown ${ref}${postAction}` };
    }

    return { success: false, output: '', error: result.error || `Failed to select "${value}" in ${ref}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HOVER ELEMENT — Trigger tooltips, dropdown menus
  // ═══════════════════════════════════════════════════════════════════════

  private async hoverElement(args: Record<string, any>): Promise<CommandResult> {
    const { ref } = args;

    if (!ref) {
      return { success: false, output: '', error: 'Missing required parameter: ref' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'hover', ref };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);

    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const elementDesc = element ? `"${element.name || element.role}" (${element.tag})` : ref;
      return { success: true, output: `Hovered over ${elementDesc}` };
    }

    return { success: false, output: '', error: result.error || `Failed to hover ${ref}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRESS KEY
  // ═══════════════════════════════════════════════════════════════════════

  private async pressKey(args: Record<string, any>): Promise<CommandResult> {
    const { key } = args;

    if (!key) {
      return { success: false, output: '', error: 'Missing required parameter: key' };
    }

    const command: AICommand = { action: 'press', key };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    const safeSnapshot = snapshot || { elements: [], url: '', title: '', timestamp: Date.now() } as LiteSnapshot;

    const result = await this.actionExecutor.execute(command, safeSnapshot);

    if (result.success) {
      // Enter key often submits forms — collect post-action context
      const postAction = key.toLowerCase() === 'enter'
        ? await this.collectPostActionContext()
        : '';
      return { success: true, output: `Pressed key "${key}"${postAction}` };
    }

    return { success: false, output: '', error: result.error || `Failed to press "${key}"` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCROLL PAGE (by amount)
  // ═══════════════════════════════════════════════════════════════════════

  private async scrollPage(args: Record<string, any>): Promise<CommandResult> {
    const direction = args.direction || 'down';
    const amount = args.amount || 600;

    const command: AICommand = { action: 'scroll', direction, amount };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    const safeSnapshot = snapshot || { elements: [], url: '', title: '', timestamp: Date.now() } as LiteSnapshot;

    const result = await this.actionExecutor.execute(command, safeSnapshot);

    if (result.success) {
      return { success: true, output: `Scrolled ${direction} by ${amount}px` };
    }

    return { success: false, output: '', error: result.error || `Failed to scroll ${direction}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCROLL TO ELEMENT (scroll ref into view)
  // ═══════════════════════════════════════════════════════════════════════

  private async scrollToElement(args: Record<string, any>): Promise<CommandResult> {
    const { ref } = args;

    if (!ref) {
      return { success: false, output: '', error: 'Missing required parameter: ref' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'scroll', targetRef: ref };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);

    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const elementDesc = element ? `"${element.name || element.tag}"` : ref;
      return { success: true, output: `Scrolled ${elementDesc} into view` };
    }

    return { success: false, output: '', error: result.error || `Failed to scroll ${ref} into view` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NAVIGATE TO — With external origin security check
  // ═══════════════════════════════════════════════════════════════════════

  private async navigateTo(args: Record<string, any>): Promise<CommandResult> {
    const { url } = args;

    if (!url) {
      return { success: false, output: '', error: 'Missing required parameter: url' };
    }

    const securityCheck = this.checkNavigationSecurity(url);
    if (!securityCheck.allowed) {
      return { success: false, output: '', error: securityCheck.reason! };
    }

    const command: AICommand = { action: 'goto', url };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    const safeSnapshot = snapshot || { elements: [], url: '', title: '', timestamp: Date.now() } as LiteSnapshot;

    const result = await this.actionExecutor.execute(command, safeSnapshot);

    if (result.success) {
      const postAction = await this.collectPostActionContext();
      return { success: true, output: `Navigated to ${url}${postAction}` };
    }

    return { success: false, output: '', error: result.error || `Failed to navigate to ${url}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WAIT FOR PAGE — With network idle + visual stability
  // ═══════════════════════════════════════════════════════════════════════

  private async waitForPage(args: Record<string, any>): Promise<CommandResult> {
    const reason = args.reason || 'waiting for page to settle';

    try {
      // 1. Wait for visual stability (DOM mutations settled)
      await VisualStability.waitForStable(this.page);

      // 2. Wait for network idle if tracker available
      if (this.integrations.networkTracker) {
        try {
          await this.integrations.networkTracker.waitForNetworkIdle(3000);
        } catch {
          // Network idle timeout is non-critical
        }
      }

      // 3. Short additional wait for post-render JS
      await this.page.waitForTimeout(500);

      return { success: true, output: `Page settled (${reason})` };
    } catch {
      // Timeout is not a failure — page might just be slow
      return { success: true, output: `Wait completed (may still be loading): ${reason}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOGGLE ELEMENT (switches, checkboxes, radio buttons)
  // ═══════════════════════════════════════════════════════════════════════

  private async toggleElement(args: Record<string, any>): Promise<CommandResult> {
    const { ref } = args;

    if (!ref) {
      return { success: false, output: '', error: 'Missing required parameter: ref' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'toggle', ref };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);
    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const elementDesc = element ? `"${element.name || element.role}" (${element.tag})` : ref;
      const postAction = await this.collectPostActionContext(ref);
      return { success: true, output: `Toggled ${elementDesc}${postAction}` };
    }

    return { success: false, output: '', error: result.error || `Failed to toggle ${ref}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SET RANGE (slider/range input)
  // ═══════════════════════════════════════════════════════════════════════

  private async setRange(args: Record<string, any>): Promise<CommandResult> {
    const { ref, value } = args;

    if (!ref || value === undefined) {
      return { success: false, output: '', error: 'Missing required parameters: ref, value' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'setRange', ref, value: String(value) };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);
    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const elementDesc = element ? `"${element.name || element.role}" (${element.tag})` : ref;
      return { success: true, output: `Set range ${elementDesc} to ${value}` };
    }

    return { success: false, output: '', error: result.error || `Failed to set range ${ref} to ${value}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SELECT DATE (date/time/datetime-local inputs)
  // ═══════════════════════════════════════════════════════════════════════

  private async selectDate(args: Record<string, any>): Promise<CommandResult> {
    const { ref, value } = args;

    if (!ref || !value) {
      return { success: false, output: '', error: 'Missing required parameters: ref, value' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'selectDate', ref, value };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);
    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const elementDesc = element ? `"${element.name || element.role}" (${element.tag})` : ref;
      return { success: true, output: `Set date ${elementDesc} to "${value}"` };
    }

    return { success: false, output: '', error: result.error || `Failed to set date ${ref} to ${value}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLEAR FIELD (clear input value)
  // ═══════════════════════════════════════════════════════════════════════

  private async clearField(args: Record<string, any>): Promise<CommandResult> {
    const { ref } = args;

    if (!ref) {
      return { success: false, output: '', error: 'Missing required parameter: ref' };
    }

    const refCheck = this.checkRefExists(ref);
    if (!refCheck.valid) {
      return { success: false, output: '', error: refCheck.error! };
    }

    const command: AICommand = { action: 'clear', ref };
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { success: false, output: '', error: 'No page snapshot available. Call observe_page first.' };
    }

    const result = await this.actionExecutor.execute(command, snapshot);
    if (result.success) {
      const element = snapshot.elements.find(el => el.ref === ref);
      const elementDesc = element ? `"${element.name || element.role}" (${element.tag})` : ref;
      return { success: true, output: `Cleared ${elementDesc}` };
    }

    return { success: false, output: '', error: result.error || `Failed to clear ${ref}` };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TERMINAL COMMANDS
  // ═══════════════════════════════════════════════════════════════════════

  private markDone(args: Record<string, any>): CommandResult {
    return {
      success: true,
      output: `Goal achieved: ${args.reason || 'completed'}. Evidence: ${args.evidence || 'none provided'}`,
      done: true,
    };
  }

  private reportBlocked(args: Record<string, any>): CommandResult {
    const reason = args.reason || 'unknown blocker';
    const blockerType = args.blocker_type || 'other';
    const canUserHelp = args.can_user_help ?? true;

    // Add insight with blocker details for reporting
    this.blackboard.addInsight(
      `BLOCKED [${blockerType}]: ${reason}` +
      (canUserHelp ? ' (user can help unblock)' : ' (permanently blocked)'),
    );

    return {
      success: true,
      output: `Test blocked: ${reason} [type: ${blockerType}, user_help: ${canUserHelp}]`,
      blocked: true,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POST-ACTION CONTEXT (lightweight signals for AI self-verification)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Collect lightweight post-action context after state-changing commands.
   * Gives the Executor LLM raw signals (page alerts, URL change, element removal)
   * so IT can decide whether to observe_page, retry, or continue.
   *
   * NOT a full snapshot — just fast DOM queries (~20-50ms).
   * The AI agent reads these signals and decides the next action.
   */
  private async collectPostActionContext(ref?: string): Promise<string> {
    const parts: string[] = [];
    try {
      // 1. URL change detection (instant — no DOM query)
      const currentUrl = this.page.url();
      const bbUrl = this.blackboard.getCurrentUrl();
      if (bbUrl && currentUrl !== bbUrl) {
        parts.push(`URL changed: ${currentUrl}`);
      }

      // 2. Page alerts — validation errors, auth failures, toast messages
      //    Fast inline evaluate, NOT full SnapshotCollector
      const alerts = await this.page.evaluate(`
        (() => {
          const alertEls = document.querySelectorAll(
            '[role="alert"], [aria-live="assertive"], [aria-live="polite"], ' +
            '.error, .alert, .validation-error, .form-error, .field-error, ' +
            '[class*="error-message"], [class*="validation"], [data-error]'
          );
          const texts = [];
          alertEls.forEach(el => {
            const text = el.innerText && el.innerText.trim();
            if (text && text.length > 0 && text.length < 200) texts.push(text);
          });
          return [...new Set(texts)].slice(0, 3);
        })()
      `).catch(() => []) as string[];

      if (alerts.length > 0) {
        parts.push(`PAGE ALERTS: ${alerts.map(a => `"${a}"`).join(', ')}`);
      }

      // 3. Check if target element still exists (form submit may remove it)
      if (ref) {
        const exists = await this.page.locator(`[data-agent-ref="${ref}"]`).count().catch(() => 0);
        if (exists === 0) {
          parts.push(`Target element ${ref} removed from page`);
        }
      }
    } catch {
      // Non-critical — return whatever we collected
    }
    return parts.length > 0 ? `\n[POST-ACTION: ${parts.join(' | ')}]` : '';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SAFETY CHECKS (deterministic, <1ms, no AI)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Validate that a ref exists in the current page snapshot.
   * Prevents hallucinated refs from causing Playwright errors.
   */
  private checkRefExists(ref: string): { valid: boolean; error?: string } {
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) {
      return { valid: false, error: 'No page snapshot available. Call observe_page first.' };
    }

    const element = snapshot.elements.find(el => el.ref === ref);
    if (!element) {
      const availableRefs = snapshot.elements
        .slice(0, 20)
        .map(el => `${el.ref}(${el.tag}${el.name ? ':' + el.name.slice(0, 20) : ''})`)
        .join(', ');
      return {
        valid: false,
        error: `Element ref "${ref}" not found on page. Available: ${availableRefs}`,
      };
    }

    if (element.disabled) {
      return { valid: false, error: `Element ${ref} is disabled and cannot be interacted with.` };
    }

    return { valid: true };
  }

  /**
   * Check navigation security — block external origins.
   */
  private checkNavigationSecurity(url: string): { allowed: boolean; reason?: string } {
    try {
      const targetOrigin = new URL(url).origin;
      const goalOrigin = new URL(this.blackboard.getUrl()).origin;
      const currentUrl = this.blackboard.getCurrentUrl();
      const currentOrigin = currentUrl ? new URL(currentUrl).origin : goalOrigin;

      if (targetOrigin !== currentOrigin && targetOrigin !== goalOrigin) {
        return {
          allowed: false,
          reason: `Navigation to external origin blocked: ${targetOrigin} (test site: ${goalOrigin}). Use on-page links instead.`,
        };
      }

      return { allowed: true };
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }
  }

  /**
   * Override fill value for credential fields.
   * SECURITY: Never sends real credentials to LLM — backend injects correct values.
   * Uses shared field classifier (3-level hierarchy).
   */
  private overrideCredentialFillValue(command: AICommand): AICommand {
    if (command.action !== 'fill' || !command.ref) return command;
    if (!this.config.credentials) return command;

    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) return command;

    const element = snapshot.elements.find(el => el.ref === command.ref);
    if (!element) return command;

    const classification = classifyField(element);

    // If LLM marked as sensitive but classifier found no kind:
    // - Classifier with HIGH confidence it's NOT a credential → trust classifier, skip override
    // - Classifier with LOW/MEDIUM confidence → trust LLM's is_sensitive, fall through to generic override
    if (command.isSensitive && !classification.kind) {
      if (classification.confidence === 'high') {
        return command; // Classifier is confident this is NOT a credential field
      }
      // Low/medium classifier confidence + LLM says sensitive → fall through to generic override at end
    }

    if (!classification.kind && !command.isSensitive) return command;

    const { credentials } = this.config;

    switch (classification.kind) {
      case 'password':
        logger.debug('[CMD_EXECUTOR] Overriding password field', { ref: command.ref });
        return { ...command, value: credentials.password };

      case 'phone':
        if (credentials.phone) {
          logger.debug('[CMD_EXECUTOR] Overriding phone field', { ref: command.ref });
          return { ...command, value: credentials.phone };
        }
        break;

      case 'email':
        if (credentials.email) {
          logger.debug('[CMD_EXECUTOR] Overriding email field', { ref: command.ref });
          return { ...command, value: credentials.email };
        }
        break;

      case 'username': {
        const usernameValue = credentials.username || credentials.email || credentials.phone;
        if (usernameValue) {
          logger.debug('[CMD_EXECUTOR] Overriding username field', { ref: command.ref });
          return { ...command, value: usernameValue };
        }
        break;
      }
    }

    // Generic sensitive: fallback to email
    if (command.isSensitive && !classification.kind && credentials.email) {
      return { ...command, value: credentials.email };
    }

    return command;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRACE LOGGING (fire-and-forget, never breaks execution)
  // ═══════════════════════════════════════════════════════════════════════

  private traceCommand(
    name: CommandName,
    args: Record<string, any>,
    result: CommandResult,
    durationMs: number,
  ): void {
    try {
      this.integrations.traceWriter?.write({
        iteration: this.blackboard.getRounds().length,
        stage: 'command_execution',
        eventType: 'command_executed',
        spanId: this.integrations.traceWriter.generateSpanId(),
        payload: {
          command: name,
          args: name === 'fill_field' && args.is_sensitive
            ? { ...args, value: '[REDACTED]' }
            : args,
          success: result.success,
          error: result.error,
          done: result.done,
          blocked: result.blocked,
          durationMs,
        },
      });
    } catch {
      // Never break execution for trace failures
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GRAPH BUILDER INTEGRATION (emit action nodes for visualization)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Emit a graph action node for browser commands.
   * Skips meta-commands (observe_page, wait_for_page, mark_done, report_blocked).
   * Uses the same DynamicAction/GraphActionResult types as the old LiteEngine.
   */
  private emitGraphActionNode(
    name: CommandName,
    args: Record<string, any>,
    result: CommandResult,
    durationMs: number,
  ): void {
    if (!this.integrations.graphBuilder) return;

    // Skip meta-commands that don't represent user-visible actions
    const skipForGraph: CommandName[] = ['observe_page', 'wait_for_page', 'mark_done', 'report_blocked'];
    if (skipForGraph.includes(name)) return;

    try {
      const snapshot = this.blackboard.getCurrentPageSnapshot();

      // Build DynamicAction (matching existing intelligent-testing.types)
      const dynamicAction = this.toDynamicAction(name, args, snapshot);
      if (!dynamicAction) return;

      // Build GraphActionResult
      const graphResult: GraphActionResult = {
        success: result.success,
        error: result.error,
        durationMs,
        urlChanged: false, // We don't have before/after URL diff per command
        isTimeout: result.error?.toLowerCase().includes('timeout') ?? false,
      };

      const graphUpdate = this.integrations.graphBuilder.addActionNode(dynamicAction, graphResult);
      // Graph updates are batched — the pipeline's emitGraphUpdateWs handles WebSocket emission
      void graphUpdate;
    } catch {
      // Non-critical
    }
  }

  /**
   * Convert a pipeline PlaywrightCommand to DynamicAction for GraphBuilder.
   * Maps command names to action types and builds human-readable descriptions.
   */
  private toDynamicAction(
    name: CommandName,
    args: Record<string, any>,
    snapshot?: LiteSnapshot,
  ): DynamicAction | null {
    const ref = args.ref as string | undefined;
    const element = ref && snapshot ? snapshot.elements.find(el => el.ref === ref) : undefined;
    const elementDesc = element ? (element.name || element.placeholder || element.tag || ref) : ref;

    switch (name) {
      case 'fill_field': {
        // SECURITY: Redact credential values
        const isSensitive = args.is_sensitive ?? false;
        const shouldRedact = element ? shouldRedactField(element, isSensitive) : isSensitive;
        const displayValue = shouldRedact ? '[REDACTED]' : (args.value?.slice(0, 20) || '');
        return {
          action: 'fill',
          selector: ref ? `[data-agent-ref="${ref}"]` : undefined,
          value: shouldRedact ? '[REDACTED]' : args.value,
          description: `Fill "${elementDesc}" with "${displayValue}"`,
        };
      }
      case 'click_element':
        return {
          action: 'click',
          selector: ref ? `[data-agent-ref="${ref}"]` : undefined,
          description: `Click "${elementDesc}"`,
        };
      case 'select_option':
        return {
          action: 'select',
          selector: ref ? `[data-agent-ref="${ref}"]` : undefined,
          value: args.value,
          description: `Select "${args.value}" in "${elementDesc}"`,
        };
      case 'press_key':
        return {
          action: 'press',
          description: `Press key "${args.key}"`,
        };
      case 'hover_element':
        return {
          action: 'hover',
          selector: ref ? `[data-agent-ref="${ref}"]` : undefined,
          description: `Hover "${elementDesc}"`,
        };
      case 'scroll_page':
        return {
          action: 'scroll',
          description: `Scroll ${args.direction || 'down'} by ${args.amount || 600}px`,
        };
      case 'scroll_to_element':
        return {
          action: 'scroll',
          selector: ref ? `[data-agent-ref="${ref}"]` : undefined,
          description: `Scroll to "${elementDesc}"`,
        };
      case 'navigate_to':
        return {
          action: 'goto',
          url: args.url,
          description: `Navigate to ${args.url}`,
        };
      default:
        return null;
    }
  }
}
