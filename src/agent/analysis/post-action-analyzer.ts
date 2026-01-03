/**
 * PostActionAnalyzer
 * AI-driven analyzer that decides what to do after each action
 *
 * Key features:
 * - Analyzes DOM changes after action execution
 * - Uses AI to decide if follow-up actions are needed
 * - Handles autocomplete, suggestions, modals, validation errors
 * - Returns actionable follow-up steps
 */

import { AICostManager } from '@/services/ai/cost/ai-cost-manager.service';
import { logger } from '@/utils/core/logger';
import OpenAI from 'openai';
import { Page } from 'playwright';
import { DynamicAction } from '../types/intelligent-testing.types';

const openai = new OpenAI();

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PostActionContext {
  action: DynamicAction;
  actionResult: { success: boolean; error?: string };
  inputValue?: string;
  goal: string;
}

export interface DOMSnapshot {
  visibleElements: VisibleElement[];
  modals: ModalInfo[];
  errors: string[];
  buttonStates: ButtonState[];
}

interface VisibleElement {
  selector: string;
  text: string;
  tagName: string;
  type: 'button' | 'chip' | 'tag' | 'option' | 'link' | 'input' | 'error' | 'modal' | 'other';
  isNew?: boolean; // Appeared after action
  isClickable: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

interface ModalInfo {
  type: 'error' | 'success' | 'info' | 'confirm' | 'other';
  text: string;
  hasCloseButton: boolean;
  closeSelector?: string;
}

interface ButtonState {
  selector: string;
  text: string;
  isDisabled: boolean;
  wasDisabled?: boolean; // Was disabled before action
}

export interface PostActionDecision {
  needsFollowUp: boolean;
  followUpActions: DynamicAction[];
  reason: string;
  confidence: number;
  stateChange?: string; // What changed on the page
}

// ═══════════════════════════════════════════════════════════════════════════
// POST-ACTION ANALYZER
// ═══════════════════════════════════════════════════════════════════════════

export class PostActionAnalyzer {
  /**
   * Main entry: Analyze page after action and decide next steps
   */
  static async analyze(
    page: Page,
    context: PostActionContext,
    snapshotBefore?: DOMSnapshot,
    costManager?: AICostManager
  ): Promise<PostActionDecision> {
    const startTime = Date.now();

    try {
      // Skip analysis for non-interactive actions
      if (!this.shouldAnalyze(context.action)) {
        return {
          needsFollowUp: false,
          followUpActions: [],
          reason: 'Action type does not require post-action analysis',
          confidence: 1.0,
        };
      }

      // Wait for UI to react
      await page.waitForTimeout(300);

      // Get current DOM snapshot
      const snapshotAfter = await this.captureSnapshot(page);

      // Detect what changed
      const changes = this.detectChanges(snapshotBefore, snapshotAfter);

      // If nothing significant changed, skip AI call
      if (!changes.hasSignificantChanges) {
        logger.debug('[POST_ACTION] No significant changes detected');
        return {
          needsFollowUp: false,
          followUpActions: [],
          reason: 'No significant UI changes detected',
          confidence: 0.9,
        };
      }

      // Ask AI what to do
      const decision = await this.askAIForDecision(
        context,
        snapshotAfter,
        changes,
        costManager
      );

      logger.info('[POST_ACTION] Analysis complete', {
        action: context.action.description,
        needsFollowUp: decision.needsFollowUp,
        followUpCount: decision.followUpActions.length,
        duration: Date.now() - startTime,
      });

      return decision;

    } catch (error) {
      logger.error('[POST_ACTION] Analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        needsFollowUp: false,
        followUpActions: [],
        reason: 'Analysis failed, continuing without follow-up',
        confidence: 0.5,
      };
    }
  }

  /**
   * Check if action type needs post-action analysis
   */
  private static shouldAnalyze(action: DynamicAction): boolean {
    const analyzeActions = [
      'fill', 'type', 'click', 'select', 'check', 'uncheck',
    ];
    return analyzeActions.includes(action.action);
  }

