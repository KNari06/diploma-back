/**
 * GoalDetector
 * Evaluates whether the current page state matches the user's goal.
 * Uses a hybrid approach:
 * 1. Fast heuristic detection (rule-based, no AI call)
 * 2. AI fallback for uncertain cases (done validation, stuck recovery)
 *
 * Usage:
 * - detectHeuristic() - fast path, called every iteration
 * - validateDoneWithContext() - validate AI's done=true claim with optional AI fallback
 * - evaluateWithAI() - full AI evaluation for stuck recovery
 */

import { logger } from '@/utils/core/logger';
import type { GoalContext, GoalEval, LiteSnapshot } from '../lite-types';
import { AIGoalEvaluator } from './ai-goal-evaluator';

/**
 * Result of goal detection (heuristic)
 */
export interface GoalDetectionResult {
  goalReached: boolean;
  progressScore: number; // 0..1 - how close we are to the goal
  signals: GoalSignal[];
  confidence: 'low' | 'medium' | 'high';
  reason?: string;
}

/**
 * Individual signal contributing to goal detection
 */
export interface GoalSignal {
  type: 'url' | 'form' | 'heading' | 'cta' | 'content' | 'element';
  match: boolean;
  weight: number; // 0..1 - importance of this signal
  detail?: string;
}

/**
 * Parse the goal to extract keywords and expected patterns
 */
interface ParsedGoal {
  action?: string; // register, login, checkout, search, etc.
  target?: string; // form, page, button, etc.
  keywords: string[];
  urlPatterns: string[];
}

// Minimum confidence for heuristic to be "trusted"
const MIN_HEURISTIC_CONFIDENCE = 0.5;

/**
 * GoalDetector class
 */
export class GoalDetector {
  private goal: string;
  private parsedGoal: ParsedGoal;
  private aiEvaluator: AIGoalEvaluator | null = null;
  private testId: string;

  constructor(goal: string, testId?: string) {
    this.goal = goal.toLowerCase();
    this.parsedGoal = this.parseGoal(goal);
    this.testId = testId || 'unknown';

    // Initialize AI evaluator if testId is provided
    if (testId) {
      this.aiEvaluator = new AIGoalEvaluator(testId);
    }
  }

  /**
   * Set test ID (for cases where constructor didn't have it)
   */
  setTestId(testId: string): void {
    this.testId = testId;
    this.aiEvaluator = new AIGoalEvaluator(testId);
  }

  /**
   * Parse goal to extract structured information
   */
  private parseGoal(goal: string): ParsedGoal {
    const lowerGoal = goal.toLowerCase();
    const parsed: ParsedGoal = {
      keywords: [],
      urlPatterns: [],
    };

    // Extract action type
    if (/register|sign\s*up|create\s+account|registration/i.test(lowerGoal)) {
      parsed.action = 'register';
      parsed.keywords = ['register', 'signup', 'sign up', 'create account', 'registration'];
      parsed.urlPatterns = ['register', 'signup', 'sign-up', 'create-account', 'join'];
    } else if (/login|sign\s*in|log\s*in|auth/i.test(lowerGoal)) {
      parsed.action = 'login';
      parsed.keywords = ['login', 'sign in', 'log in', 'signin', 'authentication'];
      parsed.urlPatterns = ['login', 'signin', 'sign-in', 'auth', 'account'];
    } else if (/checkout|payment|pay|order|purchase/i.test(lowerGoal)) {
      parsed.action = 'checkout';
      parsed.keywords = ['checkout', 'payment', 'pay', 'order', 'purchase', 'buy'];
      parsed.urlPatterns = ['checkout', 'payment', 'cart', 'order', 'pay'];
    } else if (/search|find|look\s*for/i.test(lowerGoal)) {
      parsed.action = 'search';
      parsed.keywords = ['search', 'find', 'results'];
      parsed.urlPatterns = ['search', 'results', 'query'];
    } else if (/contact|message|support|help/i.test(lowerGoal)) {
      parsed.action = 'contact';
      parsed.keywords = ['contact', 'message', 'support', 'help', 'feedback'];
      parsed.urlPatterns = ['contact', 'support', 'help', 'feedback'];
    }

    // Extract target from goal
    if (/form/i.test(lowerGoal)) parsed.target = 'form';
    if (/page/i.test(lowerGoal)) parsed.target = 'page';
    if (/button/i.test(lowerGoal)) parsed.target = 'button';

    return parsed;
  }

