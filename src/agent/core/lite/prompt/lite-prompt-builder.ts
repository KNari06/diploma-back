/**
 * LitePromptBuilder
 * Builds AI prompts with JSON-only responses (no code)
 * SECURITY: AI returns structured commands, not arbitrary code
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { AIDecision, GoalGuidance, StuckCheck } from '../lite-types';

/**
 * Options for askJson calls
 */
export interface AskJsonOptions {
  /** Model to use: 'gpt-4o-mini' (cheap/fast) or 'gpt-4o' (accurate/expensive) */
  model?: 'gpt-4o-mini' | 'gpt-4o';
  /** Temperature (0-1, lower = more deterministic) */
  temperature?: number;
  /** Max tokens for response */
  maxTokens?: number;
  /** Timeout in ms (default: 15000) */
  timeoutMs?: number;
}

export class LitePromptBuilder {
  /**
   * Build prompt for AI decision
   * Includes stuck warning when agent is stuck
   * NEW: Includes progress signals from GoalDetector
   * NEW: Includes AI guidance/nextSubgoal when provided (from AI fallback)
   * ✅ FIX: Truncates snapshot if too large to prevent token overflow
   * ✅ NEW: Includes contextualHints from GoalDetector for smarter navigation
   *
   * @param params - Prompt parameters
   * @returns Complete prompt string
   */
  static build(params: {
    goal: string;
    snapshot: string;
    history: string;
    stuckCheck: StuckCheck;
    lastOutcome?: string;
    progressSignals?: {
      currentUrl: string;
      progressScore: number;
      matchedSignals: (string | undefined)[];
    };
    /** AI guidance from stuck recovery (optional) */
    guidance?: GoalGuidance;
    /** Current iteration (for guidance lifetime check) */
    currentIteration?: number;
    /** ✅ NEW: Contextual hints from GoalDetector */
    contextualHints?: string[];
  }): string {
    // ✅ FIX: Truncate snapshot if too large (prevent token overflow)
    const MAX_SNAPSHOT_LENGTH = 100_000; // 100k chars (~25k tokens)
    const snapshot = LitePromptBuilder.truncateSnapshot(params.snapshot, MAX_SNAPSHOT_LENGTH);

    // Build stuck warning if agent is stuck
    const stuckWarning = params.stuckCheck.stuck
      ? `
⚠️ WARNING: YOU ARE STUCK!
Reason: ${params.stuckCheck.reason}
Suggestion: ${params.stuckCheck.suggestion}
DO NOT repeat the same action. Try something DIFFERENT.
`
      : '';

    // Build last outcome section
    const lastOutcomeSection = params.lastOutcome
      ? `\nLAST ACTION RESULT:\n${params.lastOutcome}\n`
      : '';

    // Build progress signals section
    const progressSection = params.progressSignals
      ? `
PROGRESS SIGNALS:
- Current URL: ${params.progressSignals.currentUrl}
- Progress: ${Math.round(params.progressSignals.progressScore * 100)}%
- Detected cues: ${params.progressSignals.matchedSignals.filter(Boolean).join(', ') || 'None yet'}
${params.progressSignals.progressScore >= 0.5 ? '→ Getting close to goal! Look for final action to complete it.' : '→ Navigate toward target state via intermediate steps.'}
`
      : '';

    // Build AI guidance section (from stuck recovery)
    // Only include if guidance is fresh (within 2 iterations of when it was added)
    const guidanceSection = LitePromptBuilder.buildGuidanceSection(params.guidance, params.currentIteration);

    // ✅ NEW: Build registration hint if goal is register/login and form not found
    const registrationHint = LitePromptBuilder.buildRegistrationHint(params.goal, snapshot);

    // ✅ NEW: Build contextual hints section from GoalDetector
    const contextualHintsSection = params.contextualHints && params.contextualHints.length > 0
      ? `\nCONTEXTUAL HINTS:\n${params.contextualHints.join('\n')}\n`
      : '';

    // Build complete prompt with JSON-only response format
    return `You are a browser automation agent testing a web application.
Your job is to REACH THE TARGET STATE through intermediate steps. Navigation is expected.

GOAL: ${params.goal}

CURRENT PAGE:
${snapshot}
${stuckWarning}${lastOutcomeSection}${progressSection}${guidanceSection}${registrationHint}${contextualHintsSection}
HISTORY:
${params.history}

AVAILABLE ACTIONS (choose ONE):
- click: { "action": "click", "ref": "e5" }
- fill: { "action": "fill", "ref": "e2", "value": "text to type" }
- press: { "action": "press", "key": "Enter" }
- goto: { "action": "goto", "url": "https://..." }
- scroll: { "action": "scroll", "direction": "down", "amount": 600 }
- scroll_to: { "action": "scroll", "targetRef": "e10" }
- select: { "action": "select", "ref": "e3", "value": "option" }
- hover: { "action": "hover", "ref": "e4" }
- wait: { "action": "wait" }

IMPORTANT RULES:
1. Use data-agent-ref values (e.g., "e5") to target elements
2. Look at parent context to understand element location
3. If an action fails repeatedly, try a different approach
4. Check for error messages or validation warnings
5. If you see a modal/popup (ACTIVE_MODAL), interact with it first - prioritize elements inside
6. If the snapshot is empty or loading (< 3 elements), or if the page is clearly in a loading state (e.g., contains "Loading...", "Please wait", spinner elements), use the "wait" action
7. Your job is to REACH the target state - intermediate navigation steps are expected!
8. If you detect "HTTP 429" / "Too Many Requests" / rate limiting, use "wait" (back off) before trying again.
9. For multi-step forms: "Continue/Продолжить" button = step forward (keep going), "Register/Finish/Зарегистрироваться" = final step
10. For Registration goal: If you see only "Login/Вход" form, look for "Register/Зарегистрироваться" toggle inside it - don't give up!
11. ✅ EXPLORATION RULE: If your target form (e.g., registration, checkout) is not visible, look for entry points like "Login/Вход", "Profile/Профиль", "Account/Кабинет", or a user icon. Clicking these is a VALID and often NECESSARY step to reach your goal.

RESPONSE FORMAT (JSON ONLY):
{
  "thought": "Brief reasoning (1 sentence)",
  "command": { "action": "click", "ref": "e5" }
}

Special responses:
- If goal is achieved: { "done": true, "thought": "Goal completed because..." }
- If blocked (login required, captcha, verification code needed):
  Option 1: { "blocked": "Reason why blocked", "thought": "..." }
  Option 2: { "blockedInfo": { "reason": "CAPTCHA detected", "canUserHelp": true }, "thought": "..." }

CRITICAL: Return ONLY a valid JSON object. NO markdown code blocks (\\\`\\\`\\\`json or \\\`\\\`\\\`), NO preamble, NO extra text.
Analyze state changes after each action. Success = state changed.`;
  }