  /**
   * Capture current DOM snapshot
   */
  static async captureSnapshot(page: Page): Promise<DOMSnapshot> {
    try {
      const snapshot = await page.evaluate(() => {
        const result: any = {
          visibleElements: [],
          modals: [],
          errors: [],
          buttonStates: [],
        };

        // Collect visible clickable elements
        const clickableSelectors = [
          'button', '[role="button"]', '[role="option"]',
          '[class*="chip"]', '[class*="tag"]', '[class*="suggestion"]',
          '[class*="option"]', 'li', 'a',
        ];

        for (const selector of clickableSelectors) {
          // @ts-expect-error - browser context
          const elements = document.querySelectorAll(selector);
          elements.forEach((el: any, idx: number) => {
            const rect = el.getBoundingClientRect();
            // @ts-expect-error - browser context
            const style = window.getComputedStyle(el);

            if (
              rect.width > 10 &&
              rect.height > 10 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              parseFloat(style.opacity) > 0.1
            ) {
              const text = el.textContent?.trim() || '';
              if (text.length > 0 && text.length < 200) {
                result.visibleElements.push({
                  selector: selector,
                  selectorIndex: idx,
                  text: text.substring(0, 100),
                  tagName: el.tagName.toLowerCase(),
                  type: selector.includes('chip') || selector.includes('tag') ? 'chip' :
                        selector.includes('suggestion') || selector.includes('option') ? 'option' :
                        el.tagName === 'BUTTON' ? 'button' :
                        el.tagName === 'A' ? 'link' : 'other',
                  isClickable: true,
                  boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                });
              }
            }
          });
        }

        // Collect modals/popups
        const modalSelectors = [
          '[role="dialog"]', '[role="alertdialog"]', '.modal', '.popup',
          '[class*="modal"]', '[class*="dialog"]', '[class*="overlay"]',
        ];
        for (const selector of modalSelectors) {
          // @ts-expect-error - browser context
          const modals = document.querySelectorAll(selector);
          modals.forEach((modal: any) => {
            // @ts-expect-error - browser context
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const closeBtn = modal.querySelector('[class*="close"], [aria-label*="close"], button');
              result.modals.push({
                type: 'other',
                text: modal.textContent?.trim().substring(0, 200) || '',
                hasCloseButton: !!closeBtn,
                closeSelector: closeBtn ? (closeBtn.id ? `#${closeBtn.id}` : null) : null,
              });
            }
          });
        }

        // Collect validation errors
        const errorSelectors = [
          '.error', '.error-message', '[class*="error"]',
          '[role="alert"]', '.invalid-feedback', '.validation-error',
        ];
        for (const selector of errorSelectors) {
          // @ts-expect-error - browser context
          const errors = document.querySelectorAll(selector);
          errors.forEach((err: any) => {
            const text = err.textContent?.trim();
            if (text && text.length > 2 && text.length < 200) {
              result.errors.push(text);
            }
          });
        }

        // Collect button states
        // @ts-expect-error - browser context
        const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        buttons.forEach((btn: any, idx: number) => {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            result.buttonStates.push({
              selector: btn.id ? `#${btn.id}` : `button:nth-of-type(${idx + 1})`,
              text: btn.textContent?.trim().substring(0, 50) || '',
              isDisabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true',
            });
          }
        });

        return result;
      });

