/**
 * ActionExecutor
 * Executes AI commands via safe switch/case with fuzzy fallback
 * SECURITY: NO arbitrary code execution - only whitelisted Playwright actions
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { logger } from '@/utils/core/logger';
import {
  MODAL_OVERLAY_SELECTORS,
  POSITIONAL_CANDIDATES_SELECTOR,
  INTERACTIVE_CHILDREN_SELECTOR,
  MODAL_CLASS_REGEX,
  IRON_CLAD_MODAL_SELECTORS,
  CLOSE_BUTTON_SELECTOR,
  LAYER3_FALLBACK_PATTERNS,
} from '@/agent/utils/selectors/modal-detection';
import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import type { Locator, Page } from 'playwright';
import { VisualAnchorManager } from '../analysis/visual-anchor-manager';
import { ShadowDOMHandler } from './shadow-dom-handler';
import type {
  AICommand,
  BlockerInfo,
  ElementInfo,
  ExecutionResult,
  LiteElement,
  LiteSnapshot,
  ModalDismissInfo,
  ObstacleType,
  VisualSignature,
} from '../lite-types';

/**
 * Modal keywords passed from GoalDetector for classification
 */
export interface ModalKeywords {
  unexpectedModalKeywords: string[];
  systemErrorKeywords: string[];
  validationErrorKeywords: string[];
  goalModalKeywords: string[];
  goalKeywords: string[];
}

/**
 * Execution options including modal keywords
 */
export interface ExecuteOptions {
  entryPointKeywords?: string[];
  modalKeywords?: ModalKeywords;
  /**
   * Visual Anchor support: Get signature for fallback lookup
   * Called when ref-based lookup fails
   */
  getSignature?: (ref: string) => VisualSignature | undefined;
  /**
   * Visual Anchor support: Save signature after successful interaction
   * Called with the target element after successful action
   */
  saveSignature?: (ref: string, signature: VisualSignature) => void;
  /**
   * Optional trace hook for detailed action logging
   * Called on key action execution points (without Playwright objects)
   */
  traceHook?: (event: {
    stage: 'validation' | 'execution_start' | 'execution_end' | 'fallback' | 'modal_check';
    action: string;
    success?: boolean;
    error?: string;
    duration?: number;
    details?: Record<string, any>;
  }) => void;
  /**
   * L5 Vision Escalation: Active frame for iframe support
   * If provided, actions will be executed in this frame instead of main page
   */
  activeFrame?: import('playwright').Frame;
}

export class ActionExecutor {
  private page: Page;
  private elementMap: Map<string, ElementInfo> = new Map();

  // ✅ L5: Current execution context (page or frame)
  // Set at the start of each execute() call for iframe support
  private currentContext: Page | import('playwright').Frame;

  // ✅ FIX: Configurable timeouts for different action types
  private readonly DEFAULT_TIMEOUT = 10000; // 10s for most actions (increased from 5s)
  private readonly NAVIGATION_TIMEOUT = 15000; // 15s for actions that may trigger navigation
  private readonly FALLBACK_TIMEOUT = 8000; // 8s for fallback attempts

  // ✅ REMOVED: Hardcoded ENTRY_POINT_KEYWORDS
  // Now passed dynamically via execute() options from GoalDetector's AI-generated strategy

  constructor(page: Page) {
    this.page = page;
    this.currentContext = page;
  }

  /**
   * Execute AI command via safe switch/case
   * NO arbitrary code execution - only whitelisted actions
   *
   * @param command - Structured AI command
   * @param snapshot - Current page snapshot for fallback
   * @param options - Optional execution options (e.g., entryPointKeywords, modalKeywords from AI strategy)
   * @returns Execution result with fallback info and modal dismiss info
   */
  async execute(
    command: AICommand,
    snapshot: LiteSnapshot,
    options?: ExecuteOptions
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let modalDismissInfo: ModalDismissInfo | undefined;

    // ✅ L5: Use active frame if provided (iframe support), otherwise use main page
    this.currentContext = options?.activeFrame || this.page;

    // Build element lookup map for fallback
    snapshot.elements.forEach((el) => {
      this.elementMap.set(el.ref, {
        text: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.name,
        tag: el.tag,
        type: el.type,
        role: el.role, // ✅ FIX: Include role for Phase 0 dropdown selection
      });
    });

    try {
      // Validate command
      this.validateCommand(command);

      // ✅ NEW: Trace validation
      options?.traceHook?.({
        stage: 'validation',
        action: command.action,
        success: true,
        details: {
          ref: command.ref,
          value: command.value ? '[REDACTED]' : undefined,
          url: command.url,
        },
      });

      // ✅ NEW: Trace execution start
      options?.traceHook?.({
        stage: 'execution_start',
        action: command.action,
        details: {
          ref: command.ref,
          target: command.targetRef,
        },
      });

      // Execute command
      await this.executeCommand(command);

      // ✅ NEW: After click, check for unexpected modal and try to dismiss (Lite Autonomy v3)
      if (command.action === 'click' && options?.modalKeywords) {
        options?.traceHook?.({
          stage: 'modal_check',
          action: 'check_unexpected_modal',
          details: {
            hasModalKeywords: true,
          },
        });

        modalDismissInfo = await this.handleUnexpectedModal(options.modalKeywords);

        if (modalDismissInfo?.attempted) {
          options?.traceHook?.({
            stage: 'modal_check',
            action: 'modal_dismiss_attempted',
            success: modalDismissInfo.dismissed,
            details: {
              dismissed: modalDismissInfo.dismissed,
              stillPresent: modalDismissInfo.stillPresent,
              modalType: modalDismissInfo.modalType,
            },
          });
        }
      }

      // ✅ LEGACY: After click on entry point, wait for modal to appear and stabilize
      // Uses dynamic keywords from AI strategy (no hardcoded keywords)
      if (command.action === 'click' && command.ref && !modalDismissInfo?.attempted) {
        const elementInfo = this.elementMap.get(command.ref);
        const dynamicKeywords = options?.entryPointKeywords || [];
        if (elementInfo && this.isEntryPointElement(elementInfo.text || '', dynamicKeywords)) {
          logger.debug('[ACTION_EXECUTOR] Click on entry point detected, waiting for modal', {
            ref: command.ref,
            text: elementInfo.text,
            keywordsUsed: dynamicKeywords.length,
          });
          await this.waitForModalAfterClick();
        }
      }

      logger.info('[ACTION_EXECUTOR] Command executed successfully', {
        action: command.action,
        ref: command.ref,
        modalDismissAttempted: modalDismissInfo?.attempted || false,
        modalDismissed: modalDismissInfo?.dismissed || false,
      });

      // ═══════════════════════════════════════════════════════════════════════
      // VISUAL ANCHOR: Save signature for future fallback (if callback provided)
      // ═══════════════════════════════════════════════════════════════════════
      if (command.ref && options?.saveSignature) {
        const targetElement = snapshot.elements.find(el => el.ref === command.ref);
        if (targetElement) {
          const signature = VisualAnchorManager.createSignature(targetElement, snapshot.elements);
          options.saveSignature(command.ref, signature);
          logger.debug('[ACTION_EXECUTOR] Saved visual signature for element', {
            ref: command.ref,
            anchorCount: signature.anchors.length,
          });
        }
      }

      // ✅ NEW: Trace execution end
      options?.traceHook?.({
        stage: 'execution_end',
        action: command.action,
        success: true,
        duration: Date.now() - startTime,
        details: {
          modalDismissAttempted: modalDismissInfo?.attempted || false,
          modalDismissed: modalDismissInfo?.dismissed || false,
        },
      });

      return {
        success: true,
        duration: Date.now() - startTime,
        startTime,
        modalDismissInfo,
        usedForceClick: false, // Primary execution never uses force
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      logger.warn('[ACTION_EXECUTOR] Command execution failed, trying fallback', {
        action: command.action,
        ref: command.ref,
        error: errorMsg.slice(0, 100),
      });

      // Try fallback for element-based actions
      if (this.isNotFoundError(errorMsg) && command.ref) {
        options?.traceHook?.({
          stage: 'fallback',
          action: 'fuzzy_fallback_attempt',
          details: {
            originalError: errorMsg.slice(0, 100),
            ref: command.ref,
          },
        });

        const fallback = await this.tryFuzzyFallback(command, options, snapshot);
        if (fallback.success) {
          logger.info('[ACTION_EXECUTOR] Fallback successful', {
            info: fallback.info,
            usedForceClick: fallback.usedForceClick,
          });

          options?.traceHook?.({
            stage: 'fallback',
            action: 'fuzzy_fallback_success',
            success: true,
            duration: Date.now() - startTime,
            details: {
              info: fallback.info,
              usedForceClick: fallback.usedForceClick,
            },
          });

          return {
            success: true,
            duration: Date.now() - startTime,
            startTime,
            usedFallback: true,
            fallbackInfo: fallback.info,
            modalDismissInfo: fallback.modalDismissInfo,
            usedForceClick: fallback.usedForceClick,
            blockerInfo: fallback.blockerInfo,
          };
        }
      }

      logger.error('[ACTION_EXECUTOR] Command failed', {
        action: command.action,
        error: errorMsg,
      });

      // ✅ NEW: Trace execution error
      options?.traceHook?.({
        stage: 'execution_end',
        action: command.action,
        success: false,
        error: errorMsg,
        duration: Date.now() - startTime,
      });

      return {
        success: false,
        error: errorMsg,
        duration: Date.now() - startTime,
        startTime,
        modalDismissInfo,
      };
    }
  }

  /**
   * Validate command before execution
   */
  private validateCommand(command: AICommand): void {
    // Validate ref format if present (e-prefix for light DOM, s-prefix for shadow DOM)
    if (command.ref && !/^[es]\d+$/.test(command.ref)) {
      throw new Error(`Invalid ref format: ${command.ref}`);
    }

    // Validate URL schema (supports both absolute and relative URLs)
    if (command.url) {
      try {
        // Try absolute URL first
        const url = new URL(command.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error(`Invalid URL protocol: ${url.protocol}`);
        }
      } catch {
        // ✅ FIX: Try as relative URL with current page as base
        try {
          const baseUrl = this.page.url();
          const url = new URL(command.url, baseUrl);
          if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error(`Invalid URL protocol: ${url.protocol}`);
          }
          // Resolve to absolute URL for execution
          command.url = url.href;
        } catch {
          throw new Error(`Invalid URL: ${command.url}`);
        }
      }
    }

    // Validate required fields
    if (command.action === 'click' && !command.ref) {
      throw new Error('click requires ref');
    }
    if (command.action === 'fill' && (!command.ref || !command.value)) {
      throw new Error('fill requires ref and value');
    }
    if (command.action === 'press' && !command.key) {
      throw new Error('press requires key');
    }
    if (command.action === 'goto' && !command.url) {
      throw new Error('goto requires url');
    }
    if (command.action === 'select' && (!command.ref || !command.value)) {
      throw new Error('select requires ref and value');
    }
    if (command.action === 'hover' && !command.ref) {
      throw new Error('hover requires ref');
    }
    if (command.action === 'toggle' && !command.ref) {
      throw new Error('toggle requires ref');
    }
    if (command.action === 'setRange' && (!command.ref || command.value === undefined)) {
      throw new Error('setRange requires ref and value');
    }
    if (command.action === 'clear' && !command.ref) {
      throw new Error('clear requires ref');
    }
    if (command.action === 'selectDate' && (!command.ref || !command.value)) {
      throw new Error('selectDate requires ref and value (date string)');
    }

    // Validate scroll extras
    if (command.action === 'scroll') {
      if (command.targetRef && !/^[es]\d+$/.test(command.targetRef)) {
        throw new Error(`Invalid targetRef format: ${command.targetRef}`);
      }
      if (command.amount !== undefined) {
        const amount = Number(command.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error(`Invalid scroll amount: ${command.amount}`);
        }
      }
    }
  }

