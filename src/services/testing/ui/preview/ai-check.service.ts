/**
 * AI Check Service
 * Evaluates natural language assertions using LLM with HTML, accessibility tree, and screenshot context
 * Inspired by Momentic's AI check feature
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { redactWithValues } from '@/utils/interpolation/redact-secrets';
import { PreviewAccessibilityNode } from '@/websocket/types/types';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input for AI check evaluation
 */
export interface AiCheckInput {
  /** Natural language assertion to evaluate (required) */
  assertionText: string;
  /** Current page URL */
  url: string;
  /** HTML content (optional, max 100KB) */
  html?: string;
  /** Accessibility tree (optional) */
  a11yTree?: PreviewAccessibilityNode[];
  /** Screenshot base64 (JPEG, optional) */
  screenshotBase64?: string;
  /**
   * Resolved `secrets.*` values active for this run (from
   * `executor.getRedactValues()`). The assertion text and the page HTML are
   * sent to a third-party LLM, and an authored assertion can legitimately
   * quote page text containing a credential (e.g. "Welcome back, <email>") —
   * so every string leaving this service is masked against these first
   * (CLAUDE.md invariant #10).
   *
   * NOTE: this cannot mask the SCREENSHOT, which may still render the value
   * visually. Prefer not authoring credential-bearing assertions at all.
   */
  secretValues?: readonly string[];
}

/**
 * Result from AI check evaluation
 */
export interface AiCheckResult {
  /** Whether the assertion passes */
  pass: boolean;
  /** Short explanation (for CI/report) */
  explanation: string;
  /** Confidence score (0-1, optional) */
  confidence?: number;
  /**
   * True when the check could NOT produce a trustworthy verdict (input
   * validation / LLM call / parse error) — distinct from a confident `pass:false`
   * (the assertion was genuinely not met). Observability gates `ai_check.errored`
   * on this so a legitimately-failed assertion isn't logged as a system failure.
   */
  evaluationError?: boolean;
  /** Which artifacts were used for evaluation */
  artifactsUsed: {
    html: boolean;
    a11y: boolean;
    screenshot: boolean;
  };
  /** Optional: data-agent-ref values that support the explanation (for UI highlight) */
  highlightRefs?: string[];
}

/**
 * Structured JSON response from LLM
 */
