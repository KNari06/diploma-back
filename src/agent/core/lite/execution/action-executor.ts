/**
 * ActionExecutor
 * Executes AI commands via safe switch/case with fuzzy fallback
 * SECURITY: NO arbitrary code execution - only whitelisted Playwright actions
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { logger } from '@/utils/core/logger';
import type { Locator, Page } from 'playwright';
import type { AICommand, ElementInfo, ExecutionResult, LiteSnapshot } from '../lite-types';

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
   * @param options - Optional execution options (e.g., entryPointKeywords from AI strategy)
   * @returns Execution result with fallback info
   */
  async execute(
    command: AICommand,
    snapshot: LiteSnapshot,
    options?: { entryPointKeywords?: string[] }
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

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

      // ✅ NEW: After click on entry point, wait for modal to appear and stabilize
      // Uses dynamic keywords from AI strategy (no hardcoded keywords)
      if (command.action === 'click' && command.ref) {
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
      });

      return {
        success: true,
        duration: Date.now() - startTime,
        startTime,
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
        const fallback = await this.tryFuzzyFallback(command);
        if (fallback.success) {
          logger.info('[ACTION_EXECUTOR] Fallback successful', {
            info: fallback.info,
          });
          return {
            success: true,
            duration: Date.now() - startTime,
            startTime,
            usedFallback: true,
            fallbackInfo: fallback.info,
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
   */
  private async tryFuzzyFallback(
    cmd: AICommand
  ): Promise<{ success: boolean; info?: string }> {
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
          // Execute the original action on found element
          await this.executeFallbackAction(cmd, strategy.locator);

          return {
            success: true,
            info: `Ref ${cmd.ref} stale, found by ${strategy.name}: "${el.text?.slice(0, 30)}"`,
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
   * Execute action on fallback locator
   * ✅ FIX: Uses force: true for clicks to handle overlapping elements
   */
  private async executeFallbackAction(cmd: AICommand, locator: Locator): Promise<void> {
    switch (cmd.action) {
      case 'click':
        // ✅ FIX: First try normal click, then try with force if it fails
        try {
          await locator.click({ timeout: this.FALLBACK_TIMEOUT });
        } catch (error) {
          logger.debug('[ACTION_EXECUTOR] Normal fallback click failed, trying force click', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Force click at element coordinates even if obscured by overlay
          await locator.click({ timeout: this.FALLBACK_TIMEOUT, force: true });
        }
        break;
      case 'fill':
        if (cmd.value) {
          // ✅ FIX: Use same pressSequentially() logic as primary execution
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
