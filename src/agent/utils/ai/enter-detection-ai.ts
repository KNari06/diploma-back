import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { logger } from '@/utils/core/logger';
import { Locator, Page } from 'playwright';

/**
 * AI-powered Enter key detection after fill action
 * Uses GPT-4o-mini to intelligently decide based on context
 */

interface InputContext {
  type: string;
  placeholder: string;
  name: string;
  id: string;
  className: string;
  ariaLabel: string;
  maxLength: number;
  autocomplete: string;
  pattern: string;
  tagName: string;
  isInModal: boolean;
  formInfo: {
    hasSubmitButton: boolean;
    formId: string | null;
  } | null;
  outerHTML: string;
}

/**
 * Gather context about input element for AI analysis
 */
async function gatherInputContext(locator: Locator, page: Page): Promise<InputContext | null> {
  // @ts-expect-error - HTMLElement, HTMLInputElement, HTMLTextAreaElement are browser globals
  const inputContext = await locator.evaluate((el: HTMLElement) => {
    // @ts-expect-error - HTMLInputElement, HTMLTextAreaElement are browser globals
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // @ts-expect-error - HTMLInputElement is browser global
      const input = el instanceof HTMLInputElement ? el : null;

      // Get form context
      let formInfo = null;
      if (el.form) {
        const form = el.form;
        formInfo = {
          hasSubmitButton: !!form.querySelector('button[type="submit"], input[type="submit"], button:not([type])'),
          formId: form.id || null,
        };
      }

      // Get modal/dialog context
      const isInModal = !!el.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog, [data-modal]');

      return {
        type: input ? input.type : 'textarea',
        placeholder: el.placeholder || '',
        name: el.name || '',
        id: el.id || '',
        className: el.className || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        maxLength: input ? input.maxLength : -1,
        autocomplete: input ? input.autocomplete : '',
        pattern: input ? input.pattern || '' : '',
        tagName: el.tagName.toLowerCase(),
        isInModal,
        formInfo,
        outerHTML: el.outerHTML.substring(0, 300), // Limited for AI context
      };
    }
    return null;
  }).catch(() => null);

  return inputContext;
}

/**
 * Count total inputs on page
 */
async function countInputs(page: Page): Promise<number> {
  return await page.evaluate(() => {
    // @ts-expect-error - document is browser global
    return document.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], input[type="password"], input:not([type]), textarea').length;
  }).catch(() => 999);
}

/**
 * Build AI prompt for Enter key detection
 */
