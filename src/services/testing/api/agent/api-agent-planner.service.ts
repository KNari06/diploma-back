/**
 * API Agent Planner
 * AI-powered step planning based on current state and policy
 */

import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import type {
  ApiAgentRunState,
  ApiAgentLevelPolicy,
  ApiAgentAIDecision,
  ApiAgentPlannedStep,
  ApiAgentStepType,
  ApiAgentRequest,
} from './api-agent.types';
import { getAllowedStepTypes, checkSafetyGate } from './api-agent-policy';

// ═══════════════════════════════════════════════════════════════════════════
// PLANNER SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ApiAgentPlannerService {
  /**
   * Plan the next step using AI (or rule-based for simple cases)
   * Returns the planned step and tokens consumed
   */
  static async planNextStep(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy
  ): Promise<{ decision: ApiAgentAIDecision; tokensUsed: number }> {
    const allowedStepTypes = getAllowedStepTypes(policy.level);

    // Rule-based planning for initial steps (saves AI tokens)
    const ruleBasedDecision = this.tryRuleBasedPlanning(request, state, policy, allowedStepTypes);
    if (ruleBasedDecision) {
      return { decision: ruleBasedDecision, tokensUsed: 0 };
    }

    // AI-based planning for complex decisions
    return this.aiBasedPlanning(request, state, policy, allowedStepTypes);
  }

  /**
   * Rule-based planning for predictable steps
   */
  private static tryRuleBasedPlanning(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    allowedStepTypes: ApiAgentStepType[]
  ): ApiAgentAIDecision | null {
    // Step 0: Always start with happy path
    if (state.consumed.steps === 0) {
      return {
        nextStep: {
          stepType: 'happy_path',
          description: `Execute ${request.method} ${request.url} with provided data`,
          request: {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
          },
          expectedOutcome: `Expect ${request.expectedStatus || 200} response`,
          riskLevel: 'safe',
        },
        reasoning: 'Starting with happy path test',
        shouldStop: false,
        noveltyEstimate: 1.0,
      };
    }

    // Step 1-N: Method contract checks (for all levels)
    const happyPathDone = state.steps.some((s) => s.stepType === 'happy_path');
    const methodContractDone = state.steps.filter((s) => s.stepType === 'method_contract').length >= 4;

    if (happyPathDone && !methodContractDone && allowedStepTypes.includes('method_contract')) {
      const testedMethods = state.steps
        .filter((s) => s.stepType === 'method_contract')
        .map((s) => s.request.method.toUpperCase());
      testedMethods.push(request.method.toUpperCase()); // Original method is already tested

      const methodsToTest = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].filter(
        (m) => !testedMethods.includes(m)
      );

      if (methodsToTest.length > 0) {
        const nextMethod = methodsToTest[0];
        return {
          nextStep: {
            stepType: 'method_contract',
            description: `Test ${nextMethod} method on endpoint (expect 405/4xx)`,
            request: {
              method: nextMethod,
              url: request.url,
              headers: request.headers,
            },
            expectedOutcome: 'Expect 405 Method Not Allowed or 4xx error',
            riskLevel: nextMethod === 'GET' ? 'safe' : 'low',
          },
          reasoning: `Testing method contract for ${nextMethod}`,
          shouldStop: false,
          noveltyEstimate: state.novelty,
        };
      }
    }

    // For LIGHT level: stop after method contracts
    if (policy.level === 'light' && methodContractDone) {
      return {
        nextStep: null,
        reasoning: 'LIGHT level complete: happy path + method contracts done',
        shouldStop: true,
        stopReason: 'completed',
        noveltyEstimate: state.novelty,
      };
    }

    // For MEDIUM/HARD: continue with AI-based planning
    return null;
  }

  /**
   * AI-based planning for complex decisions
   */
  private static async aiBasedPlanning(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    allowedStepTypes: ApiAgentStepType[]
  ): Promise<{ decision: ApiAgentAIDecision; tokensUsed: number }> {
    const prompt = this.buildPlanningPrompt(request, state, policy, allowedStepTypes);

    try {
      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: this.getSystemPrompt(policy.level),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          temperature: 0.3,
          response_format: { type: 'json_object' },
          model: 'gpt-4o-mini', // Cost-effective for planning
        }
      );

      const tokensUsed = response.usage?.totalTokens || 0;
      const parsed = JSON.parse(response.content);

      // Validate and build decision
      const decision = this.parseAIResponse(parsed, request, state, policy);

      logger.debug('[API_AGENT_PLANNER] AI planning complete', {
        tokensUsed,
        hasNextStep: !!decision.nextStep,
        shouldStop: decision.shouldStop,
      });

      return { decision, tokensUsed };
    } catch (error) {
      logger.error('[API_AGENT_PLANNER] AI planning failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: stop with error
      return {
        decision: {
          nextStep: null,
          reasoning: 'AI planning failed, stopping execution',
          shouldStop: true,
          stopReason: 'error',
          noveltyEstimate: 0,
        },
        tokensUsed: 0,
      };
    }
  }

  /**
   * Build planning prompt
   */
  private static buildPlanningPrompt(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    allowedStepTypes: ApiAgentStepType[]
  ): string {
    const recentSteps = state.steps.slice(-5).map((s) => ({
      type: s.stepType,
      description: s.description,
      success: s.success,
      status: s.response?.status,
      findingsCount: s.findings.length,
    }));

    const findingsSummary = state.findings.slice(-10).map((f) => ({
      type: f.type,
      severity: f.severity,
      title: f.title,
    }));

    return `## Current State
- Level: ${policy.level}
- Steps executed: ${state.consumed.steps}/${policy.budget.maxSteps}
- Novelty: ${state.novelty.toFixed(2)} (threshold: ${policy.noveltyStopThreshold})
- Findings: ${state.findings.length} total

## Target Endpoint
- URL: ${request.url}
- Original Method: ${request.method}
- User Intent: ${request.userMessage || 'Test this API'}

## Recent Steps
${JSON.stringify(recentSteps, null, 2)}

## Recent Findings
${JSON.stringify(findingsSummary, null, 2)}

## Discovered
- Methods: ${state.discoveredMethods.join(', ') || 'none'}
- Known IDs: ${state.knownIds.slice(0, 5).join(', ') || 'none'}
- Schema inferred: ${state.inferredSchema ? 'yes' : 'no'}

## Allowed Step Types for ${policy.level}
${allowedStepTypes.join(', ')}

## Task
Decide the next step to execute. Consider:
1. What hasn't been tested yet?
2. Are there findings worth investigating deeper?
3. Is novelty still high enough to continue?
4. For MEDIUM: focus on business logic, negative cases, consistency
5. For HARD: add security testing, fuzzing, edge cases

Return JSON:
{
  "nextStep": {
    "stepType": "one of: ${allowedStepTypes.join(', ')}",
    "description": "what this step tests",
    "request": {
      "method": "HTTP method",
      "url": "full URL",
      "headers": {},
      "body": null or object
    },
    "expectedOutcome": "what we expect",
    "riskLevel": "safe|low|medium|high"
  } or null if should stop,
  "reasoning": "why this decision",
  "shouldStop": true/false,
  "stopReason": "completed|novelty_threshold|null",
  "noveltyEstimate": 0.0-1.0
}`;
  }

  /**
   * Get system prompt for planner
   */
  private static getSystemPrompt(level: string): string {
    return `You are an expert API testing agent planning the next test step.

Level: ${level.toUpperCase()}
- LIGHT: Focus on sanity checks, contract validation, basic schema
- MEDIUM: Add business logic validation, negative cases, consistency checks
- HARD: Add security testing, fuzzing, edge cases, deeper exploration

Rules:
1. Always return valid JSON
2. Consider safety - skip high-risk steps on production-looking URLs
3. Stop when novelty is low (nothing new to discover)
4. Prioritize high-value tests over redundant ones
5. For mutations, prefer test data that can be cleaned up`;
  }

  /**
   * Parse AI response into decision
   */
  private static parseAIResponse(
    parsed: any,
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy
  ): ApiAgentAIDecision {
    // Validate nextStep if present
    let nextStep: ApiAgentPlannedStep | null = null;

    if (parsed.nextStep && typeof parsed.nextStep === 'object') {
      // Validate step type
      const allowedTypes = getAllowedStepTypes(policy.level);
      if (!allowedTypes.includes(parsed.nextStep.stepType)) {
        logger.warn('[API_AGENT_PLANNER] AI suggested disallowed step type', {
          suggested: parsed.nextStep.stepType,
          allowed: allowedTypes,
        });
        return {
          nextStep: null,
          reasoning: `AI suggested disallowed step type: ${parsed.nextStep.stepType}`,
          shouldStop: true,
          stopReason: 'completed',
          noveltyEstimate: state.novelty,
        };
      }

      // Check safety gate
      const safetyCheck = checkSafetyGate({
        url: parsed.nextStep.request?.url || request.url,
        method: parsed.nextStep.request?.method || 'GET',
        stepType: parsed.nextStep.stepType,
        policy,
        currentState: state,
      });

      if (!safetyCheck.allowed) {
        logger.info('[API_AGENT_PLANNER] Step blocked by safety gate', {
          reason: safetyCheck.reason,
          skipped: safetyCheck.skippedAction,
        });
        // Don't stop, just skip this step and let AI try again
        return {
          nextStep: null,
          reasoning: `Step skipped by safety gate: ${safetyCheck.reason}`,
          shouldStop: false,
          noveltyEstimate: state.novelty * 0.9, // Slight decay
        };
      }

      nextStep = {
        stepType: parsed.nextStep.stepType,
        description: parsed.nextStep.description || 'Test step',
        request: {
          method: parsed.nextStep.request?.method || request.method,
          url: parsed.nextStep.request?.url || request.url,
          headers: parsed.nextStep.request?.headers,
          body: parsed.nextStep.request?.body,
        },
        expectedOutcome: parsed.nextStep.expectedOutcome || 'Verify response',
        riskLevel: parsed.nextStep.riskLevel || 'low',
      };
    }

    return {
      nextStep,
      reasoning: parsed.reasoning || 'No reasoning provided',
      shouldStop: parsed.shouldStop === true || nextStep === null,
      stopReason: parsed.stopReason || (nextStep === null ? 'completed' : undefined),
      noveltyEstimate: typeof parsed.noveltyEstimate === 'number' ? parsed.noveltyEstimate : state.novelty,
    };
  }
}
