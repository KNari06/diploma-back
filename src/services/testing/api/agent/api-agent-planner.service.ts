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
  ApiAgentStopReason,
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

    // AI-driven on all levels:
    // - deterministic logic only provides a suggestedNextStep to guide the model
    // - AI is still invoked iteratively to confirm/adjust the plan based on results
    const suggestion = this.getSuggestedNextStep(request, state, policy, allowedStepTypes);
    return this.aiBasedPlanning(request, state, policy, allowedStepTypes, suggestion);
  }

  /**
   * Deterministic suggestions for predictable steps
   * (Used as a hint for the AI planner, not as a bypass.)
   */
  private static getSuggestedNextStep(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    allowedStepTypes: ApiAgentStepType[]
  ): {
    suggestedNextStep: ApiAgentPlannedStep | null;
    suggestedShouldStop?: boolean;
    suggestedStopReason?: ApiAgentStopReason;
    suggestedReasoning?: string;
  } {
    // Step 0: Always start with happy path
    if (state.consumed.steps === 0) {
      return {
        suggestedNextStep: {
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
        suggestedShouldStop: false,
        suggestedReasoning: 'Starting with happy path test',
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
          suggestedNextStep: {
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
          suggestedShouldStop: false,
          suggestedReasoning: `Testing method contract for ${nextMethod}`,
        };
      }
    }

    // For LIGHT level: stop after method contracts
    if (policy.level === 'light' && methodContractDone) {
      return {
        suggestedNextStep: null,
        suggestedShouldStop: true,
        suggestedStopReason: 'completed',
        suggestedReasoning: 'LIGHT level complete: happy path + method contracts done',
      };
    }

    // MEDIUM/HARD: suggest parameter probing via negative_case (one probe at a time)
    // This is a hint only; AI still decides whether to execute it.
    if (policy.level !== 'light' && allowedStepTypes.includes('negative_case') && happyPathDone) {
      const baseUrl = request.url;
      const tried = new Set(
        state.steps
          .filter((s) => s.stepType === 'negative_case')
          .map((s) => s.request.url)
      );

      const probes = [
        { key: 'page', value: '-1' },
        { key: 'limit', value: '100000' },
        { key: 'limit', value: '-1' },
        { key: 'unexpected', value: 'true' },
      ];

      for (const p of probes) {
        try {
          const u = new URL(baseUrl);
          u.searchParams.set(p.key, p.value);
          const probeUrl = u.toString();
          if (!tried.has(probeUrl)) {
            return {
              suggestedNextStep: {
                stepType: 'negative_case',
                description: `Probe invalid/edge parameter: ${p.key}=${p.value} (expect controlled 4xx)`,
                request: {
                  method: request.method,
                  url: probeUrl,
                  headers: request.headers,
                  body: request.body,
                },
                expectedOutcome: 'Expect controlled 4xx (not 5xx/timeout)',
                riskLevel: 'low',
              },
              suggestedShouldStop: false,
              suggestedReasoning: 'Parameter probing to detect invalid input handling issues',
            };
          }
        } catch {
          // If URL parsing fails, skip probing suggestions
          break;
        }
      }
    }

    return { suggestedNextStep: null };
  }

  /**
   * AI-based planning for complex decisions
   */
  private static async aiBasedPlanning(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    allowedStepTypes: ApiAgentStepType[],
    suggestion?: {
      suggestedNextStep: ApiAgentPlannedStep | null;
      suggestedShouldStop?: boolean;
      suggestedStopReason?: ApiAgentStopReason;
      suggestedReasoning?: string;
    }
  ): Promise<{ decision: ApiAgentAIDecision; tokensUsed: number }> {
    const prompt = this.buildPlanningPrompt(request, state, policy, allowedStepTypes, suggestion);

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
          max_tokens: policy.level === 'light' ? 650 : 1000,
          response_format: { type: 'json_object' },
          model: 'gpt-4o-mini', // Cost-effective for planning
        }
      );

      const tokensUsed = response.usage?.totalTokens || 0;
      const parsed = JSON.parse(response.content);

      // Validate and build decision
      const decision = this.parseAIResponse(parsed, request, state, policy);

      // LIGHT guardrail: if deterministic suggestion says stop, do not allow AI to continue.
      // We still call AI to keep the loop AI-driven, but we enforce bounded LIGHT behavior.
      if (policy.level === 'light' && suggestion?.suggestedShouldStop === true) {
        return {
          decision: {
            nextStep: null,
            reasoning: `LIGHT level complete. AI reasoning: ${decision.reasoning}`.trim(),
            shouldStop: true,
            stopReason: suggestion.suggestedStopReason || 'completed',
            noveltyEstimate: decision.noveltyEstimate,
          },
          tokensUsed,
        };
      }

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
    allowedStepTypes: ApiAgentStepType[],
    suggestion?: {
      suggestedNextStep: ApiAgentPlannedStep | null;
      suggestedShouldStop?: boolean;
      suggestedStopReason?: ApiAgentStopReason;
      suggestedReasoning?: string;
    }
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

    const suggestedBlock = suggestion
      ? `\n## Suggested Next Step (deterministic hint)\n${JSON.stringify(
          {
            suggestedNextStep: suggestion.suggestedNextStep,
            suggestedShouldStop: suggestion.suggestedShouldStop,
            suggestedStopReason: suggestion.suggestedStopReason,
            suggestedReasoning: suggestion.suggestedReasoning,
          },
          null,
          2
        )}\n`
      : '';

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

## Expectation Model
${state.expectationModel ? JSON.stringify(state.expectationModel, null, 2) : 'none'}

## Allowed Step Types for ${policy.level}
${allowedStepTypes.join(', ')}
${suggestedBlock}

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