      return snapshot;
    } catch (error) {
      logger.debug('[POST_ACTION] Snapshot capture failed', { error });
      return {
        visibleElements: [],
        modals: [],
        errors: [],
        buttonStates: [],
      };
    }
  }

  /**
   * Detect changes between snapshots
   */
  private static detectChanges(
    before: DOMSnapshot | undefined,
    after: DOMSnapshot
  ): {
    hasSignificantChanges: boolean;
    newElements: VisibleElement[];
    newErrors: string[];
    buttonStateChanges: { selector: string; text: string; becameEnabled: boolean }[];
    newModals: ModalInfo[];
  } {
    const newElements: VisibleElement[] = [];
    const newErrors: string[] = [];
    const buttonStateChanges: { selector: string; text: string; becameEnabled: boolean }[] = [];
    const newModals: ModalInfo[] = [];

    if (!before) {
      // First snapshot - everything is "new" but we only care about suggestions/chips
      newElements.push(...after.visibleElements.filter(el =>
        el.type === 'chip' || el.type === 'option'
      ));
    } else {
      // Compare elements
      const beforeTexts = new Set(before.visibleElements.map(el => el.text.toLowerCase()));
      for (const el of after.visibleElements) {
        if (!beforeTexts.has(el.text.toLowerCase())) {
          el.isNew = true;
          newElements.push(el);
        }
      }

      // Compare errors
      const beforeErrors = new Set(before.errors);
      for (const err of after.errors) {
        if (!beforeErrors.has(err)) {
          newErrors.push(err);
        }
      }

      // Compare button states
      const beforeButtonMap = new Map(
        before.buttonStates.map(b => [b.text.toLowerCase(), b.isDisabled])
      );
      for (const btn of after.buttonStates) {
        const wasBtnDisabled = beforeButtonMap.get(btn.text.toLowerCase());
        if (wasBtnDisabled === true && !btn.isDisabled) {
          buttonStateChanges.push({
            selector: btn.selector,
            text: btn.text,
            becameEnabled: true,
          });
        }
      }

      // Compare modals
      const beforeModalTexts = new Set(before.modals.map(m => m.text.substring(0, 50)));
      for (const modal of after.modals) {
        if (!beforeModalTexts.has(modal.text.substring(0, 50))) {
          newModals.push(modal);
        }
      }
    }

    const hasSignificantChanges =
      newElements.length > 0 ||
      newErrors.length > 0 ||
      buttonStateChanges.length > 0 ||
      newModals.length > 0;

    return {
      hasSignificantChanges,
      newElements,
      newErrors,
      buttonStateChanges,
      newModals,
    };
  }

  /**
   * Ask AI what to do based on changes
   */
  private static async askAIForDecision(
    context: PostActionContext,
    snapshot: DOMSnapshot,
    changes: {
      newElements: VisibleElement[];
      newErrors: string[];
      buttonStateChanges: { selector: string; text: string; becameEnabled: boolean }[];
      newModals: ModalInfo[];
    },
    costManager?: AICostManager
  ): Promise<PostActionDecision> {
    try {
      // Build context for AI
      const changesDescription = this.buildChangesDescription(changes);
      const visibleElementsList = snapshot.visibleElements
        .slice(0, 15)
        .map((el, i) => `[${i}] ${el.type}: "${el.text}" (${el.selector})`)
        .join('\n');

      // Extract text from the action that was just executed to avoid duplicate clicks
      const executedActionText = this.extractActionText(context.action);

      const prompt = `You are a QA automation expert analyzing a web page after an action was executed.

ACTION EXECUTED:
- Type: ${context.action.action}
- Target: ${context.action.selector || 'N/A'}
- Value: ${context.inputValue || context.action.value || 'N/A'}
- Description: ${context.action.description}
- Result: ${context.actionResult.success ? 'Success' : 'Failed: ' + context.actionResult.error}
${executedActionText ? `- Action text: "${executedActionText}"` : ''}

TESTING GOAL: ${context.goal}

CHANGES DETECTED AFTER ACTION:
${changesDescription}

VISIBLE CLICKABLE ELEMENTS:
${visibleElementsList || 'None detected'}

TASK:
Decide if any follow-up action is needed to complete the current step.

Common scenarios requiring follow-up:
1. Autocomplete: After typing, a suggestion appeared → click it
2. Dropdown: After clicking, options appeared → select one
3. Validation: Error appeared → fix the input
4. Modal: Dialog appeared → close or interact
5. Button state: A submit button became enabled → ready to proceed

RESPONSE (JSON only):
{
  "needsFollowUp": true/false,
  "reason": "<brief explanation>",
  "stateChange": "<what changed on the page>",
  "followUpActions": [
    {
      "action": "click|fill|select",
      "selectorIndex": <index from visible elements list>,
      "description": "<what this does>"
    }
  ],
  "confidence": 0.0-1.0
}

RULES:
- Only suggest follow-up if NECESSARY to complete the current step
- Use selectorIndex from the visible elements list above
- Maximum 2 follow-up actions
- If action succeeded and no interaction needed → needsFollowUp: false
- CRITICAL: Do NOT suggest clicking on the same element that was just clicked (check action description and text)
- If the executed action was a click and succeeded, do NOT suggest clicking the same button/element again`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a QA automation expert. Respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty AI response');
      }

      // Track AI cost
      if (costManager) {
        costManager.recordOperation({
          operation: 'post_action_analysis',
          model: 'gpt-4o-mini',
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        });
      }

      const decision = JSON.parse(content);

      logger.debug('[POST_ACTION] AI decision', {
        needsFollowUp: decision.needsFollowUp,
        reason: decision.reason,
        actionsCount: decision.followUpActions?.length || 0,
      });

      // Convert AI response to DynamicActions
      const followUpActions: DynamicAction[] = [];
      if (decision.needsFollowUp && decision.followUpActions) {
        const executedActionText = this.extractActionText(context.action);

        for (const aiAction of decision.followUpActions.slice(0, 2)) {
          const targetElement = snapshot.visibleElements[aiAction.selectorIndex];
          if (targetElement) {
            // ✅ FIX: Skip if this is a duplicate of the action we just executed
            if (this.isDuplicateAction(context.action, targetElement, executedActionText)) {
              logger.debug('[POST_ACTION] Skipping duplicate follow-up action', {
                executedAction: context.action.description,
                followUpAction: targetElement.text,
              });
              continue;
            }

            followUpActions.push({
              action: aiAction.action || 'click',
              selector: `${targetElement.selector}:nth-of-type(${(targetElement as any).selectorIndex + 1})`,
              description: aiAction.description || `Follow-up: ${aiAction.action} on ${targetElement.text}`,
              optional: true,
              timeout: 3000,
            });
          }
        }
      }

      return {
        needsFollowUp: decision.needsFollowUp && followUpActions.length > 0,
        followUpActions,
        reason: decision.reason || 'AI decision',
        confidence: decision.confidence || 0.7,
        stateChange: decision.stateChange,
      };

    } catch (error) {
      logger.debug('[POST_ACTION] AI decision failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: simple rule-based decision
      return this.fallbackDecision(context, changes, snapshot);
    }
  }

  /**
   * Build human-readable description of changes
   */
  private static buildChangesDescription(changes: {
    newElements: VisibleElement[];
    newErrors: string[];
    buttonStateChanges: { selector: string; text: string; becameEnabled: boolean }[];
    newModals: ModalInfo[];
  }): string {
    const parts: string[] = [];

    if (changes.newElements.length > 0) {
      const elementList = changes.newElements
        .slice(0, 5)
        .map(el => `- ${el.type}: "${el.text}"`)
        .join('\n');
      parts.push(`NEW ELEMENTS APPEARED:\n${elementList}`);
    }

    if (changes.newErrors.length > 0) {
      parts.push(`VALIDATION ERRORS:\n${changes.newErrors.slice(0, 3).map(e => `- ${e}`).join('\n')}`);
    }

    if (changes.buttonStateChanges.length > 0) {
      const enabled = changes.buttonStateChanges.filter(b => b.becameEnabled);
      if (enabled.length > 0) {
        parts.push(`BUTTONS BECAME ENABLED:\n${enabled.map(b => `- "${b.text}"`).join('\n')}`);
      }
    }

    if (changes.newModals.length > 0) {
      parts.push(`NEW MODALS/DIALOGS:\n${changes.newModals.map(m => `- ${m.text.substring(0, 50)}`).join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : 'No significant changes detected';
  }

  /**
   * Extract text from action description/selector to identify what was clicked
   */
  private static extractActionText(action: DynamicAction): string | null {
    if (!action.description) return null;

    // Try to extract button/element text from description
    // Examples: "Click the 'Найти репетитора' button" → "Найти репетитора"
    const match = action.description.match(/['"]([^'"]+)['"]/);
    if (match) return match[1].toLowerCase();

    // Fallback: extract from selector if it's a text selector
    if (action.selector?.includes('text=')) {
      const textMatch = action.selector.match(/text=["']([^"']+)["']/);
      if (textMatch) return textMatch[1].toLowerCase();
    }

    return null;
  }

  /**
   * Check if follow-up action is a duplicate of the executed action
   */
  private static isDuplicateAction(
    executedAction: DynamicAction,
    targetElement: VisibleElement,
    executedActionText: string | null
  ): boolean {
    // If executed action was a click, check if we're trying to click the same element
    if (executedAction.action === 'click' && targetElement.type === 'button') {
      // Compare by text if we have it
      if (executedActionText) {
        const targetText = targetElement.text.toLowerCase();
        if (targetText.includes(executedActionText) || executedActionText.includes(targetText)) {
          return true;
        }
      }

      // Compare by description
      if (executedAction.description && targetElement.text) {
        const descLower = executedAction.description.toLowerCase();
        const elementTextLower = targetElement.text.toLowerCase();
        // If description mentions the element text, it's likely the same element
        if (descLower.includes(elementTextLower) || elementTextLower.includes(descLower.split("'")[1] || '')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Fallback decision when AI fails
   */
  private static fallbackDecision(
    context: PostActionContext,
    changes: {
      newElements: VisibleElement[];
      newErrors: string[];
      buttonStateChanges: { selector: string; text: string; becameEnabled: boolean }[];
      newModals: ModalInfo[];
    },
    snapshot: DOMSnapshot
  ): PostActionDecision {
    const followUpActions: DynamicAction[] = [];
    const executedActionText = this.extractActionText(context.action);

    // Rule 1: If new chips/options appeared after fill/type, click matching one
    if (
      (context.action.action === 'fill' || context.action.action === 'type') &&
      context.inputValue &&
      changes.newElements.length > 0
    ) {
      const inputLower = context.inputValue.toLowerCase();
      const matchingElement = changes.newElements.find(el =>
        el.text.toLowerCase().includes(inputLower) ||
        inputLower.includes(el.text.toLowerCase())
      );

      if (matchingElement && !this.isDuplicateAction(context.action, matchingElement, executedActionText)) {
        followUpActions.push({
          action: 'click',
          selector: `${matchingElement.selector}:has-text("${matchingElement.text}")`,
          description: `Click suggestion: ${matchingElement.text}`,
          optional: true,
          timeout: 2000,
        });
      }
    }

    // Rule 2: Close new modals
    if (changes.newModals.length > 0) {
      const modalWithClose = changes.newModals.find(m => m.hasCloseButton && m.closeSelector);
      if (modalWithClose?.closeSelector) {
        followUpActions.push({
          action: 'click',
          selector: modalWithClose.closeSelector,
          description: 'Close modal',
          optional: true,
          timeout: 2000,
        });
      }
    }

    // ✅ FIX: Don't suggest clicking on a button that was just clicked
    // Rule 3: Button became enabled - only suggest if it wasn't just clicked
    if (changes.buttonStateChanges.length > 0 && context.action.action !== 'click') {
      const enabledButton = changes.buttonStateChanges.find(b => b.becameEnabled);
      if (enabledButton) {
        // Find the button in snapshot
        const buttonElement = snapshot.visibleElements.find(
          el => el.text.toLowerCase() === enabledButton.text.toLowerCase() && el.type === 'button'
        );

        if (buttonElement && !this.isDuplicateAction(context.action, buttonElement, executedActionText)) {
          // Only suggest if it's a different button than what was clicked
          followUpActions.push({
            action: 'click',
            selector: enabledButton.selector,
            description: `Click enabled button: ${enabledButton.text}`,
            optional: true,
            timeout: 3000,
          });
        }
      }
    }

    return {
      needsFollowUp: followUpActions.length > 0,
      followUpActions,
      reason: followUpActions.length > 0 ? 'Fallback rule-based decision' : 'No follow-up needed',
      confidence: 0.6,
    };
  }
}