  /**
   * Main detection method
   */
  detect(snapshot: LiteSnapshot): GoalDetectionResult {
    const signals: GoalSignal[] = [];
    let totalWeight = 0;
    let matchedWeight = 0;

    // 1. URL pattern matching (weight: 0.35)
    const urlSignal = this.checkUrlPatterns(snapshot.url);
    signals.push(urlSignal);
    totalWeight += 0.35;
    if (urlSignal.match) matchedWeight += 0.35 * urlSignal.weight;

    // 2. Form presence (weight: 0.25 for form-related goals)
    if (['register', 'login', 'contact'].includes(this.parsedGoal.action || '')) {
      const formSignal = this.checkFormPresence(snapshot);
      signals.push(formSignal);
      totalWeight += 0.25;
      if (formSignal.match) matchedWeight += 0.25 * formSignal.weight;
    }

    // 3. Heading/title matching (weight: 0.2)
    const headingSignal = this.checkHeadings(snapshot);
    signals.push(headingSignal);
    totalWeight += 0.2;
    if (headingSignal.match) matchedWeight += 0.2 * headingSignal.weight;

    // 4. CTA/button text matching (weight: 0.15)
    const ctaSignal = this.checkCTAs(snapshot);
    signals.push(ctaSignal);
    totalWeight += 0.15;
    if (ctaSignal.match) matchedWeight += 0.15 * ctaSignal.weight;

    // 5. Content/element matching (weight: 0.05)
    const contentSignal = this.checkContent(snapshot);
    signals.push(contentSignal);
    totalWeight += 0.05;
    if (contentSignal.match) matchedWeight += 0.05 * contentSignal.weight;

    // Calculate progress score
    const progressScore = totalWeight > 0 ? matchedWeight / totalWeight : 0;

    // Determine if goal is reached
    const goalReached = progressScore >= 0.6 && signals.filter(s => s.match).length >= 3;

    // Determine confidence
    let confidence: 'low' | 'medium' | 'high' = 'low';
    if (progressScore >= 0.8 && signals.filter(s => s.match).length >= 4) {
      confidence = 'high';
    } else if (progressScore >= 0.5 && signals.filter(s => s.match).length >= 2) {
      confidence = 'medium';
    }

    const result: GoalDetectionResult = {
      goalReached,
      progressScore,
      signals,
      confidence,
      reason: this.buildReason(signals, progressScore),
    };

    logger.debug('[GOAL_DETECTOR] Detection result', {
      goal: this.goal.slice(0, 50),
      goalReached,
      progressScore: Math.round(progressScore * 100) + '%',
      confidence,
      matchedSignals: signals.filter(s => s.match).length,
      totalSignals: signals.length,
    });

    return result;
  }

  /**
   * Check URL patterns
   */
  private checkUrlPatterns(url: string): GoalSignal {
    const lowerUrl = url.toLowerCase();

    for (const pattern of this.parsedGoal.urlPatterns) {
      if (lowerUrl.includes(pattern)) {
        return {
          type: 'url',
          match: true,
          weight: 1,
          detail: `URL contains "${pattern}"`,
        };
      }
    }

    // Partial match for keywords
    for (const keyword of this.parsedGoal.keywords) {
      if (lowerUrl.includes(keyword.replace(/\s+/g, ''))) {
        return {
          type: 'url',
          match: true,
          weight: 0.7,
          detail: `URL contains keyword "${keyword}"`,
        };
      }
    }

    return {
      type: 'url',
      match: false,
      weight: 0,
      detail: 'URL does not match expected patterns',
    };
  }