  /**
   * Ask AI for decision
   * Uses GPT-4o-mini with JSON response format
   * ✅ FIX: Cleans markdown code blocks from response (saves from 5% random parse errors)
   *
   * @param prompt - Complete prompt string
   * @returns AI decision
   */
  static async askAI(prompt: string): Promise<AIDecision> {
    try {
      // ✅ MY IDEA: Estimate total tokens and warn if too large
      const estimatedTokens = Math.ceil(prompt.length / 4); // Rough estimate: 1 token ~= 4 chars
      const MODEL_CONTEXT_WINDOW = 128_000; // gpt-4o-mini context window
      const MAX_SAFE_PROMPT_TOKENS = 120_000; // Leave 8k for response

      if (estimatedTokens > MAX_SAFE_PROMPT_TOKENS) {
        logger.warn('[LITE_PROMPT] Prompt may exceed safe token limit', {
          estimatedTokens,
          maxSafeTokens: MAX_SAFE_PROMPT_TOKENS,
          contextWindow: MODEL_CONTEXT_WINDOW,
          promptLength: prompt.length,
        });
      }

      logger.debug('[LITE_PROMPT] Sending prompt to AI', {
        promptLength: prompt.length,
        estimatedTokens,
      });

      const response = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: 'gpt-4o-mini',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          max_tokens: 500,
        }
      );

      const content = response.content;

      if (!content) {
        throw new Error('Empty response from AI');
      }

      // ✅ FIX: Clean markdown code blocks before parsing (handles models that ignore instructions)
      // This saves us from ~5% of random parse errors when AI wraps JSON in ```json blocks
      const cleanContent = content.replace(/```json\s*|```\s*/g, '').trim();

      // ✅ MY IDEA: Log raw AI response for debugging (only first 200 chars to avoid spam)
      logger.debug('[LITE_PROMPT] Raw AI response', {
        raw: cleanContent.slice(0, 200),
        length: cleanContent.length,
        wasCleaned: cleanContent !== content,
      });

      // Parse JSON response
      const parsed = JSON.parse(cleanContent);

      // Determine action type for logging
      const isBlocked = parsed.blocked || parsed.blockedInfo;
      const actionType = parsed.command?.action || (parsed.done ? 'done' : isBlocked ? 'blocked' : 'unknown');

      logger.debug('[LITE_PROMPT] Received AI decision', {
        thought: parsed.thought?.slice(0, 50),
        action: actionType,
        hasBlockedInfo: !!parsed.blockedInfo,
      });

      // Validate response structure
      if (!parsed.thought) {
        throw new Error('Missing thought in AI response');
      }

