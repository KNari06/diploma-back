/**
 * Trace Analysis Util
 *
 * Pure aggregation of editor / preview-run JSONL events into a flat
 * summary suitable for:
 *   1. Inline emission as a `trace_summary` event at writer-close time
 *      (this is what `EditorTraceService.close()` writes into JSONL so
 *      operators can `jq 'select(.eventType=="trace_summary")' file.jsonl`
 *      without external tooling).
 *   2. Post-hoc upload-time recompute inside `editor-trace-upload.ts`
 *      when the close-time event is missing (process crash, force-kill,
 *      writer dropped) — recompute keeps `trace_files.parsed_data` honest
 *      regardless of how the file got there.
 *
 * Two consumption modes share ONE algorithm so the numbers can never
 * drift between local jq inspection and prod Supabase queries.
 *
 * Surface explained per field — when adding a new aggregate, add the
 * comment so reviewers know what question it answers.
 */

/**
 * Numeric surface. All counts; all percentile fields nullable so dashboards
 * can hide the row when the bucket is empty (prevents misleading 0s).
 *
 * Shape is intentionally flat (no nested {by_kind: {…}}) — Supabase JSONB
 * path queries like `parsed_data->'modalDetectionMisses'` stay one-hop.
 */
export interface TraceSummary {
  // ── Legacy counts (kept stable for back-compat) ─────────────────────────
  /** Events tagged with stage='error' or eventType='error'. */
  errors: number;
  /** step_result events with payload.status='fail' (run loop). */
  failedSteps: number;
  /** Distinct step_result events; overridden by run_end.totalSteps when present. */
  totalSteps: number;
  /** Every non-empty JSONL line, including malformed ones we couldn't parse. */
  totalEvents: number;

  // ── Resolver health (NEW — see editor-trace-upload comments for rationale) ─
  /**
   * step_apply_result.resolverPath frequency. Tells us how often each
   * fallback stage actually fired — % `llm` vs % `identity_id` is the
   * "did compiled-plan even help" signal.
   */
  resolverPathCounts: Record<string, number>;
  /**
   * LLM-resolve confidence histogram (4 buckets). Mid-band concentration
   * (lt75 + lt85) signals Stage 3 ambiguity that honesty-guard would
   * target. Excludes non-LLM resolves so the denominator is meaningful.
   */
  confidenceBuckets: { lt55: number; lt75: number; lt85: number; ge85: number };
  /**
   * fingerprintMatch outcome distribution (exact / partial / none /
   * no_recorded). 'none' rate on a project with mostly fresh recordings
   * reveals fingerprint-vs-snapshot symmetry bugs across the runtime.
   */
  fingerprintMatchCounts: Record<string, number>;
  /**
   * Bug-D detector: snapshot has at least one node with
   * isInsideActiveModal=true BUT every modal.* rule reported count=0
   * for the same resolve. Pure cross-reference of the two halves of
   * the same element_resolution payload — no extra source needed.
   */
  modalDetectionMisses: number;
  /**
   * Bug-A detector (lower-bound): LLM picked a candidate whose label
   * shows zero substring overlap with the step description. Case-
   * insensitive substring is intentionally lax — we under-count
   * rather than over-count.
   */
  llmBugAOccurrences: number;
  /** Number of element_resolution events with a numeric latencyMs. */
  resolveCount: number;
  /** P50 of element_resolution.latencyMs (or null when no resolves). */
  latencyP50Ms: number | null;
  /** P95 of element_resolution.latencyMs (or null when no resolves). */
  latencyP95Ms: number | null;
}

/**
 * Stateful aggregator. Feed events as they come in (no JSONL re-read),
 * call `finalize()` once at the end. Designed so a long-running
 * preview session pays O(1) memory regardless of event volume — only
 * the latency array grows linearly with resolves.
 *
 * Used by EditorTraceService at write-time, and by editor-trace-upload
 * as a fallback that re-feeds parsed JSONL lines.
 */
export class TraceSummaryAggregator {
  private errors = 0;
  private failedSteps = 0;
  private totalSteps = 0;
  private totalEvents = 0;
  private resolverPathCounts: Record<string, number> = Object.create(null);
  private confidenceBuckets = { lt55: 0, lt75: 0, lt85: 0, ge85: 0 };
  private fingerprintMatchCounts: Record<string, number> = Object.create(null);
  private modalDetectionMisses = 0;
  private llmBugAOccurrences = 0;
  private resolveLatencies: number[] = [];

