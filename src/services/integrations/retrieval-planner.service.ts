/**
 * RetrievalPlannerService — query-driven RAG planning (Phase 1).
 *
 * One cheap LLM call turns a task into WHAT to search for (terms/entities/
 * hypotheses); the orchestrator then runs its existing searches with an enriched
 * query. NOT a tool-using loop — the model plans once, the code retrieves.
 * Never throws: on any failure returns an empty plan so the caller falls back
 * to the raw ticket text (no regression).
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { buildQueryPlanMessages, type QueryPlanInput } from '@/ai/prompts/query-planner.prompts';
import { logger } from '@/utils/core/logger';

export interface RetrievalPlan {
  searchTerms: string[];
  entities: string[];
  hypotheses: string[];
}

const EMPTY_PLAN: RetrievalPlan = { searchTerms: [], entities: [], hypotheses: [] };
const MAX_TERMS = 8;
const MAX_ENTITIES = 8;
const MAX_HYPOTHESES = 4;

export class RetrievalPlannerService {
  /** Plan retrieval terms for a task. Never throws — empty plan on failure. */
  static async plan(input: QueryPlanInput): Promise<RetrievalPlan> {
    try {
      const { system, user } = buildQueryPlanMessages(input);
      const completion = await getChatCompletionWithMessages(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { model: AI_MODELS.fast, temperature: 0.1, max_tokens: 400, response_format: { type: 'json_object' } },
      );
      return this.sanitize(completion.content);
    } catch (err) {
      logger.warn('[RETRIEVAL_PLANNER] plan failed (non-fatal, using raw query)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return EMPTY_PLAN;
    }
  }

  /** Parse + clamp the LLM output into a safe RetrievalPlan. */
  static sanitize(raw: string | undefined): RetrievalPlan {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      return EMPTY_PLAN;
    }
    return {
      searchTerms: this.cleanList(obj.searchTerms, MAX_TERMS),
      entities: this.cleanList(obj.entities, MAX_ENTITIES),
      hypotheses: this.cleanList(obj.hypotheses, MAX_HYPOTHESES),
    };
  }

  /**
   * Combine the raw ticket query with the planned terms/entities into one
   * enriched search string. Deduped, bounded. Returns the raw query unchanged
   * when the plan is empty.
   */
  static enrichQuery(rawQuery: string, plan: RetrievalPlan): string {
    const extra = [...plan.searchTerms, ...plan.entities];
    if (extra.length === 0) return rawQuery;
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const p of [rawQuery, ...extra]) {
      const t = p.trim();
      const key = t.toLowerCase();
      if (!t || seen.has(key)) continue;
      seen.add(key);
      parts.push(t);
    }
    return parts.join(' — ').slice(0, 1200);
  }

  private static cleanList(v: unknown, cap: number): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of v) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t || t.length > 120) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= cap) break;
    }
    return out;
  }
}