  /**
   * Check form presence
   */
  private checkFormPresence(snapshot: LiteSnapshot): GoalSignal {
    // Look for input fields relevant to the action
    const inputElements = snapshot.elements.filter(
      el => el.tag === 'input' || el.tag === 'textarea'
    );

    const hasPasswordField = inputElements.some(el => el.type === 'password');
    const hasEmailField = inputElements.some(
      el => el.type === 'email' || el.name?.toLowerCase().includes('email')
    );
    const hasNameField = inputElements.some(el =>
      ['name', 'username', 'firstname', 'lastname'].some(
        n => el.name?.toLowerCase().includes(n) || el.placeholder?.toLowerCase().includes(n)
      )
    );

    // Registration typically has email + password + name
    if (this.parsedGoal.action === 'register') {
      if (hasPasswordField && (hasEmailField || hasNameField)) {
        return {
          type: 'form',
          match: true,
          weight: hasPasswordField && hasEmailField && hasNameField ? 1 : 0.7,
          detail: `Found registration form fields (email: ${hasEmailField}, password: ${hasPasswordField}, name: ${hasNameField})`,
        };
      }
    }

    // Login typically has email/username + password
    if (this.parsedGoal.action === 'login') {
      if (hasPasswordField && (hasEmailField || hasNameField)) {
        return {
          type: 'form',
          match: true,
          weight: 1,
          detail: 'Found login form fields',
        };
      }
    }

    // Check for general form presence
    if (inputElements.length >= 2) {
      return {
        type: 'form',
        match: true,
        weight: 0.5,
        detail: `Found ${inputElements.length} input fields`,
      };
    }

    return {
      type: 'form',
      match: false,
      weight: 0,
      detail: 'No relevant form fields found',
    };
  }

  /**
   * Check headings for goal keywords
   * NOTE: LiteElement uses 'name' for text content (not 'text')
   */
  private checkHeadings(snapshot: LiteSnapshot): GoalSignal {
    const headings = snapshot.elements.filter(el =>
      ['h1', 'h2', 'h3'].includes(el.tag || '')
    );

    for (const heading of headings) {
      const text = (heading.name || '').toLowerCase();
      for (const keyword of this.parsedGoal.keywords) {
        if (text.includes(keyword)) {
          return {
            type: 'heading',
            match: true,
            weight: 1,
            detail: `Heading contains "${keyword}": "${heading.name?.slice(0, 50)}"`,
          };
        }
      }
    }

    return {
      type: 'heading',
      match: false,
      weight: 0,
      detail: 'No headings match goal keywords',
    };
  }

  /**
   * Check CTAs (buttons, links)
   * NOTE: LiteElement uses 'name' for text content (not 'text')
   */
  private checkCTAs(snapshot: LiteSnapshot): GoalSignal {
    const ctas = snapshot.elements.filter(el =>
      el.tag === 'button' ||
      (el.tag === 'a' && el.name && el.name.length < 50) ||
      el.type === 'submit'
    );

    for (const cta of ctas) {
      const text = (cta.name || '').toLowerCase();
      for (const keyword of this.parsedGoal.keywords) {
        if (text.includes(keyword)) {
          return {
            type: 'cta',
            match: true,
            weight: 1,
            detail: `CTA contains "${keyword}": "${cta.name?.slice(0, 30)}"`,
          };
        }
      }
    }

    return {
      type: 'cta',
      match: false,
      weight: 0,
      detail: 'No CTAs match goal keywords',
    };
  }

  /**
   * Check general content
   * NOTE: LiteElement uses 'name' for text content (not 'text')
   */
  private checkContent(snapshot: LiteSnapshot): GoalSignal {
    // Check for success indicators
    const successIndicators = ['success', 'thank you', 'welcome', 'confirmed', 'completed'];

    for (const el of snapshot.elements) {
      const text = (el.name || '').toLowerCase();

      // Check for success
      for (const indicator of successIndicators) {
        if (text.includes(indicator)) {
          return {
            type: 'content',
            match: true,
            weight: 0.8,
            detail: `Found success indicator: "${indicator}"`,
          };
        }
      }
    }

    // Check for goal keywords in content
    const allText = snapshot.elements.map(el => el.name || '').join(' ').toLowerCase();
    const keywordCount = this.parsedGoal.keywords.filter(kw => allText.includes(kw)).length;

    if (keywordCount >= 2) {
      return {
        type: 'content',
        match: true,
        weight: 0.6,
        detail: `Found ${keywordCount} goal keywords in page content`,
      };
    }

    return {
      type: 'content',
      match: false,
      weight: 0,
      detail: 'No relevant content found',
    };
  }

