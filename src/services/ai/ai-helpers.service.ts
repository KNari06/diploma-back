import { buildApprovalDetectionPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';

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
  // Validate input
  if (!userMessage || typeof userMessage !== 'string') {
    logger.warn('[APPROVAL_DETECT] Invalid input message', { userMessage });
    return { approved: null, confidence: 0.0, reasoning: 'Invalid input' };
  }

  const trimmedMessage = userMessage.trim();
  if (trimmedMessage.length === 0) {
    logger.warn('[APPROVAL_DETECT] Empty message');
    return { approved: null, confidence: 0.0, reasoning: 'Empty message' };
  }

  try {
    logger.info('🔍 [APPROVAL_DETECT] Starting detection', {
      message: trimmedMessage,
      length: trimmedMessage.length,
    });

    // Use centralized prompt
    const prompt = buildApprovalDetectionPrompt(trimmedMessage);

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
      model: 'gpt-4o-mini', // Better context understanding than gpt-3.5-turbo, cheaper too!
      temperature: 0.2, // Low temp for consistent results
      max_tokens: 100,
    });

    logger.info('🔍 [APPROVAL_DETECT] AI response received', {
      rawContent: response.content?.substring(0, 100),
    });

    // Safe JSON parsing
    let parsed: any;
    try {
      parsed = JSON.parse(response.content);
    } catch (parseError) {
      logger.error('[APPROVAL_DETECT] Failed to parse AI response', {
        response: response.content?.substring(0, 200),
        parseError,
      });
      throw new Error('Invalid JSON response from AI');
    }

    // Validate parsed response structure
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('AI response is not a valid object');
    }

    // Log based on actual result
    const logPrefix = parsed.approved === true ? '✅ [APPROVAL_DETECT] Approved'
                    : parsed.approved === false ? '❌ [APPROVAL_DETECT] Rejected'
                    : '⚠️ [APPROVAL_DETECT] Unclear/Not approval';

    logger.info(logPrefix, {
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
    logger.error('❌ [APPROVAL_DETECT] AI detection failed, using fallback', { error });

    // Fallback: simple keyword matching
    const message = trimmedMessage.toLowerCase();

    const approvalKeywords = ['да', 'yes', 'ok', 'ок', 'го', 'давай', 'запускай', 'погнали', 'валим', 'sure', 'run', 'execute', 'start', 'согласен', 'одобряю', 'approve', 'confirm', 'good', 'fine', 'хорошо', 'делай', 'начинай', 'тестируй', '+', '✅', '👍'];
    const rejectionKeywords = ['нет', 'no', 'не надо', "don't", 'stop', 'cancel', 'отмена', 'потом', 'later', 'not now', 'maybe', 'подожди', 'отклоняю', 'reject', 'пас', 'skip', 'нет спасибо', '-', '❌', '👎'];

    // Check approval
    if (approvalKeywords.some(k => message.includes(k))) {
      logger.info('✅ [APPROVAL_DETECT] Keyword match found (approval)', {
        message,
        matchedKeyword: approvalKeywords.find(k => message.includes(k)),
      });
      return { approved: true, confidence: 0.8, reasoning: 'Keyword matching (fallback)' };
    }

    // Check rejection
    if (rejectionKeywords.some(k => message.includes(k))) {
      logger.info('❌ [APPROVAL_DETECT] Keyword match found (rejection)', {
        message,
        matchedKeyword: rejectionKeywords.find(k => message.includes(k)),
      });
      return { approved: false, confidence: 0.8, reasoning: 'Keyword matching (fallback)' };
    }

    // Unclear
    logger.warn('⚠️ [APPROVAL_DETECT] No clear intent detected', { message });
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
  // Validate inputs
  if (!baseUrl || !page) {
    logger.error('[LOGIN_DETECT] Invalid parameters', { hasBaseUrl: !!baseUrl, hasPage: !!page });
    return null;
  }

  try {
    logger.info('[LOGIN_DETECT] Starting login page detection', { baseUrl });

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
      model: 'gpt-4o-mini', // Better AI, cheaper than gpt-3.5-turbo
    });

    const detectedPath = response.content.trim().replace(/['"]/g, '');

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
  // Validate inputs
  if (!selector || !elementPurpose) {
    logger.warn('[SELECTOR_VALIDATE] Missing required parameters', { selector, elementPurpose });
    return { isValid: false, confidence: 0.0, reasoning: 'Missing required parameters' };
  }

  try {
    logger.info('[SELECTOR_VALIDATE] Starting validation', { selector, elementPurpose });

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
      model: 'gpt-4o-mini', // Better AI, cheaper than gpt-3.5-turbo
    });

    const result = JSON.parse(response.content);

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
      model: 'gpt-4o-mini', // Better AI, cheaper than gpt-3.5-turbo
    });

    const parsed = JSON.parse(response.content);

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
      model: 'gpt-4o-mini',
    });

    const choice = response.content.trim();
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// URL EXTRACTION WITH GPT (GLOBAL UTILITY)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Cache for URL extraction results
 */
