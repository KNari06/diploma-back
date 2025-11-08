import { Page } from 'playwright';
import { logger } from '@/utils/logger';
import { getChatCompletionWithMessages } from '@/services/openai.service';
import { buildApprovalDetectionPrompt } from '@/ai/prompts/index';

/**
 * AI-powered helper functions
 * Uses GPT-3.5-turbo for cost-effective simple tasks
 */

/**
 * Detect user approval/rejection of test plan
 * Universal AI-powered detection - user can write ANYTHING
 * Uses GPT-3.5-turbo for cost efficiency
 */
export async function detectUserApproval(
  userMessage: string
): Promise<{
  approved: boolean | null; // true = approve, false = reject, null = unclear
  confidence: number; // 0.0-1.0
  reasoning?: string;
}> {
  try {
    logger.info('Detecting user approval with AI', {
      message: userMessage.substring(0, 50),
    });

    // Use centralized prompt
    const prompt = buildApprovalDetectionPrompt(userMessage);

    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are an intent detection expert. Detect approval/rejection from ANY natural language input. Return ONLY valid JSON.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      model: 'gpt-3.5-turbo',
      temperature: 0.2, // Low temp for consistent results
      max_tokens: 100,
    });

    const parsed = JSON.parse(response);

    logger.info('User approval detected', {
      approved: parsed.approved,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    });

    return {
      approved: parsed.approved,
      confidence: parsed.confidence || 0,
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    logger.error('Failed to detect user approval', { error });

    // Fallback: simple keyword matching
    const message = userMessage.toLowerCase().trim();

    const approvalKeywords = ['да', 'давай', 'ок', 'согласен', 'го', 'хорошо', 'go', 'yes', 'ok', 'sure', 'запускай', '+', 'подтверждаю', 'accept'];
    const rejectionKeywords = ['нет', 'не надо', 'отмена', 'стоп', 'no', 'cancel', 'reject', 'stop', '-', 'отклоняю'];

    // Check approval
    if (approvalKeywords.some(k => message.includes(k))) {
      return { approved: true, confidence: 0.6, reasoning: 'Keyword matching (fallback)' };
    }

    // Check rejection
    if (rejectionKeywords.some(k => message.includes(k))) {
      return { approved: false, confidence: 0.6, reasoning: 'Keyword matching (fallback)' };
    }

    // Unclear
    return { approved: null, confidence: 0.1, reasoning: 'No clear intent (fallback)' };
  }
}

/**
 * Detect login page using AI (fallback to hardcode)
 * Uses GPT-3.5-turbo for cost efficiency
 */
export async function detectLoginPage(
  baseUrl: string,
  page: Page
): Promise<string | null> {
  try {
    logger.info('Detecting login page with AI', { baseUrl });

    // First try hardcoded paths (fast + free)
    const commonPaths = ['/login', '/signin', '/auth/login', '/account/login', '/log-in', '/sign-in'];

    for (const path of commonPaths) {
      const testUrl = `${baseUrl}${path}`;
      try {
        const response = await page.goto(testUrl, {
          timeout: 5000,
          waitUntil: 'domcontentloaded'
        });
        if (response?.ok()) {
          logger.info('Login page found (hardcode)', { path: testUrl });
          return testUrl;
        }
      } catch {
        continue;
      }
    }

    // If hardcode failed, try AI detection
    logger.info('Hardcode paths failed, trying AI detection');

    // Get all links from homepage
    const links = await page.evaluate(() => {
      // @ts-expect-error - browser context
      return Array.from(document.querySelectorAll('a[href]')).map((a: any) => ({
        text: a.textContent?.trim().toLowerCase(),
        href: a.getAttribute('href'),
      })).filter((l: any) => l.text && l.href);
    });

    if (links.length === 0) {
      return null;
    }

    // Ask AI to identify login link
    const prompt = `You are analyzing a website to find the login page.

Base URL: ${baseUrl}

Available links:
${links.slice(0, 20).map((l: any, i: number) => `${i + 1}. "${l.text}" → ${l.href}`).join('\n')}

Which link is most likely the login page? Return ONLY the href value, nothing else.
If none look like login, return "null".

Response:`;

    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are a web navigation expert. Return only the exact href value or "null".',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0,
      max_tokens: 100,
      model: 'gpt-3.5-turbo', // Cheaper model for simple task
    });

    const detectedPath = response.trim().replace(/['"]/g, '');

    if (detectedPath === 'null' || !detectedPath) {
      logger.info('AI could not detect login page');
      return null;
    }

    // Build full URL
    const loginUrl = detectedPath.startsWith('http')
      ? detectedPath
      : `${baseUrl}${detectedPath.startsWith('/') ? '' : '/'}${detectedPath}`;

    logger.info('Login page detected by AI', { loginUrl });
    return loginUrl;
  } catch (error) {
    logger.error('Login page detection failed', { error });
    return null;
  }
}

/**
 * Validate selector using AI
 * Checks if selector is optimal and suggests improvements
 * Uses GPT-3.5-turbo
 */
