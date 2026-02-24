/**
 * API Agent Expectation Service
 * Builds a normalized expectation model from expectedBehavior (JSON-first, 1 AI fallback).
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { ApiAgentExpectationModel, ApiAgentRequest } from './api-agent.types';

export type ExpectationBuildSource = 'none' | 'json' | 'ai' | 'heuristic';

export interface BuildExpectationResult {
  model: ApiAgentExpectationModel | null;
  tokensUsed: number;
  source: ExpectationBuildSource;
}

function uniqUpper(arr: string[] | undefined): string[] | undefined {
  if (!arr) return undefined;
  const out = Array.from(new Set(arr.map((m) => String(m).toUpperCase().trim()).filter(Boolean)));
  return out.length > 0 ? out : undefined;
}

function uniqStrings(arr: unknown): string[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const out = Array.from(new Set(arr.map((x) => String(x).trim()).filter(Boolean)));
  return out.length > 0 ? out : undefined;
}

function normalizeFromJson(obj: any, request: ApiAgentRequest): ApiAgentExpectationModel {
  const responseTypeRaw = obj?.type ?? obj?.responseType ?? obj?.response_type;
  const responseType =
    responseTypeRaw === 'list' || responseTypeRaw === 'array'
      ? 'list'
      : responseTypeRaw === 'object'
        ? 'object'
        : responseTypeRaw === 'primitive'
          ? 'primitive'
          : responseTypeRaw
            ? 'unknown'
            : undefined;

  return {
    responseType,
    entity: obj?.entity ? String(obj.entity) : undefined,
    allowedMethods: uniqUpper(obj?.allowedMethods ?? obj?.allowed_methods) ?? [request.method.toUpperCase()],
    requiredFields: uniqStrings(obj?.requiredFields ?? obj?.required_fields),
    invariants: uniqStrings(obj?.invariants),
  };
}

function heuristicFromText(text: string, request: ApiAgentRequest): ApiAgentExpectationModel {
  const lower = text.toLowerCase();
  const responseType =
    lower.includes('list') || lower.includes('спис') || lower.includes('array')
      ? 'list'
      : lower.includes('object') || lower.includes('объект')
        ? 'object'
        : undefined;

  return {
    responseType,
    allowedMethods: [request.method.toUpperCase()],
  };
}

export class ApiAgentExpectationService {
  static async buildExpectationModel(
    request: ApiAgentRequest,
    opts?: { maxTokens?: number }
  ): Promise<BuildExpectationResult> {
    const raw = request.expectedBehavior;
    if (!raw || String(raw).trim().length === 0) {
      return { model: null, tokensUsed: 0, source: 'none' };
    }

    const text = String(raw).trim();

    // JSON-first
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { model: normalizeFromJson(parsed, request), tokensUsed: 0, source: 'json' };
      }
    } catch {
      // continue to AI
    }

    // Heuristic baseline (for resilience even if AI fails)
    const heuristic = heuristicFromText(text, request);

    // Cost guard: if heuristics already give a usable shape, skip AI normalization.
    // This keeps LIGHT runs cheap for common "return list/object" expectations.
    if (heuristic.responseType) {
      return { model: heuristic, tokensUsed: 0, source: 'heuristic' };
    }

    // 1 AI fallback to normalize free-text into a compact model
    try {
      const resp = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content:
              'You convert user expectation text into a strict JSON expectation model for API testing. Return only valid JSON.',
          },
          {
            role: 'user',
            content: `ExpectedBehavior:\n${text}\n\nReturn JSON with fields:\n{\n  "responseType": "list|object|primitive|unknown",\n  "entity": "optional string",\n  "allowedMethods": ["GET", ...],\n  "requiredFields": ["id", ...],\n  "invariants": ["non_empty_list","unique_id","pagination_stable", ...]\n}\n\nNotes:\n- allowedMethods should default to ["${request.method.toUpperCase()}"] if unclear.\n- If user expects a list, consider adding invariant "non_empty_list" only if explicitly stated.\n`,
          },
        ],
        {
          temperature: 0.2,
          // LIGHT constraint: keep interpretation cheap
          max_tokens: opts?.maxTokens ?? 350,
          response_format: { type: 'json_object' },
          model: AI_TASK_MODELS.apiExpectation,
        }
      );

      const tokensUsed = resp.usage?.totalTokens || 0;
      const parsed = JSON.parse(resp.content);
      const model = normalizeFromJson(parsed, request);

      return { model: { ...heuristic, ...model }, tokensUsed, source: 'ai' };
    } catch (error) {
      logger.warn('[API_AGENT_EXPECTATION] Failed to build expectation model via AI, using heuristic', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { model: heuristic, tokensUsed: 0, source: 'heuristic' };
    }
  }
}