  /**
   * Safe switch/case execution - only whitelisted Playwright methods
   * PHASE B: Pre-scroll to ensure element is in viewport before interaction
   */
  private async executeCommand(cmd: AICommand): Promise<void> {
    const locator = cmd.ref
      ? this.currentContext.locator(`[data-agent-ref="${cmd.ref}"]`)
      : null;

    switch (cmd.action) {
      case 'click':
        if (!locator) throw new Error('click requires ref');
        // ═══════════════════════════════════════════════════════════════════
        // PHASE B: Pre-scroll to ensure element is visible before click
        // ═══════════════════════════════════════════════════════════════════
        await this.ensureElementVisible(locator);
        // ✅ FIX: Use longer timeout for clicks (may trigger navigation/modals)
        await locator.click({ timeout: this.NAVIGATION_TIMEOUT });
        break;

      case 'fill':
        if (!locator || !cmd.value) throw new Error('fill requires ref and value');
        // ═══════════════════════════════════════════════════════════════════
        // PHASE B: Pre-scroll to ensure element is visible before fill
        // ═══════════════════════════════════════════════════════════════════
        await this.ensureElementVisible(locator);

        // ✅ FIX: Detect special input types and route to appropriate handler
        const inputType = await locator.evaluate(
          (el) => (el as HTMLInputElement).type?.toLowerCase() || ''
        ).catch(() => '');

        if (inputType === 'range') {
          // Range inputs: fill()/pressSequentially() don't work — use evaluate
          logger.debug('[ACTION_EXECUTOR] Detected range input, using evaluate to set value');
          await locator.evaluate((el, val) => {
            const input = el as HTMLInputElement;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(input, val);
            } else {
              input.value = val;
            }
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, cmd.value);
        } else if (['date', 'time', 'datetime-local', 'month', 'week'].includes(inputType)) {
          // Date/time inputs: pressSequentially opens calendar UI, fill() is more reliable
          // But even fill() can fail on some frameworks, so use evaluate as primary
          logger.debug('[ACTION_EXECUTOR] Detected date/time input, using evaluate to set value', {
            inputType,
          });
          await locator.evaluate((el, val) => {
            const input = el as HTMLInputElement;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(input, val);
            } else {
              input.value = val;
            }
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, cmd.value);
        } else if (inputType === 'color') {
          // Color inputs: set value directly
          logger.debug('[ACTION_EXECUTOR] Detected color input, using evaluate to set value');
          await locator.evaluate((el, val) => {
            const input = el as HTMLInputElement;
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, cmd.value);
        } else {
          // Standard text-like inputs: use pressSequentially with fill() fallback
          try {
            // First, clear the field
            await locator.clear({ timeout: this.DEFAULT_TIMEOUT });
            // Then type character by character (more realistic)
            await locator.pressSequentially(cmd.value, {
              timeout: this.DEFAULT_TIMEOUT,
              delay: 50, // 50ms between keystrokes (realistic typing speed)
            });
          } catch (error) {
            // Fallback to fill() if pressSequentially() fails
            logger.debug('[ACTION_EXECUTOR] pressSequentially failed, falling back to fill()', {
              error: error instanceof Error ? error.message : String(error),
            });
            await locator.fill(cmd.value, { timeout: this.DEFAULT_TIMEOUT });
          }

          // ✅ FIX BUG 7: Post-fill event reinforcement for Angular/React/Vue reactive forms
          // Framework form controls (especially Angular reactive forms) may not detect
          // Playwright's fill/pressSequentially because they rely on specific DOM events.
          // After typing, verify the value persisted and dispatch framework events if needed.
          try {
            await locator.evaluate((el, val) => {
              const input = el as HTMLInputElement;
              // Only reinforce if value doesn't match what we typed
              // (framework may have eaten the input or validation cleared it)
              if (input.value !== val) {
                // Use nativeInputValueSetter to bypass framework getter/setter
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                )?.set || Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                )?.set;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(input, val);
                } else {
                  input.value = val;
                }
              }
              // Always dispatch events to ensure framework picks up the value:
              // Angular listens for 'input' event via DefaultValueAccessor
              // React uses 'input' + its synthetic event system
              // Vue uses 'input' for v-model
              input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              // Also dispatch blur to trigger validation (Angular validators fire on blur)
              input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
            }, cmd.value);
          } catch (eventError) {
            // Non-critical: event dispatch failure doesn't mean fill failed
            logger.debug('[ACTION_EXECUTOR] Post-fill event reinforcement failed (non-critical)', {
              error: eventError instanceof Error ? eventError.message : String(eventError),
            });
          }
        }
        break;

      case 'press':
        if (!cmd.key) throw new Error('press requires key');
        // ✅ FIX: keyboard is page-level (not frame-level), always use this.page
        await this.page.keyboard.press(cmd.key);
        break;

