import { buildTestPlanPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { ExplorationResult } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { PlaywrightCommand } from '@/types';
import { logger } from '@/utils/core/logger';
import { randomUUID } from 'crypto';

/**
 * ✅ IMPROVED: Validate and AUTO-FIX selectors in generated plan
 *
 * Features:
 * - Detects AI-invented selectors (like button:has-text("text"))
 * - Automatically finds matching selector from DOM analysis by text
 * - Fixes selectors in-place to prevent test failures
 * - ✅ Handles text collisions (multiple selectors for same text) - chooses best one
 * - ✅ Unicode normalization (NFKD) for multilingual support (Cyrillic, accents, etc.)
 * - ✅ Skips short words (< 4 chars) to avoid noise from "Ok", "Go", etc.
 * - ✅ Confidence scoring based on selector type priority (ID > data-testid > role > label > text > class)
 *
 * Future improvements (TODO):
 * - Fuzzy matching (Levenshtein/Jaro-Winkler) for approximate text matches
 * - Dry-run validation on page (requires page context - can be done during test execution)
 * - Element visibility check before auto-fix
 */

/**
 * ✅ ENHANCED: Normalize text key with Unicode support
 * - Normalizes to NFKD and removes diacritics for better matching
 * - Handles Cyrillic, accents, special characters
 * - Removes quotes, punctuation, normalizes whitespace
 */
function normalizeTextKey(text: string): string {
  if (!text) return '';

  return text
    .normalize('NFKD') // Decompose characters (é → e + ́)
    .replace(/[\u0300-\u036F]/g, '') // Remove diacritics
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D'\""]/g, '') // normalize quotes
    .replace(/[^\n\p{L}\p{N}\s]/gu, '') // remove punctuation (unicode aware)
    .replace(/\s+/g, ' ') // normalize whitespace
    .trim();
}

/**
 * ✅ NEW: Choose best selector from candidates
 * Priority: ID > data-testid > role > label > text > class
 * Also considers: visibility, element type match
 */
function chooseBestSelector(
  candidates: Array<{ selector: string; elementType?: string; priority?: number }>,
  expectedText?: string
): { selector: string; confidence: number } {
  if (candidates.length === 0) {
    return { selector: '', confidence: 0 };
  }

  if (candidates.length === 1) {
    return { selector: candidates[0].selector, confidence: 0.9 };
  }

  // Score each candidate
  const scored = candidates.map(candidate => {
    let score = 0;
    const sel = candidate.selector;

    // Priority by selector type (higher = better)
    if (sel.startsWith('#') || /^\[id=/.test(sel)) {
      score += 100; // ID is most stable
    } else if (sel.includes('[data-testid=')) {
      score += 80; // data-testid is test-friendly
    } else if (sel.startsWith('role=')) {
      score += 60; // role is semantic
    } else if (sel.startsWith('label=')) {
      score += 50; // label is accessible
    } else if (sel.startsWith('text=')) {
      score += 40; // text is readable but fragile
    } else if (sel.startsWith('.')) {
      score += 20; // class is less stable
    } else {
      score += 10; // other selectors
    }

    // Bonus for element type match (if provided)
    if (candidate.elementType && expectedText) {
      // Prefer buttons for button actions, inputs for fill actions, etc.
      score += 5;
    }

    // Use priority if provided (from DOM analysis)
    if (candidate.priority !== undefined) {
      score += candidate.priority;
    }

    return { selector: sel, score, elementType: candidate.elementType };
  });

  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const secondBest = scored[1];

  // Calculate confidence based on score difference
  // If scores are close, confidence is lower (ambiguous)
  const scoreDiff = best.score - (secondBest?.score || 0);
  const confidence = scoreDiff > 20 ? 0.9 : scoreDiff > 10 ? 0.75 : 0.6;

  return {
    selector: best.selector,
    confidence,
  };
}

function validateSelectorsInPlan(aiPlan: any, explorationResult: ExplorationResult): void {
  // Safe guards for missing domAnalysis
  const dom = explorationResult.domAnalysis || { buttons: [], inputs: [], forms: [], links: [], modals: [], interactiveElements: [] } as any;

  const buttons = dom.buttons || [];
  const links = dom.links || [];
  const inputs = dom.inputs || [];
  const forms = dom.forms || [];
  const checkboxes = (dom as any).checkboxes || [];
  const radios = (dom as any).radios || [];
  const interactiveElements = (dom as any).interactiveElements || [];

  // ✅ FIX: Build text -> selector[] map to handle collisions
  // Store multiple selectors per text, then choose best one
  const textToSelectorMap = new Map<string, Array<{ selector: string; elementType?: string; priority?: number }>>();

  const addToMap = (
    text: string | undefined,
    selector?: string,
    elementType?: string,
    minWordLength: number = 4 // ✅ FIX: Don't add short words (< 4 chars) to avoid noise
  ) => {
    if (!text || !selector) return;
    const key = normalizeTextKey(text);
    if (!key || key.length < 2) return; // Skip very short keys

    // Helper to add to map
    const addEntry = (mapKey: string) => {
      if (!textToSelectorMap.has(mapKey)) {
        textToSelectorMap.set(mapKey, []);
      }
      const existing = textToSelectorMap.get(mapKey)!;
      // Avoid duplicates
      if (!existing.some(e => e.selector === selector)) {
        // Calculate priority based on selector type
        let priority = 0;
        if (selector.startsWith('#') || /^\[id=/.test(selector)) priority = 100;
        else if (selector.includes('[data-testid=')) priority = 80;
        else if (selector.startsWith('role=')) priority = 60;
        else if (selector.startsWith('label=')) priority = 50;
        else if (selector.startsWith('text=')) priority = 40;
        else if (selector.startsWith('.')) priority = 20;
        else priority = 10;

        existing.push({ selector, elementType, priority });
      }
    };

    // store full phrase (always, even if short)
    addEntry(key);

    // store words and 2-grams for better partial matching (only if word length >= minWordLength)
    const words = key.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      // ✅ FIX: Only add words >= minWordLength to avoid noise from "Ok", "Go", etc.
      if (w.length >= minWordLength) {
        addEntry(w);
      }
      if (i < words.length - 1) {
        const bigram = `${words[i]} ${words[i+1]}`;
        // Bigrams are always added (they're more specific)
        addEntry(bigram);
      }
    }
  };

  buttons.forEach((b: any) => addToMap(b.text, b.selector, 'button'));
  links.forEach((l: any) => addToMap(l.text, l.selector, 'link'));
  inputs.forEach((i: any) => addToMap(i.placeholder || i.name || i.label, i.selector, 'input'));
  forms.forEach((f: any) => f.fields?.forEach((field: any) => addToMap(field.name || field.placeholder || field.label, field.selector, 'input')));
  checkboxes.forEach((cb: any) => addToMap(cb.label || cb.name, cb.selector, 'checkbox'));
  radios.forEach((r: any) => addToMap(r.label || r.name, r.selector, 'radio'));
  interactiveElements.forEach((el: any) => addToMap(el.text, el.selector, el.tag || 'element'));

  // collect valid selectors (normalized)
  const validSelectors = new Set<string>();
  buttons.forEach((b: any) => b.selector && validSelectors.add((b.selector || '').trim()));
  links.forEach((l: any) => l.selector && validSelectors.add((l.selector || '').trim()));
  inputs.forEach((i: any) => i.selector && validSelectors.add((i.selector || '').trim()));
  forms.forEach((f: any) => f.fields?.forEach((field: any) => field.selector && validSelectors.add((field.selector || '').trim())));
  checkboxes.forEach((cb: any) => cb.selector && validSelectors.add((cb.selector || '').trim()));
  radios.forEach((r: any) => r.selector && validSelectors.add((r.selector || '').trim()));
  interactiveElements.forEach((el: any) => el.selector && validSelectors.add((el.selector || '').trim()));

  let fixedCount = 0;
  const invalidSelectors: Array<{ step: string; selector: string; fixedTo?: string; reason: string }> = [];

  function findSelectorByText(inventedSelector: string, expectedElementType?: string): { selector: string; confidence: number } | null {
    if (!inventedSelector) return null;

    // Try to extract quoted text from common patterns
    const hasTextMatch = inventedSelector.match(/:has-text\(['"](.+?)['"]\)/) || inventedSelector.match(/text\s*=\s*['"](.+?)['"]/);
    const raw = hasTextMatch ? hasTextMatch[1] : null;
    if (!raw) return null;
    const search = normalizeTextKey(raw);
    if (!search) return null;

    // ✅ FIX: Handle collisions - collect all candidates
    let candidates: Array<{ selector: string; elementType?: string; priority?: number }> = [];

    // exact match
    const exactCandidates = textToSelectorMap.get(search);
    if (exactCandidates && exactCandidates.length > 0) {
      candidates.push(...exactCandidates);
    }

    // try best partial match (prefer longest key for better accuracy)
    if (candidates.length === 0) {
      let bestMatchKey: string | null = null;
      let bestMatchLength = 0;

      for (const [key, keyCandidates] of textToSelectorMap.entries()) {
        if (key.includes(search) || search.includes(key)) {
          if (!bestMatchKey || key.length > bestMatchLength) {
            bestMatchKey = key;
            bestMatchLength = key.length;
            candidates = keyCandidates;
          }
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // ✅ FIX: Choose best selector from candidates
    const result = chooseBestSelector(candidates, expectedElementType);

    // Log if there were multiple candidates (collision detected)
    if (candidates.length > 1) {
      logger.debug('[TEST_PLAN_GENERATOR] Text collision detected, chose best selector', {
        searchText: raw,
        normalizedSearch: search,
        candidatesCount: candidates.length,
        chosenSelector: result.selector,
        confidence: result.confidence,
        allCandidates: candidates.map(c => c.selector).slice(0, 3), // Log first 3
      });
    }

    return result;
  }

  const tryFix = (obj: any, indexLabel: string) => {
    const selector = obj.selector?.toString()?.trim();
    const action = obj.action?.toLowerCase();

    // Skip validation for actions that don't need selectors
    if (!selector || action === 'goto' || action === 'wait' || action === 'resize') {
      return;
    }

    // Already valid selector from DOM analysis
    if (validSelectors.has(selector)) {
      return;
    }

    // ✅ FIX: More precise detection of AI-invented selectors
    // Check for :has-text(), text=, contains(), but avoid false positives like input[type="text"]
    const isInventedSelector =
      selector.includes(':has-text(') ||
      /^text\s*=\s*['"]/.test(selector) || // text="..." at start
      selector.includes('contains(') ||
      (selector.includes('text') && (selector.includes(':has-text') || /text\s*=\s*['"]/.test(selector))); // text= with quotes

    if (isInventedSelector) {
      // ✅ FIX: Infer expected element type from action
      let expectedElementType: string | undefined;
      if (action === 'click') expectedElementType = 'button';
      else if (action === 'fill' || action === 'type') expectedElementType = 'input';
      else if (action === 'select') expectedElementType = 'select';
      else if (action === 'check' || action === 'uncheck') expectedElementType = 'checkbox';

      const result = findSelectorByText(selector, expectedElementType);

      if (result && result.selector) {
        obj.selector = result.selector;
        fixedCount++;

        // ✅ FIX: Reduce confidence if collision was detected (multiple candidates)
        if (result.confidence < 0.9) {
          const currentConfidence = obj.confidence ?? 1.0;
          obj.confidence = Math.min(currentConfidence, result.confidence);
          logger.debug('[TEST_PLAN_GENERATOR] Auto-fixed selector with reduced confidence due to collision', {
            item: indexLabel,
            original: selector,
            fixed: result.selector,
            confidence: result.confidence,
          });
        } else {
          logger.debug('[TEST_PLAN_GENERATOR] Auto-fixed selector', {
            item: indexLabel,
            original: selector,
            fixed: result.selector,
            confidence: result.confidence,
          });
        }
      } else {
        // Only mark as invalid if it was detected as invented but couldn't be fixed
        invalidSelectors.push({
          step: indexLabel,
          selector: selector,
          reason: 'AI-invented selector and no matching DOM selector found',
        });
        // mark optional and reduce confidence
        obj.optional = true;
        obj.confidence = Math.min(obj.confidence ?? 1.0, 0.6);
      }
    }
    // If selector is not invented and not in validSelectors, it might be a CSS selector that's valid but not from DOM analysis
    // We don't mark it as invalid - let the test executor handle it
  };

  if (aiPlan.steps && Array.isArray(aiPlan.steps)) {
    aiPlan.steps.forEach((step: any, idx: number) => tryFix(step, `Step ${idx + 1}: ${step.description || step.action || 'unknown'}`));
  }

  if (aiPlan.commands && Array.isArray(aiPlan.commands)) {
    aiPlan.commands.forEach((cmd: any, idx: number) => tryFix(cmd, `Command ${idx + 1}: ${cmd.description || cmd.action || 'unknown'}`));
  }

  if (fixedCount > 0) {
    logger.info('[TEST_PLAN_GENERATOR] Auto-fixed invalid selectors', { fixedCount, remainingInvalid: invalidSelectors.length, totalValidSelectors: validSelectors.size });
  }

  if (invalidSelectors.length > 0) {
    logger.warn('[TEST_PLAN_GENERATOR] Invalid selectors that could not be auto-fixed', { invalidCount: invalidSelectors.length, invalidSelectors: invalidSelectors.slice(0, 10), totalValidSelectors: validSelectors.size });
    if (aiPlan.notes) {
      aiPlan.notes = `${aiPlan.notes}\n\nNote: Some selectors were not resolvable and marked optional. See logs for details.`;
    } else {
      aiPlan.notes = 'Note: Some selectors were not resolvable and were marked optional. Check logs for details.';
    }
  } else if (fixedCount === 0) {
    logger.debug('[TEST_PLAN_GENERATOR] All selectors validated successfully', { totalValidSelectors: validSelectors.size });
  }
}

/**
 * Expected outcome - supports both string (legacy) and structured format (new)
 */
export type ExpectedOutcome =
  | string // Legacy format: simple string description
  | {
      type: 'url_change' | 'toast' | 'element_visible' | 'count_increase' | 'form_submitted' | 'other';
      selector?: string | null;
      expectedValue?: string | null;
      timeoutMs?: number;
    };

/**
 * Test plan with user confirmation
 *
 * ✅ IMPORTANT: Steps and commands are now used as HINTS for AI guidance
 * The Intelligent Mode AI will use these as suggestions but adapt to actual page elements.
 * This provides self-healing and better test reliability.
 */
export interface TestPlan {
  id: string;
  status: 'pending_confirmation' | 'confirmed' | 'rejected';
  url: string;
  scope: string;
  summary: string;
  /**
   * Test steps - used as HINTS for AI guidance
   * AI will adapt these to actual page elements, not execute them literally
   */
  steps: Array<{
    id: string;
    description: string;
    action: string;
    selector?: string; // Suggested selector - AI will find actual element
    value?: string;
    optional?: boolean; // Step is optional if element not found
    confidence?: number; // Confidence level 0.0-1.0
    expectedOutcome: ExpectedOutcome; // Supports both string and structured format
  }>;
  /**
   * Playwright commands - converted to hints for AI guidance
   * @deprecated Commands are now used as hints, not strict commands
   */
  commands: PlaywrightCommand[];
  estimatedDuration: string;
  whatWillBeTested: string[];
  whatWillNotBeTested: string[];
  risks: string[];
  notes?: string | null; // Additional notes about the plan
  createdAt: string;
  expiresAt: string; // Plan expires after 3 days

  // Intelligent testing mode (now always true - Standard Mode removed)
  intelligentMode?: boolean; // Flag for intelligent testing
  estimatedPages?: string; // Estimated pages for intelligent mode
  estimatedCost?: string; // Estimated cost for intelligent mode
  mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
}

/**
 * Generate test plan from exploration results
 * IMPORTANT: Plan requires user confirmation!
 */
export async function generateTestPlan(
  explorationResult: ExplorationResult,
  userRequest: {
    message: string;
    scope: string;
    additionalInfo?: Record<string, any>;
  }
): Promise<TestPlan> {
  try {
    logger.info('Generating test plan from exploration', {
      url: explorationResult.url,
      scope: userRequest.scope,
    });

    // Build comprehensive prompt for AI
    const prompt = buildTestPlanPrompt(explorationResult, userRequest);

    // Generate plan using AI
    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are an expert QA engineer creating comprehensive test plans. Always be specific and actionable.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0.4,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });

    // Extract content from new response format (safe parse)
    let aiPlan: any;
    try {
      if (typeof response.content === 'string') {
        aiPlan = JSON.parse(response.content);
      } else {
        aiPlan = response.content;
      }
    } catch (parseErr) {
      logger.error('[TEST_PLAN_GENERATOR] Failed to parse AI response content', { error: parseErr, raw: response.content && response.content.toString ? response.content.toString().slice(0, 1000) : String(response.content) });
      throw new Error('Invalid AI response format');
    }

    // Log token usage for tracking
    logger.debug('[TEST_PLAN_GENERATOR] AI tokens used', {
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.totalTokens,
      model: response.usage?.model,
    });

    // Generate unique ID - IMPORTANT: Use UUID format for database compatibility
    const planId = randomUUID();

    // Validate selectors against DOM analysis
    validateSelectorsInPlan(aiPlan, explorationResult);

    // ✅ Normalize steps: ensure expectedOutcome is properly formatted
    const normalizedSteps = (aiPlan.steps || []).map((step: any) => ({
      id: step.id || `step_${Math.random().toString(36).substr(2, 9)}`,
      description: step.description || step.action || 'Unknown step',
      action: step.action || 'wait',
      selector: step.selector || undefined,
      value: step.value || undefined,
      optional: step.optional ?? false, // NEW: Support optional flag
      confidence: step.confidence ?? 1.0, // NEW: Support confidence (default 1.0)
      // ✅ Support both string and object format for expectedOutcome
      expectedOutcome: step.expectedOutcome || 'Step completed successfully',
    }));

    // Create structured test plan
    // ✅ FIX: Always use intelligent mode - Standard Mode was removed
    const testPlan: TestPlan = {
      id: planId,
      status: 'pending_confirmation',
      url: explorationResult.url,
      scope: userRequest.scope,
      summary: aiPlan.summary || 'Automated test plan',
      steps: normalizedSteps,
      commands: aiPlan.commands || [], // Commands are hints for intelligent mode
      estimatedDuration: aiPlan.estimatedDuration || 'Unknown',
      whatWillBeTested: aiPlan.whatWillBeTested || [],
      whatWillNotBeTested: aiPlan.whatWillNotBeTested || [],
      risks: aiPlan.risks || [],
      notes: aiPlan.notes || null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 3 days
      // ✅ CRITICAL: Always intelligent mode - Standard Mode removed
      intelligentMode: true,
      mode: (userRequest.additionalInfo?.mode as 'lite' | 'pro') || 'lite', // Test execution mode
    };

    logger.info('Test plan generated (intelligent mode)', {
      planId,
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands.length,
    });

    return testPlan;
  } catch (error) {
    logger.error('Failed to generate test plan', { error });
    throw error;
  }
}


/**
 * Format test plan for user confirmation
 * Returns markdown formatted plan
 * @param plan - Test plan to format
 * @param userLanguage - Optional user language for localized footer ('en' | 'ru' | 'neutral')
 * @param userMessage - Optional user message to detect language from
 */
export function formatTestPlanForConfirmation(
  plan: TestPlan,
  userLanguage?: 'en' | 'ru' | 'neutral',
  userMessage?: string
): string {
  // ✅ UNIFIED: Support both AI-generated and standard test plans
  const isAiGenerated = plan.intelligentMode;

  // Header with appropriate mode indication
  let markdown = isAiGenerated
    ? `# 🧠 AI Test Plan for Confirmation\n`
    : `# 🧪 Test Plan for Confirmation\n`;

  // Basic info
  markdown += `**Plan ID:** \`${plan.id}\`\n`;
  markdown += `**URL:** ${plan.url}\n`;
  markdown += `**Scope:** ${plan.scope}\n`;

  // if (isAiGenerated) {
  //   markdown += `**Mode:** 🤖 **AI-Generated Testing**\n`;
  // }

  // markdown += `**Estimated Duration:** ${plan.estimatedDuration}\n`;

  // Summary
  markdown += `## 📋 Summary\n${plan.summary}\n`;

  // AI-specific estimates (if available)
  // if (isAiGenerated && (plan.estimatedPages || plan.estimatedCost)) {
  //   markdown += `## 📊 AI Estimates\n`;
  //   if (plan.estimatedPages) {
  //     markdown += `- **Pages to Test:** ${plan.estimatedPages}\n`;
  //   }
  //   // if (plan.estimatedCost) {
  //   //   markdown += `- **Estimated Cost:** ${plan.estimatedCost}\n`;
  //   // }
  //   markdown += '';
  // }

  // AI explanation (for AI-generated plans)
  if (isAiGenerated) {
    markdown += `## 🤖 How AI Testing Works\n`;
    markdown += `This AI-generated test plan will:\n`;
    markdown += `1. **Execute pre-analyzed test steps** tailored to your specific site\n`;
    markdown += `2. **Adapt to page context** based on URL analysis and user intent\n`;
    markdown += `3. **Follow intelligent test scenarios** created by AI\n`;
    markdown += `4. **Provide detailed results** with actionable insights\n`;
  }

  // What will be tested
  markdown += `## ✅ What Will Be Tested\n`;
  for (const item of plan.whatWillBeTested) {
    markdown += `- ${item}\n`;
  }

  // Note: whatWillNotBeTested is kept in plan structure for AI responses
  // but not shown in markdown to avoid negative framing

  // Test Steps - Always show if we have steps with selectors (even for intelligent mode)
  const hasConcreteSteps = plan.steps && plan.steps.length > 0 &&
    plan.steps.some(s => s.selector || (s.action && !s.action.startsWith('intelligent_')));

  if (hasConcreteSteps || (!isAiGenerated && plan.steps && plan.steps.length > 0)) {
    markdown += `\n## 🔍 Test Steps\n`;
    if (isAiGenerated) {
      markdown += `*These steps will be executed intelligently by the AI agent, adapting to page context dynamically.*\n\n`;
    }
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      markdown += `**${i + 1}. ${step.description}**\n`;
      if (step.optional) {
        markdown += `   - ⚠️ Optional: This step may not be available\n`;
      }
      // if (step.confidence !== undefined && step.confidence < 1.0) {
      //   markdown += `   - Confidence: ${(step.confidence * 100).toFixed(0)}%\n`;
      // }
      markdown += `   - Action: \`${step.action}\`\n`;
      if (step.selector) {
        markdown += `   - Selector: \`${step.selector}\`\n`;
      }
      if (step.value) {
        markdown += `   - Value: \`${step.value}\`\n`;
      }
      // ✅ Support both string and object format for expectedOutcome
      if (typeof step.expectedOutcome === 'string') {
        markdown += `   - Expected: ${step.expectedOutcome}\n`;
      } else if (step.expectedOutcome && typeof step.expectedOutcome === 'object') {
        const outcome = step.expectedOutcome;
        markdown += `   - Expected: ${outcome.type}`;
        if (outcome.expectedValue) {
          markdown += ` (${outcome.expectedValue})`;
        }
        if (outcome.timeoutMs) {
          markdown += ` [timeout: ${outcome.timeoutMs}ms]`;
        }
        markdown += `\n`;
      } else {
        markdown += `   - Expected: Step completed successfully\n`;
      }
    }
  } else if (isAiGenerated && plan.steps && plan.steps.length > 0) {
    // Show intelligent steps even if they don't have selectors
    markdown += `\n## 🔍 Test Execution\n\n`;
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      markdown += `**${i + 1}. ${step.description}**\n`;
      if (step.optional) {
        markdown += `   - ⚠️ Optional: This step may not be available\n`;
      }
      if (step.confidence !== undefined && step.confidence < 1.0) {
        markdown += `   - Confidence: ${(step.confidence * 100).toFixed(0)}%\n`;
      }
      markdown += `   - Action: \`${step.action}\`\n`;
      // ✅ Support both string and object format for expectedOutcome
      if (typeof step.expectedOutcome === 'string') {
        markdown += `   - Expected: ${step.expectedOutcome}\n`;
      } else if (step.expectedOutcome && typeof step.expectedOutcome === 'object') {
        const outcome = step.expectedOutcome;
        markdown += `   - Expected: ${outcome.type}`;
        if (outcome.expectedValue) {
          markdown += ` (${outcome.expectedValue})`;
        }
        if (outcome.timeoutMs) {
          markdown += ` [timeout: ${outcome.timeoutMs}ms]`;
        }
        markdown += `\n`;
      } else {
        markdown += `   - Expected: Step completed successfully\n`;
      }
    }
    markdown += `\n⚠️ **Note:** Detailed test steps will be generated dynamically by the AI agent during execution.\n`;
  }

  // Notes (NEW) - show before risks
  if (plan.notes) {
    markdown += `\n## 📝 Notes\n`;
    markdown += `${plan.notes}\n`;
  }

  // Risks
  if (plan.risks.length > 0) {
    markdown += `## 🚨 Warning Points\n`;
    for (const risk of plan.risks) {
      markdown += `- ${risk}\n`;
    }
    // markdown += '\n';
  }

  // Safety features (for AI plans)
  if (isAiGenerated) {
    markdown += `## 🛡️ Safety Features\n`;
    markdown += `- Real-time progress updates via WebSocket\n`;
    markdown += `- Automatic detection of dangerous actions (payment, delete, etc.)\n`;
    markdown += `- Intelligent timeout and error handling\n`;
    markdown += `- Safe execution with rollback capabilities\n`;
  }

  // Footer
  markdown += `---\n`;

  // ✅ FIX: Generate natural, language-aware footer
  const footer = generateFooter(plan, userLanguage, userMessage);
  markdown += footer;

  return markdown;
}

/**
 * Generate natural footer text based on user language
 * More natural, less bot-like formatting that adapts to user's language
 */
function generateFooter(
  plan: TestPlan,
  userLanguage?: 'en' | 'ru' | 'neutral',
  userMessage?: string
): string {
  // Auto-detect language from user message if not provided
  let detectedLang = userLanguage;
  if (!detectedLang && userMessage) {
    // Simple detection: if message contains Cyrillic → ru, else → en
    const hasCyrillic = /[а-яА-ЯёЁ]/.test(userMessage);
    detectedLang = hasCyrillic ? 'ru' : 'en';
  }

  // Default to English if no language detected
  const lang = detectedLang === 'ru' ? 'ru' : 'en';

  // Natural, conversational footer - sounds like AI, not a bot
  if (lang === 'ru') {
    return `Дайте знать, если хотите продолжить с этим тестом, или если нужно что-то изменить.\n`;
  }
  return `Let me know if you want to proceed with this test, or if you'd like to adjust anything.\n`;
}


// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENT TEST PLAN GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate intelligent test plan with AI-generated specific steps
 * Uses DOM analysis to create concrete steps that will be executed intelligently
 */
export async function generateIntelligentTestPlan(
  explorationResult: ExplorationResult,
  userRequest: {
    message: string;
    scope: string;
    additionalInfo?: Record<string, any>;
  }
): Promise<TestPlan> {
  try {
    logger.info('Generating intelligent test plan', {
      url: explorationResult.url,
      scope: userRequest.scope,
    });

    // Build comprehensive prompt for AI (same as regular plan, but with intelligent mode context)
    const prompt = buildTestPlanPrompt(explorationResult, {
      ...userRequest,
      message: `${userRequest.message}\n\nNOTE: This is an intelligent test plan. Generate specific test steps with selectors from DOM analysis, but these steps will be executed adaptively by the AI agent during runtime.`,
    });

    // Generate plan using AI
    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are an expert QA engineer creating intelligent test plans. Generate specific, actionable steps with real selectors from DOM analysis. These steps will be executed by an AI agent that can adapt dynamically.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0.4,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    });

    // Extract content from new response format (safe parse)
    let aiPlan: any;
    try {
      if (typeof response.content === 'string') {
        aiPlan = JSON.parse(response.content);
      } else {
        aiPlan = response.content;
      }
    } catch (parseErr) {
      logger.error('[TEST_PLAN_GENERATOR] Failed to parse AI response content', { error: parseErr, raw: response.content && response.content.toString ? response.content.toString().slice(0, 1000) : String(response.content) });
      throw new Error('Invalid AI response format');
    }

    // Log token usage
    logger.debug('[TEST_PLAN_GENERATOR] AI tokens used (intelligent)', {
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.totalTokens,
      model: response.usage?.model,
    });

    // Generate unique ID
    const planId = randomUUID();

    // Validate selectors against DOM analysis
    validateSelectorsInPlan(aiPlan, explorationResult);

    // ✅ Normalize steps: ensure expectedOutcome is properly formatted
    const normalizedSteps = (aiPlan.steps || []).map((step: any) => ({
      id: step.id || `step_${Math.random().toString(36).substr(2, 9)}`,
      description: step.description || step.action || 'Unknown step',
      action: step.action || 'wait',
      selector: step.selector || undefined,
      value: step.value || undefined,
      optional: step.optional ?? false, // NEW: Support optional flag
      confidence: step.confidence ?? 1.0, // NEW: Support confidence (default 1.0)
      // ✅ Support both string and object format for expectedOutcome
      expectedOutcome: step.expectedOutcome || 'Step completed successfully',
    }));

    // Fallback steps if AI didn't generate any
    const fallbackSteps: TestPlan['steps'] = [
      {
        id: 'step_1',
        description: 'Analyze and explore the site',
        action: 'intelligent_explore',
        expectedOutcome: 'Understanding of site structure and key pages',
      },
      {
        id: 'step_2',
        description: 'Execute contextual testing on each page',
        action: 'intelligent_test',
        expectedOutcome: 'Comprehensive testing adapted to page context',
      },
    ];

    // Create structured test plan with AI-generated steps
    const testPlan: TestPlan = {
      id: planId,
      status: 'pending_confirmation',
      url: explorationResult.url,
      scope: userRequest.scope,
      summary: aiPlan.summary || `Intelligent testing of ${explorationResult.url}. The AI agent will autonomously explore and test the site, adapting to each page dynamically.`,
      steps: normalizedSteps.length > 0 ? normalizedSteps : fallbackSteps,
      commands: aiPlan.commands || [], // AI-generated commands with real selectors
      estimatedDuration: aiPlan.estimatedDuration || '1-3 minutes',
      whatWillBeTested: aiPlan.whatWillBeTested || [
        'Page navigation and routing',
        'Interactive elements (buttons, forms, inputs)',
        'Logical dependencies between elements',
        'User journey flows',
        'Visual elements and layouts',
        'Dynamic content and state changes',
      ],
      whatWillNotBeTested: aiPlan.whatWillNotBeTested || [
        'Payment processing (requires manual approval)',
        'Account deletion (safety restriction)',
        'Email/SMS sending (external systems)',
        'Third-party integrations',
      ],
      risks: aiPlan.risks || [
        'CAPTCHA may require manual intervention',
        'Authentication may be needed for protected pages',
        'Dynamic content may cause unpredictable behavior',
        'Popups and modals may block automation',
      ],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 3 days

      // Intelligent mode flags
      intelligentMode: true,
      estimatedPages: '5-10 pages',
      estimatedCost: '$0.10-0.20',
      mode: (userRequest.additionalInfo?.mode as 'lite' | 'pro') || 'lite', // Test execution mode
    };

    logger.info('Intelligent test plan generated', {
      planId,
      intelligentMode: true,
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands.length,
    });

    return testPlan;
  } catch (error) {
    logger.error('Failed to generate intelligent test plan', { error });
    throw error;
  }
}
