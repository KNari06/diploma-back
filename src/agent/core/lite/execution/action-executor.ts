/**
 * ActionExecutor
 * Executes AI commands via safe switch/case with fuzzy fallback
 * SECURITY: NO arbitrary code execution - only whitelisted Playwright actions
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { logger } from '@/utils/core/logger';
import type { Locator, Page } from 'playwright';
import type { AICommand, ElementInfo, ExecutionResult, LiteSnapshot, ModalDismissInfo } from '../lite-types';

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
}

export class ActionExecutor {
  private page: Page;
  private elementMap: Map<string, ElementInfo> = new Map();

  // ✅ FIX: Configurable timeouts for different action types
  private readonly DEFAULT_TIMEOUT = 10000; // 10s for most actions (increased from 5s)
  private readonly NAVIGATION_TIMEOUT = 15000; // 15s for actions that may trigger navigation
  private readonly FALLBACK_TIMEOUT = 8000; // 8s for fallback attempts

  // ✅ REMOVED: Hardcoded ENTRY_POINT_KEYWORDS
  // Now passed dynamically via execute() options from GoalDetector's AI-generated strategy

  constructor(page: Page) {
    this.page = page;
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

    // Build element lookup map for fallback
    snapshot.elements.forEach((el) => {
      this.elementMap.set(el.ref, {
        text: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.name,
        tag: el.tag,
        type: el.type,
      });
    });

    try {
      // Validate command
      this.validateCommand(command);

      // Execute command
      await this.executeCommand(command);

      // ✅ NEW: After click, check for unexpected modal and try to dismiss (Lite Autonomy v3)
      if (command.action === 'click' && options?.modalKeywords) {
        modalDismissInfo = await this.handleUnexpectedModal(options.modalKeywords);
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
        const fallback = await this.tryFuzzyFallback(command, options);
        if (fallback.success) {
          logger.info('[ACTION_EXECUTOR] Fallback successful', {
            info: fallback.info,
            usedForceClick: fallback.usedForceClick,
          });
          return {
            success: true,
            duration: Date.now() - startTime,
            startTime,
            usedFallback: true,
            fallbackInfo: fallback.info,
            modalDismissInfo: fallback.modalDismissInfo,
            usedForceClick: fallback.usedForceClick,
          };
        }
      }

      logger.error('[ACTION_EXECUTOR] Command failed', {
        action: command.action,
        error: errorMsg,
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
    // Validate ref format if present
    if (command.ref && !/^e\d+$/.test(command.ref)) {
      throw new Error(`Invalid ref format: ${command.ref}`);
    }

    // Validate URL schema
    if (command.url) {
      try {
        const url = new URL(command.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error(`Invalid URL protocol: ${url.protocol}`);
        }
      } catch {
        throw new Error(`Invalid URL: ${command.url}`);
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

    // Validate scroll extras
    if (command.action === 'scroll') {
      if (command.targetRef && !/^e\d+$/.test(command.targetRef)) {
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
   */
  private async executeCommand(cmd: AICommand): Promise<void> {
    const locator = cmd.ref
      ? this.page.locator(`[data-agent-ref="${cmd.ref}"]`)
      : null;

    switch (cmd.action) {
      case 'click':
        if (!locator) throw new Error('click requires ref');
        // ✅ FIX: Use longer timeout for clicks (may trigger navigation/modals)
        await locator.click({ timeout: this.NAVIGATION_TIMEOUT });
        break;

      case 'fill':
        if (!locator || !cmd.value) throw new Error('fill requires ref and value');
        // ✅ FIX: Use pressSequentially() for better compatibility with masked inputs
        // This simulates real typing and works better with phone masks, date pickers, etc.
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
        break;

      case 'press':
        if (!cmd.key) throw new Error('press requires key');
        await this.page.keyboard.press(cmd.key);
        break;

      case 'goto':
        if (!cmd.url) throw new Error('goto requires url');
        await this.page.goto(cmd.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        break;

      case 'scroll':
        // If a targetRef is provided, scroll that element into view.
        if (cmd.targetRef) {
          const target = this.page.locator(`[data-agent-ref="${cmd.targetRef}"]`);
          await target.scrollIntoViewIfNeeded({ timeout: this.DEFAULT_TIMEOUT });

          // ✅ EXPERT ADVICE: Add offset for sticky headers (100px up)
          // Many sites have sticky nav bars that cover the element after scrollIntoView
          await this.page.evaluate(() => {
            const STICKY_HEADER_OFFSET = 100; // pixels to scroll up after element is in view
            // @ts-expect-error - window available in browser context
            window.scrollBy(0, -STICKY_HEADER_OFFSET);
          });

          break;
        }

        // Otherwise, scroll by amount (default 500px). Clamp to avoid extreme scrolls.
        await this.page.evaluate(
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
        await locator.selectOption(cmd.value, { timeout: this.DEFAULT_TIMEOUT });
        break;

      case 'hover':
        if (!locator) throw new Error('hover requires ref');
        await locator.hover({ timeout: this.DEFAULT_TIMEOUT });
        break;

      case 'wait':
        await this.page.waitForTimeout(1000);
        break;

      default:
        throw new Error(`Unknown action: ${(cmd as any).action}`);
    }
  }

  /**
   * Fuzzy fallback: find element by attributes if ref not found
   * Priority: placeholder → aria-label → text content → role+name
   * NEW: Includes staged self-healing and modal handling
   */
  private async tryFuzzyFallback(
    cmd: AICommand,
    options?: ExecuteOptions
  ): Promise<{
    success: boolean;
    info?: string;
    usedForceClick?: boolean;
    modalDismissInfo?: ModalDismissInfo;
  }> {
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
            locator: this.page.locator(`[placeholder="${el.placeholder}"]`),
            name: 'placeholder',
          }
        : undefined,
      // 2. By aria-label
      el.ariaLabel
        ? {
            locator: this.page.getByLabel(el.ariaLabel),
            name: 'aria-label',
          }
        : undefined,
      // 3. By text content
      el.text
        ? {
            locator: this.page.getByText(el.text, { exact: false }).first(),
            name: 'text',
          }
        : undefined,
      // 4. By role + name
      el.text && roleFromTag(el.tag)
        ? {
            locator: this.page.getByRole(roleFromTag(el.tag) as any, { name: el.text }),
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
  ): Promise<{ usedForceClick: boolean }> {
    let usedForceClick = false;

    switch (cmd.action) {
      case 'click':
        usedForceClick = await this.stagedClickWithSelfHealing(locator, options);
        break;
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
          await locator.selectOption(cmd.value, { timeout: this.FALLBACK_TIMEOUT });
        }
        break;
      default:
        throw new Error(`Fallback not supported for action: ${cmd.action}`);
    }

    return { usedForceClick };
  }

  /**
   * Staged click with self-healing (Lite Autonomy v3)
   * Tries multiple strategies before falling back to force click
   */
  private async stagedClickWithSelfHealing(
    locator: Locator,
    options?: ExecuteOptions
  ): Promise<boolean> {
    // Stage 1: Normal click
    try {
      await locator.click({ timeout: this.FALLBACK_TIMEOUT });
      return false; // No force needed
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

    // Stage 2: Try to dismiss modal if present
    if (options?.modalKeywords) {
      const dismissResult = await this.handleUnexpectedModal(options.modalKeywords);
      if (dismissResult.dismissed) {
        logger.info('[ACTION_EXECUTOR] Modal dismissed, retrying click');
        try {
          await locator.click({ timeout: this.FALLBACK_TIMEOUT });
          return false;
        } catch {
          // Continue to next stage
        }
      }
    }

    // Stage 3: Try scroll offset (for sticky headers)
    try {
      await this.page.evaluate(() => {
        // @ts-expect-error
        window.scrollBy(0, -150); // Scroll up to reveal element
      });
      await this.page.waitForTimeout(200);
      await locator.click({ timeout: this.FALLBACK_TIMEOUT });
      logger.info('[ACTION_EXECUTOR] Click successful after scroll offset');
      return false;
    } catch {
      // Continue to next stage
    }

    // Stage 4: Brief wait (for transient overlays)
    try {
      await this.page.waitForTimeout(1000);
      await locator.click({ timeout: this.FALLBACK_TIMEOUT });
      logger.info('[ACTION_EXECUTOR] Click successful after brief wait');
      return false;
    } catch {
      // Continue to force click
    }

    // Stage 5: Force click (last resort)
    logger.warn('[ACTION_EXECUTOR] All self-healing attempts failed, using force click');
    await locator.click({ timeout: this.FALLBACK_TIMEOUT, force: true });
    return true; // Force was used
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

    // Detect modal and get its text
    const modalInfo = await this.detectActiveModalWithText();

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
   * Detect active modal and get its text content
   */
  private async detectActiveModalWithText(): Promise<{
    hasModal: boolean;
    ref?: string;
    text?: string;
  }> {
    return await this.page.evaluate(() => {
      // Find potential modals
      const potentialModals = Array.from(document.querySelectorAll('*')).filter((el: Element) => {
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') return false;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) < 0.1) return false;

        const zIndex = parseInt(style.zIndex, 10);
        if (isNaN(zIndex) || zIndex < 1) return false;

        return true;
      });

      if (potentialModals.length === 0) return { hasModal: false };

      // Find highest z-index modal
      let bestModal: Element | null = null;
      let highestZIndex = 0;

      for (const modal of potentialModals) {
        const style = window.getComputedStyle(modal);
        const zIndex = parseInt(style.zIndex, 10);
        const rect = modal.getBoundingClientRect();

        // @ts-expect-error
        const viewportArea = window.innerWidth * window.innerHeight;
        const modalArea = rect.width * rect.height;
        const coverage = modalArea / viewportArea;

        const hasModalRole = modal.getAttribute('role') === 'dialog' ||
                             modal.getAttribute('aria-modal') === 'true' ||
                             modal.classList.contains('modal') ||
                             modal.classList.contains('overlay') ||
                             modal.classList.contains('popup');

        const isModal = (hasModalRole && coverage > 0.1) || coverage > 0.3;

        if (isModal && zIndex > highestZIndex) {
          highestZIndex = zIndex;
          bestModal = modal;
        }
      }

      if (!bestModal) return { hasModal: false };

      const ref = bestModal.getAttribute('data-agent-ref') || undefined;
      const text = bestModal.textContent?.trim().slice(0, 500) || '';

      return { hasModal: true, ref, text };
    });
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

          // Prefer role="button"
          if (candidate.getAttribute('role') === 'button') score += 1;

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
      await this.page.locator(`[data-agent-ref="${closeButton}"]`).click({ timeout: 3000 });
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
      // Check for modal in current page state
      const currentModalState = await this.page.evaluate(() => {
        // Find potential overlay/modal containers
        const potentialModals = Array.from(document.querySelectorAll('*')).filter((el: Element) => {
          const style = window.getComputedStyle(el);
          const position = style.position;

          if (position !== 'fixed' && position !== 'absolute') return false;
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity) < 0.1) return false;

          // ✅ FIX: Use same z-index threshold as SnapshotCollector (zIndex >= 1)
          const zIndex = parseInt(style.zIndex, 10);
          if (isNaN(zIndex) || zIndex < 1) return false;

          return true;
        });

        if (potentialModals.length === 0) return { ref: null, rect: null };

        // Find highest z-index modal
        let bestModal: Element | null = null;
        let highestZIndex = 0;

        for (const modal of potentialModals) {
          const style = window.getComputedStyle(modal);
          const zIndex = parseInt(style.zIndex, 10);
          const rect = modal.getBoundingClientRect();

          // @ts-expect-error - window available in browser context
          const viewportArea = window.innerWidth * window.innerHeight;
          const modalArea = rect.width * rect.height;
          const coverage = modalArea / viewportArea;

          const hasModalRole = modal.getAttribute('role') === 'dialog' ||
                               modal.getAttribute('aria-modal') === 'true' ||
                               modal.classList.contains('modal') ||
                               modal.classList.contains('overlay');

          const isModal = (hasModalRole && coverage > 0.2) || coverage > 0.4;

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
      });

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