      case 'goto':
        if (!cmd.url) throw new Error('goto requires url');
        // Use 'load' to ensure JS hydration completes (SPA frameworks),
        // fallback to 'domcontentloaded' only on timeout errors
        try {
          await this.currentContext.goto(cmd.url, {
            waitUntil: 'load',
            timeout: 30000,
          });
        } catch (gotoErr) {
          const isTimeout = gotoErr instanceof Error && gotoErr.message.includes('Timeout');
          if (!isTimeout) throw gotoErr;
          await this.currentContext.goto(cmd.url, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
        }
        break;

      case 'scroll':
        // If a targetRef is provided, scroll that element into view.
        if (cmd.targetRef) {
          const target = this.currentContext.locator(`[data-agent-ref="${cmd.targetRef}"]`);
          await target.scrollIntoViewIfNeeded({ timeout: this.DEFAULT_TIMEOUT });

          // ✅ EXPERT ADVICE: Add offset for sticky headers (100px up)
          // Many sites have sticky nav bars that cover the element after scrollIntoView
          await this.currentContext.evaluate(() => {
            const STICKY_HEADER_OFFSET = 100; // pixels to scroll up after element is in view
            // @ts-expect-error - window available in browser context
            window.scrollBy(0, -STICKY_HEADER_OFFSET);
          });

          break;
        }

        // Otherwise, scroll by amount (default 500px). Clamp to avoid extreme scrolls.
        // ✅ FIX: Use currentContext for iframe support
        await this.currentContext.evaluate(
          ({ dir, amount }) => {
            const clamped = Math.max(50, Math.min(2000, amount));
            // @ts-expect-error - window available in browser context
            window.scrollBy(0, dir === 'up' ? -clamped : clamped);
          },
          {
            dir: cmd.direction || 'down',
            amount: typeof cmd.amount === 'number' ? cmd.amount : 500,
          }
        );
        break;

      case 'select':
        if (!locator || !cmd.value) throw new Error('select requires ref and value');
        // ═══════════════════════════════════════════════════════════════════
        // PHASE B: Pre-scroll to ensure element is visible before select
        // ═══════════════════════════════════════════════════════════════════
        await this.ensureElementVisible(locator);

        // Detect native <select> vs custom dropdown
        const isNativeSelect = await locator.evaluate(
          (el) => el.tagName.toLowerCase() === 'select'
        ).catch(() => false);

        if (isNativeSelect) {
          try {
            await locator.selectOption(cmd.value, { timeout: 5000 });
          } catch {
            // Fallback: set value directly via DOM when Playwright selectOption hangs
            await this.page.evaluate(
              ({ ref, value }) => {
                const select = document.querySelector(`[data-agent-ref="${ref}"]`) as HTMLSelectElement | null;
                if (!select) return;
                for (const opt of Array.from(select.options)) {
                  if (opt.text.trim().toLowerCase() === value.toLowerCase() || opt.value === value) {
                    select.value = opt.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    return;
                  }
                }
              },
              { ref: cmd.ref, value: cmd.value },
            );
          }
        } else {
          await this.selectFromCustomDropdown(locator, cmd.value || '', this.DEFAULT_TIMEOUT);
        }
        break;

      case 'hover':
        if (!locator) throw new Error('hover requires ref');
        // ═══════════════════════════════════════════════════════════════════
        // PHASE B: Pre-scroll to ensure element is visible before hover
        // ═══════════════════════════════════════════════════════════════════
        await this.ensureElementVisible(locator);
        await locator.hover({ timeout: this.DEFAULT_TIMEOUT });
        break;

      case 'wait':
        await this.page.waitForTimeout(1000);
        break;

      case 'toggle':
        if (!locator) throw new Error('toggle requires ref');
        await this.ensureElementVisible(locator);
        // Toggle works for: switches (role="switch"), checkboxes, radio buttons,
        // custom toggles with aria-pressed, accordion details/summary
        await locator.click({ timeout: this.DEFAULT_TIMEOUT });
        // ✅ FIX: Dispatch change event for Angular/React checkbox/switch forms
        try {
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        break;

      case 'setRange':
        if (!locator || cmd.value === undefined) throw new Error('setRange requires ref and value');
        await this.ensureElementVisible(locator);
        // V9: Uses shared native input helper (deduplicates nativeInputValueSetter pattern)
        await (await import('@/agent/playwright/core/native-input-helpers')).setNativeInputValue(locator, cmd.value);
        break;

      case 'clear':
        if (!locator) throw new Error('clear requires ref');
        await this.ensureElementVisible(locator);
        // Clear field value: works for inputs, textareas, contenteditable
        try {
          await locator.clear({ timeout: this.DEFAULT_TIMEOUT });
        } catch (clearError) {
          // Fallback: triple-click to select all + delete
          logger.debug('[ACTION_EXECUTOR] clear() failed, using select-all + delete fallback', {
            error: clearError instanceof Error ? clearError.message : String(clearError),
          });
          await locator.click({ clickCount: 3, timeout: this.DEFAULT_TIMEOUT });
          await this.page.keyboard.press('Backspace');
        }
        // ✅ FIX: Dispatch events so framework forms detect the cleared value
        try {
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        break;

      case 'selectDate':
        if (!locator || !cmd.value) throw new Error('selectDate requires ref and value');
        await this.ensureElementVisible(locator);
        // V9: Uses shared native input helper (deduplicates nativeInputValueSetter pattern)
        await (await import('@/agent/playwright/core/native-input-helpers')).setNativeInputValue(locator, cmd.value);
        break;

      default:
        throw new Error(`Unknown action: ${(cmd as any).action}`);
    }
  }

  /**
   * Fuzzy fallback: find element by attributes if ref not found
   * Priority order (Manus Style):
   * 1. Visual Anchor (spatial signature) - for dynamic ID sites
   * 2. Shadow DOM - for elements inside shadow roots
   * 3. Placeholder → aria-label → text content → role+name (legacy)
   *
   * NEW: Includes staged self-healing and modal handling
   */
  private async tryFuzzyFallback(
    cmd: AICommand,
    options?: ExecuteOptions,
    snapshot?: LiteSnapshot
  ): Promise<{
    success: boolean;
    info?: string;
    usedForceClick?: boolean;
    modalDismissInfo?: ModalDismissInfo;
    blockerInfo?: BlockerInfo;
  }> {
    // ═══════════════════════════════════════════════════════════════════════
    // FALLBACK 1: Visual Anchor (spatial signature)
    // Uses geometric relationship to stable anchor elements
    // Includes "Gray Zone Recovery" for confidence 0.6-0.69 (Manus Pro Tip)
    // ═══════════════════════════════════════════════════════════════════════
    if (cmd.ref && options?.getSignature && snapshot) {
      const signature = options.getSignature(cmd.ref);
      if (signature) {
        logger.debug('[ACTION_EXECUTOR] Trying Visual Anchor fallback', {
          ref: cmd.ref,
          signatureAnchors: signature.anchors.length,
        });

        let { element: foundElement, confidence } = VisualAnchorManager.findBySignature(
          signature,
          snapshot.elements
        );

        // ═══════════════════════════════════════════════════════════════════
        // GRAY ZONE RECOVERY (Manus Pro Tip)
        // If confidence is 0.6-0.69, elements might not have rendered yet
        // Try: 1) Wait 500ms  2) Micro-scroll  3) Recalculate
        // ═══════════════════════════════════════════════════════════════════
        if (foundElement && confidence >= 0.6 && confidence < 0.7) {
          logger.debug('[ACTION_EXECUTOR] Visual Anchor in gray zone, trying recovery', {
            confidence: confidence.toFixed(2),
            ref: cmd.ref,
          });

          // Step 1: Wait for potential lazy-loaded elements
          await this.page.waitForTimeout(500);

          // Step 2: Micro-scroll to trigger viewport-based rendering
          await this.page.evaluate(() => {
            // @ts-expect-error - window available in browser context
            window.scrollBy(0, 50);
            // @ts-expect-error
            window.scrollBy(0, -50);
          });
          await this.page.waitForTimeout(200);

          // Step 3: Re-collect snapshot and recalculate
          const freshSnapshot = await this.page.evaluate(() => {
            const elements: any[] = [];
            // @ts-expect-error - document available in browser context
            document.querySelectorAll('[data-agent-ref]').forEach((el: any) => {
              const rect = el.getBoundingClientRect();
              elements.push({
                ref: el.getAttribute('data-agent-ref'),
                name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 50) || '',
                tag: el.tagName.toLowerCase(),
                type: el.type || undefined,
                visible: true,
                bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
              });
            });
            return elements;
          }) as LiteElement[];

          // Recalculate confidence with fresh data
          const retryResult = VisualAnchorManager.findBySignature(signature, freshSnapshot);

          if (retryResult.confidence > confidence) {
            logger.info('[ACTION_EXECUTOR] Gray zone recovery improved confidence', {
              before: confidence.toFixed(2),
              after: retryResult.confidence.toFixed(2),
            });
            foundElement = retryResult.element;
            confidence = retryResult.confidence;
          }
        }

        if (foundElement && confidence >= 0.7) {
          logger.info('[ACTION_EXECUTOR] Visual Anchor found element', {
            originalRef: cmd.ref,
            newRef: foundElement.ref,
            confidence: confidence.toFixed(2),
          });

          options?.traceHook?.({
            stage: 'fallback',
            action: 'visual_anchor_match',
            success: true,
            details: {
              originalRef: cmd.ref,
              newRef: foundElement.ref,
              confidence,
            },
          });

          // Execute on the found element
          try {
            const newLocator = this.currentContext.locator(`[data-agent-ref="${foundElement.ref}"]`);
            const result = await this.executeFallbackActionWithSelfHealing(
              { ...cmd, ref: foundElement.ref },
              newLocator,
              options
            );

            // Handle modal after successful click
            let modalDismissInfo: ModalDismissInfo | undefined;
            if (cmd.action === 'click' && options?.modalKeywords) {
              modalDismissInfo = await this.handleUnexpectedModal(options.modalKeywords);
            }

            // Save new signature for the found element
            if (options?.saveSignature) {
              const newSignature = VisualAnchorManager.createSignature(foundElement, snapshot.elements);
              options.saveSignature(foundElement.ref, newSignature);
            }

            return {
              success: true,
              info: `Visual Anchor: ref ${cmd.ref} → ${foundElement.ref} (confidence: ${confidence.toFixed(2)})`,
              usedForceClick: result.usedForceClick,
              blockerInfo: result.blockerInfo,
              modalDismissInfo,
            };
          } catch (visualAnchorError) {
            logger.debug('[ACTION_EXECUTOR] Visual Anchor execution failed, trying next fallback', {
              error: visualAnchorError instanceof Error ? visualAnchorError.message : String(visualAnchorError),
            });
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FALLBACK 2: Shadow DOM
    // For elements inside shadow roots (web components)
    // ═══════════════════════════════════════════════════════════════════════
    if (cmd.ref) {
      try {
        const shadowResult = await this.tryShadowDOMFallback(cmd);
        if (shadowResult.success) {
          return shadowResult;
        }
      } catch (shadowError) {
        logger.debug('[ACTION_EXECUTOR] Shadow DOM fallback failed', {
          error: shadowError instanceof Error ? shadowError.message : String(shadowError),
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FALLBACK 3: Legacy text-based matching
    // placeholder → aria-label → text content → role+name
    // ═══════════════════════════════════════════════════════════════════════
    const el = this.elementMap.get(cmd.ref!);
    if (!el) {
      return { success: false };
    }

    // Map HTML tag to Playwright role for getByRole fallback.
    const roleFromTag = (tag: string | undefined): 'button' | 'link' | 'textbox' | 'combobox' | undefined => {
      switch ((tag || '').toLowerCase()) {
        case 'button':
          return 'button';
        case 'a':
          return 'link';
        case 'input':
        case 'textarea':
          return 'textbox';
        case 'select':
          return 'combobox';
        default:
          return undefined;
      }
    };

    // Build fallback strategies
    const strategies: Array<{ locator: Locator; name: string } | undefined> = [
      // 1. By placeholder
      el.placeholder
        ? {
            locator: this.currentContext.locator(`[placeholder="${el.placeholder}"]`),
            name: 'placeholder',
          }
        : undefined,
      // 2. By aria-label
      // ✅ FIX: Use currentContext for iframe support
      el.ariaLabel
        ? {
            locator: this.currentContext.getByLabel(el.ariaLabel),
            name: 'aria-label',
          }
        : undefined,
      // 3. By text content
      el.text
        ? {
            locator: this.currentContext.getByText(el.text, { exact: false }).first(),
            name: 'text',
          }
        : undefined,
      // 4. By role + name
      el.text && roleFromTag(el.tag)
        ? {
            locator: this.currentContext.getByRole(roleFromTag(el.tag) as any, { name: el.text }),
            name: 'role+name',
          }
        : undefined,
    ].filter(Boolean) as Array<{ locator: Locator; name: string }>;

    // Try each strategy
    for (const strategy of strategies) {
      if (!strategy) continue; // Skip undefined strategies

      try {
        const count = await strategy.locator.count();
        if (count > 0) {
          // Execute the original action on found element with staged self-healing
          const result = await this.executeFallbackActionWithSelfHealing(cmd, strategy.locator, options);

          // Handle modal after successful click
          let modalDismissInfo: ModalDismissInfo | undefined;
          if (cmd.action === 'click' && options?.modalKeywords) {
            modalDismissInfo = await this.handleUnexpectedModal(options.modalKeywords);
          }

          return {
            success: true,
            info: `Ref ${cmd.ref} stale, found by ${strategy.name}: "${el.text?.slice(0, 30)}"`,
            usedForceClick: result.usedForceClick,
            blockerInfo: result.blockerInfo,
            modalDismissInfo,
          };
        }
      } catch (fallbackError) {
        logger.debug('[ACTION_EXECUTOR] Fallback strategy failed', {
          strategy: strategy.name,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        continue; // Try next strategy
      }
    }

    return { success: false };
  }

  /**
   * Try Shadow DOM fallback for elements inside shadow roots
   * Uses ShadowDOMHandler to penetrate shadow boundaries
   */
  private async tryShadowDOMFallback(
    cmd: AICommand
  ): Promise<{
    success: boolean;
    info?: string;
    usedForceClick?: boolean;
    modalDismissInfo?: ModalDismissInfo;
  }> {
    if (!cmd.ref) return { success: false };

    logger.debug('[ACTION_EXECUTOR] Trying Shadow DOM fallback', { ref: cmd.ref });

    switch (cmd.action) {
      case 'click': {
        const clicked = await ShadowDOMHandler.click(this.page, cmd.ref);
        if (clicked) {
          return {
            success: true,
            info: `Shadow DOM: clicked ${cmd.ref}`,
            usedForceClick: false,
          };
        }
        break;
      }
      case 'fill': {
        if (!cmd.value) return { success: false };
        const filled = await ShadowDOMHandler.fill(this.page, cmd.ref, cmd.value);
        if (filled) {
          return {
            success: true,
            info: `Shadow DOM: filled ${cmd.ref}`,
            usedForceClick: false,
          };
        }
        break;
      }
      // ✅ FIX: Route all shadow DOM action types through ShadowDOMHandler
      case 'toggle': {
        const toggled = await ShadowDOMHandler.toggle(this.page, cmd.ref);
        if (toggled) return { success: true, info: `Shadow DOM: toggled ${cmd.ref}` };
        break;
      }
      case 'clear': {
        const cleared = await ShadowDOMHandler.clear(this.page, cmd.ref);
        if (cleared) return { success: true, info: `Shadow DOM: cleared ${cmd.ref}` };
        break;
      }
      case 'setRange': {
        if (!cmd.value) return { success: false };
        const ranged = await ShadowDOMHandler.setRange(this.page, cmd.ref, cmd.value);
        if (ranged) return { success: true, info: `Shadow DOM: setRange ${cmd.ref}` };
        break;
      }
      case 'selectDate': {
        if (!cmd.value) return { success: false };
        const dated = await ShadowDOMHandler.selectDate(this.page, cmd.ref, cmd.value);
        if (dated) return { success: true, info: `Shadow DOM: selectDate ${cmd.ref}` };
        break;
      }
      default:
        break;
    }

    return { success: false };
  }

  /**
   * Execute action on fallback locator with staged self-healing
   * NEW: Staged approach instead of force-default
   * 1. Try normal click
   * 2. If intercepted → try dismiss modal
   * 3. If still intercepted → try scroll offset
   * 4. If still intercepted → try wait (transient overlay)
   * 5. Last resort → force click (and log it)
   */
  private async executeFallbackActionWithSelfHealing(
    cmd: AICommand,
    locator: Locator,
    options?: ExecuteOptions
  ): Promise<{ usedForceClick: boolean; blockerInfo?: BlockerInfo }> {
    let usedForceClick = false;
    let blockerInfo: BlockerInfo | undefined;

    switch (cmd.action) {
      case 'click': {
        const clickResult = await this.stagedClickWithSelfHealing(locator, {
          ...options,
          targetRef: cmd.ref,
        });
        usedForceClick = clickResult.usedForce;
        blockerInfo = clickResult.blockerInfo;
        break;
      }
      case 'fill':
        if (cmd.value) {
          try {
            await locator.clear({ timeout: this.FALLBACK_TIMEOUT });
            await locator.pressSequentially(cmd.value, {
              timeout: this.FALLBACK_TIMEOUT,
              delay: 50,
            });
          } catch (error) {
            logger.debug('[ACTION_EXECUTOR] pressSequentially failed in fallback, using fill()', {
              error: error instanceof Error ? error.message : String(error),
            });
            await locator.fill(cmd.value, { timeout: this.FALLBACK_TIMEOUT });
          }
          // ✅ FIX: Post-fill event reinforcement (same as primary path)
          try {
            await locator.evaluate((el, val) => {
              const input = el as HTMLInputElement;
              if (input.value !== val) {
                const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                )?.set || Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                )?.set;
                if (setter) setter.call(input, val); else input.value = val;
              }
              input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
            }, cmd.value);
          } catch { /* non-critical */ }
        }
        break;
      case 'hover':
        // ✅ FIX: Try force hover if normal hover fails
        try {
          await locator.hover({ timeout: this.FALLBACK_TIMEOUT });
        } catch (error) {
          logger.debug('[ACTION_EXECUTOR] Normal fallback hover failed, trying force hover', {
            error: error instanceof Error ? error.message : String(error),
          });
          await locator.hover({ timeout: this.FALLBACK_TIMEOUT, force: true });
        }
        break;
      case 'select':
        if (cmd.value) {
          const isNativeFallback = await locator.evaluate(
            (el) => el.tagName.toLowerCase() === 'select'
          ).catch(() => false);

          if (isNativeFallback) {
            try {
              await locator.selectOption(cmd.value, { timeout: 5000 });
            } catch {
              await this.page.evaluate(
                ({ ref, value }) => {
                  const select = document.querySelector(`[data-agent-ref="${ref}"]`) as HTMLSelectElement | null;
                  if (!select) return;
                  for (const opt of Array.from(select.options)) {
                    if (opt.text.trim().toLowerCase() === value.toLowerCase() || opt.value === value) {
                      select.value = opt.value;
                      select.dispatchEvent(new Event('change', { bubbles: true }));
                      return;
                    }
                  }
                },
                { ref: cmd.ref, value: cmd.value },
              );
            }
          } else {
            await this.selectFromCustomDropdown(locator, cmd.value, this.FALLBACK_TIMEOUT);
          }
        }
        break;
      case 'toggle':
        await locator.click({ timeout: this.FALLBACK_TIMEOUT });
        // ✅ FIX: Dispatch change event for Angular/React checkbox/switch forms
        try {
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        break;
      case 'setRange':
        if (cmd.value !== undefined) {
          await locator.evaluate((el, val) => {
            const input = el as HTMLInputElement;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(input, val);
            } else {
              input.value = val;
            }
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, cmd.value);
        }
        break;
      case 'clear':
        try {
          await locator.clear({ timeout: this.FALLBACK_TIMEOUT });
        } catch {
          await locator.click({ clickCount: 3, timeout: this.FALLBACK_TIMEOUT });
          await this.page.keyboard.press('Backspace');
        }
        // ✅ FIX: Dispatch events so framework forms detect the cleared value
        try {
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        break;
      case 'selectDate':
        if (cmd.value) {
          await locator.evaluate((el, dateStr) => {
            const input = el as HTMLInputElement;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(input, dateStr);
            } else {
              input.value = dateStr;
            }
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, cmd.value);
        }
        break;
      default:
        throw new Error(`Fallback not supported for action: ${cmd.action}`);
    }

    return { usedForceClick, blockerInfo };
  }

  /**
   * Custom dropdown select: click trigger → find visible option → click option.
   * 4-phase strategy:
   *   1. Pre-collected option refs from snapshot (fastest, most reliable)
   *   2. Scoped ARIA container search
   *   3. Page-level ARIA roles (handles portals)
   *   4. Universal text fallback (non-ARIA dropdowns)
   */
  private async selectFromCustomDropdown(
    locator: Locator,
    value: string,
    timeout: number
  ): Promise<void> {
    await locator.click({ timeout });
    await this.page.waitForTimeout(300);

    const valueLower = value.toLowerCase().trim();

    // Phase 0: Try pre-collected option elements from snapshot (role="option" with matching text)
    // SnapshotCollector now collects [role="option"], [role="menuitem"], etc.
    // If snapshot has these, we can target them directly by ref — faster & more reliable
    // IMPORTANT: Only consider elements with option-like roles/tags to avoid clicking non-option elements
    const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'listitem']);
    const OPTION_TAGS = new Set(['option', 'li']);
    for (const [ref, info] of this.elementMap.entries()) {
      // Filter: only match elements that look like dropdown options
      const role = (info.role || '').toLowerCase();
      const tag = (info.tag || '').toLowerCase();
      if (!OPTION_ROLES.has(role) && !OPTION_TAGS.has(tag)) continue;

      const textLower = (info.text || '').toLowerCase().trim();
      if (textLower === valueLower || textLower.includes(valueLower)) {
        try {
          const optLocator = this.currentContext.locator(`[data-agent-ref="${ref}"]`);
          const isVis = await optLocator.isVisible().catch(() => false);
          if (isVis) {
            await optLocator.click({ timeout: 2000 });
            logger.debug('[ACTION_EXECUTOR] Selected option via pre-collected ref', {
              ref,
              text: info.text?.slice(0, 40),
              role,
              tag,
            });
            return;
          }
        } catch {
          // Option ref not found/visible, continue to next phase
        }
      }
    }

    // Phase 1: Scoped search inside visible ARIA container
    const containers = [
      this.page.locator('[role="listbox"]:visible'),
      this.page.locator('[role="menu"]:visible'),
      this.page.locator('[role="tree"]:visible'),
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
      this.page.getByRole('treeitem', { name: value, exact: true }),
      this.page.getByRole('option', { name: value, exact: false }),
      this.page.getByRole('menuitem', { name: value, exact: false }),
      this.page.getByRole('treeitem', { name: value, exact: false }),
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

    // Phase 3: Universal text fallback (non-ARIA dropdowns)
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

  /**
   * Staged click with self-healing (Lite Autonomy v3 + Layer 3 Obstacle Intelligence)
   * Tries multiple strategies before falling back to force click.
   * Returns { usedForce, blockerInfo } for Layer 3 feedback to Critic.
   */
  private async stagedClickWithSelfHealing(
    locator: Locator,
    options?: ExecuteOptions & { targetRef?: string }
  ): Promise<{ usedForce: boolean; blockerInfo?: BlockerInfo }> {
    // Stage 1: Normal click
    try {
      await locator.click({ timeout: this.FALLBACK_TIMEOUT });
      return { usedForce: false }; // No force needed
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If not an interception error, re-throw
      if (!this.isInterceptedError(errorMsg)) {
        throw error;
      }

      logger.debug('[ACTION_EXECUTOR] Click intercepted, starting self-healing', {
        error: errorMsg.slice(0, 100),
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Stage 2 (NEW): Layer 3 — Identify exact blocker & type-specific recovery
    // ═══════════════════════════════════════════════════════════════════════
    let blockerInfo: BlockerInfo | undefined;
    if (LITE_ENGINE_FLAGS.enableLayer3BlockerDetection && options?.targetRef) {
      const blocker = await this.identifyBlocker(options.targetRef);
      if (blocker) {
        blockerInfo = blocker as BlockerInfo;
        logger.info('[ACTION_EXECUTOR] Layer 3: Blocker identified', {
          type: blocker.hintType,
          recovery: blocker.suggestedRecovery,
          blockerTag: blocker.blockerTag,
          blockerClass: blocker.blockerClass.slice(0, 50),
        });

        // Attempt type-specific recovery
        const recovered = await this.attemptBlockerRecovery(blocker as BlockerInfo);
        if (recovered) {
          try {
            await locator.click({ timeout: this.FALLBACK_TIMEOUT });
            logger.info('[ACTION_EXECUTOR] Layer 3 recovery succeeded', {
              type: blocker.hintType,
              recovery: blocker.suggestedRecovery,
            });
            return { usedForce: false, blockerInfo };
          } catch {
            // Recovery didn't fully work, continue to next stage
          }
        }
      }
    }

    // Stage 3: Try to dismiss modal if present (existing behavior)
    if (options?.modalKeywords) {
      const dismissResult = await this.handleUnexpectedModal(options.modalKeywords);
      if (dismissResult.dismissed) {
        logger.info('[ACTION_EXECUTOR] Modal dismissed, retrying click');
        try {
          await locator.click({ timeout: this.FALLBACK_TIMEOUT });
          return { usedForce: false, blockerInfo };
        } catch {
          // Continue to next stage
        }
      }
    }

    // Stage 4: Try scroll offset (for sticky headers)
    try {
      await locator.evaluate(() => {
        // @ts-expect-error - window available in browser context
        window.scrollBy(0, -150); // Scroll up to reveal element
      });
      await this.page.waitForTimeout(200);
      await locator.click({ timeout: this.FALLBACK_TIMEOUT });
      logger.info('[ACTION_EXECUTOR] Click successful after scroll offset');
      return { usedForce: false, blockerInfo };
    } catch {
      // Continue to next stage
    }

    // Stage 5: Brief wait (for transient overlays)
    try {
      await this.page.waitForTimeout(1000);
      await locator.click({ timeout: this.FALLBACK_TIMEOUT });
      logger.info('[ACTION_EXECUTOR] Click successful after brief wait');
      return { usedForce: false, blockerInfo };
    } catch {
      // Continue to force click
    }

    // Stage 6: Force click (last resort)
    logger.warn('[ACTION_EXECUTOR] All self-healing attempts failed, using force click');
    await locator.click({ timeout: this.FALLBACK_TIMEOUT, force: true });
    return { usedForce: true, blockerInfo };
  }

  /**
   * Check if error indicates element is intercepted/obscured
   */
  private isInterceptedError(msg: string): boolean {
    const interceptedIndicators = [
      'intercept',
      'obscured',
      'covered',
      'overlapping',
      'other element',
      'receives pointer',
    ];

    const msgLower = msg.toLowerCase();
    return interceptedIndicators.some((indicator) => msgLower.includes(indicator));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 3: REACTIVE BLOCKER DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Layer 3: Identify the exact element blocking a click via elementFromPoint.
   * Called after "intercepts pointer events" error to determine WHAT is blocking
   * and HOW to recover (scroll, dismiss, wait, etc.).
   */
  private async identifyBlocker(targetRef: string): Promise<BlockerInfo | null> {
    // Minimal Layer 3 fallback patterns — only 3 types where recovery differs from default.
    // All other classification is done by LLM (Layer 2 Observer Agent).
    const fallbackPatterns = Object.fromEntries(
      Object.entries(LAYER3_FALLBACK_PATTERNS).map(([k, v]) => [k, v.source])
    );

    try {
      return await this.currentContext.evaluate(
        ({ targetRef, fallbackPatterns }) => {
          const target = document.querySelector(`[data-agent-ref="${targetRef}"]`);
          if (!target) return null;

          const rect = target.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          // @ts-expect-error
          if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) {
            return null; // Target out of viewport
          }

          const topEl = document.elementFromPoint(cx, cy);
          if (!topEl) return null;

          // Check if top element IS the target or contains/is contained by target
          if (topEl === target || target.contains(topEl) || topEl.contains(target)) {
            return null; // Not blocked
          }

          // It's a blocker — gather info
          const blockerTag = topEl.tagName.toLowerCase();
          const blockerClass = (topEl.getAttribute('class') || '').slice(0, 200);
          const blockerText = (topEl.textContent || '').trim().slice(0, 100);
          const blockerRef = topEl.getAttribute('data-agent-ref') || undefined;
          const blockerRole = (topEl.getAttribute('role') || '').replace(/["']/g, '').trim();
          const blockerAriaModal = (topEl.getAttribute('aria-modal') || '').replace(/["']/g, '').trim() === 'true';
          const style = window.getComputedStyle(topEl);
          const position = style.position;

          // Classify blocker type — minimal reactive fallback
          // ARIA + geometry + 3 key patterns only. LLM handles the rest.
          let hintType: string = 'unknown';

          // 1. ARIA modal signals
          if (blockerRole === 'dialog' || blockerRole === 'alertdialog' || blockerAriaModal) {
            hintType = 'modal';
          }
          // 2. Minimal fallback patterns (cookie, toast, loading — recovery differs from default)
          else {
            const idStr = (topEl.getAttribute('id') || '').toLowerCase();
            const combined = blockerClass.toLowerCase() + ' ' + idStr;
            for (const [type, source] of Object.entries(fallbackPatterns)) {
              if (new RegExp(source, 'i').test(combined)) {
                hintType = type;
                break;
              }
            }
          }
          // 3. Position heuristics for sticky headers/footers
          if (hintType === 'unknown') {
            const bRect = topEl.getBoundingClientRect();
            // @ts-expect-error
            const vpH = window.innerHeight;
            if ((position === 'sticky' || position === 'fixed') && bRect.top <= 5 && bRect.height < 120) {
              hintType = 'sticky_header';
            } else if ((position === 'sticky' || position === 'fixed') && bRect.bottom >= vpH - 5 && bRect.height < 120) {
              hintType = 'sticky_footer';
            }
          }

          // Map hintType to recovery action — only types that can be produced
          const recoveryMap: Record<string, string> = {
            modal: 'dismiss_escape',
            cookie_consent: 'dismiss_button',
            toast: 'wait',
            sticky_header: 'scroll_around',
            sticky_footer: 'scroll_around',
            loading_overlay: 'wait',
            unknown: 'dismiss_escape',
          };

          return {
            blockerRef,
            blockerTag,
            blockerClass,
            blockerText,
            targetRef,
            point: { x: Math.round(cx), y: Math.round(cy) },
            hintType,
            suggestedRecovery: recoveryMap[hintType] || 'dismiss_escape',
          };
        },
        { targetRef, fallbackPatterns },
      );
    } catch (err) {
      logger.debug('[ACTION_EXECUTOR] identifyBlocker error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Layer 3: Attempt recovery based on blocker type.
   * Returns true if recovery succeeded and click should be retried.
   */
  private async attemptBlockerRecovery(blocker: BlockerInfo): Promise<boolean> {
    const recovery = blocker.suggestedRecovery;

    try {
      switch (recovery) {
        case 'dismiss_escape': {
          await this.currentContext.keyboard.press('Escape');
          await this.page.waitForTimeout(300);
          return true;
        }
        case 'dismiss_button': {
          // Try to find and click a close button within the blocker
          if (blocker.blockerRef) {
            const blocker_el = this.currentContext.locator(`[data-agent-ref="${blocker.blockerRef}"]`);
            try {
              const closeBtn = blocker_el.locator(CLOSE_BUTTON_SELECTOR).first();
              await closeBtn.click({ timeout: 2000 });
              await this.page.waitForTimeout(300);
              return true;
            } catch {
              // Fallback: try Escape
              await this.currentContext.keyboard.press('Escape');
              await this.page.waitForTimeout(300);
              return true;
            }
          }
          await this.currentContext.keyboard.press('Escape');
          await this.page.waitForTimeout(300);
          return true;
        }
        case 'scroll_around': {
          // Scroll element further into center to avoid sticky header/footer
          await this.currentContext.evaluate(() => {
            // @ts-expect-error
            window.scrollBy(0, -150);
          });
          await this.page.waitForTimeout(200);
          return true;
        }
        case 'wait': {
          await this.page.waitForTimeout(2000);
          return true;
        }
        case 'click_away': {
          // Click an empty area to dismiss dropdown/tooltip
          await this.currentContext.evaluate(() => {
            // @ts-expect-error
            const emptyArea = document.elementFromPoint(10, window.innerHeight / 2);
            if (emptyArea) {
              (emptyArea as HTMLElement).click();
            }
          });
          await this.page.waitForTimeout(300);
          return true;
        }
        default:
          return false;
      }
    } catch (err) {
      logger.debug('[ACTION_EXECUTOR] blocker recovery failed', {
        recovery,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * WORKSTREAM B: 2-stage center-scroll visibility
   * Stage 1: Fast path with scrollIntoViewIfNeeded
   * Stage 2: Center the element to avoid edge overlays (cookie bars, chat widgets)
   *
   * @param locator - Playwright locator for the target element
   */
  private async ensureElementVisible(locator: Locator): Promise<void> {
    try {
      // ═══════════════════════════════════════════════════════════════════════
      // Stage 1: Fast path - scroll into view if needed
      // ═══════════════════════════════════════════════════════════════════════
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });

      // ═══════════════════════════════════════════════════════════════════════
      // Stage 2: Center the element in viewport (reduces edge overlay issues)
      // scrollIntoViewIfNeeded can place element at viewport edges where
      // sticky headers/footers, cookie bars, or chat widgets can obscure it
      // ═══════════════════════════════════════════════════════════════════════
      try {
        await locator.evaluate((el) => {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        });
      } catch {
        // If evaluate fails (e.g., element detached), continue anyway
      }

      // Smaller sticky offset after centering (centering already reduces edge risk)
      await locator.evaluate(() => {
        const STICKY_HEADER_OFFSET = 60; // pixels (reduced from 100, since we're centered)
        // @ts-expect-error - window available in browser context
        window.scrollBy(0, -STICKY_HEADER_OFFSET);
      });

      // Brief wait for scroll to complete and any lazy-loaded content
      await this.page.waitForTimeout(100);
    } catch (error) {
      // Log but don't fail - element might still be interactable
      logger.debug('[ACTION_EXECUTOR] ensureElementVisible warning', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if error indicates element not found
   */
  private isNotFoundError(msg: string): boolean {
    const notFoundIndicators = [
      'not found',
      'timeout',
      'no element',
      'strict mode',
      'unable to find',
      'does not exist',
    ];

    const msgLower = msg.toLowerCase();
    return notFoundIndicators.some((indicator) => msgLower.includes(indicator));
  }

  /**
   * Check if element is likely an entry point (for modal detection)
   * Uses dynamically provided keywords from AI strategy
   *
   * @param text - Element text to check
   * @param keywords - Dynamic keywords from GoalDetector's AI-generated strategy
   */
  private isEntryPointElement(text: string, keywords: string[]): boolean {
    if (keywords.length === 0) return false; // No keywords = no modal wait
    const textLower = text.toLowerCase();
    return keywords.some(keyword => textLower.includes(keyword.toLowerCase()));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HYBRID MODAL HANDLING (Lite Autonomy v3)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle unexpected modal after click (hybrid approach)
   * 1. Detect modal
   * 2. Classify: system error / validation error / unexpected / goal-relevant
   * 3. Auto-dismiss if unexpected (Escape first, then safe close button)
   * 4. Return info for AI if still present
   */
  private async handleUnexpectedModal(keywords: ModalKeywords): Promise<ModalDismissInfo> {
    // Small delay for modal to appear
    await this.page.waitForTimeout(500);

    // Detect modal and get its text. If the click that triggered this
    // check ALSO triggered a navigation, the page may be mid-transition
    // and `page.evaluate` throws "Target closed" / "Execution context was
    // destroyed". Treat that as "no modal" — the click succeeded, there
    // is genuinely nothing to dismiss on the new page.
    //
    // Without this guard the whole action is reported as failed even
    // though the navigation clearly worked, producing false-negative
    // click-then-navigate failures on ~20% of real-world click flows.
    let modalInfo: { hasModal: boolean; ref?: string; text?: string };
    try {
      modalInfo = await this.detectActiveModalWithText();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPageGone =
        msg.includes('Target closed') ||
        msg.includes('Target page, context or browser has been closed') ||
        msg.includes('Execution context was destroyed') ||
        msg.includes('frame was detached');
      if (isPageGone) {
        logger.debug('[ACTION_EXECUTOR] Modal check skipped — page navigated', { error: msg.slice(0, 120) });
        return { attempted: false, dismissed: false, stillPresent: false };
      }
      throw err;
    }

    if (!modalInfo.hasModal) {
      return { attempted: false, dismissed: false, stillPresent: false };
    }

    const modalText = modalInfo.text || '';
    const modalTextLower = modalText.toLowerCase();

    logger.debug('[ACTION_EXECUTOR] Modal detected after click', {
      ref: modalInfo.ref,
      textPreview: modalText.slice(0, 100),
    });

    // Classify modal
    const modalType = this.classifyModal(modalTextLower, keywords);

    logger.info('[ACTION_EXECUTOR] Modal classified', {
      type: modalType,
      ref: modalInfo.ref,
    });

    // Handle based on classification
    if (modalType === 'system') {
      // System error - don't try to dismiss, report as error
      return {
        attempted: false,
        dismissed: false,
        stillPresent: true,
        modalType: 'system',
        reason: 'System error detected - test should fail',
        modalTextPreview: modalText.slice(0, 150),
      };
    }

    if (modalType === 'validation') {
      // Validation error - don't dismiss, report for rollback
      return {
        attempted: false,
        dismissed: false,
        stillPresent: true,
        modalType: 'validation',
        reason: 'Validation error - rollback to previous step',
        modalTextPreview: modalText.slice(0, 150),
      };
    }

    if (modalType === 'goal') {
      // Goal-relevant modal - don't dismiss
      return {
        attempted: false,
        dismissed: false,
        stillPresent: true,
        modalType: 'goal',
        reason: 'Modal is relevant to goal - do not dismiss',
        modalTextPreview: modalText.slice(0, 150),
      };
    }

    // modalType === 'unexpected' - try to dismiss
    logger.info('[ACTION_EXECUTOR] Attempting to dismiss unexpected modal', {
      ref: modalInfo.ref,
    });

    // Step 1: Try Escape
    const escapeDismissed = await this.tryDismissWithEscape();
    if (escapeDismissed) {
      return {
        attempted: true,
        dismissed: true,
        stillPresent: false,
        method: 'escape',
        modalType: 'unexpected',
        reason: 'Dismissed unexpected modal with Escape',
      };
    }

    // Step 2: Try safe close button
    const buttonDismissed = await this.tryDismissWithSafeButton();
    if (buttonDismissed) {
      return {
        attempted: true,
        dismissed: true,
        stillPresent: false,
        method: 'button',
        modalType: 'unexpected',
        reason: 'Dismissed unexpected modal with close button',
      };
    }

    // Could not dismiss - return info for AI
    return {
      attempted: true,
      dismissed: false,
      stillPresent: true,
      method: 'none',
      modalType: 'unexpected',
      reason: 'Tried Escape and safe close button, modal still present',
      modalTextPreview: modalText.slice(0, 150),
    };
  }

  /**
   * Detect active modal and get its text content.
   * Refactored: Uses iron-clad ARIA/spec selectors first (zero false positives),
   * falls back to legacy heuristic only when Layer 2 is disabled.
   */
  private async detectActiveModalWithText(): Promise<{
    hasModal: boolean;
    ref?: string;
    text?: string;
  }> {
    const __mc = {
      ironCladSelectors: IRON_CLAD_MODAL_SELECTORS,
      enableLayer2: LITE_ENGINE_FLAGS.enableLayer2ObstacleClassification,
      // Legacy fallback constants (only used when Layer 2 disabled)
      overlaySelectors: MODAL_OVERLAY_SELECTORS,
      positionalSelector: POSITIONAL_CANDIDATES_SELECTOR,
      interactiveSelector: INTERACTIVE_CHILDREN_SELECTOR,
      classRegexSource: MODAL_CLASS_REGEX.source,
    };

    return await this.page.evaluate((__mc) => {
      // ═══════════════════════════════════════════════════════════════════════
      // Phase 0: Native dialog[open] — always checked first
      // ═══════════════════════════════════════════════════════════════════════
      const nativeDialog = document.querySelector('dialog[open]');
      if (nativeDialog) {
        const style = window.getComputedStyle(nativeDialog);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const ref = nativeDialog.getAttribute('data-agent-ref') || undefined;
          const text = nativeDialog.textContent?.trim().slice(0, 500) || '';
          return { hasModal: true, ref, text };
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 1: Iron-clad ARIA/spec selectors — zero false positives
      // ═══════════════════════════════════════════════════════════════════════
      const ironCladMatches = Array.from(
        document.querySelectorAll(__mc.ironCladSelectors)
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity) >= 0.1
        );
      });

      if (ironCladMatches.length > 0) {
        // Pick highest z-index among iron-clad matches
        let bestModal = ironCladMatches[0];
        let bestZ = parseInt(window.getComputedStyle(bestModal).zIndex, 10) || 0;
        for (let i = 1; i < ironCladMatches.length; i++) {
          const z = parseInt(window.getComputedStyle(ironCladMatches[i]).zIndex, 10) || 0;
          if (z > bestZ) {
            bestZ = z;
            bestModal = ironCladMatches[i];
          }
        }
        const ref = bestModal.getAttribute('data-agent-ref') || undefined;
        const text = bestModal.textContent?.trim().slice(0, 500) || '';
        return { hasModal: true, ref, text };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2: Legacy heuristic fallback (only when Layer 2 is disabled)
      // When Layer 2 is enabled, the Observer handles classification
      // ═══════════════════════════════════════════════════════════════════════
      if (__mc.enableLayer2) {
        return { hasModal: false };
      }

      // Legacy: Two-pass approach with coverage heuristics
      const targetedModals = Array.from(document.querySelectorAll(__mc.overlaySelectors));
      const positionalCandidates = Array.from(document.querySelectorAll(__mc.positionalSelector));

      const seen = new WeakSet<Element>();
      const potentialModals: Element[] = [];
      for (const el of [...targetedModals, ...positionalCandidates]) {
        if (seen.has(el)) continue;
        seen.add(el);

        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity) < 0.1) continue;

        const zIndex = parseInt(style.zIndex, 10);
        if (isNaN(zIndex) || zIndex < 1) continue;

        potentialModals.push(el);
      }

      if (potentialModals.length === 0) return { hasModal: false };

      let bestModal: Element | null = null;
      let highestZIndex = 0;

      // @ts-expect-error
      const viewportArea = window.innerWidth * window.innerHeight;
      const popupRegex = new RegExp(__mc.classRegexSource, 'i');

      for (const modal of potentialModals) {
        const style = window.getComputedStyle(modal);
        const zIndex = parseInt(style.zIndex, 10);
        const rect = modal.getBoundingClientRect();
        const modalArea = rect.width * rect.height;
        const coverage = viewportArea > 0 ? modalArea / viewportArea : 0;

        const modalRoleRaw = (modal.getAttribute('role') || '').replace(/["']/g, '').trim();
        const hasModalRole = modalRoleRaw === 'dialog' ||
                             (modal.getAttribute('aria-modal') || '').replace(/["']/g, '').trim() === 'true' ||
                             modal.classList.contains('modal') ||
                             modal.classList.contains('overlay') ||
                             modal.classList.contains('popup');

        const classStr = (modal.getAttribute('class') || '').toLowerCase();
        const hasPopupClass = popupRegex.test(classStr);
        const hasInteractiveChildren = modal.querySelector(__mc.interactiveSelector) !== null;

        const isModal =
          (hasModalRole && coverage > 0.1) ||
          coverage > 0.3 ||
          (hasPopupClass && hasInteractiveChildren && coverage > 0.1) ||
          (hasInteractiveChildren && zIndex > 10 && coverage > 0.15);

        if (isModal && zIndex > highestZIndex) {
          highestZIndex = zIndex;
          bestModal = modal;
        }
      }

      if (!bestModal) return { hasModal: false };

      const ref = bestModal.getAttribute('data-agent-ref') || undefined;
      const text = bestModal.textContent?.trim().slice(0, 500) || '';

      return { hasModal: true, ref, text };
    }, __mc);
  }

  /**
   * Classify modal based on text content and keywords
   */
  private classifyModal(
    modalTextLower: string,
    keywords: ModalKeywords
  ): 'system' | 'validation' | 'unexpected' | 'goal' {
    // 1. Check for system errors first (highest priority)
    const hasSystemError = keywords.systemErrorKeywords.some(
      kw => modalTextLower.includes(kw.toLowerCase())
    );
    if (hasSystemError) return 'system';

    // 2. Check for validation errors
    const hasValidationError = keywords.validationErrorKeywords.some(
      kw => modalTextLower.includes(kw.toLowerCase())
    );
    if (hasValidationError) return 'validation';

    // 3. Check if modal is goal-relevant (don't dismiss)
    const isGoalRelevant = keywords.goalKeywords.some(
      kw => modalTextLower.includes(kw.toLowerCase())
    );
    if (isGoalRelevant) return 'goal';

    // 4. Check for unexpected/interruption keywords
    const isUnexpected = keywords.unexpectedModalKeywords.some(
      kw => modalTextLower.includes(kw.toLowerCase())
    );
    if (isUnexpected) return 'unexpected';

    // Default: if modal appeared after click but doesn't match any pattern,
    // treat as unexpected (safer to try dismiss)
    return 'unexpected';
  }

  /**
   * Try to dismiss modal with Escape key
   * Returns true if modal was dismissed
   */
  private async tryDismissWithEscape(): Promise<boolean> {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);

    // Check if modal is still present
    const stillPresent = await this.isModalStillPresent();
    return !stillPresent;
  }

  /**
   * Try to dismiss modal with safe close button
   * Uses minimal keyword list for close buttons
   */
  private async tryDismissWithSafeButton(): Promise<boolean> {
    // Close button patterns (minimal, safe list)
    const closePatterns = [
      'close', 'закрыть', 'dismiss', 'accept', 'agree',
      'ok', 'понятно', 'allow', 'consent', 'got it', 'accept all',
      '×', 'x', '✕', '✖'
    ];

    try {
      // Find close button inside modal or at high z-index
      const closeButton = await this.page.evaluate((patterns) => {
        // Find buttons/links that match close patterns
        const candidates = Array.from(document.querySelectorAll(
          'button, a, [role="button"], [aria-label*="close" i], [aria-label*="dismiss" i]'
        )).filter((el: Element) => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity) < 0.3) return false;

          // Get text content and aria-label
          const text = (el.textContent?.trim() || '').toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();

          // Check if matches any close pattern
          return patterns.some(p =>
            text.includes(p.toLowerCase()) ||
            ariaLabel.includes(p.toLowerCase()) ||
            title.includes(p.toLowerCase())
          );
        });

        if (candidates.length === 0) return null;

        // Score candidates (prefer aria-label matches and smaller buttons)
        let bestCandidate: Element | null = null;
        let bestScore = 0;

        for (const candidate of candidates) {
          let score = 0;
          const ariaLabel = (candidate.getAttribute('aria-label') || '').toLowerCase();
          const text = (candidate.textContent?.trim() || '').toLowerCase();

          // Prefer aria-label with "close"
          if (ariaLabel.includes('close') || ariaLabel.includes('закрыть')) score += 3;

          // Prefer short text (likely just X or icon)
          if (text.length <= 3) score += 2;

          // Prefer role="button" (strip escaped quotes for Angular compatibility)
          if ((candidate.getAttribute('role') || '').replace(/["']/g, '').trim() === 'button') score += 1;

          if (score > bestScore) {
            bestScore = score;
            bestCandidate = candidate;
          }
        }

        if (bestCandidate) {
          const ref = bestCandidate.getAttribute('data-agent-ref');
          return ref || null;
        }

        return null;
      }, closePatterns);

      if (!closeButton) {
        logger.debug('[ACTION_EXECUTOR] No close button found in modal');
        return false;
      }

      // Click the close button
      await this.currentContext.locator(`[data-agent-ref="${closeButton}"]`).click({ timeout: 3000 });
      await this.page.waitForTimeout(500);

      // Check if modal is still present
      const stillPresent = await this.isModalStillPresent();
      return !stillPresent;
    } catch (error) {
      logger.debug('[ACTION_EXECUTOR] Failed to click close button', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if modal is still present
   */
  private async isModalStillPresent(): Promise<boolean> {
    const modalInfo = await this.detectActiveModalWithText();
    return modalInfo.hasModal;
  }

  /**
   * Wait for modal to appear and stabilize after clicking entry point
   * Polls every 300ms for up to 3 seconds
   * Checks for overlay appearance and stability
   */
  private async waitForModalAfterClick(): Promise<void> {
    const MAX_WAIT_TIME = 3000; // 3 seconds
    const POLL_INTERVAL = 300; // 300ms
    const STABILITY_CHECKS = 2; // Must be stable for 2 consecutive checks

    const startTime = Date.now();
    let lastModalState: { ref: string | null; rect: { x: number; y: number; width: number; height: number } | null } = {
      ref: null,
      rect: null,
    };
    let stableCount = 0;

    logger.debug('[ACTION_EXECUTOR] Starting modal polling');

    while (Date.now() - startTime < MAX_WAIT_TIME) {
      // Check for modal in current page state using iron-clad selectors
      const __mc2 = {
        ironCladSelectors: IRON_CLAD_MODAL_SELECTORS,
        enableLayer2: LITE_ENGINE_FLAGS.enableLayer2ObstacleClassification,
        // Legacy fallback constants (only used when Layer 2 disabled)
        overlaySelectors: MODAL_OVERLAY_SELECTORS,
        positionalSelector: POSITIONAL_CANDIDATES_SELECTOR,
        interactiveSelector: INTERACTIVE_CHILDREN_SELECTOR,
        classRegexSource: MODAL_CLASS_REGEX.source,
      };

      const currentModalState = await this.page.evaluate((__mc) => {
        // Phase 0: Native dialog[open]
        const nativeDialog = document.querySelector('dialog[open]');
        if (nativeDialog) {
          const style = window.getComputedStyle(nativeDialog);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const rect = nativeDialog.getBoundingClientRect();
            return {
              ref: nativeDialog.getAttribute('data-agent-ref') || 'modal-detected',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          }
        }

        // Phase 1: Iron-clad ARIA/spec selectors
        const ironCladMatches = Array.from(
          document.querySelectorAll(__mc.ironCladSelectors)
        ).filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) >= 0.1
          );
        });

        if (ironCladMatches.length > 0) {
          let bestModal = ironCladMatches[0];
          let bestZ = parseInt(window.getComputedStyle(bestModal).zIndex, 10) || 0;
          for (let i = 1; i < ironCladMatches.length; i++) {
            const z = parseInt(window.getComputedStyle(ironCladMatches[i]).zIndex, 10) || 0;
            if (z > bestZ) {
              bestZ = z;
              bestModal = ironCladMatches[i];
            }
          }
          const rect = bestModal.getBoundingClientRect();
          return {
            ref: bestModal.getAttribute('data-agent-ref') || 'modal-detected',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        }

        // Phase 2: Legacy heuristic fallback (only when Layer 2 is disabled)
        if (__mc.enableLayer2) {
          return { ref: null, rect: null };
        }

        // Legacy: Two-pass approach
        const targetedModals = Array.from(document.querySelectorAll(__mc.overlaySelectors));
        const positionalCandidates = Array.from(document.querySelectorAll(__mc.positionalSelector));

        const seen = new WeakSet();
        const potentialModals: Element[] = [];
        for (const el of [...targetedModals, ...positionalCandidates]) {
          if (seen.has(el)) continue;
          seen.add(el);

          const style = window.getComputedStyle(el);
          if (style.position !== 'fixed' && style.position !== 'absolute') continue;
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (parseFloat(style.opacity) < 0.1) continue;

          const zIndex = parseInt(style.zIndex, 10);
          if (isNaN(zIndex) || zIndex < 1) continue;

          potentialModals.push(el);
        }

        if (potentialModals.length === 0) return { ref: null, rect: null };

        let bestModal: Element | null = null;
        let highestZIndex = 0;

        // @ts-expect-error - window available in browser context
        const viewportArea = window.innerWidth * window.innerHeight;
        const popupRegex = new RegExp(__mc.classRegexSource, 'i');

        for (const modal of potentialModals) {
          const style = window.getComputedStyle(modal);
          const zIndex = parseInt(style.zIndex, 10);
          const rect = modal.getBoundingClientRect();
          const modalArea = rect.width * rect.height;
          const coverage = viewportArea > 0 ? modalArea / viewportArea : 0;

          const modalRoleRaw2 = (modal.getAttribute('role') || '').replace(/["']/g, '').trim();
          const hasModalRole = modalRoleRaw2 === 'dialog' ||
                               (modal.getAttribute('aria-modal') || '').replace(/["']/g, '').trim() === 'true' ||
                               modal.classList.contains('modal') ||
                               modal.classList.contains('overlay');

          const classStr = (modal.getAttribute('class') || '').toLowerCase();
          const hasPopupClass = popupRegex.test(classStr);
          const hasInteractiveChildren = modal.querySelector(__mc.interactiveSelector) !== null;

          const isModal =
            (hasModalRole && coverage > 0.2) ||
            coverage > 0.4 ||
            (hasPopupClass && hasInteractiveChildren && coverage > 0.1) ||
            (hasInteractiveChildren && zIndex > 10 && coverage > 0.15);

          if (isModal && zIndex > highestZIndex) {
            highestZIndex = zIndex;
            bestModal = modal;
          }
        }

        if (bestModal) {
          const rect = bestModal.getBoundingClientRect();
          return {
            ref: bestModal.getAttribute('data-agent-ref') || 'modal-detected',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        }

        return { ref: null, rect: null };
      }, __mc2);

      // Check if modal appeared
      if (currentModalState.ref && !lastModalState.ref) {
        logger.debug('[ACTION_EXECUTOR] Modal appeared', {
          ref: currentModalState.ref,
          rect: currentModalState.rect,
        });
        lastModalState = currentModalState;
        stableCount = 0;
        await this.page.waitForTimeout(POLL_INTERVAL);
        continue;
      }

      // Check if modal is stable (same position/size for consecutive checks)
      if (currentModalState.ref && lastModalState.ref && currentModalState.rect && lastModalState.rect) {
        const isSamePosition =
          Math.abs(currentModalState.rect.x - lastModalState.rect.x) < 5 &&
          Math.abs(currentModalState.rect.y - lastModalState.rect.y) < 5 &&
          Math.abs(currentModalState.rect.width - lastModalState.rect.width) < 5 &&
          Math.abs(currentModalState.rect.height - lastModalState.rect.height) < 5;

        if (isSamePosition) {
          stableCount++;
          logger.debug('[ACTION_EXECUTOR] Modal stable check', { stableCount, required: STABILITY_CHECKS });

          if (stableCount >= STABILITY_CHECKS) {
            logger.info('[ACTION_EXECUTOR] Modal stabilized', {
              ref: currentModalState.ref,
              waitTime: Date.now() - startTime,
            });
            return; // Modal is stable, exit polling
          }
        } else {
          stableCount = 0; // Reset if position changed
        }
      }

      lastModalState = currentModalState;
      await this.page.waitForTimeout(POLL_INTERVAL);
    }

    // Timeout reached - modal may or may not have appeared
    if (lastModalState.ref) {
      logger.warn('[ACTION_EXECUTOR] Modal polling timeout, but modal detected (may not be fully stable)', {
        ref: lastModalState.ref,
        waitTime: MAX_WAIT_TIME,
      });
    } else {
      logger.debug('[ACTION_EXECUTOR] Modal polling timeout, no modal detected', {
        waitTime: MAX_WAIT_TIME,
      });
    }
  }
}