      if (parsed.done) {
        return {
          thought: parsed.thought,
          command: { action: 'wait' }, // Placeholder command
          done: true,
        };
      }

      // Handle blocked state - support both old (string) and new (object) formats
      // Priority: blockedInfo (new format) > blocked (legacy string format)
      if (parsed.blockedInfo) {
        return {
          thought: parsed.thought,
          command: { action: 'wait' }, // Placeholder command
          blockedInfo: {
            reason: parsed.blockedInfo.reason || 'Unknown reason',
            canUserHelp: parsed.blockedInfo.canUserHelp || false,
          },
        };
      }

      if (parsed.blocked) {
        return {
          thought: parsed.thought,
          command: { action: 'wait' }, // Placeholder command
          blocked: parsed.blocked,
        };
      }

      if (!parsed.command || !parsed.command.action) {
        throw new Error('Missing command in AI response');
      }

      return parsed as AIDecision;
    } catch (error) {
      logger.error('[LITE_PROMPT] Failed to get AI decision', {
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof SyntaxError ? 'JSON_PARSE_ERROR' : 'UNKNOWN',
        // ✅ MY IDEA: Add stack trace for debugging production issues
        stack: error instanceof Error ? error.stack?.slice(0, 200) : undefined,
      });

      // Return safe fallback decision
      return {
        thought: 'Error getting AI decision, waiting',
        command: { action: 'wait' },
        blocked: `AI error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Build simplified prompt for testing
   * Useful for debugging
   *
   * @param goal - Test goal
   * @param snapshot - Page snapshot
   * @returns Simplified prompt
   */
  static buildSimple(goal: string, snapshot: string): string {
    return `Goal: ${goal}

Page:
${snapshot}

What should the agent do next? Respond with JSON:
{ "thought": "...", "command": { "action": "...", ... } }`;
  }

  /**
   * Build guidance section for prompt
   * Only includes guidance if it's fresh (within 2 iterations)
   *
   * @param guidance - AI guidance from stuck recovery
   * @param currentIteration - Current iteration number
   * @returns Guidance section string or empty string
   */
  private static buildGuidanceSection(
    guidance?: GoalGuidance,
    currentIteration?: number
  ): string {
    if (!guidance) {
      return '';
    }

    // Check guidance lifetime (max 2 iterations)
    const GUIDANCE_MAX_LIFETIME = 2;
    if (currentIteration !== undefined) {
      const age = currentIteration - guidance.addedAtIteration;
      if (age > GUIDANCE_MAX_LIFETIME) {
        logger.debug('[LITE_PROMPT] Guidance expired', {
          addedAt: guidance.addedAtIteration,
          currentIteration,
          age,
          maxLifetime: GUIDANCE_MAX_LIFETIME,
        });
        return '';
      }
    }

    // Build compact guidance section
    let section = '\n🎯 AI GUIDANCE:\n';
    if (guidance.nextSubgoal) {
      section += `NEXT SUBGOAL: ${guidance.nextSubgoal}\n`;
    }
    if (guidance.guidance && guidance.guidance !== guidance.nextSubgoal) {
      section += `HINT: ${guidance.guidance}\n`;
    }
    section += 'Focus on this subgoal before continuing to the main goal.\n';

    return section;
  }

  /**
   * Check if guidance is still valid (within lifetime)
   *
   * @param guidance - AI guidance
   * @param currentIteration - Current iteration number
   * @returns Whether guidance is still valid
   */
  static isGuidanceValid(guidance: GoalGuidance, currentIteration: number): boolean {
    const GUIDANCE_MAX_LIFETIME = 2;
    const age = currentIteration - guidance.addedAtIteration;
    return age <= GUIDANCE_MAX_LIFETIME;
  }

  /**
   * Build registration hint if goal requires registration but form not found
   * Provides strategy for finding registration through entry points
   *
   * @param goal - Test goal
   * @param snapshot - Current page snapshot (formatted string)
   * @returns Registration hint string or empty string
   */
  private static buildRegistrationHint(goal: string, snapshot: string): string {
    const goalLower = goal.toLowerCase();

    // Check if goal is registration
    const isRegistrationGoal = /register|sign\s*up|create\s+account|registration|зарегистр|регистрац/i.test(goalLower);
    const isLoginGoal = /login|sign\s*in|log\s*in|вход|войти/i.test(goalLower);

    if (!isRegistrationGoal && !isLoginGoal) {
      return '';
    }

    // Check if registration/login form is already present
    const snapshotLower = snapshot.toLowerCase();
    const hasPasswordField = /type=password/i.test(snapshotLower);
    const hasEmailField = /type=email|email|почта/i.test(snapshotLower);
    const hasRegisterButton = /register|sign up|create account|зарегистр/i.test(snapshotLower);
    const hasLoginButton = /login|sign in|log in|вход|войти/i.test(snapshotLower);

    // If form is already present, no hint needed
    if (isRegistrationGoal && hasPasswordField && (hasEmailField || hasRegisterButton)) {
      return '';
    }
    if (isLoginGoal && hasPasswordField && (hasEmailField || hasLoginButton)) {
      return '';
    }

    // Form not found - provide navigation strategy
    if (isRegistrationGoal) {
      return `
🎯 REGISTRATION STRATEGY (form not found yet):
1. FIRST: Look for entry points: "Profile/Профиль", "Account/Кабинет", "Login/Вход", "Sign In/Войти" (user icon)
2. CLICK entry point to open auth modal/page
3. INSIDE auth modal: Look for "Register/Зарегистрироваться", "Sign Up", "Create Account/Создать аккаунт" toggle
4. If you see "Login/Вход" form, DON'T GIVE UP - registration is often a tab/link inside it
5. For multi-step: "By Email/По почте" is preferred over "By Phone"
6. If no entry point found after scrolling, try menu button (☰) or scroll to footer
`;
    }

    if (isLoginGoal) {
      return `
🎯 LOGIN STRATEGY (form not found yet):
1. FIRST: Look for "Login/Вход", "Sign In/Войти", "Account/Кабинет", "Profile/Профиль" (user icon)
2. CLICK to open login modal/page
3. If no direct link found, try menu button (☰) or scroll to footer
`;
    }

    return '';
  }

  /**
   * Truncate snapshot if too large to prevent token overflow
   * ✅ FIX: Prevents context window overflow when DOM tree is massive
   *
   * @param snapshot - Raw snapshot string
   * @param maxLength - Maximum allowed length (default: 100k chars)
   * @returns Truncated snapshot with warning if truncated
   */
  private static truncateSnapshot(snapshot: string, maxLength: number = 100_000): string {
    if (snapshot.length <= maxLength) {
      return snapshot;
    }

    logger.warn('[LITE_PROMPT] Snapshot too large, truncating', {
      originalLength: snapshot.length,
      maxLength,
      truncatedChars: snapshot.length - maxLength,
      estimatedTokensSaved: Math.round((snapshot.length - maxLength) / 4),
    });

    // Truncate and add warning message
    const truncated = snapshot.slice(0, maxLength);
    const warning = '\n\n[⚠️ SNAPSHOT TRUNCATED: Page is very large, showing first 100k chars. Focus on visible elements.]';

    return truncated + warning;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: Generic JSON prompt helper for Strategy/Auditor
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generic JSON prompt helper
   * Supports strategy prompts (gpt-4o-mini) and auditor prompts (gpt-4o)
   * Includes markdown cleanup and strict JSON response format
   *
   * @param prompt - Complete prompt string (must request JSON response)
   * @param options - Model selection and other options
   * @returns Parsed JSON response or null if failed
   */
  static async askJson<T>(
    prompt: string,
    options: AskJsonOptions = {}
  ): Promise<T | null> {
    const {
      model = 'gpt-4o-mini',
      temperature = 0.1,
      maxTokens = 600,
      timeoutMs = 15000,
    } = options;

    try {
      logger.debug('[LITE_PROMPT] askJson request', {
        model,
        promptLength: prompt.length,
        estimatedTokens: Math.ceil(prompt.length / 4),
      });

      // Create timeout promise
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      });

      // Create AI call promise
      const aiPromise = getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model,
          temperature,
          response_format: { type: 'json_object' },
          max_tokens: maxTokens,
        }
      );

      // Race between AI call and timeout
      const response = await Promise.race([aiPromise, timeoutPromise]);

      if (!response) {
        logger.warn('[LITE_PROMPT] askJson timed out', {
          timeoutMs,
          model,
        });
        return null;
      }

      const content = response.content;

      if (!content) {
        logger.warn('[LITE_PROMPT] askJson empty response');
        return null;
      }

      // Clean markdown code blocks before parsing (handles models that ignore instructions)
      const cleanContent = content.replace(/```json\s*|```\s*/g, '').trim();

      logger.debug('[LITE_PROMPT] askJson response', {
        model,
        rawLength: content.length,
        wasCleaned: cleanContent !== content,
        preview: cleanContent.slice(0, 150),
      });

      // Parse JSON response
      const parsed = JSON.parse(cleanContent) as T;

      return parsed;
    } catch (error) {
      logger.error('[LITE_PROMPT] askJson failed', {
        model,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof SyntaxError ? 'JSON_PARSE_ERROR' : 'UNKNOWN',
        stack: error instanceof Error ? error.stack?.slice(0, 200) : undefined,
      });
      return null;
    }
  }
}
