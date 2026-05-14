/**
 * Admin endpoint — Phase 2 telemetry aggregates for mobile regressions.
 *
 * Single-call surface for "is Phase 5 (scenario cache) worth building?".
 * The four sections answer the four questions in
 * `docs/mobile-test-orchestration-plan.md` Phase 5 audit:
 *
 *   1. wallclockBreakdown — where time actually goes (app setup vs
 *      scenario re-play vs test body vs overhead)
 *   2. durationByBucket   — distribution of regression sizes (are
 *      "50-test runs" actually a thing, or is the 90% case 1-5 tests?)
 *   3. scenarioReplayLoad — how often the same scenario plays inside
 *      one run (proxy for Phase 5 hit-rate ceiling)
 *   4. coldStartVsScenario — which dominates: cold-start tail (Phase 7)
 *      or scenario re-play (Phase 5)
 *
 * Read-only. No mutations. Best-effort: a failing section returns null,
 * other sections still respond — so a transient SQL error doesn't black-
 * hole the whole admin view.
 *
 * Auth: requireAuth + requireAdmin (added at the route layer).
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { Request, Response } from 'express';

const TAG = '[ADMIN_REGRESSION_METRICS]';

// Window clamp: shorter than 1d gives spiky stats; longer than 30d
// is mostly pre-Phase-2 NULLs and doesn't add information.
const MIN_DAYS = 1;
const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;

interface WallclockBreakdown {
  totalRuns: number;
  avgDurationSec: number | null;
  avgAppSetupSec: number | null;
  avgScenarioSec: number | null;
  avgTestBodySec: number | null;
  avgOverheadSec: number | null;
  scenarioShareOfDuration: number | null;
  appSetupShareOfDuration: number | null;
}

interface DurationBucket {
  bucket: '1-5' | '6-20' | '21-50' | '50+';
  runs: number;
  p50Sec: number | null;
  p95Sec: number | null;
  p99Sec: number | null;
}

interface ScenarioReplayLoad {
  runsWithScenarios: number;
  avgTestsWithScenarioPerRun: number | null;
  avgScenarioPerTestMs: number | null;
  worstScenarioPerTestMs: number | null;
}

interface ColdStartVsScenario {
  totalRuns: number;
  avgColdStartsPerRun: number | null;
  avgScenarioSec: number | null;
  estimatedColdStartCostSec: number | null;
  verdict:
    | 'scenario_dominates'
    | 'cold_start_dominates'
    | 'roughly_equal'
    | 'insufficient_data';
}

interface MetricsResponse {
  windowDays: number;
  rangeFrom: string;
  rangeTo: string;
  wallclockBreakdown: WallclockBreakdown | null;
  durationByBucket: DurationBucket[] | null;
  scenarioReplayLoad: ScenarioReplayLoad | null;
  coldStartVsScenario: ColdStartVsScenario | null;
  warnings: string[];
}

/**
 * GET /api/v1/admin/regression-metrics?days=7
 *
 * Aggregates Phase 2 telemetry over the last N days (default 7, max 30).
 * Mobile-only — regressions without Phase 2 telemetry (NULL columns)
 * are excluded from every section.
 */
export const getRegressionMetrics = async (req: Request, res: Response): Promise<void> => {
  const daysRaw = parseInt((req.query.days as string) || '', 10);
  const days = Number.isFinite(daysRaw)
    ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, daysRaw))
    : DEFAULT_DAYS;

  const rangeTo = new Date();
  const rangeFrom = new Date(rangeTo.getTime() - days * 86_400_000);
  const warnings: string[] = [];

  const [wallclockBreakdown, durationByBucket, scenarioReplayLoad, coldStartVsScenario] = await Promise.all([
    safeSection('wallclockBreakdown', () => computeWallclockBreakdown(rangeFrom), warnings),
    safeSection('durationByBucket', () => computeDurationByBucket(rangeFrom), warnings),
    safeSection('scenarioReplayLoad', () => computeScenarioReplayLoad(rangeFrom), warnings),
    safeSection('coldStartVsScenario', () => computeColdStartVsScenario(rangeFrom), warnings),
  ]);

  const response: MetricsResponse = {
    windowDays: days,
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    wallclockBreakdown,
    durationByBucket,
    scenarioReplayLoad,
    coldStartVsScenario,
    warnings,
  };

  res.json({ success: true, data: response });
};

/**
 * Generic safe-wrapper: a failing section logs + adds a warning + returns
 * null. Other sections still ship. The caller can decide to retry later
 * or look at the populated sections.
 */