interface UrlExtractionCache {
  result: {
    url: string | null;
    method: string | null;
    confidence: number;
  };
  timestamp: number;
}

const urlExtractionCache = new Map<string, UrlExtractionCache>();
const URL_EXTRACTION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Extract URL and HTTP method from chat messages using GPT-3.5-turbo
 * This is a GLOBAL utility that can be used anywhere in the codebase
 *
 * @param messages - Array of chat messages (only user messages recommended)
 * @param currentMessage - Current user message (for context)
 * @returns Extracted URL, method, and confidence score
 */
export async function extractUrlWithGPT(
  messages: Array<{ role: string; content: string }>,
  currentMessage?: string
): Promise<{
  url: string | null;
  method: string | null;
  confidence: number;
  reasoning?: string;
}> {
  try {
    // Build cache key from messages content
    const cacheKey = messages.map(m => m.content).join('|') + (currentMessage || '');
    const cached = urlExtractionCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < URL_EXTRACTION_CACHE_TTL) {
      logger.info('🎯 [URL_EXTRACT] Using cached result', {
        url: cached.result.url,
        method: cached.result.method,
      });
      return cached.result;
    }

    logger.info('🔍 [URL_EXTRACT] Starting URL extraction with GPT', {
      messagesCount: messages.length,
      hasCurrentMessage: !!currentMessage,
    });

    // Build context from messages
    const messagesContext = messages
      .map((msg, idx) => `[${idx + 1}] ${msg.role}: "${msg.content}"`)
      .join('\n');

    const prompt = `Extract API URL and HTTP method from these chat messages.

CHAT HISTORY:
${messagesContext}

${currentMessage ? `CURRENT MESSAGE: "${currentMessage}"` : ''}

RULES:
1. Extract the MOST RECENT API URL mentioned by user
2. If user corrected/changed URL → use the LATEST one
3. Extract HTTP method (GET, POST, PUT, DELETE, PATCH) if mentioned
4. Clean URL: remove punctuation (commas, periods, brackets)
5. Ignore URLs from AI responses - ONLY user messages
6. If multiple URLs → prioritize the one user wants to test NOW

EXAMPLES:

Example 1:
[1] user: "test GET https://api.example.com/users"
[2] ai: "Creating plan..."
[3] user: "yes"
→ { "url": "https://api.example.com/users", "method": "GET", "confidence": 0.95 }

Example 2:
[1] user: "Check https://api.com/old"
[2] user: "wait, test https://api.com/new instead"
→ { "url": "https://api.com/new", "method": null, "confidence": 0.9 }

Example 3:
[1] user: "test this endpoint: https://api.example.com/users,"
→ { "url": "https://api.example.com/users", "method": null, "confidence": 0.85 }

Example 4:
[1] user: "what can you do?"
[2] user: "tell me more"
→ { "url": null, "method": null, "confidence": 0.0 }

RETURN ONLY VALID JSON:
{
  "url": string | null,
  "method": "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | null,
  "confidence": 0.0-1.0,
  "reasoning": "why this URL/method was selected"
}`;

    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are a URL extraction expert. Extract API URLs and HTTP methods from chat messages. Return ONLY valid JSON.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      model: 'gpt-4o-mini',
      temperature: 0.1, // Very low for consistent extraction
      max_tokens: 200,
    });

    // Parse response
    let parsed: any;
    try {
      parsed = JSON.parse(response.content.trim());
    } catch (parseError) {
      logger.error('[URL_EXTRACT] Failed to parse GPT response', {
        response: response.content.substring(0, 200),
      });
      return { url: null, method: null, confidence: 0.0 };
    }

    const result = {
      url: parsed.url || null,
      method: parsed.method || null,
      confidence: parsed.confidence || 0.0,
      reasoning: parsed.reasoning,
    };

    // Cache the result
    urlExtractionCache.set(cacheKey, {
      result,
      timestamp: Date.now(),
    });

    logger.info('✅ [URL_EXTRACT] Extraction complete', {
      url: result.url,
      method: result.method,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });

    return result;

  } catch (error) {
    logger.error('[URL_EXTRACT] URL extraction failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { url: null, method: null, confidence: 0.0 };
  }
}