function buildEnterDetectionPrompt(
  inputContext: InputContext,
  description?: string,
  totalInputs?: number
): string {
  return `Analyze this input field and determine if Enter key should be automatically pressed after filling it.

INPUT CONTEXT:
- Type: ${inputContext.type}
- Placeholder: "${inputContext.placeholder}"
- Name: "${inputContext.name}"
- ID: "${inputContext.id}"
- Class: "${inputContext.className}"
- ARIA Label: "${inputContext.ariaLabel}"
- Tag: ${inputContext.tagName}
- Max Length: ${inputContext.maxLength}
- Autocomplete: ${inputContext.autocomplete}
- Pattern: ${inputContext.pattern}
- In Modal/Dialog: ${inputContext.isInModal}
- Total inputs on page: ${totalInputs}

${inputContext.formInfo ? `FORM CONTEXT:
- In Form: Yes
- Has Submit Button: ${inputContext.formInfo.hasSubmitButton}
- Form ID: ${inputContext.formInfo.formId || 'none'}
` : 'FORM CONTEXT: Not in a form'}

${description ? `ACTION DESCRIPTION: "${description}"` : ''}

ELEMENT HTML (partial):
${inputContext.outerHTML}

WHEN TO PRESS ENTER (comprehensive list):

**Search & Query:**
1. ✅ Search inputs (type="search", placeholder/name contains "search", "find", "поиск", "query", "filter")
2. ✅ Single input on page (likely search or single-field form)
3. ✅ URL/address inputs (type="url" or contains "url", "address", "адрес")

**Forms without Submit Button:**
4. ✅ Input in form WITHOUT submit button (user expects Enter to submit)
5. ✅ Input in modal/dialog without submit button

**Authentication:**
6. ✅ Password field in login context (after password, Enter should submit)
7. ✅ Login forms (typically email/username + password, last field should submit on Enter)

**Short Codes & Verification:**
8. ✅ Short inputs for codes (maxLength 4-10, contains "code", "otp", "pin", "verification", "подтверждение")
9. ✅ Number/Tel inputs for verification (type="number" or "tel" + short maxLength + code-related name)
10. ✅ Inputs with pattern validation for codes (has pattern attribute + short maxLength)

**Chat & Messaging:**
11. ✅ Chat/message inputs (single-line textarea, contains "message", "chat", "comment", "reply", "сообщение")
12. ✅ Single-line textarea (rows=1 or height < 50px) for messages

**Command & Technical:**
13. ✅ Command/terminal-like inputs (autocomplete="off", contains "command", "cmd", "terminal", "prompt")

**Context Hints:**
14. ✅ Action description suggests submission ("search for", "find", "submit", "send", "enter", "go", "отправить", "искать")

WHEN NOT TO PRESS ENTER (be conservative):

**Forms with Submit Button:**
1. ❌ Input in form WITH submit button (user should click button for clarity)
2. ❌ Multi-field forms with visible submit button (let user click button)

**Multi-line Content:**
3. ❌ Multi-line textarea (Enter should create new line, not submit)
4. ❌ Textarea with rows > 2 (clearly for multi-line input)

**Registration & Multi-step Forms:**
5. ❌ Email/username in registration form with multiple fields (more fields to fill)
6. ❌ First name/last name in multi-field forms (not the last required field)
7. ❌ Regular text inputs in multi-field forms (unless it's the last field)

**Special Cases:**
8. ❌ File input fields (Enter doesn't make sense)
9. ❌ Color/date/time pickers (Enter doesn't submit)
10. ❌ When unclear - default to NO (safer to not press Enter than to submit prematurely)

**DECISION STRATEGY:**
- If total inputs = 1 AND (search-related OR no submit button) → PRESS ENTER
- If password field AND login context → PRESS ENTER
- If short code input (maxLength ≤ 10) → PRESS ENTER
- If in modal AND no submit button → PRESS ENTER
- If form has submit button → DON'T PRESS (let user click)
- If multi-field form AND not last field → DON'T PRESS
- When in doubt → DON'T PRESS (safer default)

Return JSON:
{
  "shouldPressEnter": true|false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation (1 sentence)"
}`;
}

/**
 * Use AI to determine if Enter should be pressed after fill
 */
export async function shouldPressEnterAfterFill(
  locator: Locator,
  page: Page,
  description?: string
): Promise<boolean> {
  try {
    // Gather context
    const inputContext = await gatherInputContext(locator, page);
    if (!inputContext) {
      return false;
    }

    const totalInputs = await countInputs(page);

    // Build AI prompt
    const prompt = buildEnterDetectionPrompt(inputContext, description, totalInputs);

    // Call GPT-4o-mini
    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are an expert at understanding form behavior. Determine if Enter key should be pressed after filling an input. Return ONLY valid JSON.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 150,
    });

    // Parse AI response
    const result = JSON.parse(response.content);

    logger.debug('[ENTER_DETECTION_AI] AI decision', {
      shouldPress: result.shouldPressEnter,
      confidence: result.confidence,
      reasoning: result.reasoning,
      inputType: inputContext.type,
      inputName: inputContext.name,
    });

    // Use AI decision if confidence is high enough
    if (result.confidence >= 0.7) {
      return result.shouldPressEnter === true;
    }

    // Low confidence fallback: don't press Enter (safe default)
    logger.debug('[ENTER_DETECTION_AI] AI confidence too low, defaulting to false', {
      confidence: result.confidence,
    });
    return false;

  } catch (error) {
    // If AI fails, fall back to safe default (don't press Enter)
    logger.debug('[ENTER_DETECTION_AI] Error in AI detection, defaulting to false', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