async function safeSection<T>(
  name: string,
  fn: () => Promise<T>,
  warnings: string[],
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${TAG} Section "${name}" failed`, { error: msg });
    warnings.push(`${name}: ${msg.slice(0, 200)}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 1 — Wallclock breakdown
// ═══════════════════════════════════════════════════════════════════════════

async function computeWallclockBreakdown(rangeFrom: Date): Promise<WallclockBreakdown> {
  // Pull only the columns we need to keep the payload small even when a
  // 30-day window covers hundreds of rows.
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('total_duration_ms, total_app_setup_ms, total_scenario_ms, total_test_steps_ms')
    .not('total_duration_ms', 'is', null)
    .gte('completed_at', rangeFrom.toISOString());

  if (error) throw error;
  const rows = data ?? [];

  if (rows.length === 0) {
    return {
      totalRuns: 0,
      avgDurationSec: null,
      avgAppSetupSec: null,
      avgScenarioSec: null,
      avgTestBodySec: null,
      avgOverheadSec: null,
      scenarioShareOfDuration: null,
      appSetupShareOfDuration: null,
    };
  }

  const sumDuration = sumNonNull(rows, 'total_duration_ms');
  const sumAppSetup = sumNonNull(rows, 'total_app_setup_ms');
  const sumScenario = sumNonNull(rows, 'total_scenario_ms');
  const sumTestBody = sumNonNull(rows, 'total_test_steps_ms');

  // Overhead = duration - (setup + scenario + body). Includes queueing,
  // pool waits, inter-test gaps. A large overhead share is a flag for
  // infra-level optimisation (Phase 7), not Phase 5.
  const sumKnown = sumAppSetup + sumScenario + sumTestBody;
  const sumOverhead = Math.max(0, sumDuration - sumKnown);

  return {
    totalRuns: rows.length,
    avgDurationSec: msToSec(sumDuration / rows.length),
    avgAppSetupSec: msToSec(sumAppSetup / rows.length),
    avgScenarioSec: msToSec(sumScenario / rows.length),
    avgTestBodySec: msToSec(sumTestBody / rows.length),
    avgOverheadSec: msToSec(sumOverhead / rows.length),
    scenarioShareOfDuration: sumDuration > 0 ? round(sumScenario / sumDuration, 3) : null,
    appSetupShareOfDuration: sumDuration > 0 ? round(sumAppSetup / sumDuration, 3) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2 — Duration by test_count bucket
// ═══════════════════════════════════════════════════════════════════════════

async function computeDurationByBucket(rangeFrom: Date): Promise<DurationBucket[]> {
  // We compute percentiles in JS rather than via PostgREST RPC — keeps
  // this controller self-contained and avoids a Supabase function
  // definition that would need its own migration. For 30 days of data
  // this is a few hundred rows; bucketing + sorting client-side is fine.
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('test_count, total_duration_ms')
    .not('total_duration_ms', 'is', null)
    .not('test_count', 'is', null)
    .gte('completed_at', rangeFrom.toISOString());

  if (error) throw error;
  const rows = (data ?? []) as Array<{ test_count: number | null; total_duration_ms: number | null }>;

  const buckets: Record<DurationBucket['bucket'], number[]> = {
    '1-5': [],
    '6-20': [],
    '21-50': [],
    '50+': [],
  };
  for (const r of rows) {
    if (r.test_count == null || r.total_duration_ms == null) continue;
    const b = bucketFor(r.test_count);
    buckets[b].push(r.total_duration_ms);
  }

  return (Object.keys(buckets) as Array<DurationBucket['bucket']>).map((b) => {
    const arr = buckets[b].slice().sort((a, b2) => a - b2);
    return {
      bucket: b,
      runs: arr.length,
      p50Sec: msToSec(percentile(arr, 0.50)),
      p95Sec: msToSec(percentile(arr, 0.95)),
      p99Sec: msToSec(percentile(arr, 0.99)),
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3 — Scenario re-play load (Phase 5 hit-rate ceiling)
// ═══════════════════════════════════════════════════════════════════════════

async function computeScenarioReplayLoad(rangeFrom: Date): Promise<ScenarioReplayLoad> {
  // Find runs that ACTUALLY have scenario steps. Then for each, count
  // how many tests in the run carried a scenario prefix. If many tests
  // share a scenario in one run → Phase 5 cache has things to skip.
  // If usually 1 test per run uses a scenario → Phase 5 has nothing to
  // hit (the first play is the only play).
  const { data: runs, error: runsErr } = await supabaseAdmin
    .from('regression_runs')
    .select('id')
    .gt('total_scenario_ms', 0)
    .gte('completed_at', rangeFrom.toISOString())
    .limit(500); // cap to keep the per-run subquery cost bounded
  if (runsErr) throw runsErr;
  const runIds = (runs ?? []).map((r) => r.id as string);

  if (runIds.length === 0) {
    return {
      runsWithScenarios: 0,
      avgTestsWithScenarioPerRun: null,
      avgScenarioPerTestMs: null,
      worstScenarioPerTestMs: null,
    };
  }

  // For those runs pull the per-test telemetry rows that have scenario_steps_ms.
  const { data: execs, error: execsErr } = await supabaseAdmin
    .from('test_executions')
    .select('run_id, scenario_steps_ms')
    .in('run_id', runIds)
    .gt('scenario_steps_ms', 0);
  if (execsErr) throw execsErr;
  const execRows = (execs ?? []) as Array<{ run_id: string; scenario_steps_ms: number }>;

  if (execRows.length === 0) {
    return {
      runsWithScenarios: runIds.length,
      avgTestsWithScenarioPerRun: null,
      avgScenarioPerTestMs: null,
      worstScenarioPerTestMs: null,
    };
  }

  const perRun = new Map<string, number>();
  let sumMs = 0;
  let worstMs = 0;
  for (const e of execRows) {
    perRun.set(e.run_id, (perRun.get(e.run_id) ?? 0) + 1);
    sumMs += e.scenario_steps_ms;
    if (e.scenario_steps_ms > worstMs) worstMs = e.scenario_steps_ms;
  }
  const totalRunsWithScenario = perRun.size;
  const totalTestsWithScenario = execRows.length;

  return {
    runsWithScenarios: totalRunsWithScenario,
    avgTestsWithScenarioPerRun:
      totalRunsWithScenario > 0 ? round(totalTestsWithScenario / totalRunsWithScenario, 1) : null,
    avgScenarioPerTestMs: round(sumMs / execRows.length, 0),
    worstScenarioPerTestMs: worstMs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4 — Cold-start vs scenario re-play (verdict)
// ═══════════════════════════════════════════════════════════════════════════

const COLD_START_AVG_MS = 60_000; // observed cold-start in Phase 3 docs

async function computeColdStartVsScenario(rangeFrom: Date): Promise<ColdStartVsScenario> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('cold_start_count, total_scenario_ms')
    .not('total_duration_ms', 'is', null)
    .gte('completed_at', rangeFrom.toISOString())
    .gte('test_count', 5); // small runs aren't representative

  if (error) throw error;
  const rows = (data ?? []) as Array<{ cold_start_count: number | null; total_scenario_ms: number | null }>;

  if (rows.length === 0) {
    return {
      totalRuns: 0,
      avgColdStartsPerRun: null,
      avgScenarioSec: null,
      estimatedColdStartCostSec: null,
      verdict: 'insufficient_data',
    };
  }

  const sumCold = rows.reduce((a, r) => a + (r.cold_start_count ?? 0), 0);
  const sumScenario = rows.reduce((a, r) => a + (r.total_scenario_ms ?? 0), 0);
  const avgCold = sumCold / rows.length;
  const avgScenarioMs = sumScenario / rows.length;
  const estimatedColdMs = avgCold * COLD_START_AVG_MS;

  // Verdict: a 25% gap or more flips the dominance call. Within ±25% we
  // call it roughly equal so neither phase claims an outright win.
  let verdict: ColdStartVsScenario['verdict'];
  if (avgScenarioMs < 5_000 && estimatedColdMs < 5_000) {
    verdict = 'insufficient_data';
  } else if (avgScenarioMs > estimatedColdMs * 1.25) {
    verdict = 'scenario_dominates';
  } else if (estimatedColdMs > avgScenarioMs * 1.25) {
    verdict = 'cold_start_dominates';
  } else {
    verdict = 'roughly_equal';
  }

  return {
    totalRuns: rows.length,
    avgColdStartsPerRun: round(avgCold, 2),
    avgScenarioSec: msToSec(avgScenarioMs),
    estimatedColdStartCostSec: msToSec(estimatedColdMs),
    verdict,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

function sumNonNull<T extends Record<string, unknown>>(rows: T[], key: keyof T): number {
  let s = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) s += v;
  }
  return s;
}

function bucketFor(testCount: number): DurationBucket['bucket'] {
  if (testCount >= 1 && testCount <= 5) return '1-5';
  if (testCount <= 20) return '6-20';
  if (testCount <= 50) return '21-50';
  return '50+';
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

function msToSec(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round((v / 1000) * 10) / 10;
}

function round(v: number | null | undefined, decimals: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(v * factor) / factor;
}
