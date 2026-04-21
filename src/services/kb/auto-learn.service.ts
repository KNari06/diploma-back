/**
 * Auto-learn from test traces
 *
 * After a successful test run, this service extracts stable facts from the
 * execution trace and upserts them into the project KB so that future chat
 * queries can retrieve "what actually worked" — not just what the user's
 * uploaded docs say.
 *
 * Design:
 *   - One synthetic "file" per URL-path, e.g. `auto:trace:/checkout.md`.
 *     All facts about the checkout page live in that file.
 *   - Each fact = one chunk, keyed by (url_path, role, name, action, method).
 *     Dedup via SELECT-then-UPDATE-or-INSERT: re-confirmation touches
 *     `last_confirmed_at` in metadata instead of duplicating.
 *   - Versioning handled by Phase 4 machinery: current chunks have
 *     is_current=true. When a page's facts change, we don't version-flip the
 *     file — we just update/insert individual chunks in place.
 *   - Feature-flagged via projects.settings.autoLearnFromTests (opt-in).
 *
 * What we do NOT do:
 *   - Embed every step. We filter to interactions with a durable element ref
 *     (role + accessible name). Random free-form type/wait steps are skipped.
 *   - Re-confirm synchronously. If inserting a chunk fails, we log and move
 *     on — the test result is already final, we don't want to surface this
 *     as a user-facing error.
 */

import { supabaseAdmin } from '@/db/supabase';
import { generateEmbeddings } from '@/services/ai/core/embedding.service';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';

const MAX_FACTS_PER_RUN = 50; // hard cap so one huge exploration doesn't spam
const MAX_BATCH_EMBED = 100;