  /**
   * Consume a single parsed JSONL event. Safe to call with any shape —
   * unknown event types are counted toward totalEvents only.
   *
   * `evt` is `unknown` because both call sites parse from JSON; we don't
   * want every caller to maintain a TraceEvent type that drifts from
   * what writers actually emit.
   */
  consume(evt: unknown): void {
    if (!evt || typeof evt !== 'object') return;
    this.totalEvents++;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = evt as any;
    const evtType = e.eventType;
    const payload = e.payload ?? {};

    if (e.stage === 'error' || evtType === 'error') {
      this.errors++;
    }

    if (evtType === 'step_result') {
      this.totalSteps++;
      if (payload.status === 'fail') this.failedSteps++;
    }
    if (evtType === 'run_error_summary') {
      this.errors = Math.max(this.errors, payload.totalErrors ?? 0);
    }
    if (evtType === 'run_end') {
      if (payload.totalSteps) this.totalSteps = payload.totalSteps;
      if (payload.failedSteps) this.failedSteps = payload.failedSteps;
    }

    if (evtType === 'step_apply_result') {
      const path = typeof payload.resolverPath === 'string'
        ? payload.resolverPath : 'other';
      this.resolverPathCounts[path] = (this.resolverPathCounts[path] ?? 0) + 1;

      const fp = typeof payload.fingerprintMatch === 'string'
        ? payload.fingerprintMatch : 'no_recorded';
      this.fingerprintMatchCounts[fp] = (this.fingerprintMatchCounts[fp] ?? 0) + 1;
    }

    if (evtType === 'element_resolution') {
      if (typeof payload.latencyMs === 'number') {
        this.resolveLatencies.push(payload.latencyMs);
      }

      const chosen = payload.result?.chosen;
      const confidence = chosen?.confidence;
      const hasLlm = !!payload.llm;
      if (hasLlm && typeof confidence === 'number') {
        if (confidence < 0.55) this.confidenceBuckets.lt55++;
        else if (confidence < 0.75) this.confidenceBuckets.lt75++;
        else if (confidence < 0.85) this.confidenceBuckets.lt85++;
        else this.confidenceBuckets.ge85++;
      }

      // Bug-D detector (see TraceSummary.modalDetectionMisses comment).
      const rules = Array.isArray(payload.rules) ? payload.rules : [];
      const modalRuleHit = rules.some((r: { ruleId?: string; count?: number }) =>
        (r.ruleId === 'modal.detected' || r.ruleId === 'modal.detected_via_snapshot')
        && (r.count ?? 0) > 0
      );
      const domSnapshot = Array.isArray(payload.domSnapshot) ? payload.domSnapshot : [];
      const hasModalNodes = domSnapshot.some(
        (n: { isInsideActiveModal?: boolean }) => n.isInsideActiveModal === true,
      );
      if (hasModalNodes && !modalRuleHit) {
        this.modalDetectionMisses++;
      }

      // Bug-A detector (see TraceSummary.llmBugAOccurrences comment).
      if (hasLlm && chosen?.ref && chosen.ref !== 'null') {
        const intentRaw = typeof payload.description === 'string'
          ? payload.description : '';
        const labelRaw = typeof chosen.label === 'string'
          ? chosen.label : '';
        const intent = intentRaw.toLowerCase().trim();
        const label = labelRaw.toLowerCase().trim();
        const intentHasText = intent.length >= 3;
        const labelMissesIntent = intentHasText
          && label.length > 0
          && !label.includes(intent)
          && !intent.includes(label);
        const labelIsEmpty = intentHasText && label.length === 0;
        if (labelMissesIntent || labelIsEmpty) {
          this.llmBugAOccurrences++;
        }
      }
    }
  }

  /**
   * Compute the final summary. Safe to call multiple times — no
   * mutation of accumulator state, so a writer can emit `trace_summary`
   * and the upload pipeline can still re-aggregate from the same JSONL.
   */
  finalize(): TraceSummary {
    const sorted = this.resolveLatencies.slice().sort((a, b) => a - b);
    return {
      errors: this.errors,
      failedSteps: this.failedSteps,
      totalSteps: this.totalSteps,
      totalEvents: this.totalEvents,
      resolverPathCounts: { ...this.resolverPathCounts },
      confidenceBuckets: { ...this.confidenceBuckets },
      fingerprintMatchCounts: { ...this.fingerprintMatchCounts },
      modalDetectionMisses: this.modalDetectionMisses,
      llmBugAOccurrences: this.llmBugAOccurrences,
      resolveCount: this.resolveLatencies.length,
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
    };
  }
}

/** Internal helper — null when array empty so dashboards can hide row. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

/**
 * Convenience: aggregate a whole JSONL string in one call. Used by the
 * upload pipeline (recompute branch) where we already have the file
 * contents in memory. Not used at write-time (the aggregator is fed
 * event-by-event there).
 */
export function aggregateJsonl(raw: string): TraceSummary {
  const agg = new TraceSummaryAggregator();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      agg.consume(JSON.parse(line));
    } catch {
      // Malformed line — still counted via totalEvents++ inside consume()
      // ONLY when it parsed. Increment manually to keep parity with
      // legacy behaviour where unparseable lines bumped totalEvents.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (agg as any).totalEvents = ((agg as any).totalEvents ?? 0) + 1;
    }
  }
  return agg.finalize();
}
