/**
 * Data access for `exploration_product_briefs` — the reusable Phase 0 brief.
 *
 * Queries + row mapping only, no business logic (see .claude/rules/architecture.md).
 * The reuse decision (is this brief still fresh?) lives in the service.
 */

import { supabaseAdmin } from '@/db/supabase';
import type { ProductBrief } from '@/agent/core/lite/exploration/phase0/product-brief.types';

/** Natural key: one brief per product per project. */
export interface ProductBriefKey {
  projectId: string;
  /** Scheme + host + port, no path — a brief describes the product, not a page. */
  origin: string;
}

/** A stored brief row, mapped to camelCase. */
export interface ProductBriefRow extends ProductBriefKey {
  id: string;
  briefVersion: number;
  evidenceFingerprint: string | null;
  brief: ProductBrief;
  userAnswers: Array<{ key: string; answer: string | null }>;
  reuseCount: number;
  lastExplorationId: string | null;
  updatedAt: string;
}

export interface ProductBriefUpsert extends ProductBriefKey {
  briefVersion: number;
  evidenceFingerprint: string | null;
  brief: ProductBrief;
  userAnswers: Array<{ key: string; answer: string | null }>;
  lastExplorationId?: string;
}

function mapRow(row: Record<string, unknown>): ProductBriefRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    origin: String(row.origin),
    briefVersion: Number(row.brief_version ?? 0),
    evidenceFingerprint: (row.evidence_fingerprint as string | null) ?? null,
    brief: row.brief as ProductBrief,
    userAnswers: Array.isArray(row.user_answers)
      ? (row.user_answers as Array<{ key: string; answer: string | null }>)
      : [],
    reuseCount: Number(row.reuse_count ?? 0),
    lastExplorationId: (row.last_exploration_id as string | null) ?? null,
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** Load the stored brief for one origin in one project, or null if none yet. */
export async function fetchProductBrief(key: ProductBriefKey): Promise<ProductBriefRow | null> {
  const { data, error } = await supabaseAdmin
    .from('exploration_product_briefs')
    .select('*')
    .eq('project_id', key.projectId)
    .eq('origin', key.origin)
    .maybeSingle();

  if (error) throw error;
  return data ? mapRow(data as Record<string, unknown>) : null;
}

/**
 * Upsert on the natural key. `first_seen_at` is set on insert (DB default) and
 * preserved on update; `updated_at` is bumped on every write.
 */
export async function upsertProductBrief(row: ProductBriefUpsert): Promise<void> {
  const { error } = await supabaseAdmin
    .from('exploration_product_briefs')
    .upsert(
      {
        project_id: row.projectId,
        origin: row.origin,
        brief_version: row.briefVersion,
        evidence_fingerprint: row.evidenceFingerprint,
        brief: row.brief,
        user_answers: row.userAnswers,
        last_exploration_id: row.lastExplorationId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,origin' },
    );

  if (error) throw error;
}

/**
 * Count one reuse of a stored brief.
 *
 * Deliberately does NOT touch `updated_at`: that column means "when the brief
 * last changed", and bumping it on a read would make an unchanged brief look
 * freshly derived in every operational query.
 *
 * The count is passed in rather than incremented in SQL — the caller already
 * holds the row it just read, and a concurrent-run race here costs an
 * undercounted analytics number, not a wrong brief. Mirrors how
 * `app-skeleton.db` writes `run_count` (computed in the service, plain write)
 * instead of introducing an RPC for one counter.
 */
export async function recordProductBriefReuse(
  id: string,
  reuseCount: number,
  explorationId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('exploration_product_briefs')
    .update({ reuse_count: reuseCount, last_exploration_id: explorationId })
    .eq('id', id);

  if (error) throw error;
}