interface AiCheckLLMResponse {
  pass: boolean;
  explanation: string;
  confidence?: number;
  reasoning?: string;
  /** Optional: data-agent-ref values that support the explanation */
  highlightRefs?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Max HTML content length (100KB) */
const MAX_HTML_LENGTH = 100 * 1024;

/** Max accessibility tree depth */
const MAX_A11Y_DEPTH = 10;

/** Max accessibility tree nodes */
const MAX_A11Y_NODES = 500;

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build system prompt for AI check evaluation (Momentic-inspired)
 * Enforces: no vacuous truth, strict counts, visual criteria from screenshot
 * V2: Optionally returns highlightRefs for UI highlighting
 */
function buildSystemPrompt(): string {
  return `You are an expert QA engineer evaluating natural language assertions about web pages.

Your job is to determine if a user's assertion is TRUE or FALSE based on the provided context (HTML, accessibility tree, and/or screenshot).

# CRITICAL RULES (Momentic-style enforcement):

1. **No Vacuous Truth**: If an assertion mentions a specific element (e.g., "Submit button is not blue"), the element MUST exist. If it doesn't exist, the assertion FAILS.
   - Example: "Submit button is not blue" with no submit button present → FAIL (not pass by absence)

2. **Strict Counts**: When an assertion specifies a count (e.g., "page shows 3 results"), the count must be EXACT. Off-by-one or approximate counts are FAIL.
   - Example: "page shows 3 results" with 4 results present → FAIL

3. **Visual Criteria from Screenshot**: Any assertion about color, style, position, or visual appearance MUST be evaluated using the screenshot (if provided). HTML/a11y alone are insufficient for visual checks.
   - Example: "Buy button is blue" → evaluate from screenshot, not HTML

4. **Be Precise**: If the assertion is ambiguous or context is insufficient, set pass:false and explain why.

5. **Short Explanations**: Keep explanations concise (1-2 sentences) for CI/report readability.

# OUTPUT FORMAT:
Return a JSON object with these fields:
- pass: boolean (true if assertion holds, false otherwise)
- explanation: string (short, 1-2 sentences)
- confidence: number (0-1, optional, your confidence in the evaluation)
- reasoning: string (optional, detailed reasoning for debugging)
- highlightRefs: array of strings (optional, best-effort)
  - If HTML contains data-agent-ref attributes on elements relevant to the assertion, include them here
  - Example: For "Submit button is blue", if you find <button data-agent-ref="btn_submit">, return ["btn_submit"]
  - If you cannot confidently identify refs or HTML lacks data-agent-ref, return [] or omit
  - Limit to 5 refs max (most relevant)

# EXAMPLES:

Assertion: "There is a black nav bar with five links"
Context: HTML shows <nav data-agent-ref="nav_main"> with 5 <a> tags, screenshot shows black background
→ { "pass": true, "explanation": "Nav bar exists with 5 links and black background.", "confidence": 0.95, "highlightRefs": ["nav_main"] }

Assertion: "Submit button is not blue"
Context: No submit button found in HTML/a11y
→ { "pass": false, "explanation": "Submit button does not exist, so assertion is vacuously false.", "confidence": 0.9, "highlightRefs": [] }

Assertion: "Page shows 3 results"
Context: HTML shows 4 result items with refs: result_1, result_2, result_3, result_4
→ { "pass": false, "explanation": "Page shows 4 results, not 3.", "confidence": 1.0, "highlightRefs": ["result_1", "result_2", "result_3", "result_4"] }

Assertion: "Logo is in the top-left corner"
Context: Screenshot shows logo in top-right corner, HTML has <img data-agent-ref="logo_img">
→ { "pass": false, "explanation": "Logo is in top-right corner, not top-left.", "confidence": 0.85, "highlightRefs": ["logo_img"] }

Now evaluate the user's assertion based on the provided context.`;
}

/**
 * Build user prompt with assertion and context
 */
function buildUserPrompt(input: AiCheckInput, truncatedFlags: { html: boolean; a11y: boolean }): string {
  let prompt = `# ASSERTION TO EVALUATE:\n"${input.assertionText}"\n\n`;
  prompt += `# CURRENT PAGE:\nURL: ${input.url}\n\n`;

  if (input.html) {
    prompt += `# HTML CONTENT:\n${input.html}\n`;
    if (truncatedFlags.html) {
      prompt += `(Note: HTML was truncated to fit within limits)\n`;
    }
    prompt += `\n`;
  }

  if (input.a11yTree && input.a11yTree.length > 0) {
    const a11yText = serializeA11yTree(input.a11yTree);
    prompt += `# ACCESSIBILITY TREE:\n${a11yText}\n`;
    if (truncatedFlags.a11y) {
      prompt += `(Note: Accessibility tree was truncated to fit within limits)\n`;
    }
    prompt += `\n`;
  }

  prompt += `Now evaluate the assertion and return JSON.`;

  return prompt;
}

/**
 * Serialize accessibility tree to text (for LLM context)
 */
function serializeA11yTree(nodes: PreviewAccessibilityNode[], depth: number = 0, maxDepth: number = MAX_A11Y_DEPTH, nodeCount: { count: number } = { count: 0 }): string {
  if (depth > maxDepth || nodeCount.count > MAX_A11Y_NODES) {
    return '';
  }

  let result = '';
  for (const node of nodes) {
    if (nodeCount.count > MAX_A11Y_NODES) break;
    nodeCount.count++;

    const indent = '  '.repeat(depth);
    let line = `${indent}- ${node.role}`;
    if (node.name) line += `: ${node.name}`;
    if (node.value) line += ` (value: ${node.value})`;
    if (node.description) line += ` [${node.description}]`;
    result += line + '\n';

    if (node.children && node.children.length > 0) {
      result += serializeA11yTree(node.children, depth + 1, maxDepth, nodeCount);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EVALUATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate an AI check assertion
 * Uses OpenAI GPT-4o (vision) when screenshot is provided, otherwise GPT-4o-mini
 */
export async function evaluateAiCheck(input: AiCheckInput): Promise<AiCheckResult> {
  const startTime = Date.now();

  // No secrets in play → identity, zero cost (redactWithValues short-circuits).
  const secretValues = input.secretValues ?? [];
  const maskSecrets = (value: string): string =>
    (secretValues.length > 0 ? redactWithValues(value, secretValues) : value);

  logger.info('[AI_CHECK] Starting evaluation', {
    assertion: maskSecrets(input.assertionText),
    url: input.url,
    hasHtml: !!input.html,
    hasA11y: !!input.a11yTree,
    hasScreenshot: !!input.screenshotBase64,
  });

  try {
    // Validate input
    if (!input.assertionText || input.assertionText.trim().length === 0) {
      throw new Error('assertionText is required and cannot be empty');
    }

    // Determine which artifacts are being used
    const artifactsUsed = {
      html: !!input.html,
      a11y: !!input.a11yTree && input.a11yTree.length > 0,
      screenshot: !!input.screenshotBase64,
    };

    // Truncate HTML if too large
    const truncatedFlags = { html: false, a11y: false };
    let html = input.html;
    if (html && html.length > MAX_HTML_LENGTH) {
      html = html.substring(0, MAX_HTML_LENGTH);
      truncatedFlags.html = true;
      logger.warn('[AI_CHECK] HTML truncated', {
        originalLength: input.html?.length ?? 0,
        truncatedLength: html.length,
      });
    }

    // Build messages
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt() },
    ];

    // Mask resolved secrets in the ONE assembled string, so the assertion, the
    // HTML and the a11y tree are all masked identically — the model still sees
    // a consistent comparison ("shows ***" vs "shows ***"), it just never sees
    // the credential. Cannot mask the screenshot (see AiCheckInput.secretValues).
    const userPrompt = maskSecrets(buildUserPrompt({ ...input, html }, truncatedFlags));

    // Build user message with text and optional screenshot
    if (input.screenshotBase64) {
      // Multimodal: text + image
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: userPrompt,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${input.screenshotBase64}`,
              detail: 'high', // High detail for better visual analysis
            },
          },
        ],
      });
    } else {
      // Text-only
      messages.push({
        role: 'user',
        content: userPrompt,
      });
    }

    // Choose model based on whether we have a screenshot
    const model = input.screenshotBase64 ? AI_TASK_MODELS.aiCheckVision : AI_TASK_MODELS.aiCheck;

    // Call OpenAI
    logger.debug('[AI_CHECK] Calling OpenAI', { model, messageCount: messages.length });
    const response = await getChatCompletionWithMessages(messages, {
      model,
      temperature: 0.2, // Lower temperature for more consistent evaluation
      max_tokens: 500, // Keep explanations concise
      response_format: { type: 'json_object' },
    });

    // Parse response
    const parsed: AiCheckLLMResponse = JSON.parse(response.content);

    logger.info('[AI_CHECK] Evaluation completed', {
      assertion: maskSecrets(input.assertionText),
      pass: parsed.pass,
      confidence: parsed.confidence,
      tokensUsed: response.usage.totalTokens,
      durationMs: Date.now() - startTime,
    });

    return {
      pass: parsed.pass,
      // The model's free text is an UNTRUSTED sink for secrets, not a safe one:
      // the prompt is masked, but a screenshot cannot be, so a vision model can
      // read a rendered credential off the page and quote it back here — from
      // where it flows into the thrown error, the step's failure explanation and
      // the persisted run report. Mask at this single choke point so every
      // consumer inherits it (invariant #10).
      explanation: maskSecrets(parsed.explanation || 'No explanation provided'),
      confidence: parsed.confidence,
      evaluationError: false,
      artifactsUsed,
      highlightRefs: parsed.highlightRefs || [],
    };
  } catch (error) {
    logger.error('[AI_CHECK] Evaluation failed', {
      assertion: maskSecrets(input.assertionText),
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    });

    // Return failure result on error — the check could not be evaluated.
    return {
      pass: false,
      explanation: `AI check evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      confidence: 0,
      evaluationError: true,
      artifactsUsed: {
        html: !!input.html,
        a11y: !!input.a11yTree,
        screenshot: !!input.screenshotBase64,
      },
      highlightRefs: [],
    };
  }
}