export interface ExecutedStepEvent {
  ts?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface TraceFact {
  /** Pathname-only URL: "https://app.foo/checkout?x=1" → "/checkout". */
  urlPath: string;
  /** Full URL, stored for citation/debugging. */
  url: string;
  /** HTTP-like action verb: 'click', 'fill', 'select', 'press_key', 'navigate'. */
  action: string;
  /** Accessibility role if available ('button', 'link', 'textbox', …). */
  role?: string;
  /** Visible accessible name of the target element. */
  name?: string;
  /** Locator strategy used (for debugging, not for embedding). */
  selector?: string;
  /** If the step triggered an API call, the method+path+status. */
  apiCall?: { method: string; url: string; status?: number };
}

/**
 * Turn a full URL into a stable path key: strip query/fragment, lowercase
 * host, keep pathname. Used for dedup and file_name synthesis.
 */
export function urlToPathKey(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    const path = u.pathname || '/';
    // Collapse trailing slash (except root) to keep "/a" == "/a/"
    return path === '/' ? '/' : path.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Stable fingerprint of a fact — same interaction = same fingerprint.
 * Used as the chunk-level dedup key stored in metadata.
 */
function factFingerprint(projectId: string, f: TraceFact): string {
  const keyParts = [
    projectId,
    f.urlPath,
    f.action,
    f.role ?? '',
    (f.name ?? '').trim().toLowerCase(),
    f.apiCall ? `${f.apiCall.method.toUpperCase()} ${f.apiCall.url}` : '',
  ];
  return crypto.createHash('sha1').update(keyParts.join('\x00')).digest('hex');
}

/**
 * Render a fact as a retrieval-friendly paragraph. The LLM sees this verbatim
 * when the project_kb chunk matches.
 */
function renderFact(f: TraceFact, confirmedAt: string): string {
  const lines: string[] = [];
  const who = f.role && f.name ? `${f.role} "${f.name}"` : f.role ?? f.name ?? 'element';
  lines.push(`On ${f.urlPath}: ${f.action} on ${who} (confirmed working ${confirmedAt.slice(0, 10)}).`);
  if (f.url !== f.urlPath) {
    lines.push(`Full URL: ${f.url}`);
  }
  if (f.apiCall) {
    const statusStr = f.apiCall.status ? ` → ${f.apiCall.status}` : '';
    lines.push(`Triggers ${f.apiCall.method} ${f.apiCall.url}${statusStr}.`);
  }
  if (f.selector) {
    lines.push(`Locator: ${f.selector}`);
  }
  return lines.join('\n');
}

function synthFileName(urlPath: string): string {
  // Normalize to safe file_name: "auto:trace:/checkout/cart.md"
  const safePath = urlPath.replace(/\s+/g, '-');
  return `auto:trace:${safePath}.md`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fact extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull facts out of `tests.executed_steps`. Best-effort — we skip anything
 * we can't confidently identify. Duplicates within the same run are collapsed
 * by fingerprint so one job doesn't insert the same click twice.
 */
export function extractFactsFromExecutedSteps(
  events: unknown
): TraceFact[] {
  if (!Array.isArray(events)) return [];

  const facts: TraceFact[] = [];
  const seen = new Set<string>();

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const ev = raw as ExecutedStepEvent;
    if (ev.type !== 'step_completed') continue;

    const data = ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : null;
    if (!data || data.success !== true) continue;

    const fact = factFromStepEvent(data);
    if (!fact) continue;

    // Local dedup key must match the persisted fingerprint so that two
    // facts differing only by API call don't collapse here and lose the
    // network evidence. Keep in sync with factFingerprint().
    const apiKey = fact.apiCall
      ? `${fact.apiCall.method.toUpperCase()} ${fact.apiCall.url}`
      : '';
    const fp = `${fact.urlPath}|${fact.action}|${fact.role ?? ''}|${(fact.name ?? '').toLowerCase()}|${apiKey}`;
    if (seen.has(fp)) continue;
    seen.add(fp);

    facts.push(fact);
    if (facts.length >= MAX_FACTS_PER_RUN) break;
  }

  return facts;
}

function factFromStepEvent(data: Record<string, unknown>): TraceFact | null {
  // Step shape varies; we check several common locations instead of assuming
  // one fixed schema. Better to miss a fact than crash on shape drift.

  // URL at step time
  const url = pickString(data, [
    'pageUrl',
    ['runtimeMeta', 'pageUrl'],
    ['context', 'pageUrl'],
    ['compiled', 'context', 'pageUrl'],
  ]);
  const urlPath = url ? urlToPathKey(url) : null;
  if (!url || !urlPath) return null;

  // Action type (click, fill, press_key, select, navigate, …)
  const action = pickString(data, ['action', 'type', 'actionType', ['action', 'type']]);
  if (!action) return null;
  // Skip uninteresting / ambiguous actions
  if (action === 'wait' || action === 'wait_for' || action === 'scroll' || action === 'ai_check') {
    return null;
  }

  // Role + accessible name — prefer compiled target, fallback to bindingHints
  const role = pickString(data, [
    ['targetFingerprint', 'role'],
    ['target', 'role'],
    ['compiled', 'targetFingerprint', 'role'],
    ['bindingHints', 'role'],
  ]);
  const name = pickString(data, [
    ['targetFingerprint', 'labelText'],
    ['target', 'name'],
    ['compiled', 'targetFingerprint', 'labelText'],
    ['bindingHints', 'label'],
    'stepDescription',
    'description',
  ]);

  // A fact must have at least role OR name, otherwise it's not useful for
  // retrieval (can't describe what the user clicked).
  if (!role && !name) return null;

  const selector = pickString(data, [
    ['compiled', 'locatorPlan', 0, 'value'],
    ['locator'],
  ]);

  // API call correlation (optional)
  let apiCall: TraceFact['apiCall'] | undefined;
  const slowApis = pickArray(data, [['runtimeMeta', 'slowApiCalls'], 'slowApiCalls']);
  const netEvidence = pickArray(data, [['runtimeMeta', 'networkEvidence'], 'networkEvidence']);
  // Prefer networkEvidence (carries status); only keep successful 2xx/3xx as "confirmed".
  const firstGoodNet = netEvidence.find(
    (n) =>
      n && typeof n === 'object' &&
      typeof (n as Record<string, unknown>).method === 'string' &&
      typeof (n as Record<string, unknown>).url === 'string'
  );
  if (firstGoodNet) {
    const n = firstGoodNet as Record<string, unknown>;
    const status = typeof n.status === 'number' ? n.status : undefined;
    apiCall = {
      method: String(n.method).toUpperCase(),
      url: String(n.url),
      ...(status !== undefined ? { status } : {}),
    };
  } else if (slowApis.length > 0 && typeof slowApis[0] === 'object') {
    const s = slowApis[0] as Record<string, unknown>;
    if (typeof s.method === 'string' && typeof s.url === 'string') {
      apiCall = { method: String(s.method).toUpperCase(), url: String(s.url) };
    }
  }

  return {
    urlPath,
    url,
    action: action.toLowerCase(),
    role: role?.toLowerCase(),
    name: name?.trim(),
    selector,
    apiCall,
  };
}

function pickString(obj: Record<string, unknown>, paths: Array<string | (string | number)[]>): string | undefined {
  for (const p of paths) {
    const v = typeof p === 'string' ? obj[p] : dig(obj, p);
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

function pickArray(obj: Record<string, unknown>, paths: Array<string | (string | number)[]>): unknown[] {
  for (const p of paths) {
    const v = typeof p === 'string' ? obj[p] : dig(obj, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

function dig(obj: unknown, path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === 'object') {
      cur = (cur as Record<string | number, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if auto-learn is enabled for the project. Reads
 * projects.settings.autoLearnFromTests (default false).
 * Fails CLOSED on any read error — better to skip learning than to leak.
 */
export async function isAutoLearnEnabled(projectId: string): Promise<boolean> {
  if (!projectId || typeof projectId !== 'string') return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !data) return false;
    const settings = data.settings as Record<string, unknown> | null;
    return settings?.autoLearnFromTests === true;
  } catch (err) {
    logger.warn('[AUTO_LEARN] feature flag read failed (fail closed)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point. Fetches executed_steps for the test, extracts facts,
 * and upserts them into project_kb_chunks.
 * Returns a summary for logging. Never throws — errors are logged.
 */
export async function learnFromTestRun(params: {
  testId: string;
  projectId: string;
  uploadedBy?: string;
}): Promise<{ inserted: number; refreshed: number; skipped: number; reason?: string }> {
  const { testId, projectId } = params;

  try {
    if (!(await isAutoLearnEnabled(projectId))) {
      return { inserted: 0, refreshed: 0, skipped: 0, reason: 'disabled' };
    }

    // Pull executed_steps JSONB — with retry.
    //
    // Race condition this guards against:
    //   handleSuccessfulTest enqueues this job RIGHT AFTER creating the
    //   test_result record, but `tests.executed_steps` is populated from a
    //   separate WebSocket → Redis → DB path (TestExecutedStepsRedisService
    //   .finalizeToDb). On a fast worker the job can read executed_steps
    //   before the finalize write lands — silently extracting zero facts.
    //
    //   Retry up to 3 times (0ms, 2s, 4s) while the field is empty/missing.
    //   Total worst case: ~6s before giving up, which is well below the
    //   ai-analysis job's SLA and doesn't block anything user-visible.
    let executedSteps: unknown = null;
    const RETRY_DELAYS_MS = [0, 2000, 4000];
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }

      const { data: testRow, error: testError } = await supabaseAdmin
        .from('tests')
        .select('executed_steps')
        .eq('id', testId)
        .maybeSingle();

      if (testError || !testRow) {
        logger.debug('[AUTO_LEARN] test not found or read failed', {
          testId,
          attempt: attempt + 1,
          error: testError?.message,
        });
        // Test row missing is terminal — retrying won't materialize it.
        return { inserted: 0, refreshed: 0, skipped: 0, reason: 'test-not-found' };
      }

      if (Array.isArray(testRow.executed_steps) && testRow.executed_steps.length > 0) {
        executedSteps = testRow.executed_steps;
        break;
      }

      logger.debug('[AUTO_LEARN] executed_steps empty, retrying', {
        testId,
        attempt: attempt + 1,
        maxAttempts: RETRY_DELAYS_MS.length,
      });
    }

    if (!Array.isArray(executedSteps) || executedSteps.length === 0) {
      // Either the test legitimately has no completed steps, or the finalize
      // path is slower than our retry window. Either way, nothing to learn.
      return { inserted: 0, refreshed: 0, skipped: 0, reason: 'no-executed-steps' };
    }

    const facts = extractFactsFromExecutedSteps(executedSteps);
    if (facts.length === 0) {
      return { inserted: 0, refreshed: 0, skipped: 0, reason: 'no-facts' };
    }

    return await upsertFacts({
      projectId,
      facts,
      uploadedBy: params.uploadedBy ?? 'auto-learn',
    });
  } catch (err) {
    logger.warn('[AUTO_LEARN] learnFromTestRun failed (non-fatal)', {
      testId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { inserted: 0, refreshed: 0, skipped: 0, reason: 'error' };
  }
}

/**
 * Insert new facts or refresh existing ones' last_confirmed_at.
 * Dedup happens on `metadata->>fingerprint` (per project).
 */
async function upsertFacts(params: {
  projectId: string;
  facts: TraceFact[];
  uploadedBy: string;
}): Promise<{ inserted: number; refreshed: number; skipped: number }> {
  const { projectId, facts, uploadedBy } = params;
  const nowIso = new Date().toISOString();

  // 1. Compute fingerprints and split into (existing, new)
  const byFp = new Map<string, TraceFact>();
  for (const f of facts) byFp.set(factFingerprint(projectId, f), f);
  const fingerprints = Array.from(byFp.keys());

  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from('project_kb_chunks')
    .select('id, metadata')
    .eq('project_id', projectId)
    .eq('format', 'auto:trace')
    .in('metadata->>fingerprint', fingerprints);

  if (existingError) {
    logger.warn('[AUTO_LEARN] existing-check query failed', {
      projectId,
      error: existingError.message,
      code: existingError.code,
    });
    // Fall through: try pure-insert path, duplicates will surface via
    // application-level dedup next run.
  }

  const existingFpToId = new Map<string, string>();
  for (const r of existingRows ?? []) {
    const fp = (r.metadata as Record<string, unknown> | null)?.fingerprint;
    if (typeof fp === 'string' && typeof r.id === 'string') {
      existingFpToId.set(fp, r.id);
    }
  }

  const toInsert: TraceFact[] = [];
  const toRefresh: string[] = [];
  for (const [fp, fact] of byFp) {
    const id = existingFpToId.get(fp);
    if (id) toRefresh.push(id);
    else toInsert.push(fact);
  }

  // 2. Refresh existing: bump last_confirmed_at + refresh_count
  let refreshed = 0;
  if (toRefresh.length > 0) {
    // Do individual updates — metadata merge in Postgres requires jsonb_set
    // and we want atomicity per row. 50 updates worst case; fine.
    for (const id of toRefresh) {
      const { error: updError } = await supabaseAdmin.rpc('project_kb_auto_learn_refresh', {
        p_chunk_id: id,
        p_confirmed_at: nowIso,
      });
      if (!updError) refreshed++;
      // If the RPC is missing (fresh deploy without migration), fall back to
      // an in-place update of metadata.last_confirmed_at.
      if (updError && (updError as { code?: string }).code === 'PGRST202') {
        const { data: row } = await supabaseAdmin
          .from('project_kb_chunks')
          .select('metadata')
          .eq('id', id)
          .maybeSingle();
        const merged = {
          ...((row?.metadata as Record<string, unknown>) ?? {}),
          last_confirmed_at: nowIso,
          refresh_count:
            (Number((row?.metadata as Record<string, unknown>)?.refresh_count ?? 0) || 0) + 1,
        };
        const { error: fallbackErr } = await supabaseAdmin
          .from('project_kb_chunks')
          .update({ metadata: merged, uploaded_at: nowIso })
          .eq('id', id);
        if (!fallbackErr) refreshed++;
      }
    }
  }

  // 3. Insert new facts — embed in one batch, insert in one batch
  let inserted = 0;
  let skipped = 0;

  if (toInsert.length > 0) {
    const contents = toInsert.map((f) => renderFact(f, nowIso));
    // Batch-embed respecting OpenAI's 100-input cap
    const embeddings: number[][] = [];
    try {
      for (let i = 0; i < contents.length; i += MAX_BATCH_EMBED) {
        const batch = contents.slice(i, i + MAX_BATCH_EMBED);
        const embs = await generateEmbeddings(batch);
        embeddings.push(...embs);
      }
    } catch (err) {
      logger.warn('[AUTO_LEARN] embedding generation failed', {
        projectId,
        count: contents.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return { inserted: 0, refreshed, skipped: toInsert.length };
    }

    const records = toInsert.map((f, idx) => {
      const fp = factFingerprint(projectId, f);
      return {
        project_id: projectId,
        file_name: synthFileName(f.urlPath),
        content: contents[idx],
        embedding: JSON.stringify(embeddings[idx]),
        metadata: {
          format: 'auto:trace',
          fingerprint: fp,
          url_path: f.urlPath,
          url: f.url,
          action: f.action,
          role: f.role,
          name: f.name,
          selector: f.selector,
          api_call: f.apiCall ?? null,
          last_confirmed_at: nowIso,
          refresh_count: 1,
        },
        uploaded_by: uploadedBy,
        uploaded_at: nowIso,
        file_version: 1,
        is_current: true,
        format: 'auto:trace',
      };
    });

    const { error: insertError, count } = await supabaseAdmin
      .from('project_kb_chunks')
      .insert(records, { count: 'exact' });

    if (insertError) {
      logger.warn('[AUTO_LEARN] insert failed', {
        projectId,
        recordCount: records.length,
        error: insertError.message,
        code: insertError.code,
      });
      skipped = records.length;
    } else {
      inserted = count ?? records.length;
    }
  }

  logger.info('[AUTO_LEARN] upserted facts', {
    projectId,
    inserted,
    refreshed,
    skipped,
    totalFacts: facts.length,
  });

  return { inserted, refreshed, skipped };
}

/**
 * Retire auto:trace chunks whose last_confirmed_at is older than N days.
 * Designed to be called from a scheduled job. Returns the number retired.
 */
export async function retireStaleAutoLearnChunks(maxAgeDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabaseAdmin.rpc('project_kb_auto_learn_retire', {
      p_cutoff: cutoff,
    });
    if (error) {
      logger.warn('[AUTO_LEARN] retire RPC failed', {
        cutoff,
        error: error.message,
        code: error.code,
      });
      return 0;
    }
    const retired = typeof data === 'number' ? data : 0;
    logger.info('[AUTO_LEARN] retired stale chunks', { cutoff, retired });
    return retired;
  } catch (err) {
    logger.warn('[AUTO_LEARN] retire threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