export async function validateSelector(
  selector: string,
  elementPurpose: string,
  domContext?: string
): Promise<{
  isValid: boolean;
  confidence: number;
  suggestion?: string;
  reasoning?: string;
}> {
  try {
    logger.info('Validating selector with AI', { selector, elementPurpose });

    const prompt = `You are a Playwright selector expert.

Task: Validate this CSS selector for reliability and suggest improvements if needed.

Selector: "${selector}"
Element purpose: "${elementPurpose}"
${domContext ? `\nDOM context:\n${domContext.substring(0, 500)}` : ''}

Evaluate:
1. Is this selector reliable? (id/data-testid > name > class > text > nth-child)
2. Will it break if layout changes?
3. Can you suggest a better selector?

Return JSON:
{
  "isValid": true/false,
  "confidence": 0-1 (how confident this selector will work),
  "suggestion": "better selector if you have one, or null",
  "reasoning": "brief explanation"
}`;

    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are a Playwright expert. Return only valid JSON.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0.2,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      model: 'gpt-3.5-turbo', // Cheaper for simple validation
    });

    const result = JSON.parse(response);

    logger.info('Selector validated', {
      selector,
      isValid: result.isValid,
      confidence: result.confidence,
    });

    return {
      isValid: result.isValid ?? true,
      confidence: result.confidence ?? 0.8,
      suggestion: result.suggestion || undefined,
      reasoning: result.reasoning || undefined,
    };
  } catch (error) {
    logger.error('Selector validation failed', { error });

    // Fallback: assume valid
    return {
      isValid: true,
      confidence: 0.7,
    };
  }
}

/**
 * Parse natural language answers to structured format
 * Uses GPT-3.5-turbo for cost efficiency
 */
export async function parseNaturalAnswers(
  userMessage: string,
  questions: Array<{ id: string; question: string; type: string }>
): Promise<Record<string, any>> {
  try {
    logger.info('Parsing natural language answers with AI', {
      message: userMessage.substring(0, 50),
      questionCount: questions.length,
    });

    const prompt = `Parse user's natural language response into structured answers.

Questions asked:
${questions.map(q => `- ${q.id} (${q.type}): ${q.question}`).join('\n')}

User's response:
"${userMessage}"

Extract answers and return JSON in this format:
{
  "url": "extracted URL or null",
  "scope": "extracted scope/description or null",
  "needs_auth": true/false/null,
  "credentials": { "email": "...", "password": "..." } or null
}

Examples:

User: "URL: https://app.com/login, тестировать форму логина"
Response: { "url": "https://app.com/login", "scope": "форму логина", "needs_auth": null }

User: "https://shop.com регистрация, credentials test@test.com / pass123"
Response: {
  "url": "https://shop.com",
  "scope": "регистрация",
  "credentials": { "email": "test@test.com", "password": "pass123" }
}

User response: "${userMessage}"
Extracted answers (JSON only):`;

    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are a data extraction expert. Return only valid JSON with extracted values or null.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      model: 'gpt-3.5-turbo', // Cheap and fast for simple parsing
    });

    const parsed = JSON.parse(response);

    logger.info('Natural answers parsed', {
      extractedFields: Object.keys(parsed).filter(k => parsed[k] !== null),
    });

    // Clean up nulls
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && value !== 'null') {
        cleaned[key] = value;
      }
    }

    return cleaned;
  } catch (error) {
    logger.error('Natural answer parsing failed', { error });

    // Fallback: try to extract URL at least
    const urlMatch = userMessage.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      return { url: urlMatch[1] };
    }

    return {};
  }
}

/**
 * Smart navigation - AI helps find target page
 * Uses GPT-3.5-turbo
 */
export async function smartNavigate(
  page: Page,
  targetDescription: string,
  currentUrl: string
): Promise<{ success: boolean; finalUrl?: string }> {
  try {
    logger.info('Smart navigation with AI', { targetDescription, currentUrl });

    // Get available navigation options
    const navOptions = await page.evaluate(() => {
      // @ts-expect-error - browser context
      const links = Array.from(document.querySelectorAll('a[href], button')).map((el: any) => ({
        text: el.textContent?.trim(),
        href: el.getAttribute('href') || null,
        tag: el.tagName.toLowerCase(),
      })).filter((item: any) => item.text && item.text.length < 50);

      return links.slice(0, 30);
    });

    if (navOptions.length === 0) {
      return { success: false };
    }

    // Ask AI which link to click
    const prompt = `Current page: ${currentUrl}
User wants to navigate to: "${targetDescription}"

Available navigation options:
${navOptions.map((opt: any, i: number) => `${i + 1}. ${opt.tag} "${opt.text}"${opt.href ? ` → ${opt.href}` : ''}`).join('\n')}

Which option should we click? Return ONLY the number (1-${navOptions.length}) or "none".`;

    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are a navigation expert. Return only a number or "none".',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0,
      max_tokens: 10,
      model: 'gpt-3.5-turbo',
    });

    const choice = response.trim();
    const index = parseInt(choice) - 1;

    if (isNaN(index) || index < 0 || index >= navOptions.length) {
      return { success: false };
    }

    const selected = navOptions[index];

    if (selected.href) {
      await page.goto(selected.href);
    } else {
      await page.click(`:text("${selected.text}")`);
    }

    const finalUrl = page.url();

    logger.info('Smart navigation succeeded', { finalUrl });
    return { success: true, finalUrl };
  } catch (error) {
    logger.error('Smart navigation failed', { error });
    return { success: false };
  }
}
