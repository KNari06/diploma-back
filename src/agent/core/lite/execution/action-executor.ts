/**
 * ActionExecutor
 * Executes AI commands via safe switch/case with fuzzy fallback
 * SECURITY: NO arbitrary code execution - only whitelisted Playwright actions
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import type { Page, Locator } from 'playwright';
import { logger } from '@/utils/core/logger';
import type { AICommand, ExecutionResult, LiteSnapshot, ElementInfo } from '../lite-types';

export class ActionExecutor {
  private page: Page;
  private elementMap: Map<string, ElementInfo> = new Map();

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Execute AI command via safe switch/case
   * NO arbitrary code execution - only whitelisted actions
   *
   * @param command - Structured AI command
   * @param snapshot - Current page snapshot for fallback
   * @returns Execution result with fallback info
   */
  async execute(
    command: AICommand,
    snapshot: LiteSnapshot
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
        await locator.click({ timeout: 5000 });
        break;

      case 'fill':
        if (!locator || !cmd.value) throw new Error('fill requires ref and value');
        await locator.fill(cmd.value, { timeout: 5000 });
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
        await this.page.evaluate((dir) => {
          // @ts-expect-error - window available in browser context
          window.scrollBy(0, dir === 'up' ? -500 : 500);
        }, cmd.direction || 'down');
        break;

      case 'select':
        if (!locator || !cmd.value) throw new Error('select requires ref and value');
        await locator.selectOption(cmd.value, { timeout: 5000 });
        break;

      case 'hover':
        if (!locator) throw new Error('hover requires ref');
        await locator.hover({ timeout: 5000 });
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
   */
  private async executeFallbackAction(cmd: AICommand, locator: Locator): Promise<void> {
    switch (cmd.action) {
      case 'click':
        await locator.click({ timeout: 3000 });
        break;
      case 'fill':
        if (cmd.value) {
          await locator.fill(cmd.value, { timeout: 3000 });
        }
        break;
      case 'hover':
        await locator.hover({ timeout: 3000 });
        break;
      case 'select':
        if (cmd.value) {
          await locator.selectOption(cmd.value, { timeout: 3000 });
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
}