  /**
   * Build human-readable reason
   */
  private buildReason(signals: GoalSignal[], score: number): string {
    const matched = signals.filter(s => s.match);
    if (matched.length === 0) {
      return 'No goal indicators found on current page';
    }

    const details = matched.map(s => s.detail).filter(Boolean);
    return `Progress: ${Math.round(score * 100)}%. ${details.join('; ')}`;
  }

  /**
   * Validate AI's done claim (legacy method for backward compatibility)
   * Returns true if we should accept the done claim
   */
  validateDoneClaim(snapshot: LiteSnapshot, aiThought?: string): boolean {
    const detection = this.detect(snapshot);

    // Accept if goal detection says reached with medium+ confidence
    if (detection.goalReached && detection.confidence !== 'low') {
      return true;
    }

    // Check for success indicators in AI's thought
    if (aiThought) {
      const thoughtLower = aiThought.toLowerCase();
      const successPhrases = [
        'completed',
        'successfully',
        'goal reached',
        'done',
        'finished',
        'submitted',
        'registered',
        'logged in',
      ];

      for (const phrase of successPhrases) {
        if (thoughtLower.includes(phrase)) {
          // Cross-check with at least some signals
          if (detection.progressScore >= 0.3) {
            return true;
          }
        }
      }
    }

    // Reject if no strong evidence
    logger.warn('[GOAL_DETECTOR] Rejecting false-positive done claim', {
      progressScore: Math.round(detection.progressScore * 100) + '%',
      confidence: detection.confidence,
      matchedSignals: detection.signals.filter(s => s.match).length,
    });

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: Context-aware methods with AI fallback support
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect goal using heuristic with full context
   * Fast path - no AI call
   *
   * @param context - Full goal context
   * @returns Heuristic detection result
   */
  detectHeuristic(context: GoalContext): GoalDetectionResult {
    // Create a minimal snapshot from context for the existing detect() method
    const snapshot: LiteSnapshot = {
      url: context.page.url,
      title: context.page.title,
      elements: this.parseSnapshotSummary(context.snapshotSummary),
      timestamp: Date.now(),
    };

    return this.detect(snapshot);
  }

  /**
   * Validate AI's done=true claim with optional AI fallback
   * Called when AI says done=true
   *
   * @param context - Full goal context
   * @param aiThought - AI's thought explaining why done
   * @returns Promise<{ accepted: boolean; usedAIFallback: boolean; aiEval?: GoalEval }>
   */
  async validateDoneWithContext(
    context: GoalContext,
    aiThought?: string
  ): Promise<{ accepted: boolean; usedAIFallback: boolean; aiEval?: GoalEval }> {
    // Step 1: Try heuristic first
    const heuristicResult = this.detectHeuristic(context);

    // If heuristic is confident, use it
    if (heuristicResult.goalReached && heuristicResult.confidence !== 'low') {
      logger.info('[GOAL_DETECTOR] Heuristic accepted done claim', {
        testId: this.testId,
        progressScore: Math.round(heuristicResult.progressScore * 100) + '%',
        confidence: heuristicResult.confidence,
      });
      return { accepted: true, usedAIFallback: false };
    }

    // Check for success indicators in AI's thought (quick check)
    if (aiThought && heuristicResult.progressScore >= MIN_HEURISTIC_CONFIDENCE) {
      const thoughtLower = aiThought.toLowerCase();
      const successPhrases = ['completed', 'successfully', 'goal reached', 'done', 'finished', 'submitted', 'registered', 'logged in'];

      for (const phrase of successPhrases) {
        if (thoughtLower.includes(phrase)) {
          logger.info('[GOAL_DETECTOR] Heuristic accepted done claim with thought phrase', {
            testId: this.testId,
            phrase,
            progressScore: Math.round(heuristicResult.progressScore * 100) + '%',
          });
          return { accepted: true, usedAIFallback: false };
        }
      }
    }

    // Step 2: Heuristic uncertain - try AI fallback
    if (!this.aiEvaluator) {
      logger.warn('[GOAL_DETECTOR] No AI evaluator, rejecting uncertain done claim', {
        testId: this.testId,
        progressScore: Math.round(heuristicResult.progressScore * 100) + '%',
      });
      return { accepted: false, usedAIFallback: false };
    }

    logger.info('[GOAL_DETECTOR] Heuristic uncertain, calling AI fallback', {
      testId: this.testId,
      progressScore: Math.round(heuristicResult.progressScore * 100) + '%',
      confidence: heuristicResult.confidence,
    });

    try {
      const aiEval = await this.aiEvaluator.evaluate(context, 'done_validation');

      if (!aiEval) {
        // AI fallback timed out or failed - reject to be safe
        logger.warn('[GOAL_DETECTOR] AI fallback failed, rejecting done claim', {
          testId: this.testId,
        });
        return { accepted: false, usedAIFallback: true };
      }

      // Accept if AI says goal reached with sufficient confidence
      const accepted = aiEval.goalReached && aiEval.confidence >= MIN_HEURISTIC_CONFIDENCE;

      logger.info('[GOAL_DETECTOR] AI fallback result', {
        testId: this.testId,
        goalReached: aiEval.goalReached,
        confidence: aiEval.confidence,
        accepted,
        evidence: aiEval.evidence.slice(0, 2),
      });

      return { accepted, usedAIFallback: true, aiEval };
    } catch (error) {
      // Check if cancelled
      if (error instanceof Error && error.message.includes('cancelled')) {
        throw error;
      }

      logger.error('[GOAL_DETECTOR] AI fallback error', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, usedAIFallback: true };
    }
  }

  /**
   * Evaluate using AI for stuck recovery
   * Called when agent is stuck for 2+ iterations
   *
   * @param context - Full goal context
   * @returns GoalEval with nextSubgoal or null if failed
   */
  async evaluateForStuckRecovery(context: GoalContext): Promise<GoalEval | null> {
    if (!this.aiEvaluator) {
      logger.warn('[GOAL_DETECTOR] No AI evaluator for stuck recovery', {
        testId: this.testId,
      });
      return null;
    }

    logger.info('[GOAL_DETECTOR] Evaluating for stuck recovery', {
      testId: this.testId,
      consecutiveStuckCount: context.consecutiveStuckCount,
      stuckReason: context.stuckCheck.reason,
    });

    try {
      const aiEval = await this.aiEvaluator.evaluate(context, 'stuck_recovery');

      if (aiEval) {
        logger.info('[GOAL_DETECTOR] Stuck recovery AI result', {
          testId: this.testId,
          progressScore: Math.round(aiEval.progressScore * 100) + '%',
          hasNextSubgoal: !!aiEval.nextSubgoal,
          nextSubgoal: aiEval.nextSubgoal?.slice(0, 50),
        });
      }

      return aiEval;
    } catch (error) {
      // Check if cancelled
      if (error instanceof Error && error.message.includes('cancelled')) {
        throw error;
      }

      logger.error('[GOAL_DETECTOR] Stuck recovery AI error', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Parse snapshot summary back into minimal elements
   * Format: "tag[type]:name"
   */
  private parseSnapshotSummary(summary: string[]): Array<{
    ref: string;
    role: string;
    name: string;
    tag: string;
    type?: string;
    visible: boolean;
  }> {
    return summary.map((entry, idx) => {
      // Parse "tag[type]:name" or "tag:name"
      const match = entry.match(/^(\w+)(?:\[([^\]]+)\])?:(.+)$/);
      if (!match) {
        return {
          ref: `e${idx}`,
          role: 'generic',
          name: entry,
          tag: 'span',
          visible: true,
        };
      }

      const [, tag, type, name] = match;
      return {
        ref: `e${idx}`,
        role: this.tagToRole(tag),
        name: name.trim(),
        tag: tag.toLowerCase(),
        type: type || undefined,
        visible: true,
      };
    });
  }

  /**
   * Map tag to ARIA role (simplified)
   */
  private tagToRole(tag: string): string {
    const roleMap: Record<string, string> = {
      button: 'button',
      a: 'link',
      input: 'textbox',
      textarea: 'textbox',
      select: 'combobox',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      form: 'form',
    };
    return roleMap[tag.toLowerCase()] || 'generic';
  }
}
